/**
 * Automation Engine (Phase 8, §18) — triggers subscribing to the OS.
 *
 * Trigger kinds:
 *   cron    — 5-field cron expressions (min hour dom mon dow), including steps
 *             (every-N syntax), ranges (9-17), lists (1,15), and the wildcard.
 *             A 60s ticker fires every automation whose schedule says NOW
 *             (catch-up: missed windows fire once on the next tick).
 *   event   — matches events on the existing bus (EventBus → BrokerPort
 *             subscription): exact event_type + optional substring pattern on
 *             the event data JSON.
 *   webhook — external intake via POST /api/webhooks/:id with the automation's
 *             secret (bearer token; constant-time compare).
 *
 * Actions: run a FLOW (flow_id + input template) or an AGENT (agent_name +
 * input template). The per-automation autonomy_level gates the dispatch the
 * same way the runtime gates tools: below the minimum level for the action's
 * risk (agent execution = medium risk), the fire is SKIPPED with a reason.
 * Every fire — dispatched, skipped, or failed — lands in automation_runs.
 */
import type { DataPort } from '../infra/types';
import { iso, uuid } from '../infra/types';
import type { EventBus } from '../kernel/bus';
import { safeJson } from '../kernel/bus';
import type { AgentRuntime } from './runtime';
import type { FlowEngine } from './flows';
import { getFlow } from './flows';
import * as store from './store';
import type { AutomationRecord, AutomationRunRecord } from '@agentic/contracts';

// ─── cron parsing (5-field, no deps) ────────────────────────────────────────

export interface CronField { min: number; max: number; values: Set<number> }

/** Parse one cron field: wildcard, "5", every-10 ("* / 10" without spaces), "1-30/3", "1,15", "mon". */
function parseCronField(spec: string, min: number, max: number, names?: Record<string, number>): CronField {
  const values = new Set<number>();
  for (const part of spec.split(',')) {
    if (part === '*') { for (let v = min; v <= max; v++) values.add(v); continue; }
    const stepMatch = /^(\*|\d+(?:-\d+)?)\/(\d+)$/.exec(part);
    let range: [number, number];
    let step = 1;
    if (stepMatch) {
      const base = stepMatch[1];
      step = Number(stepMatch[2]);
      if (step < 1) throw new Error(`invalid step "${step}"`);
      range = base === '*' ? [min, max] : (base.includes('-')
        ? (() => { const [a, b] = base.split('-').map(Number); return [a, b] as [number, number]; })()
        : [Number(base), max]);
    } else if (part.includes('-')) {
      const [a, b] = part.split('-');
      range = [resolveName(a, names, min, max), resolveName(b, names, min, max)];
    } else {
      const v = resolveName(part, names, min, max);
      range = [v, v];
    }
    if (range[0] < min || range[1] > max || range[0] > range[1]) {
      throw new Error(`field "${spec}" out of range ${min}-${max}`);
    }
    for (let v = range[0]; v <= range[1]; v += step) values.add(v);
  }
  if (values.size === 0) throw new Error(`empty field "${spec}"`);
  return { min, max, values };
}

function resolveName(token: string, names: Record<string, number> | undefined, min: number, max: number): number {
  const nameVal = names?.[token.toLowerCase()];
  if (nameVal !== undefined) return nameVal;   // NB: sunday=0 is falsy — compare against undefined
  const n = Number(token);
  if (!Number.isInteger(n)) throw new Error(`invalid value "${token}"`);
  return n;
}

const MONTH_NAMES: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DOW_NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

export interface ParsedCron {
  minute: CronField; hour: CronField; dom: CronField; month: CronField; dow: CronField;
}

