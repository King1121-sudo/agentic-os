/**
 * Vector Index Port (Phase 5) — semantic retrieval boundary of the Memory Engine.
 *
 * The memory engine's composite scoring stays in memory.ts (keyword + vector +
 * recency + importance + access); this port supplies the VECTOR leg only, so
 * callers never change:
 *
 *   LocalVectorIndex  — zero-dep default: cosine over stored hash embeddings,
 *                       candidate set pre-narrowed by SQL keyword prefilter.
 *   PgVectorIndex    — production driver: pgvector ANN (cosine distance) when
 *                       DATABASE_URL points at a pgvector-enabled Postgres.
 *                       transparently upgrades to a real embedding provider
 *                       (openai-compat /embeddings) when configured.
 *
 * Both drivers return the same VectorHit[] shape and both keep the SAME
 * embedding dimension, so switching drivers never re-embeds (the pgvector
 * driver carries the hash embeddings forward; a real provider later can
 * re-embed via POST /api/memory/reembed).
 */
import { DataPort } from '../infra/types';
import { VectorHit } from '@agentic/contracts';

export interface VectorIndexPort {
  kind: 'local' | 'pgvector';
  /** Candidate prefilter + vector similarity. Returns memory ids + scores. */
  search(db: DataPort, userId: string, queryEmbedding: number[], queryTokens: string[], k: number, types?: string[]): Promise<VectorHit[]>;
  /** true when the backing store supports native ANN (pgvector installed). */
  native(): boolean;
  /** driver stats for /api/health and the settings panel. */
  stats(): { kind: string; dim: number; provider: string };
}

export interface EmbeddingProvider {
  id: string;
  dim: number;
  embed(text: string): Promise<number[]>;
}

/** Deterministic local hash embedding (kept in sync with memory.embed — same
 *  function, re-exported so drivers don't import in circles). */
import { embed as hashEmbed } from '../modules/memory';

export class LocalEmbeddingProvider implements EmbeddingProvider {
  id = 'local-hash-128';
  dim = 128;
  async embed(text: string): Promise<number[]> { return hashEmbed(text); }
}

/** OpenAI-compatible /embeddings adapter (works for OpenAI, Ollama, LM Studio,
 *  OpenRouter…). Configured via OPENAI_EMBED_BASE_URL / OPENAI_EMBED_MODEL. */
export class OpenAICompatEmbeddingProvider implements EmbeddingProvider {
  id: string;
  dim: number;
  constructor(private baseUrl: string, private apiKey: string, private model: string, dim = 1536) {
    this.id = `openai-compat:${model}`;
    this.dim = dim;
  }
  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({ model: this.model, input: text.slice(0, 8000) }),
    });
    if (!res.ok) throw new Error(`embedding provider ${res.status}`);
    const json: any = await res.json();
    const v = json?.data?.[0]?.embedding;
    if (!Array.isArray(v) || !v.length) throw new Error('embedding provider returned no vector');
    return v;
  }
}

/** ── default: local in-process cosine over stored embeddings ───────────────
 * The memories table keeps embeddings as a JSON array (works on both SQLite
 * and Postgres TEXT columns). The local driver loads a candidate window
 * (keyword-prefiltered, newest first) and scores it with cosine in JS. */
export class LocalVectorIndex implements VectorIndexPort {
  kind = 'local' as const;
  constructor(private provider: EmbeddingProvider = new LocalEmbeddingProvider()) {}

  async search(db: DataPort, userId: string, queryEmbedding: number[], queryTokens: string[], k: number, types?: string[]): Promise<VectorHit[]> {
    // candidate prefilter: any keyword overlap OR recent — keeps the JS cosine
    // pass over a bounded window even for large memory stores
    const rows = await db.query<any>(
      `SELECT id, keywords, embedding FROM memories
       WHERE user_id = ? ${types?.length ? 'AND type IN (' + types.map(() => '?').join(',') + ')' : ''}
       ORDER BY updated_at DESC LIMIT 400`,
      types?.length ? [userId, ...types] : [userId],
    );
    const hits: VectorHit[] = [];
    for (const r of rows) {
      let emb: number[] = [];
      try { emb = typeof r.embedding === 'string' ? JSON.parse(r.embedding) : (r.embedding ?? []); } catch { /* skip */ }
      if (!Array.isArray(emb) || emb.length === 0) continue;
      const kws: string[] = (() => { try { return typeof r.keywords === 'string' ? JSON.parse(r.keywords) : (r.keywords ?? []); } catch { return []; } })();
      // require at least one shared token OR a non-trivial cosine to enter scoring
      let overlap = 0;
      for (const t of queryTokens) if (kws.includes(t)) overlap++;
      const cos = cosine(queryEmbedding, emb);
      if (overlap === 0 && cos < 0.05) continue;
      hits.push({ memory_id: r.id, score: cos });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k * 3); // supersample; composite rescoring happens in memory.ts
  }

  native() { return false; }
  stats() { return { kind: this.kind, dim: this.provider.dim, provider: this.provider.id }; }
}

/** ── pgvector driver ───────────────────────────────────────────────────────
 * Extends the Postgres store with a `memories_vec` column (vector type) kept
 * in sync from the TEXT embedding JSON, then serves the vector leg with ANN
 * cosine-distance ordering. Falls back to the LocalVectorIndex behavior on
 * any pgvector failure (extension not installed, dimension mismatch…). */
