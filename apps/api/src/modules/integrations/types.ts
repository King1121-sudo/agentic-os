/**
 * Integration Platform — universal model (Phases 2/18).
 *
 * Everything a provider contributes is DATA (a manifest); the engine is
 * generic. Adding a provider = one adapter file + env config + registration.
 * The core never imports provider specifics.
 */

// ─── capabilities ───────────────────────────────────────────────────────────

export type CapabilityAction = 'read' | 'write' | 'send' | 'create' | 'update' | 'delete' | 'search' | 'listen' | 'webhook' | 'sync';

export interface CapabilityDef {
  id: string;                       // e.g. 'gmail.send'
  action: CapabilityAction;
  label: string;                    // UI: "Send Gmail"
  description?: string;
  scopes: string[];                 // provider scopes this capability maps to
  required?: boolean;               // requested by default on connect
}

// ─── auth methods ───────────────────────────────────────────────────────────

export type AuthMethodKind = 'oauth2' | 'token' | 'bot_token' | 'webhook_verify';

export interface AuthMethod {
  kind: AuthMethodKind;
  label: string;                    // UI: "Google OAuth" / "Bot Token"
  /** token inputs the user supplies (none for pure oauth2) */
  tokenFields?: { name: string; label: string; placeholder?: string }[];
  /** oauth2 config resolution is centralized in the OAuthManager; adapters
   *  only declare provider endpoints + env names + scopes. */
  oauth?: {
    authorizeUrl: string;
    tokenUrl: string;
    clientIdEnv: string;
    clientSecretEnv: string;
    /** static scope string — used unless scopeFromCapabilities is set */
    scopeParam: string;
    /** PKCE (S256) — required by modern providers, safe for all that accept it */
    pkce?: boolean;
    /** extra query params on the authorize URL (e.g. access_type=offline) */
    authorizeParams?: Record<string, string>;
    /** providers whose OAuth identity is shared across services (Google):
     *  a family of providers authenticates once; scopes merge incrementally. */
    sharedIdentity?: string;        // 'google' | 'meta' | 'microsoft' | ...
    /** override the callback path (default /api/integrations/<provider>/oauth/callback).
     *  Shared-identity families point at ONE family callback so a single
     *  redirect URI covers every service in the family. */
    redirectPath?: string;
    /** compute the requested scope string from the capabilities the user
     *  selected (least privilege per §4) instead of the static scopeParam */
    scopeFromCapabilities?: boolean;
  };
}

// ─── provider manifest ──────────────────────────────────────────────────────

export type ProviderCategory = 'communication' | 'development' | 'social' | 'media' | 'productivity';

export interface ProviderManifest {
  id: string;                       // 'github' | 'gmail' | ...
  name: string;
  icon: string;
  color: string;
  category: ProviderCategory;
  blurb: string;
  authMethods: AuthMethod[];        // ORDERED — first is the primary in the UI
  capabilities: CapabilityDef[];
  /** provider API constraints surfaced to the UI/docs (requirement 19) */
  apiNotes?: string[];
  /** default capability ids requested at connect (usually the required ones) */
  defaultCapabilities?: string[];
  /** webhook verification this provider supports (signature header, scheme) */
  webhook?: {
    signatureHeader: string;        // 'x-hub-signature-256' | 'x-slack-signature' | ...
    scheme: 'hmac-sha256' | 'hmac-sha256-v0' | 'secret-query';
    /** where the provider's webhook secret comes from */
    secret: 'per-connection' | 'env';
    secretEnv?: string;             // for env-sourced (e.g. SLACK_SIGNING_SECRET)
  };
  /** polling/sync support */
  sync?: {
    defaultIntervalS: number;       // engine clamps: >= 60s
  };
  /** conservative per-connection request budget (engine-enforced) */
  rateLimit: { maxPerMinute: number; burst?: number };
}

// ─── connections / secrets ──────────────────────────────────────────────────

export type ConnectionStatus =
  | 'connected' | 'disconnected' | 'reauth_required' | 'error';

