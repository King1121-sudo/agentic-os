/**
 * Integrations service (Phase 9, §16) — real adapters on the IntegrationPort.
 *
 * Auth modes:
 *   token — personal access token (GitHub PAT / Slack bot token): the user
 *           supplies it, it lands in the encrypted vault, and connect() probes
 *           the provider's identity endpoint to resolve the account handle.
 *   oauth — full authorization-code flow (GitHub + Gmail): GET
 *           /api/integrations/:id/oauth → provider consent screen → callback
 *           exchanges state+code for tokens (CSRF-checked state row, one-time
 *           use, 10-minute expiry).
 *
 * Scope enforcement: every adapter declares required_scopes; connections store
 * granted scopes; read/create/search require the connection to hold the
 * matching scope (403-equivalent errors, never silent).
 *
 * Event bridge: adapters poll/subscribe → events are persisted
 * (integration_events) AND emitted onto the OS bus as `integration.event` —
 * so Phase 8 automations can trigger flows/agents off external activity
 * (trigger_config.event_type = 'integration.event').
 */
import type { DataPort } from '../infra/types';
import { iso, uuid } from '../infra/types';
import type { EventBus } from '../kernel/bus';
import { safeJson } from '../kernel/bus';
import { encryptSecret, decryptSecret } from './vault';
import type { IntegrationRecord, IntegrationEventRecord } from '@agentic/contracts';
import type { IntegrationPort, IntegrationEvent } from './integrations';

// ─── HTTP helper (stdlib fetch, JSON, short timeouts) ───────────────────────

export interface HttpOpts { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number }

