/** Live smoke test: PgVectorIndex driver against a real pgvector Postgres. */
import { PgDataPort } from '../src/infra/pg.adapter';
import { runMigrations } from '../src/infra/migrations';
import { setVectorIndex } from '../src/modules/memory';
import { createMemory, searchMemory } from '../src/modules/memory';
import { PgVectorIndex, LocalEmbeddingProvider } from '../src/modules/vector';

async function main() {
  const db = new PgDataPort('postgres://agentic:agentic@localhost:5544/agentic');
  console.log('migrations:', (await runMigrations(db)).join(', ') || 'up to date');

  const pool = db.getPool();
  const vi = new PgVectorIndex(pool, new LocalEmbeddingProvider(), 128);
  await new Promise(r => setTimeout(r, 500)); // bootstrap window
  console.log('driver stats:', JSON.stringify(vi.stats()), 'native:', vi.native());

  // seed a user + memories
  await db.run('INSERT INTO users (id, username, password_hash, display_name, created_at, updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING',
    ['u1', 'tester', 'x:y', 'T', new Date().toISOString(), new Date().toISOString()]);
  await createMemory(db, { user_id: 'u1', type: 'semantic', content: 'The production database runs on Neon Postgres with pgvector for semantic embeddings.', importance: 8 });
  await createMemory(db, { user_id: 'u1', type: 'semantic', content: 'Grocery list: apples, bananas, oat milk.', importance: 3 });
  await createMemory(db, { user_id: 'u1', type: 'preference', content: 'User prefers dark themes and terse summaries.', importance: 7 });

  // vector column populated?
  const vecCol = await db.query<any>("SELECT COUNT(*) AS n FROM memories WHERE memories_vec IS NOT NULL");
  console.log('rows with vector column set:', vecCol[0].n);

  // raw pgvector search
  const raw = await pool.query("SELECT COUNT(*)::int AS n FROM memories WHERE memories_vec IS NOT NULL");
  console.log('pool raw vector rows:', raw.rows[0].n);

  // driver search
  const hits = await vi.search(db, 'u1', require('../src/modules/text').embed('semantic embeddings database'), ['semantic', 'database', 'embeddings'], 5);
  console.log('driver hits:', JSON.stringify(hits));

  // full engine search through the port
  setVectorIndex(vi);
  const results = await searchMemory(db, { user_id: 'u1', query: 'semantic embeddings database', k: 3 });
  console.log('engine results:');
  for (const r of results) console.log(' ', Number(r.score).toFixed(3), r.summary.slice(0, 70));

  // verify the ANN index exists
  const idx = await pool.query("SELECT indexname FROM pg_indexes WHERE tablename='memories' AND indexname='idx_mem_vec'");
  console.log('ANN index:', idx.rows.length ? idx.rows[0].indexname : 'MISSING (table scan mode)');

  await db.close();
  console.log('DONE');
}

main().catch(e => { console.error('FAIL', e); process.exit(1); });
