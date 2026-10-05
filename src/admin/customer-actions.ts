import type { AdminUser } from "./access";
import { adminWriteSnapshot, adminWriteWasRevoked } from "./write-authorization";
import { captureBatchWriteFailure } from "../sentry-helpers";
import { isNonEmptyString, toIso } from "./reservation-time-utils";
import { OWN_STORE_MEMBERSHIP_ARMS, staffCanAccessCustomer } from "./customers";
import {
  IDEMPOTENCY_TTL_MS,
  fetchAdminActionIdempotency,
  sha256Hex,
  startedIdempotencyStatement,
  type IdempotencyRow,
} from "./settings-common";

// Shared staff gate for block/unblock and archive/unarchive. Owner / system_admin
// pass through. Staff may only act on a customer inside their own-store scope, and
// fail closed when they have no store binding. Runs AFTER the pure input validation
// (so a malformed id never reaches a bind) and BEFORE any idempotency or state read,
// keeping the authz decision ahead of every side effect.
//
// Every caller passes includeArchived because being archived is a STATE, not an
// authz fact: the restore target is archived by definition, and any RETRY carries
// the same idempotency key against a row that may have been archived since. Judging
// scope on archived_at turns those into 403 — the retry reports failure for an
// operation that already succeeded, where owner gets the {replayed: true} replay.
// The state rules still hold downstream: block/unblock's fetchCustomer requires
// archived_at IS NULL (not_found), and a genuine double-archive is invalid_transition.
const staffMayActOnCustomer = async (
  db: D1Database,
  admin: AdminUser,
  customerId: string
): Promise<boolean> => {
  if (admin.role !== "staff") return true;
  if (!admin.store_id) return false;
  return staffCanAccessCustomer(db, customerId, admin.store_id, { includeArchived: true });
};

// The staff gate above is a SELECT, and the UPDATE that follows it is a separate
// statement — between them the membership can disappear (the only valid visit is
// voided, the staff moves to another store). Carrying the same predicate into the
// UPDATE closes that window structurally: the row stops matching, changes() is 0,
// and the audit INSERT that follows aborts the whole batch on its actor_type CHECK.
// Without it the write lands and is recorded as a success by a staff member who no
// longer has the customer.
//
// Every role must still match its live actor snapshot. Staff additionally retain
// customer membership; a missing store binding stays fail-closed.
const ownStoreUpdateScope = (admin: AdminUser): { clause: string; params: (string | null)[] } => {
  const snapshot = adminWriteSnapshot(admin);
  const clause = ` AND ${snapshot.sql}`;
  if (admin.role !== "staff") return { clause, params: snapshot.bindings };
  const storeId = admin.store_id ?? "";
  return { clause: `${clause} AND ${OWN_STORE_MEMBERSHIP_ARMS}`, params: [...snapshot.bindings, storeId, storeId, storeId] };
};

export type AdminCustomerBlockRequest = {
  idempotencyKey: string;
  reason?: string;
};

type AdminCustomerBlockFailureReason =
  | "forbidden"
  | "invalid_request"
  | "not_found"
  | "invalid_transition"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "write_failed";

export type AdminCustomerBlockResult =
  | {
      ok: true;
      customerId: string;
      blockStatus: "active" | "blocked";
      replayed: boolean;
    }
  | {
      ok: false;
      reason: AdminCustomerBlockFailureReason;
    };

type CustomerRow = {
  id: string;
  block_status: "active" | "blocked";
};

const fetchCustomer = async (db: D1Database, customerId: string) => {
  return db
    .prepare(
      `
        SELECT id, block_status
        FROM customers
        WHERE id = ?
          AND merged_into_id IS NULL
          AND archived_at IS NULL
        LIMIT 1
      `
    )
    .bind(customerId)
    .first<CustomerRow>();
};

const createRequestHash = async (input: {
  action: "block" | "unblock";
  customerId: string;
  reason?: string;
}) => {
  return sha256Hex(
    JSON.stringify({
      action: input.action,
      customerId: input.customerId,
      reason: input.reason?.trim() ?? null
    })
  );
};

