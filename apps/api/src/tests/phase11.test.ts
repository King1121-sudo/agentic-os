/** Phase 11 tests: co-occurrence derivation (idempotence, symmetry, stale
 * removal), graph snapshot shape, neighborhoods, graph queries. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { SqliteDataPort } from '../infra/sqlite.adapter';
import { runMigrations } from '../infra/migrations';
import {
  deriveCoOccurrenceLinks, graphSnapshot, graphNeighborhood, graphQuery,
} from '../modules/graph';

let db: SqliteDataPort;

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let mem1: string, mem2: string, mem3: string;

async function insertMemoryWithEntities(id: string, entityIds: string[]): Promise<void> {
  await db.run(
    `INSERT INTO memories (id, user_id, type, content, summary, importance, confidence, source, source_id,
      project_id, entities, keywords, embedding, access_count, created_at, updated_at, last_accessed, expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, 'u1', 'semantic', `test content ${id}`, `test ${id}`, 5, 0.8, 'test', null,
      null, JSON.stringify(entityIds), '[]', '[]', 0, now(), now(), now(), null]);
  for (const e of entityIds) {
    const [kind, ...rest] = e.split(':');
    const entityId = rest.join(':');
    await db.run('INSERT INTO entities (id, kind, entity_id, title, subtitle, meta, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      [e, kind, entityId, entityId.replace(/-/g, ' '), `test ${kind}`, '{}', now(), now()])
      .catch(() => { /* exists */ });
    await db.run('INSERT INTO memory_entities (memory_id, entity_id, created_at) VALUES (?,?,?)', [id, e, now()])
      .catch(() => { /* dup */ });
  }
}

