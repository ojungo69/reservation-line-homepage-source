-- Mark admin_users rows that authenticate via Cloudflare Access Service Tokens.
--
-- Service Token JWTs carry an empty `email` / `sub` and identify the Service Token Client ID via
-- `common_name`. We add an additive `is_service_token` flag so:
--   1. Human admins (existing rows) keep DEFAULT 0 and the human auth path filters with `= 0`.
--   2. Future Service Token rows (registered for Service Token authentication) are flagged `= 1`
--      and only matched when the route opts in via authenticateAdmin(..., { allowServiceToken }).
-- An index keyed by (is_service_token, active) supports the opt-in Service Token lookup.
--
-- This is forward-only and rollback-safe: production never receives Service Token rows, so the
-- column existing with DEFAULT 0 is a no-op there. If the feature is rolled back, leaving the
-- column in place is harmless.

ALTER TABLE admin_users
  ADD COLUMN is_service_token INTEGER NOT NULL DEFAULT 0 CHECK (is_service_token IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_admin_users_service_token
  ON admin_users(is_service_token, active);