// Shared batch-error mapper for the conditional-UPDATE "actor_type" abort
// trick used by BOTH the block and archive flows. The 'staff' sentinel
// actor_type trips a CHECK violation when the guarded UPDATE matched 0 rows,
// surfacing here as invalid_transition; anything else is a generic write
// failure. The narrow {ok:false} shape is assignable to both
// AdminCustomerBlockResult and AdminCustomerArchiveResult.
const mapActorTypeBatchError = (
  error: unknown
): { ok: false; reason: "invalid_transition" | "write_failed" } => {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("actor_type")) {
    // Expected: the 'staff' sentinel actor_type trips a CHECK when the guarded
    // UPDATE matched 0 rows (a concurrent transition already applied). Not a
    // fault — stays silent.
    return { ok: false, reason: "invalid_transition" };
  }
  // Genuine unexpected batch-write failure (not the expected 0-row guard trip).
  captureBatchWriteFailure(error, { component: "customer-actions", op: "batch_write_failed" });
  return { ok: false, reason: "write_failed" };
};

const resolveCustomerBlockIdempotency = (
  idempotency: IdempotencyRow | null,
  requestHash: string,
  desiredStatus: "active" | "blocked"
): AdminCustomerBlockResult | undefined => {
  if (!idempotency) {
    return undefined;
  }
  if (idempotency.request_hash !== requestHash) {
    return {
      ok: false,
      reason: "idempotency_conflict"
    };
  }
  if (idempotency.status === "succeeded" && idempotency.target_id) {
    return {
      ok: true,
      customerId: idempotency.target_id,
      blockStatus: desiredStatus,
      replayed: true
    };
  }
  return {
    ok: false,
    reason: "idempotency_in_progress"
  };
};

const resolveCustomerBlockBatchFailure = async (
  db: D1Database,
  idempotencyKey: string,
  requestHash: string,
  desiredStatus: "active" | "blocked",
  error: unknown,
  nowIso: string
): Promise<AdminCustomerBlockResult> => {
  try {
    const concurrentIdempotency = await fetchAdminActionIdempotency(db, idempotencyKey, nowIso);
    return resolveCustomerBlockIdempotency(concurrentIdempotency, requestHash, desiredStatus) ?? mapActorTypeBatchError(error);
  } catch {
    return mapActorTypeBatchError(error);
  }
};

// block / archive take the same shaped request, so the limits live in one
// predicate: a copy in each handler is how the two drift apart. The authz call
// stays inline in both — it differs (archive must accept an already-archived
// customer) and a shared wrapper with a flag would hide that.
const isValidCustomerActionRequest = (
  customerId: string,
  request: { idempotencyKey: string; reason?: string }
): boolean =>
  isNonEmptyString(customerId, 128) &&
  isNonEmptyString(request.idempotencyKey, 256) &&
  (request.reason === undefined || isNonEmptyString(request.reason, 500));

