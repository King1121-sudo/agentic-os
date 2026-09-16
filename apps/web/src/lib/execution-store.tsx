'use client';
/**
 * ExecutionStore — the ONE source of truth for live execution state in the web
 * client. Mounted once at the root layout; survives navigation (background
 * executions §22/§45 keep streaming into it wherever the user goes).
 *
 * Real state only (§51 ALWAYS): every entry is created by a REAL
 * command/execution response and updated ONLY by real bus events over SSE.
 * Idempotent by event id (§34) — replays and duplicates can't duplicate rows.
 *
 * Event → store mapping (all existing backend events, nothing invented):
 *   command.acknowledged  → ack text on the active command
 *   agent.started         → execution entry appears (agent, input)
 *   agent.thinking        → activity line (kind from data.kind, safe telemetry)
 *   plan.created          → activity line "Plan: <rationale> (N steps)"
 *   agent.executing       → activity line "Step i/N" + current operation
 *   tool.executed/denied/failed → activity line with real tool + outcome
 *   skill.executed        → activity line with real skill name
 *   approval.requested    → approval_required state + inline decision controls
 *   approval.decided      → resumes
 *   agent.paused/resumed/stopped/completed/failed → terminal/intermediate states
 *   agent.token           → streaming response buffer (never persisted server-side)
 *
 * Private-reasoning guard (§14): trace 'kind' messages come from the runtime's
 * SAFE telemetry vocabulary (state/plan/tool/model/skill/result summaries),
 * never chain-of-thought. The plan rationale is the planner's declared intent
 * — safe telemetry, not deliberation.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export type ExecState =
  | 'received' | 'understanding' | 'planning' | 'executing' | 'waiting'
  | 'approval_required' | 'completing' | 'completed' | 'failed' | 'cancelled';

export type ActivityLine = {
  id: string;            // event id (dedupe key) or synthetic stable key
  ts: string;
  icon: 'done' | 'active' | 'pending' | 'warn' | 'fail';
  label: string;         // human-friendly (Level 1)
  detail?: string;       // technical (Level 2, collapsible)
  kind?: string;         // trace kind: tool/model/skill/plan/state
};

export type LiveExecution = {
  id: string;
  agent: string;
  agentId?: string;
  input: string;
  ack?: string;
  state: ExecState;
  startedAt: string;
  completedAt?: string;
  activity: ActivityLine[];
  streaming?: { phase: string; text: string };
  error?: string | null;
  result?: string | null;
  parentId?: string | null;   // delegation graph
};

type StoreShape = {
  executions: Record<string, LiveExecution>;
  order: string[];                    // newest first
  /** SSE connection state — surfaced as "Reconnecting…" (§35). */
  connected: boolean;
  ack: (text: string) => void;        // local echo of the ack for the just-typed command
  lastAck: string | null;
  register: (id: string, seed: Partial<LiveExecution>) => void;
  trackCommand: (commandText: string) => void;
  activeCount: number;
};

const StoreCtx = createContext<StoreShape | null>(null);

const ACTIVE_STATES: ExecState[] = ['received', 'understanding', 'planning', 'executing', 'waiting', 'approval_required'];

/** Real-state mapping from backend execution.status → UI state vocabulary (§8). */
function stateFromExecutionStatus(status?: string): ExecState | null {
  switch (status) {
    case 'running': return 'executing';
    case 'paused': return 'waiting';
    case 'approval_required': return 'approval_required';
    case 'interrupted': return 'waiting';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    default: return null;
  }
}

