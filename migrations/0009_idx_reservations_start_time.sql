-- Phase 2 (admin period search + CSV export): support all-store range scans
-- on reservations.start_at.
--
-- The existing idx_reservations_store_time(store_id, start_at, end_at) leads
-- with store_id, so a 92-day range query without store filter cannot use it
-- and falls back to a full table scan. Phase 2 search/export endpoints
-- frequently run "all stores, period range" queries, so we add a dedicated
-- index keyed by start_at first.
--
-- Composite (start_at, end_at) keeps the index covering for ORDER BY
-- start_at ASC and lets future end_at-based filters reuse it. end_at is
-- already part of every reservation row.

CREATE INDEX IF NOT EXISTS idx_reservations_start_time
  ON reservations(start_at, end_at);
