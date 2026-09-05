/** Phase 3 tests: delegation graph, depth guard, agent messaging, retry, resume. */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { SqliteDataPort } from '../infra/sqlite.adapter';
import { runMigrations } from '../infra/migrations';
import { InProcessBroker } from '../infra/broker';
import { EventBus } from '../kernel/bus';
import { ModelRouter } from '../gateway/router';
import { BuiltinProvider, heuristicPlan } from '../gateway/providers';
import { ToolRegistry, createBuiltinTools, setRuntimeRef } from '../modules/tools';
import { AgentRuntime } from '../modules/runtime';
import * as store from '../modules/store';
import { config } from '../config';

let db: SqliteDataPort;
let runtime: AgentRuntime;
let bus: EventBus;

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

beforeAll(async () => {
  const file = path.resolve(__dirname, '..', '..', '..', 'data', `test-phase3-${Date.now()}.db`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new SqliteDataPort(file);
  await runMigrations(db);
  await db.run('INSERT INTO users (id, username, password_hash, display_name, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    ['u1', 'tester', 'x:y', 'T', now(), now()]);

  bus = new EventBus(db, new InProcessBroker());
  const router = new ModelRouter(db, async () => {});
  router.register(new BuiltinProvider());
  await router.bootstrap();

  const tools = new ToolRegistry();
  for (const t of createBuiltinTools(db)) tools.register(t);
  runtime = new AgentRuntime(db, new InProcessBroker(), bus, router, tools);
  setRuntimeRef(runtime);

  // test agents
  await store.upsertAgent(db, {
    id: uid(), name: 'Hermes', description: 'supervisor', system_instructions: 'supervise',
    model_policy: { capability: 'reasoning', preference: [] },
    skills: [], tools: ['memory.search', 'memory.write', 'agent.delegate', 'agent.message', 'sys.info', 'http.fetch'],
    memory_policy: { read: true, write: true, k: 3, types: [] },
    permissions: { tools: [], scopes: ['memory:read', 'memory:write', 'agents:delegate', 'agents:message', 'system:read', 'net:fetch'] },
    autonomy_level: 3, status: 'idle', created_at: now(), updated_at: now(),
  } as any);
  await store.upsertAgent(db, {
    id: uid(), name: 'Monitor', description: 'watcher', system_instructions: 'watch',
    model_policy: { capability: 'reasoning', preference: [] },
    skills: [], tools: ['sys.info'],
    memory_policy: { read: false, write: false, k: 3, types: [] },
    permissions: { tools: [], scopes: ['system:read'] },
    autonomy_level: 3, status: 'idle', created_at: now(), updated_at: now(),
  } as any);
}, 30000);

describe('phase 3 — delegation', () => {
  it('extracts delegate args from natural language', () => {
    const plan = heuristicPlan('delegate to Monitor: check system health', null);
    const step = plan.steps.find(s => (s as any).tool === 'agent.delegate') as any;
    expect(step).toBeDefined();
    expect(step.args.agent_name).toBe('Monitor');
    expect(step.args.task).toMatch(/check system health/i);
  });

  it('agent.delegate creates a CHILD execution with graph link; parent waits for completion', async () => {
    const hermes = (await store.getAgentByName(db, 'Hermes'))!;
    // run a delegation command through Hermes
    const exec = await runtime.run({
      agent: hermes, input: 'delegate to Monitor: check system health and report counts',
      user_id: 'u1',
    });
    // wait for terminal state (delegation polls every 300ms; builtin child is fast)
    const deadline = Date.now() + 30000;
    let ex = await store.getExecution(db, exec.id);
    while (ex && !['completed', 'failed', 'cancelled'].includes(ex.status) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 200));
      ex = await store.getExecution(db, ex.id);
    }
    expect(ex!.status).toBe('completed');

    // child execution exists with parent link
    const children = await db.query<any>('SELECT * FROM executions WHERE parent_execution_id = ?', [exec.id]);
    expect(children.length).toBe(1);
    expect(children[0].agent_id).toBe((await store.getAgentByName(db, 'Monitor'))!.id);

    // delegated_to link in the graph
    const links = await db.query<any>("SELECT * FROM links WHERE from_type = 'execution' AND from_id = ? AND relation = 'delegated_to'", [exec.id]);
    expect(links.length).toBe(1);

    // the delegation observation contains the child result
    const parsed = store.parseExecution(ex!);
    const delObs = parsed.observations.find(o => JSON.stringify(o.data).includes('child_execution_id'));
    expect(delObs).toBeDefined();
    expect((delObs!.data as any).status).toBe('completed');
  }, 45000);

  it('depth guard blocks delegation chains beyond the limit', async () => {
    const hermes = (await store.getAgentByName(db, 'Hermes'))!;
    // Monitor has no delegate tool; craft a direct delegate from a depth-2 context:
    // run Hermes delegating to Monitor, where Monitor's task asks it to delegate again.
    // Monitor lacks the tool → denied observation (gate), not a crash. Verify the guard
    // at the tool level by attempting depth directly:
    const tools = createBuiltinTools(db);
    const delegate = tools.find(t => t.name === 'agent.delegate')!;
    const fakeCtx = {
      execution_id: null, agent: hermes, user_id: 'u1', depth: config.maxDelegationDepth,
      emit: () => {}, observe: () => {},
    } as any;
    await expect(delegate.execute({ agent_name: 'Monitor', task: 'anything' }, fakeCtx))
      .rejects.toThrow(/depth limit/i);
  }, 30000);
});

