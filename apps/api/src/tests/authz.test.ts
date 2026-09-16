/**
 * Authorization tests (§39) — resource ownership.
 *
 * The OS is multi-user and several tables carry a `user_id` OWNER column
 * (executions, working_memory, flow_runs, memories, notifications). This suite
 * proves that one authenticated user cannot read or control another user's
 * records, and that the answer is always 404 (never 403) so a response never
 * confirms that someone else's record exists.
 *
 * Runs the REAL Fastify app with two REAL login sessions — no mocks. Every
 * assertion below is a regression guard: before this suite existed, every one
 * of these routes leaked.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { SqliteDataPort } from '../infra/sqlite.adapter';
import { runMigrations } from '../infra/migrations';
import { InProcessBroker } from '../infra/broker';
import { EventBus } from '../kernel/bus';
import { ModelRouter } from '../gateway/router';
import { BuiltinProvider } from '../gateway/providers';
import { AgentRuntime } from '../modules/runtime';
import { ToolRegistry, createBuiltinTools, setRuntimeRef } from '../modules/tools';
import { FlowEngine } from '../modules/flows';
import * as store from '../modules/store';
import { ownerOf, isOwnedBy } from '../modules/authz';
import { hashPassword } from '../auth.util';
import { buildApi } from '../app';

let app: any;
let db: SqliteDataPort;
let alice: string;   // 'alice-cookie'
let bob: string;     // 'bob-cookie'

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

// alice-owned fixtures
let aliceExec: string;
let aliceApproval: string;
let aliceFlowRun: string;
let aliceFlow: string;

const get = (url: string, who: string) => app.inject({ method: 'GET', url, headers: { cookie: who } });
const post = (url: string, who: string, payload: unknown = {}) =>
  app.inject({ method: 'POST', url, headers: { cookie: who }, payload });

async function login(username: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  expect(res.statusCode).toBe(200);
  const setCookie = res.headers['set-cookie'] as string | string[];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return raw.split(';')[0];
}

beforeAll(async () => {
  const file = path.resolve(__dirname, '..', '..', '..', 'data', `test-authz-${Date.now()}.db`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new SqliteDataPort(file);
  await runMigrations(db);

  const mkUser = async (id: string, username: string) => {
    await db.run(
      'INSERT INTO users (id, username, password_hash, display_name, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      [id, username, hashPassword('pw'), username, now(), now()]);
    return id;
  };
  await mkUser('alice', 'alice');
  await mkUser('bob', 'bob');

  await store.upsertAgent(db, {
    id: 'agent1', name: 'Hermes', description: 'supervisor',
    system_instructions: '', model_policy: {}, skills: [], tools: ['sys.info'],
    memory_policy: { read: false, write: false, k: 3 }, permissions: { scopes: [] },
    autonomy_level: 2, status: 'idle', created_at: now(), updated_at: now(),
  } as any);

  const broker = new InProcessBroker();
  const bus = new EventBus(db, broker);
  const router = new ModelRouter(db, async () => {});
  router.register(new BuiltinProvider());
  await router.bootstrap();
  const tools = new ToolRegistry();
  for (const t of createBuiltinTools(db)) tools.register(t);
  const runtime = new AgentRuntime(db, broker, bus, router, tools);
  setRuntimeRef(runtime);
  const flowEngine = new FlowEngine({ db, bus, runtime, tools });

  app = buildApi({ db, broker, bus, router, runtime, tools, flowEngine } as any);
  await app.ready();

  alice = await login('alice', 'pw');
  bob = await login('bob', 'pw');

  // ── alice-owned fixtures ───────────────────────────────────────────────────
  aliceExec = uid();
  await store.insertExecution(db, {
    id: aliceExec, agent_id: 'agent1', user_id: 'alice',
    input: 'alice private task', status: 'running', observations: [], trace: [],
    started_at: now(),
  });
  // a working-memory window so a 404 proves the AUTHZ check, not mere absence
  await db.run(
    `INSERT INTO working_memory (id, execution_id, user_id, agent_id, pinned_memory_ids, facts, token_estimate, created_at, updated_at, closed_at)
     VALUES (?,?,?,?,?,?,?,?,?,NULL)`,
    [uid(), aliceExec, 'alice', 'agent1', JSON.stringify([]), JSON.stringify([]), 0, now(), now()]);
  // a pending approval hanging off alice's execution
  const appr = await store.createApproval(db, {
    execution_id: aliceExec, agent_id: 'agent1', tool: 'shell.run',
    args: { cmd: 'rm -rf /' }, reason: 'high-risk',
  });
  aliceApproval = appr.id;
  // a generation attributed to alice's execution
  await db.run(
    `INSERT INTO generations (id, agent_id, execution_id, model_id, provider_id, kind, input, output, context,
      input_tokens, output_tokens, latency_ms, cost, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [uid(), 'agent1', aliceExec, 'builtin-small', 'builtin', 'reasoning',
     JSON.stringify({}), 'alice secret output', JSON.stringify({}), 1, 1, 1, 0, 'completed', now()]);
  // a flow + a run owned by alice
  aliceFlow = uid();
  await db.run(
    'INSERT INTO flows (id, name, description, nodes, edges, version, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [aliceFlow, 'Alice flow', '', JSON.stringify([]), JSON.stringify([]), '0.1.0', 'alice', now(), now()]);
  aliceFlowRun = uid();
  await db.run(
    `INSERT INTO flow_runs (id, flow_id, flow_version, user_id, status, input, context, current_node,
      completed_nodes, trace, result, error, started_at, updated_at, completed_at)
     VALUES (?,?,?,?,?,?,?,NULL,?,?,NULL,NULL,?,?,NULL)`,
    [aliceFlowRun, aliceFlow, '0.1.0', 'alice', 'waiting', JSON.stringify({}), JSON.stringify({}),
     JSON.stringify([]), JSON.stringify([]), now(), now()]);
});

afterAll(async () => { try { await app.close(); } catch { /* */ } });

