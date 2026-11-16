-- New all-day approvals record their mirror explicitly. Historical NULL links
-- stay unlinked; audit text is never used to infer ownership.
ALTER TABLE store_closures ADD COLUMN external_block_id TEXT
  REFERENCES external_blocks(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX idx_store_closures_external_block
  ON store_closures(external_block_id) WHERE external_block_id IS NOT NULL;

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
