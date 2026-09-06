/**
 * Memory Engine (§9) — multi-type memory with composite retrieval scoring:
 *   keyword overlap + vector similarity + recency + importance + access reinforcement.
 * Phase 5:
 *   - the vector leg is delegated to a VectorIndexPort (local cosine default,
 *     pgvector ANN when DATABASE_URL points at a pgvector Postgres) — callers
 *     of createMemory/searchMemory are UNCHANGED.
 *   - entity extraction: every write pulls person/org/tech/url/topic entities
 *     into the graph (entities + memory_entities + links) so the Links
 *     Explorer and semantic search can traverse memory → entity → memory.
 * Duplicate detection (content-hash), decay, and consolidation included.
 */
import type { DataPort } from '../infra/types';
import { iso, uuid } from '../infra/types';
import type { MemoryRecord, MemoryHit, MemoryType } from '@agentic/contracts';
import { safeJson } from '../kernel/bus';
import { tokenize, embed, cosine, estimateTokens } from './text';
import { extractEntities, linkMemoryEntities } from './entities';
import type { VectorIndexPort } from './vector';

export { tokenize, embed, cosine, estimateTokens };

/** Active vector index — set once at boot by initVectorIndex(); defaults to
 *  in-process scoring (legacy behavior) so existing imports/tests keep working. */
let vectorIndex: VectorIndexPort | null = null;
export function setVectorIndex(v: VectorIndexPort): void { vectorIndex = v; }
export function getVectorIndex(): VectorIndexPort | null { return vectorIndex; }

export interface MemorySearchOpts {
  user_id: string;
  query: string;
  k?: number;
  types?: MemoryType[];
  project_id?: string | null;
  min_importance?: number;
}