export function parseCron(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron needs 5 fields (minute hour dom month dow), got ${parts.length}`);
  const [minute, hour, dom, month, dow] = parts;
  return {
    minute: parseCronField(minute, 0, 59),
    hour: parseCronField(hour, 0, 23),
    dom: parseCronField(dom, 1, 31),
    month: parseCronField(month, 1, 12, MONTH_NAMES),
    // cron's sunday=7 convention: map 7 → 0
    dow: { ...parseCronField(dow === '*' ? '*' : dow.replace(/\b7\b/g, '0'), 0, 6, DOW_NAMES) },
  };
}

/** Next time (>= from) this cron fires — minute-precision scan. */
export function nextCronFire(cron: ParsedCron, from: Date = new Date()): Date {
  // start at the next minute boundary
  const t = new Date(from);
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  const limit = new Date(from.getTime() + 366 * 86400000); // 1-year bound
  while (t <= limit) {
    if (cron.month.values.has(t.getMonth() + 1)
      && cron.dom.values.has(t.getDate())
      && cron.dow.values.has(t.getDay())
      && cron.hour.values.has(t.getHours())
      && cron.minute.values.has(t.getMinutes())) {
      return new Date(t);
    }
    t.setMinutes(t.getMinutes() + 1);
  }
  throw new Error('no cron fire within a year (malformed expression?)');
}

/** Does this cron fire during the [windowStart, now] interval? (catch-up) */
function cronDue(cron: ParsedCron, lastFire: Date | null, now: Date): boolean {
  // cheap pre-check: if any schedule minute matches the current minute and the
  // last fire wasn't THIS minute, it's due (missed windows catch up on next tick)
  if (cron.minute.values.has(now.getMinutes())
    && cron.hour.values.has(now.getHours())
    && cron.month.values.has(now.getMonth() + 1)
    && cron.dom.values.has(now.getDate())
    && cron.dow.values.has(now.getDay())) {
    const thisMinute = new Date(now); thisMinute.setSeconds(0, 0);
    if (!lastFire || lastFire < thisMinute) return true;
  }
  return false;
}

// ─── engine ─────────────────────────────────────────────────────────────────

export interface AutomationDeps {
  db: DataPort;
  bus: EventBus;
  runtime: AgentRuntime;
  flows: FlowEngine;
}

// minimum autonomy for each action kind (mirrors the runtime's risk gates)
const ACTION_MIN_AUTONOMY: Record<string, number> = {
  flow: 2,   // flows internally gate their own high-risk nodes
  agent: 2,  // agent executions are medium-risk (their tools still gate)
};

export class AutomationEngine {
  private ticker: NodeJS.Timeout | null = null;
  private unsubscribeBus: (() => void) | null = null;
  /** in-flight dispatch guard: one fire per automation at a time */
  private firing = new Set<string>();

  constructor(private deps: AutomationDeps) {}

  // ── lifecycle ──
  async start(): Promise<void> {
    // 1) cron ticker — every 60s (catch-up via last_fired_at on the row)
    this.ticker = setInterval(() => this.tickCron().catch(() => {}), 60_000);
    // 2) event subscriptions — one broker subscription feeding all event automations
    //    (the bus persists every event, so the broker channel carries them all)
    const { bus } = this.deps;
    const { CHANNEL } = await import('../kernel/bus');
    // subscribe through the broker directly (bus.emit publishes there)
    this.unsubscribeBus = await (bus as any).broker.subscribe(CHANNEL, (_ch: string, payload: unknown) => {
      const ev = payload as { type?: string; data?: unknown };
      if (ev?.type) this.onEvent(ev.type, ev.data ?? {}).catch(() => {});
    });
  }

  async stop(): Promise<void> {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    if (this.unsubscribeBus) this.unsubscribeBus();
    this.unsubscribeBus = null;
  }

  // ── trigger paths ──
  private async tickCron(): Promise<void> {
    const now = new Date();
    const rows = await this.deps.db.query<any>(
      "SELECT * FROM automations WHERE trigger = 'cron' AND enabled = 1");
    for (const r of rows) {
      const rec = parseAutomation(r);
      try {
        const cron = parseCron(String(rec.trigger_config.schedule ?? ''));
        if (cronDue(cron, rec.last_fired_at ? new Date(rec.last_fired_at) : null, now)) {
          await this.fire(rec, 'cron', { trigger: 'cron', schedule: rec.trigger_config.schedule });
        }
      } catch { /* bad schedule: skip silently (validator flags it at save) */ }
    }
  }

  private async onEvent(eventType: string, data: unknown): Promise<void> {
    const rows = await this.deps.db.query<any>(
      "SELECT * FROM automations WHERE trigger = 'event' AND enabled = 1");
    for (const r of rows) {
      const rec = parseAutomation(r);
      const wantType = String(rec.trigger_config.event_type ?? '');
      if (wantType !== eventType) continue;
      // optional substring pattern over the event data
      const pattern = rec.trigger_config.pattern ? String(rec.trigger_config.pattern) : null;
      if (pattern && !JSON.stringify(data ?? {}).toLowerCase().includes(pattern.toLowerCase())) continue;
      // SELF-TRIGGER GUARD: never fire on automation.* events (feedback loops)
      if (eventType.startsWith('automation.')) continue;
      await this.fire(rec, 'event', { event_type: eventType, pattern });
    }
  }

  /** Webhook intake — called by the API route after token verification. */
  async onWebhook(automationId: string, payload: Record<string, unknown>): Promise<AutomationRunRecord | null> {
    const rows = await this.deps.db.query<any>('SELECT * FROM automations WHERE id = ?', [automationId]);
    if (!rows[0]) return null;
    const rec = parseAutomation(rows[0]);
    if (rec.trigger !== 'webhook') return null;
    if (!rec.enabled) {
      return this.logRun(rec.id, 'webhook', 'skipped', 'automation is paused', null);
    }
    return this.fire(rec, 'webhook', { webhook_payload: payload }, payload);
  }

  // ── dispatch (the shared fire path, policy-gated) ──
  private async fire(
    rec: AutomationRecord, trigger: string, detail: Record<string, unknown>,
    payload?: Record<string, unknown>,
  ): Promise<AutomationRunRecord> {
    // in-flight guard: don't double-fire (cron catch-up + slow agent)
    if (this.firing.has(rec.id)) {
      return this.logRun(rec.id, trigger, 'skipped', 'previous dispatch still in flight', null);
    }
    this.firing.add(rec.id);
    try {
      // ── per-automation autonomy policy gate ──
      const minAutonomy = ACTION_MIN_AUTONOMY[rec.action] ?? 2;
      if (rec.autonomy_level < minAutonomy) {
        const reason = `autonomy policy: level ${rec.autonomy_level} below required ${minAutonomy} for ${rec.action} action`;
        await this.deps.bus.emit('automation.skipped', { automation_id: rec.id, name: rec.name, reason },
          { actor_type: 'automation', target_type: 'event', target_id: rec.id });
        return this.logRun(rec.id, trigger, 'skipped', reason, null);
      }

      // resolve the input template: ${event.*} refs from the trigger payload
      const inputTemplate = String(rec.action_config.input ?? '');
      const input = resolveEventTemplate(inputTemplate, detail, payload);

      let targetId: string | null = null;
      if (rec.action === 'flow') {
        const flowId = String(rec.action_config.flow_id ?? '');
        const flow = await getFlow(this.deps.db, flowId);
        if (!flow) {
          return this.logRun(rec.id, trigger, 'failed', `flow not found: ${flowId}`, null);
        }
        const run = await this.deps.flows.start(flow, rec.created_by ?? '', { input: input || '' });
        targetId = run.id;
      } else {
        const agentName = String(rec.action_config.agent_name ?? '');
        const agent = await store.getAgentByName(this.deps.db, agentName);
        if (!agent) {
          return this.logRun(rec.id, trigger, 'failed', `agent not found: ${agentName}`, null);
        }
        const exec = await this.deps.runtime.run({
          agent, user_id: rec.created_by ?? '', input: input || `Automation "${rec.name}" fired (${trigger})`,
          autonomy_override: rec.autonomy_level,   // policy flows into the agent's gates
        });
        targetId = exec.id;
      }

      // update run stats + emit
      const now = iso();
      await this.deps.db.run(
        'UPDATE automations SET last_fired_at = ?, last_run_id = ?, run_count = run_count + 1, updated_at = ? WHERE id = ?',
        [now, targetId, now, rec.id]);
      await this.deps.bus.emit('automation.dispatched',
        { automation_id: rec.id, name: rec.name, trigger, action: rec.action, target_id: targetId },
        { actor_type: 'automation', target_type: 'event', target_id: rec.id });
      return this.logRun(rec.id, trigger, 'dispatched', `action ${rec.action} started`, targetId);
    } catch (e: any) {
      const reason = String(e?.message ?? e);
      await this.deps.bus.emit('automation.failed', { automation_id: rec.id, name: rec.name, error: reason },
        { actor_type: 'automation', target_type: 'event', target_id: rec.id });
      return this.logRun(rec.id, trigger, 'failed', reason, null);
    } finally {
      this.firing.delete(rec.id);
    }
  }

  /** Manual test-fire (inspector UI) — same path, `test` trigger label. */
  async testFire(automationId: string): Promise<AutomationRunRecord | null> {
    const rows = await this.deps.db.query<any>('SELECT * FROM automations WHERE id = ?', [automationId]);
    if (!rows[0]) return null;
    const rec = parseAutomation(rows[0]);
    return this.fire(rec, 'test', { test: true });
  }

  private async logRun(automationId: string, trigger: string, status: string, reason: string, targetId: string | null): Promise<AutomationRunRecord> {
    const run: AutomationRunRecord = {
      id: uuid(), automation_id: automationId, trigger: trigger as AutomationRunRecord['trigger'],
      status: status as AutomationRunRecord['status'], reason: reason.slice(0, 300), target_id: targetId, fired_at: iso(),
    };
    await this.deps.db.run(
      'INSERT INTO automation_runs (id, automation_id, trigger, status, reason, target_id, fired_at) VALUES (?,?,?,?,?,?,?)',
      [run.id, run.automation_id, run.trigger, run.status, run.reason, run.target_id, run.fired_at]);
    return run;
  }
}

/** ${event.foo} / ${payload.bar} templates in action input strings. */
function resolveEventTemplate(template: string, detail: Record<string, unknown>, payload?: Record<string, unknown>): string {
  if (!template) return '';
  return template
    .replace(/\$\{event\.([A-Za-z0-9_.-]+)\}/g, (_m, p) => {
      const v = (detail as any)[p];
      return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    })
    .replace(/\$\{payload\.([A-Za-z0-9_.-]+)\}/g, (_m, p) => {
      const v = (payload as any)?.[p];
      return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    });
}

// ─── persistence helpers ─────────────────────────────────────────────────────

export function parseAutomation(r: any): AutomationRecord {
  return {
    id: r.id, name: r.name, description: r.description,
    trigger: r.trigger, trigger_config: safeJson(r.trigger_config),
    action: r.action, action_config: safeJson(r.action_config),
    autonomy_level: r.autonomy_level, enabled: !!r.enabled,
    last_fired_at: r.last_fired_at, last_run_id: r.last_run_id, run_count: r.run_count,
    created_by: r.created_by, created_at: r.created_at, updated_at: r.updated_at,
  };
}

export async function listAutomations(db: DataPort): Promise<AutomationRecord[]> {
  const rows = await db.query<any>('SELECT * FROM automations ORDER BY created_at DESC');
  return rows.map(parseAutomation);
}

export async function getAutomation(db: DataPort, id: string): Promise<AutomationRecord | null> {
  const rows = await db.query<any>('SELECT * FROM automations WHERE id = ?', [id]);
  return rows[0] ? parseAutomation(rows[0]) : null;
}

export async function listAutomationRuns(db: DataPort, automationId?: string, limit = 50): Promise<AutomationRunRecord[]> {
  const rows = automationId
    ? await db.query<any>('SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY fired_at DESC LIMIT ?', [automationId, limit])
    : await db.query<any>('SELECT * FROM automation_runs ORDER BY fired_at DESC LIMIT ?', [limit]);
  return rows.map((r: any) => ({
    id: r.id, automation_id: r.automation_id, trigger: r.trigger, status: r.status,
    reason: r.reason, target_id: r.target_id, fired_at: r.fired_at,
  }));
}

/** Validate a trigger config at save time. Returns errors for the API. */
export function validateTrigger(trigger: string, cfg: Record<string, unknown>): string | null {
  if (trigger === 'cron') {
    if (!cfg.schedule || typeof cfg.schedule !== 'string') return 'cron trigger needs trigger_config.schedule';
    try { parseCron(String(cfg.schedule)); } catch (e: any) { return `invalid cron: ${e.message}`; }
    return null;
  }
  if (trigger === 'event') {
    if (!cfg.event_type || typeof cfg.event_type !== 'string') return 'event trigger needs trigger_config.event_type';
    return null;
  }
  if (trigger === 'webhook') return null; // secret generated server-side if absent
  return `unknown trigger kind: ${trigger}`;
}

/** Constant-time string compare (webhook secret check). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
