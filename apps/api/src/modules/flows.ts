/**
 * Flow Engine (Phase 7, §17) — long-running, checkpointed executions of visual
 * flow graphs.
 *
 * Model: a flow is a directed graph of nodes (trigger/agent/skill/tool/
 * condition/branch/loop/wait/approval) walked from its trigger. Every node
 * completion persists a CHECKPOINT (current node, completed set, live context
 * variable store, trace) to flow_runs — so a run killed mid-flight resumes
 * from its checkpoint (at-least-once: the node in flight at crash time re-runs).
 *
 * Control semantics mirror the agent runtime: pause between nodes, stop marks
 * cancelled, boot recovery marks orphaned runs `interrupted` (resumable).
 *
 * Context variable store: node outputs are written to `context[output_var]`
 * (default: the node id). Template strings "${ctx.name}" inside node configs
 * resolve against it, so agent inputs/tool args can consume upstream outputs.
 */
import type { DataPort } from '../infra/types';
import { iso, uuid } from '../infra/types';
import type { EventBus } from '../kernel/bus';
import { safeJson } from '../kernel/bus';
import type { AgentRuntime } from './runtime';
import type { ToolRegistry } from './tools';
import * as store from './store';
import { config as appConfig } from '../config';
import type { FlowNode, FlowEdge, FlowRecord, FlowRunRecord } from '@agentic/contracts';

// ─── persistence ─────────────────────────────────────────────────────────────

export async function getFlow(db: DataPort, id: string): Promise<FlowRecord | null> {
  const rows = await db.query<any>('SELECT * FROM flows WHERE id = ?', [id]);
  return rows[0] ? parseFlow(rows[0]) : null;
}

export async function listFlows(db: DataPort): Promise<FlowRecord[]> {
  const rows = await db.query<any>('SELECT * FROM flows ORDER BY updated_at DESC');
  return rows.map(parseFlow);
}

export function parseFlow(r: any): FlowRecord {
  return {
    id: r.id, name: r.name, description: r.description,
    nodes: safeJson(r.nodes), edges: safeJson(r.edges),
    version: r.version, created_by: r.created_by, created_at: r.created_at, updated_at: r.updated_at,
  };
}

export async function getRun(db: DataPort, id: string): Promise<FlowRunRecord | null> {
  const rows = await db.query<any>('SELECT * FROM flow_runs WHERE id = ?', [id]);
  return rows[0] ? parseRun(rows[0]) : null;
}

export async function listRuns(db: DataPort, flowId?: string, limit = 50): Promise<FlowRunRecord[]> {
  const rows = flowId
    ? await db.query<any>('SELECT * FROM flow_runs WHERE flow_id = ? ORDER BY started_at DESC LIMIT ?', [flowId, limit])
    : await db.query<any>('SELECT * FROM flow_runs ORDER BY started_at DESC LIMIT ?', [limit]);
  return rows.map(parseRun);
}

export function parseRun(r: any): FlowRunRecord {
  return {
    id: r.id, flow_id: r.flow_id, flow_version: r.flow_version, user_id: r.user_id,
    status: r.status, input: safeJson(r.input), context: safeJson(r.context),
    current_node: r.current_node, completed_nodes: safeJson(r.completed_nodes),
    trace: safeJson(r.trace), result: r.result ? safeJson(r.result) : null, error: r.error,
    started_at: r.started_at, updated_at: r.updated_at, completed_at: r.completed_at,
  };
}

