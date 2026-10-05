ALTER TABLE customers ADD COLUMN email TEXT CHECK (email IS NULL OR length(email) <= 254);

ALTER TABLE notification_jobs ADD COLUMN email_fallback_status TEXT CHECK (
  email_fallback_status IS NULL OR email_fallback_status IN ('pending', 'processing', 'sending', 'sent', 'failed', 'skipped')
);
ALTER TABLE notification_jobs ADD COLUMN email_fallback_locked_until TEXT;
ALTER TABLE notification_jobs ADD COLUMN email_fallback_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notification_jobs ADD COLUMN email_fallback_last_error TEXT;
ALTER TABLE notification_jobs ADD COLUMN email_fallback_message_id TEXT;
