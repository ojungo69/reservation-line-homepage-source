-- Migration 0016: Extend google_calendar_conflicts.resolution_status CHECK constraint
-- to include 'approved_as_closure' (all-day → closure approval flow) and 'rejected'
-- (owner/system_admin rejects the all-day candidate).
--
-- SQLite does not support ALTER TABLE ... DROP/ADD CONSTRAINT, so we must recreate
-- the table with the extended CHECK. We preserve all existing data and indexes.
--
-- NOTE: This migration was originally applied without BEGIN/COMMIT wrappers and
-- D1's wrangler runner rejects explicit transaction statements (code 7500). Do
-- NOT add an explicit transaction wrapper — the migration runner already provides
-- per-statement-batch atomicity.

-- 1. Create the replacement table with the extended CHECK.
CREATE TABLE google_calendar_conflicts_new (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  calendar_id TEXT NOT NULL CHECK (length(calendar_id) <= 320),
  google_event_id TEXT NOT NULL CHECK (length(google_event_id) <= 1024),
  reservation_id TEXT REFERENCES reservations(id) ON DELETE SET NULL,
  external_block_id TEXT REFERENCES external_blocks(id) ON DELETE SET NULL,
  conflict_type TEXT NOT NULL,
  google_safe_snapshot_json TEXT NOT NULL,
  d1_safe_snapshot_json TEXT,
  resolution_status TEXT NOT NULL CHECK (
    resolution_status IN (
      'open',
      'auto_reverted',
      'accepted',
      'ignored',
      'manual_resolved',
      'approved_as_closure',
      'rejected'
    )
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  resolved_by TEXT
);

-- 2. Copy existing data.
INSERT INTO google_calendar_conflicts_new (
  id, store_id, calendar_id, google_event_id, reservation_id,
  external_block_id, conflict_type, google_safe_snapshot_json,
  d1_safe_snapshot_json, resolution_status, created_at, resolved_at, resolved_by
)
SELECT
  id, store_id, calendar_id, google_event_id, reservation_id,
  external_block_id, conflict_type, google_safe_snapshot_json,
  d1_safe_snapshot_json, resolution_status, created_at, resolved_at, resolved_by
FROM google_calendar_conflicts;

-- 3. Drop old table and rename.
DROP TABLE google_calendar_conflicts;
ALTER TABLE google_calendar_conflicts_new RENAME TO google_calendar_conflicts;

-- 4. Recreate the index.
CREATE INDEX IF NOT EXISTS idx_google_conflicts_resolution
  ON google_calendar_conflicts(resolution_status, created_at);