// ─── pure ownership policy ───────────────────────────────────────────────────

describe('ownership policy', () => {
  it('reads user_id first, then created_by, and treats empty strings as ownerless', () => {
    expect(ownerOf({ user_id: 'u1' })).toBe('u1');
    expect(ownerOf({ user_id: null, created_by: 'u2' })).toBe('u2');
    expect(ownerOf({ user_id: '', created_by: 'u2' })).toBe('u2');
    // rows written from a context with no user stay shared, not unreachable
    expect(ownerOf({ user_id: '' })).toBeNull();
    expect(ownerOf({})).toBeNull();
    expect(ownerOf(null)).toBeNull();
  });

  it('ownerless records are shared; foreign records are not; missing records are not', () => {
    expect(isOwnedBy({ user_id: 'alice' }, 'alice')).toBe(true);
    expect(isOwnedBy({ user_id: 'alice' }, 'bob')).toBe(false);
    expect(isOwnedBy({ user_id: '' }, 'bob')).toBe(true);
    expect(isOwnedBy(null, 'bob')).toBe(false);
  });
});

// ─── executions ──────────────────────────────────────────────────────────────

describe('executions are owner-scoped', () => {
  it('the list shows only the caller\'s own executions', async () => {
    const mine = (await get('/api/executions', alice)).json();
    expect(mine.map((e: any) => e.id)).toContain(aliceExec);
    const theirs = (await get('/api/executions', bob)).json();
    expect(theirs.map((e: any) => e.id)).not.toContain(aliceExec);
  });

  it('reading another user\'s execution is 404, not 403 (existence is not confirmed)', async () => {
    const denied = await get(`/api/executions/${aliceExec}`, bob);
    expect(denied.statusCode).toBe(404);
    expect(denied.json()).toEqual({ error: 'not found' });
    expect((await get(`/api/executions/${aliceExec}`, alice)).statusCode).toBe(200);
  });

  it('the child-execution graph is owner-scoped', async () => {
    expect((await get(`/api/executions/${aliceExec}/children`, bob)).statusCode).toBe(404);
    expect((await get(`/api/executions/${aliceExec}/children`, alice)).statusCode).toBe(200);
  });

  it('another user cannot stop a running execution', async () => {
    expect((await post(`/api/executions/${aliceExec}/stop`, bob)).statusCode).toBe(404);
    const row = await store.getExecution(db, aliceExec);
    expect(row?.status).toBe('running');   // untouched — the denial was real
  });

  it('another user cannot pause a running execution', async () => {
    expect((await post(`/api/executions/${aliceExec}/pause`, bob)).statusCode).toBe(404);
  });

  it('the working-memory window is owner-scoped (window exists, access still denied)', async () => {
    const denied = await get(`/api/executions/${aliceExec}/working-memory`, bob);
    expect(denied.statusCode).toBe(404);
    expect((await get(`/api/executions/${aliceExec}/working-memory`, alice)).statusCode).toBe(200);
  });

  it('another user cannot inject facts into a working-memory window', async () => {
    const denied = await post(`/api/executions/${aliceExec}/working-memory/facts`, bob, { text: 'injected' });
    expect(denied.statusCode).toBe(404);
    const wm = await db.query<any>('SELECT facts FROM working_memory WHERE execution_id = ?', [aliceExec]);
    expect(JSON.parse(wm[0].facts)).toHaveLength(0);
  });
});

