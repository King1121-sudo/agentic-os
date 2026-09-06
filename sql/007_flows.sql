-- Phase 7 — Flows: visual flow graphs, versioned definitions, long-running executions.

-- ── flows: the current (draft) graph definition ─────────────────────────────
CREATE TABLE IF NOT EXISTS flows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  nodes TEXT NOT NULL,               -- json array (FlowNode[])
  edges TEXT NOT NULL,               -- json array (FlowEdge[])
  version TEXT NOT NULL DEFAULT '0.1.0',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ── flow_versions: immutable snapshots of every published graph ─────────────
CREATE TABLE IF NOT EXISTS flow_versions (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL,
  version TEXT NOT NULL,
  nodes TEXT NOT NULL,
  edges TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (flow_id, version)
);

-- ── flow_runs: long-running executions with checkpoint state ────────────────
CREATE TABLE IF NOT EXISTS flow_runs (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL,
  flow_version TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',   -- running|paused|waiting|completed|failed|cancelled|interrupted
  input TEXT NOT NULL,                      -- json
  context TEXT NOT NULL,                    -- json: live variable store
  current_node TEXT,                        -- checkpoint: node id being executed or next
  completed_nodes TEXT NOT NULL,             -- json array of node ids
  trace TEXT NOT NULL,                      -- json array of trace entries
  result TEXT,                               -- json
  error TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_flow_runs_flow ON flow_runs(flow_id, started_at);
CREATE INDEX IF NOT EXISTS idx_flow_runs_status ON flow_runs(status);