export function ExecutionStoreProvider({ children }: { children: ReactNode }) {
  const [executions, setExecutions] = useState<Record<string, LiveExecution>>({});
  const [order, setOrder] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [lastAck, setLastAck] = useState<string | null>(null);
  const seenEvents = useRef<Set<string>>(new Set());
  const pendingCommand = useRef<string | null>(null);
  const ackRef = useRef<string | null>(null);

  const apply = (id: string, fn: (ex: LiveExecution) => LiveExecution) => {
    setExecutions(prev => {
      const cur = prev[id];
      if (!cur) return prev; // never invent an execution the backend didn't create
      const next = fn(cur);
      if (next === cur) return prev;
      return { ...prev, [id]: next };
    });
  };

  const register = (id: string, seed: Partial<LiveExecution>) => {
    setExecutions(prev => prev[id] ? prev : {
      ...prev,
      [id]: {
        id, agent: seed.agent ?? 'Agent', agentId: seed.agentId,
        input: seed.input ?? '', ack: seed.ack, state: seed.state ?? 'received',
        startedAt: seed.startedAt ?? new Date().toISOString(),
        activity: seed.activity ?? [], parentId: seed.parentId ?? null,
      },
    });
    setOrder(prev => prev.includes(id) ? prev : [id, ...prev]);
  };

  const addActivity = (id: string, line: ActivityLine, dedupeKey?: string) => {
    apply(id, ex => {
      if (dedupeKey && ex.activity.some(l => l.id === dedupeKey)) return ex; // §34 idempotent
      return { ...ex, activity: [...ex.activity, line].slice(-80) }; // bounded (§36)
    });
  };

  const setState = (id: string, state: ExecState, patch?: Partial<LiveExecution>) => {
    apply(id, ex => ({ ...ex, ...patch, state }));
  };

  // ── the ONE SSE subscription for execution state ──────────────────────────
  useEffect(() => {
    const es = new EventSource('/api/stream');
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);   // EventSource auto-reconnects; tail() replays
    es.onmessage = (e) => {
      let ev: any;
      try { ev = JSON.parse(e.data); } catch { return; }
      if (!ev?.id || !ev?.type) return;
      if (seenEvents.current.has(ev.id)) return; // §34 duplicate events
      seenEvents.current.add(ev.id);
      if (seenEvents.current.size > 4000) {
        seenEvents.current = new Set(Array.from(seenEvents.current).slice(-2000));
      }
      const d = ev.data ?? {};
      const exId: string | undefined = d.execution_id ?? d.child_execution_id;

      switch (ev.type as string) {
        case 'command.acknowledged': {
          if (d.kind === 'execution' && d.text && pendingCommand.current !== null) {
            // the execution response carries the id; link ack when it lands
            setLastAck(String(d.ack ?? ''));
          }
          break;
        }
        case 'agent.started': {
          if (!exId) break;
          const isNew = !executions[exId] && !order.includes(exId);
          if (isNew) {
            register(exId, {
              agent: d.agent ?? 'Agent', input: String(d.input ?? ''),
              ack: ackRef.current ?? undefined,
              state: 'understanding', startedAt: ev.created_at,
              parentId: d.delegated_by ?? null,
            });
            ackRef.current = null;
            setLastAck(null);
          } else {
            setState(exId, 'understanding');
          }
          addActivity(exId, { id: ev.id, ts: ev.created_at, icon: 'done', label: `${d.agent} started`, detail: d.delegated_by ? `delegated from ${(d.delegated_by as string).slice(0, 8)}` : undefined });
          break;
        }
        case 'agent.thinking': {
          if (!exId) break;
          // phase = planning context; kind = trace kind. Both are safe telemetry.
          const label = d.phase === 'planning'
            ? 'Understanding the request and building a plan'
            : String(d.message ?? d.phase ?? 'working');
          addActivity(exId, { id: ev.id, ts: ev.created_at, icon: 'active', label, kind: String(d.kind ?? d.phase ?? 'state') });
          if (d.phase === 'planning') setState(exId, 'planning');
          break;
        }
        case 'plan.created': {
          if (!exId) break;
          const steps = Number(d.steps ?? 0);
          addActivity(exId, { id: ev.id, ts: ev.created_at, icon: 'done', label: `Plan ready — ${steps} step${steps === 1 ? '' : 's'}`, detail: String(d.rationale ?? ''), kind: 'plan' });
          break;
        }
        case 'agent.executing': {
          if (!exId) break;
          const total = Number(d.total ?? 0);
          setState(exId, 'executing');
          addActivity(exId, { id: ev.id, ts: ev.created_at, icon: 'active', label: `Step ${d.step}${total ? ` of ${total}` : ''}`, detail: d.kind ? `kind: ${d.kind}` : undefined, kind: String(d.kind ?? 'state') });
          break;
        }
        case 'tool.executed': {
          if (!exId) break;
          addActivity(exId, { id: ev.id, ts: ev.created_at, icon: 'done', label: `${d.tool} completed`, detail: `${d.summary ?? ''}${d.latency_ms ? ` · ${d.latency_ms}ms` : ''}`, kind: 'tool' });
          break;
        }
        case 'tool.denied':
        case 'tool.failed': {
          if (!exId) break;
          addActivity(exId, { id: ev.id, ts: ev.created_at, icon: 'fail', label: `${d.tool} ${ev.type === 'tool.denied' ? 'denied by policy' : 'failed'}`, detail: String(d.reason ?? d.error ?? ''), kind: 'tool' });
          break;
        }
        case 'skill.executed': {
          if (!exId) break;
          addActivity(exId, { id: ev.id, ts: ev.created_at, icon: 'done', label: `Skill ${d.skill} executed`, detail: `${d.steps} steps · chain ${Array.isArray(d.chain) ? d.chain.join(' → ') : ''} · v${d.version}`, kind: 'skill' });
          break;
        }
        case 'skill.denied': {
          if (!exId) break;
          addActivity(exId, { id: ev.id, ts: ev.created_at, icon: 'warn', label: `Skill ${d.skill} denied`, detail: `missing tools: ${Array.isArray(d.missing) ? d.missing.join(', ') : ''}`, kind: 'skill' });
          break;
        }
        case 'approval.requested': {
          if (!exId) break;
          setState(exId, 'approval_required');
          addActivity(exId, { id: ev.id, ts: ev.created_at, icon: 'warn', label: `Approval needed — ${d.agent} wants to run ${d.tool}`, detail: String(d.reason ?? ''), kind: 'approval' });
          break;
        }
        case 'approval.decided': {
          if (!exId) break;
          setState(exId, 'executing');
          addActivity(exId, { id: ev.id, ts: ev.created_at, icon: 'done', label: `Approval ${d.decision} — resuming`, kind: 'approval' });
          break;
        }
        case 'agent.paused': {
          if (!exId) break;
          setState(exId, 'waiting');
          addActivity(exId, { id: ev.id, ts: ev.created_at, icon: 'warn', label: 'Paused', kind: 'state' });
          break;
        }
        case 'agent.resumed': {
          if (!exId) break;
          setState(exId, 'executing');
          addActivity(exId, { id: ev.id, ts: ev.created_at, icon: 'done', label: 'Resumed', kind: 'state' });
          break;
        }
        case 'agent.stopped': {
          if (!exId) break;
          setState(exId, 'cancelled', { completedAt: ev.created_at, result: d.result ?? null });
          addActivity(exId, { id: ev.id, ts: ev.created_at, icon: 'warn', label: 'Stopped by user', kind: 'state' });
          break;
        }
        case 'agent.completed': {
          if (!exId) break;
          setState(exId, 'completed', { completedAt: ev.created_at, result: d.result ?? null });
          addActivity(exId, { id: ev.id, ts: ev.created_at, icon: 'done', label: 'Execution completed', kind: 'result' });
          break;
        }
        case 'agent.failed': {
          if (!exId) break;
          setState(exId, 'failed', { completedAt: ev.created_at, error: d.error ?? 'Execution failed' });
          addActivity(exId, { id: ev.id, ts: ev.created_at, icon: 'fail', label: 'Execution failed', detail: String(d.error ?? ''), kind: 'error' });
          break;
        }
        case 'agent.token': {
          // volatile streaming delta — append to the buffer, never persists
          if (!exId) break;
          apply(exId, ex => {
            const phase = String(d.phase ?? 'response');
            const text = String(d.delta ?? '');
            if (ex.streaming && ex.streaming.phase === phase) {
              return { ...ex, streaming: { phase, text: (ex.streaming.text + text).slice(-4000) } };
            }
            return { ...ex, streaming: { phase, text } };
          });
          break;
        }
        case 'memory.working.opened': {
          if (!exId) break;
          addActivity(exId, { id: ev.id, ts: ev.created_at, icon: 'done', label: d.pinned ? `Using context — ${d.pinned} relevant memories` : 'Context opened', kind: 'memory' });
          break;
        }
        case 'execution.interrupted': {
          if (!exId) break;
          setState(exId, 'waiting');
          addActivity(exId, { id: ev.id, ts: ev.created_at, icon: 'warn', label: 'Interrupted (resumable)', kind: 'state' });
          break;
        }
        case 'agent.delegated': {
          // delegation graph edge — shows under the parent when the child starts
          if (!exId) break;
          addActivity(exId, { id: ev.id, ts: ev.created_at, icon: 'active', label: `Delegating to ${d.agent ?? 'agent'}`, kind: 'state' });
          break;
        }
      }
    };
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // one subscription for the session; state updates via functional setState

  const ack = (text: string) => { ackRef.current = text; setLastAck(text); };
  const trackCommand = (commandText: string) => { pendingCommand.current = commandText; };

  // reconcile against the source of truth when (re)connecting (§35): fetch
  // live executions and mark anything the store missed. Never trusts stale
  // frontend state over the backend.
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/executions?limit=20', { credentials: 'include' });
        if (!res.ok) return;
        const rows = await res.json();
        if (!Array.isArray(rows) || cancelled) return;
        const live = rows.filter((r: any) => ['running', 'paused', 'approval_required', 'interrupted'].includes(r.status));
        setExecutions(prev => {
          const next = { ...prev };
          for (const r of live) {
            const mapped = stateFromExecutionStatus(r.status);
            if (mapped && !next[r.id]) {
              next[r.id] = {
                id: r.id, agent: 'Agent', input: String(r.input ?? ''), state: mapped,
                startedAt: r.started_at, activity: [{ id: 'reconcile', ts: r.started_at, icon: 'active', label: 'Reconnected to running execution' }],
              };
              setOrder(o => o.includes(r.id) ? o : [r.id, ...o]);
            } else if (mapped && next[r.id]) {
              if (ACTIVE_STATES.includes(next[r.id].state) && !ACTIVE_STATES.includes(mapped)) {
                // backend reached terminal state while we were away
                next[r.id] = { ...next[r.id], state: mapped, completedAt: r.completed_at, result: r.result ?? null, error: r.error ?? null };
              }
            }
          }
          return next;
        });
      } catch { /* unauthenticated */ }
    })();
    return () => { cancelled = true; };
  }, [connected]);

  const activeCount = useMemo(
    () => order.filter(id => ACTIVE_STATES.includes(executions[id]?.state ?? '')).length,
    [order, executions],
  );

  const value = useMemo<StoreShape>(() => ({
    executions, order, connected, ack, lastAck, register, trackCommand, activeCount,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [executions, order, connected, activeCount]);

  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

export function useExecutionStore(): StoreShape {
  const ctx = useContext(StoreCtx);
  if (!ctx) throw new Error('useExecutionStore requires ExecutionStoreProvider');
  return ctx;
}

/** Convenience: the most recent execution (the one the command surface shows). */
export function useLatestExecution(): LiveExecution | null {
  const { executions, order } = useExecutionStore();
  return order.length ? executions[order[0]] ?? null : null;
}