export async function createMemory(
  db: DataPort,
  m: { user_id: string; type: MemoryType; content: string; summary?: string; importance?: number;
       confidence?: number; source?: string; source_id?: string | null; project_id?: string | null;
       expires_at?: string | null; bus?: { emit: (t: any, d: unknown, o?: any) => Promise<unknown> } | null },
): Promise<{ record: MemoryRecord; deduped: MemoryRecord | null }> {
  const content = m.content.trim();
  if (!content) throw new Error('memory content empty');

  // duplicate detection: same user + type + normalized content
  const norm = content.toLowerCase().replace(/\s+/g, ' ').slice(0, 200);
  const dupes = await db.query<any>(
    'SELECT * FROM memories WHERE user_id = ? AND type = ? ORDER BY updated_at DESC LIMIT 300',
    [m.user_id, m.type],
  );
  for (const d of dupes) {
    const dContent = String(d.content).toLowerCase().replace(/\s+/g, ' ');
    if (dContent === norm || (dContent.length > 60 && norm.length > 60 && (dContent.includes(norm) || norm.includes(dContent)))) {
      // reinforce instead of duplicating
      const rec = parseMemory(d);
      const updated = { ...rec, importance: Math.min(10, rec.importance + 0.5), updated_at: iso(), access_count: rec.access_count + 1 };
      await db.run(
        'UPDATE memories SET importance = ?, updated_at = ?, access_count = ? WHERE id = ?',
        [updated.importance, updated.updated_at, updated.access_count, rec.id],
      );
      return { record: updated, deduped: rec };
    }
  }

  const now = iso();
  const keywords = [...new Set(tokenize(content))].slice(0, 30);
  // Phase 5: entity extraction at write time — the single choke point every
  // memory write already funnels through (runtime, tools, API, seed).
  const extracted = extractEntities(content);
  const rec: MemoryRecord = {
    id: uuid(), user_id: m.user_id, type: m.type, content,
    summary: m.summary ?? content.slice(0, 160), importance: m.importance ?? 5,
    confidence: m.confidence ?? 0.85, source: m.source ?? 'agent', source_id: m.source_id ?? null,
    project_id: m.project_id ?? null, entities: extracted.map(e => e.name), keywords,
    embedding: JSON.stringify(embed(content)) as unknown as string,
    access_count: 0, created_at: now, updated_at: now, last_accessed: now, expires_at: m.expires_at ?? null,
  };
  await db.run(
    `INSERT INTO memories (id, user_id, type, content, summary, importance, confidence, source, source_id,
      project_id, entities, keywords, embedding, access_count, created_at, updated_at, last_accessed, expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [rec.id, rec.user_id, rec.type, rec.content, rec.summary, rec.importance, rec.confidence, rec.source,
     rec.source_id, rec.project_id, JSON.stringify(rec.entities), JSON.stringify(rec.keywords), rec.embedding,
     0, rec.created_at, rec.updated_at, rec.last_accessed, rec.expires_at],
  );
  // Phase 5: entities → graph (best-effort; a graph failure never blocks the write)
  if (extracted.length) {
    await linkMemoryEntities(db, rec.id, extracted).catch(() => {});
    await m.bus?.emit?.('memory.entities.extracted',
      { memory_id: rec.id, entities: extracted.map(e => `${e.kind}:${e.name}`) },
      { actor_type: 'system', target_type: 'memory', target_id: rec.id }).catch(() => {});
  }
  // mark scanned at write time (extraction already ran; zero-entity is terminal)
  await db.run('INSERT INTO memory_entity_scan (memory_id, processed_at) VALUES (?,?)', [rec.id, iso()])
    .catch(() => { /* already marked — fine */ });
  return { record: rec, deduped: null };
}

export async function searchMemory(db: DataPort, opts: MemorySearchOpts): Promise<MemoryHit[]> {
  const k = opts.k ?? 5;

  // Phase 5: vector leg — delegate to the active VectorIndexPort (pgvector ANN
  // when available, local cosine otherwise); composite rescoring happens below.
  const qTokens = [...new Set(tokenize(opts.query))];
  const qEmbed = embed(opts.query);
  const vectorHits = vectorIndex
    ? await vectorIndex.search(db, opts.user_id, qEmbed, qTokens, k, opts.types?.length ? opts.types.map(String) : undefined).catch(() => [])
    : [];
  const vecScore = new Map<string, number>(vectorHits.map(h => [h.memory_id, h.score]));

  // candidate set: vector supersample ∪ plain recency window (keeps behavior
  // stable when the vector port is unavailable or the query has no tokens)
  let rows = await db.query<any>(
    'SELECT * FROM memories WHERE user_id = ? ORDER BY updated_at DESC LIMIT 500',
    [opts.user_id],
  );
  rows = rows.filter(r => {
    if (opts.types?.length && !opts.types.includes(r.type)) return false;
    if (opts.project_id != null && r.project_id != null && r.project_id !== opts.project_id) return false;
    if (opts.min_importance != null && r.importance < opts.min_importance) return false;
    if (r.expires_at && r.expires_at < iso()) return false;
    return true;
  });
  if (vectorHits.length) {
    // union: rows in the recency window ∪ rows the vector pass surfaced that
    // fell outside it (fetch those by id so they still get composite-scored)
    const inWindow = new Set(rows.map(r => r.id));
    const missing = vectorHits.filter(h => !inWindow.has(h.memory_id)).map(h => h.memory_id);
    if (missing.length) {
      const byId = await db.query<any>(
        `SELECT * FROM memories WHERE user_id = ? AND id IN (${missing.map(() => '?').join(',')})`,
        [opts.user_id, ...missing],
      );
      rows = [...rows, ...byId];
    }
  }

  const now = Date.now();
  const scored = rows.map(r => {
    const rec = parseMemory(r);
    const kw = new Set(rec.keywords);
    let overlap = 0;
    for (const t of qTokens) if (kw.has(t)) overlap++;
    const keywordScore = qTokens.length ? overlap / qTokens.length : 0;
    const embedScore = vecScore.get(rec.id)
      ?? cosine(qEmbed, typeof rec.embedding === 'string' ? safeJson(rec.embedding) : (rec.embedding as any) ?? []);
    const ageDays = Math.max(0, (now - Date.parse(rec.updated_at)) / 86400000);
    const recencyScore = Math.exp(-ageDays / 30);                      // 30-day half-life-ish
    const importanceScore = rec.importance / 10;
    const accessScore = Math.min(1, rec.access_count / 10);
    const score = 0.40 * keywordScore + 0.25 * embedScore + 0.15 * recencyScore
                + 0.15 * importanceScore + 0.05 * accessScore;
    return { ...rec, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, k);

  // access reinforcement for retrieved memories
  for (const h of top) {
    if (h.score > 0.15) {
      await db.run('UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE id = ?', [iso(), h.id]).catch(() => {});
    }
  }
  return top;
}

export async function listMemories(db: DataPort, userId: string, opts: { type?: string; project_id?: string; limit?: number } = {}): Promise<MemoryRecord[]> {
  const conds = ['user_id = ?']; const params: unknown[] = [userId];
  if (opts.type) { conds.push('type = ?'); params.push(opts.type); }
  if (opts.project_id) { conds.push('project_id = ?'); params.push(opts.project_id); }
  params.push(opts.limit ?? 200);
  const rows = await db.query<any>(
    `SELECT * FROM memories WHERE ${conds.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`, params);
  return rows.map(parseMemory);
}
export async function getMemory(db: DataPort, id: string): Promise<MemoryRecord | null> {
  const rows = await db.query<any>('SELECT * FROM memories WHERE id = ?', [id]);
  return rows[0] ? parseMemory(rows[0]) : null;
}
export async function deleteMemory(db: DataPort, id: string): Promise<boolean> {
  const r = await db.run('DELETE FROM memories WHERE id = ?', [id]).then(() => true).catch(() => false);
  // Phase 5: cascade the join rows + graph links (entities themselves stay —
  // other memories may reference them)
  await db.run('DELETE FROM memory_entities WHERE memory_id = ?', [id]).catch(() => {});
  await db.run('DELETE FROM memory_entity_scan WHERE memory_id = ?', [id]).catch(() => {});
  await db.run('DELETE FROM links WHERE (from_type = ? AND from_id = ?) OR (to_type = ? AND to_id = ?)', ['memory', id, 'memory', id]).catch(() => {});
  return r;
}

/** Phase 5: memories linked to an entity (either direction via memory_entities). */
export async function memoriesForEntity(db: DataPort, entityId: string, limit = 50): Promise<MemoryRecord[]> {
  const rows = await db.query<any>(
    `SELECT m.* FROM memories m JOIN memory_entities me ON me.memory_id = m.id
     WHERE me.entity_id = ? ORDER BY m.updated_at DESC LIMIT ?`, [entityId, limit]);
  return rows.map(parseMemory);
}

/** Memory decay: importance erodes with age when the memory hasn't been accessed.
 *  Called by the maintenance cron (and exposed via POST /api/memory/maintain). */
export async function decayMemories(db: DataPort, userId: string): Promise<number> {
  const rows = await db.query<any>('SELECT id, importance, updated_at, last_accessed, access_count FROM memories WHERE user_id = ?', [userId]);
  const now = Date.now(); let n = 0;
  for (const r of rows) {
    const last = Date.parse(r.last_accessed ?? r.updated_at);
    const idleDays = (now - (Number.isNaN(last) ? now : last)) / 86400000;
    if (idleDays > 14 && r.importance > 1) {
      const penalty = Math.min(r.importance - 1, idleDays / 30 * 0.5 * (r.access_count > 0 ? 0.5 : 1));
      const newImp = Math.max(1, r.importance - penalty);
      if (newImp < r.importance) {
        await db.run('UPDATE memories SET importance = ?, updated_at = ? WHERE id = ?', [newImp, iso(), r.id]);
        n++;
      }
    }
  }
  return n;
}

/** Consolidation: merge memories of same type whose embeddings are near-identical. */
export async function consolidateMemories(db: DataPort, userId: string): Promise<{ merged: number }> {
  const rows = await db.query<any>('SELECT * FROM memories WHERE user_id = ? ORDER BY created_at', [userId]);
  const recs = rows.map(parseMemory);
  const removed = new Set<string>(); let merged = 0;
  for (let i = 0; i < recs.length; i++) {
    if (removed.has(recs[i].id)) continue;
    for (let j = i + 1; j < recs.length; j++) {
      if (removed.has(recs[j].id) || recs[i].type !== recs[j].type) continue;
      const a = typeof recs[i].embedding === 'string' ? safeJson(recs[i].embedding) : [];
      const b = typeof recs[j].embedding === 'string' ? safeJson(recs[j].embedding) : [];
      if (cosine(a, b) > 0.92) {
        // merge j into i (keep the richer one)
        const keep = recs[i].content.length >= recs[j].content.length ? recs[i] : recs[j];
        const drop = keep === recs[i] ? recs[j] : recs[i];
        const importance = Math.max(recs[i].importance, recs[j].importance) + 0.5;
        await db.run('UPDATE memories SET importance = ?, updated_at = ? WHERE id = ?', [importance, iso(), keep.id]);
        await db.run('DELETE FROM memories WHERE id = ?', [drop.id]);
        // Phase 5: re-point the dropped memory's entity links at the keeper
        await db.run(
          'UPDATE OR IGNORE memory_entities SET memory_id = ? WHERE memory_id = ? AND entity_id NOT IN (SELECT entity_id FROM memory_entities WHERE memory_id = ?)',
          [keep.id, drop.id, keep.id],
        ).catch(async () => {
          // Postgres has no UPDATE OR IGNORE — fall back to delete-only for conflicting rows
          await db.run("DELETE FROM memory_entities WHERE memory_id = ? AND entity_id IN (SELECT entity_id FROM memory_entities WHERE memory_id = ?)", [drop.id, keep.id]).catch(() => {});
          await db.run('UPDATE memory_entities SET memory_id = ? WHERE memory_id = ?', [keep.id, drop.id]).catch(() => {});
        });
        await db.run('DELETE FROM memory_entities WHERE memory_id = ?', [drop.id]).catch(() => {});
        removed.add(drop.id);
        merged++;
      }
    }
  }
  return { merged };
}

export function parseMemory(r: any): MemoryRecord {
  return {
    id: r.id, user_id: r.user_id, type: r.type, content: r.content, summary: r.summary,
    importance: r.importance, confidence: r.confidence, source: r.source, source_id: r.source_id,
    project_id: r.project_id, entities: safeJson(r.entities), keywords: safeJson(r.keywords),
    embedding: r.embedding, access_count: r.access_count, created_at: r.created_at,
    updated_at: r.updated_at, last_accessed: r.last_accessed, expires_at: r.expires_at,
  };
}
