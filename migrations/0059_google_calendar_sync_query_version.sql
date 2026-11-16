-- Additive query provenance; legacy tokens stay intact until a validated full walk.
-- Keep this column on code rollback. NULL means the token's query shape is unknown.
ALTER TABLE google_calendar_channels ADD COLUMN sync_query_version INTEGER
  CHECK (sync_query_version IS NULL OR (typeof(sync_query_version) = 'integer' AND sync_query_version > 0));
