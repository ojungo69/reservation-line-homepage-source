-- Store-login self-service: enforce at most ONE active shared login per store.
--
-- The store login is an admin_users row grouped under the deterministic sentinel
-- staff_member_id `staff_login_<storeId>`. The upsert domain logic
-- (src/admin/settings-store-login.ts) already resolves to a single active row,
-- but two concurrent POSTs (double-click, different emails, distinct idempotency
-- keys) can each resolve `none` and both INSERT an active pending row under the
-- same sentinel before either commits — yielding two authenticatable logins for
-- one store. This partial UNIQUE index makes the losing insert fail atomically
-- with a UNIQUE constraint violation (caught by recoverFromCreateBatchFailure ->
-- write_failed; the loser retries and hits the Case B/C path against the winner).
--
-- Scoped to `staff_login_*` rows only (via GLOB) so it constrains ONLY this
-- feature's rows and can never conflict with existing or legacy admin_users data
-- linked to ordinary staff_members. Disabled rows (active = 0) are excluded so
-- the disabled-login history under a sentinel is unbounded. Service-token rows
-- (is_service_token = 1) are excluded — they are a separate auth path.
--
-- Forward-only and rollback-safe: leaving the index in place if the feature is
-- rolled back is harmless. No BEGIN/COMMIT — D1 forbids explicit transaction
-- control in migrations.

CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_users_active_store_login
  ON admin_users (staff_member_id)
  WHERE active = 1
    AND is_service_token = 0
    AND staff_member_id GLOB 'staff_login_*';
