-- A block is keyed on the PHONE NUMBER, not on the customers row: the public
-- submit and both admin booking modes reject the whole phone_hash. Those checks
-- are preflight, and the existing trigger only re-checks NEW.customer_id, so a
-- block landing on a SIBLING row between the check and the insert slipped through
-- — and since specs/006 staff can create those sibling rows from 顧客を追加, the
-- window is now reachable on purpose, not just by accident.
--
-- Same RAISE message as trg_reservations_reject_blocked_customer so the race
-- resolves to the same user-visible rejection: both writers already map
-- "blocked_customer" to their clean reason (reservation-create.ts / public-submit.ts).
--
-- NULL phone_hash never joins (NULL = NULL is not true in SQL), so phone-less
-- paper-chart customers are unaffected — a blocked phone-less customer is still
-- only protected by the per-row trigger, which is the structural limit of matching
-- people by number.
--
-- Merged tombstones are excluded: their block_status='blocked' is the merge marker,
-- not a real block (same rule as getBlockedCustomerByPhoneHash).
CREATE TRIGGER IF NOT EXISTS trg_reservations_reject_blocked_phone
BEFORE INSERT ON reservations
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
  FROM customers booked
  JOIN customers sibling ON sibling.phone_hash = booked.phone_hash
  WHERE booked.id = NEW.customer_id
    AND booked.phone_hash IS NOT NULL
    AND sibling.block_status = 'blocked'
    AND sibling.merged_into_id IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'blocked_customer');
END;
