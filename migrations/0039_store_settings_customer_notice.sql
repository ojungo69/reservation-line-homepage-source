-- Per-store customer-facing notice shown on the public booking page
-- (e.g. "水曜・土曜はメンズデーとなっております。"). NULL/absent = no notice.
-- 500-char cap mirrors MAX_NOTICE_LENGTH in src/admin/settings-customer-notice.ts —
-- the two must move together.
ALTER TABLE store_settings ADD COLUMN customer_notice TEXT
  CHECK (customer_notice IS NULL OR length(customer_notice) <= 500);
