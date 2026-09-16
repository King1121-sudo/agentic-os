/**
 * Central OAuth Manager (Phase 3) — ONE implementation of the authorization-
 * code flow shared by every OAuth-capable provider. Adapters declare endpoints
 * + env names; all state/PKCE/exchange/refresh logic lives here.
 *
 * Supported: state generation + one-time validation (CSRF), PKCE S256 where
 * the provider manifest asks for it, token exchange, refresh-token storage,
 * expiry tracking, automatic refresh (engine consults before every call),
 * multi-account (state rows carry provider + user; connections are per
 * provider+account), shared identity (Google: one identity, many services).
 */
import * as crypto from 'crypto';
import { DataPort } from '../../infra/types';
import { iso } from '../../infra/types';
import { AuthMethod, ProviderManifest } from './types';

export interface OAuthFlowConfig {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopeParam: string;
  redirectBase: string;
  redirectPath: string;
  pkce: boolean;
  authorizeParams?: Record<string, string>;
}

/** The callback path for a provider: family-shared when the manifest declares
 *  one (Google: a single /api/integrations/google/oauth/callback covers Gmail,
 *  YouTube, and every future Google service), provider-specific otherwise. */
export function callbackPathFor(manifest: ProviderManifest): string {
  const method = manifest.authMethods.find(m => m.kind === 'oauth2');
  return method?.oauth?.redirectPath ?? `/api/integrations/${manifest.id}/oauth/callback`;
}

/** Resolve the flow config for a provider's oauth method; throws with a
 *  user-safe message when env is missing (never echoes secret values). */
