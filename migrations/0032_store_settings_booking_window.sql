-- Per-store public booking window (how many days ahead a customer may book).
--
-- Adds a configurable per-store limit (default 30, range 1..90) that replaces
-- the previously-hardcoded 90-day AVAILABILITY_LOOKAHEAD_DAYS constant. The
-- public availability endpoint (src/reservations/public-options.ts) enforces
-- this server-side per request (uncached, live), and the booking UI date
-- dropdown reads the same per-store value via the options endpoint, so the
-- client and server can never desync on the window length.
--
-- Default 30 (= "1 month ahead"): existing stores transition from the old
-- 90-day window to a 30-day window on apply. Range 1..90 mirrors the API
-- validation in src/admin/settings-booking-window.ts and is bounded at 90 so
-- the per-day Google freeBusy availability checks never exceed the prior
-- query budget. The two (CHECK here, MIN/MAX there) must move together.
--
-- UPSERT-friendly: NOT NULL DEFAULT 30 so the existing singleton
-- store_settings rows backfill to 30, and a freshly-bootstrapped store with no
-- row yet falls back to 30 via COALESCE at every read site.
--
-- No BEGIN/COMMIT: D1 rejects explicit transaction control in migrations.

ALTER TABLE store_settings
  ADD COLUMN booking_window_days INTEGER NOT NULL DEFAULT 30
  CHECK (booking_window_days BETWEEN 1 AND 90);
