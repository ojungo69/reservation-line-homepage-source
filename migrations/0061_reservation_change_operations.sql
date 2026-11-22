CREATE TABLE reservation_change_operations (
  operation_id TEXT NOT NULL PRIMARY KEY,
  reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (
    typeof(request_hash) = 'text'
    AND length(request_hash) = 64
    AND instr(request_hash, char(0)) = 0
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  kind TEXT NOT NULL CHECK (kind IN ('move', 'resize', 'undo')),
  inverse_of_operation_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('started', 'succeeded', 'not_applied')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  before_version INTEGER,
  applied_version INTEGER,
  before_snapshot_json TEXT,
  after_snapshot_json TEXT,
  effects_json TEXT,
  UNIQUE (actor_id, idempotency_key),
  CHECK ((kind = 'undo') = (inverse_of_operation_id IS NOT NULL)),
  CHECK (
    (status = 'succeeded'
      AND typeof(before_version) = 'integer'
      AND typeof(applied_version) = 'integer'
      AND before_version >= 1
      AND applied_version = before_version + 1
      AND applied_version <= 9007199254740991
      AND CASE
        WHEN typeof(before_snapshot_json) = 'text' AND json_valid(before_snapshot_json)
          AND typeof(after_snapshot_json) = 'text' AND json_valid(after_snapshot_json)
          AND typeof(effects_json) = 'text' AND json_valid(effects_json)
        THEN json_type(before_snapshot_json) = 'object'
          AND json_type(after_snapshot_json) = 'object'
          AND json_type(effects_json) = 'object'
        ELSE 0
      END
    ) OR (status IN ('started', 'not_applied')
      AND before_version IS NULL AND applied_version IS NULL
      AND before_snapshot_json IS NULL AND after_snapshot_json IS NULL AND effects_json IS NULL)
  )
);

CREATE INDEX idx_reservation_change_operations_reservation
  ON reservation_change_operations(reservation_id);

CREATE TRIGGER trg_reservation_change_operations_finalized
BEFORE UPDATE ON reservation_change_operations
WHEN OLD.status IN ('succeeded', 'not_applied')
BEGIN
  SELECT RAISE(ABORT, 'reservation_change_operation_finalized');
END;

CREATE TRIGGER trg_reservation_change_operations_identity_immutable
BEFORE UPDATE ON reservation_change_operations
WHEN OLD.operation_id IS NOT NEW.operation_id
  OR OLD.reservation_id IS NOT NEW.reservation_id
  OR OLD.actor_id IS NOT NEW.actor_id
  OR OLD.idempotency_key IS NOT NEW.idempotency_key
  OR OLD.request_hash IS NOT NEW.request_hash
  OR OLD.kind IS NOT NEW.kind
  OR OLD.inverse_of_operation_id IS NOT NEW.inverse_of_operation_id
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'reservation_change_operation_identity_immutable');
END;
