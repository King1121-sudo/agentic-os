/** Phase 2 tests: streaming, cancellation, Gemini adapter, cost registry, usage. */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { SqliteDataPort } from '../infra/sqlite.adapter';
import { runMigrations } from '../infra/migrations';
import { ModelRouter } from '../gateway/router';
import { BuiltinProvider, GeminiProvider, abortErr } from '../gateway/providers';
import { lookupCosts } from '../gateway/costs';

let db: SqliteDataPort;
let router: ModelRouter;

beforeAll(async () => {
  const file = path.resolve(__dirname, '..', '..', '..', 'data', `test-phase2-${Date.now()}.db`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new SqliteDataPort(file);
  await runMigrations(db);
  router = new ModelRouter(db, async () => {});
  router.register(new BuiltinProvider());
  await router.bootstrap();
});

describe('phase 2 — streaming', () => {
  it('builtin provider streams token deltas and returns full text', async () => {
    const p = new BuiltinProvider();
    const chunks: string[] = [];
    const resp = await p.generateStream({ capability: 'reasoning', prompt: 'Tell me about the kernel' }, 'reasoner', d => chunks.push(d));
    expect(chunks.length).toBeGreaterThan(3);           // word-by-word cadence
    expect(chunks.join('')).toBe(resp.text);             // deltas reconstruct the output
    expect(resp.output_tokens).toBeGreaterThan(0);
  });

  it('router.generateStream emits tokens through onToken and records the generation', async () => {
    const seen: string[] = [];
    const resp = await router.generateStream(
      { capability: 'reasoning', prompt: 'stream test' },
      (d) => { seen.push(d); },
      { agent_id: null, execution_id: null },
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.join('')).toBe(resp.text);
    const gens = await db.query<any>('SELECT status FROM generations WHERE model_id = ? ORDER BY created_at DESC LIMIT 1', [resp.model_id]);
    expect(gens[0]?.status).toBe('completed');
  });

  it('aborting mid-stream marks the generation cancelled and throws', async () => {
    const ctl = new AbortController();
    const seen: string[] = [];
    // abort after the first few tokens
    const seen0 = new Promise<void>(res => { const t = setTimeout(res, 60); return t; });
    setTimeout(() => ctl.abort(), 80);
    await expect(router.generateStream(
      { capability: 'reasoning', prompt: 'cancel me mid stream with plenty of words to stream' },
      (d) => { seen.push(d); },
      { agent_id: null, execution_id: null },
      ctl.signal,
    )).rejects.toThrow();
    const gens = await db.query<any>("SELECT status FROM generations WHERE status = 'cancelled' ORDER BY created_at DESC LIMIT 1");
    expect(gens.length).toBe(1);
  });
});

describe('phase 2 — cost registry', () => {
  it('matches specific model ids with ordered patterns', () => {
    expect(lookupCosts('openai-compat', 'gpt-4o-mini')).toEqual({ in: 0.15, out: 0.60 });
    expect(lookupCosts('openai-compat', 'gpt-4o')).toEqual({ in: 2.50, out: 10.00 });  // not the -mini price
    expect(lookupCosts('gemini', 'gemini-2.5-flash')).toEqual({ in: 0.30, out: 2.50 });
    expect(lookupCosts('ollama', 'llama-3.3-70b')).toEqual({ in: 0.59, out: 0.79 });
    expect(lookupCosts('builtin', 'planner')).toBeNull();
  });

  it('costs are seeded into the models table at registration', async () => {
    // register a provider with a priced model and check the ledger
    const fakePriced = {
      id: 'openai-compat', name: 'x', kind: 'openai-compat' as const,
      healthy: async () => true,
      listModels: async () => ['gpt-4o-mini'],
      generate: async () => { throw new Error('unused'); },
    };
    // note: router already has builtin registered; create a fresh router for this check
    const r2 = new ModelRouter(db, async () => {});
    r2.register(fakePriced as any);
    await r2.bootstrap();
    const rows = await db.query<any>("SELECT cost_in_per_mtok, cost_out_per_mtok FROM models WHERE id = 'openai-compat:gpt-4o-mini'");
    expect(rows[0]?.cost_in_per_mtok).toBe(0.15);
    expect(rows[0]?.cost_out_per_mtok).toBe(0.60);
  });
});

describe('phase 2 — usage accounting', () => {
  it('aggregates generations per model with numeric coercion', async () => {
    const usage = await router.usage() as any[];
    expect(Array.isArray(usage)).toBe(true);
    expect(usage.length).toBeGreaterThan(0);
    const u = usage.find(x => x.model_id.includes('builtin'));
    expect(typeof u.generations).toBe('number');
    expect(u.completed + u.failed + u.cancelled).toBe(u.generations);
  });
});

describe('phase 2 — gemini adapter shape', () => {
  it('builds the correct request body and parses responses', async () => {
    const p = new GeminiProvider('fake-key', 'https://example.invalid');
    const body = JSON.parse((p as any).body({ capability: 'chat', prompt: 'hello', system: 'be terse' }));
    expect(body.contents[0].parts[0].text).toBe('hello');
    expect(body.systemInstruction.parts[0].text).toBe('be terse');
    expect(body.generationConfig.temperature).toBe(0.4);
  });

  it('healthy() reports false for invalid endpoint', async () => {
    const p = new GeminiProvider('fake-key', 'https://example.invalid');
    expect(await p.healthy()).toBe(false);
  });
});
