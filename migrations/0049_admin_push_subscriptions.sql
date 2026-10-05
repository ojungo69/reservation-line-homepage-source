-- Web Push subscriptions for the admin SPA, plus the dedupe marker for the
-- "approval deadline is near" push.
--
-- endpoint is the natural primary key: the push service issues one endpoint per
-- browser/device, and re-subscribing on the same device returns the same URL, so
-- an upsert keyed on it is exactly "this device's registration". No surrogate id
-- and no separate UNIQUE index.
--
-- The row is deleted when the push service answers 404/410 (subscription gone
-- for good) and CASCADEs when the admin user row is deleted. D1 enforces
-- declared foreign keys, so the CASCADE is real, not decorative.
CREATE TABLE IF NOT EXISTS admin_push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  admin_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ponytail: no index on admin_user_id. This table holds one row per admin
-- device (single digits in practice) and every read is a full scan joined to
-- admin_users anyway. Add one if it ever passes ~1k rows.

-- Dedupe marker for the expiring-approval push. Stamped when the push for this
-- reservation has been dispatched, so the 10-minute cron can use a generous
-- "expires within the next hour" window instead of a one-tick band — a skipped
-- tick then delays the notification rather than dropping it.
--
-- Lives on reservations (not a side table) so it disappears with the row it
-- describes and needs no cleanup job. Always NULL for reservations that never
-- reached the window.
ALTER TABLE reservations
ADD COLUMN approval_expiry_pushed_at TEXT;
