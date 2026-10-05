-- Prevent concurrent admin phone-create requests from bypassing customer locks:
-- Two concurrent admin phone-create requests for the same previously unseen
-- phone could both observe getCustomerByPhoneHash=null, generate distinct
-- customer_id values, and both succeed past the existing
-- UNIQUE(customer_id, slot_at) on customer_time_locks. This let the same
-- physical customer hold two confirmed reservations at the same wall-clock
-- slot across two different stores/resources.
--
-- Add a phone-scoped lock layer: a new nullable phone_hash column on
-- customer_time_locks plus a partial UNIQUE index on (phone_hash, slot_at)
-- WHERE phone_hash IS NOT NULL. Lock-creating code paths populate the
-- column for admin/phone-tracked reservations only (CASE WHEN
-- reservations.source IN ('phone_admin','admin')). Existing rows have
-- phone_hash IS NULL so the partial index never fires retroactively, making
-- this an additive migration safe to apply before deploying the worker.

ALTER TABLE customer_time_locks
  ADD COLUMN phone_hash TEXT
    CHECK (phone_hash IS NULL OR length(phone_hash) <= 128);

-- Backfill phone_hash for pre-existing locks owned by admin/phone-tracked
-- reservations so legacy rows participate in the new partial UNIQUE.
-- Without this, an existing reservation lock with phone_hash IS NULL could
-- still be bypassed by a later admin create/reschedule, leaving the race
-- condition partially unresolved for in-flight legacy reservations
--
-- Conflict-safe: ROW_NUMBER() picks the OLDEST lock per (slot_at,
-- phone_hash) group. Other locks at the same (slot_at, phone_hash) are
-- left NULL — they were race victims from before this migration and need
-- ops reconciliation, but leaving them NULL keeps them outside the partial
-- UNIQUE so the CREATE INDEX below cannot fail. Reconcile these legacy rows
-- separately before relying on the phone-scoped lock.
WITH dedup AS (
  SELECT
    ctl.id AS lock_id,
    ctl.slot_at,
    customers.phone_hash AS candidate_phone_hash,
    ROW_NUMBER() OVER (
      PARTITION BY ctl.slot_at, customers.phone_hash
      ORDER BY ctl.created_at ASC, ctl.id ASC
    ) AS rownum
  FROM customer_time_locks ctl
  JOIN reservations ON reservations.id = ctl.owner_id
  JOIN customers ON customers.id = reservations.customer_id
  WHERE ctl.phone_hash IS NULL
    AND ctl.owner_type = 'reservation'
    AND reservations.source IN ('phone_admin', 'admin')
    AND customers.phone_hash IS NOT NULL
)
UPDATE customer_time_locks
SET phone_hash = (
  SELECT candidate_phone_hash FROM dedup
  WHERE dedup.lock_id = customer_time_locks.id
)
WHERE id IN (
  SELECT lock_id FROM dedup WHERE rownum = 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_time_locks_phone_slot
  ON customer_time_locks (phone_hash, slot_at)
  WHERE phone_hash IS NOT NULL;
