-- Crash-safety marker for email-delivered notification jobs.
--
-- The LINE path is idempotent across "provider accepted the send, then the D1
-- write failed": every push carries `X-Line-Retry-Key: job_id`, so a re-attempt
-- is de-duplicated by LINE. Email has no equivalent — if the Worker dies between
-- `EMAIL.send()` resolving and `markJobSuccess`, the row stays `processing`, is
-- reclaimed once its 5-minute lock expires, and the owner gets the same mail twice.
--
-- Stamped immediately BEFORE the send and checked on re-claim: a claimed row that
-- already carries a timestamp had a send in flight whose outcome is unknown, so it
-- terminates instead of sending again (same trade-off as the customer email path's
-- `email_fallback_status = 'sending'` recovery: prefer a possibly-missed mail over
-- a certainly-duplicated one, and leave a greppable last_error behind).
ALTER TABLE notification_jobs
ADD COLUMN email_inflight_at TEXT;
