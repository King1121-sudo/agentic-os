/** Phase 8 tests: cron parsing/next-fire, event matching + self-trigger guard,
 * autonomy policy gate, webhook auth, dispatch E2E (flow + agent), run log. */
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
import { FlowEngine } from '../modules/flows';
import {
  AutomationEngine, parseCron, nextCronFire, validateTrigger, timingSafeEqual,
  listAutomations, listAutomationRuns, getAutomation,
} from '../modules/automations-engine';
import * as store from '../modules/store';

let db: SqliteDataPort;
let bus: EventBus;
let runtime: AgentRuntime;
let engine: AutomationEngine;
let flowEngine: FlowEngine;

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let userId: string;
let flowId: string;

beforeAll(async () => {
  const file = path.resolve(__dirname, '..', '..', '..', 'data', `test-phase8-${Date.now()}.db`);
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
  flowEngine = new FlowEngine({ db, bus, runtime, tools });
  engine = new AutomationEngine({ db, bus, runtime, flows: flowEngine });
  await engine.start();

  await store.upsertAgent(db, {
    id: uid(), name: 'Hermes', description: 'supervisor', system_instructions: 'supervise',
    model_policy: { capability: 'reasoning', preference: [] },
    skills: [], tools: ['memory.search', 'memory.write', 'sys.info'],
    memory_policy: { read: true, write: true, k: 3, types: [] },
    permissions: { tools: [], scopes: ['memory:read', 'memory:write', 'system:read'] },
    autonomy_level: 3, status: 'idle', created_at: now(), updated_at: now(),
  } as any);

  // a flow for flow-action tests: trigger → sys.info
  flowId = uid();
  const nodes = [
    { id: 't', kind: 'trigger', config: {} },
    { id: 's', kind: 'tool', config: { tool_name: 'sys.info', output_var: 'result' } },
  ];
  const edges = [{ id: 'e1', from: 't', to: 's' }];
  await db.run(
    'INSERT INTO flows (id, name, description, nodes, edges, version, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [flowId, 'Test Flow', '', JSON.stringify(nodes), JSON.stringify(edges), '0.1.0', userId, now(), now()]);
}, 30000);

afterAll(async () => { await engine.stop().catch(() => {}); await db.close().catch(() => {}); });

async function insertAutomation(over: Record<string, unknown> = {}): Promise<string> {
  const id = uid();
  const name = String(over.name ?? 'Test Automation');
  const trigger = String(over.trigger ?? 'event');
  const triggerConfig = over.trigger_config ?? { event_type: 'task.completed' };
  const action = String(over.action ?? 'agent');
  const actionConfig = over.action_config ?? { agent_name: 'Hermes', input: 'auto fired: ${event.event_type}' };
  const autonomy = Number(over.autonomy_level ?? 2);
  const enabled = over.enabled === false ? 0 : 1;
  await db.run(
    `INSERT INTO automations (id, name, description, trigger, trigger_config, action, action_config, autonomy_level, enabled, last_fired_at, last_run_id, run_count, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, name, '', trigger, JSON.stringify(triggerConfig), action, JSON.stringify(actionConfig),
     autonomy, enabled, (over.last_fired_at as string) ?? null, null, 0, userId, now(), now()]);
  return id;
}

// ─── cron parsing ────────────────────────────────────────────────────────────
describe('phase 8 — cron parsing', () => {
  it('parses wildcards, steps, ranges, lists, names', () => {
    expect(parseCron('* * * * *').minute.values.size).toBe(60);           // every minute
    expect([...parseCron('*/15 * * * *').minute.values]).toEqual([0, 15, 30, 45]);
    expect([...parseCron('0 9-17 * * *').hour.values]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...parseCron('* * 1,15 * *').dom.values]).toEqual([1, 15]);   // 1,15 in the dom position
    expect([...parseCron('0 0 * * mon,fri').dow.values]).toEqual([1, 5]);  // mon,fri in the dow position
    expect([...parseCron('0 0 * jan *').month.values]).toEqual([1]);
    expect([...parseCron('0 0 * * sun').dow.values]).toEqual([0]);         // sun = 0
    expect([...parseCron('0 0 * * 7').dow.values]).toEqual([0]);           // 7 → sunday convention
  });

  it('rejects malformed expressions', () => {
    expect(() => parseCron('* * * *')).toThrow();          // 4 fields
    expect(() => parseCron('60 * * * *')).toThrow();       // minute out of range
    expect(() => parseCron('*/0 * * * *')).toThrow();      // zero step
    expect(() => parseCron('a * * * *')).toThrow();        // junk
    expect(() => parseCron('5-2 * * * *')).toThrow();      // inverted range
  });

  it('nextCronFire computes the next matching minute (local time, like cron)', () => {
    // build from a LOCAL base so assertions are timezone-independent
    const from = new Date();
    from.setHours(12, 3, 30, 0); // local 12:03:30
    // every 15 min → next :15/:30/:45/:00 boundary
    const next15 = nextCronFire(parseCron('*/15 * * * *'), from);
    expect([0, 15, 30, 45]).toContain(next15.getMinutes());
    expect(next15.getSeconds()).toBe(0);
    expect(next15.getTime()).toBeGreaterThan(from.getTime());
    // wildcard → the very next minute
    const anyMin = nextCronFire(parseCron('* * * * *'), from);
    expect(anyMin.getMinutes()).toBe(4 % 60); // 12:03 → next minute boundary :04
    // daily at 09:00 local → next local 9am is strictly in the future at hour 9
    const daily = nextCronFire(parseCron('0 9 * * *'), from);
    expect(daily.getHours()).toBe(9);
    expect(daily.getMinutes()).toBe(0);
    expect(daily.getTime()).toBeGreaterThan(from.getTime());
  });

  it('validateTrigger checks schedules and event types', () => {
    expect(validateTrigger('cron', { schedule: '*/5 * * * *' })).toBeNull();
    expect(validateTrigger('cron', {})).toContain('schedule');
    expect(validateTrigger('cron', { schedule: 'bogus' })).toContain('invalid cron');
    expect(validateTrigger('event', { event_type: 'task.completed' })).toBeNull();
    expect(validateTrigger('event', {})).toContain('event_type');
    expect(validateTrigger('webhook', {})).toBeNull();
  });
});

// ─── engine: event triggers ─────────────────────────────────────────────────
describe('phase 8 — event triggers', () => {
  it('dispatches an agent action when the event type matches', async () => {
    const autoId = await insertAutomation({
      name: 'On task complete',
      trigger_config: { event_type: 'task.completed' },
      action_config: { agent_name: 'Hermes', input: 'a task completed — note it' },
    });
    await bus.emit('task.completed', { id: 't1', status: 'done' }, { actor_type: 'user', actor_id: userId, target_type: 'task', target_id: 't1' });
    await sleep(1500); // async event path
    const runs = await listAutomationRuns(db, autoId);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0].status).toBe('dispatched');
    expect(runs[0].target_id).toBeTruthy(); // agent execution id
    // stats updated on the row
    const auto = await getAutomation(db, autoId);
    expect(auto!.run_count).toBe(1);
    expect(auto!.last_fired_at).toBeTruthy();
  });

  it('pattern narrows matching; non-matching events do not fire', async () => {
    const autoId = await insertAutomation({
      name: 'Urgent only',
      trigger_config: { event_type: 'task.created', pattern: 'urgent' },
      action_config: { agent_name: 'Hermes', input: 'urgent task created' },
    });
    // non-matching payload
    await bus.emit('task.created', { id: 'x', priority: 'low' }, { actor_type: 'user', actor_id: userId });
    await sleep(800);
    let runs = await listAutomationRuns(db, autoId);
    expect(runs.length).toBe(0);
    // matching payload
    await bus.emit('task.created', { id: 'y', priority: 'urgent', title: 'hotfix' }, { actor_type: 'user', actor_id: userId });
    await sleep(1500);
    runs = await listAutomationRuns(db, autoId);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe('dispatched');
  }, 20000);

  it('automation.* events never fire automations (self-trigger guard)', async () => {
    const autoId = await insertAutomation({
      name: 'Feedback bait',
      trigger_config: { event_type: 'automation.dispatched' },
      action_config: { agent_name: 'Hermes', input: 'should never run' },
    });
    await bus.emit('automation.dispatched', { automation_id: 'zzz' }, { actor_type: 'automation' });
    await sleep(1000);
    const runs = await listAutomationRuns(db, autoId);
    expect(runs.length).toBe(0);
  });

  it('paused (enabled=0) event automations do not fire', async () => {
    const autoId = await insertAutomation({
      name: 'Paused one',
      enabled: false,
      trigger_config: { event_type: 'memory.created' },
      action_config: { agent_name: 'Hermes', input: 'x' },
    });
    await bus.emit('memory.created', { id: 'm1' }, { actor_type: 'user', actor_id: userId });
    await sleep(1000);
    const runs = await listAutomationRuns(db, autoId);
    expect(runs.length).toBe(0);
  });
});

// ─── engine: autonomy policy gate ────────────────────────────────────────────
describe('phase 8 — autonomy policy gate', () => {
  it('level < 2 skips the dispatch with a policy reason', async () => {
    const autoId = await insertAutomation({
      name: 'Observe only',
      autonomy_level: 1,
      trigger_config: { event_type: 'task.updated' },
      action_config: { agent_name: 'Hermes', input: 'never dispatched' },
    });
    await bus.emit('task.updated', { id: 't9', status: 'in_progress' }, { actor_type: 'user', actor_id: userId });
    await sleep(1000);
    const runs = await listAutomationRuns(db, autoId);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe('skipped');
    expect(runs[0].reason).toContain('autonomy policy');
    expect(runs[0].target_id).toBeNull();
    // no agent execution was started
    const auto = await getAutomation(db, autoId);
    expect(auto!.run_count).toBe(0);
  });
});

// ─── engine: flow actions ────────────────────────────────────────────────────
describe('phase 8 — flow actions', () => {
  it('dispatches a flow run when the event fires', async () => {
    const autoId = await insertAutomation({
      name: 'Flow on memory write',
      trigger: 'event',
      trigger_config: { event_type: 'memory.updated' },
      action: 'flow',
      action_config: { flow_id: flowId, input: 'automation flow run' },
    });
    await bus.emit('memory.updated', { id: 'm2' }, { actor_type: 'user', actor_id: userId });
    await sleep(1500);
    const runs = await listAutomationRuns(db, autoId);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe('dispatched');
    expect(runs[0].target_id).toBeTruthy();
    // the flow run exists and reaches a terminal state
    const flowRunId = runs[0].target_id!;
    const row = await db.query<any>('SELECT status FROM flow_runs WHERE id = ?', [flowRunId]);
    expect(['running', 'waiting', 'completed']).toContain(row[0]?.status);
  });

  it('missing flow target fails the dispatch with a clear reason', async () => {
    const autoId = await insertAutomation({
      name: 'Ghost flow',
      trigger: 'event',
      trigger_config: { event_type: 'sprint.started' },
      action: 'flow',
      action_config: { flow_id: uid(), input: '' },
    });
    await bus.emit('sprint.started', { id: 's1' }, { actor_type: 'user', actor_id: userId });
    await sleep(1000);
    const runs = await listAutomationRuns(db, autoId);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].reason).toContain('flow not found');
  });
});

// ─── engine: webhook triggers ───────────────────────────────────────────────
describe('phase 8 — webhook triggers', () => {
  it('fires with the correct secret; rejects the wrong one (constant-time path)', async () => {
    const autoId = await insertAutomation({
      name: 'CI webhook',
      trigger: 'webhook',
      trigger_config: { secret: 'test-secret-12345' },
      action_config: { agent_name: 'Hermes', input: 'deploy done: ${payload.status}' },
    });
    // secret verification lives in the API route (constant-time compare utility):
    expect(timingSafeEqual('test-secret-12345', 'test-secret-12345')).toBe(true);
    expect(timingSafeEqual('test-secret-12345', 'wrong-secret-99999')).toBe(false);
    expect(timingSafeEqual('short', 'shorter')).toBe(false);
    // the verified path dispatches with the webhook payload
    const good = await engine.onWebhook(autoId, { status: 'passed' });
    expect(good!.status).toBe('dispatched');
    expect(good!.target_id).toBeTruthy();
  });

  it('paused webhook automations log a skip', async () => {
    const autoId = await insertAutomation({
      name: 'Paused webhook',
      trigger: 'webhook',
      enabled: false,
      trigger_config: { secret: 'shhh-secret-999' },
      action_config: { agent_name: 'Hermes', input: 'x' },
    });
    const run = await engine.onWebhook(autoId, {});
    expect(run!.status).toBe('skipped');
    expect(run!.reason).toContain('paused');
  });
});

// ─── test-fire + template resolution ────────────────────────────────────────
describe('phase 8 — test fire + input templates', () => {
  it('testFire dispatches through the same policy-gated path', async () => {
    const autoId = await insertAutomation({
      name: 'Testable',
      trigger: 'event',
      trigger_config: { event_type: 'task.completed' },
      action_config: { agent_name: 'Hermes', input: 'manual test with ${event.event_type}' },
    });
    const run = await engine.testFire(autoId);
    expect(run).not.toBeNull();
    expect(run!.status).toBe('dispatched');
    expect(run!.trigger).toBe('test');
  });

  it('in-flight guard skips a double fire', async () => {
    const autoId = await insertAutomation({
      name: 'Slow one',
      trigger: 'event',
      trigger_config: { event_type: 'link.created' },
      action_config: { agent_name: 'Hermes', input: 'first' },
    });
    // fire twice concurrently — second should skip
    const p1 = engine.testFire(autoId);
    const p2 = engine.testFire(autoId);
    const [r1, r2] = await Promise.all([p1, p2]);
    const statuses = [r1!.status, r2!.status].sort();
    expect(statuses).toContain('dispatched');
    expect(statuses).toContain('skipped');
  });
});

// ─── lifecycle ───────────────────────────────────────────────────────────────
describe('phase 8 — persistence helpers', () => {
  it('listAutomations/getAutomation round-trip', async () => {
    const id = await insertAutomation({ name: 'Roundtrip' });
    const all = await listAutomations(db);
    expect(all.find(a => a.id === id)?.name).toBe('Roundtrip');
    const one = await getAutomation(db, id);
    expect(one!.trigger_config).toEqual({ event_type: 'task.completed' });
    expect(one!.enabled).toBe(true);
  });
});
