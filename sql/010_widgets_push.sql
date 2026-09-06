-- Phase 10 — Notifications + Widgets: dashboard layouts, push subscriptions, channel prefs.

-- ── dashboard_layouts: per-user widget grid (order = render order) ────────────
CREATE TABLE IF NOT EXISTS dashboard_layouts (
  user_id TEXT PRIMARY KEY,
  widgets TEXT NOT NULL,              -- json array of {id, kind, width}
  updated_at TEXT NOT NULL
);

-- ── push_subscriptions: browser Web Push endpoints (one row per browser) ───
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,      -- the browser push service URL
  keys TEXT NOT NULL,                  -- json {p256dh, auth}
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pushsubs_user ON push_subscriptions(user_id);

-- ── notification_prefs: per-user channel routing ─────────────────────────────
CREATE TABLE IF NOT EXISTS notification_prefs (
  user_id TEXT PRIMARY KEY,
  prefs TEXT NOT NULL,                 -- json NotificationPrefs
  updated_at TEXT NOT NULL
);
