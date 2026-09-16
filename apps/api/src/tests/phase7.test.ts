/** Phase 7 tests: flow validation, condition expressions, engine execution
 * (branch/loop/wait semantics), checkpoint pause/resume, cancel, recovery. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { SqliteDataPort } from '../infra/sqlite.adapter';
import { runMigrations } from '../infra/migrations';
import { InProcessBroker } from '../infra/broker';
import { EventBus } from '../kernel/bus';
import { ModelRouter } from '../gateway/router';
import { BuiltinProvider } from '../gateway/providers';
import { ToolRegistry, createBuiltinTools, setRuntimeRef } from '../modules/tools';
import { AgentRuntime } from '../modules/runtime';
import * as store from '../modules/store';
import { FlowEngine, validateFlow, evalCondition, resolveTemplate, getRun } from '../modules/flows';
import type { FlowNode, FlowEdge, FlowRunRecord } from '@agentic/contracts';

let db: SqliteDataPort;
let bus: EventBus;
let runtime: AgentRuntime;
let engine: FlowEngine;

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const node = (id: string, kind: FlowNode['kind'], config: Record<string, unknown> = {}): FlowNode =>
  ({ id, kind, config, label: id });
const edge = (from: string, to: string, handle?: string): FlowEdge =>
  ({ id: `e-${from}-${to}${handle ? '-' + handle : ''}`, from, to, from_handle: handle });

let userId: string;

beforeAll(async () => {
  const file = path.resolve(__dirname, '..', '..', '..', 'data', `test-phase7-${Date.now()}.db`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new SqliteDataPort(file);
  await runMigrations(db);
  userId = uid();
  await db.run('INSERT INTO users (id, username, password_hash, display_name, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    [userId, 'tester', 'x:y', 'T', now(), now()]);

  bus = new EventBus(db, new InProcessBroker());
  const router = new ModelRouter(db, async () => {});
  router.register(new BuiltinProvider());
  await router.bootstrap();

  const tools = new ToolRegistry();
  for (const t of createBuiltinTools(db)) tools.register(t);
  runtime = new AgentRuntime(db, new InProcessBroker(), bus, router, tools);
  setRuntimeRef(runtime);
  engine = new FlowEngine({ db, bus, runtime, tools });

  // test agents the flow agent-nodes will use
  await store.upsertAgent(db, {
    id: uid(), name: 'Hermes', description: 'supervisor', system_instructions: 'supervise',
    model_policy: { capability: 'reasoning', preference: [] },
    skills: [], tools: ['memory.search', 'memory.write', 'sys.info'],
    memory_policy: { read: true, write: true, k: 3, types: [] },
    permissions: { tools: [], scopes: ['memory:read', 'memory:write', 'system:read'] },
    autonomy_level: 3, status: 'idle', created_at: now(), updated_at: now(),
  } as any);
}, 30000);

afterAll(async () => { await db.close().catch(() => {}); });

async function insertFlow(name: string, nodes: FlowNode[], edges: FlowEdge[]): Promise<string> {
  const id = uid();
  await db.run(
    'INSERT INTO flows (id, name, description, nodes, edges, version, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [id, name, '', JSON.stringify(nodes), JSON.stringify(edges), '0.1.0', userId, now(), now()]);
  return id;
}

async function waitForRun(runId: string, timeoutMs = 30000): Promise<FlowRunRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await getRun(db, runId);
    if (run && ['completed', 'failed', 'cancelled', 'paused'].includes(run.status)) return run;
    await sleep(250);
  }
  throw new Error(`run ${runId} did not settle in ${timeoutMs}ms`);
}

// ─── validation ──────────────────────────────────────────────────────────────
describe('phase 7 — flow validation', () => {
  it('accepts a well-formed graph', () => {
    const v = validateFlow(
      [node('t', 'trigger'), node('a', 'agent', { agent_name: 'Hermes' })],
      [edge('t', 'a')],
    );
    expect(v.ok).toBe(true);
  });

  it('rejects: missing trigger, duplicate ids, dangling edges, bad node config, non-loop cycles', () => {
    expect(validateFlow([node('t', 'trigger')], []).ok).toBe(true);
    expect(validateFlow([], []).ok).toBe(false);
    expect(validateFlow([node('t', 'trigger'), node('t', 'agent', { agent_name: 'X' })], []).ok).toBe(false); // dup ids
    expect(validateFlow([node('t', 'trigger')], [edge('t', 'ghost')]).ok).toBe(false);                       // dangling target
    expect(validateFlow([node('t', 'trigger'), node('a', 'agent')], [edge('t', 'a')]).ok).toBe(false);       // agent without name
    expect(validateFlow([node('t', 'trigger'), node('c', 'condition')], [edge('t', 'c')]).ok).toBe(false);   // condition without expression
    expect(validateFlow([node('t', 'trigger'), node('w', 'wait', { seconds: 999 })], [edge('t', 'w')]).ok).toBe(false); // wait out of range
    // two triggers
    expect(validateFlow([node('t1', 'trigger'), node('t2', 'trigger')], []).ok).toBe(false);
    // cycle NOT through a loop node → rejected
    const cyc = validateFlow(
      [node('t', 'trigger'), node('a', 'agent', { agent_name: 'H' }), node('b', 'agent', { agent_name: 'H' })],
      [edge('t', 'a'), edge('a', 'b'), edge('b', 'a')],
    );
    expect(cyc.ok).toBe(false);
    expect(cyc.errors.join(' ')).toContain('cycle');
    // same cycle but through a loop node → sanctioned
    const looped = validateFlow(
      [node('t', 'trigger'), node('l', 'loop', { max_iterations: 3 }), node('a', 'agent', { agent_name: 'H' })],
      [edge('t', 'l'), edge('l', 'a', 'body'), edge('a', 'l'), edge('l', 'end-node-x'), ],
    );
    expect(looped.ok).toBe(false); // edge to missing 'end-node-x' — fix below
    const looped2 = validateFlow(
      [node('t', 'trigger'), node('l', 'loop', { max_iterations: 3 }), node('a', 'agent', { agent_name: 'H' })],
      [edge('t', 'l'), edge('l', 'a', 'body'), edge('a', 'l'), edge('l', 't2x') ].map(e => e.to === 't2x' ? { ...e, to: 't' } : e).map(e => e.to === 'l' && e.from === 'a' ? e : e),
    );
    // loop body a→l is a sanctioned back-edge (a is reached only via loop body)
    expect(looped2.ok).toBe(false); // still dangling unless target exists; construct cleanly:
    const clean = validateFlow(
      [node('t', 'trigger'), node('l', 'loop', { max_iterations: 3 }), node('a', 'agent', { agent_name: 'H' })],
      [edge('t', 'l'), edge('l', 'a', 'body'), edge('a', 'l'), edge('l', 'l2x')].map(e => e.to === 'l2x' ? { ...e, to: 'l' } : e),
    );
    expect(clean.ok).toBe(true); // loop → body → back to loop is allowed
  });
});

// ─── condition expressions ─────────────────────────────────────────────────
describe('phase 7 — condition evaluation (safe parser)', () => {
  const ctx = { score: 7, name: 'apollo', count: '3', flag: true, nested: { depth: 2 } };
  it('evaluates comparisons, booleans, paths, and/or/not', () => {
    expect(evalCondition('ctx.score > 5', ctx)).toBe(true);
    expect(evalCondition('ctx.score < 5', ctx)).toBe(false);
    expect(evalCondition('ctx.score >= 7 && ctx.flag', ctx)).toBe(true);
    expect(evalCondition('ctx.score == 7', ctx)).toBe(true);
    expect(evalCondition('ctx.score != 7 || ctx.flag', ctx)).toBe(true);
    expect(evalCondition("!ctx.flag", ctx)).toBe(false);
    expect(evalCondition('ctx.name == "apollo"', ctx)).toBe(true);
    expect(evalCondition('ctx.count > 2', ctx)).toBe(true);       // numeric string coercion
    expect(evalCondition('ctx.nested.depth == 2', ctx)).toBe(true); // nested path
    expect(evalCondition('(ctx.score > 5) && (ctx.flag || false)', ctx)).toBe(true);
  });
  it('is safe: rejects junk and unknown tokens', () => {
    expect(() => evalCondition('process.exit(1)', ctx)).toThrow();
    expect(() => evalCondition('ctx.score >', ctx)).toThrow();
    expect(() => evalCondition('foo bar', ctx)).toThrow();
  });
});

// ─── template resolution ────────────────────────────────────────────────────
describe('phase 7 — ctx templates', () => {
  it('resolves ${ctx.x} inside strings and structures', () => {
    const ctx = { who: 'apollo', nested: { v: 42 } };
    expect(resolveTemplate('hello ${ctx.who}', ctx)).toBe('hello apollo');
    expect(resolveTemplate('${ctx.who}', ctx)).toBe('apollo');
    expect(resolveTemplate('${ctx.nested.v}', ctx)).toBe(42); // full-match keeps the type
    expect(resolveTemplate({ q: '${ctx.who}', list: ['${ctx.who}'] }, ctx)).toEqual({ q: 'apollo', list: ['apollo'] });
  });
});

// ─── engine E2E ─────────────────────────────────────────────────────────────
describe('phase 7 — engine execution', () => {
  it('runs a linear flow: trigger → tool → condition(true) → tool end', async () => {
    const flowId = await insertFlow('linear', [
      node('t', 'trigger'),
      node('w', 'tool', { tool_name: 'memory.write', args: { content: 'flow test note', type: 'semantic' } }),
      node('c', 'condition', { expression: 'ctx.w && true' }),
      node('done', 'tool', { tool_name: 'sys.info' }),
    ], [edge('t', 'w'), edge('w', 'c'), edge('c', 'done', 'true')]);
    const flow = { id: flowId, name: 'linear', description: '', nodes: [], edges: [], version: '0.1.0', created_by: null, created_at: '', updated_at: '' };
    const flowRow = await db.query<any>('SELECT * FROM flows WHERE id = ?', [flowId]);
    flow.nodes = JSON.parse(flowRow[0].nodes); flow.edges = JSON.parse(flowRow[0].edges);

    const run = await engine.start(flow as any, userId, { input: 'go' });
    const settled = await waitForRun(run.id);
    expect(settled.status).toBe('completed');
    expect(settled.completed_nodes).toEqual(['t', 'w', 'c', 'done']);
    // memory.write output landed in context
    expect(settled.context.w).toBeDefined();
    expect((settled.context.w as { memory?: unknown }).memory).toBeDefined();
    expect(settled.trace.some(t => t.message.includes('condition'))).toBe(true);
  }, 45000);

  it('condition without a false-edge ends the flow on false', async () => {
    const flowId = await insertFlow('cond-false-end', [
      node('t', 'trigger'),
      node('c', 'condition', { expression: 'ctx.missing == "nope"' }),
      node('never', 'tool', { tool_name: 'sys.info' }),
    ], [edge('t', 'c'), edge('c', 'never', 'true')]);
    const row = await db.query<any>('SELECT * FROM flows WHERE id = ?', [flowId]);
    const flow = { id: flowId, name: '', description: '', nodes: JSON.parse(row[0].nodes), edges: JSON.parse(row[0].edges), version: '0.1.0' };
    const run = await engine.start(flow as any, userId, {});
    const settled = await waitForRun(run.id);
    expect(settled.status).toBe('completed');
    expect(settled.completed_nodes).toEqual(['t', 'c']); // never ran
  });

  it('branch routes by ctx value to labeled edges', async () => {
    const flowId = await insertFlow('branchy', [
      node('t', 'trigger'),
      node('b', 'branch', { value_from: 'ctx.route' }),
      node('a-path', 'tool', { tool_name: 'sys.info', output_var: 'out_a' }),
      node('b-path', 'tool', { tool_name: 'sys.info', output_var: 'out_b' }),
    ], [edge('t', 'b'), edge('b', 'a-path', 'alpha'), edge('b', 'b-path', 'beta'), edge('b', 'a-path', 'default')]);
    const row = await db.query<any>('SELECT * FROM flows WHERE id = ?', [flowId]);
    const flow = { id: flowId, name: '', description: '', nodes: JSON.parse(row[0].nodes), edges: JSON.parse(row[0].edges), version: '0.1.0' };
    const run = await engine.start(flow as any, userId, { route: 'beta' });
    const settled = await waitForRun(run.id);
    expect(settled.status).toBe('completed');
    expect(settled.completed_nodes).toContain('b-path');
    expect(settled.completed_nodes).not.toContain('a-path');
  });

  it('loop iterates the body max_iterations times then exits', async () => {
    const flowId = await insertFlow('loopy', [
      node('t', 'trigger'),
      node('l', 'loop', { max_iterations: 3, counter_var: 'i' }),
      node('body', 'tool', { tool_name: 'sys.info' }),
      node('after', 'tool', { tool_name: 'sys.info', output_var: 'after_out' }),
    ], [edge('t', 'l'), edge('l', 'body', 'body'), edge('body', 'l'), edge('l', 'after', 'exit')]);
    const row = await db.query<any>('SELECT * FROM flows WHERE id = ?', [flowId]);
    const flow = { id: flowId, name: '', description: '', nodes: JSON.parse(row[0].nodes), edges: JSON.parse(row[0].edges), version: '0.1.0' };
    const run = await engine.start(flow as any, userId, {});
    const settled = await waitForRun(run.id);
    expect(settled.status).toBe('completed');
    // body visited exactly 3 times
    const bodyVisits = settled.completed_nodes.filter(n => n === 'body').length;
    expect(bodyVisits).toBe(3);
    expect(settled.context.i).toBe(3);
    expect(settled.completed_nodes[settled.completed_nodes.length - 1]).toBe('after');
  });

  it('wait node sleeps and completes', async () => {
    const flowId = await insertFlow('waity', [
      node('t', 'trigger'),
      node('w', 'wait', { seconds: 1 }),
      node('end', 'tool', { tool_name: 'sys.info' }),
    ], [edge('t', 'w'), edge('w', 'end')]);
    const row = await db.query<any>('SELECT * FROM flows WHERE id = ?', [flowId]);
    const flow = { id: flowId, name: '', description: '', nodes: JSON.parse(row[0].nodes), edges: JSON.parse(row[0].edges), version: '0.1.0' };
    const run = await engine.start(flow as any, userId, {});
    const settled = await waitForRun(run.id, 15000);
    expect(settled.status).toBe('completed');
    expect(settled.completed_nodes).toContain('w');
    expect(settled.trace.some(t => t.message.includes('waited'))).toBe(true);
  });

  it('agent node runs the agent to completion and stores its result', async () => {
    const flowId = await insertFlow('agenty', [
      node('t', 'trigger'),
      node('a', 'agent', { agent_name: 'Hermes', input: 'what system info do you have' }),
    ], [edge('t', 'a')]);
    const row = await db.query<any>('SELECT * FROM flows WHERE id = ?', [flowId]);
    const flow = { id: flowId, name: '', description: '', nodes: JSON.parse(row[0].nodes), edges: JSON.parse(row[0].edges), version: '0.1.0' };
    const run = await engine.start(flow as any, userId, {});
    const settled = await waitForRun(run.id, 45000);
    expect(settled.status).toBe('completed');
    // context is Record<string, unknown>; assert the shape the agent node writes
    const a = settled.context.a as { status: string; execution_id?: string; result?: unknown };
    expect(a.status).toBe('completed');
    expect(a.execution_id).toBeDefined();
    expect(a.result).toBeTruthy();
  }, 60000);

  it('stop cancels a running flow', async () => {
    const flowId = await insertFlow('stoppable', [
      node('t', 'trigger'),
      node('w1', 'wait', { seconds: 30 }),
      node('end', 'tool', { tool_name: 'sys.info' }),
    ], [edge('t', 'w1'), edge('w1', 'end')]);
    const row = await db.query<any>('SELECT * FROM flows WHERE id = ?', [flowId]);
    const flow = { id: flowId, name: '', description: '', nodes: JSON.parse(row[0].nodes), edges: JSON.parse(row[0].edges), version: '0.1.0' };
    const run = await engine.start(flow as any, userId, {});
    await sleep(500); // let it enter the wait
    expect(await engine.stop(run.id)).toBe(true);
    const settled = await waitForRun(run.id);
    expect(settled.status).toBe('cancelled');
    expect(settled.completed_nodes).toEqual(['t']);
  });

  it('pause checkpoints; resume continues from the wait node', async () => {
    const flowId = await insertFlow('pausable', [
      node('t', 'trigger'),
      node('w1', 'wait', { seconds: 5 }),
      node('end', 'tool', { tool_name: 'sys.info', output_var: 'end_out' }),
    ], [edge('t', 'w1'), edge('w1', 'end')]);
    const row = await db.query<any>('SELECT * FROM flows WHERE id = ?', [flowId]);
    const flow = { id: flowId, name: '', description: '', nodes: JSON.parse(row[0].nodes), edges: JSON.parse(row[0].edges), version: '0.1.0' };
    const run = await engine.start(flow as any, userId, {});
    await sleep(400); // trigger done, wait in flight
    // pause takes effect at the next node boundary → current_node stays w1
    await engine.pause(run.id);
    const paused = await waitForRun(run.id);
    expect(paused.status).toBe('paused');
    expect(['w1', 't']).toContain(paused.current_node);

    // resume: the wait re-runs (at-least-once) and the flow completes
    await engine.resume(run.id);
    const settled = await waitForRun(run.id, 30000);
    expect(settled.status).toBe('completed');
    expect(settled.completed_nodes).toContain('end');
  }, 60000);

  it('boot recovery marks running flows interrupted', async () => {
    const flowId = await insertFlow('crashy', [
      node('t', 'trigger'),
      node('w1', 'wait', { seconds: 30 }),
    ], [edge('t', 'w1')]);
    const row = await db.query<any>('SELECT * FROM flows WHERE id = ?', [flowId]);
    const flow = { id: flowId, name: '', description: '', nodes: JSON.parse(row[0].nodes), edges: JSON.parse(row[0].edges), version: '0.1.0' };
    const run = await engine.start(flow as any, userId, {});
    await sleep(300);
    // simulate a crash: force status back to 'running' with no live control entry
    await db.run("UPDATE flow_runs SET status = 'running' WHERE id = ?", [run.id]);
    const n = await engine.recoverInterrupted();
    expect(n).toBeGreaterThanOrEqual(1);
    const after = await getRun(db, run.id);
    expect(after!.status).toBe('interrupted');
    // resume completes it (wait re-runs at 30s — stop it right after resume to keep the test fast)
    const resumed = await engine.resume(run.id);
    expect(resumed!.status).toBe('running');
    await sleep(300);
    await engine.stop(run.id);
  });

  it('tool node with missing required args fails the run with a clear error', async () => {
    const flowId = await insertFlow('badargs', [
      node('t', 'trigger'),
      node('bad', 'tool', { tool_name: 'memory.write', args: {} }), // content required
    ], [edge('t', 'bad')]);
    const row = await db.query<any>('SELECT * FROM flows WHERE id = ?', [flowId]);
    const flow = { id: flowId, name: '', description: '', nodes: JSON.parse(row[0].nodes), edges: JSON.parse(row[0].edges), version: '0.1.0' };
    const run = await engine.start(flow as any, userId, {});
    const settled = await waitForRun(run.id);
    expect(settled.status).toBe('failed');
    expect(settled.error).toContain('required arg "content"');
  });
});
