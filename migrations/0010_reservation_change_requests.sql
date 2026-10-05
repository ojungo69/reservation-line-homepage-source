-- Phase 3: customer-initiated cancel / reschedule request flow.
--
-- New table reservation_change_requests stores customer-submitted requests
-- against confirmed/pending_approval reservations. Pending duplicates are
-- prevented by a partial UNIQUE on (reservation_id) WHERE status='pending'.
-- A reservation_version_at_request snapshot is captured so admin approve can
-- guard against intervening manual edits.
--
-- The migration also adds an additive notification_jobs.change_request_id
-- column so the queue worker can resolve admin/customer messages without
-- parsing dedupe_key (dedupe_key parsing is not a lookup contract).
--
-- This is forward-only. Rollback = DROP TABLE + DROP COLUMN; both are safe
-- because no Phase 3 code paths exist before this migration ships.

CREATE TABLE IF NOT EXISTS reservation_change_requests (
  id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  line_identity_id TEXT REFERENCES line_identities(id) ON DELETE SET NULL,
  request_type TEXT NOT NULL CHECK (request_type IN ('cancel', 'reschedule')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn', 'expired')),
  reservation_version_at_request INTEGER NOT NULL,
  current_start_at TEXT NOT NULL,
  current_end_at   TEXT NOT NULL,
  requested_start_at TEXT,
  requested_end_at   TEXT,
  customer_note TEXT CHECK (customer_note IS NULL OR length(customer_note) <= 500),
  admin_decision_note TEXT CHECK (admin_decision_note IS NULL OR length(admin_decision_note) <= 500),
  decided_by_admin_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (request_type = 'cancel' AND requested_start_at IS NULL AND requested_end_at IS NULL)
    OR
    (request_type = 'reschedule' AND requested_start_at IS NOT NULL AND requested_end_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_change_requests_one_pending
  ON reservation_change_requests(reservation_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_change_requests_pending_recent
  ON reservation_change_requests(status, created_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_change_requests_reservation
  ON reservation_change_requests(reservation_id);

CREATE INDEX IF NOT EXISTS idx_change_requests_line_identity
  ON reservation_change_requests(line_identity_id)
  WHERE line_identity_id IS NOT NULL;

ALTER TABLE notification_jobs
  ADD COLUMN change_request_id TEXT REFERENCES reservation_change_requests(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_notification_jobs_change_request
  ON notification_jobs(change_request_id)
  WHERE change_request_id IS NOT NULL;
