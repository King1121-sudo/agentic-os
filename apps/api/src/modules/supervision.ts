/**
 * Supervision (Phase 12, §Desktop/Mobile) — the mobile supervisor surface.
 *
 * 1. MOBILE BRIEFING: one render-ready payload for a supervision app —
 *    system status, agent roster, actionable tasks (with project names),
 *    pending approvals, recent kernel events, and running-work counts.
 *
 * 2. EMERGENCY STOP: the kill switch. One call cascades through the OS:
 *    running executions (delegated children included — runtime.stop already
 *    cascades the execution graph and aborts in-flight generations),
 *    running/waiting flow runs, and pauses every enabled automation so
 *    nothing re-fires until a human re-arms it. Every stop is audited and
 *    announced on the bus (`system.emergency_stop`); the supervisor gets a
 *    notification confirming the world state after the stop.
 */
import type { DataPort } from '../infra/types';
import { iso, uuid } from '../infra/types';
import type { EventBus } from '../kernel/bus';
import type { AgentRuntime } from './runtime';
import type { FlowEngine } from './flows';
import * as store from './store';

// ─── mobile briefing ─────────────────────────────────────────────────────────

export interface MobileBriefing {
  generated_at: string;
  status: 'nominal' | 'action_required' | 'critical';
  agents: { id: string; name: string; status: string; description: string }[];
  open_tasks: { id: string; title: string; status: string; priority: string; project_id: string | null; project_name: string }[];
  approvals: { id: string; tool: string; reason: string; status: string; agent_id: string; created_at: string }[];
  recent_events: { id: string; type: string; created_at: string; summary: string }[];
  counts: { running_executions: number; running_flow_runs: number; enabled_automations: number; unread_notifications: number };
}

const summarize = (data: unknown): string => {
  const d = (data ?? {}) as any;
  if (d.input) return `${d.agent ? `${d.agent}: ` : ''}${String(d.input).slice(0, 80)}`;
  if (d.tool) return `${d.tool}${d.summary ? ` → ${d.summary}` : ''}`;
  if (d.summary) return String(d.summary).slice(0, 80);
  return JSON.stringify(d).slice(0, 80);
};

/** The supervision payload. `status`: approvals pending (or anything failed
 *  recently) escalate to action_required; nothing nominal otherwise — the
 *  escalation ladder stays intentionally simple for a phone screen. */
export async function mobileBriefing(db: DataPort, userId: string): Promise<MobileBriefing> {
  const [agents, openTasks, approvals, events, notes] = await Promise.all([
    store.listAgents(db),
    store.listTasks(db, { limit: 100 }),
    store.listApprovals(db, 'pending'),
    bus_listEvents(db, 12),
    store.listNotifications(db, userId, 'unread'),
  ]);
  const projects = await store.listProjects(db);
  const projectName = new Map(projects.map(p => [p.id, p.name]));

  const actionable = openTasks.filter(t => t.status === 'todo' || t.status === 'in_progress' || t.status === 'blocked');

  const runningExec = Number((await db.query<any>("SELECT COUNT(*) AS n FROM executions WHERE status IN ('running','paused','approval_required','interrupted')"))[0]?.n ?? 0);
  const runningFlows = Number((await db.query<any>("SELECT COUNT(*) AS n FROM flow_runs WHERE status IN ('running','waiting','paused','interrupted')"))[0]?.n ?? 0);
  const enabledAutos = Number((await db.query<any>('SELECT COUNT(*) AS n FROM automations WHERE enabled = 1'))[0]?.n ?? 0);

  const status: MobileBriefing['status'] = approvals.length > 0
    ? 'action_required'
    : events.some(e => String(e.type).includes('failed'))
      ? 'critical'
      : 'nominal';

  return {
    generated_at: iso(),
    status,
    agents: agents.map(a => ({ id: a.id, name: a.name, status: a.status, description: (a.description ?? '').slice(0, 120) })),
    open_tasks: actionable.map(t => ({
      id: t.id, title: t.title, status: t.status, priority: t.priority,
      project_id: t.project_id, project_name: (t.project_id && projectName.get(t.project_id)) || '—',
    })).slice(0, 10),
    approvals: approvals.map(a => ({ id: a.id, tool: a.tool, reason: a.reason, status: a.status, agent_id: a.agent_id, created_at: a.created_at })),
    recent_events: events.map(e => ({ id: e.id, type: e.type, created_at: e.created_at, summary: summarize((e as any).data) })),
    counts: {
      running_executions: runningExec, running_flow_runs: runningFlows,
      enabled_automations: enabledAutos, unread_notifications: notes.length,
    },
  };
}

