/**
 * Memory Engine (§9) — multi-type memory with composite retrieval scoring:
 *   keyword overlap + recency + importance + confidence + access reinforcement,
 *   plus a cheap deterministic hash embedding for fuzzy term overlap.
 * Duplicate detection (content-hash), decay (importance erosion by age),
 * and consolidation (merge near-duplicate semantic memories) are included.
 * This is the MemoryProvider interface — a pgvector/dedicated vector driver can
 * replace `similarity()` without touching callers.
 */
import type { DataPort } from '../infra/types';
import { iso, uuid } from '../infra/types';
import type { MemoryRecord, MemoryHit, MemoryType } from '@agentic/contracts';
import { safeJson } from '../kernel/bus';

const STOPWORDS = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of', 'in',
  'on', 'for', 'with', 'and', 'or', 'not', 'it', 'this', 'that', 'i', 'you', 'my', 'me', 'do', 'does',
  'did', 'have', 'has', 'had', 'will', 'would', 'can', 'could', 'should', 'at', 'as', 'by', 'from', 'what', 'how']);

export function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9][a-z0-9'-]{1,}/g) ?? [])
    .filter(t => !STOPWORDS.has(t) && t.length > 2);
}

/** Deterministic bag-of-hashes embedding (dim 128). Not semantic — but stable,
 * dependency-free, and good enough for term-overlap similarity. A real
 * embedding provider slots into `embed()` without touching any caller. */
export function embed(text: string): number[] {
  const v = new Array(128).fill(0);
  for (const tok of tokenize(text)) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) { h ^= tok.charCodeAt(i); h = Math.imul(h, 16777619); }
    v[Math.abs(h) % 128] += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map(x => x / norm);
}

export function cosine(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i];
  return s;
}

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
       expires_at?: string | null },
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
  const rec: MemoryRecord = {
    id: uuid(), user_id: m.user_id, type: m.type, content,
    summary: m.summary ?? content.slice(0, 160), importance: m.importance ?? 5,
    confidence: m.confidence ?? 0.85, source: m.source ?? 'agent', source_id: m.source_id ?? null,
    project_id: m.project_id ?? null, entities: [], keywords,
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
  return { record: rec, deduped: null };
}

export async function searchMemory(db: DataPort, opts: MemorySearchOpts): Promise<MemoryHit[]> {
  const k = opts.k ?? 5;
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

  const qTokens = new Set(tokenize(opts.query));
  const qEmbed = embed(opts.query);
  const now = Date.now();
  const scored = rows.map(r => {
    const rec = parseMemory(r);
    const kw = new Set(rec.keywords);
    let overlap = 0;
    for (const t of qTokens) if (kw.has(t)) overlap++;
    const keywordScore = qTokens.size ? overlap / qTokens.size : 0;
    const embedScore = cosine(qEmbed, typeof rec.embedding === 'string' ? safeJson(rec.embedding) : (rec.embedding as any) ?? []);
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
  return r;
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
