/**
 * Integration Platform service (engine) — the ONLY place connection state,
 * credential storage, capability enforcement, token refresh, health, and the
 * normalized event bridge live. Provider behavior comes exclusively from
 * registered manifests + adapters (Phase 7); nothing here knows GitHub/Gmail
 * specifics.
 *
 * Security invariants:
 *  - credentials only ever move between the vault (AES-256-GCM) and an
 *    in-flight adapter call; they are never in API responses, events, logs,
 *    or audit rows (redaction enforced in audit paths)
 *  - a connection is only 'connected' after a successful provider probe
 *  - every capability call checks the connection's granted capability set
 */
import type { DataPort } from '../../infra/types';
import { iso, uuid } from '../../infra/types';
import type { EventBus } from '../../kernel/bus';
import { encryptSecret, decryptSecret } from '../vault';
import {
  type ProviderAdapter, type ProviderManifest, type IntegrationConnection, type NormalizedEvent,
  type AuthMethod, type AdapterCredentials, resolveAuthConfigStatus,
} from './types';
import { oauthStart, oauthExchange, oauthRefresh, needsRefresh } from './oauth';
import { RateLimiter } from './rate-limit';

const REDACT_KEYS = /token|secret|password|authorization|api[-_]?key|credential/i;
/** Deep redaction — anything token/secret-ish is masked before audit/events. */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (typeof value === 'string') return value.length > 400 ? value.slice(0, 400) + '…' : value;
  if (Array.isArray(value)) return value.slice(0, 50).map(v => redactSecrets(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.test(k) ? '[redacted]' : redactSecrets(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface IntegrationEngineDeps { db: DataPort; bus: EventBus }

export class IntegrationService {
  private adapters = new Map<string, ProviderAdapter>();
  private limiter = new RateLimiter();

  constructor(private deps: IntegrationEngineDeps) {}

  register(adapter: ProviderAdapter): void { this.adapters.set(adapter.manifest.id, adapter); }

  getAdapter(provider: string): ProviderAdapter | undefined { return this.adapters.get(provider); }

  listProviders(): unknown[] {
    const out: unknown[] = [];
    for (const a of this.adapters.values()) {
      const m = a.manifest;
      const authConfig = resolveAuthConfigStatus(m);
      out.push({
        id: m.id, name: m.name, icon: m.icon, color: m.color, category: m.category,
        blurb: m.blurb, apiNotes: m.apiNotes ?? [],
        authMethods: m.authMethods.map(x => ({
          kind: x.kind, label: x.label,
          tokenFields: x.tokenFields ?? [],
          configStatus: authConfig[x.kind],
        })),
        capabilities: m.capabilities,
        defaultCapabilities: m.defaultCapabilities ?? m.capabilities.filter(c => c.required).map(c => c.id),
        webhook: m.webhook ? { supported: true, signatureScheme: m.webhook.scheme } : { supported: false },
        sync: m.sync ? { supported: true, defaultIntervalS: m.sync.defaultIntervalS } : { supported: false },
      });
    }
    return out;
  }

  // ── connections ──
  private parseConnection(r: any): IntegrationConnection {
    return {
      id: r.id, provider: r.provider, user_id: r.user_id, label: r.label,
      account_id: r.account_id, identity_key: r.identity_key, status: r.status,
      auth_method: r.auth_method,
      capabilities: JSON.parse(r.capabilities ?? '[]'), scopes: JSON.parse(r.scopes ?? '[]'),
      token_expires_at: r.token_expires_at, last_success_at: r.last_success_at,
      last_error: r.last_error, last_error_at: r.last_error_at,
      created_at: r.created_at, updated_at: r.updated_at,
    };
  }

  async listConnections(userId: string, provider?: string): Promise<IntegrationConnection[]> {
    const rows = provider
      ? await this.deps.db.query<any>('SELECT * FROM integration_connections WHERE user_id = ? AND provider = ? ORDER BY created_at DESC', [userId, provider])
      : await this.deps.db.query<any>('SELECT * FROM integration_connections WHERE user_id = ? ORDER BY created_at DESC', [userId]);
    return rows.map(r => this.parseConnection(r));
  }

  async getConnection(id: string): Promise<IntegrationConnection | null> {
    const rows = await this.deps.db.query<any>('SELECT * FROM integration_connections WHERE id = ?', [id]);
    return rows[0] ? this.parseConnection(rows[0]) : null;
  }

  // ── secrets ──
  private async storeSecret(connectionId: string, kind: string, plaintext: string): Promise<void> {
    const ciphertext = encryptSecret(plaintext);
    await this.deps.db.run(
      `INSERT INTO integration_secrets (id, connection_id, kind, ciphertext, created_at) VALUES (?,?,?,?,?)
       ON CONFLICT(connection_id, kind) DO UPDATE SET ciphertext = excluded.ciphertext`,
      [uuid(), connectionId, kind, ciphertext, iso()]);
  }

  private async readSecret(connectionId: string, kind: string): Promise<string | null> {
    const rows = await this.deps.db.query<any>(
      'SELECT ciphertext FROM integration_secrets WHERE connection_id = ? AND kind = ?', [connectionId, kind]);
    if (!rows[0]) return null;
    try { return decryptSecret(rows[0].ciphertext); } catch { return null; }
  }

  // ── connect (token/bot) ──
  async connectWithToken(
    userId: string, provider: string, token: string, authMethod: AuthMethod['kind'],
    requestedCapabilities: string[], label?: string,
  ): Promise<IntegrationConnection> {
    const adapter = this.requireAdapter(provider);
    const manifest = adapter.manifest;
    const capabilities = requestedCapabilities.length ? requestedCapabilities : manifest.defaultCapabilities ?? [];
    // capability validation FIRST (before any network call): only capabilities
    // the manifest defines can ever be granted
    const valid = manifest.capabilities.map(c => c.id);
    const unknown = capabilities.filter(c => !valid.includes(c));
    if (unknown.length) throw new Error(`unknown capabilities: ${unknown.join(', ')}`);
    const probe = await adapter.probeToken(token);   // throws on bad credentials
    const now = iso();
    const connId = uuid();
    await this.deps.db.run(
      `INSERT INTO integration_connections
        (id, provider, user_id, label, account_id, identity_key, status, auth_method, capabilities, scopes, token_expires_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [connId, provider, userId, label ?? null, probe.account, probe.identityKey ?? null,
       'connected', authMethod, JSON.stringify(capabilities), JSON.stringify(probe.scopes),
       probe.expiresAt ?? null, now, now]);
    await this.storeSecret(connId, 'token', token);
    await this.deps.bus.emit('integration.connected',
      { provider, account: probe.account, capabilities },
      { actor_type: 'user', actor_id: userId, target_type: 'integration', target_id: connId });
    return (await this.getConnection(connId))!;
  }

  // ── OAuth flows ──
  async startOAuth(userId: string, provider: string, capabilities: string[], redirectTo: string | null) {
    const adapter = this.requireAdapter(provider);
    const oauthMethod = adapter.manifest.authMethods.find(m => m.kind === 'oauth2');
    if (!oauthMethod) throw new Error(`${provider} does not support OAuth`);
    return oauthStart(this.deps.db, userId, adapter.manifest, oauthMethod, capabilities, redirectTo);
  }

  async completeOAuth(userId: string, provider: string, state: string, code: string): Promise<IntegrationConnection> {
    const adapter = this.requireAdapter(provider);
    const oauthMethod = adapter.manifest.authMethods.find(m => m.kind === 'oauth2');
    if (!oauthMethod) throw new Error(`${provider} does not support OAuth`);
    const { tokens, userId: stateUser, requestedCapabilities } =
      await oauthExchange(this.deps.db, adapter.manifest, oauthMethod, state, code);
    if (stateUser !== userId) throw new Error('OAuth state does not belong to this session');
    // probe to verify + resolve account (requirement 17: never trust config alone)
    const probe = await adapter.probeToken(tokens.access_token);
    const manifest = adapter.manifest;
    // §9 SHARED GOOGLE IDENTITY: when the provider belongs to a family (google),
    // ONE connection row per provider+account is created, but the FAMILY's
    // credential is stored ONCE under the shared identity key — Gmail and
    // YouTube connections resolve the same vault entry and the same refresh
    // token. familyKey = 'google:<sub>'.
    const family = oauthMethod.oauth?.sharedIdentity;
    const familyKey = family && probe.identityKey ? probe.identityKey : null;
    const capabilities = requestedCapabilities.length ? requestedCapabilities : manifest.defaultCapabilities ?? [];
    const now = iso();

    // §9: incremental auth — if a family credential already exists for this
    // Google account, REUSE it (no second login) when it already covers this
    // provider's needs; the new consent (include_granted_scopes) simply
    // refreshed the shared token.
    let familyVaultId: string | null = null;
    if (familyKey) {
      const existingFamily = await this.deps.db.query<any>(
        'SELECT id FROM integration_connections WHERE identity_key = ? AND user_id = ? LIMIT 1',
        [familyKey, userId]);
      familyVaultId = existingFamily[0]?.id ?? null;
    }

    // multi-account: if the same provider+account already exists, refresh it
    const existing = await this.deps.db.query<any>(
      'SELECT id FROM integration_connections WHERE provider = ? AND user_id = ? AND account_id = ?',
      [provider, userId, probe.account]);
    let connId: string;
    if (existing[0]) {
      connId = existing[0].id;
      await this.deps.db.run(
        `UPDATE integration_connections SET status = 'connected', auth_method = 'oauth2',
          capabilities = ?, scopes = ?, token_expires_at = ?, identity_key = ?, updated_at = ? WHERE id = ?`,
        [JSON.stringify(capabilities), JSON.stringify(tokens.scope), tokens.expires_at, familyKey, now, connId]);
    } else {
      connId = uuid();
      await this.deps.db.run(
        `INSERT INTO integration_connections
          (id, provider, user_id, label, account_id, identity_key, status, auth_method, capabilities, scopes, token_expires_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [connId, provider, userId, null, probe.account, familyKey, 'connected', 'oauth2',
         JSON.stringify(capabilities), JSON.stringify(tokens.scope), tokens.expires_at, now, now]);
    }
    // family credential: store once under the family vault row (or this row when
    // it IS the first family member) — every Google service shares it
    const vaultRow = familyVaultId ?? connId;
    await this.storeSecret(vaultRow, 'token', tokens.access_token);
    if (tokens.refresh_token) await this.storeSecret(vaultRow, 'refresh_token', tokens.refresh_token);
    // when reusing an existing family row, this service row's credentialsFor()
    // resolves through familyVaultId — record that on the connection
    if (familyVaultId && familyVaultId !== connId) {
      await this.storeSecret(connId, 'family_vault_id', familyVaultId);
    }
    await this.deps.bus.emit('integration.connected',
      { provider, account: probe.account, capabilities },
      { actor_type: 'user', actor_id: userId, target_type: 'integration', target_id: connId });
    const conn = (await this.getConnection(connId))!;
    // §11: verify the connection can actually reach the provider API — a token
    // exchange alone never marks CONNECTED. Verification failure → error state
    // with the standard code (the user sees exactly what to fix).
    if (adapter.verifyConnection) {
      const verification = await adapter.verifyConnection({ accessToken: tokens.access_token });
      if (!verification.ok) {
        await this.deps.db.run(
          "UPDATE integration_connections SET status = 'error', last_error = ?, last_error_at = ?, updated_at = ? WHERE id = ?",
          [`${verification.code}: ${verification.detail}`, iso(), iso(), connId]);
        return { ...conn, status: 'error' as const, last_error: `${verification.code}: ${verification.detail}` };
      }
    }
    return conn;
  }

  /** §15 diagnostics — configuration state WITHOUT any secret values. */
  async googleDiagnostics(): Promise<Record<string, unknown>> {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const base = (process.env.AGENTIC_PUBLIC_URL ?? 'http://localhost:3000').replace(/\/$/, '');
    const checks: Record<string, unknown> = {
      client_id: clientId ? 'configured' : 'missing',
      client_secret: clientSecret ? 'configured' : 'missing',
      redirect_uri: `${base}/api/integrations/google/oauth/callback`,
      configured: !!(clientId && clientSecret),
      status: clientId && clientSecret ? 'READY' : (clientId || clientSecret) ? 'MISCONFIGURED' : 'NOT_CONFIGURED',
    };
    const conns = await this.deps.db.query<any>(
      "SELECT provider, status, account_id FROM integration_connections WHERE identity_key LIKE 'google:%' AND status = 'connected'");
    checks.connected_accounts = conns.map(c => ({ provider: c.provider, account: c.account_id }));
    return checks;
  }

  // ── disconnect / revoke ──
  async disconnect(userId: string, connectionId: string): Promise<boolean> {
    const conn = await this.getConnection(connectionId);
    if (!conn || conn.user_id !== userId) return false;
    await this.deps.db.run('DELETE FROM integration_secrets WHERE connection_id = ?', [connectionId]);
    await this.deps.db.run(
      "UPDATE integration_connections SET status = 'disconnected', capabilities = '[]', scopes = '[]', token_expires_at = NULL, updated_at = ? WHERE id = ?",
      [iso(), connectionId]);
    await this.deps.bus.emit('integration.disconnected', { provider: conn.provider, connection_id: connectionId },
      { actor_type: 'user', actor_id: userId, target_type: 'integration', target_id: connectionId });
    return true;
  }

  // ── credentials + refresh (the pre-call pipeline) ──
  /** Live credentials for a connection: shared-family connections resolve the
   *  FAMILY vault row (one Google token set for Gmail+YouTube+…); refreshes an
   *  expired OAuth token when a refresh token exists; marks reauth_required
   *  when refresh fails. */
  async credentialsFor(connectionId: string): Promise<AdapterCredentials> {
    const conn = await this.getConnection(connectionId);
    if (!conn || conn.status !== 'connected') throw new Error('connection is not connected');
    const adapter = this.requireAdapter(conn.provider);
    // §9 shared family credential: service rows point at the family vault row
    const familyRef = await this.readSecret(connectionId, 'family_vault_id');
    const vaultRowId = familyRef ?? connectionId;
    let token = await this.readSecret(vaultRowId, 'token');
    if (!token) { await this.markError(connectionId, 'no stored credential'); throw new Error('no stored credential for this connection'); }
    if (conn.auth_method === 'oauth2' && needsRefresh(conn.token_expires_at)) {
      const refresh = await this.readSecret(vaultRowId, 'refresh_token');
      const method = adapter.manifest.authMethods.find(m => m.kind === 'oauth2');
      if (refresh && method?.oauth) {
        const refreshed = await oauthRefresh(adapter.manifest, method, refresh).catch(() => null);
        if (refreshed) {
          token = refreshed.access_token;
          await this.storeSecret(vaultRowId, 'token', refreshed.access_token);
          if (refreshed.refresh_token) await this.storeSecret(vaultRowId, 'refresh_token', refreshed.refresh_token);
          await this.deps.db.run(
            'UPDATE integration_connections SET token_expires_at = ?, last_success_at = ?, updated_at = ? WHERE id = ?',
            [refreshed.expires_at, iso(), iso(), connectionId]);
          // family expiry: every Google service row sharing this identity
          // expires together (the vault row itself has no family_vault_id
          // pointer — propagate via identity_key so ALL members update)
          if (conn.identity_key) {
            await this.deps.db.run(
              "UPDATE integration_connections SET token_expires_at = ?, updated_at = ? WHERE identity_key = ? AND user_id = ?",
              [refreshed.expires_at, iso(), conn.identity_key, conn.user_id]).catch(() => {});
          }
        } else {
          await this.markReauth(connectionId, 'Google authorization expired or was revoked');
          if (conn.identity_key) {
            // revoked family refresh → every service row needs reauth
            await this.deps.db.run(
              "UPDATE integration_connections SET status = 'reauth_required', last_error = 'Google authorization expired or was revoked', updated_at = ? WHERE identity_key = ? AND user_id = ?",
              [iso(), conn.identity_key, conn.user_id]).catch(() => {});
          }
          throw new Error('authorization expired — reconnect required');
        }
      }
    }
    return { accessToken: token };
  }

  /** Capability-gated execute (Phase 16 pipeline). */
  async executeCapability(
    userId: string, connectionId: string, capabilityId: string, args: Record<string, unknown>,
  ): Promise<unknown> {
    const conn = await this.getConnection(connectionId);
    if (!conn || conn.user_id !== userId) throw new Error('connection not found');
    if (!conn.capabilities.includes(capabilityId)) {
      throw new Error(`connection does not grant ${capabilityId}`);
    }
    const adapter = this.requireAdapter(conn.provider);
    const manifest = adapter.manifest;
    const cap = manifest.capabilities.find(c => c.id === capabilityId);
    if (!cap) throw new Error(`unknown capability ${capabilityId}`);
    // rate limit per provider+connection
    const waitMs = this.limiter.take(`${conn.provider}:${connectionId}`, manifest.rateLimit.maxPerMinute);
    if (waitMs > 0) throw new Error(`${manifest.name} rate limit reached — retry in ~${Math.ceil(waitMs / 1000)}s`);
    const cred = await this.credentialsFor(connectionId);
    try {
      const result = await adapter.execute(capabilityId, cred, args);
      await this.deps.db.run(
        'UPDATE integration_connections SET last_success_at = ?, updated_at = ? WHERE id = ?',
        [iso(), iso(), connectionId]);
      return result;
    } catch (e: any) {
      await this.markError(connectionId, String(e?.message ?? e).slice(0, 200));
      throw e;
    }
  }

  async healthCheck(userId: string, connectionId: string): Promise<{ status: string; detail: string }> {
    const conn = await this.getConnection(connectionId);
    if (!conn || conn.user_id !== userId) throw new Error('connection not found');
    if (conn.status !== 'connected') {
      return { status: conn.status, detail: conn.last_error ?? 'not connected' };
    }
    const adapter = this.requireAdapter(conn.provider);
    if (!adapter.healthCheck) {
      return { status: 'connected', detail: `ok · last success ${conn.last_success_at?.slice(11, 19) ?? 'never'}` };
    }
    try {
      const cred = await this.credentialsFor(connectionId);
      const r = await adapter.healthCheck(cred);
      return { status: r.ok ? 'connected' : 'degraded', detail: r.detail ?? (r.ok ? 'ok' : 'degraded') };
    } catch (e: any) {
      return { status: 'error', detail: String(e?.message ?? e).slice(0, 160) };
    }
  }

  private async markError(connectionId: string, msg: string): Promise<void> {
    await this.deps.db.run(
      'UPDATE integration_connections SET last_error = ?, last_error_at = ?, updated_at = ? WHERE id = ?',
      [msg, iso(), iso(), connectionId]);
  }

  private async markReauth(connectionId: string, msg: string): Promise<void> {
    await this.deps.db.run(
      "UPDATE integration_connections SET status = 'reauth_required', last_error = ?, last_error_at = ?, updated_at = ? WHERE id = ?",
      [msg, iso(), iso(), connectionId]);
  }

  // ── normalized events (Phase 18) ──
  async recordNormalizedEvent(
    provider: string, connectionId: string | null, ev: Omit<NormalizedEvent, 'id'> ,
  ): Promise<NormalizedEvent> {
    const rec: NormalizedEvent = {
      ...ev, id: uuid(), timestamp: ev.timestamp ?? iso(),
    } as NormalizedEvent;
    await this.deps.db.run(
      'INSERT INTO integration_events (id, integration_id, connection_id, kind, payload, received_at) VALUES (?,?,?,?,?,?)',
      [rec.id, provider, connectionId, rec.event_type, JSON.stringify(rec.payload), rec.timestamp]);
    await this.deps.bus.emit('integration.event', {
      integration: provider, kind: rec.event_type,
      connection_id: connectionId, payload: redactSecrets(rec.payload),
    }, { actor_type: 'integration', target_type: 'integration', target_id: provider });
    return rec;
  }

  async listEvents(limit = 50, provider?: string): Promise<any[]> {
    const rows = provider
      ? await this.deps.db.query<any>('SELECT * FROM integration_events WHERE integration_id = ? ORDER BY received_at DESC LIMIT ?', [provider, limit])
      : await this.deps.db.query<any>('SELECT * FROM integration_events ORDER BY received_at DESC LIMIT ?', [limit]);
    return rows;
  }

  private requireAdapter(provider: string): ProviderAdapter {
    const a = this.adapters.get(provider);
    if (!a) throw new Error(`unknown provider: ${provider}`);
    return a;
  }
}