beforeAll(async () => {
  const file = path.resolve(__dirname, '..', '..', '..', 'data', `test-phase11-${Date.now()}.db`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new SqliteDataPort(file);
  await runMigrations(db);
  await db.run('INSERT INTO users (id, username, password_hash, display_name, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    ['u1', 'tester', 'x:y', 'T', now(), now()]);

  // memory 1: pgvector + postgres co-occur
  mem1 = uid();
  await insertMemoryWithEntities(mem1, ['tech:pgvector', 'tech:postgres']);
  // memory 2: pgvector + postgres + redis co-occur (pgvector+postgres pair repeats)
  mem2 = uid();
  await insertMemoryWithEntities(mem2, ['tech:pgvector', 'tech:postgres', 'tech:redis']);
  // memory 3: a person + an org
  mem3 = uid();
  await insertMemoryWithEntities(mem3, ['person:ada-lovelace', 'org:analytical-engines']);
}, 30000);

afterAll(async () => { await db.close().catch(() => {}); });

// ─── co-occurrence derivation ─────────────────────────────────────────────────
describe('phase 11 — co-occurrence derivation', () => {
  it('derives links for every co-occurring pair (unordered, deduped)', async () => {
    const res = await deriveCoOccurrenceLinks(db);
    // pairs: m1(pgvector,postgres) m2(pgvector,postgres) m2(pgvector,redis) m2(postgres,redis) m3(ada,org)
    expect(res.pairs_scanned).toBe(5);
    expect(res.links_created).toBe(4); // 4 distinct pairs: pg-pg? no: pgvector-postgres, pgvector-redis, postgres-redis, ada-org
    // derived rows exist with the marker
    const derived = await db.query<any>("SELECT * FROM links WHERE created_by = 'derived' AND relation = 'co_occurs_with'");
    expect(derived.length).toBe(4);
    // pgvector-postgres shared by TWO memories — but links store pairs once
    const pgPg = derived.filter(l =>
      (l.from_id === 'pgvector' && l.to_id === 'postgres') || (l.from_id === 'postgres' && l.to_id === 'pgvector'));
    expect(pgPg.length).toBe(1); // symmetric pair, single row
  });

  it('second derivation is idempotent (no churn, no duplicates)', async () => {
    const before = await db.query<any>("SELECT COUNT(*) n FROM links WHERE created_by = 'derived'");
    const res = await deriveCoOccurrenceLinks(db);
    expect(res.links_created).toBe(0);            // nothing new
    expect(res.links_removed).toBe(0);            // nothing stale
    const after = await db.query<any>("SELECT COUNT(*) n FROM links WHERE created_by = 'derived'");
    expect(after[0].n).toBe(before[0].n);
  });

  it('removing a memory prunes its now-unique pairs on the next derivation', async () => {
    // drop memory 3 → person:ada-lovelace + org:analytical-engines no longer co-occur
    await db.run('DELETE FROM memory_entities WHERE memory_id = ?', [mem3]);
    const res = await deriveCoOccurrenceLinks(db);
    expect(res.links_removed).toBe(1);
    const adaLinks = await db.query<any>(
      "SELECT * FROM links WHERE (from_id = 'ada-lovelace' OR to_id = 'ada-lovelace') AND created_by = 'derived'");
    expect(adaLinks.length).toBe(0);
  });

  it('derivation survives explicit links (never touches them)', async () => {
    // add an explicit link unrelated to derivation
    await db.run(
      'INSERT INTO links (id, from_type, from_id, to_type, to_id, relation, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)',
      [uid(), 'tech', 'pgvector', 'person', 'ada-lovelace', 'mentions', null, now()]);
    const res = await deriveCoOccurrenceLinks(db);
    expect(res.links_removed).toBe(0); // the explicit mentions link survives
    const explicit = await db.query<any>(
      "SELECT * FROM links WHERE relation = 'mentions' AND from_id = 'pgvector'");
    expect(explicit.length).toBe(1);
  });
});

// ─── snapshot ──────────────────────────────────────────────────────────────────
describe('phase 11 — graph snapshot', () => {
  it('returns render-ready nodes with degrees and typed edges', async () => {
    const snap = await graphSnapshot(db);
    const ids = snap.nodes.map(n => n.id);
    expect(ids).toContain('tech:pgvector');
    expect(ids).toContain('person:ada-lovelace');
    expect(ids).not.toContain(expect.anything && undefined); // sanity
    // executions are excluded from the default visual set
    // (none inserted here, but assert the filter contract via kinds param)
    // pgvector has derived links to postgres + redis (+1 explicit mentions)
    const pg = snap.nodes.find(n => n.id === 'tech:pgvector')!;
    expect(pg.degree).toBe(3); // 2 derived + 1 mentions
    expect(pg.weight).toBe(2); // derived strength = 2 derived edges
    // derived edges are marked
    const derivedEdges = snap.edges.filter(e => e.derived);
    expect(derivedEdges.length).toBe(3); // pg-pg(1) + pg-redis + postgres-redis
    expect(derivedEdges.every(e => e.relation === 'co_occurs_with')).toBe(true);
    // explicit edge present and not marked derived
    const explicitEdge = snap.edges.find(e => e.relation === 'mentions');
    expect(explicitEdge?.derived).toBe(false);
    expect(snap.derived).toBe(3);
  });

  it('kinds filter narrows the node set and edges follow', async () => {
    const snap = await graphSnapshot(db, { kinds: ['tech'] });
    expect(snap.nodes.every(n => n.kind === 'tech')).toBe(true);
    expect(snap.nodes.find(n => n.id === 'tech:pgvector')).toBeTruthy();
    // the mentions edge to person is dropped (person excluded)
    expect(snap.edges.some(e => e.relation === 'mentions')).toBe(false);
  });

  it('includeAll adds every registry entity (executions etc.)', async () => {
    // simulate a bookkeeping entity
    await db.run('INSERT INTO entities (id, kind, entity_id, title, subtitle, meta, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      [`execution:${uid()}`, 'execution', uid(), 'Execution test', '', '{}', now(), now()]);
    const visual = await graphSnapshot(db);
    const all = await graphSnapshot(db, { includeAll: true });
    expect(all.nodes.length).toBeGreaterThan(visual.nodes.length);
    expect(all.nodes.some(n => n.kind === 'execution')).toBe(true);
    expect(visual.nodes.some(n => n.kind === 'execution')).toBe(false);
  });
});

// ─── neighborhoods ────────────────────────────────────────────────────────────
describe('phase 11 — neighborhoods', () => {
  it('one-hop traversal: center + neighbors + typed edges', async () => {
    const nb = await graphNeighborhood(db, 'tech:pgvector');
    expect(nb).not.toBeNull();
    expect(nb!.center.id).toBe('tech:pgvector');
    expect(nb!.center.degree).toBe(3);
    const nbIds = nb!.nodes.map(n => n.id);
    expect(nbIds).toContain('tech:postgres');
    expect(nbIds).toContain('tech:redis');
    expect(nbIds).toContain('person:ada-lovelace'); // via the explicit mentions link
    expect(nb!.edges.length).toBe(3);
  });

  it('unknown node returns null', async () => {
    expect(await graphNeighborhood(db, 'tech:nope')).toBeNull();
  });
});

// ─── graph queries (search integration) ────────────────────────────────────────
describe('phase 11 — graph queries', () => {
  it('matching entities expand to neighborhoods', async () => {
    const gq = await graphQuery(db, 'pgvector');
    expect(gq.matched.length).toBeGreaterThan(0);
    expect(gq.matched[0].id).toBe('tech:pgvector');
    expect(gq.neighborhoods.length).toBeGreaterThan(0);
    expect(gq.neighborhoods[0].center.id).toBe('tech:pgvector');
    expect(gq.neighborhoods[0].nodes.length).toBeGreaterThan(0);
  });

  it('no match → empty result (no crash)', async () => {
    const gq = await graphQuery(db, 'zzz-nonexistent-thing');
    expect(gq.matched).toEqual([]);
    expect(gq.neighborhoods).toEqual([]);
  });

  it('label matching works (title contains query)', async () => {
    // ada-lovelace's label is "ada lovelace" (dashes → spaces)
    const gq = await graphQuery(db, 'ada');
    expect(gq.matched.some(m => m.id === 'person:ada-lovelace')).toBe(true);
  });
});