export async function setAdminCustomerBlockStatus(input: {
  db: D1Database;
  admin: AdminUser;
  customerId: string;
  action: "block" | "unblock";
  request: AdminCustomerBlockRequest;
  now?: () => number;
}): Promise<AdminCustomerBlockResult> {
  if (!isValidCustomerActionRequest(input.customerId, input.request)) {
    return {
      ok: false,
      reason: "invalid_request"
    };
  }
  if (!(await staffMayActOnCustomer(input.db, input.admin, input.customerId))) {
    return {
      ok: false,
      reason: "forbidden"
    };
  }

  const desiredStatus = input.action === "block" ? "blocked" : "active";
  const requestHash = await createRequestHash({
    action: input.action,
    customerId: input.customerId,
    reason: input.request.reason
  });
  // Single clock stamps expires_at on write AND filters the TTL read (F-6.1).
  const nowMs = (input.now ?? Date.now)();
  const nowIso = toIso(new Date(nowMs));
  const idempotency = await fetchAdminActionIdempotency(input.db, input.request.idempotencyKey, nowIso);
  const idempotencyResult = resolveCustomerBlockIdempotency(idempotency, requestHash, desiredStatus);
  if (idempotencyResult) {
    return idempotencyResult;
  }

  const customer = await fetchCustomer(input.db, input.customerId);
  if (!customer) {
    return {
      ok: false,
      reason: "not_found"
    };
  }
  if (customer.block_status === desiredStatus) {
    return {
      ok: false,
      reason: "invalid_transition"
    };
  }

  const idempotencyId = crypto.randomUUID();
  const expiresAt = toIso(new Date(nowMs + IDEMPOTENCY_TTL_MS));
  const auditAction = input.action === "block" ? "admin_customer_blocked" : "admin_customer_unblocked";
  const blockScope = ownStoreUpdateScope(input.admin);

  try {
    await input.db.batch([
      startedIdempotencyStatement({
        db: input.db,
        id: idempotencyId,
        key: input.request.idempotencyKey,
        requestHash,
        expiresAt,
        nowIso
      }),
      input.db
        .prepare(
          `
            UPDATE customers AS c
            SET block_status = ?,
                updated_at = ?
            WHERE c.id = ?
              AND c.block_status = ?
              AND c.merged_into_id IS NULL
              AND c.archived_at IS NULL${blockScope.clause}
          `
        )
        .bind(desiredStatus, nowIso, input.customerId, customer.block_status, ...blockScope.params),
      input.db
        .prepare(
          `
            -- Abort the batch if the conditional customer update did not change one row.
            INSERT INTO audit_logs (
              id,
              actor_type,
              actor_id,
              action,
              target_type,
              target_id,
              metadata_json
            )
            SELECT
              ?,
              CASE WHEN changes() = 1 THEN 'staff' ELSE 'customer_block_transition_conflict' END,
              ?,
              ?,
              'customer',
              ?,
              ?
          `
        )
        .bind(
          crypto.randomUUID(),
          input.admin.id,
          auditAction,
          input.customerId,
          JSON.stringify({
            previousStatus: customer.block_status,
            blockStatus: desiredStatus,
            reason: input.request.reason?.trim() ?? null,
            adminRole: input.admin.role,
            // Which store acted. Since staff may block/unblock (2026-08-26) and a
            // block is global, the role alone no longer identifies the actor's
            // scope — and store-login accounts are shared per store, so actor_id
            // does not narrow it either.
            adminStoreId: input.admin.store_id ?? null
          })
        ),
      input.db
        .prepare(
          `
            UPDATE idempotency_keys
            SET status = 'succeeded',
                target_type = 'customer',
                target_id = ?,
                updated_at = ?
            WHERE id = ?
          `
        )
        .bind(input.customerId, nowIso, idempotencyId)
    ]);
  } catch (error) {
    if (await adminWriteWasRevoked(input.db, input.admin, error)) {
      return { ok: false, reason: "forbidden" };
    }
    return resolveCustomerBlockBatchFailure(
      input.db,
      input.request.idempotencyKey,
      requestHash,
      desiredStatus,
      error,
      nowIso
    );
  }

  return {
    ok: true,
    customerId: input.customerId,
    blockStatus: desiredStatus,
    replayed: false
  };
}

export type AdminCustomerArchiveRequest = {
  idempotencyKey: string;
  reason?: string;
};

type AdminCustomerArchiveFailureReason =
  | "forbidden"
  | "invalid_request"
  | "not_found"
  | "invalid_transition"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "write_failed";

export type AdminCustomerArchiveResult =
  | {
      ok: true;
      customerId: string;
      archived: boolean;
      replayed: boolean;
    }
  | {
      ok: false;
      reason: AdminCustomerArchiveFailureReason;
    };

type CustomerArchiveRow = {
  id: string;
  archived_at: string | null;
};

const fetchCustomerArchiveState = async (db: D1Database, customerId: string) =>
  // Exclude merge tombstones so archive/unarchive never acts on a non-canonical
  // row. Deliberately do NOT filter archived_at here: unarchive must be able to
  // find an already-archived customer (the caller compares currentlyArchived
  // against the desired state).
  db
    .prepare(
      `
        SELECT id, archived_at
        FROM customers
        WHERE id = ?
          AND merged_into_id IS NULL
        LIMIT 1
      `
    )
    .bind(customerId)
    .first<CustomerArchiveRow>();

const createArchiveRequestHash = async (input: {
  action: "archive" | "unarchive";
  customerId: string;
  reason?: string;
}) =>
  sha256Hex(
    JSON.stringify({
      action: input.action,
      customerId: input.customerId,
      reason: input.reason?.trim() ?? null,
    })
  );


const resolveArchiveIdempotency = (
  idempotency: IdempotencyRow | null,
  requestHash: string,
  desiredArchived: boolean
): AdminCustomerArchiveResult | undefined => {
  if (!idempotency) return undefined;
  if (idempotency.request_hash !== requestHash) {
    return { ok: false, reason: "idempotency_conflict" };
  }
  if (idempotency.status === "succeeded" && idempotency.target_id) {
    return { ok: true, customerId: idempotency.target_id, archived: desiredArchived, replayed: true };
  }
  return { ok: false, reason: "idempotency_in_progress" };
};

const resolveArchiveBatchFailure = async (
  db: D1Database,
  idempotencyKey: string,
  requestHash: string,
  desiredArchived: boolean,
  error: unknown,
  nowIso: string
): Promise<AdminCustomerArchiveResult> => {
  try {
    const concurrent = await fetchAdminActionIdempotency(db, idempotencyKey, nowIso);
    return (
      resolveArchiveIdempotency(concurrent, requestHash, desiredArchived) ??
      mapActorTypeBatchError(error)
    );
  } catch {
    return mapActorTypeBatchError(error);
  }
};

