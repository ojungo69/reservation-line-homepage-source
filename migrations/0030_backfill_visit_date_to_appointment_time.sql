-- One-time backfill: correct historical completed-visit dates.
--
-- Reservation-sourced customer_visits rows were recorded with
-- visited_at = the admin "complete"-click time (nowIso), not the appointment
-- time. When owners complete reservations in batches days later, that drifted
-- the customer's last-visit date. Going forward buildCompleteVisitStatement
-- now binds the reservation's start_at; this resets the existing rows to match.
--
-- Scope: only VALID, reservation-sourced rows (reservation_id IS NOT NULL).
--   - status = 'valid'  → never touch voided/audit rows.
--   - manual / paper-chart imports (reservation_id IS NULL) keep their
--     operator-entered date.
-- The admin action timestamp is unaffected — it stays in reservations.completed_at.
--
-- Rollback safety: snapshot the old visited_at into a backup table BEFORE the
-- UPDATE so the change is reversible even for any legacy row whose visited_at
-- might differ from reservations.completed_at.
--
-- D1 rule: no BEGIN/COMMIT in migrations (wrangler wraps each file).

CREATE TABLE IF NOT EXISTS _backfill_0030_visit_dates_backup (
  customer_visit_id TEXT PRIMARY KEY,
  old_visited_at TEXT NOT NULL
);

-- The `visited_at <> start_at` guard skips rows already at the appointment time
-- (e.g. completions done same-day), so we neither back them up nor rewrite them
-- — fewer D1 writes and a backup table holding only genuinely-changed rows. (gemini)
INSERT OR IGNORE INTO _backfill_0030_visit_dates_backup (customer_visit_id, old_visited_at)
SELECT cv.id, cv.visited_at
FROM customer_visits cv
WHERE cv.reservation_id IS NOT NULL
  AND cv.status = 'valid'
  AND cv.visit_source IN ('reservation_completed', 'phone_admin_completed')
  AND EXISTS (SELECT 1 FROM reservations r WHERE r.id = cv.reservation_id)
  AND cv.visited_at <> (SELECT r.start_at FROM reservations r WHERE r.id = cv.reservation_id);

UPDATE customer_visits
SET visited_at = (
  SELECT r.start_at FROM reservations r WHERE r.id = customer_visits.reservation_id
)
WHERE reservation_id IS NOT NULL
  AND status = 'valid'
  AND visit_source IN ('reservation_completed', 'phone_admin_completed')
  AND EXISTS (
    SELECT 1 FROM reservations r WHERE r.id = customer_visits.reservation_id
  )
  AND visited_at <> (
    SELECT r.start_at FROM reservations r WHERE r.id = customer_visits.reservation_id
  );
