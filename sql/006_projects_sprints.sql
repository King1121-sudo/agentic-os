-- Phase 6 — Projects/Sprints: milestones, dependency dedup, deadline tracking.

-- ── milestones: dated checkpoints within a project ─────────────────────────
CREATE TABLE IF NOT EXISTS milestones (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'open',      -- open | reached | missed
  reached_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_milestones_project ON milestones(project_id);

-- ── deadline automation ledger: dedup so overdue/due-soon fires once per task ──
CREATE TABLE IF NOT EXISTS deadline_alerts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,                       -- overdue | due_soon | missed
  alerted_at TEXT NOT NULL,
  UNIQUE (task_id, kind)
);
