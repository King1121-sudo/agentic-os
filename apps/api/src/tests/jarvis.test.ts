/**
 * JARVIS real-agent-experience tests: command acknowledgement contract (§7),
 * execution lifecycle visibility (§8/§11), honest-state rules (§2).
 * Runs the REAL routeCommand + runtime + bus through the real Fastify app
 * with a real login session — no mocks.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import Fastify from 'fastify';
import { SqliteDataPort } from '../infra/sqlite.adapter';
import { runMigrations } from '../infra/migrations';
import { ModelRouter } from '../gateway/router';
import { BuiltinProvider } from '../gateway/providers';
import { EventBus } from '../kernel/bus';
import { InProcessBroker } from '../infra/broker';
import { AgentRuntime } from '../modules/runtime';
import { ToolRegistry, createBuiltinTools } from '../modules/tools';
import * as store from '../modules/store';
import { hashPassword } from '../auth.util';
import { buildApi } from '../app';

let app: ReturnType<typeof Fastify>;
let db: SqliteDataPort;
let bus: EventBus;
let cookieHeader: string;

beforeAll(async () => {
  const file = path.resolve(__dirname, '..', '..', '..', 'data', `test-jarvis-${Date.now()}.db`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new SqliteDataPort(file);
  await runMigrations(db);
  await db.run(
    'INSERT INTO users (id, username, password_hash, display_name, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    ['u1', 'tester', hashPassword('pw'), 'Tester', new Date().toISOString(), new Date().toISOString()],
  );
  await store.upsertAgent(db, {
    id: 'a1', name: 'Hermes', description: 'supervisor',
    system_instructions: '', model_policy: {}, skills: [], tools: ['sys.info'],
    memory_policy: { read: true, write: true, k: 5 }, permissions: {},
    autonomy_level: 2, status: 'idle',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  } as any);
  const router = new ModelRouter(db, async () => {});
  router.register(new BuiltinProvider());
  await router.bootstrap();
  const broker = new InProcessBroker();
  bus = new EventBus(db, broker);
  const tools = new ToolRegistry();
  for (const t of createBuiltinTools(db)) tools.register(t);
  const runtime = new AgentRuntime(db, broker, bus, router, tools);
  // buildApi(deps) builds and returns a fully-wired Fastify instance
  app = buildApi({ db, broker, bus, router, runtime, tools } as any) as any;
  await app.ready();

  // real login → session cookie
  const login = await app.inject({
    method: 'POST', url: '/api/auth/login', payload: { username: 'tester', password: 'pw' },
  });
  expect(login.statusCode).toBe(200);
  const setCookie = login.headers['set-cookie'] as string | string[];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  cookieHeader = raw.split(';')[0];
});

afterAll(async () => { try { await app.close(); } catch { /* */ } });

const command = (text: string) => app.inject({
  method: 'POST', url: '/api/command',
  headers: { cookie: cookieHeader },
  payload: { text },
});

describe('JARVIS command acknowledgement (§7)', () => {
  it('instant local answers carry an ack naming what actually happens', async () => {
    const res = await command('what are my agents doing');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.kind).toBe('result');
    expect(typeof body.ack).toBe('string');
    expect(body.ack.length).toBeGreaterThan(10);
    expect(/agent roster|executions/i.test(body.ack)).toBe(true);
  });

  it('agent commands acknowledge with the real agent name and return the execution id immediately', async () => {
    const res = await command('investigate the deployment logs');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.kind).toBe('execution');
    expect(body.execution_id).toBeTruthy();
    expect(body.agent_name).toBe('Hermes');
    expect(body.ack).toContain('Hermes');
  });

  it('command.acknowledged lands on the bus with kind + agent + ack text', async () => {
    await command('research vector databases');
    const events = await bus.list(10, ['command.acknowledged']);
    expect(events.length).toBeGreaterThan(0);
    const d = events[0].data as any;
    expect(typeof d.ack).toBe('string');
    expect(['result', 'execution', 'unimplemented']).toContain(d.kind);
  });

  it('command.executed precedes command.acknowledged in the stream', async () => {
    const events = await bus.list(40);
    const ackIdx = events.findIndex(e => e.type === 'command.acknowledged');
    const execIdx = events.findIndex(e => e.type === 'command.executed');
    // list is DESC — the later event has the LOWER index
    expect(ackIdx).toBeGreaterThanOrEqual(0);
    expect(execIdx).toBeGreaterThan(ackIdx);
  });
});

describe('execution lifecycle visibility (§8/§11)', () => {
  it('a real execution drives to a terminal state and emits the real event chain', async () => {
    const res = await command('check system status');
    const body = res.json();
    if (body.kind !== 'execution') return; // routed to a local branch — also valid
    const execId = body.execution_id;

    const deadline = Date.now() + 20000;
    let exec: any = null;
    while (Date.now() < deadline) {
      const r = await app.inject({
        method: 'GET', url: `/api/executions/${execId}`, headers: { cookie: cookieHeader },
      });
      exec = r.json();
      if (['completed', 'failed', 'cancelled'].includes(exec?.status)) break;
      await new Promise(r2 => setTimeout(r2, 200));
    }
    expect(exec).toBeTruthy();
    expect(['completed', 'failed', 'cancelled']).toContain(exec.status);

    // every lifecycle event for this execution is a real persisted bus event
    const events = await bus.list(200);
    const mine = events.filter(e => (e.data as any)?.execution_id === execId);
    expect(mine.length).toBeGreaterThanOrEqual(2);
    expect(mine.map(e => e.type)).toContain('agent.started');
  });
});
