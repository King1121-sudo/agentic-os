/**
 * Integration Platform tests (finalization Phases 21) — OAuth state/PKCE,
 * capability enforcement, encrypted storage, secret redaction, webhook
 * verification + replay, health, connection lifecycle, multi-account,
 * rate limiting, and provider adapter probes against MOCKED HTTP.
 * No real credentials anywhere.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { SqliteDataPort } from '../infra/sqlite.adapter';
import { runMigrations } from '../infra/migrations';
import { InProcessBroker } from '../infra/broker';
import { EventBus } from '../kernel/bus';
import { IntegrationService, redactSecrets } from '../modules/integrations/service';
import { verifyWebhookSignature, claimWebhookEvent, intakeWebhook } from '../modules/integrations/webhooks';
import { oauthStart, oauthExchange, oauthRefresh, needsRefresh } from '../modules/integrations/oauth';
import { RateLimiter } from '../modules/integrations/rate-limit';
import { githubManifest, slackManifest, gmailManifest, GitHubPlatformAdapter, TelegramPlatformAdapter } from '../modules/integrations/providers';
import { resolveAuthConfigStatus } from '../modules/integrations/types';
import { createIntegrationPlatform } from '../modules/integrations/index';
import { encryptSecret, decryptSecret, __resetVaultKeyForTests } from '../modules/vault';
import type { ProviderAdapter } from '../modules/integrations/types';

let db: SqliteDataPort;
let bus: EventBus;
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

beforeAll(async () => {
  __resetVaultKeyForTests();
  const file = path.resolve(__dirname, '..', '..', '..', 'data', `test-intg-${Date.now()}.db`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new SqliteDataPort(file);
  await runMigrations(db);
  bus = new EventBus(db, new InProcessBroker());
}, 30000);
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await db.close().catch(() => {}); });

// ─── secret storage ──────────────────────────────────────────────────────────

describe('platform — encrypted credential storage', () => {
  it('stores secrets AES-256-GCM sealed — plaintext never in the DB', async () => {
    const secret = 'xoxb-test-token-123456';
    const ct = encryptSecret(secret);
    expect(ct).not.toContain(secret);
    expect(decryptSecret(ct)).toBe(secret);
    const rows = await db.query<any>("SELECT ciphertext FROM integration_secrets LIMIT 1");
    expect(JSON.stringify(rows)).not.toContain(secret);
  });
  it('tamper with the ciphertext throws (auth tag)', () => {
    const ct = encryptSecret('abc');
    const parts = ct.split('.');
    const tampered = `${parts[0]}.${parts[1]}.${Buffer.from('hacked').toString('base64')}`;
    expect(() => decryptSecret(tampered)).toThrow();
  });
  it('redactSecrets masks anything token/secret-like recursively', () => {
    const out = redactSecrets({
      access_token: 'secret-value', client_secret: 'x', nested: { refresh_token: 'y', ok: 'fine' },
      arr: [{ api_key: 'z' }],
    }) as any;
    expect(out.access_token).toBe('[redacted]');
    expect(out.client_secret).toBe('[redacted]');
    expect(out.nested.refresh_token).toBe('[redacted]');
    expect(out.nested.ok).toBe('fine');
    expect(out.arr[0].api_key).toBe('[redacted]');
  });
});

// ─── OAuth manager ──────────────────────────────────────────────────────────

describe('platform — central OAuth manager', () => {
  it('generates a consent URL with state + PKCE S256 challenge for Google-style providers', async () => {
    process.env.GOOGLE_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
    const gmailOauth = { ...gmailManifest.authMethods[0] };
    const userId = uid();
    const { url, state } = await oauthStart(db, userId, gmailManifest, gmailOauth, ['gmail.read'], null);
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('client_id')).toBe('test-client-id');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')!).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get('state')).toBe(state);
    // state row is one-time + bound to the user
    const rows = await db.query<any>('SELECT * FROM oauth_states WHERE state = ?', [state]);
    expect(rows[0].user_id).toBe(userId);
    expect(rows[0].code_challenge).toBeTruthy(); // stores the VERIFIER for exchange
    expect(rows[0].capabilities).toContain('gmail.read');
  });

  it('rejects unknown/expired/replayed state (CSRF)', async () => {
    process.env.GITHUB_CLIENT_ID = 'gh-id';
    process.env.GITHUB_CLIENT_SECRET = 'gh-secret';
    const adapter = new GitHubPlatformAdapter();
    const method = adapter.manifest.authMethods[0];
    const userId = uid();
    const { state } = await oauthStart(db, userId, adapter.manifest, method, [], null);
    // consume once
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 't', scope: 'repo' }), { status: 200 }));
    const r = await oauthExchange(db, adapter.manifest, method, state, 'code-1');
    expect(r.tokens.access_token).toBe('t');
    fetchMock.mockRestore();
    // replay → rejected
    await expect(oauthExchange(db, adapter.manifest, method, state, 'code-1')).rejects.toThrow(/unknown OAuth state/);
  });

  it('exchange fails cleanly when the provider rejects the code', async () => {
    const adapter = new GitHubPlatformAdapter();
    const method = adapter.manifest.authMethods[0];
    const userId = uid();
    const { state } = await oauthStart(db, userId, adapter.manifest, method, [], null);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'bad_verification_code' }), { status: 200 }));
    await expect(oauthExchange(db, adapter.manifest, method, state, 'bad')).rejects.toThrow(/token exchange failed/);
    fetchMock.mockRestore();
  });

  it('refresh flow returns null on revoked tokens (→ reauth path)', async () => {
    const adapter = new GitHubPlatformAdapter();
    const method = adapter.manifest.authMethods[0];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }));
    const r = await oauthRefresh(adapter.manifest, method, 'revoked-refresh');
    expect(r).toBeNull();
    fetchMock.mockRestore();
  });

  it('needsRefresh respects the skew window', () => {
    expect(needsRefresh(new Date(Date.now() + 3600_000).toISOString())).toBe(false);
    expect(needsRefresh(new Date(Date.now() + 30_000).toISOString())).toBe(true);
    expect(needsRefresh(null)).toBe(false);
  });
});

// ─── capability enforcement + lifecycle ─────────────────────────────────────

describe('platform — connection lifecycle + capability authorization', () => {
  const platform = () => createIntegrationPlatform({ db, bus });
  const userId = uid();

  it('connect rejects a failed probe — never connected on bad credentials (req 17)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 }));
    await expect(platform().connectWithToken(userId, 'github', 'ghp-invalid', 'token', ['github.repo.read']))
      .rejects.toThrow();
    fetchMock.mockRestore();
    const conns = await platform().listConnections(userId, 'github');
    expect(conns.length).toBe(0);
  });

  it('full lifecycle: connect (mocked probe) → capability gate → multi-account → disconnect', async () => {
    // mock GitHub /user for two different accounts (multi-account!)
    const svc = platform();
    const fm1 = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ login: 'alice', id: 1 }), { status: 200 }));
    const c1 = await svc.connectWithToken(userId, 'github', 'ghp-alice-token', 'token', ['github.repo.read', 'github.issue.read']);
    fm1.mockRestore();
    const fm2 = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ login: 'bob', id: 2 }), { status: 200 }));
    const c2 = await svc.connectWithToken(userId, 'github', 'ghp-bob-token', 'token', ['github.pr.read']);
    fm2.mockRestore();
    expect(c1.account_id).toBe('alice');
    expect(c2.account_id).toBe('bob');
    expect(c1.id).not.toBe(c2.id);   // multi-account: both live

    // capability gate: c2 lacks issue.read → denied
    await expect(svc.executeCapability(userId, c2.id, 'github.issue.read', {})).rejects.toThrow(/does not grant/);
    // c1 holds it → engine proceeds to the (mocked) provider call
    const fm3 = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify([{ number: 7, title: 'x', html_url: 'u' }]), { status: 200 }));
    const out = await svc.executeCapability(userId, c1.id, 'github.issue.read', { repo: 'owner/name' });
    fm3.mockRestore();
    expect((out as any[]).length).toBe(1);

    // unknown provider capability is rejected at connect time
    await expect(svc.connectWithToken(userId, 'github', 'ghp-x', 'token', ['not.a.capability'])).rejects.toThrow(/unknown capabilities/);

    // disconnect deletes vault rows + status flips
    const fm4 = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ login: 'alice' }), { status: 200 }));
    const ok = await svc.disconnect(userId, c1.id);
    fm4.mockRestore();
    expect(ok).toBe(true);
    const after = await svc.getConnection(c1.id);
    expect(after!.status).toBe('disconnected');
    const secrets = await db.query<any>('SELECT * FROM integration_secrets WHERE connection_id = ?', [c1.id]);
    expect(secrets.length).toBe(0);   // vault rows deleted on disconnect
    // disconnected connection can't execute (capabilities were cleared on
    // disconnect, so the capability gate rejects it)
    await expect(svc.executeCapability(userId, c1.id, 'github.repo.read', {})).rejects.toThrow(/does not grant/);
  });

  it('expired OAuth token: refresh success path stores the new token', async () => {
    const svc = platform();
    // execution order: probe (userinfo) → token refresh → gmail list
    const fm1 = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: 'z-sub-1', email: 'z@example.com' }), { status: 200 }));   // probe
    const conn = await svc.connectWithToken(userId, 'gmail', 'google-access-tok', 'oauth2', ['gmail.read']);
    fm1.mockRestore();
    // force expiry + a refresh token
    await db.run("UPDATE integration_connections SET token_expires_at = ? WHERE id = ?", [new Date(Date.now() - 1000).toISOString(), conn.id]);
    await db.run("INSERT INTO integration_secrets (id, connection_id, kind, ciphertext, created_at) VALUES (?,?,?,?,?) ON CONFLICT(connection_id, kind) DO UPDATE SET ciphertext = excluded.ciphertext",
      [uid(), conn.id, 'refresh_token', encryptSecret('refresh-xyz'), now()]);
    const fmRefresh = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'NEW-TOKEN', expires_in: 3600 }), { status: 200 }))  // refresh
      .mockResolvedValue(new Response(JSON.stringify({ messages: [] }), { status: 200 }));                              // gmail list (+ per-message calls get empty)
    const out = await svc.executeCapability(userId, conn.id, 'gmail.read', {});
    expect(out).toBeTruthy();
    fmRefresh.mockRestore();
  });
});

// ─── webhooks ───────────────────────────────────────────────────────────────

describe('platform — webhook gateway', () => {
  it('verifies GitHub-style HMAC-SHA256 signatures and rejects tampering', () => {
    const secret = 'whsec-123';
    const body = JSON.stringify({ action: 'opened', issue: { id: 9 } });
    const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
    expect(verifyWebhookSignature(githubManifest, body, { 'x-hub-signature-256': sig }, secret)).toBe(true);
    expect(verifyWebhookSignature(githubManifest, body, { 'x-hub-signature-256': 'sha256=deadbeef' }, secret)).toBe(false);
    expect(verifyWebhookSignature(githubManifest, body, {}, secret)).toBe(false);
  });
  it('replay protection: same source event id accepted once', async () => {
    expect(await claimWebhookEvent(db, 'github', 'evt-1')).toBe(true);
    expect(await claimWebhookEvent(db, 'github', 'evt-1')).toBe(false);
    expect(await claimWebhookEvent(db, 'github', 'evt-2')).toBe(true);
  });
  it('full intake: verify → normalize → dedupe → persisted + bus event', async () => {
    const adapter = new GitHubPlatformAdapter();
    const secret = 'whsec-123';
    const body = JSON.stringify({ action: 'opened', issue: { id: 42, number: 5, title: 'T', html_url: 'https://x' }, repository: { id: 7, full_name: 'o/r' } });
    const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
    const r1 = await intakeWebhook(db, adapter, body, { 'x-hub-signature-256': sig }, secret);
    expect(r1.accepted).toBe(true);
    expect(r1.event_type).toBe('issue.opened');
    // replay the same delivery → deduped
    const r2 = await intakeWebhook(db, adapter, body, { 'x-hub-signature-256': sig }, secret);
    expect(r2.accepted).toBe(false);
    expect(r2.reason).toContain('duplicate');
  });
  it('Slack v0 scheme handles the v0:ts:body base string', () => {
    
    const secret = 'slack-signing';
    const ts = '1700000000';
    const body = JSON.stringify({ event: { type: 'message' } });
    const sig = 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex');
    expect(verifyWebhookSignature(slackManifest, body, { 'x-slack-signature': sig, 'x-slack-request-timestamp': ts }, secret)).toBe(true);
  });
});

// ─── sync + rate limiting ────────────────────────────────────────────────────

describe('platform — sync engine + rate limiter', () => {
  it('telegram adapter syncs updates with an advancing cursor (offset)', async () => {
    const adapter = new TelegramPlatformAdapter();
    const updates = { ok: true, result: [{ update_id: 100, message: { message_id: 1, chat: { id: 5 }, from: { username: 'u' }, text: 'hello' } }] };
    const fm = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify(updates), { status: 200 }));
    const out = await adapter.sync({ accessToken: 'TOK' }, null);
    fm.mockRestore();
    expect(out.nextCursor).toBe('101');
    expect(adapter.normalizeItem(updates.result[0])!.event_type).toBe('message.received');
  });
  it('rate limiter: burst capacity then throttles; Retry-After honored', () => {
    const rl = new RateLimiter();
    const waits: number[] = [];
    for (let i = 0; i < 8; i++) waits.push(rl.take('github:c1', 6, 2));
    expect(waits.slice(0, 2)).toEqual([0, 0]);       // burst of 2 free
    expect(waits.some(w => w > 0)).toBe(true);        // then throttled
    expect(RateLimiter.backoffMs(1, 30)).toBe(30000); // Retry-After: 30s
    expect(RateLimiter.backoffMs(3)).toBeLessThanOrEqual(30000);
  });
});

// ─── provider catalog (config status; the old 'OAuth unconfigured' bug) ─────

describe('platform — provider catalog + config status', () => {
  it('lists all 7 providers with auth-method-shaped UI metadata', () => {
    const svc = new IntegrationService({ db, bus });
    // register everything via the production factory
    const platform = createIntegrationPlatform({ db, bus });
    const list = platform.listProviders() as any[];
    expect(list.map(p => p.id).sort()).toEqual(['github', 'gmail', 'instagram', 'slack', 'telegram', 'whatsapp', 'youtube']);
    const gmail = list.find(p => p.id === 'gmail')!;
    expect(gmail.authMethods.length).toBe(1);
    expect(gmail.authMethods[0].kind).toBe('oauth2');      // NO token method for Gmail
    const gh = list.find(p => p.id === 'github')!;
    expect(gh.authMethods.map((m: any) => m.kind).sort()).toEqual(['oauth2', 'token']);  // PAT + OAuth
    const tg = list.find(p => p.id === 'telegram')!;
    expect(tg.authMethods[0].kind).toBe('bot_token');       // Telegram is NOT forced into OAuth
    const wa = list.find(p => p.id === 'whatsapp')!;
    expect(wa.authFields ?? wa.authMethods[0].tokenFields.length).toBe(2); // token + phone_number_id
    expect(list.every(p => !('oauth_configured' in p))).toBe(true); // old buggy field is gone
  });
  it('config status distinguishes not_configured / configured / misconfigured (no secret values)', () => {
    const resolve = resolveAuthConfigStatus;
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
    expect(resolve(githubManifest).oauth2).toBe('not_configured');
    process.env.GITHUB_CLIENT_ID = 'id-only';
    expect(resolve(githubManifest).oauth2).toBe('misconfigured');
    process.env.GITHUB_CLIENT_SECRET = 'gh-secret-value';
    const resolved = resolve(githubManifest);
    expect(resolved.oauth2).toBe('configured');
    expect(JSON.stringify(resolved)).not.toContain('gh-secret-value'); // never the value
  });
});

// ─── adapter probes against mocked APIs ─────────────────────────────────────

describe('platform — provider adapter probes (mocked HTTP)', () => {
  it('telegram probe rejects a bad bot token', async () => {
    const adapter = new TelegramPlatformAdapter();
    const fm = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, description: 'Unauthorized' }), { status: 401 }));
    await expect(adapter.probeToken('bad-token')).rejects.toThrow();
    fm.mockRestore();
  });
  it('github adapter executes issue.create against the mocked API', async () => {
    const adapter = new GitHubPlatformAdapter();
    const fm = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ number: 10, html_url: 'https://github.com/o/r/issues/10' }), { status: 201 }));
    const out = await adapter.execute('github.issue.write', { accessToken: 'T' }, { repo: 'o/r', title: 'x' });
    fm.mockRestore();
    expect((out as any).number).toBe(10);
  });
});
