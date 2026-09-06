-- Phase 5a — entity-backfill scan marker: memories with zero extracted
-- entities have no memory_entities rows, so backfill needs an explicit
-- "already scanned" marker to stay idempotent across boots.
CREATE TABLE IF NOT EXISTS memory_entity_scan (
  memory_id TEXT PRIMARY KEY,
  processed_at TEXT NOT NULL
);
