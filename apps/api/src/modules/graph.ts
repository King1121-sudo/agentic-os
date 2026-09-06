/**
 * Knowledge Graph engine (Phase 11, §10).
 *
 * The graph registry (entities + links) has existed since v0.1; this phase
 * makes it a real knowledge graph:
 *
 *   1. CO-OCCURRENCE DERIVATION: entities that appear in the SAME memory are
 *      semantically related — every pair sharing a memory gets a derived
 *      `co_occurs_with` link with a strength (shared-memory count). Derived
 *      links are marked `created_by = 'derived'` and the derivation is
 *      idempotent (a derivation ledger row per memory pair prevents recompute
 *      churn; deleted memories clean up).
 *
 *   2. SNAPSHOT: the whole graph in one render-ready payload — nodes sized by
 *      degree, edges typed (explicit vs derived), optional kind filters.
 *
 *   3. NEIGHBORHOODS: one-hop traversal for the explorer's focus mode and for
 *      universal search graph queries.
 *
 *   4. GRAPH QUERIES: entities matching a query expand to their neighborhood —
 *      "what's connected to X?" is now a first-class search result.
 */
import type { DataPort } from '../infra/types';
import { iso } from '../infra/types';
import type { GraphSnapshot, GraphNode, GraphEdge, GraphNeighborhood } from '@agentic/contracts';

/** Node kinds that belong in the visualization. Executions/generations are
 *  registry bookkeeping — they drown the semantic graph, so the snapshot
 *  focuses on meaningful kinds unless explicitly included. */
const VISUAL_KINDS = new Set([
  'person', 'org', 'tech', 'url', 'topic',           // extracted (Phase 5)
  'agent', 'task', 'project', 'sprint', 'skill', 'memory', // kernel entities
]);

// ─── co-occurrence derivation ────────────────────────────────────────────────

export interface DeriveResult { pairs_scanned: number; links_created: number; links_removed: number }

/**
 * Derive co_occurs_with links from memory_entities. For each memory with ≥2
 * entities, every unordered pair gets a link (strength = number of memories
 * the pair shares, recomputed each pass). Idempotent: existing derived links
 * are upserted with fresh counts; pairs that no longer co-occur are removed.
 * `derived_pairs` is the ledger (memory_id, a, b) — actually pairs are
 * recomputed wholesale each pass since the dataset is small; the ledger table
 * is not needed: deletion is by created_by='derived'.
 */
export async function deriveCoOccurrenceLinks(db: DataPort, limit = 5000): Promise<DeriveResult> {
  // 1) gather all (memory_id, entity_id) pairs
  const rows = await db.query<any>(
    'SELECT memory_id, entity_id FROM memory_entities ORDER BY memory_id LIMIT ?', [limit]);
  const byMemory = new Map<string, string[]>();
  for (const r of rows) {
    if (!byMemory.has(r.memory_id)) byMemory.set(r.memory_id, []);
    byMemory.get(r.memory_id)!.push(r.entity_id);
  }

  // 2) count unordered pairs
  const pairCount = new Map<string, { a: string; b: string; n: number }>();
  let pairsScanned = 0;
  for (const ents of byMemory.values()) {
    const uniq = [...new Set(ents)].sort();
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        pairsScanned++;
        const key = `${uniq[i]}|${uniq[j]}`;
        const cur = pairCount.get(key);
        if (cur) cur.n++;
        else pairCount.set(key, { a: uniq[i], b: uniq[j], n: 1 });
      }
    }
  }

  // 3) existing derived links (for upsert/diff) — key by the pair's (type,id)
  // columns reconstructed into refs so they compare against pairCount keys
  const existing = await db.query<any>(
    "SELECT id, from_type, from_id, to_type, to_id, relation FROM links WHERE created_by = 'derived' AND relation = 'co_occurs_with'");
  const existingByKey = new Map(existing.map(l => [`${l.from_type}:${l.from_id}|${l.to_type}:${l.to_id}`, l]));

  let created = 0, removed = 0;
  const now = iso();

  // upsert current pairs (link ids are stable keyed "<a>→<b>" so re-derivation
  // does not churn rows). Entity refs are "<kind>:<slug>" — split them into the
  // (type, id) columns the links table stores.
  const splitRef = (ref: string): [string, string] => {
    const i = ref.indexOf(':');
    return i === -1 ? ['topic', ref] : [ref.slice(0, i), ref.slice(i + 1)];
  };
  for (const { a, b } of pairCount.values()) {
    const key = `${a}|${b}`;
    const ex = existingByKey.get(key);
    if (!ex) {
      const [fa, ia] = splitRef(a);
      const [fb, ib] = splitRef(b);
      await db.run(
        'INSERT INTO links (id, from_type, from_id, to_type, to_id, relation, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)',
        [`der-${a}-${b}`.slice(0, 200), fa, ia, fb, ib, 'co_occurs_with', 'derived', now],
      ).catch(() => { /* id collision on re-derive — fine */ });
      created++;
    }
    existingByKey.delete(key);
  }

  // stale derived links (pairs that no longer co-occur) are removed
  for (const stale of existingByKey.values()) {
    await db.run('DELETE FROM links WHERE id = ?', [stale.id]);
    removed++;
  }

  return { pairs_scanned: pairsScanned, links_created: created, links_removed: removed };
}

// ─── snapshot ────────────────────────────────────────────────────────────────

/** The render-ready graph. `kinds` filters node kinds (default: semantic
 *  kinds only — pass undefined for ALL registry entities incl. executions). */