export function resolveOAuthFlow(manifest: ProviderManifest, method: AuthMethod): OAuthFlowConfig {
  const o = method.oauth!;
  const clientId = process.env[o.clientIdEnv];
  const clientSecret = process.env[o.clientSecretEnv];
  if (!clientId || !clientSecret) {
    throw new Error(`${manifest.name} OAuth app not configured — set ${o.clientIdEnv} and ${o.clientSecretEnv}`);
  }
  const redirectBase = (process.env.AGENTIC_PUBLIC_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  return {
    authorizeUrl: o.authorizeUrl,
    tokenUrl: o.tokenUrl,
    clientId, clientSecret,
    scopeParam: o.scopeParam,
    redirectBase,
    redirectPath: callbackPathFor(manifest),
    pkce: !!o.pkce,
    authorizeParams: o.authorizeParams,
  };
}

/** Least-privilege scope string for the capabilities the user selected: the
 *  union of each capability's provider scopes (openid/email for identity). */
export function scopesForCapabilities(manifest: ProviderManifest, capabilityIds: string[]): string {
  const byId = new Map(manifest.capabilities.map(c => [c.id, c] as const));
  const scopes = new Set<string>();
  for (const id of capabilityIds) {
    const cap = byId.get(id);
    if (!cap) continue;
    for (const s of cap.scopes) scopes.add(s);
  }
  // identity scopes (shared Google login needs openid+email to resolve the account)
  scopes.add('openid');
  scopes.add('email');
  return [...scopes].join(' ');
}

export interface StartedFlow { url: string; state: string }

/** Step 1: persist a one-time state row (+ PKCE verifier) and build the consent URL.
 *  Scopes come from the REQUESTED CAPABILITIES (least privilege) unless the
 *  manifest opts into a static scope string. */
export async function oauthStart(
  db: DataPort, userId: string, manifest: ProviderManifest, method: AuthMethod,
  requestedCapabilities: string[], redirectTo: string | null,
): Promise<StartedFlow> {
  const flow = resolveOAuthFlow(manifest, method);
  const state = crypto.randomBytes(24).toString('base64url');
  const verifier = flow.pkce ? crypto.randomBytes(32).toString('base64url') : null;
  const challenge = verifier ? crypto.createHash('sha256').update(verifier).digest('base64url') : null;
  await db.run(
    `INSERT INTO oauth_states (state, integration_id, user_id, redirect_to, created_at, expires_at, code_challenge, capabilities)
     VALUES (?,?,?,?,?,?,?,?)`,
    [state, manifest.id, userId, redirectTo, iso(), new Date(Date.now() + 10 * 60_000).toISOString(),
     verifier, JSON.stringify(requestedCapabilities)]);
  const url = new URL(flow.authorizeUrl);
  url.searchParams.set('client_id', flow.clientId);
  url.searchParams.set('redirect_uri', `${flow.redirectBase}${flow.redirectPath}`);
  url.searchParams.set('response_type', 'code');   // REQUIRED by Google (GitHub tolerates its absence — this omission caused Google's 400 malformed-request)
  url.searchParams.set('state', state);
  const scopeStr = method.oauth?.scopeFromCapabilities
    ? scopesForCapabilities(manifest, requestedCapabilities)
    : flow.scopeParam;
  url.searchParams.set('scope', scopeStr);
  if (flow.pkce && challenge) {
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  for (const [k, v] of Object.entries(flow.authorizeParams ?? {})) url.searchParams.set(k, v);
  // Safe OAuth diagnostics (no secrets — never the client secret, tokens, or code):
  console.log(`[oauth] ${manifest.id}: client_id=${flow.clientId ? 'configured' : 'NOT configured'} redirect_uri=${flow.redirectBase}${flow.redirectPath} scopes=[${scopeStr.split(' ').join(', ')}] state=present pkce=${flow.pkce ? 'S256' : 'off'}`);
  return { url: url.toString(), state };
}

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_at: string | null;      // ISO
  scope: string[];
}

/** Exchange an authorization code (+ PKCE verifier when present). */
export async function oauthExchange(
  db: DataPort, manifest: ProviderManifest, method: AuthMethod, state: string, code: string,
): Promise<{ tokens: TokenSet; userId: string; requestedCapabilities: string[]; redirectTo: string | null }> {
  const rows = await db.query<any>('SELECT * FROM oauth_states WHERE state = ?', [state]);
  const st = rows[0];
  if (!st) throw new Error('unknown OAuth state (expired or already used)');
  if (st.user_id !== undefined && st.user_id === null) throw new Error('OAuth state has no user');
  if (st.expires_at < iso()) {
    await db.run('DELETE FROM oauth_states WHERE state = ?', [state]);
    throw new Error('OAuth state expired — restart the connection flow');
  }
  await db.run('DELETE FROM oauth_states WHERE state = ?', [state]); // one-time use
  const flow = resolveOAuthFlow(manifest, method);
  const body: Record<string, string> = {
    client_id: flow.clientId,
    client_secret: flow.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: `${flow.redirectBase}${flow.redirectPath}`,
  };
  if (st.code_challenge) body.code_verifier = st.code_challenge;
  const res = await fetch(flow.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json?.access_token) {
    throw new Error(`token exchange failed: ${String(json?.error_description ?? json?.error ?? res.status).slice(0, 160)}`);
  }
  const expiresInS = Number(json.expires_in ?? 0);
  const tokens: TokenSet = {
    access_token: String(json.access_token),
    refresh_token: json.refresh_token ? String(json.refresh_token) : undefined,
    expires_at: expiresInS > 0 ? new Date(Date.now() + expiresInS * 1000).toISOString() : null,
    scope: String(json.scope ?? flow.scopeParam).split(/[\s,]+/).filter(Boolean),
  };
  return {
    tokens,
    userId: st.user_id,
    requestedCapabilities: JSON.parse(st.capabilities ?? '[]'),
    redirectTo: st.redirect_to,
  };
}

/** Refresh an access token. Returns null when no refresh token is stored. */
export async function oauthRefresh(
  manifest: ProviderManifest, method: AuthMethod, refreshToken: string,
): Promise<TokenSet | null> {
  const flow = resolveOAuthFlow(manifest, method);
  if (!refreshToken) return null;
  const res = await fetch(flow.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: flow.clientId,
      client_secret: flow.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }).toString(),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json?.access_token) return null;   // revoked/expired → reauth
  const expiresInS = Number(json.expires_in ?? 0);
  return {
    access_token: String(json.access_token),
    refresh_token: json.refresh_token ? String(json.refresh_token) : refreshToken,
    expires_at: expiresInS > 0 ? new Date(Date.now() + expiresInS * 1000).toISOString() : null,
    scope: String(json.scope ?? '').split(/[\s,]+/).filter(Boolean),
  };
}

/** Does this connection's access token need a refresh (or is it already bad)? */
export function needsRefresh(expiresAt: string | null, skewMs = 60_000): boolean {
  if (!expiresAt) return false;
  return Date.now() + skewMs >= Date.parse(expiresAt);
}
