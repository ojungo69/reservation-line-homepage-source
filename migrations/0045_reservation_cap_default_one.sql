-- Reduce the public web reservation cap to one for every store.
--
-- Recreate the trigger because migration 0024 embedded the previous fallback
-- directly in its SQL. Existing store_settings rows are updated in the same
-- migration so configured and fallback behavior agree immediately.
--
-- No explicit transaction wrapper: D1 rejects transaction control in migrations.

DROP TRIGGER IF EXISTS trg_reservations_web_cap;

CREATE TRIGGER IF NOT EXISTS trg_reservations_web_cap
BEFORE INSERT ON reservations
FOR EACH ROW
WHEN NEW.source = 'web_line'
  AND NEW.status IN ('confirmed', 'pending_approval')
  AND (
    -- Count by customer_id only; uses idx_reservations_customer_time(customer_id, start_at).
    SELECT COUNT(*)
    FROM reservations r
    WHERE r.customer_id = NEW.customer_id
      AND datetime(r.start_at) > datetime(NEW.updated_at)
      AND (
        r.status = 'confirmed'
        OR (
          r.status = 'pending_approval'
          AND (r.pending_expires_at IS NULL OR datetime(r.pending_expires_at) > datetime(NEW.updated_at))
        )
      )
  ) >= COALESCE(
    (SELECT max_active_reservations_per_customer FROM store_settings WHERE store_id = NEW.store_id),
    1
  )
BEGIN
  SELECT RAISE(ABORT, 'reservation_limit_reached');
END;

UPDATE store_settings
SET max_active_reservations_per_customer = 1;
