/**
 * Migration runner + entity sync. Idempotent: tracked via schema_migrations.
 * The SQL is identical for both drivers (see 001_kernel.sql).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { DataPort } from './types';

const MIGRATIONS: { id: string; file: string }[] = [
  { id: '001_kernel', file: '001_kernel.sql' },
  { id: '002_agent_messages', file: '002_agent_messages.sql' },
  { id: '003_skill_history', file: '003_skill_history.sql' },
];

export async function runMigrations(db: DataPort): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const applied = new Set((await db.query<{ id: string }>('SELECT id FROM schema_migrations')).map(r => r.id));
  const done: string[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    // __dirname = apps/api/{src|dist}/infra → repo root is 4 levels up
    const sql = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '..', 'sql', m.file), 'utf8');
    await db.exec(sql);
    await db.run('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', [m.id, new Date().toISOString()]);
    done.push(m.id);
  }
  return done;
}

/** Upsert an entity into the graph registry so Links Explorer + universal search can find it. */
export async function syncEntity(
  db: DataPort,
  kind: string, id: string, title: string, subtitle: string, meta: unknown,
): Promise<void> {
  const ref = `${kind}:${id}`;
  const now = new Date().toISOString();
  const existing = await db.query('SELECT id FROM entities WHERE kind = ? AND entity_id = ?', [kind, id]);
  if (existing.length === 0) {
    await db.run(
      'INSERT INTO entities (id, kind, entity_id, title, subtitle, meta, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      [ref, kind, id, title, subtitle, JSON.stringify(meta ?? {}), now, now],
    );
  } else {
    await db.run(
      'UPDATE entities SET title = ?, subtitle = ?, meta = ?, updated_at = ? WHERE kind = ? AND entity_id = ?',
      [title, subtitle, JSON.stringify(meta ?? {}), now, kind, id],
    );
  }
}
