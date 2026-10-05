-- Additive: payload_json TEXT column for system-level notification rows that
-- have no reservation_id (e.g. google_drift_alert). NULL for all existing
-- rows; existing dispatcher logic does not read this column.
ALTER TABLE notification_jobs ADD COLUMN payload_json TEXT;
