/**
 * SQLite DataPort adapter — the default zero-dependency driver.
 * Uses Node's built-in node:sqlite (stable in Node ≥ 23).
 * Same SQL surface as the Postgres adapter: TEXT json columns, ? params, no dialect-specific SQL.
 */
import type { DataPort } from './types';

export class SqliteDataPort implements DataPort {
  kind = 'sqlite' as const;
  private db: any;

  constructor(file: string) {
    // require() keeps this out of the type graph (node:sqlite typings vary across @types/node versions)
    const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (f: string) => any };
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec('PRAGMA foreign_keys=ON;');
    this.db.exec('PRAGMA busy_timeout=5000;');
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as T[];
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    this.db.prepare(sql).run(...params);
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async health(): Promise<boolean> {
    this.db.prepare('SELECT 1 AS ok').get();
    return true;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
