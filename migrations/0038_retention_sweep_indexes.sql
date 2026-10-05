-- Backlog ⑪⑩: indexes for the retention sweep's new predicates so the daily
-- cap-deletes scan a narrow index instead of the full table.
--
-- (1) google_calendar_events tombstone sweep (⑪): narrow to the status-matching
--     minority (cancelled/deleted) past the 90-day window.
--     NOTE: the sweep wraps last_seen_at in datetime() (the codebase stores two TEXT
--     timestamp formats, so a raw '<' would mis-order them), so the second index
--     column is NOT a range bound — only the leading `status` narrows the scan. That
--     status narrowing is the win (tombstones are a small fraction). Upgrade path if
--     volume ever makes the date range matter: an expression index on
--     (status, datetime(last_seen_at)).
--
-- (2) orphaned confirmed-lock sweep (⑩): a daily DELETE over slot_locks /
--     customer_time_locks filtered by lock_status='confirmed' AND owner_type='reservation'
--     followed by a correlated reservations lookup on owner_id. Without an index this
--     full-scans the whole lock table as bookings grow (a D1-timeout risk — the same
--     failure class the cron has hit before). A PARTIAL index on owner_id over exactly
--     the confirmed reservation locks keeps the scan + the correlated lookup cheap.
--
-- reservation_change_requests is intentionally NOT swept (see retention-sweep.ts —
-- 予約履歴/任意, out of Phase 1, accounting-window unresolved), so it gets no index here.
--
-- No BEGIN/COMMIT (D1 rejects them in migrations; each statement is its own tx).

CREATE INDEX IF NOT EXISTS idx_google_events_status_last_seen
  ON google_calendar_events(status, last_seen_at);

CREATE INDEX IF NOT EXISTS idx_slot_locks_orphan_sweep
  ON slot_locks(owner_id)
  WHERE lock_status = 'confirmed' AND owner_type = 'reservation';

CREATE INDEX IF NOT EXISTS idx_customer_time_locks_orphan_sweep
  ON customer_time_locks(owner_id)
  WHERE lock_status = 'confirmed' AND owner_type = 'reservation';
