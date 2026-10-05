-- Drop the unused customer email fallback columns after removing their callers.
-- Public sample databases contain no customer or fallback-email records.
--
-- notification_jobs.email_inflight_at は別物。notification_jobs 経由で送るオーナー宛
-- メール（日次サマリー・Google ドリフト通知など）の送信中フラグとして現役なので、
-- 落とさない。顧客タブの確認コードはキューを通さず同期送信する別経路で、この列は使わない。

ALTER TABLE customers DROP COLUMN email;
ALTER TABLE notification_jobs DROP COLUMN email_fallback_status;
ALTER TABLE notification_jobs DROP COLUMN email_fallback_locked_until;
ALTER TABLE notification_jobs DROP COLUMN email_fallback_attempts;
ALTER TABLE notification_jobs DROP COLUMN email_fallback_last_error;
ALTER TABLE notification_jobs DROP COLUMN email_fallback_message_id;