export interface StoredSecret {
  encrypted_access_token?: string;
  encrypted_refresh_token?: string;
  token_type?: string;
  expires_at?: string | null;
  scope?: string | null;
}

export interface IntegrationConnection {
  id: string;
  provider: string;
  user_id: string;
  label: string | null;
  account_id: string;
  identity_key: string | null;
  status: ConnectionStatus;
  auth_method: AuthMethodKind;
  capabilities: string[];
  scopes: string[];
  token_expires_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Configuration status of a provider's app credentials (NEVER includes values). */
export type ProviderConfigStatus = 'configured' | 'not_configured' | 'misconfigured';

// ─── normalized events (Phase 18) ────────────────────────────────────────────

export interface NormalizedEvent {
  id: string;
  provider: string;
  connection_id: string | null;
  event_type: string;                // 'message.received' | 'issue.created' | ...
  actor: string | null;
  timestamp: string;
  resource: { type: string; id: string | null; url?: string } | null;
  payload: Record<string, unknown>;  // provider payload kept, normalized core
  capabilities_required: string[];
  source_event_id: string | null;
  metadata: Record<string, unknown>;
}

// ─── adapter contract (Phase 7) ──────────────────────────────────────────────

/** Credentials resolved by the engine before an adapter call. */
export interface AdapterCredentials {
  accessToken: string;
  refresh?: (userId: string) => Promise<string | null>;
}

export interface ProviderAdapter {
  manifest: ProviderManifest;
  /** Verify raw credentials → account + granted provider scopes. Must throw on
   *  invalid credentials — the engine never marks a connection connected on a
   *  failed probe (requirement 17). */
  probeToken(token: string): Promise<{ account: string; scopes: string[]; identityKey?: string | null; expiresAt?: string | null }>;
  /** Execute a capability. `cred` is a live credential object (auto-refreshing
   *  for OAuth). Throw on provider errors — engine handles retry/audit. */
  execute(capabilityId: string, cred: AdapterCredentials, args: Record<string, unknown>): Promise<unknown>;
  /** Health check — used by the engine's health sweep. */
  healthCheck?(cred: AdapterCredentials): Promise<{ ok: boolean; detail?: string }>;
  /** Post-connect API verification (least-surprise: a connection is CONNECTED
   *  only when the granted scopes actually reach the provider API). Returns a
   *  standard error code (API_NOT_ENABLED, INVALID_SCOPE, …) on failure —
   *  never a raw provider secret. */
  verifyConnection?(cred: AdapterCredentials): Promise<{ ok: true } | { ok: false; code: string; detail: string }>;
  /** Incremental sync (polling providers). Returns new raw items + next cursor. */
  sync?(cred: AdapterCredentials, cursor: string | null): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }>;
  /** Map a raw provider item (sync/webhook) to a normalized event. */
  normalizeItem?(item: Record<string, unknown>): { event_type: string; payload: Record<string, unknown>; actor?: string; resource?: { type: string; id: string | null; url?: string } } | null;
  /** Normalize a verified webhook body. */
  normalizeWebhook?(body: Record<string, unknown>, headers: Record<string, string>): { event_type: string; payload: Record<string, unknown>; source_event_id?: string } | null;
}

// ─── provider config resolution (Phase 4) ────────────────────────────────────

/** Resolve a provider's configuration status from env — no values leave the API. */
export function resolveAuthConfigStatus(manifest: ProviderManifest): Record<AuthMethodKind, ProviderConfigStatus> {
  const out = {} as Record<AuthMethodKind, ProviderConfigStatus>;
  for (const m of manifest.authMethods) {
    if (m.kind === 'oauth2') {
      const id = m.oauth?.clientIdEnv ? process.env[m.oauth.clientIdEnv] : undefined;
      const secret = m.oauth?.clientSecretEnv ? process.env[m.oauth.clientSecretEnv] : undefined;
      out[m.kind] = !id && !secret ? 'not_configured' : id && secret ? 'configured' : 'misconfigured';
    } else {
      // token/bot methods are configured BY THE USER at connect time
      out[m.kind] = 'configured';
    }
  }
  return out;
}
