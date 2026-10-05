-- Customer archive (soft-delete) marker — PR-B item ④.
-- Additive only: customers.block_status has an active/blocked CHECK that
-- cannot be widened without a table rebuild, so archive state is a separate
-- nullable column (same pattern as merged_into_id in 0014). archived_at holds
-- an ISO-8601 instant (e.g. 2026-06-02T03:00:00.000Z); NULL means "not
-- archived". A row is hidden from every list/search/lookup when
-- archived_at IS NOT NULL, and restored by setting it back to NULL.

ALTER TABLE customers
  ADD COLUMN archived_at TEXT
    CHECK (archived_at IS NULL OR length(archived_at) <= 32);

CREATE INDEX IF NOT EXISTS idx_customers_archived
  ON customers(archived_at)
  WHERE archived_at IS NOT NULL;
