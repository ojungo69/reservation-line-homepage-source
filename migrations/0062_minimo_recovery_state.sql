-- Preserve applied data and cooldown while distinguishing preview progress and
-- durable provider restrictions from per-attempt diagnostics.
ALTER TABLE minimo_sync_state ADD COLUMN sweep_mode TEXT CHECK (sweep_mode IN ('preview', 'apply'));
ALTER TABLE minimo_sync_state ADD COLUMN sweep_error TEXT;
ALTER TABLE minimo_sync_state ADD COLUMN last_preview_at TEXT;
ALTER TABLE minimo_sync_state ADD COLUMN paused_reason TEXT;

-- Earlier cursors and success timestamps do not identify their execution mode.
-- Restart the next due sweep without shortening any existing provider delay.
UPDATE minimo_sync_state SET next_date = NULL, last_success_at = NULL,
  paused_reason = CASE WHEN last_error IN
    ('forbidden', 'challenge', 'auth_failed', 'redirect', 'invalid_session', 'invalid_response', 'body_too_large')
    THEN last_error ELSE NULL END;
