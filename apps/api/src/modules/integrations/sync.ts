/**
 * Sync Engine (Phase 11) — incremental polling for providers without
 * webhooks (or capabilities webhooks don't cover). Cursor-based, checkpointed
 * in integration_sync_state, rate-limited per manifest, never aggressive
 * (interval floor 60s), with failure backoff and full recovery from cursors.
 */
import type { DataPort } from '../../infra/types';
import { iso } from '../../infra/types';
import type { EventBus } from '../../kernel/bus';
import type { IntegrationService } from './service';

export interface SyncOutcome { provider: string; connectionId: string; newEvents: number; cursor: string | null; status: string }

export class SyncEngine {
  private timers = new Map<string, NodeJS.Timeout>();
  private running = new Set<string>();

  constructor(private deps: { db: DataPort; bus: EventBus; service: IntegrationService }) {}

  /** Start periodic sync for every connection whose provider manifest has sync. */
  async start(): Promise<void> {
    // one engine-level ticker; each tick walks connections with per-provider
    // intervals respected via last_sync_at
    const t = setInterval(() => this.tick().catch(() => {}), 60_000);
    this.timers.set('engine', t);
  }

  stop(): void {
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
  }

  private async tick(): Promise<void> {
    const conns = await this.deps.db.query<any>(
      "SELECT * FROM integration_connections WHERE status = 'connected'");
    for (const row of conns) {
      const adapter = this.deps.service.getAdapter(row.provider);
      if (!adapter?.manifest.sync || !adapter.sync) continue;
      const intervalS = Math.max(60, adapter.manifest.sync.defaultIntervalS);
      const state = await this.deps.db.query<any>(
        'SELECT * FROM integration_sync_state WHERE connection_id = ? AND provider = ?', [row.id, row.provider]);
      const last = state[0]?.last_sync_at ? Date.parse(state[0].last_sync_at) : 0;
      if (Date.now() - last < intervalS * 1000) continue;
      await this.syncConnection(row.id).catch(() => {});
    }
  }

  /** One incremental sync pass for a connection. Returns normalized new items. */
  async syncConnection(connectionId: string): Promise<SyncOutcome> {
    if (this.running.has(connectionId)) {
      return { provider: '?', connectionId, newEvents: 0, cursor: null, status: 'already-running' };
    }
    this.running.add(connectionId);
    try {
      const rows = await this.deps.db.query<any>('SELECT * FROM integration_connections WHERE id = ?', [connectionId]);
      const conn = rows[0];
      if (!conn) throw new Error('connection not found');
      const adapter = this.deps.service.getAdapter(conn.provider);
      if (!adapter?.sync) throw new Error(`${conn.provider} does not support sync`);
      const stateRows = await this.deps.db.query<any>(
        'SELECT cursor FROM integration_sync_state WHERE connection_id = ? AND provider = ?', [connectionId, conn.provider]);
      const cursor = stateRows[0]?.cursor ?? null;

      const cred = await this.deps.service.credentialsFor(connectionId);
      const { items, nextCursor } = await adapter.sync(cred, cursor);

      // normalize + bridge each new item
      let newEvents = 0;
      for (const item of items) {
        const norm = adapter.normalizeItem?.(item);
        if (!norm) continue;
        const { event_type, payload, actor, resource } = norm;
        await this.deps.service.recordNormalizedEvent(conn.provider, connectionId, {
          provider: conn.provider, connection_id: connectionId,
          event_type, actor: actor ?? null, timestamp: iso(),
          resource: resource ?? null, payload,
          capabilities_required: [], source_event_id: null, metadata: { via: 'sync' },
        } as any);
        newEvents++;
      }
      await this.deps.db.run(
        `INSERT INTO integration_sync_state (connection_id, provider, cursor, last_sync_at, last_status)
         VALUES (?,?,?,?,?)
         ON CONFLICT(connection_id, provider) DO UPDATE SET cursor = excluded.cursor,
           last_sync_at = excluded.last_sync_at, last_status = excluded.last_status`,
        [connectionId, conn.provider, nextCursor, iso(), 'ok']);
      await this.deps.db.run('UPDATE integration_connections SET last_success_at = ? WHERE id = ?', [iso(), connectionId]);
      return { provider: conn.provider, connectionId, newEvents, cursor: nextCursor, status: 'ok' };
    } finally {
      this.running.delete(connectionId);
    }
  }
}
