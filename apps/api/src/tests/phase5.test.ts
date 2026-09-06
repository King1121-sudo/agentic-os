/** Phase 5 tests: vector search port, entity extraction + links, working memory. */
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
import * as memory from '../modules/memory';
import { setVectorIndex } from '../modules/memory';
import { LocalVectorIndex, LocalEmbeddingProvider } from '../modules/vector';
import { extractEntities, linkMemoryEntities, backfillEntities, entityIdFor } from '../modules/entities';
import { openWorkingMemory, appendFact, closeWorkingMemory, getWorkingMemory, renderWorkingMemory } from '../modules/workingmemory';
import { embed, cosine } from '../modules/text';

let db: SqliteDataPort;
let runtime: AgentRuntime;
let bus: EventBus;

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

beforeAll(async () => {
  const file = path.resolve(__dirname, '..', '..', '..', 'data', `test-phase5-${Date.now()}.db`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new SqliteDataPort(file);
  await runMigrations(db);
  await db.run('INSERT INTO users (id, username, password_hash, display_name, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    ['u1', 'tester', 'x:y', 'T', now(), now()]);

  // Phase 5: active vector index = local driver (what a no-PG deployment uses)
  setVectorIndex(new LocalVectorIndex(new LocalEmbeddingProvider()));

  bus = new EventBus(db, new InProcessBroker());
  const router = new ModelRouter(db, async () => {});
  router.register(new BuiltinProvider());
  await router.bootstrap();

  const tools = new ToolRegistry();
  for (const t of createBuiltinTools(db)) tools.register(t);
  runtime = new AgentRuntime(db, new InProcessBroker(), bus, router, tools);
  setRuntimeRef(runtime);

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

// ─── 1. vector search port ──────────────────────────────────────────────────
describe('phase 5 — vector index (local driver)', () => {
  it('semantic search surfaces the right memory via the vector leg', async () => {
    await memory.createMemory(db, { user_id: 'u1', type: 'semantic', content: 'The production database runs on Neon Postgres with pgvector enabled for embeddings.', importance: 8 });
    await memory.createMemory(db, { user_id: 'u1', type: 'preference', content: 'User prefers dark themes and terse summaries.', importance: 7 });
    await memory.createMemory(db, { user_id: 'u1', type: 'semantic', content: 'Grocery list: apples, bananas, oat milk.', importance: 3 });
    const hits = await memory.searchMemory(db, { user_id: 'u1', query: 'where do we store embeddings for semantic search', k: 3 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].content).toContain('pgvector');
    expect(hits[0].score).toBeGreaterThan(0.1);
  });

  it('local vector driver returns memory ids + cosine scores', async () => {
    const vi = memory.getVectorIndex()!;
    const q = embed('database embeddings pgvector');
    const hits = await vi.search(db, 'u1', q, ['database', 'embeddings', 'pgvector'], 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toHaveProperty('memory_id');
    expect(hits[0].score).toBeGreaterThan(0);
    expect(hits[0].score).toBeLessThanOrEqual(1);
  });

  it('stats report the driver + provider identity', () => {
    const vi = memory.getVectorIndex()!;
    const s = vi.stats();
    expect(s.kind).toBe('local');
    expect(s.dim).toBe(128);
    expect(s.provider).toContain('local-hash');
  });

  it('deactivating the port falls back to legacy in-row cosine (callers unchanged)', async () => {
    const saved = memory.getVectorIndex();
    setVectorIndex(null as any);
    try {
      const hits = await memory.searchMemory(db, { user_id: 'u1', query: 'pgvector database', k: 2 });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].content).toContain('pgvector');
    } finally {
      setVectorIndex(saved!);
    }
  });
});

// ─── 2. entity extraction ────────────────────────────────────────────────────
describe('phase 5 — entity extraction', () => {
  it('extracts url / tech / person / org / topic deterministically', () => {
    const ents = extractEntities(
      'Met with John Smith from Acme Labs Inc yesterday — he says the https://acme.dev/docs guide covers pgvector. #kernels "semantic retrieval" is the plan.',
    );
    const kinds = Object.fromEntries(ents.map(e => [`${e.kind}:${e.name.toLowerCase()}`, true]));
    expect(kinds['url:acme.dev']).toBe(true);
    expect(kinds['tech:pgvector']).toBe(true);
    expect(kinds['topic:kernels']).toBe(true);
    expect(kinds['topic:semantic retrieval']).toBe(true);
    // person: mid-sentence capitalized bigram
    expect(ents.some(e => e.kind === 'person' && e.name === 'John Smith')).toBe(true);
    // org: capitalized sequence + Inc marker
    expect(ents.some(e => e.kind === 'org' && /acme/i.test(e.name))).toBe(true);
  });

  it('does NOT extract sentence-initial capitalized subjects as people', () => {
    const ents = extractEntities('The Planning Phase starts now.');
    expect(ents.some(e => e.kind === 'person')).toBe(false);
  });

  it('createMemory links entities → graph (entities, memory_entities, links)', async () => {
    const { record } = await memory.createMemory(db, {
      user_id: 'u1', type: 'semantic',
      content: 'Claude from Anthropic wrote the memo about pgvector and Redis at https://anthropic.com/news.',
      importance: 6,
    });
    // record.entities populated on the memory itself
    expect(record.entities.length).toBeGreaterThan(0);

    // join rows exist
    const joins = await db.query<any>('SELECT * FROM memory_entities WHERE memory_id = ?', [record.id]);
    expect(joins.length).toBeGreaterThan(0);
    // graph links memory -[mentions]-> entity exist
    const links = await db.query<any>(
      "SELECT * FROM links WHERE from_type = 'memory' AND from_id = ? AND relation = 'mentions'", [record.id]);
    expect(links.length).toBe(joins.length);
    // entity registry rows exist with the kind prefix
    for (const j of joins) {
      expect(['person', 'org', 'tech', 'url', 'topic']).toContain(j.entity_id.split(':')[0]);
    }
  });

  it('memoriesForEntity finds linked memories across the join', async () => {
    const entId = `tech:pgvector`;
    const mems = await memory.memoriesForEntity(db, entId);
    expect(mems.length).toBeGreaterThan(0);
    expect(mems.every(m => m.entities.length > 0)).toBe(true);
  });

  it('backfill processes only unlinked memories and is idempotent', async () => {
    // pre-phase-5 memory inserted raw (no extraction)
    await db.run(
      `INSERT INTO memories (id, user_id, type, content, summary, importance, confidence, source, source_id,
        project_id, entities, keywords, embedding, access_count, created_at, updated_at, last_accessed, expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ['legacy-1', 'u1', 'semantic', 'Deployments go through GitHub Actions and Docker.', 'legacy', 5, 0.8, 'seed', null,
        null, '[]', '[]', JSON.stringify(embed('Deployments go through GitHub Actions and Docker.')), 0, now(), now(), now(), null],
    );
    const first = await backfillEntities(db, 200);
    expect(first.processed).toBeGreaterThan(0);
    // the legacy row is now linked
    const linked = await db.query<any>('SELECT COUNT(*) AS n FROM memory_entities WHERE memory_id = ?', ['legacy-1']);
    expect(Number(linked[0].n)).toBeGreaterThan(0);
    // second run: nothing left unlinked → zero processed (idempotent)
    const second = await backfillEntities(db, 200);
    expect(second.processed).toBe(0);
  });

  it('deleteMemory cascades join rows + graph links but keeps entities', async () => {
    const { record } = await memory.createMemory(db, {
      user_id: 'u1', type: 'semantic', content: 'Another note about pgvector and Redis.', importance: 5,
    });
    const entId = `tech:pgvector`;
    const before = await db.query<any>('SELECT COUNT(*) AS n FROM memory_entities WHERE memory_id = ?', [record.id]);
    expect(Number(before[0].n)).toBeGreaterThan(0);
    await memory.deleteMemory(db, record.id);
    const after = await db.query<any>('SELECT COUNT(*) AS n FROM memory_entities WHERE memory_id = ?', [record.id]);
    expect(Number(after[0].n)).toBe(0);
    // entity registry row survives (other memories reference it)
    const still = await db.query<any>("SELECT id FROM entities WHERE kind = 'tech' AND entity_id = 'pgvector'");
    expect(still.length).toBe(1);
  });
});

// ─── 3. working memory ───────────────────────────────────────────────────────
describe('phase 5 — working memory windows', () => {
  it('open → append (bounded) → close lifecycle', async () => {
    const execId = uid();
    const wm = await openWorkingMemory(db, { execution_id: execId, user_id: 'u1', agent_id: 'a1', pinned_memory_ids: ['m1', 'm2'] });
    expect(wm.pinned_memory_ids).toEqual(['m1', 'm2']);
    expect(wm.facts).toEqual([]);
    expect(wm.closed_at).toBeNull();

    const with1 = await appendFact(db, execId, { source: 'tool', step: 1, text: 'http.fetch returned 200 with 4KB body' });
    expect(with1!.facts.length).toBe(1);
    expect(with1!.facts[0].source).toBe('tool');
    expect(with1!.token_estimate).toBeGreaterThan(0);

    // long text is truncated to the bound
    const long = 'x'.repeat(500);
    const with2 = await appendFact(db, execId, { source: 'model', step: 2, text: long });
    expect(with2!.facts[1].text.length).toBeLessThanOrEqual(240);

    // bounds: MAX_FACTS (40) — oldest dropped
    for (let i = 0; i < 50; i++) await appendFact(db, execId, { source: 'test', step: i, text: `fact ${i}` });
    const final = await getWorkingMemory(db, execId);
    expect(final!.facts.length).toBe(40);
    expect(final!.facts[0].text).toContain('fact 10'); // first 12 dropped

    await closeWorkingMemory(db, execId);
    const closed = await getWorkingMemory(db, execId);
    expect(closed!.closed_at).not.toBeNull();

    // append after close still works (facts recorded, window stays inspectable)
    const post = await appendFact(db, execId, { source: 'resume', step: 9, text: 'resumed fact' });
    expect(post!.facts.some(f => f.text === 'resumed fact')).toBe(true);
  });

  it('renderWorkingMemory produces a compact prompt block', async () => {
    const execId = uid();
    await openWorkingMemory(db, { execution_id: execId, user_id: 'u1', agent_id: 'a1', pinned_memory_ids: ['m1'] });
    await appendFact(db, execId, { source: 'tool', step: 1, text: 'created task T-42' });
    const wm = await getWorkingMemory(db, execId);
    const rendered = renderWorkingMemory(wm);
    expect(rendered).toContain('Pinned memory ids: m1');
    expect(rendered).toContain('Working memory facts:');
    expect(rendered).toContain('created task T-42');
  });

  it('a full runtime execution opens a window, records step facts, closes on finish', async () => {
    const agent = (await store.getAgentByName(db, 'Hermes'))!;
    const exec = await runtime.run({ agent, input: 'search memory for pgvector notes and summarize', user_id: 'u1' });
    // wait for terminal state (builtin provider — fast)
    let ex = exec;
    for (let i = 0; i < 100 && !['completed', 'failed', 'cancelled'].includes(ex.status); i++) {
      await new Promise(r => setTimeout(r, 100));
      ex = (await store.getExecution(db, exec.id))!;
    }
    expect(ex.status).toBe('completed');

    const wm = await getWorkingMemory(db, exec.id);
    expect(wm).not.toBeNull();
    expect(wm!.closed_at).not.toBeNull();
    // retrieval fact + step facts recorded
    const sources = wm!.facts.map(f => f.source);
    expect(sources).toContain('retrieval');
    expect(wm!.facts.some(f => ['tool', 'model', 'skill'].includes(f.source))).toBe(true);
    // pinned memories: the search returned hits for the seeded pgvector content
    expect(wm!.pinned_memory_ids.length).toBeGreaterThan(0);
  }, 30000);
});

// ─── 4. cross-feature: consolidation keeps entity links sane ────────────────
describe('phase 5 — consolidation × entities', () => {
  it('merging near-duplicates re-points entity join rows at the keeper', async () => {
    const a = await memory.createMemory(db, { user_id: 'u1', type: 'semantic', content: 'Kafka handles the event stream at Acme Labs Inc.', importance: 5 });
    const b = await memory.createMemory(db, { user_id: 'u1', type: 'semantic', content: 'Kafka handles the event stream at Acme Labs Inc, mostly.', importance: 5 });
    // force near-identical embeddings so consolidation pairs them
    await db.run('UPDATE memories SET embedding = ? WHERE id = ?', [JSON.stringify(embed('Kafka handles the event stream at Acme Labs Inc.')), a.record.id]);
    await db.run('UPDATE memories SET embedding = ? WHERE id = ?', [JSON.stringify(embed('Kafka handles the event stream at Acme Labs Inc.')), b.record.id]);

    const { merged } = await memory.consolidateMemories(db, 'u1');
    expect(merged).toBeGreaterThan(0);
    // no orphaned join rows: every memory_entities row references a live memory
    const orphans = await db.query<any>(
      'SELECT me.* FROM memory_entities me LEFT JOIN memories m ON m.id = me.memory_id WHERE m.id IS NULL');
    expect(orphans.length).toBe(0);
  });
});

// ─── 5. cosine sanity for the shared text module ────────────────────────────
describe('phase 5 — text module', () => {
  it('embed/cosine re-exported from text.ts behave as before', () => {
    const v1 = embed('semantic retrieval over pgvector');
    const v2 = embed('semantic retrieval over pgvector');
    const v3 = embed('totally unrelated content here');
    expect(v1).toEqual(v2);
    expect(cosine(v1, v2)).toBeCloseTo(1, 5);
    expect(cosine(v1, v3)).toBeLessThan(0.6);
  });
});
