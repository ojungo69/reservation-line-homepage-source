-- Persisted snapshot of the LINE Messaging API monthly quota usage.
-- Refreshed by the maintenance cron from GET /v2/bot/message/quota[/consumption].
-- One row per JST calendar month; total_usage counts push-type messages only
-- (reply messages are free and not counted by LINE). quota_value is NULL when
-- the plan is unlimited ("none"); on the free Communication plan it is 200.
-- No explicit transaction wrapper — D1 wraps each migration itself.
CREATE TABLE IF NOT EXISTS line_quota_snapshots (
  year_month TEXT PRIMARY KEY,
  total_usage INTEGER NOT NULL DEFAULT 0,
  quota_value INTEGER,
  fetched_at TEXT NOT NULL
);
