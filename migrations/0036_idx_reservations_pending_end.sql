-- Follow-up to "expire pending reservations at appointment end": the expiry
-- sweep (src/reservations/expiration.ts) now matches pending rows via
-- `OR end_at <= now`. Without an index on end_at scoped to pending rows, SQLite
-- plans that arm as a full `reservations` table SCAN + temp sort (verified with
-- EXPLAIN QUERY PLAN: "SCAN reservations" + "USE TEMP B-TREE FOR ORDER BY").
--
-- That sweep runs on the hot path (shouldExpireBeforeFetch, ahead of public
-- availability/reservation requests), so a full scan would grow with the entire
-- reservations history. A partial index on end_at over only pending_approval
-- rows keeps the lookup bounded by the small, transient pending set
-- (EXPLAIN then reports "SCAN ... USING INDEX idx_reservations_pending_end",
-- i.e. the pending-only partial index, not the full table).
CREATE INDEX IF NOT EXISTS idx_reservations_pending_end
  ON reservations(end_at)
  WHERE status = 'pending_approval';
