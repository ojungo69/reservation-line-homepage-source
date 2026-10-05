-- "キャンセル料未納" (cancellation fee unpaid) flag for no-show reservations.
--
-- A nullable timestamp on reservations. When an admin marks a reservation as a
-- no-show (無断キャンセル / 来店なし), this is stamped with the action time so the
-- admin app can render a red "キャンセル料未納" badge. Owner+ can clear it (set
-- back to NULL) once the fee is collected, via PUT /reservations/:id/cancellation-fee.
--
-- This is a NOTE/FLAG only — NOT billing. Payment / fee collection is an
-- intentionally excluded feature (docs/FEATURE_COMPLETION_MATRIX.md); this column
-- just surfaces an unpaid-fee reminder the salon tracks manually.
--
-- Scope decision: flagged on no_show ONLY (not same-day cancels). Customers
-- cannot cancel within 24h (lead-time gate), so same-day cancels are admin-driven
-- and the owner asked to flag only no-shows. No same-day detection is needed.
--
-- NULL = no unpaid fee recorded. Non-null ISO timestamp = unpaid fee flagged at
-- that instant. Additive column with no default, so existing rows are unaffected.
--
-- No BEGIN/COMMIT: D1 rejects explicit transaction control in migrations.

ALTER TABLE reservations
  ADD COLUMN cancellation_fee_unpaid_at TEXT;