async function bus_listEvents(db: DataPort, limit: number): Promise<any[]> {
  return db.query<any>('SELECT * FROM events ORDER BY created_at DESC LIMIT ?', [limit]);
}

// ─── emergency stop ─────────────────────────────────────────────────────────

export interface EmergencyStopResult {
  stopped_executions: number;
  cancelled_flow_runs: number;
  paused_automations: number;
  executions: string[];
  flow_runs: string[];
  at: string;
}

export interface EmergencyStopDeps {
  db: DataPort;
  bus: EventBus;
  runtime: AgentRuntime;
  flows: FlowEngine;
}

/** The kill switch. Idempotent by construction: everything it stops is
 *  terminal when stopped, so a second call finds nothing left to stop. */
export class EmergencyStop {
  constructor(private deps: EmergencyStopDeps) {}

  async execute(reason: string, actorId?: string): Promise<EmergencyStopResult> {
    const { db, bus, runtime, flows } = this.deps;

    // 1) running executions (any non-terminal status) — runtime.stop cascades
    //    to delegated children and aborts in-flight generations. The runtime's
    //    drive loop flips the DB row at its next step boundary; a supervisor
    //    needs the world stopped NOW, so the row is also set synchronously
    //    (both paths write the same 'cancelled' — no conflict).
    const running = await db.query<any>(
      "SELECT id, agent_id FROM executions WHERE status IN ('running','paused','approval_required','interrupted')");
    const executions: string[] = [];
    for (const r of running) {
      const ok = await runtime.stop(r.id).catch(() => false);
      if (ok) {
        executions.push(r.id);
        await db.run(
          "UPDATE executions SET status = 'cancelled', updated_at = ? WHERE id = ? AND status NOT IN ('completed','failed','cancelled')",
          [iso(), r.id]).catch(() => {});
        if (r.agent_id) {
          await db.run("UPDATE agents SET status = 'idle', updated_at = ? WHERE id = ?", [iso(), r.agent_id]).catch(() => {});
        }
      }
    }

    // 2) flow runs — cancelled via the engine (checkpoints kept for audit)
    const flowRuns = await db.query<any>(
      "SELECT id FROM flow_runs WHERE status IN ('running','waiting','paused','interrupted')");
    const runs: string[] = [];
    for (const fr of flowRuns) {
      const ok = await flows.stop(fr.id).catch(() => false);
      if (ok) runs.push(fr.id);
    }

    // 3) automations — paused so nothing re-fires until re-armed
    const autos = await db.query<any>('SELECT id FROM automations WHERE enabled = 1');
    const now = iso();
    for (const a of autos) {
      await db.run('UPDATE automations SET enabled = 0, updated_at = ? WHERE id = ?', [now, a.id]);
      await bus.emit('automation.paused', { automation_id: a.id, reason: 'emergency stop' },
        { actor_type: 'system', target_type: 'event', target_id: a.id }).catch(() => {});
    }

    const result: EmergencyStopResult = {
      stopped_executions: executions.length,
      cancelled_flow_runs: runs.length,
      paused_automations: autos.length,
      executions, flow_runs: runs,
      at: now,
    };

    // 4) trail: audit + bus event + supervisor notification
    await store.audit(db, {
      actor_type: 'user', actor_id: actorId ?? 'supervisor', action: 'system.emergency_stop',
      meta: { reason, ...result },
    });
    await bus.emit('system.emergency_stop', { reason, ...result },
      { actor_type: 'user', actor_id: actorId, target_type: 'event', target_id: 'emergency-stop' });
    await store.notify(db, {
      user_id: actorId ?? '', title: 'Emergency stop executed',
      message: `Stopped ${result.stopped_executions} execution(s), cancelled ${result.cancelled_flow_runs} flow run(s), paused ${result.paused_automations} automation(s). Reason: ${reason}`,
      priority: 'urgent', category: 'system', source: 'supervision',
    }).catch(() => {});

    return result;
  }
}

export function createEmergencyStop(deps: EmergencyStopDeps): EmergencyStop {
  return new EmergencyStop(deps);
}
