-- Phase 4: skill versioning + execution history.
CREATE TABLE IF NOT EXISTS skill_versions (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  version TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  parent_id TEXT,
  instructions TEXT,
  steps TEXT NOT NULL,             -- json array
  required_tools TEXT NOT NULL,   -- json array
  required_permissions TEXT NOT NULL, -- json array
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skill_versions_skill ON skill_versions(skill_id, created_at);

CREATE TABLE IF NOT EXISTS skill_executions (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  skill_version TEXT NOT NULL,
  execution_id TEXT,
  agent_id TEXT,
  status TEXT NOT NULL,            -- completed | failed | denied
  error TEXT,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skill_exec_skill ON skill_executions(skill_id, created_at);
