/**
 * Test suite — covers the kernel pieces that must be correct:
 * memory engine scoring/decay/consolidation, model-gateway routing & fallback,
 * planner arg extraction, security gate, Sqlite adapter + migrations.
 * Run: npm test (repo root) or npx vitest run (apps/api).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { SqliteDataPort } from '../infra/sqlite.adapter';
import { runMigrations } from '../infra/migrations';
import { createMemory, searchMemory, decayMemories, consolidateMemories, embed, cosine } from '../modules/memory';
import * as store from '../modules/store';
import { heuristicPlan } from '../gateway/providers';
import { evaluateGate } from '../kernel/types';
import { hashPassword, verifyPassword } from '../auth.util';

let db: SqliteDataPort;

beforeAll(async () => {
  const file = path.resolve(__dirname, '..', '..', '..', 'data', `test-${Date.now()}.db`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new SqliteDataPort(file);
  await runMigrations(db);
  await db.run(
    'INSERT INTO users (id, username, password_hash, display_name, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    ['u1', 'tester', hashPassword('pw'), 'Tester', new Date().toISOString(), new Date().toISOString()],
  );
});

describe('memory engine', () => {
  it('creates and retrieves by keyword with scoring', async () => {
    await createMemory(db, { user_id: 'u1', type: 'semantic', content: 'The production database is hosted on Neon Postgres.', importance: 8 });
    await createMemory(db, { user_id: 'u1', type: 'preference', content: 'User prefers dark themes and terse summaries.', importance: 7 });
    await createMemory(db, { user_id: 'u1', type: 'episodic', content: 'Went grocery shopping on Tuesday.', importance: 3 });
    const hits = await searchMemory(db, { user_id: 'u1', query: 'production database postgres', k: 3 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].content).toContain('Neon Postgres');
    expect(hits[0].score).toBeGreaterThan(0.15);
  });

  it('dedupes identical memories by reinforcing', async () => {
    const first = await createMemory(db, { user_id: 'u1', type: 'semantic', content: 'AWS region is us-east-2 for all workloads.', importance: 5 });
    const second = await createMemory(db, { user_id: 'u1', type: 'semantic', content: 'AWS region is us-east-2 for all workloads.', importance: 5 });
    expect(second.deduped).not.toBeNull();
    expect(second.record.id).toBe(first.record.id);
    expect(second.record.importance).toBeGreaterThan(5);
  });

  it('embedding is deterministic and cosine-safe', () => {
    const a = embed('alpha beta gamma');
    const b = embed('alpha beta gamma');
    const c = embed('completely different tokens here');
    expect(a).toEqual(b);
    expect(cosine(a, b)).toBeCloseTo(1, 5);
    expect(cosine(a, c)).toBeLessThan(0.5);
  });

  it('consolidates near-identical embeddings', async () => {
    const before = await db.query<any>('SELECT COUNT(*) AS n FROM memories WHERE user_id = ?', ['u1']);
    const { merged } = await consolidateMemories(db, 'u1');
    const after = await db.query<any>('SELECT COUNT(*) AS n FROM memories WHERE user_id = ?', ['u1']);
    expect(after[0].n).toBe(before[0].n - merged);
  });
});

describe('planner (builtin heuristic)', () => {
  it('extracts task args from natural language', () => {
    const plan = heuristicPlan('Create a task to fix the login bug in project Aurora, urgent', null);
    const taskStep = plan.steps.find(s => s.kind === 'tool' && s.tool === 'task.create');
    expect(taskStep).toBeDefined();
    expect((taskStep as any).args.title).toMatch(/login bug/i);
    expect((taskStep as any).args.priority).toBe('urgent');
    expect((taskStep as any).args.project_name).toMatch(/aurora/i);
  });

  it('extracts URLs for http.fetch', () => {
    const plan = heuristicPlan('Fetch https://example.com/data and summarize it', null);
    const step = plan.steps.find(s => s.tool === 'http.fetch') as any;
    expect(step.args.url).toBe('https://example.com/data');
  });

  it('falls back to pure reasoning when no tool matches', () => {
    const plan = heuristicPlan('Tell me about the meaning of life', null);
    expect(plan.steps.every(s => s.kind === 'model')).toBe(true);
  });

  it('always ends with a synthesis step', () => {
    const plan = heuristicPlan('remember that I like tea', null);
    expect(plan.steps[plan.steps.length - 1].kind).toBe('model');
  });
});

describe('security gate (autonomy × risk)', () => {
  const baseAgent = {
    id: 'a1', name: 'T', description: '', system_instructions: '',
    model_policy: {}, skills: [], tools: ['memory.search', 'file.write', 'shell.run'],
    memory_policy: { read: true, write: true, k: 5, types: [] },
    permissions: { tools: ['memory.search', 'file.write', 'shell.run'], scopes: ['memory:read', 'files:write', 'shell:exec'] },
    autonomy_level: 2, status: 'idle' as const, created_at: '', updated_at: '',
  };
  const lowRisk = { name: 'memory.search', description: '', risk: 'low' as const, scope: 'memory:read', schema: { query: { type: 'string' as const, required: true, description: '' } }, execute: async () => null };
  const highRisk = { name: 'shell.run', description: '', risk: 'high' as const, scope: 'shell:exec', schema: { command: { type: 'string' as const, required: true, description: '' } }, execute: async () => null };

  it('allows low-risk tool with args at L1', () => {
    const d = evaluateGate(baseAgent as any, lowRisk as any, { query: 'x' });
    expect(d.allowed).toBe(true);
    expect(d.needsApproval).toBe(false);
  });
  it('denies tool outside agent toolset', () => {
    const stranger = { ...baseAgent, tools: [] };
    const d = evaluateGate(stranger as any, lowRisk as any, { query: 'x' });
    expect(d.allowed).toBe(false);
  });
  it('denies missing required args', () => {
    const d = evaluateGate(baseAgent as any, lowRisk as any, {});
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('query');
  });
  it('high-risk tool always requires approval, even L4', () => {
    const l4 = { ...baseAgent, autonomy_level: 4, tools: [...baseAgent.tools] };
    const d = evaluateGate(l4 as any, highRisk as any, { command: 'ls' });
    expect(d.allowed).toBe(true);
    expect(d.needsApproval).toBe(true);
  });
  it('high-risk tool denied below L3', () => {
    const l1 = { ...baseAgent, autonomy_level: 1 };
    const d = evaluateGate(l1 as any, highRisk as any, { command: 'ls' });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('Autonomy');
  });
});

describe('model router fallback', () => {
  it('builtin provider answers planning requests without network', async () => {
    const { BuiltinProvider } = await import('../gateway/providers');
    const p = new BuiltinProvider();
    const resp = await p.generate({ capability: 'planning', prompt: 'create a task to test routing' }, 'planner');
    expect(resp.plan).toBeDefined();
    expect(resp.plan!.steps.length).toBeGreaterThan(0);
    expect(resp.provider_id).toBe('builtin');
  });
});

describe('project lookup hardening (post-audit fix)', () => {
  it('findProjectByName: exact match wins, substring fallback finds shorter existing name', async () => {
    await store.createProject(db, { name: 'Aurora', created_by: 'u1' });
    await store.createProject(db, { name: 'Agentic OS', created_by: 'u1' });
    // exact
    const exact = await store.findProjectByName(db, 'Aurora');
    expect(exact!.name).toBe('Aurora');
    // query longer than name ("aurora project" should match existing "Aurora")
    const longer = await store.findProjectByName(db, 'the Aurora project');
    expect(longer!.name).toBe('Aurora');
    // case/whitespace normalization
    const messy = await store.findProjectByName(db, '  AGENtic  os ');
    expect(messy!.name).toBe('Agentic OS');
    // longest existing name wins when multiple substring candidates
    await store.createProject(db, { name: 'Agentic OS v2 beta', created_by: 'u1' });
    const longest = await store.findProjectByName(db, 'the Agentic OS v2 beta roadmap');
    expect(longest!.name).toBe('Agentic OS v2 beta');
  });
});

describe('sqlite adapter + migrations', () => {
  it('persists and queries rows', async () => {
    await db.run('INSERT INTO tasks (id, project_id, sprint_id, title, description, status, priority, deadline, assignee_agent_id, labels, created_by, created_at, updated_at, completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ['t1', null, null, 'Adapter test', '', 'todo', 'low', null, null, '[]', 'u1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', null]);
    const rows = await db.query<any>('SELECT title FROM tasks WHERE id = ?', ['t1']);
    expect(rows[0].title).toBe('Adapter test');
  });
  it('migrations are idempotent', async () => {
    const applied = await runMigrations(db);
    expect(applied.length).toBe(0);
  });
});

describe('auth hashing', () => {
  it('hash + verify roundtrip', () => {
    const h = hashPassword('secret');
    expect(h).not.toContain('secret');
    expect(verifyPassword('secret', h)).toBe(true);
    expect(verifyPassword('wrong', h)).toBe(false);
  });
});
