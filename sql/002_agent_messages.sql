-- Phase 3: agent-to-agent messaging.
CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  from_agent_id TEXT,
  to_agent_id TEXT NOT NULL,
  execution_id TEXT,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_msgs_to ON agent_messages(to_agent_id, status);
