/**
 * Google OAuth flow tests (§18) — mocked Google endpoints, no real credentials.
 * Covers: configuration detection, authorize URL (+ per-capability scopes),
 * state generation/validation/rejection, code exchange, encrypted token
 * storage, refresh, revoked → REAUTH_REQUIRED, shared Gmail+YouTube connection
 * (family vault, incremental scopes), disconnect, capability authorization,
 * post-connect verification, secret redaction, diagnostics.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { SqliteDataPort } from '../infra/sqlite.adapter';
import { runMigrations } from '../infra/migrations';
import { InProcessBroker } from '../infra/broker';
import { EventBus } from '../kernel/bus';
import { redactSecrets } from '../modules/integrations/service';
import { createIntegrationPlatform } from '../modules/integrations/index';
import { oauthStart, oauthExchange, oauthRefresh, needsRefresh, scopesForCapabilities, resolveOAuthFlow } from '../modules/integrations/oauth';
import { gmailManifest, youtubeManifest } from '../modules/integrations/providers';
import { encryptSecret, decryptSecret, __resetVaultKeyForTests } from '../modules/vault';

let db: SqliteDataPort;
let bus: EventBus;
const uid = () => crypto.randomUUID();
const USER = uid();

const mockToken = (opts: { access: string; refresh?: string; expiresInS: number }) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    new Response(JSON.stringify({
      access_token: opts.access,
      refresh_token: opts.refresh,
      expires_in: opts.expiresInS,
      scope: 'openid email https://www.googleapis.com/auth/gmail.readonly',
    }), { status: 200 }));

beforeAll(async () => {
  __resetVaultKeyForTests();
  const file = path.resolve(__dirname, '..', '..', '..', 'data', `test-google-${Date.now()}.db`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new SqliteDataPort(file);
  await runMigrations(db);
  bus = new EventBus(db, new InProcessBroker());
  process.env.GOOGLE_CLIENT_ID = 'g-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'g-client-secret';
}, 30000);
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await db.close().catch(() => {}); });

// ─── configuration detection ─────────────────────────────────────────────────

describe('google oauth — configuration', () => {
  it('resolveOAuthFlow throws a user-safe message when env is missing (no secret echoed)', () => {
    const savedId = process.env.GOOGLE_CLIENT_ID;
    const savedSecret = process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    try {
      expect(() => resolveOAuthFlow(gmailManifest, gmailManifest.authMethods[0]))
        .toThrow(/Gmail OAuth app not configured — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET/);
    } finally {
      process.env.GOOGLE_CLIENT_ID = savedId;
      process.env.GOOGLE_CLIENT_SECRET = savedSecret;
    }
  });
  it('diagnostics report READY + correct family redirect URI, no secret values', async () => {
    const svc = createIntegrationPlatform({ db, bus });
    const d = await svc.googleDiagnostics() as any;
    expect(d.status).toBe('READY');
    expect(d.client_id).toBe('configured');
    expect(d.client_secret).toBe('configured');
    expect(d.redirect_uri).toBe('http://localhost:3000/api/integrations/google/oauth/callback');
    expect(JSON.stringify(d)).not.toContain('g-client-secret');
  });
});

// ─── authorize URL + scopes ──────────────────────────────────────────────────

describe('google oauth — authorize URL + capability scopes', () => {
  it('builds the consent URL with response_type=code, PKCE S256, family redirect, offline access, and granted-scopes increment', async () => {
    const { url } = await oauthStart(db, USER, gmailManifest, gmailManifest.authMethods[0], ['gmail.read'], null);
    const u = new URL(url);
    expect(u.origin).toBe('https://accounts.google.com');
    expect(u.pathname).toBe('/o/oauth2/v2/auth');
    expect(u.searchParams.get('client_id')).toBe('g-client-id');
    expect(u.searchParams.get('response_type')).toBe('code');   // REQUIRED — its omission was Google's 400 malformed-request
    expect(u.searchParams.get('redirect_uri')).toBe('http://localhost:3000/api/integrations/google/oauth/callback');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('prompt')).toBe('consent');
    expect(u.searchParams.get('include_granted_scopes')).toBe('true');
    expect(u.searchParams.get('state')).toBeTruthy();
    expect(u.searchParams.get('scope')).toContain('openid');
    expect(u.searchParams.get('scope')).toContain('email');
    // URL-encoded correctly (URLSearchParams handles the space-separated scopes)
    expect(url).toContain(encodeURIComponent('https://www.googleapis.com/auth/gmail.readonly'));
  });
  it('scopes are computed from the SELECTED capabilities — least privilege (§4)', () => {
    const s = scopesForCapabilities(gmailManifest, ['gmail.read', 'gmail.send']);
    expect(s).toContain('gmail.readonly');
    expect(s).toContain('gmail.send');
    expect(s).not.toContain('youtube.readonly');
    const ytOnly = scopesForCapabilities(youtubeManifest, ['youtube.channel.read']);
    expect(ytOnly).toContain('youtube.readonly');
    expect(ytOnly).not.toContain('gmail');
  });
});

// ─── state + exchange ─────────────────────────────────────────────────────────

describe('google oauth — state + code exchange', () => {
  it('state is one-time and user-bound; replay rejected', async () => {
    const { state } = await oauthStart(db, USER, gmailManifest, gmailManifest.authMethods[0], ['gmail.read'], null);
    const rows = await db.query<any>('SELECT * FROM oauth_states WHERE state = ?', [state]);
    expect(rows[0].user_id).toBe(USER);
    expect(rows[0].code_challenge).toBeTruthy();  // PKCE verifier stored
    // exchange = ONE fetch (the token call). Correct user consumes the state.
    mockToken({ access: 'ACCESS-1', refresh: 'REFRESH-1', expiresInS: 3600 });
    const r = await oauthExchange(db, gmailManifest, gmailManifest.authMethods[0], state, 'code-1');
    expect(r.tokens.access_token).toBe('ACCESS-1');
    expect(r.userId).toBe(USER);
    // replay: same state → rejected
    await expect(oauthExchange(db, gmailManifest, gmailManifest.authMethods[0], state, 'code-1'))
      .rejects.toThrow(/unknown OAuth state/);
    // foreign state: garbage → rejected
    await expect(oauthExchange(db, gmailManifest, gmailManifest.authMethods[0], 'totally-fake-state', 'c'))
      .rejects.toThrow(/unknown OAuth state/);
  });
});

// ─── shared connection: Gmail + YouTube on ONE Google identity (§9) ──────────

describe('google oauth — shared connection + capability authorization', () => {
  it('Gmail connect stores the family credential; YouTube connect REUSES it (same vault row)', async () => {
    const svc = createIntegrationPlatform({ db, bus });

    // Gmail: start + exchange + probe + verify
    const g = await svc.startOAuth(USER, 'gmail', ['gmail.read', 'gmail.search', 'gmail.send'], '/integrations');
    const fm = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'GA-1', refresh_token: 'GR-1', expires_in: 3600,
        scope: 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: 'g-sub-9', email: 'owner@gmail.com', name: 'O' }), { status: 200 }))  // identity
      .mockResolvedValueOnce(new Response(JSON.stringify({ emailAddress: 'owner@gmail.com' }), { status: 200 }));                  // gmail verify
    const gmailConn = await svc.completeOAuth(USER, 'gmail', g.state, 'gcode');
    expect(gmailConn.status).toBe('connected');
    expect(gmailConn.account_id).toBe('owner@gmail.com');
    expect(gmailConn.identity_key).toBe('google:g-sub-9');
    fm.mockRestore();

    // YouTube connect for the SAME Google account: family vault resolves the
    // SAME credential row — no second Google login would be needed in practice;
    // here we complete the flow and assert the family_vault_id pointer.
    const y = await svc.startOAuth(USER, 'youtube', ['youtube.channel.read', 'youtube.video.read'], '/integrations');
    const fmy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'GA-2', refresh_token: 'GR-2', expires_in: 3600,
        scope: 'openid email https://www.googleapis.com/auth/youtube.readonly' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: 'g-sub-9', email: 'owner@gmail.com', name: 'O' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }));   // youtube verify (no channel — ok)
    const ytConn = await svc.completeOAuth(USER, 'youtube', y.state, 'ycode');
    expect(ytConn.status).toBe('connected');
    expect(ytConn.identity_key).toBe('google:g-sub-9');
    fmy.mockRestore();

    // §9: the YouTube row points at the Gmail row's vault (family credential)
    const famRef = await db.query<any>(
      "SELECT connection_id, ciphertext FROM integration_secrets WHERE kind = 'family_vault_id'");
    expect(famRef.length).toBeGreaterThan(0);
    const gmailRow = await db.query<any>("SELECT id FROM integration_connections WHERE provider = 'gmail' AND user_id = ?", [USER]);
    // the family_vault_id pointer ON the youtube row decrypts to the gmail row id
    const pointerVal = famRef.map((r: any) => r.ciphertext).find((ct: string) => {
      try { return decryptSecret(ct) === gmailRow[0].id; } catch { return false; }
    });
    expect(pointerVal).toBeTruthy();
    expect(famRef[0].connection_id).toBe(ytConn.id);
  });

  it('capability authorization: gmail.send denied without the grant; allowed with it', async () => {
    const svc = createIntegrationPlatform({ db, bus });
    const conns = await svc.listConnections(USER, 'gmail');
    const conn = conns.find(c => c.status === 'connected')!;
    // connection granted gmail.read/search/send (from startOAuth caps)
    const capOk = conn.capabilities.includes('gmail.send');
    expect(capOk).toBe(true);
    // engine-level denial path: a connection WITHOUT gmail.send
    const { state } = await oauthStart(db, USER, gmailManifest, gmailManifest.authMethods[0], ['gmail.read'], null);
    const fm = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'X1', expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: 's2', email: 'other@gmail.com' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ emailAddress: 'other@gmail.com' }), { status: 200 }));
    const limited = await svc.completeOAuth(USER, 'gmail', state, 'c2');
    expect(limited.capabilities).not.toContain('gmail.send');
    await expect(svc.executeCapability(USER, limited.id, 'gmail.send', { to: 'x@y.c', subject: 's' }))
      .rejects.toThrow(/does not grant/);
    fm.mockRestore();
  });

  it('post-connect verification failure → error state with a standard code (API_NOT_ENABLED)', async () => {
    const svc = createIntegrationPlatform({ db, bus });
    const { state } = await oauthStart(db, USER, gmailManifest, gmailManifest.authMethods[0], ['gmail.read'], null);
    const fm = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'X2', expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: 's3', email: 'noapi@gmail.com' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Gmail API has not been used in project 1 before or it is disabled' } }), { status: 403 }));
    const conn = await svc.completeOAuth(USER, 'gmail', state, 'c3');
    expect(conn.status).toBe('error');
    expect(conn.last_error).toContain('API_NOT_ENABLED');
    fm.mockRestore();
  });
});

// ─── token refresh + revoked (§7) ─────────────────────────────────────────────

describe('google oauth — refresh + reauth', () => {
  it('expired token refreshes through the family vault; revoked refresh → REAUTH_REQUIRED on every Google service', async () => {
    const svc = createIntegrationPlatform({ db, bus });
    // connect gmail + youtube sharing family vault
    const g = await svc.startOAuth(USER, 'gmail', ['gmail.read'], '/integrations');
    let fm = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'A1', refresh_token: 'R1', expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: 'fsub', email: 'fam@gmail.com' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ emailAddress: 'fam@gmail.com' }), { status: 200 }));
    await svc.completeOAuth(USER, 'gmail', g.state, 'gc');
    fm.mockRestore();
    const y = await svc.startOAuth(USER, 'youtube', ['youtube.channel.read'], '/integrations');
    fm = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'A2', refresh_token: 'R2', expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: 'fsub', email: 'fam@gmail.com' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    await svc.completeOAuth(USER, 'youtube', y.state, 'yc');
    fm.mockRestore();

    // expire BOTH service rows
    await db.run("UPDATE integration_connections SET token_expires_at = ? WHERE identity_key = 'google:fsub' AND user_id = ?",
      [new Date(Date.now() - 1000).toISOString(), USER]);

    // gmail.read triggers a family refresh → succeeds → both rows get new expiry
    fm = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'A-NEW', expires_in: 3600 }), { status: 200 }))   // refresh
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [] }), { status: 200 }));                               // gmail list
    const out = await svc.executeCapability(USER, (await svc.listConnections(USER, 'gmail'))[0].id, 'gmail.read', {});
    expect(out).toBeTruthy();
    fm.mockRestore();
    const rows = await db.query<any>("SELECT token_expires_at FROM integration_connections WHERE identity_key = 'google:fsub' AND user_id = ?", [USER]);
    expect(rows.every(r => Date.parse(r.token_expires_at) > Date.now())).toBe(true);

    // now revoke: refresh fails → REAUTH_REQUIRED on gmail AND youtube
    await db.run("UPDATE integration_connections SET token_expires_at = ? WHERE identity_key = 'google:fsub' AND user_id = ?",
      [new Date(Date.now() - 1000).toISOString(), USER]);
    fm = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }));   // revoked refresh
    const gmailConn = (await svc.listConnections(USER, 'gmail'))[0];
    await expect(svc.executeCapability(USER, gmailConn.id, 'gmail.read', {})).rejects.toThrow(/authorization expired/);
    fm.mockRestore();
    const after = await db.query<any>("SELECT status FROM integration_connections WHERE identity_key = 'google:fsub' AND user_id = ?", [USER]);
    expect(after.every(r => r.status === 'reauth_required')).toBe(true);   // family-wide reauth
  });

  it('oauthRefresh returns null on invalid_grant (the reauth trigger)', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }));
    expect(await oauthRefresh(gmailManifest, gmailManifest.authMethods[0], 'revoked')).toBeNull();
  });
  it('needsRefresh respects the 60s skew window', () => {
    expect(needsRefresh(new Date(Date.now() + 3600_000).toISOString())).toBe(false);
    expect(needsRefresh(new Date(Date.now() + 30_000).toISOString())).toBe(true);
  });
});

// ─── storage + redaction ─────────────────────────────────────────────────────

describe('google oauth — encrypted storage + secret redaction', () => {
  it('tokens are AES-256-GCM sealed — never plaintext in the DB', async () => {
    const ct = encryptSecret('ya29.google-access-token');
    expect(ct).not.toContain('ya29');
    expect(decryptSecret(ct)).toBe('ya29.google-access-token');
    const rows = await db.query<any>('SELECT ciphertext FROM integration_secrets LIMIT 3');
    expect(JSON.stringify(rows)).not.toContain('ya29.google-access-token');
  });
  it('redactSecrets masks access/refresh token fields at any depth', () => {
    const out = redactSecrets({ access_token: 'a', refresh_token: 'r', payload: { authorization: 'Bearer x' } }) as any;
    expect(out.access_token).toBe('[redacted]');
    expect(out.refresh_token).toBe('[redacted]');
    expect(out.payload.authorization).toBe('[redacted]');
  });
  it('disconnect deletes vault rows (family members keep the shared credential)', async () => {
    const svc = createIntegrationPlatform({ db, bus });
    const conns = await svc.listConnections(USER, 'gmail');
    const target = conns.find(c => c.status === 'connected');
    if (target) {
      const ok = await svc.disconnect(USER, target.id);
      expect(ok).toBe(true);
      const secrets = await db.query<any>('SELECT * FROM integration_secrets WHERE connection_id = ?', [target.id]);
      expect(secrets.every(s => s.kind === 'family_vault_id')).toBe(true);   // only the pointer row remains
    }
  });
});