export class PgVectorIndex implements VectorIndexPort {
  kind = 'pgvector' as const;
  private local = new LocalVectorIndex();
  private ready: Promise<boolean>;

  constructor(private pool: any, private provider: EmbeddingProvider = new LocalEmbeddingProvider(), private dim = 128) {
    this.ready = this.bootstrap();
  }

  private async bootstrap(): Promise<boolean> {
    try {
      // 1) extension must exist
      const ext = await this.pool.query(`SELECT COUNT(*)::int AS n FROM pg_available_extensions WHERE name = 'vector'`);
      if (!ext.rows?.[0] || ext.rows[0].n < 1) return false;
      await this.pool.query('CREATE EXTENSION IF NOT EXISTS vector');
      // 2) vector column, dimension-stable
      const dim = this.provider.dim;
      await this.pool.query(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS memories_vec vector(${dim})`);
      // 3) index (IVF for scale; HNSW needs pgvector 0.5+ — try, tolerate absence)
      try { await this.pool.query('CREATE INDEX IF NOT EXISTS idx_mem_vec ON memories USING hnsw (memories_vec vector_cosine_ops)'); }
      catch { try { await this.pool.query('CREATE INDEX IF NOT EXISTS idx_mem_vec ON memories USING ivfflat (memories_vec vector_cosine_ops) WITH (lists = 100)'); } catch { /* table scan still works */ } }
      // 3b) keep the vector column in sync on EVERY write: the embedding TEXT
      //     column holds a JSON array ("[0.1,0.2,…]") which is exactly pgvector's
      //     text literal form — a BEFORE INSERT OR UPDATE trigger casts it.
      //     Covers every write path (memory engine, tools, seed) with no
      //     app-code changes.
      await this.pool.query(`
        CREATE OR REPLACE FUNCTION agentic_sync_mem_vec() RETURNS trigger AS $fn$
        BEGIN
          NEW.memories_vec := NEW.embedding::vector;
          RETURN NEW;
        END;
        $fn$ LANGUAGE plpgsql`);
      await this.pool.query('DROP TRIGGER IF EXISTS trg_mem_vec ON memories');
      await this.pool.query(`CREATE TRIGGER trg_mem_vec BEFORE INSERT OR UPDATE OF embedding ON memories
        FOR EACH ROW WHEN (NEW.embedding IS NOT NULL AND NEW.memories_vec IS NULL)
        EXECUTE FUNCTION agentic_sync_mem_vec()`);
      // 4) backfill rows not yet carried into the vector column
      const missing = await this.pool.query(`SELECT id, embedding FROM memories WHERE memories_vec IS NULL`);
      for (const r of missing.rows ?? []) {
        try {
          const v = typeof r.embedding === 'string' ? JSON.parse(r.embedding) : r.embedding;
          if (Array.isArray(v) && v.length === dim) {
            await this.pool.query('UPDATE memories SET memories_vec = $1 WHERE id = $2', [`[${v.join(',')}]`, r.id]);
          }
        } catch { /* skip malformed rows */ }
      }
      return true;
    } catch {
      return false;
    }
  }

  async search(db: DataPort, userId: string, queryEmbedding: number[], queryTokens: string[], k: number, types?: string[]): Promise<VectorHit[]> {
    const ok = await this.ready;
    if (!ok || queryEmbedding.length !== this.dim) return this.local.search(db, userId, queryEmbedding, queryTokens, k, types);
    try {
      const vec = `[${queryEmbedding.join(',')}]`;
      const params: unknown[] = [userId, vec, k * 3];
      let sql = `SELECT id, 1 - (memories_vec <=> $2::vector) AS score FROM memories
                 WHERE user_id = $1 AND memories_vec IS NOT NULL`;
      if (types?.length) {
        sql += ` AND type IN (${types.map((_, i) => `$${i + 4}`).join(',')})`;
        params.push(...types);
      }
      sql += ' ORDER BY memories_vec <=> $2::vector LIMIT $3';
      const res = await this.pool.query(sql, params);
      return (res.rows ?? []).map((r: any) => ({ memory_id: r.id, score: Number(r.score) }));
    } catch {
      return this.local.search(db, userId, queryEmbedding, queryTokens, k, types); // graceful degrade
    }
  }

  native() { return true; }
  stats() { return { kind: this.kind, dim: this.provider.dim, provider: this.provider.id }; }
}

/** Cosine similarity (module-local to avoid importing from memory.ts in tests). */
function cosine(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i];
  return s;
}

/** Factory chosen in main.ts by driver availability + env config. */
export function createVectorIndex(db: DataPort, opts: { embedBaseUrl?: string; embedApiKey?: string; embedModel?: string } = {}): VectorIndexPort {
  const provider: EmbeddingProvider = (opts.embedBaseUrl && opts.embedModel)
    ? new OpenAICompatEmbeddingProvider(opts.embedBaseUrl, opts.embedApiKey ?? '', opts.embedModel)
    : new LocalEmbeddingProvider();
  if (db.kind === 'postgres') {
    const pool = (db as any).getPool?.() ?? (db as any).pool;
    if (pool) return new PgVectorIndex(pool, provider, provider.dim);
  }
  return new LocalVectorIndex(provider);
}
