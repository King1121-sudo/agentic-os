-- 011 — Integration Platform (multi-account, webhooks, sync, PKCE)
-- Provider-agnostic connection model. The Phase-9 `integrations` table
-- (UNIQUE per user+adapter) is preserved; this table replaces it as the
-- canonical store, allowing MULTIPLE connections per provider per user.

CREATE TABLE IF NOT EXISTS integration_connections (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,               -- 'github' | 'gmail' | 'youtube' | 'slack' | 'whatsapp' | 'telegram' | 'instagram' | ...
  user_id TEXT NOT NULL,
  label TEXT,                            -- user-assigned display name
  account_id TEXT NOT NULL,             -- provider account handle (login / email / team / phone)
  identity_key TEXT,                     -- shared-identity grouping, e.g. 'google:alice@gmail.com'
  status TEXT NOT NULL DEFAULT 'connected',  -- connected | disconnected | reauth_required | error
  auth_method TEXT NOT NULL,             -- oauth2 | token | bot_token
  capabilities TEXT NOT NULL,            -- granted platform capability ids (json array)
  scopes TEXT NOT NULL,                 -- raw provider scopes granted (json array)
  token_expires_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  last_error_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_iconn_user ON integration_connections(user_id);
CREATE INDEX IF NOT EXISTS idx_iconn_provider_user ON integration_connections(provider, user_id);
CREATE INDEX IF NOT EXISTS idx_iconn_identity ON integration_connections(identity_key);

-- Provider webhook registrations (verification secrets; the secret itself must
-- be available in plaintext for HMAC verification — stored here, never exposed
-- via any API surface).
CREATE TABLE IF NOT EXISTS integration_webhooks (
  id TEXT PRIMARY KEY,
  connection_id TEXT,
  provider TEXT NOT NULL,
  secret TEXT NOT NULL,
  external_id TEXT,
  created_at TEXT NOT NULL
);

-- Webhook replay protection: every accepted delivery's source event id.
CREATE TABLE IF NOT EXISTS integration_webhook_dedup (
  source_event_id TEXT PRIMARY KEY,     -- provider's own event id (or content hash)
  provider TEXT NOT NULL,
  received_at TEXT NOT NULL
);

-- Sync engine cursors (Phase 11): incremental polling per connection.
CREATE TABLE IF NOT EXISTS integration_sync_state (
  connection_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  cursor TEXT,
  last_sync_at TEXT NOT NULL,
  last_status TEXT,
  PRIMARY KEY (connection_id, provider)
);

-- OAuth states gain PKCE + granted-capability columns (the migration runner
-- applies each file exactly once, so plain ALTER TABLE is safe here).
ALTER TABLE oauth_states ADD COLUMN code_challenge TEXT;
ALTER TABLE oauth_states ADD COLUMN capabilities TEXT;

-- Backfill: carry any live Phase-9 connections forward (idempotent via PK).
INSERT OR IGNORE INTO integration_connections
  (id, provider, user_id, label, account_id, identity_key, status, auth_method, capabilities, scopes, created_at, updated_at)
SELECT
  'mig-' || id, integration_id, user_id, NULL, account, NULL, status, 'token', capabilities, scopes, connected_at, updated_at
FROM integrations WHERE status = 'connected';
