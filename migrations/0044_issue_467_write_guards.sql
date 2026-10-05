-- Close the read-then-write race between active reservations and
-- store closures. D1 batches are transactional, so the second writer reaches
-- one of these triggers after the first writer commits and is rejected.

CREATE TRIGGER IF NOT EXISTS trg_reservations_reject_store_closure_insert
BEFORE INSERT ON reservations
FOR EACH ROW
WHEN NEW.status IN ('pending_approval', 'confirmed')
  AND EXISTS (
    SELECT 1
    FROM store_closures c
    WHERE c.store_id = NEW.store_id
      AND c.starts_at < NEW.end_at
      AND c.ends_at > NEW.start_at
  )
BEGIN
  SELECT RAISE(ABORT, 'store_closed');
END;

CREATE TRIGGER IF NOT EXISTS trg_reservations_reject_store_closure_update
BEFORE UPDATE OF store_id, start_at, end_at, status ON reservations
FOR EACH ROW
WHEN NEW.status IN ('pending_approval', 'confirmed')
  AND EXISTS (
    SELECT 1
    FROM store_closures c
    WHERE c.store_id = NEW.store_id
      AND c.starts_at < NEW.end_at
      AND c.ends_at > NEW.start_at
  )
BEGIN
  SELECT RAISE(ABORT, 'store_closed');
END;

CREATE TRIGGER IF NOT EXISTS trg_store_closures_reject_active_reservation_insert
BEFORE INSERT ON store_closures
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
  FROM reservations r
  WHERE r.store_id = NEW.store_id
    AND r.status IN ('pending_approval', 'confirmed')
    AND r.start_at < NEW.ends_at
    AND r.end_at > NEW.starts_at
)
BEGIN
  SELECT RAISE(ABORT, 'overlapping_reservations');
END;

CREATE TRIGGER IF NOT EXISTS trg_store_closures_reject_active_reservation_update
BEFORE UPDATE OF store_id, starts_at, ends_at ON store_closures
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
  FROM reservations r
  WHERE r.store_id = NEW.store_id
    AND r.status IN ('pending_approval', 'confirmed')
    AND r.start_at < NEW.ends_at
    AND r.end_at > NEW.starts_at
)
BEGIN
  SELECT RAISE(ABORT, 'overlapping_reservations');
END;

-- Optimistic-lock token for the staff settings form. Existing rows start at 1;
-- every successful update increments it atomically.
ALTER TABLE staff_members
  ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);
