/**
 * EventBus — every meaningful thing that happens becomes an event (§2, §5).
 * Events are persisted (audit + activity stream + universal search) and
 * broadcast over the BrokerPort (SSE + future subscribers: flows, automations).
 */
import type { BrokerPort } from '../infra/types';
import { iso, uuid } from '../infra/types';
import type { EventType, OsEvent } from '@agentic/contracts';
import type { DataPort } from '../infra/types';

export const CHANNEL = 'agentic-os:events';

export class EventBus {
  constructor(private db: DataPort, private broker: BrokerPort) {}

  async emit(
    type: EventType,
    data: unknown,
    opts: { actor_type?: OsEvent['actor_type']; actor_id?: string; target_type?: string; target_id?: string } = {},
  ): Promise<OsEvent> {
    const ev: OsEvent = {
      id: uuid(), type, data: data ?? {},
      actor_type: opts.actor_type ?? 'system',
      actor_id: opts.actor_id,
      target_type: opts.target_type as OsEvent['target_type'], target_id: opts.target_id,
      created_at: iso(),
    };
    // audit_logs is the immutable trail (§26); events is the activity stream (§27)
    await this.db.run(
      `INSERT INTO events (id, type, actor_type, actor_id, target_type, target_id, data, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [ev.id, ev.type, ev.actor_type, ev.actor_id ?? null, ev.target_type ?? null, ev.target_id ?? null,
       JSON.stringify(ev.data), ev.created_at],
    );
    await this.broker.publish(CHANNEL, ev);
    return ev;
  }

  async list(limit = 100, types?: string[]): Promise<OsEvent[]> {
    const rows = await this.db.query<any>(
      `SELECT * FROM events ${types && types.length ? 'WHERE type IN (' + types.map(() => '?').join(',') + ') ' : ''}
       ORDER BY created_at DESC LIMIT ?`,
      [...(types ?? []), limit],
    );
    return rows.map(parseEventRow);
  }

  async tail(sinceIso: string, limit = 200): Promise<OsEvent[]> {
    const rows = await this.db.query<any>(
      'SELECT * FROM events WHERE created_at > ? ORDER BY created_at DESC LIMIT ?', [sinceIso, limit],
    );
    return rows.map(parseEventRow).reverse();
  }
}

export function parseEventRow(r: any): OsEvent {
  return {
    id: r.id, type: r.type, actor_type: r.actor_type, actor_id: r.actor_id ?? undefined,
    target_type: r.target_type ?? undefined, target_id: r.target_id ?? undefined,
    data: safeJson(r.data), created_at: r.created_at,
  };
}

export function safeJson(v: unknown): any {
  if (v == null) return {};
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } }
  return v;
}