export async function setAdminCustomerArchiveStatus(input: {
  db: D1Database;
  admin: AdminUser;
  customerId: string;
  action: "archive" | "unarchive";
  request: AdminCustomerArchiveRequest;
  now?: () => number;
}): Promise<AdminCustomerArchiveResult> {
  if (!isValidCustomerActionRequest(input.customerId, input.request)) {
    return { ok: false, reason: "invalid_request" };
  }

  const desiredArchived = input.action === "archive";
  if (!(await staffMayActOnCustomer(input.db, input.admin, input.customerId))) {
    return { ok: false, reason: "forbidden" };
  }

  const requestHash = await createArchiveRequestHash({
    action: input.action,
    customerId: input.customerId,
    reason: input.request.reason,
  });
  const nowMs = (input.now ?? Date.now)();
  const nowIso = toIso(new Date(nowMs));

  const idempotency = await fetchAdminActionIdempotency(input.db, input.request.idempotencyKey, nowIso);
  const idempotencyResult = resolveArchiveIdempotency(idempotency, requestHash, desiredArchived);
  if (idempotencyResult) return idempotencyResult;

  const customer = await fetchCustomerArchiveState(input.db, input.customerId);
  if (!customer) return { ok: false, reason: "not_found" };

  const currentlyArchived = customer.archived_at !== null;
  if (currentlyArchived === desiredArchived) {
    return { ok: false, reason: "invalid_transition" };
  }

  const idempotencyId = crypto.randomUUID();
  const expiresAt = toIso(new Date(nowMs + IDEMPOTENCY_TTL_MS));
  const auditAction = input.action === "archive" ? "admin_customer_archived" : "admin_customer_unarchived";
  const newArchivedAt = desiredArchived ? nowIso : null;
  const archiveScope = ownStoreUpdateScope(input.admin);

  try {
    await input.db.batch([
      startedIdempotencyStatement({
        db: input.db,
        id: idempotencyId,
        key: input.request.idempotencyKey,
        requestHash,
        expiresAt,
        nowIso,
      }),
      // Conditional UPDATE: only flips the row whose archived_at nullness still
      // matches what we read. If a concurrent writer changed it, changes()=0 and
      // the next statement aborts the batch.
      input.db
        .prepare(
          `
            UPDATE customers AS c
            SET archived_at = ?,
                updated_at = ?
            WHERE c.id = ?
              AND c.merged_into_id IS NULL
              AND c.archived_at IS ${currentlyArchived ? "NOT NULL" : "NULL"}${archiveScope.clause}
          `
        )
        .bind(newArchivedAt, nowIso, input.customerId, ...archiveScope.params),
      input.db
        .prepare(
          `
            -- Abort the batch (CHECK violation on actor_type) if the conditional
            -- customer update did not change exactly one row.
            INSERT INTO audit_logs (
              id, actor_type, actor_id, action, target_type, target_id, metadata_json
            )
            SELECT
              ?,
              CASE WHEN changes() = 1 THEN 'staff' ELSE 'customer_archive_transition_conflict' END,
              ?,
              ?,
              'customer',
              ?,
              ?
          `
        )
        .bind(
          crypto.randomUUID(),
          input.admin.id,
          auditAction,
          input.customerId,
          JSON.stringify({
            previousArchived: currentlyArchived,
            archived: desiredArchived,
            reason: input.request.reason?.trim() ?? null,
            adminRole: input.admin.role,
            // See the block audit above: staff may archive/restore since
            // 2026-08-26 and the effect is global, so record the acting store.
            adminStoreId: input.admin.store_id ?? null,
          })
        ),
      input.db
        .prepare(
          `
            UPDATE idempotency_keys
            SET status = 'succeeded',
                target_type = 'customer',
                target_id = ?,
                updated_at = ?
            WHERE id = ?
          `
        )
        .bind(input.customerId, nowIso, idempotencyId),
    ]);
  } catch (error) {
    if (await adminWriteWasRevoked(input.db, input.admin, error)) {
      return { ok: false, reason: "forbidden" };
    }
    return resolveArchiveBatchFailure(
      input.db,
      input.request.idempotencyKey,
      requestHash,
      desiredArchived,
      error,
      nowIso
    );
  }

  return { ok: true, customerId: input.customerId, archived: desiredArchived, replayed: false };
}
