-- Migration 0017: Extend google_calendar_conflicts.resolution_status CHECK
-- to include 'approved_as_cancel' (Google delete → reservation cancel approval).
--
-- SQLite does not support ALTER TABLE ... DROP/ADD CONSTRAINT, so we recreate
-- the table with the extended CHECK. Preserves all existing data and indexes
-- (mirrors 0016 pattern).
--
-- NOTE: Do not wrap in an explicit transaction wrapper. Cloudflare D1 wrangler
-- runner rejects explicit transaction statements with code 7500 (the migration
-- runner already handles atomicity per-statement-batch). The earlier plan
-- review accepted BEGIN/COMMIT based on a misread of D1 semantics; the live
-- migration apply failed on both staging + production until this hotfix.

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
      'rejected',
      'approved_as_cancel'
    )
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  resolved_by TEXT
);

INSERT INTO google_calendar_conflicts_new SELECT * FROM google_calendar_conflicts;
DROP TABLE google_calendar_conflicts;
ALTER TABLE google_calendar_conflicts_new RENAME TO google_calendar_conflicts;

CREATE INDEX IF NOT EXISTS idx_google_conflicts_resolution
  ON google_calendar_conflicts(resolution_status, created_at);
