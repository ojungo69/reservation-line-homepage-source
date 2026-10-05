-- Step 4: Google Calendar event snapshot history.
-- Additive only. No drops, no alters. Read-only for outbound Google API.

CREATE TABLE IF NOT EXISTS google_calendar_event_history (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  calendar_id TEXT NOT NULL CHECK (length(calendar_id) <= 320),
  google_event_id TEXT NOT NULL CHECK (length(google_event_id) <= 1024),
  google_etag TEXT CHECK (google_etag IS NULL OR length(google_etag) <= 512),
  google_updated_at TEXT,
  source_type TEXT NOT NULL CHECK (source_type IN ('reservation', 'external_block', 'unknown')),
  status TEXT NOT NULL CHECK (status IN ('active', 'cancelled', 'deleted', 'conflict', 'ignored')),
  reason TEXT NOT NULL CHECK (reason IN ('upsert')),
  snapshot_json TEXT NOT NULL,
  captured_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_event_history_event
  ON google_calendar_event_history(calendar_id, google_event_id, captured_at);

CREATE INDEX IF NOT EXISTS idx_event_history_captured
  ON google_calendar_event_history(captured_at);

CREATE TABLE IF NOT EXISTS google_calendar_history_maintenance_runs (
  task_key TEXT NOT NULL,
  day_bucket TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  PRIMARY KEY (task_key, day_bucket)
);
