-- Manual-create "出所(origin)" marker for admin-created reservations.
--
-- Records WHERE a manually-created reservation came from (minimo / 電話 / 店頭 /
-- その他) WITHOUT changing the technical `source` column. `source` stays the
-- routing key for LINE notification suppression, phone-hash slot locks
-- (LOCK_PHONE_HASH_SOURCES), Google delete protection, and metrics enums; its
-- value and meaning are unchanged. `reservation_origin` is display/reporting
-- metadata only.
--
-- Nullable: Web/LINE bookings (source='web_line') and pre-existing rows carry
-- NULL — for those, `source` already conveys the origin. Only manual admin
-- creates set a non-NULL origin.
--
-- No BEGIN/COMMIT: D1 rejects explicit transaction control in migrations.

ALTER TABLE reservations
  ADD COLUMN reservation_origin TEXT NULL
  CHECK (reservation_origin IS NULL OR reservation_origin IN ('minimo', 'phone', 'walk_in', 'other'));
