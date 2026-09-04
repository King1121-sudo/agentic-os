/**
 * Infrastructure PORTS (the replaceable boundaries of the OS).
 *
 * DataPort  — persistence. Adapters: node:sqlite (default), PostgreSQL.
 *             All persistence goes through typed service methods that emit
 *             dialect-neutral SQL (TEXT json columns, ?-params, UUIDs from app).
 * BrokerPort— pub/sub.   Adapters: in-process (default), Redis.
 * ModelProviderPort lives in gateway/types.ts.
 */
export interface DataPort {
  kind: 'sqlite' | 'postgres';
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<void>;
  exec(sql: string): Promise<void>;
  health(): Promise<boolean>;
  close(): Promise<void>;
}

export type BrokerHandler = (channel: string, payload: unknown) => void;

export interface BrokerPort {
  kind: 'inprocess' | 'redis';
  publish(channel: string, payload: unknown): Promise<void>;
  subscribe(channel: string, handler: BrokerHandler): Promise<() => void>;
  close(): Promise<void>;
}

/** minimal shared helpers for SQL adapters */
export function toParams(v: unknown): unknown {
  if (v === undefined) return null;
  if (v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (Array.isArray(v) || (typeof v === 'object' && v !== null)) return JSON.stringify(v);
  return v;
}
export function iso(d: Date = new Date()): string { return d.toISOString(); }
export function uuid(): string { return crypto.randomUUID(); }
