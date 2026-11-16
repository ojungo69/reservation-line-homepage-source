-- Independent polling/availability progress shares one non-bypassable provider cooldown.
ALTER TABLE minimo_sync_state ADD COLUMN next_inbound_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';
ALTER TABLE minimo_sync_state ADD COLUMN next_outbound_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';
ALTER TABLE minimo_sync_state ADD COLUMN last_inbound_attempt_at TEXT;
ALTER TABLE minimo_sync_state ADD COLUMN last_inbound_success_at TEXT;
ALTER TABLE minimo_sync_state ADD COLUMN last_inbound_preview_at TEXT;
ALTER TABLE minimo_sync_state ADD COLUMN inbound_error TEXT;
ALTER TABLE minimo_sync_state ADD COLUMN next_inbound_id TEXT;
ALTER TABLE minimo_sync_state ADD COLUMN inbound_sweep_error TEXT;
ALTER TABLE minimo_sync_state ADD COLUMN rate_limited_until TEXT;

UPDATE minimo_sync_state SET
  next_outbound_at = next_attempt_at,
  rate_limited_until = CASE WHEN last_error = 'rate_limited' THEN next_attempt_at ELSE NULL END,
  next_attempt_at = CASE WHEN last_error IS NOT NULL OR consecutive_failures > 0
    THEN next_attempt_at ELSE '1970-01-01T00:00:00.000Z' END;
