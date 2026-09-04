/**
 * PostgreSQL DataPort adapter — production driver.
 * Selected automatically when DATABASE_URL is set (docker-compose sets it).
 * Converts ?-placeholders to $n. SQL itself stays identical to SQLite
 * because the schema uses only TEXT/INTEGER/REAL types and app-side UUIDs.
 */
import type { DataPort } from './types';

export class PgDataPort implements DataPort {
  kind = 'postgres' as const;
  private pool: any;

  constructor(connectionUrl: string) {
    const { Pool } = require('pg') as { Pool: new (o: any) => any };
    this.pool = new Pool({ connectionString: connectionUrl, max: 10 });
  }

  private toDollar(sql: string): string {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.pool.query(this.toDollar(sql), params);
    return res.rows as T[];
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    await this.pool.query(this.toDollar(sql), params);
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async health(): Promise<boolean> {
    const r = await this.pool.query('SELECT 1 AS ok');
    return r.rows?.[0]?.ok === 1;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