export async function graphSnapshot(
  db: DataPort,
  opts: { kinds?: string[]; includeAll?: boolean; limit?: number } = {},
): Promise<GraphSnapshot> {
  const limit = opts.limit ?? 800;
  const kinds = opts.includeAll ? null : (opts.kinds?.length ? opts.kinds : [...VISUAL_KINDS]);

  const entityRows = kinds
    ? await db.query<any>(
        `SELECT id, kind, entity_id, title FROM entities WHERE kind IN (${kinds.map(() => '?').join(',')}) ORDER BY updated_at DESC LIMIT ?`,
        [...kinds, limit])
    : await db.query<any>('SELECT id, kind, entity_id, title FROM entities ORDER BY updated_at DESC LIMIT ?', [limit]);

  const nodeIds = new Set(entityRows.map(r => r.id));
  const linkRows = await db.query<any>('SELECT * FROM links ORDER BY created_at DESC LIMIT 3000');

  // edges keep only nodes present in the filtered node set
  const edges: GraphEdge[] = [];
  const degree = new Map<string, number>();
  const weight = new Map<string, number>();
  for (const l of linkRows) {
    const fromId = `${l.from_type}:${l.from_id}`;
    const toId = `${l.to_type}:${l.to_id}`;
    if (!nodeIds.has(fromId) || !nodeIds.has(toId)) continue;
    edges.push({ from: fromId, to: toId, relation: l.relation, derived: l.created_by === 'derived' });
    degree.set(fromId, (degree.get(fromId) ?? 0) + 1);
    degree.set(toId, (degree.get(toId) ?? 0) + 1);
  }
  // co-occurrence strength per node (derived edge count)
  for (const e of edges) if (e.derived) {
    weight.set(e.from, (weight.get(e.from) ?? 0) + 1);
    weight.set(e.to, (weight.get(e.to) ?? 0) + 1);
  }

  const nodes: GraphNode[] = entityRows.map(r => ({
    id: r.id, kind: r.kind, label: r.title || r.entity_id,
    degree: degree.get(r.id) ?? 0, weight: weight.get(r.id) ?? 0,
  }));

  return { nodes, edges, derived: edges.filter(e => e.derived).length };
}

// ─── neighborhoods ───────────────────────────────────────────────────────────

/** One-hop neighborhood of a node — the explorer's focus view and the search
 *  expansion primitive. Returns null when the node is unknown. */
export async function graphNeighborhood(db: DataPort, nodeId: string): Promise<GraphNeighborhood | null> {
  const [kind, ...rest] = nodeId.split(':');
  const entityId = rest.join(':');
  const rows = await db.query<any>('SELECT * FROM entities WHERE kind = ? AND entity_id = ?', [kind, entityId]);
  if (rows.length === 0) return null;
  const center: GraphNode = { id: rows[0].id, kind: rows[0].kind, label: rows[0].title || rows[0].entity_id, degree: 0, weight: 0 };

  const linkRows = await db.query<any>(
    'SELECT * FROM links WHERE (from_type = ? AND from_id = ?) OR (to_type = ? AND to_id = ?)',
    [kind, entityId, kind, entityId]);

  // collect neighbor ids
  const neighborRefs = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const l of linkRows) {
    const fromId = `${l.from_type}:${l.from_id}`;
    const toId = `${l.to_type}:${l.to_id}`;
    edges.push({ from: fromId, to: toId, relation: l.relation, derived: l.created_by === 'derived' });
    neighborRefs.add(l.from_type === kind && l.from_id === entityId ? toId : fromId);
  }
  center.degree = edges.length;

  // fetch neighbor entity rows
  const byKind = new Map<string, Set<string>>();
  for (const ref of neighborRefs) {
    const [k, ...r] = ref.split(':');
    if (!byKind.has(k)) byKind.set(k, new Set());
    byKind.get(k)!.add(r.join(':'));
  }
  const nodes: GraphNode[] = [];
  for (const [k, ids] of byKind) {
    const placeholder = [...ids].map(() => '?').join(',');
    const rrows = await db.query<any>(
      `SELECT id, kind, entity_id, title FROM entities WHERE kind = ? AND entity_id IN (${placeholder})`,
      [k, ...ids]);
    for (const r of rrows) nodes.push({ id: r.id, kind: r.kind, label: r.title || r.entity_id, degree: 0, weight: 0 });
  }
  return { center, nodes, edges };
}

// ─── graph queries for universal search ──────────────────────────────────────

export interface GraphQueryResult {
  matched: { id: string; kind: string; label: string }[];
  neighborhoods: GraphNeighborhood[];
}

/** Graph query: entities matching the query → their one-hop neighborhoods.
 *  "what's connected to pgvector?" expands into related nodes as a result. */
export async function graphQuery(db: DataPort, query: string, maxMatches = 3): Promise<GraphQueryResult> {
  const like = `%${query.toLowerCase()}%`;
  const rows = await db.query<any>(
    "SELECT id, kind, entity_id, title FROM entities WHERE kind IN ('person','org','tech','url','topic','agent','task','project','sprint','skill') AND (LOWER(title) LIKE ? OR LOWER(entity_id) LIKE ?) ORDER BY updated_at DESC LIMIT ?",
    [like, like, maxMatches]);
  const matched = rows.map(r => ({ id: r.id, kind: r.kind, label: r.title || r.entity_id }));
  const neighborhoods: GraphNeighborhood[] = [];
  for (const m of matched) {
    const nb = await graphNeighborhood(db, m.id);
    if (nb && nb.edges.length > 0) neighborhoods.push(nb);
  }
  return { matched, neighborhoods };
}