async function persistRun(db: DataPort, run: FlowRunRecord): Promise<void> {
  run.updated_at = iso();
  await db.run(
    `UPDATE flow_runs SET status = ?, context = ?, current_node = ?, completed_nodes = ?, trace = ?,
      result = ?, error = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
    [run.status, JSON.stringify(run.context), run.current_node, JSON.stringify(run.completed_nodes),
     JSON.stringify(run.trace.slice(-200)), run.result != null ? JSON.stringify(run.result) : null,
     run.error, run.updated_at, run.completed_at, run.id],
  );
}

// ─── validation ─────────────────────────────────────────────────────────────

export interface FlowValidation { ok: boolean; errors: string[] }

/** Structural validation: ids unique, edges reference real nodes, exactly one
 *  trigger, no cycles EXCEPT through loop nodes (loops are the sanctioned way
 *  to revisit nodes), condition/branch handles well-formed. */
export function validateFlow(nodes: FlowNode[], edges: FlowEdge[]): FlowValidation {
  const errors: string[] = [];
  const ids = new Set(nodes.map(n => n.id));
  if (nodes.length === 0) errors.push('flow needs at least one node');
  if (new Set(nodes.map(n => n.id)).size !== nodes.length) errors.push('duplicate node ids');
  const triggers = nodes.filter(n => n.kind === 'trigger');
  if (triggers.length !== 1) errors.push(`exactly one trigger node required (found ${triggers.length})`);
  for (const e of edges) {
    if (!ids.has(e.from)) errors.push(`edge ${e.id} references missing source ${e.from}`);
    if (!ids.has(e.to)) errors.push(`edge ${e.id} references missing target ${e.to}`);
  }
  for (const n of nodes) {
    if (n.kind === 'condition') {
      if (typeof n.config.expression !== 'string' || !n.config.expression) errors.push(`condition ${n.id} needs config.expression`);
    }
    if (n.kind === 'branch' && !n.config.value_from) errors.push(`branch ${n.id} needs config.value_from (ctx path)`);
    if (n.kind === 'loop') {
      const max = Number(n.config.max_iterations);
      if (!(max >= 1 && max <= 100)) errors.push(`loop ${n.id} needs config.max_iterations (1-100)`);
      if (!n.config.counter_var) n.config.counter_var = `__loop_${n.id}`;
    }
    if (n.kind === 'wait' && !(Number(n.config.seconds) >= 1 && Number(n.config.seconds) <= 300)) errors.push(`wait ${n.id} needs config.seconds (1-300)`);
    if (n.kind === 'agent' && !n.config.agent_name) errors.push(`agent node ${n.id} needs config.agent_name`);
    if (n.kind === 'skill' && !n.config.skill_name) errors.push(`skill node ${n.id} needs config.skill_name`);
    if (n.kind === 'tool' && !n.config.tool_name) errors.push(`tool node ${n.id} needs config.tool_name`);
  }
  // cycle detection ignoring loop-back edges: a cycle not passing through a
  // loop node would run forever — reject at save time
  try {
    const loopIds = new Set(nodes.filter(n => n.kind === 'loop').map(n => n.id));
    // walk from trigger; if we revisit a non-loop node via a non-loop path → cycle
    const trigger = triggers[0];
    if (trigger) {
      const visiting = new Set<string>();
      const dfs = (id: string): void => {
        if (visiting.has(id)) {
          if (!loopIds.has(id)) errors.push(`cycle detected at node ${id} (route loops through a non-loop node)`);
          return;
        }
        visiting.add(id);
        for (const e of edges.filter(x => x.from === id)) {
          // an edge leaving a loop node via the 'body' handle is the sanctioned back-edge
          if (loopIds.has(id) && e.from_handle === 'body') continue;
          dfs(e.to);
        }
        visiting.delete(id);
      };
      dfs(trigger.id);
    }
  } catch { /* defensive */ }
  return { ok: errors.length === 0, errors };
}

// ─── safe expression evaluation (condition nodes) ───────────────────────────

/** Tiny safe evaluator for condition expressions. Supports: ctx.path refs,
 *  string/number/boolean literals, ==, !=, >, <, >=, <=, &&, ||, !, parentheses.
 *  No property access on prototypes, no function calls — parser, not eval. */
export function evalCondition(expr: string, ctx: Record<string, unknown>): boolean {
  const tokens = tokenizeExpr(expr);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parsePrimary(): any {
    const t = next();
    if (t === undefined) throw new Error('unexpected end of expression');
    if (t === '(') { const v = parseOr(); if (next() !== ')') throw new Error('missing )'); return v; }
    if (t === '!') { return !parsePrimary(); }
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null') return null;
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    if (t.startsWith("'") || t.startsWith('"')) return t.slice(1, -1);
    if (t.startsWith('ctx.')) return resolvePath(ctx, t.slice(4));
    if (t === 'ctx') return ctx;
    throw new Error(`unknown token: ${t}`);
  }
  function parseComparison(): any {
    let left = parsePrimary();
    // string coercion for numeric-looking comparisons
    const op = peek();
    if (['==', '!=', '>', '<', '>=', '<='].includes(op ?? '')) {
      next();
      const right = parsePrimary();
      const l = typeof left === 'string' && right != null && !Number.isNaN(Number(left)) ? Number(left) : left;
      const r = typeof right === 'string' && left != null && !Number.isNaN(Number(right)) ? Number(right) : right;
      switch (op) {
        case '==': return l == r;        // eslint-disable-line eqeqeq
        case '!=': return l != r;        // eslint-disable-line eqeqeq
        case '>': return l > r;
        case '<': return l < r;
        case '>=': return l >= r;
        case '<=': return l <= r;
      }
    }
    return left;
  }
  function parseAnd(): any {
    let v = parseComparison();
    while (peek() === '&&') { next(); const r = parseComparison(); v = v && r; }
    return v;
  }
  function parseOr(): any {
    let v = parseAnd();
    while (peek() === '||') { next(); const r = parseAnd(); v = v || r; }
    return v;
  }

  const result = parseOr();
  if (pos < tokens.length) throw new Error(`unexpected token: ${tokens[pos]}`);
  return Boolean(result);
}

function tokenizeExpr(s: string): string[] {
  const out: string[] = [];
  const OPS = ['>=', '<=', '==', '!=', '&&', '||', '(', ')', '>', '<', '!'];
  const WORD = /^(?:'(?:[^']*)'|"(?:[^"]*)"|-?\d+(?:\.\d+)?|ctx(?:\.[A-Za-z0-9_.-]+)?|true|false|null)/;
  let i = 0;
  const skipSpace = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  while (i < s.length) {
    skipSpace();
    if (i >= s.length) break;
    // operators (longest first)
    const op = OPS.find(o => s.startsWith(o, i));
    if (op) { out.push(op); i += op.length; continue; }
    // words / literals
    const rest = s.slice(i);
    const m = WORD.exec(rest);
    if (m) { out.push(m[0]); i += m[0].length; continue; }
    throw new Error(`cannot parse expression near: ${s.slice(i, i + 12)}`);
  }
  return out;
}

function resolvePath(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

// ─── template resolution ("${ctx.foo}" → context value) ────────────────────

export function resolveTemplate(value: unknown, ctx: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const full = /^\$\{ctx\.([A-Za-z0-9_.-]+)\}$/.exec(value);
    if (full) return resolvePath(ctx, full[1]);
    return value.replace(/\$\{ctx\.([A-Za-z0-9_.-]+)\}/g, (_m, p) => {
      const v = resolvePath(ctx, p);
      return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    });
  }
  if (Array.isArray(value)) return value.map(v => resolveTemplate(v, ctx));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = resolveTemplate(v, ctx);
    return out;
  }
  return value;
}

// ─── the engine ─────────────────────────────────────────────────────────────

export interface FlowEngineDeps { db: DataPort; bus: EventBus; runtime: AgentRuntime; tools: ToolRegistry }

interface Control { pause: boolean; stop: boolean }

export class FlowEngine {
  private control = new Map<string, Control>();
  private waiting = new Map<string, (v: 'approved' | 'denied' | 'timeout' | 'cancelled') => void>();

  constructor(private deps: FlowEngineDeps) {}

  /** Start a run (fire-and-forget drive, like the agent runtime). */
  async start(flow: FlowRecord, userId: string, input: Record<string, unknown>): Promise<FlowRunRecord> {
    const run: FlowRunRecord = {
      id: uuid(), flow_id: flow.id, flow_version: flow.version, user_id: userId,
      status: 'running', input, context: { ...input }, current_node: null,
      completed_nodes: [], trace: [], result: null, error: null,
      started_at: iso(), updated_at: iso(), completed_at: null,
    };
    await this.deps.db.run(
      `INSERT INTO flow_runs (id, flow_id, flow_version, user_id, status, input, context, current_node, completed_nodes, trace, result, error, started_at, updated_at, completed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [run.id, run.flow_id, run.flow_version, run.user_id, run.status, JSON.stringify(run.input),
       JSON.stringify(run.context), null, '[]', '[]', null, null, run.started_at, run.updated_at, null],
    );
    this.control.set(run.id, { pause: false, stop: false });
    await this.deps.bus.emit('flow.run.started', { run_id: run.id, flow: flow.name, input_keys: Object.keys(input) },
      { actor_type: 'user', actor_id: userId, target_type: 'flow', target_id: flow.id });
    // fire-and-forget
    this.drive(flow, run).catch(async (e: any) => {
      run.status = 'failed'; run.error = String(e?.message ?? e); run.completed_at = iso();
      await persistRun(this.deps.db, run);
    });
    return run;
  }

  /** Resume an interrupted/paused run from its persisted checkpoint. */
  async resume(runId: string): Promise<FlowRunRecord | null> {
    const run = await getRun(this.deps.db, runId);
    if (!run || !['paused', 'interrupted', 'waiting'].includes(run.status)) return run;
    const flow = await getFlow(this.deps.db, run.flow_id);
    if (!flow) return null;
    run.status = 'running';
    await persistRun(this.deps.db, run);
    this.control.set(run.id, { pause: false, stop: false });
    await this.deps.bus.emit('flow.run.resumed', { run_id: run.id, from_node: run.current_node },
      { actor_type: 'user', target_type: 'flow', target_id: run.flow_id });
    this.drive(flow, run).catch(async (e: any) => {
      run.status = 'failed'; run.error = String(e?.message ?? e); run.completed_at = iso();
      await persistRun(this.deps.db, run);
    });
    return run;
  }

  async pause(runId: string): Promise<boolean> {
    const run = await getRun(this.deps.db, runId);
    if (!run || !['running', 'waiting'].includes(run.status)) return false;
    const ctl = this.control.get(runId);
    if (ctl) ctl.pause = true;
    this.waiting.get(runId)?.('cancelled'); // wake a waiting approval for a clean pause
    run.status = 'paused';
    await persistRun(this.deps.db, run);
    await this.deps.bus.emit('flow.run.paused', { run_id: runId }, { actor_type: 'user', target_type: 'flow', target_id: run.flow_id });
    return true;
  }

  async stop(runId: string): Promise<boolean> {
    const run = await getRun(this.deps.db, runId);
    if (!run || ['completed', 'failed', 'cancelled'].includes(run.status)) return false;
    const ctl = this.control.get(runId);
    if (ctl) ctl.stop = true;
    this.waiting.get(runId)?.('cancelled');
    run.status = 'cancelled'; run.completed_at = iso();
    await persistRun(this.deps.db, run);
    await this.deps.bus.emit('flow.run.cancelled', { run_id: runId }, { actor_type: 'user', target_type: 'flow', target_id: run.flow_id });
    return true;
  }

  /** The node walker. Checkpoints after every node. */
  private async drive(flow: FlowRecord, run: FlowRunRecord): Promise<void> {
    const { db, bus, runtime, tools } = this.deps;
    const nodes = new Map(flow.nodes.map(n => [n.id, n]));
    const edges = flow.edges;
    const trace = (node: string | null, kind: string, message: string, data?: unknown) => {
      run.trace.push({ ts: iso(), node, kind, message: message.slice(0, 240), data: data as any });
    };

    // resume: find where we left off. current_node is the node to (re)execute;
    // a null current_node on resume means start from the trigger.
    let nodeId: string | null = run.current_node;
    if (!nodeId) {
      const trigger = flow.nodes.find(n => n.kind === 'trigger');
      if (!trigger) throw new Error('flow has no trigger node');
      nodeId = trigger.id;
    }

    let steps = 0;
    const MAX_STEPS = 500; // hard bound: loops are capped by their own counters, this is the global guard

    while (nodeId) {
      const ctl = this.control.get(run.id);
      if (ctl?.stop) { run.status = 'cancelled'; run.completed_at = iso(); await persistRun(db, run); return; }
      if (ctl?.pause) {
        run.status = 'paused';
        run.current_node = nodeId;   // checkpoint: resume re-runs this node
        await persistRun(db, run);
        return;
      }
      if (++steps > MAX_STEPS) throw new Error(`flow exceeded ${MAX_STEPS} node visits (unbounded loop?)`);

      const node = nodes.get(nodeId);
      if (!node) throw new Error(`node ${nodeId} not found in flow definition`);

      // CHECKPOINT: mark the node in flight (at-least-once on resume)
      run.current_node = nodeId;
      await persistRun(db, run);
      await bus.emit('flow.node.started', { run_id: run.id, node: node.id, kind: node.kind, label: node.label },
        { actor_type: 'flow', target_type: 'flow', target_id: flow.id }).catch(() => {});
      trace(node.id, node.kind, `executing ${node.kind} node${node.label ? ` "${node.label}"` : ''}`);

      // ── execute the node ──
      const outVar = (node.config.output_var as string) || node.id;
      let outcome: 'next' | 'done' | { route: string } = 'next';
      try {
        switch (node.kind) {
          case 'trigger': {
            // seeds context from input (already done at start / resume) — also
            // allows config.defaults to fill missing values
            const defaults = (node.config.defaults ?? {}) as Record<string, unknown>;
            for (const [k, v] of Object.entries(defaults)) {
              if (run.context[k] === undefined) run.context[k] = resolveTemplate(v, run.context);
            }
            break;
          }
          case 'agent': {
            const agentName = String(node.config.agent_name);
            const agent = await store.getAgentByName(db, agentName);
            if (!agent) throw new Error(`agent not found: ${agentName}`);
            const inputText = String(resolveTemplate(node.config.input ?? '${ctx.input ?? ""}', run.context));
            const exec = await runtime.run({
              agent, input: inputText || `Flow "${flow.name}" node "${node.label ?? node.id}"`, user_id: run.user_id,
            });
            // wait for terminal state (same pattern as agent.delegate)
            const deadline = Date.now() + 5 * 60 * 1000;
            let ex = await store.getExecution(db, exec.id);
            while (ex && !['completed', 'failed', 'cancelled'].includes(ex.status) && Date.now() < deadline) {
              await sleep(300);
              ex = await store.getExecution(db, exec.id);
            }
            run.context[outVar] = { execution_id: exec.id, status: ex?.status, result: ex?.result, error: ex?.error };
            if (ex?.status === 'failed') throw new Error(`agent node failed: ${ex.error?.slice(0, 200)}`);
            trace(node.id, node.kind, `agent ${agentName} → ${ex?.status}`, { execution_id: exec.id });
            break;
          }
          case 'skill': {
            const skillName = String(node.config.skill_name);
            const skill = await store.getSkill(db, skillName);
            if (!skill) throw new Error(`skill not found: ${skillName}`);
            const agentName = String(node.config.agent_name ?? 'Hermes');
            const agent = await store.getAgentByName(db, agentName);
            if (!agent) throw new Error(`agent not found: ${agentName}`);
            const inputText = String(resolveTemplate(node.config.input ?? '${ctx.input ?? ""}', run.context));
            const exec = await runtime.run({ agent, input: inputText || `Run skill ${skillName}`, user_id: run.user_id, skill: skillName });
            const deadline = Date.now() + 5 * 60 * 1000;
            let ex = await store.getExecution(db, exec.id);
            while (ex && !['completed', 'failed', 'cancelled'].includes(ex.status) && Date.now() < deadline) {
              await sleep(300);
              ex = await store.getExecution(db, exec.id);
            }
            run.context[outVar] = { execution_id: exec.id, status: ex?.status, result: ex?.result };
            if (ex?.status === 'failed') throw new Error(`skill node failed: ${ex.error?.slice(0, 200)}`);
            trace(node.id, node.kind, `skill ${skillName} via ${agentName} → ${ex?.status}`, { execution_id: exec.id });
            break;
          }
          case 'tool': {
            const toolName = String(node.config.tool_name);
            const tool = tools.get(toolName);
            if (!tool) throw new Error(`tool not found: ${toolName}`);
            const args = resolveTemplate((node.config.args ?? {}) as Record<string, unknown>, run.context) as Record<string, unknown>;
            // required-arg check (same rule as the security gate)
            for (const [k, def] of Object.entries(tool.schema)) {
              if (def.required && (args[k] === undefined || args[k] === null || args[k] === '')) {
                throw new Error(`missing required arg "${k}" for tool ${toolName}`);
              }
            }
            const result = await tool.execute(args, {
              execution_id: run.id, agent: { id: 'flow', name: flow.name, tools: [toolName], model_policy: {} as any, memory_policy: {} as any, permissions: {} as any, autonomy_level: 4 } as any,
              user_id: run.user_id, depth: 0,
              emit: async () => {}, observe: () => {},
            });
            run.context[outVar] = result;
            trace(node.id, node.kind, `tool ${toolName} → ok`, { summary: JSON.stringify(result)?.slice(0, 160) });
            break;
          }
          case 'condition': {
            const expr = String(node.config.expression);
            const value = evalCondition(expr, run.context);
            run.context[outVar] = value;
            trace(node.id, node.kind, `condition "${expr}" → ${value}`);
            outcome = { route: value ? 'true' : 'false' };
            break;
          }
          case 'branch': {
            const value = resolvePath(run.context, String(node.config.value_from).replace(/^ctx\./, ''));
            const routes = edges.filter(e => e.from === node.id).map(e => String(e.from_handle ?? 'default'));
            const matched = routes.includes(String(value)) ? String(value)
              : routes.includes('default') ? 'default' : null;
            if (!matched) throw new Error(`branch node ${node.id}: no route matches "${String(value)}" and no default edge`);
            run.context[outVar] = matched;
            trace(node.id, node.kind, `branch on ${node.config.value_from}="${String(value)}" → route ${matched}`);
            outcome = { route: matched };
            break;
          }
          case 'loop': {
            const counterVar = String(node.config.counter_var ?? `__loop_${node.id}`);
            const max = Number(node.config.max_iterations ?? 5);
            const cur = Number(run.context[counterVar] ?? 0);
            if (cur < max) {
              run.context[counterVar] = cur + 1;
              trace(node.id, node.kind, `loop iteration ${cur + 1}/${max}`);
              outcome = { route: 'body' };
            } else {
              trace(node.id, node.kind, `loop finished after ${cur} iterations`);
              outcome = { route: 'exit' };
            }
            break;
          }
          case 'wait': {
            const seconds = Math.min(300, Math.max(1, Number(node.config.seconds ?? 5)));
            const until = Date.now() + seconds * 1000;
            run.status = 'waiting';
            await persistRun(db, run);
            await bus.emit('flow.waiting', { run_id: run.id, node: node.id, seconds }, { actor_type: 'flow', target_type: 'flow', target_id: flow.id });
            await sleep(seconds * 1000);
            if (this.control.get(run.id)?.stop) { run.status = 'cancelled'; run.completed_at = iso(); await persistRun(db, run); return; }
            run.status = 'running';
            trace(node.id, node.kind, `waited ${seconds}s`);
            break;
          }
          case 'approval': {
            const reason = String(node.config.reason ?? 'Flow approval gate');
            const approval = await store.createApproval(db, {
              execution_id: run.id, agent_id: 'flow', tool: `flow:${flow.name}`, args: { node: node.id }, reason,
            });
            run.status = 'waiting';
            await persistRun(db, run);
            await bus.emit('flow.approval.requested', { run_id: run.id, node: node.id, approval_id: approval.id, reason },
              { actor_type: 'flow', target_type: 'flow', target_id: flow.id });
            const notif = await store.notify(db, {
              user_id: run.user_id, title: `Flow approval: ${flow.name}`,
              message: reason, priority: 'high', category: 'approval', source: 'flow',
              related_type: 'approval', related_id: approval.id,
            });
            await bus.emit('notification.created', { id: notif.id, title: notif.title }, { actor_type: 'system', target_type: 'notification', target_id: notif.id });
            // poll the approval decision (flow runs live outside the agent runtime's waiter map)
            const decision = await this.awaitApproval(run.id, approval.id);
            run.status = 'running';
            if (decision !== 'approved') {
              run.context[outVar] = decision;
              if (decision === 'cancelled') { run.status = 'paused'; run.current_node = node.id; await persistRun(db, run); return; }
              throw new Error(`approval ${decision} — flow stopped at node ${node.id}`);
            }
            run.context[outVar] = 'approved';
            trace(node.id, node.kind, `approval ${decision}`);
            break;
          }
        }
      } catch (e: any) {
        run.status = 'failed';
        run.error = String(e?.message ?? e);
        run.completed_at = iso();
        trace(node.id, 'error', run.error);
        await persistRun(db, run);
        await bus.emit('flow.run.failed', { run_id: run.id, node: node.id, error: run.error },
          { actor_type: 'flow', target_type: 'flow', target_id: flow.id });
        return;
      }

      run.completed_nodes.push(node.id);
      // route: outcome route (condition/branch/loop) or the single outgoing edge
      let nextId: string | null = null;
      if (outcome !== 'next' && typeof outcome === 'object') {
        const edge = edges.find(e => e.from === node.id && String(e.from_handle ?? '') === outcome.route);
        if (!edge) {
          // 'true'/'false' with no matching edge → treat missing false-branch as flow end (if-condition pattern)
          if (node.kind === 'condition' && outcome.route === 'false') { nextId = null; }
          else throw new Error(`node ${node.id}: no edge for route "${outcome.route}"`);
        } else {
          nextId = edge.to;
        }
      } else {
        const out = edges.filter(e => e.from === node.id && !e.from_handle);
        if (out.length === 0) nextId = null;
        else if (out.length > 1) throw new Error(`node ${node.id} has ${out.length} plain outgoing edges — use a branch node`);
        else nextId = out[0].to;
      }

      run.current_node = nextId;
      await persistRun(db, run);
      await bus.emit('flow.node.completed', { run_id: run.id, node: node.id }, { actor_type: 'flow', target_type: 'flow', target_id: flow.id }).catch(() => {});
      nodeId = nextId;
    }

    // no next node → flow end
    run.status = 'completed';
    run.result = (run.context.result !== undefined ? run.context.result : run.context) as any;
    run.completed_at = iso();
    trace(null, 'done', 'flow completed');
    await persistRun(db, run);
    await bus.emit('flow.run.completed', { run_id: run.id, flow: flow.name, nodes_completed: run.completed_nodes.length },
      { actor_type: 'flow', target_type: 'flow', target_id: flow.id });
  }

  /** Poll an approval row until decided / timeout / cancelled by pause-stop. */
  private async awaitApproval(runId: string, approvalId: string): Promise<'approved' | 'denied' | 'timeout' | 'cancelled'> {
    return new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(async () => {
        const rows = await this.deps.db.query<any>('SELECT status FROM approvals WHERE id = ?', [approvalId]);
        const status = rows[0]?.status;
        if (this.control.get(runId)?.stop) { clearInterval(timer); resolve('cancelled'); return; }
        if (status && status !== 'pending') { clearInterval(timer); resolve(status === 'approved' ? 'approved' : 'denied'); return; }
        if (Date.now() - started > appConfig.approvalTimeoutS * 1000) { clearInterval(timer); resolve('timeout'); }
      }, 1500);
    });
  }

  /** Boot recovery: runs orphaned by a crash are marked interrupted (resumable). */
  async recoverInterrupted(): Promise<number> {
    const rows = await this.deps.db.query<any>(
      "SELECT id FROM flow_runs WHERE status IN ('running', 'waiting')");
    for (const r of rows) {
      await this.deps.db.run("UPDATE flow_runs SET status = 'interrupted', updated_at = ? WHERE id = ?", [iso(), r.id]);
      await this.deps.bus.emit('flow.run.paused', { run_id: r.id, reason: 'process restart (interrupted)' },
        { actor_type: 'system', target_type: 'flow', target_id: r.id }).catch(() => {});
    }
    return rows.length;
  }
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }
