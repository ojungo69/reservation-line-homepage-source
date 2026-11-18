-- Preserve explicit closure ownership while replacing its FK parent. Suspend only
-- the paired-link triggers so migration cannot enqueue cancellation side effects.
-- Apply this whole file atomically through Wrangler migrations, never statement by statement.
CREATE TABLE _0061_closure_links AS
SELECT id, external_block_id FROM store_closures WHERE external_block_id IS NOT NULL;
CREATE UNIQUE INDEX _0061_closure_links_id ON _0061_closure_links(id);

DROP TRIGGER trg_store_closures_link_insert;
DROP TRIGGER trg_store_closures_link_update;
DROP TRIGGER trg_external_blocks_linked_closure_store;
DROP TRIGGER trg_store_closures_cancel_linked_block;
DROP TRIGGER trg_external_blocks_cancel_linked_closure;

UPDATE store_closures SET external_block_id = NULL
WHERE id IN (SELECT id FROM _0061_closure_links);

-- Extend managed block ownership without disabling FK enforcement. The event
-- ledger uses RESTRICT and a source/link CHECK; conflicts use SET NULL. Save
-- both links before replacing their parent, then restore them in this migration.
CREATE TABLE _0061_google_event_links AS
SELECT id, external_block_id, source_type FROM google_calendar_events
WHERE external_block_id IS NOT NULL;
CREATE UNIQUE INDEX _0061_google_event_links_id ON _0061_google_event_links(id);

CREATE TABLE _0061_google_conflict_links AS
SELECT id, external_block_id FROM google_calendar_conflicts
WHERE external_block_id IS NOT NULL;
CREATE UNIQUE INDEX _0061_google_conflict_links_id ON _0061_google_conflict_links(id);

UPDATE google_calendar_events
SET external_block_id = NULL, source_type = 'unknown'
WHERE external_block_id IS NOT NULL;

UPDATE google_calendar_conflicts
SET external_block_id = NULL
WHERE external_block_id IS NOT NULL;

CREATE TABLE _0061_external_blocks (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES store_resources(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('google_calendar', 'admin_block', 'system_revert', 'minimo')),
  title_snapshot TEXT,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'cancelled')),
  google_event_id TEXT CHECK (google_event_id IS NULL OR length(google_event_id) <= 1024),
  google_event_etag TEXT CHECK (google_event_etag IS NULL OR length(google_event_etag) <= 512),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  minimo_reservation_id TEXT CHECK (minimo_reservation_id IS NULL OR (length(trim(minimo_reservation_id)) > 0 AND length(minimo_reservation_id) <= 128)),
  minimo_staff_id TEXT CHECK (minimo_staff_id IS NULL OR (length(trim(minimo_staff_id)) > 0 AND length(minimo_staff_id) <= 128)),
  CHECK (start_at < end_at),
  CHECK (source != 'google_calendar' OR google_event_id IS NOT NULL),
  CHECK (
    (source = 'minimo' AND minimo_reservation_id IS NOT NULL AND minimo_staff_id IS NOT NULL)
    OR (source != 'minimo' AND minimo_reservation_id IS NULL AND minimo_staff_id IS NULL)
  )
);

INSERT INTO _0061_external_blocks (
  id, store_id, resource_id, source, title_snapshot, start_at, end_at, status,
  google_event_id, google_event_etag, created_by, created_at, updated_at
)
SELECT id, store_id, resource_id, source, title_snapshot, start_at, end_at, status,
       google_event_id, google_event_etag, created_by, created_at, updated_at
FROM external_blocks;

DROP TABLE external_blocks;
ALTER TABLE _0061_external_blocks RENAME TO external_blocks;

CREATE INDEX IF NOT EXISTS idx_external_blocks_store_time ON external_blocks(store_id, start_at, end_at);
CREATE INDEX IF NOT EXISTS idx_external_blocks_resource_time ON external_blocks(resource_id, start_at, end_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_external_blocks_google_event ON external_blocks(google_event_id)
  WHERE google_event_id IS NOT NULL;
CREATE UNIQUE INDEX idx_external_blocks_minimo_reservation ON external_blocks(store_id, minimo_reservation_id)
  WHERE minimo_reservation_id IS NOT NULL;

-- Preserve the 0056 same-store checks on the rebuilt table.
CREATE TRIGGER IF NOT EXISTS trg_external_blocks_store_reference_insert
BEFORE INSERT ON external_blocks
WHEN NOT EXISTS (SELECT 1 FROM store_resources WHERE id = NEW.resource_id AND store_id = NEW.store_id)
BEGIN
  SELECT RAISE(ABORT, 'store_reference_mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_external_blocks_store_reference_update
BEFORE UPDATE OF store_id, resource_id ON external_blocks
WHEN NOT EXISTS (SELECT 1 FROM store_resources WHERE id = NEW.resource_id AND store_id = NEW.store_id)
BEGIN
  SELECT RAISE(ABORT, 'store_reference_mismatch');
END;

UPDATE google_calendar_events
SET external_block_id = (SELECT external_block_id FROM _0061_google_event_links WHERE id = google_calendar_events.id),
    source_type = (SELECT source_type FROM _0061_google_event_links WHERE id = google_calendar_events.id)
WHERE id IN (SELECT id FROM _0061_google_event_links);

UPDATE google_calendar_conflicts
SET external_block_id = (SELECT external_block_id FROM _0061_google_conflict_links WHERE id = google_calendar_conflicts.id)
WHERE id IN (SELECT id FROM _0061_google_conflict_links);

UPDATE store_closures
SET external_block_id = (SELECT external_block_id FROM _0061_closure_links WHERE id = store_closures.id)
WHERE id IN (SELECT id FROM _0061_closure_links);
DROP TABLE _0061_closure_links;

-- Restore the exact 0060 link/cancellation trigger contract; the closure table,
-- its RESTRICT FK and its partial unique index were never replaced.
CREATE TRIGGER trg_store_closures_link_insert
BEFORE INSERT ON store_closures
WHEN NEW.external_block_id IS NOT NULL AND (
  NEW.source != 'admin' OR NOT EXISTS (
    SELECT 1 FROM external_blocks b WHERE b.id = NEW.external_block_id
      AND b.store_id = NEW.store_id AND b.source = 'admin_block' AND b.status = 'active'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'linked_closure_block_mismatch');
END;

CREATE TRIGGER trg_store_closures_link_update
BEFORE UPDATE OF external_block_id, store_id, source ON store_closures
WHEN NEW.external_block_id IS NOT NULL AND (
  NEW.source != 'admin' OR NOT EXISTS (
    SELECT 1 FROM external_blocks b WHERE b.id = NEW.external_block_id
      AND b.store_id = NEW.store_id AND b.source = 'admin_block' AND b.status = 'active'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'linked_closure_block_mismatch');
END;

CREATE TRIGGER trg_external_blocks_linked_closure_store
BEFORE UPDATE OF store_id, source ON external_blocks
WHEN EXISTS (
  SELECT 1 FROM store_closures c WHERE c.external_block_id = OLD.id
    AND (c.store_id != NEW.store_id OR NEW.source != 'admin_block')
)
BEGIN
  SELECT RAISE(ABORT, 'linked_closure_block_mismatch');
END;

-- Both entrypoints already use atomic, authorized D1 batches. Trigger effects
-- share that transaction and preserve the API's original actor audit/changes().
CREATE TRIGGER trg_store_closures_cancel_linked_block
AFTER DELETE ON store_closures
WHEN OLD.external_block_id IS NOT NULL
BEGIN
  UPDATE external_blocks SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
  WHERE id = OLD.external_block_id AND store_id = OLD.store_id AND status = 'active';

  INSERT INTO slot_lock_history
    (id, slot_lock_id, store_id, resource_id, old_slot_at, old_owner_id,
     action, actor_type, actor_id, reason)
  SELECT lower(hex(randomblob(16))), id, store_id, resource_id, slot_at, owner_id,
    'released', 'system', 'linked_all_day_cancellation', 'linked_store_closure_deleted'
  FROM slot_locks WHERE owner_type = 'external_block' AND owner_id = OLD.external_block_id
    AND store_id = OLD.store_id;

  DELETE FROM slot_locks WHERE owner_type = 'external_block'
    AND owner_id = OLD.external_block_id AND store_id = OLD.store_id;

  -- Already-started provider writes retain their claim and stale-write cleanup.
  UPDATE calendar_sync_jobs SET status = 'succeeded', locked_until = NULL,
    last_error = 'superseded_by_external_block_cancellation',
    updated_at = (SELECT updated_at FROM external_blocks WHERE id = OLD.external_block_id)
  WHERE owner_type = 'external_block' AND owner_id = OLD.external_block_id
    AND google_action IN ('insert', 'patch', 'upsert') AND status IN ('queued', 'retryable');

  INSERT OR IGNORE INTO calendar_sync_jobs
    (id, dedupe_key, owner_type, owner_id, google_action, status, available_at)
  SELECT lower(hex(randomblob(16))), 'external_block:' || id || ':google:delete:cancelled',
    'external_block', id, 'delete', 'queued', updated_at
  FROM external_blocks WHERE id = OLD.external_block_id AND store_id = OLD.store_id;

  INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, metadata_json)
  VALUES (lower(hex(randomblob(16))), 'system', 'linked_all_day_cancellation',
    'all_day_linked_block_cancelled', 'external_block', OLD.external_block_id,
    json_object('closureId', OLD.id, 'externalBlockId', OLD.external_block_id, 'storeId', OLD.store_id));
END;

CREATE TRIGGER trg_external_blocks_cancel_linked_closure
AFTER UPDATE OF status ON external_blocks
WHEN OLD.status = 'active' AND NEW.status = 'cancelled'
BEGIN
  -- A closure DELETE can update this block again; the status transition guard
  -- above and the already-deleted closure make both recursive-trigger modes safe.
  DELETE FROM store_closures WHERE external_block_id = NEW.id AND store_id = NEW.store_id;
END;

DROP TABLE _0061_google_event_links;
DROP TABLE _0061_google_conflict_links;

CREATE TABLE minimo_sync_state (
  store_id TEXT PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  config_hash TEXT NOT NULL,
  session_ciphertext TEXT,
  session_expires_at TEXT,
  next_attempt_at TEXT NOT NULL,
  next_date TEXT,
  last_attempt_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0)
);

CREATE TABLE minimo_schedule_state (
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  owned_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('verified', 'pending', 'blocked')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (store_id, date)
);