describe('phase 3 — messaging', () => {
  it('agent.message stores a message; next execution of the target consumes it', async () => {
    const hermes = (await store.getAgentByName(db, 'Hermes'))!;
    const monitor = (await store.getAgentByName(db, 'Monitor'))!;
    await store.createAgentMessage(db, { from_agent_id: hermes.id, to_agent_id: monitor.id, content: 'Check the deployment pipeline after lunch.' });

    const pendingBefore = await store.pendingMessagesFor(db, monitor.id, false);
    expect(pendingBefore.length).toBe(1);

    // run monitor — mailbox should be consumed (marked read) and injected into planning context
    const exec = await runtime.run({ agent: monitor, input: 'what is the system status', user_id: 'u1' });
    const deadline = Date.now() + 20000;
    let ex = await store.getExecution(db, exec.id);
    while (ex && !['completed', 'failed', 'cancelled'].includes(ex.status) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 200));
      ex = await store.getExecution(db, ex.id);
    }
    expect(ex!.status).toBe('completed');
    const parsed = store.parseExecution(ex!);
    expect(parsed.trace.some(t => /agent message/i.test(t.message))).toBe(true);

    // mailbox now empty for monitor
    const pendingAfter = await store.pendingMessagesFor(db, monitor.id, false);
    expect(pendingAfter.length).toBe(0);
  }, 30000);
});

describe('phase 3 — retry/backoff', () => {
  it('a failing tool step retries per policy then fails the execution with trace evidence', async () => {
    const hermes = (await store.getAgentByName(db, 'Hermes'))!;
    // http.fetch with an unreachable URL → tool error → retries → execution failed
    const exec = await runtime.run({
      agent: hermes, input: 'fetch http://127.0.0.1:1/unreachable then summarize',
      user_id: 'u1',
    });
    const deadline = Date.now() + 30000;
    let ex = await store.getExecution(db, exec.id);
    while (ex && !['completed', 'failed', 'cancelled'].includes(ex.status) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 200));
      ex = await store.getExecution(db, ex.id);
    }
    // with retries configured (default 1), there should be a retry trace entry
    const parsed = store.parseExecution(ex!);
    const retryTrace = parsed.trace.find(t => /retrying in/i.test(t.message));
    if (config.stepRetries > 0) {
      expect(retryTrace).toBeDefined();
      expect(ex!.status).toBe('failed');
    }
    // at minimum the step failed cleanly with an error
    expect(ex!.error ?? parsed.trace.some(t => t.kind === 'error')).toBeTruthy();
  }, 45000);
});

describe('phase 3 — checkpoint resume', () => {
  it('recoverInterrupted marks orphaned running executions as interrupted', async () => {
    // plant a fake orphaned execution directly in the DB (simulating a crash)
    const hermes = (await store.getAgentByName(db, 'Hermes'))!;
    const id = uid();
    await store.insertExecution(db, {
      id, agent_id: hermes.id, user_id: 'u1', input: 'orphaned work',
      status: 'running', observations: [], trace: [], started_at: now(),
    });
    await db.run("UPDATE executions SET current_step = 1 WHERE id = ?", [id]);

    const n = await runtime.recoverInterrupted();
    expect(n).toBeGreaterThanOrEqual(1);
    const ex = await store.getExecution(db, id);
    expect(ex!.status).toBe('interrupted');
  });

  it('resumeExecution continues an interrupted execution from its checkpoint', async () => {
    const hermes = (await store.getAgentByName(db, 'Hermes'))!;
    const id = uid();
    // execution with a persisted plan and a checkpoint at step 2 of 2
    const plan = { rationale: 'resume test', steps: [
      { kind: 'model', capability: 'reasoning', prompt: 'step one', input_from: 'all' },
      { kind: 'model', capability: 'reasoning', prompt: 'step two', input_from: 'all' },
    ] };
    await store.insertExecution(db, {
      id, agent_id: hermes.id, user_id: 'u1', input: 'resumable work',
      status: 'interrupted', observations: [], trace: [], started_at: now(),
    });
    await store.updateExecution(db, id, { plan: JSON.stringify(plan), current_step: 2 });

    const resumed = await runtime.resumeExecution(id);
    expect(resumed).not.toBeNull();
    // wait for terminal state
    const deadline = Date.now() + 20000;
    let ex = await store.getExecution(db, id);
    while (ex && !['completed', 'failed', 'cancelled'].includes(ex.status) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 200));
      ex = await store.getExecution(db, id);
    }
    expect(['completed', 'failed']).toContain(ex!.status);
    const parsed = store.parseExecution(ex!);
    expect(parsed.trace.some(t => /resumed from checkpoint/i.test(t.message))).toBe(true);
  }, 30000);
});
