-- Additive: apply before the new Worker; keep the column on code rollback.
ALTER TABLE customers ADD COLUMN referrer_name TEXT
  CHECK (referrer_name IS NULL OR length(referrer_name) <= 120);
