-- Tier C.3 4d reminder notification settings.
-- Additive only: reservation_reminder_offset_minutes is the per-store
-- minutes-before-start_at offset the future reminder cron will use to enqueue
-- reservation_reminder notification_jobs (SPEC §"reservation_reminder Phase 2
-- 候補"). NULL = reminder disabled for the store. The reminder dispatcher
-- itself is configured separately — the column persists the operator-chosen
-- offset so it survives until the Phase 2 reminder worker lands.

ALTER TABLE store_settings
  ADD COLUMN reservation_reminder_offset_minutes INTEGER
    CHECK (
      reservation_reminder_offset_minutes IS NULL
      OR (
        reservation_reminder_offset_minutes >= 0
        AND reservation_reminder_offset_minutes <= 4320
      )
    );
