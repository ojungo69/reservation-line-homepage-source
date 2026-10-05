-- Per-customer active reservation cap for public (web_line) bookings.
--
-- Adds a configurable per-store limit (default 3, range 1..50) and a BEFORE
-- INSERT trigger that atomically rejects a public web reservation when the
-- booking customer already holds >= cap future *active* reservations across ALL
-- stores. Atomic so concurrent submits cannot exceed the cap (the whole D1 batch
-- rolls back on RAISE), mirroring trg_reservations_reject_blocked_customer.
--
-- Identity: customer_id ONLY. An existing customer is always counted via their
-- customer_id regardless of the phone number submitted (the request phone never
-- overrides the stored customer row), so a customer cannot evade the cap by
-- editing their phone. We deliberately do NOT union by phone_hash: phone numbers
-- are unverified at submit, so counting across all records sharing a phone_hash
-- would let an attacker book under a victim's phone number and exhaust the
-- victim's cap (targeted denial-of-service). The residual gap — the same person
-- opening a brand-new LINE account evades their own cap — is low harm (a soft
-- fairness limit) and is the intended job of the owner-driven customer merge.
--
-- "Now" reference: datetime(NEW.updated_at). The public reservations INSERT binds
-- updated_at = the submit instant (the application's injected clock), so the
-- future/expiry comparisons match the app and stay deterministic under tests
-- that inject now(), instead of depending on the real wall clock.
--
-- Scope: only NEW.source = 'web_line' bookings are blocked (admin/phone/system
-- reservations may exceed the cap), but reservations of every source are COUNTED
-- toward the customer's total.
--
-- No BEGIN/COMMIT: D1 rejects explicit transaction control in migrations.

ALTER TABLE store_settings
  ADD COLUMN max_active_reservations_per_customer INTEGER NOT NULL DEFAULT 3
  CHECK (max_active_reservations_per_customer BETWEEN 1 AND 50);

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
    3
  )
BEGIN
  SELECT RAISE(ABORT, 'reservation_limit_reached');
END;
