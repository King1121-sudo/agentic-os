-- Phase 5 — Memory: working-memory windows, entity↔memory links, vector index support.
-- Dialect-neutral (runs on both SQLite and Postgres): only TEXT/INTEGER/REAL columns.

-- ── working-memory context windows (one per execution) ─────────────────────
CREATE TABLE IF NOT EXISTS working_memory (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  pinned_memory_ids TEXT NOT NULL,   -- json array of memory ids
  facts TEXT NOT NULL,               -- json array of {ts, step, source, text}
  token_estimate INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_wm_exec ON working_memory(execution_id);
CREATE INDEX IF NOT EXISTS idx_wm_agent ON working_memory(agent_id);

-- ── entity ↔ memory links (extracted entities, many-to-many) ────────────────
CREATE TABLE IF NOT EXISTS memory_entities (
  memory_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,           -- entities.id ("person:Name" etc.)
  created_at TEXT NOT NULL,
  PRIMARY KEY (memory_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_mentity_entity ON memory_entities(entity_id);
