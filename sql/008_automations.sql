-- Phase 8 — Automations: trigger definitions, dispatch run log, webhook dedup.

-- ── automations: a trigger (cron/event/webhook) bound to an action (flow/agent) ──
CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  trigger TEXT NOT NULL,             -- cron | event | webhook
  trigger_config TEXT NOT NULL,      -- json
  action TEXT NOT NULL,              -- flow | agent
  action_config TEXT NOT NULL,       -- json
  autonomy_level INTEGER NOT NULL DEFAULT 2,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_fired_at TEXT,
  last_run_id TEXT,
  run_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_automations_enabled ON automations(enabled);

-- ── automation_runs: dispatch log (every fire, incl. skipped/failed) ────────
CREATE TABLE IF NOT EXISTS automation_runs (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,              -- dispatched | skipped | failed
  reason TEXT NOT NULL DEFAULT '',
  target_id TEXT,                    -- flow run id or agent execution id
  fired_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_automation_runs ON automation_runs(automation_id, fired_at);