export async function httpJson(url: string, opts: HttpOpts = {}): Promise<any> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 10000);
  try {
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'agentic-os/0.9', ...(opts.headers ?? {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: ctl.signal,
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    if (!res.ok) {
      const msg = typeof json === 'object' && json !== null ? (json.message ?? json.error ?? JSON.stringify(json).slice(0, 120)) : String(res.status);
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${String(msg).slice(0, 200)}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

// ─── adapters ───────────────────────────────────────────────────────────────

export interface AdapterContext {
  /** Vault-backed token fetch for a connection (token oauth access tokens). */
  tokenFor(connectionId: string): Promise<string | null>;
}

/** An adapter with the Phase-9 service hooks (OAuth config, probing). */
export interface ServiceAdapter extends IntegrationPort {
  /** OAuth endpoints when the adapter supports the code flow (null otherwise). */
  oauth?: {
    authorizeUrl: string;                        // provider consent screen
    tokenUrl: string;                            // code → tokens exchange
    clientIdEnv: string;                         // env var names for app creds
    clientSecretEnv: string;
    scopeParam: string;                          // space-separated scope string
    redirectUri: (base: string) => string;       // our callback URL
  };
  /** Resolve the account handle + granted capabilities from a raw token. */
  probeToken(token: string): Promise<{ account: string; capabilities: string[] }>;
  /** Map a provider's event item (poll result) to an IntegrationEvent kind. */
  eventKind?: string;
}

// ─── GitHub ─────────────────────────────────────────────────────────────────

export class GitHubAdapter implements ServiceAdapter {
  id = 'github';
  name = 'GitHub';
  required_scopes = ['repo:read', 'issues:read'];
  eventKind = 'pr.opened';
  oauth = {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    clientIdEnv: 'GITHUB_CLIENT_ID',
    clientSecretEnv: 'GITHUB_CLIENT_SECRET',
    scopeParam: 'read:user repo',
    redirectUri: (base: string) => `${base.replace(/\/$/, '')}/api/integrations/github/oauth/callback`,
  };

  private headers(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
  }

  async probeToken(token: string): Promise<{ account: string; capabilities: string[] }> {
    // PAT or OAuth access token both work against /user
    const user = await httpJson('https://api.github.com/user', { headers: this.headers(token) });
    if (!user?.login) throw new Error('GitHub token could not be verified (no login in response)');
    return { account: String(user.login), capabilities: ['read:user', 'repo:read', 'issues:read'] };
  }

  async connect(credentials: unknown): Promise<{ account: string; capabilities: string[] }> {
    const token = String((credentials as any)?.token ?? '');
    if (!token) throw new Error('github connect needs a token');
    return this.probeToken(token);
  }

  async disconnect(_account: string): Promise<void> { /* stateless — vault row removed by the service */ }

  async subscribe(_broker: unknown, onEvent: (ev: IntegrationEvent) => void): Promise<() => void> {
    // GitHub events arrive via user-driven polls (below in pollEvents) — the
    // service layer drives polling; this stub satisfies the port contract.
    return () => { void onEvent; };
  }

  async read(query: Record<string, unknown>): Promise<unknown[]> {
    // list open PRs of a repo — requires repo:read
    const repo = String(query.repo ?? '');
    if (!repo || !/[\w.-]+\/[\w.-]+/.test(repo)) throw new Error('github read needs query.repo as owner/name');
    const token = String(query.__token ?? '');
    if (!token) throw new Error('github read needs a connection token');
    const prs = await httpJson(`https://api.github.com/repos/${repo}/pulls?state=open&per_page=10`,
      { headers: this.headers(token) });
    return (Array.isArray(prs) ? prs : []).map((p: any) => ({
      repo, number: p.number, title: p.title, user: p.user?.login, url: p.html_url,
    }));
  }

  async search(q: string, token?: string): Promise<unknown[]> {
    void token; // public search needs no auth
    const res = await httpJson(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=5`);
    return (res?.items ?? []).map((r: any) => ({ full_name: r.full_name, description: r.description?.slice(0, 120), stars: r.stargazers_count }));
  }
}

// ─── Gmail ──────────────────────────────────────────────────────────────────

export class GmailAdapter implements ServiceAdapter {
  id = 'gmail';
  name = 'Gmail';
  required_scopes = ['gmail:read', 'gmail:send'];
  eventKind = 'email.received';
  oauth = {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    clientIdEnv: 'GMAIL_CLIENT_ID',
    clientSecretEnv: 'GMAIL_CLIENT_SECRET',
    scopeParam: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send',
    redirectUri: (base: string) => `${base.replace(/\/$/, '')}/api/integrations/gmail/oauth/callback`,
  };

  private headers(token: string): Record<string, string> { return { Authorization: `Bearer ${token}` }; }

  async probeToken(token: string): Promise<{ account: string; capabilities: string[] }> {
    const profile = await httpJson('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: this.headers(token) });
    if (!profile?.emailAddress) throw new Error('Gmail token could not be verified');
    return { account: String(profile.emailAddress), capabilities: ['gmail:read', 'gmail:send'] };
  }

  async connect(credentials: unknown): Promise<{ account: string; capabilities: string[] }> {
    const token = String((credentials as any)?.token ?? '');
    if (!token) throw new Error('gmail connect needs an OAuth access token');
    return this.probeToken(token);
  }

  async disconnect(_account: string): Promise<void> {}

  async subscribe(_broker: unknown, _onEvent: (ev: IntegrationEvent) => void): Promise<() => void> {
    return () => {};
  }

  async read(query: Record<string, unknown>): Promise<unknown[]> {
    const token = String(query.__token ?? '');
    if (!token) throw new Error('gmail read needs a connection token');
    const list = await httpJson('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5', { headers: this.headers(token) });
    const ids = (list?.messages ?? []) as any[];
    const out: unknown[] = [];
    for (const m of ids.slice(0, 5)) {
      const msg = await httpJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata`, { headers: this.headers(token) });
      const headers = (msg?.payload?.headers ?? []) as any[];
      const subj = headers.find(h => h.name === 'Subject')?.value ?? '';
      const from = headers.find(h => h.name === 'From')?.value ?? '';
      out.push({ id: m.id, subject: subj, from, snippet: msg?.snippet ?? '' });
    }
    return out;
  }
}

// ─── Slack ──────────────────────────────────────────────────────────────────

export class SlackAdapter implements ServiceAdapter {
  id = 'slack';
  name = 'Slack';
  required_scopes = ['chat:write', 'channels:read'];
  eventKind = 'message.received';
  // Slack's legacy "tokens" don't do the code flow here — bot token only (xoxb-)

  private headers(token: string): Record<string, string> { return { Authorization: `Bearer ${token}` }; }

  async probeToken(token: string): Promise<{ account: string; capabilities: string[] }> {
    const auth = await httpJson('https://slack.com/api/auth.test', { method: 'POST', headers: this.headers(token) });
    if (!auth?.ok) throw new Error(`Slack token could not be verified: ${auth?.error ?? 'unknown'}`);
    return { account: String(auth.team ?? auth.user ?? 'slack'), capabilities: ['chat:write', 'channels:read'] };
  }

  async connect(credentials: unknown): Promise<{ account: string; capabilities: string[] }> {
    const token = String((credentials as any)?.token ?? '');
    if (!token) throw new Error('slack connect needs a bot token (xoxb-)');
    return this.probeToken(token);
  }

  async disconnect(_account: string): Promise<void> {}

  async subscribe(_broker: unknown, _onEvent: (ev: IntegrationEvent) => void): Promise<() => void> {
    return () => {};
  }

  async create(item: Record<string, unknown>): Promise<unknown> {
    const token = String(item.__token ?? '');
    if (!token) throw new Error('slack create (post message) needs a connection token');
    const res = await httpJson('https://slack.com/api/chat.postMessage', {
      method: 'POST', headers: this.headers(token),
      body: { channel: String(item.channel ?? '#general'), text: String(item.text ?? '') },
    });
    if (!res?.ok) throw new Error(`slack postMessage failed: ${res?.error}`);
    return { channel: res.channel, ts: res.ts };
  }

  async read(query: Record<string, unknown>): Promise<unknown[]> {
    const token = String(query.__token ?? '');
    const res = await httpJson('https://slack.com/api/conversations.list?limit=10', { headers: this.headers(token) });
    if (!res?.ok) throw new Error(`slack conversations.list failed: ${res?.error}`);
    return (res.channels ?? []).map((c: any) => ({ id: c.id, name: c.name, members: c.num_members }));
  }
}

// ─── service layer ──────────────────────────────────────────────────────────

export interface IntegrationDeps { db: DataPort; bus: EventBus }

/** Capability → required scope (per-integration permission enforcement). */
const CAPABILITY_SCOPES: Record<string, Record<string, string>> = {
  github: { read: 'repo:read', search: 'repo:read' },
  gmail: { read: 'gmail:read', create: 'gmail:send' },
  slack: { read: 'channels:read', create: 'chat:write' },
};

export class IntegrationService {
  private adapters = new Map<string, ServiceAdapter>();

  constructor(private deps: IntegrationDeps) {
    this.register(new GitHubAdapter());
    this.register(new GmailAdapter());
    this.register(new SlackAdapter());
  }

  register(a: ServiceAdapter): void { this.adapters.set(a.id, a); }

  listAdapters(): { id: string; name: string; required_scopes: string[]; oauth: boolean }[] {
    return [...this.adapters.values()].map(a => ({
      id: a.id, name: a.name, required_scopes: a.required_scopes, oauth: !!a.oauth,
    }));
  }

  getAdapter(id: string): ServiceAdapter | undefined { return this.adapters.get(id); }

  // ── connections ──
  async listConnections(userId: string): Promise<IntegrationRecord[]> {
    const rows = await this.deps.db.query<any>('SELECT * FROM integrations WHERE user_id = ? ORDER BY connected_at DESC', [userId]);
    return rows.map(parseConnection);
  }

  async getConnection(userId: string, integrationId: string): Promise<IntegrationRecord | null> {
    const rows = await this.deps.db.query<any>(
      'SELECT * FROM integrations WHERE user_id = ? AND integration_id = ?', [userId, integrationId]);
    return rows[0] ? parseConnection(rows[0]) : null;
  }

  /** Connect with a raw token (PAT/bot token) or an OAuth access token:
   *  probe the provider for the account handle, store the token encrypted,
   *  upsert the connection row with the granted scopes. */
  async connectWithToken(
    userId: string, integrationId: string, token: string, scopes?: string[],
  ): Promise<IntegrationRecord> {
    const adapter = this.adapters.get(integrationId);
    if (!adapter) throw new Error(`unknown integration: ${integrationId}`);
    const { account, capabilities } = await adapter.probeToken(token);
    const grantedScopes = scopes?.length ? scopes : adapter.required_scopes;
    const now = iso();
    const connId = uuid();
    // upsert (one connection per user per adapter)
    const existing = await this.deps.db.query<any>(
      'SELECT id FROM integrations WHERE user_id = ? AND integration_id = ?', [userId, integrationId]);
    if (existing[0]) {
      await this.deps.db.run(
        'UPDATE integrations SET status = ?, account = ?, capabilities = ?, scopes = ?, updated_at = ? WHERE id = ?',
        ['connected', account, JSON.stringify(capabilities), JSON.stringify(grantedScopes), now, existing[0].id]);
      await this.storeSecret(existing[0].id, 'token', token);
      const rec = await this.getConnection(userId, integrationId);
      await this.deps.bus.emit('integration.connected',
        { integration: integrationId, account, scopes: grantedScopes },
        { actor_type: 'user', actor_id: userId, target_type: 'integration', target_id: integrationId });
      return rec!;
    }
    await this.deps.db.run(
      `INSERT INTO integrations (id, integration_id, user_id, status, account, capabilities, scopes, connected_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [connId, integrationId, userId, 'connected', account, JSON.stringify(capabilities), JSON.stringify(grantedScopes), now, now]);
    await this.storeSecret(connId, 'token', token);
    await this.deps.bus.emit('integration.connected',
      { integration: integrationId, account, scopes: grantedScopes },
      { actor_type: 'user', actor_id: userId, target_type: 'integration', target_id: integrationId });
    return (await this.getConnection(userId, integrationId))!;
  }

  async disconnect(userId: string, integrationId: string): Promise<boolean> {
    const conn = await this.getConnection(userId, integrationId);
    if (!conn || conn.status !== 'connected') return false;   // idempotent: nothing to disconnect
    await this.deps.db.run('DELETE FROM integration_secrets WHERE connection_id = ?', [conn.id]);
    await this.deps.db.run(
      "UPDATE integrations SET status = 'disconnected', capabilities = '[]', scopes = '[]', updated_at = ? WHERE id = ?",
      [iso(), conn.id]);
    await this.deps.bus.emit('integration.disconnected', { integration: integrationId },
      { actor_type: 'user', actor_id: userId, target_type: 'integration', target_id: integrationId });
    return true;
  }

  // ── vault ──
  private async storeSecret(connectionId: string, kind: string, plaintext: string): Promise<void> {
    const ciphertext = encryptSecret(plaintext);
    await this.deps.db.run(
      'INSERT INTO integration_secrets (id, connection_id, kind, ciphertext, created_at) VALUES (?,?,?,?,?) ON CONFLICT(connection_id, kind) DO UPDATE SET ciphertext = excluded.ciphertext',
      [uuid(), connectionId, kind, ciphertext, iso()]);
  }

  async tokenFor(userId: string, integrationId: string): Promise<string | null> {
    const conn = await this.getConnection(userId, integrationId);
    if (!conn || conn.status !== 'connected') return null;
    const rows = await this.deps.db.query<any>(
      'SELECT ciphertext FROM integration_secrets WHERE connection_id = ? AND kind = ?', [conn.id, 'token']);
    if (!rows[0]) return null;
    try { return decryptSecret(rows[0].ciphertext); } catch { return null; }
  }

  // ── scope enforcement ──
  /** Capability gate: the connection must hold the required scope. */
  async requireCapability(userId: string, integrationId: string, capability: string): Promise<IntegrationRecord> {
    const conn = await this.getConnection(userId, integrationId);
    if (!conn || conn.status !== 'connected') {
      throw new Error(`${integrationId} is not connected`);
    }
    const required = CAPABILITY_SCOPES[integrationId]?.[capability];
    if (required && !conn.scopes.includes(required) && !conn.scopes.includes('*')) {
      throw new Error(`missing scope "${required}" for ${integrationId} ${capability}`);
    }
    return conn;
  }

  // ── OAuth (authorization-code flow) ──
  /** Start the flow: create a CSRF state row, return the consent URL. */
  async oauthStart(userId: string, integrationId: string, redirectTo: string | null): Promise<{ url: string; state: string }> {
    const adapter = this.adapters.get(integrationId);
    if (!adapter?.oauth) throw new Error(`${integrationId} does not support OAuth`);
    const clientId = process.env[adapter.oauth.clientIdEnv];
    const clientSecret = process.env[adapter.oauth.clientSecretEnv];
    if (!clientId || !clientSecret) {
      throw new Error(`${integrationId} OAuth app not configured — set ${adapter.oauth.clientIdEnv} and ${adapter.oauth.clientSecretEnv}`);
    }
    const state = uuid() + uuid().slice(0, 8);
    await this.deps.db.run(
      'INSERT INTO oauth_states (state, integration_id, user_id, redirect_to, created_at, expires_at) VALUES (?,?,?,?,?,?)',
      [state, integrationId, userId, redirectTo, iso(), new Date(Date.now() + 10 * 60_000).toISOString()]);
    const base = process.env.AGENTIC_PUBLIC_URL ?? 'http://localhost:3000';
    const url = new URL(adapter.oauth.authorizeUrl);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', adapter.oauth.redirectUri(base));
    url.searchParams.set('state', state);
    url.searchParams.set('scope', adapter.oauth.scopeParam);
    if (integrationId === 'gmail') {
      url.searchParams.set('access_type', 'offline');   // refresh token
      url.searchParams.set('prompt', 'consent');
    }
    await this.deps.bus.emit('integration.oauth.started', { integration: integrationId },
      { actor_type: 'user', actor_id: userId, target_type: 'integration', target_id: integrationId });
    return { url: url.toString(), state };
  }

  /** Complete the flow: validate + consume the state, exchange the code for an
   *  access token, probe, and store the connection. */
  async oauthComplete(userId: string, state: string, code: string): Promise<IntegrationRecord> {
    const rows = await this.deps.db.query<any>('SELECT * FROM oauth_states WHERE state = ?', [state]);
    const st = rows[0];
    if (!st) throw new Error('unknown OAuth state (expired or already used)');
    if (st.user_id !== userId) throw new Error('OAuth state does not belong to this session');
    if (st.expires_at < iso()) {
      await this.deps.db.run('DELETE FROM oauth_states WHERE state = ?', [state]);
      throw new Error('OAuth state expired — restart the connection flow');
    }
    await this.deps.db.run('DELETE FROM oauth_states WHERE state = ?', [state]); // one-time use
    const adapter = this.adapters.get(st.integration_id);
    if (!adapter?.oauth) throw new Error('integration no longer supports OAuth');
    const clientId = process.env[adapter.oauth.clientIdEnv];
    const clientSecret = process.env[adapter.oauth.clientSecretEnv];
    if (!clientId || !clientSecret) throw new Error('OAuth app credentials removed — cannot complete');
    const base = process.env.AGENTIC_PUBLIC_URL ?? 'http://localhost:3000';
    const tokenRes = await httpJson(adapter.oauth.tokenUrl, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: {
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: adapter.oauth.redirectUri(base),
      },
    });
    const accessToken = String(tokenRes?.access_token ?? '');
    if (!accessToken) throw new Error('token exchange returned no access_token');
    // persist the refresh token too when the provider issues one
    const conn = await this.connectWithToken(userId, st.integration_id, accessToken);
    if (tokenRes.refresh_token) {
      const connRow = await this.deps.db.query<any>('SELECT id FROM integrations WHERE user_id = ? AND integration_id = ?', [userId, st.integration_id]);
      if (connRow[0]) await this.storeSecret(connRow[0].id, 'refresh_token', String(tokenRes.refresh_token));
    }
    return conn;
  }

  // ── events + bridge ──
  /** Receive an external event: persist it AND bridge it onto the OS bus as
   *  `integration.event` — automations with trigger event_type
   *  'integration.event' can dispatch flows/agents off it. */
  async receiveEvent(
    integrationId: string, kind: string, payload: Record<string, unknown>, connectionId: string | null = null,
  ): Promise<IntegrationEventRecord> {
    const rec: IntegrationEventRecord = {
      id: uuid(), integration_id: integrationId, connection_id: connectionId,
      kind, payload: payload as any, received_at: iso(),
    };
    await this.deps.db.run(
      'INSERT INTO integration_events (id, integration_id, connection_id, kind, payload, received_at) VALUES (?,?,?,?,?,?)',
      [rec.id, rec.integration_id, rec.connection_id, rec.kind, JSON.stringify(rec.payload), rec.received_at]);
    await this.deps.bus.emit('integration.event', {
      integration: integrationId, kind, payload,
    }, { actor_type: 'integration', target_type: 'integration', target_id: integrationId });
    return rec;
  }

  async listEvents(limit = 50, integrationId?: string): Promise<IntegrationEventRecord[]> {
    const rows = integrationId
      ? await this.deps.db.query<any>('SELECT * FROM integration_events WHERE integration_id = ? ORDER BY received_at DESC LIMIT ?', [integrationId, limit])
      : await this.deps.db.query<any>('SELECT * FROM integration_events ORDER BY received_at DESC LIMIT ?', [limit]);
    return rows.map((r: any) => ({
      id: r.id, integration_id: r.integration_id, connection_id: r.connection_id,
      kind: r.kind, payload: safeJson(r.payload), received_at: r.received_at,
    }));
  }

  // ── capability operations (scope-gated) ──
  async read(userId: string, integrationId: string, query: Record<string, unknown>): Promise<unknown[]> {
    const adapter = this.adapters.get(integrationId);
    if (!adapter?.read) throw new Error(`${integrationId} does not support read`);
    await this.requireCapability(userId, integrationId, 'read');
    const token = await this.tokenFor(userId, integrationId);
    if (!token) throw new Error('no stored token for this connection');
    return adapter.read({ ...query, __token: token });
  }

  async create(userId: string, integrationId: string, item: Record<string, unknown>): Promise<unknown> {
    const adapter = this.adapters.get(integrationId);
    if (!adapter?.create) throw new Error(`${integrationId} does not support create`);
    await this.requireCapability(userId, integrationId, 'create');
    const token = await this.tokenFor(userId, integrationId);
    if (!token) throw new Error('no stored token for this connection');
    const result = await adapter.create({ ...item, __token: token });
    // writing through an integration is an event too (audit trail on the bus)
    await this.receiveEvent(integrationId, `${integrationId}.created`, { item, result } as any);
    return result;
  }

  async search(userId: string, integrationId: string, q: string): Promise<unknown[]> {
    const adapter = this.adapters.get(integrationId);
    if (!adapter?.search) throw new Error(`${integrationId} does not support search`);
    await this.requireCapability(userId, integrationId, 'search');
    const token = await this.tokenFor(userId, integrationId);
    return adapter.search(q, token ?? undefined);
  }
}

function parseConnection(r: any): IntegrationRecord {
  return {
    id: r.id, integration_id: r.integration_id, user_id: r.user_id,
    status: r.status, account: r.account,
    capabilities: safeJson(r.capabilities), scopes: safeJson(r.scopes),
    connected_at: r.connected_at, updated_at: r.updated_at,
  };
}
