-- Agentic OS Kernel v0.1 — portable schema (runs identically on SQLite and PostgreSQL).
-- Deliberately uses only TEXT/INTEGER/REAL, app-generated UUIDs, and ?-params:
-- the two DataPort adapters execute the exact same statements.
-- Everything JSON-shaped is stored as TEXT json (parsed at the repository layer).

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,              -- builtin | openai-compat | ollama
  base_url TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,             -- "<provider_id>:<model_id>"
  provider_id TEXT NOT NULL REFERENCES model_providers(id) ON DELETE CASCADE,
  family TEXT NOT NULL,
  display_name TEXT NOT NULL,
  capabilities TEXT NOT NULL,      -- json array
  context_limit INTEGER NOT NULL DEFAULT 8192,
  cost_in_per_mtok REAL NOT NULL DEFAULT 0,
  cost_out_per_mtok REAL NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 50,
  health TEXT NOT NULL DEFAULT 'unknown',
  latency_ms INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  system_instructions TEXT NOT NULL DEFAULT '',
  model_policy TEXT NOT NULL,     -- json
  skills TEXT NOT NULL,           -- json array
  tools TEXT NOT NULL,            -- json array
  memory_policy TEXT NOT NULL,    -- json
  permissions TEXT NOT NULL,      -- json
  autonomy_level INTEGER NOT NULL DEFAULT 2,
  status TEXT NOT NULL DEFAULT 'idle',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  parent_execution_id TEXT,
  user_id TEXT NOT NULL,
  input TEXT NOT NULL,
  project_id TEXT,
  task_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  plan TEXT,                       -- json
  observations TEXT NOT NULL,     -- json array
  trace TEXT NOT NULL,            -- json array
  result TEXT,
  error TEXT,
  current_step INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_exec_agent   ON executions(agent_id, started_at);
CREATE INDEX IF NOT EXISTS idx_exec_status  ON executions(status);

CREATE TABLE IF NOT EXISTS generations (
  id TEXT PRIMARY KEY,
  agent_id TEXT,
  execution_id TEXT,
  parent_generation_id TEXT,
  model_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  input TEXT NOT NULL,             -- json
  output TEXT,
  context TEXT NOT NULL,           -- json
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'started',
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_gen_exec ON generations(execution_id);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  summary TEXT NOT NULL,
  importance REAL NOT NULL DEFAULT 5,
  confidence REAL NOT NULL DEFAULT 0.8,
  source TEXT NOT NULL DEFAULT 'agent',
  source_id TEXT,
  project_id TEXT,
  entities TEXT NOT NULL,          -- json array
  keywords TEXT NOT NULL,          -- json array
  embedding TEXT,                  -- json array (local hash embedding; pgvector driver can replace)
  access_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_accessed TEXT NOT NULL,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_mem_user_type ON memories(user_id, type);
CREATE INDEX IF NOT EXISTS idx_mem_project  ON memories(project_id);

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,             -- "<kind>:<entity_id>"
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  subtitle TEXT NOT NULL DEFAULT '',
  meta TEXT NOT NULL,              -- json
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_ref ON entities(kind, entity_id);

CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY,
  from_type TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_type TEXT NOT NULL,
  to_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_type, from_id);
CREATE INDEX IF NOT EXISTS idx_links_to   ON links(to_type, to_id);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  deadline TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sprints (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  objective TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'planned',
  deadline TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  sprint_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo',
  priority TEXT NOT NULL DEFAULT 'medium',
  deadline TEXT,
  assignee_agent_id TEXT,
  labels TEXT NOT NULL,            -- json array
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status  ON tasks(status);

CREATE TABLE IF NOT EXISTS task_dependencies (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'general',
  parent_id TEXT,
  version TEXT NOT NULL DEFAULT '0.1.0',
  instructions TEXT NOT NULL DEFAULT '',
  steps TEXT NOT NULL,             -- json array
  required_tools TEXT NOT NULL,   -- json array
  required_permissions TEXT NOT NULL, -- json array
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_executions (
  id TEXT PRIMARY KEY,
  execution_id TEXT,
  agent_id TEXT,
  tool TEXT NOT NULL,
  args TEXT NOT NULL,              -- json
  result TEXT,                     -- json
  risk TEXT NOT NULL DEFAULT 'low',
  status TEXT NOT NULL DEFAULT 'ok',
  error TEXT,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_toolex_exec ON tool_executions(execution_id);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  target_type TEXT,
  target_id TEXT,
  data TEXT NOT NULL,              -- json
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_time ON events(created_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  execution_id TEXT,
  meta TEXT NOT NULL,               -- json
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_exec ON audit_logs(execution_id);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(ts);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args TEXT NOT NULL,               -- json
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, execution_id);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'medium',
  category TEXT NOT NULL DEFAULT 'system',
  source TEXT NOT NULL DEFAULT 'system',
  related_type TEXT,
  related_id TEXT,
  status TEXT NOT NULL DEFAULT 'unread',
  created_at TEXT NOT NULL,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, status);
