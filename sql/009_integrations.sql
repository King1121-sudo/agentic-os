-- Phase 9 — Integrations: connections, received events, secret vault.

-- ── integrations: live connections (one per user + adapter) ─────────────────
CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL,        -- adapter id: 'github' | 'gmail' | 'slack'
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connected',  -- connected | disconnected
  account TEXT NOT NULL DEFAULT '',
  capabilities TEXT NOT NULL,           -- json array
  scopes TEXT NOT NULL,                 -- json array
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (integration_id, user_id)      -- one connection per user per adapter
);
CREATE INDEX IF NOT EXISTS idx_integrations_user ON integrations(user_id);

-- ── integration_events: external events received through adapters ───────────
CREATE TABLE IF NOT EXISTS integration_events (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL,        -- adapter id
  connection_id TEXT,                  -- integrations.id (nullable for anonymous polling)
  kind TEXT NOT NULL,                  -- 'email.received' | 'pr.opened' | ...
  payload TEXT NOT NULL,                -- json
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intevents_kind ON integration_events(kind, received_at);

-- ── integration_secrets: the vault — ciphertext only, never plaintext ───────
CREATE TABLE IF NOT EXISTS integration_secrets (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- 'token' | 'refresh_token' | 'client_secret'
  ciphertext TEXT NOT NULL,            -- AES-256-GCM: iv.tag.payload (base64)
  created_at TEXT NOT NULL,
  UNIQUE (connection_id, kind)
);

-- ── oauth_states: CSRF state for in-flight authorization-code flows ─────────
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  redirect_to TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
