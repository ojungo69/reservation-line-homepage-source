-- Tier C.2 customer merge tombstone marker.
-- Additive only: existing customers.block_status has an active/blocked CHECK
-- that cannot be widened safely without a table rebuild, so merge state is
-- represented by merged_into_id while preserving the legacy block_status
-- constraint.

ALTER TABLE customers
  ADD COLUMN merged_into_id TEXT
    CHECK (merged_into_id IS NULL OR length(merged_into_id) <= 128);

CREATE INDEX IF NOT EXISTS idx_customers_merged_into
  ON customers(merged_into_id)
  WHERE merged_into_id IS NOT NULL;
