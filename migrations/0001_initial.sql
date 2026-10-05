PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS stores (
  id TEXT PRIMARY KEY CHECK (length(id) <= 64),
  name TEXT NOT NULL CHECK (length(name) <= 120),
  timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  line_official_account_id TEXT CHECK (line_official_account_id IS NULL OR length(line_official_account_id) <= 128),
  google_calendar_id TEXT CHECK (google_calendar_id IS NULL OR length(google_calendar_id) <= 320),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS store_settings (
  store_id TEXT PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  reservation_approval_mode TEXT NOT NULL DEFAULT 'existing_customer_auto' CHECK (
    reservation_approval_mode IN ('manual', 'existing_customer_auto')
  ),
  google_controlled_edit_mode INTEGER NOT NULL DEFAULT 0 CHECK (google_controlled_edit_mode IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS store_resources (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  resource_type TEXT NOT NULL DEFAULT 'staff_calendar' CHECK (
    resource_type IN ('staff_calendar', 'room', 'chair', 'other')
  ),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS staff_members (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'staff', 'system_admin')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS admin_users (
  id TEXT PRIMARY KEY,
  staff_member_id TEXT REFERENCES staff_members(id) ON DELETE SET NULL,
  email TEXT NOT NULL UNIQUE,
  access_subject TEXT NOT NULL UNIQUE CHECK (length(access_subject) <= 256),
  role TEXT NOT NULL CHECK (role IN ('owner', 'staff', 'system_admin')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  last_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  buffer_before_minutes INTEGER NOT NULL DEFAULT 0 CHECK (buffer_before_minutes >= 0),
  buffer_after_minutes INTEGER NOT NULL DEFAULT 0 CHECK (buffer_after_minutes >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS service_stores (
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (service_id, store_id)
);

CREATE TABLE IF NOT EXISTS store_business_hours (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  opens_at TEXT NOT NULL,
  closes_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  UNIQUE (store_id, weekday, opens_at, closes_at),
  CHECK (opens_at < closes_at)
);

CREATE TABLE IF NOT EXISTS store_closures (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  reason TEXT,
  source TEXT NOT NULL CHECK (source IN ('admin', 'google_external_block')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (starts_at < ends_at)
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL CHECK (length(display_name) <= 120),
  display_name_kana TEXT CHECK (display_name_kana IS NULL OR length(display_name_kana) <= 120),
  phone_normalized TEXT CHECK (phone_normalized IS NULL OR length(phone_normalized) <= 32),
  phone_hash TEXT CHECK (phone_hash IS NULL OR length(phone_hash) <= 128),
  block_status TEXT NOT NULL DEFAULT 'active' CHECK (block_status IN ('active', 'blocked')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS line_identities (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'line',
  channel_id TEXT NOT NULL CHECK (length(channel_id) <= 128),
  line_user_id TEXT NOT NULL CHECK (length(line_user_id) <= 128),
  display_name TEXT CHECK (display_name IS NULL OR length(display_name) <= 120),
  picture_url TEXT CHECK (picture_url IS NULL OR length(picture_url) <= 2048),
  friend_flag INTEGER NOT NULL DEFAULT 0 CHECK (friend_flag IN (0, 1)),
  official_friend_status TEXT NOT NULL DEFAULT 'unknown' CHECK (
    official_friend_status IN ('unknown', 'friend', 'not_friend', 'blocked')
  ),
  followed_at TEXT,
  unfollowed_at TEXT,
  last_friend_checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (provider, channel_id, line_user_id)
);

CREATE TABLE IF NOT EXISTS customer_match_candidates (
  id TEXT PRIMARY KEY,
  customer_id TEXT REFERENCES customers(id) ON DELETE CASCADE,
  line_identity_id TEXT REFERENCES line_identities(id) ON DELETE CASCADE,
  match_key TEXT NOT NULL,
  confidence_score REAL NOT NULL CHECK (confidence_score >= 0 AND confidence_score <= 1),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  resource_id TEXT NOT NULL REFERENCES store_resources(id) ON DELETE RESTRICT,
  line_identity_id TEXT REFERENCES line_identities(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('web_line', 'phone_admin', 'admin', 'system_import')),
  status TEXT NOT NULL CHECK (
    status IN (
      'pending_approval',
      'confirmed',
      'rejected',
      'expired',
      'cancelled_by_customer',
      'cancelled_by_admin',
      'completed',
      'no_show'
    )
  ),
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  pending_expires_at TEXT,
  cancelled_at TEXT,
  cancelled_by TEXT,
  completed_at TEXT,
  no_show_at TEXT,
  created_by TEXT,
  updated_by TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  google_event_id TEXT CHECK (google_event_id IS NULL OR length(google_event_id) <= 1024),
  google_event_etag TEXT CHECK (google_event_etag IS NULL OR length(google_event_etag) <= 512),
  google_sync_state TEXT NOT NULL DEFAULT 'pending' CHECK (
    google_sync_state IN ('pending', 'synced', 'failed', 'not_required')
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (start_at < end_at)
);

CREATE TRIGGER IF NOT EXISTS trg_reservations_reject_blocked_customer
BEFORE INSERT ON reservations
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
  FROM customers
  WHERE id = NEW.customer_id
    AND block_status = 'blocked'
)
BEGIN
  SELECT RAISE(ABORT, 'blocked_customer');
END;

CREATE TABLE IF NOT EXISTS slot_locks (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES store_resources(id) ON DELETE CASCADE,
  slot_at TEXT NOT NULL,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('reservation', 'external_block', 'admin_hold')),
  owner_id TEXT NOT NULL,
  lock_status TEXT NOT NULL CHECK (lock_status IN ('pending', 'confirmed')),
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (store_id, resource_id, slot_at)
);

CREATE TABLE IF NOT EXISTS slot_lock_history (
  id TEXT PRIMARY KEY,
  slot_lock_id TEXT,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES store_resources(id) ON DELETE CASCADE,
  old_slot_at TEXT,
  new_slot_at TEXT,
  old_owner_id TEXT,
  new_owner_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('created', 'released', 'moved', 'expired')),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('customer', 'staff', 'system')),
  actor_id TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS customer_time_locks (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  slot_at TEXT NOT NULL,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('reservation')),
  owner_id TEXT NOT NULL,
  lock_status TEXT NOT NULL CHECK (lock_status IN ('pending', 'confirmed')),
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (customer_id, slot_at)
);

CREATE TABLE IF NOT EXISTS customer_visits (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  reservation_id TEXT UNIQUE REFERENCES reservations(id) ON DELETE RESTRICT,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  visited_at TEXT NOT NULL,
  visit_source TEXT NOT NULL CHECK (
    visit_source IN ('reservation_completed', 'manual_import', 'paper_chart_import', 'phone_admin_completed')
  ),
  status TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid', 'voided')),
  recorded_by TEXT NOT NULL,
  voided_by TEXT,
  voided_at TEXT,
  void_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    status = 'valid'
    OR (voided_by IS NOT NULL AND voided_at IS NOT NULL AND void_reason IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS external_blocks (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES store_resources(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('google_calendar', 'admin_block', 'system_revert')),
  title_snapshot TEXT,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'cancelled')),
  google_event_id TEXT CHECK (google_event_id IS NULL OR length(google_event_id) <= 1024),
  google_event_etag TEXT CHECK (google_event_etag IS NULL OR length(google_event_etag) <= 512),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (start_at < end_at),
  CHECK (source != 'google_calendar' OR google_event_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS consent_records (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  reservation_id TEXT REFERENCES reservations(id) ON DELETE SET NULL,
  consent_type TEXT NOT NULL CHECK (
    consent_type IN ('notice', 'cancellation_policy', 'privacy_policy', 'minor_guardian')
  ),
  version TEXT NOT NULL,
  consented_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (customer_id, reservation_id, consent_type, version)
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('public_submit', 'admin_action', 'google_write', 'line_notification')),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) <= 256),
  status TEXT NOT NULL CHECK (status IN ('started', 'succeeded', 'failed')),
  target_type TEXT,
  target_id TEXT,
  request_hash TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (scope, idempotency_key)
);

CREATE TABLE IF NOT EXISTS auth_states (
  id TEXT PRIMARY KEY,
  state_hash TEXT NOT NULL UNIQUE,
  nonce_hash TEXT NOT NULL,
  pkce_verifier_hash TEXT NOT NULL,
  redirect_path TEXT,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0 CHECK (used IN (0, 1)),
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rate_limit_events (
  id TEXT PRIMARY KEY,
  rate_limit_key TEXT NOT NULL,
  action TEXT NOT NULL,
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS job_leases (
  id TEXT PRIMARY KEY,
  lease_key TEXT NOT NULL UNIQUE,
  locked_by TEXT NOT NULL,
  locked_until TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notification_jobs (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE CHECK (length(dedupe_key) <= 256),
  template_key TEXT NOT NULL,
  recipient_type TEXT NOT NULL CHECK (recipient_type IN ('customer', 'staff', 'owner')),
  recipient_id TEXT NOT NULL,
  reservation_id TEXT REFERENCES reservations(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'retryable', 'succeeded', 'failed', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  locked_until TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notification_logs (
  id TEXT PRIMARY KEY,
  notification_job_id TEXT NOT NULL REFERENCES notification_jobs(id) ON DELETE CASCADE,
  template_key TEXT NOT NULL,
  recipient_type TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  reservation_id TEXT,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  provider_message_id TEXT,
  error TEXT,
  sent_count INTEGER NOT NULL DEFAULT 0 CHECK (sent_count >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS line_webhook_events (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE CHECK (length(dedupe_key) <= 256),
  event_type TEXT NOT NULL CHECK (length(event_type) <= 64),
  line_user_id TEXT CHECK (line_user_id IS NULL OR length(line_user_id) <= 128),
  event_timestamp TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS calendar_auth_connections (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'google',
  calendar_id TEXT NOT NULL,
  service_account_email TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'needs_reauth')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (provider, calendar_id)
);

CREATE TABLE IF NOT EXISTS calendar_sync_jobs (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE CHECK (length(dedupe_key) <= 256),
  owner_type TEXT NOT NULL CHECK (owner_type IN ('reservation', 'external_block')),
  owner_id TEXT NOT NULL,
  google_action TEXT NOT NULL CHECK (google_action IN ('insert', 'patch', 'delete', 'upsert')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'retryable', 'succeeded', 'failed', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  locked_until TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS google_calendar_channels (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  calendar_auth_connection_id TEXT NOT NULL REFERENCES calendar_auth_connections(id) ON DELETE CASCADE,
  calendar_id TEXT NOT NULL CHECK (length(calendar_id) <= 320),
  channel_id TEXT NOT NULL UNIQUE CHECK (length(channel_id) <= 256),
  resource_id TEXT NOT NULL CHECK (length(resource_id) <= 512),
  channel_token_hash TEXT NOT NULL CHECK (length(channel_token_hash) <= 128),
  channel_token_hash_alg TEXT NOT NULL DEFAULT 'sha256',
  sync_token TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'renewing', 'expired', 'stopped', 'failed')),
  expiration_at TEXT,
  last_notification_at TEXT,
  last_resource_state TEXT,
  last_message_number TEXT,
  last_incremental_sync_at TEXT,
  last_full_reconcile_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS google_calendar_notifications (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL CHECK (length(channel_id) <= 256),
  resource_id TEXT NOT NULL CHECK (length(resource_id) <= 512),
  message_number TEXT NOT NULL CHECK (length(message_number) <= 64),
  resource_state TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  headers_redacted_json TEXT,
  UNIQUE (channel_id, resource_id, message_number)
);

CREATE TABLE IF NOT EXISTS google_calendar_events (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  calendar_id TEXT NOT NULL CHECK (length(calendar_id) <= 320),
  google_event_id TEXT NOT NULL CHECK (length(google_event_id) <= 1024),
  reservation_id TEXT REFERENCES reservations(id) ON DELETE RESTRICT,
  external_block_id TEXT REFERENCES external_blocks(id) ON DELETE RESTRICT,
  google_etag TEXT CHECK (google_etag IS NULL OR length(google_etag) <= 512),
  google_updated_at TEXT,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_imported_at TEXT,
  source_type TEXT NOT NULL CHECK (source_type IN ('reservation', 'external_block', 'unknown')),
  status TEXT NOT NULL CHECK (status IN ('active', 'cancelled', 'deleted', 'conflict', 'ignored')),
  google_safe_snapshot_json TEXT,
  UNIQUE (calendar_id, google_event_id),
  CHECK (
    (source_type = 'reservation' AND reservation_id IS NOT NULL AND external_block_id IS NULL)
    OR (source_type = 'external_block' AND reservation_id IS NULL AND external_block_id IS NOT NULL)
    OR (source_type = 'unknown' AND reservation_id IS NULL AND external_block_id IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS google_calendar_import_jobs (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  calendar_id TEXT NOT NULL CHECK (length(calendar_id) <= 320),
  reason TEXT NOT NULL CHECK (reason IN ('push', 'cron_incremental', 'full_reconcile', 'manual')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'succeeded', 'retryable', 'failed', 'dead')),
  next_run_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  locked_until TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  dedupe_key TEXT NOT NULL UNIQUE CHECK (length(dedupe_key) <= 256),
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS google_calendar_conflicts (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  calendar_id TEXT NOT NULL CHECK (length(calendar_id) <= 320),
  google_event_id TEXT NOT NULL CHECK (length(google_event_id) <= 1024),
  reservation_id TEXT REFERENCES reservations(id) ON DELETE SET NULL,
  external_block_id TEXT REFERENCES external_blocks(id) ON DELETE SET NULL,
  conflict_type TEXT NOT NULL,
  google_safe_snapshot_json TEXT NOT NULL,
  d1_safe_snapshot_json TEXT,
  resolution_status TEXT NOT NULL CHECK (resolution_status IN ('open', 'auto_reverted', 'accepted', 'ignored', 'manual_resolved')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  resolved_by TEXT
);

CREATE TABLE IF NOT EXISTS google_calendar_outbound_writes (
  id TEXT PRIMARY KEY,
  calendar_sync_job_id TEXT REFERENCES calendar_sync_jobs(id) ON DELETE SET NULL,
  dedupe_key TEXT NOT NULL UNIQUE CHECK (length(dedupe_key) <= 256),
  calendar_id TEXT NOT NULL CHECK (length(calendar_id) <= 320),
  google_event_id TEXT NOT NULL CHECK (length(google_event_id) <= 1024),
  owner_type TEXT NOT NULL CHECK (owner_type IN ('reservation', 'external_block')),
  owner_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('insert', 'patch', 'delete', 'upsert')),
  expected_fingerprint TEXT NOT NULL,
  google_etag_after TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS referral_notes (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  note TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('customer', 'staff', 'system', 'google_calendar')),
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_staff_members_store ON staff_members(store_id);
CREATE INDEX IF NOT EXISTS idx_admin_users_staff ON admin_users(staff_member_id);
CREATE INDEX IF NOT EXISTS idx_store_resources_store ON store_resources(store_id);
CREATE INDEX IF NOT EXISTS idx_services_store ON services(store_id);
CREATE INDEX IF NOT EXISTS idx_customers_phone_hash ON customers(phone_hash)
  WHERE phone_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_line_identities_customer ON line_identities(customer_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reservations_one_pending_per_line ON reservations(line_identity_id)
  WHERE status = 'pending_approval' AND line_identity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reservations_store_time ON reservations(store_id, start_at, end_at);
CREATE INDEX IF NOT EXISTS idx_reservations_customer_time ON reservations(customer_id, start_at, end_at);
CREATE INDEX IF NOT EXISTS idx_reservations_resource_time ON reservations(resource_id, start_at, end_at);
CREATE INDEX IF NOT EXISTS idx_slot_locks_expiry ON slot_locks(expires_at);
CREATE INDEX IF NOT EXISTS idx_customer_time_locks_expiry ON customer_time_locks(expires_at);
CREATE INDEX IF NOT EXISTS idx_external_blocks_store_time ON external_blocks(store_id, start_at, end_at);
CREATE INDEX IF NOT EXISTS idx_external_blocks_resource_time ON external_blocks(resource_id, start_at, end_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_external_blocks_google_event ON external_blocks(google_event_id)
  WHERE google_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expiry ON idempotency_keys(expires_at);
CREATE INDEX IF NOT EXISTS idx_rate_limit_events_key_time ON rate_limit_events(rate_limit_key, occurred_at);
CREATE INDEX IF NOT EXISTS idx_notification_jobs_status_available ON notification_jobs(status, available_at);
CREATE INDEX IF NOT EXISTS idx_calendar_sync_jobs_status_available ON calendar_sync_jobs(status, available_at);
CREATE INDEX IF NOT EXISTS idx_google_channels_status_expiration ON google_calendar_channels(status, expiration_at);
CREATE INDEX IF NOT EXISTS idx_google_import_jobs_status_next_run ON google_calendar_import_jobs(status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_google_notifications_channel ON google_calendar_notifications(channel_id, received_at);
CREATE INDEX IF NOT EXISTS idx_google_events_reservation ON google_calendar_events(reservation_id)
  WHERE reservation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_google_events_external_block ON google_calendar_events(external_block_id)
  WHERE external_block_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_google_events_one_active_reservation ON google_calendar_events(reservation_id)
  WHERE reservation_id IS NOT NULL AND status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS idx_google_events_one_active_external_block ON google_calendar_events(external_block_id)
  WHERE external_block_id IS NOT NULL AND status = 'active';
CREATE INDEX IF NOT EXISTS idx_google_conflicts_resolution ON google_calendar_conflicts(resolution_status, created_at);
CREATE INDEX IF NOT EXISTS idx_google_outbound_writes_expiry ON google_calendar_outbound_writes(expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_google_outbound_writes_fingerprint ON google_calendar_outbound_writes(calendar_id, google_event_id, action, expected_fingerprint);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target ON audit_logs(target_type, target_id, created_at);
