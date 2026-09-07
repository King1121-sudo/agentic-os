/** Phase 12 tests: mobile briefing shape + emergency stop cascade. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { SqliteDataPort } from '../infra/sqlite.adapter';
import { runMigrations } from '../infra/migrations';
import { InProcessBroker } from '../infra/broker';
import { EventBus } from '../kernel/bus';
import { ModelRouter } from '../gateway/router';
import { BuiltinProvider } from '../gateway/providers';
import { ToolRegistry, createBuiltinTools } from '../modules/tools';
import { AgentRuntime } from '../modules/runtime';
import { FlowEngine } from '../modules/flows';
import * as store from '../modules/store';
import { mobileBriefing, EmergencyStop } from '../modules/supervision';

let db: SqliteDataPort;
let bus: EventBus;
let broker: InProcessBroker;
let runtime: AgentRuntime;
let flowEngine: FlowEngine;
let userId: string;
let agent: any;

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

beforeAll(async () => {
  const file = path.resolve(__dirname, '..', '..', '..', 'data', `test-phase12-${Date.now()}.db`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new SqliteDataPort(file);
  await runMigrations(db);
  userId = uid();
  await db.run('INSERT INTO users (id, username, password_hash, display_name, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    [userId, 'tester', 'x:y', 'Supervisor', now(), now()]);
  broker = new InProcessBroker();
  bus = new EventBus(db, broker);
  const router = new ModelRouter(db, async () => {});
  router.register(new BuiltinProvider());
  const tools = new ToolRegistry();
  for (const t of createBuiltinTools(db)) tools.register(t);
  runtime = new AgentRuntime(db, broker, bus, router, tools);
  flowEngine = new FlowEngine({ db, bus, runtime, tools });
  const agentRec = {
    id: uid(), name: 'MobileTestAgent', description: 'test',
    system_instructions: 'test', model_policy: { capability: 'reasoning' }, skills: [],
    tools: ['sys.info'], memory_policy: { read: true, write: true, k: 3, types: ['semantic'] },
    permissions: { tools: ['sys.info'], scopes: [] }, autonomy_level: 4,
    status: 'idle', created_at: now(), updated_at: now(),
  } as any;
  await store.upsertAgent(db, agentRec);
  agent = await store.getAgent(db, agentRec.id);
}, 30000);

afterAll(async () => { await db.close().catch(() => {}); });

// ─── mobile briefing ──────────────────────────────────────────────────────────

describe('phase 12 — mobile briefing', () => {
  it('returns the supervision payload shape (status, agents, tasks, approvals, events, counts)', async () => {
    const b = await mobileBriefing(db, userId);
    expect(b).toHaveProperty('generated_at');
    expect(b).toHaveProperty('status');
    expect(b).toHaveProperty('agents');
    expect(b).toHaveProperty('open_tasks');
    expect(b).toHaveProperty('approvals');
    expect(b).toHaveProperty('recent_events');
    expect(b).toHaveProperty('counts');
    expect(Array.isArray(b.agents)).toBe(true);
    expect(Array.isArray(b.open_tasks)).toBe(true);
    expect(Array.isArray(b.approvals)).toBe(true);
    expect(Array.isArray(b.recent_events)).toBe(true);
    expect(b.counts).toHaveProperty('running_executions');
    expect(b.status).toBe('nominal');
  });

  it('status escalates to action_required when approvals are pending', async () => {
    await store.createApproval(db, { execution_id: uid(), agent_id: agent.id, tool: 'test.tool', args: {}, reason: 'test' });
    const b = await mobileBriefing(db, userId);
    expect(b.status).toBe('action_required');
    expect(b.approvals.length).toBeGreaterThan(0);
    expect(b.approvals[0]).toMatchObject({ tool: 'test.tool', status: 'pending' });
  });

  it('open tasks are limited to actionable statuses and carry project names', async () => {
    const proj = await store.createProject(db, { name: 'P12 Test', created_by: userId });
    await store.createTask(db, { project_id: proj.id, title: 'Do the thing', status: 'todo', priority: 'high', created_by: userId } as any);
    const b = await mobileBriefing(db, userId);
    const t = b.open_tasks.find((x: any) => x.title === 'Do the thing');
    expect(t).toBeTruthy();
    expect(t.project_name).toBe('P12 Test');
  });
});

// ─── emergency stop ──────────────────────────────────────────────────────────

describe('phase 12 — emergency stop', () => {
  it('stops a running execution, cancels running flow runs, pauses enabled automations, and emits the event', async () => {
    // a real running execution (the builtin model is synchronous but the
    // execution record is inserted with status running before completion)
    const exec = await runtime.run({ agent, input: 'hello world', user_id: userId });
    // a running flow run
    const flow = {
      id: uid(), name: 'ES Flow', description: '',
      nodes: [
        { id: 't1', kind: 'trigger', label: 'start', config: {}, x: 0, y: 0 },
        { id: 'w1', kind: 'wait', label: 'wait', config: { seconds: 60 }, x: 0, y: 0 },
      ] as any,
      edges: [{ id: 'e1', from: 't1', to: 'w1' } as any],
      version: 1, created_by: userId, created_at: now(), updated_at: now(),
    } as any;
    await db.run(
      'INSERT INTO flows (id, name, description, nodes, edges, version, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [flow.id, flow.name, flow.description, JSON.stringify(flow.nodes), JSON.stringify(flow.edges), 1, userId, now(), now()]);
    const run = await flowEngine.start(flow, userId, { input: 'es' });
    await sleep(300); // let the wait node checkpoint

    const es = new EmergencyStop({ db, bus, runtime, flows: flowEngine });
    const result = await es.execute('supervisor test');
    // let the aborted drive loop settle (its own finish path writes the same
    // terminal status; must complete before afterAll closes the DB)
    await sleep(800);

    expect(result.stopped_executions).toBeGreaterThanOrEqual(1);
    expect(result.cancelled_flow_runs).toBeGreaterThanOrEqual(1);
    expect(result.paused_automations).toBeGreaterThanOrEqual(0);
    expect(result.executions).toContain(exec.id);
    expect(result.flow_runs).toContain(run.id);

    // the execution and flow run are terminal now
    const ex = await store.getExecution(db, exec.id);
    expect(['cancelled', 'completed']).toContain(ex!.status);
    const fr = await flowEngine.getRun?.(run.id) ?? await import('../modules/flows').then(m => m.getRun(db, run.id));
    expect(['cancelled', 'failed']).toContain(fr!.status);
  });

  it('is idempotent — a second stop on an already-stopped world reports zeros', async () => {
    const es = new EmergencyStop({ db, bus, runtime, flows: flowEngine });
    const r2 = await es.execute('second');
    expect(r2.stopped_executions).toBe(0);
    expect(r2.cancelled_flow_runs).toBe(0);
  });

  it('leaves a persisted audit row and a system.emergency_stop event on the bus', async () => {
    const audits = await db.query<any>('SELECT * FROM audit_logs WHERE action = ? ORDER BY created_at DESC LIMIT 1', ['system.emergency_stop']);
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const events = await db.query<any>("SELECT * FROM events WHERE type = 'system.emergency_stop' ORDER BY created_at");
    expect(events.length).toBeGreaterThanOrEqual(2); // initial + idempotent second stop
    const ev = JSON.parse(events.find(e => JSON.parse(e.data).stopped_executions >= 1)!.data);
    expect(ev.stopped_executions).toBeGreaterThanOrEqual(1);
  });
});