// ─── approvals ───────────────────────────────────────────────────────────────

describe('approvals inherit their execution\'s owner', () => {
  it('the pending queue shows only the caller\'s own approvals', async () => {
    const mine = (await get('/api/approvals', alice)).json();
    expect(mine.map((a: any) => a.id)).toContain(aliceApproval);
    const theirs = (await get('/api/approvals', bob)).json();
    expect(theirs.map((a: any) => a.id)).not.toContain(aliceApproval);
  });

  it('another user cannot approve a high-risk action on someone else\'s execution', async () => {
    const denied = await post(`/api/approvals/${aliceApproval}/decision`, bob, { decision: 'approve' });
    expect(denied.statusCode).toBe(404);
    // the approval is still pending — the denial did not partially apply
    const rows = await db.query<any>('SELECT status, decided_by FROM approvals WHERE id = ?', [aliceApproval]);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].decided_by).toBeNull();
  });

  it('the owner can still decide it', async () => {
    const ok = await post(`/api/approvals/${aliceApproval}/decision`, alice, { decision: 'approve' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().ok).toBe(true);
  });
});

// ─── generations ─────────────────────────────────────────────────────────────

describe('generations inherit their execution\'s owner', () => {
  it('only generations from the caller\'s executions are listed', async () => {
    const mine = (await get('/api/generations', alice)).json();
    expect(mine.some((g: any) => g.output === 'alice secret output')).toBe(true);
    const theirs = (await get('/api/generations', bob)).json();
    expect(theirs.some((g: any) => g.output === 'alice secret output')).toBe(false);
  });

  it('passing another user\'s execution_id filters to nothing rather than leaking', async () => {
    const theirs = (await get(`/api/generations?execution_id=${aliceExec}`, bob)).json();
    expect(theirs).toHaveLength(0);
  });
});

// ─── flow runs ───────────────────────────────────────────────────────────────

describe('flow runs are owner-scoped', () => {
  it('reading another user\'s flow run is 404', async () => {
    expect((await get(`/api/flow-runs/${aliceFlowRun}`, bob)).statusCode).toBe(404);
    expect((await get(`/api/flow-runs/${aliceFlowRun}`, alice)).statusCode).toBe(200);
  });

  it('another user cannot stop or pause a running flow', async () => {
    expect((await post(`/api/flow-runs/${aliceFlowRun}/stop`, bob)).statusCode).toBe(404);
    expect((await post(`/api/flow-runs/${aliceFlowRun}/pause`, bob)).statusCode).toBe(404);
    const rows = await db.query<any>('SELECT status FROM flow_runs WHERE id = ?', [aliceFlowRun]);
    expect(rows[0].status).toBe('waiting');   // untouched
  });

  it('a flow\'s run list is owner-scoped', async () => {
    const mine = (await get(`/api/flows/${aliceFlow}/runs`, alice)).json();
    expect(mine.map((r: any) => r.id)).toContain(aliceFlowRun);
    const theirs = (await get(`/api/flows/${aliceFlow}/runs`, bob)).json();
    expect(theirs.map((r: any) => r.id)).not.toContain(aliceFlowRun);
  });
});

// ─── aggregates ──────────────────────────────────────────────────────────────

describe('dashboard counts are per-user', () => {
  it('a second user\'s counts do not include the first user\'s work', async () => {
    const a = (await get('/api/dashboard', alice)).json();
    const b = (await get('/api/dashboard', bob)).json();
    expect(a.counts.executions).toBeGreaterThan(b.counts.executions);
    expect(a.counts.generations).toBeGreaterThan(b.counts.generations);
  });

  it('universal search does not surface another user\'s generation output', async () => {
    const hits = (await get('/api/search?q=secret', bob)).json();
    expect(hits.some((h: any) => h.type === 'generation')).toBe(false);
  });
});
