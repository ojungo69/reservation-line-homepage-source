import { adminWriteGuard, adminWriteWasRevoked } from "./write-authorization";
import type { AdminUser } from "./access";
import { safeCaptureException } from "../sentry-helpers";
import { parseIsoInstantToCanonical } from "./parse-iso-instant";
import {
  buildCreateContext,
  guardImmutableStore,
  MAX_ID_LENGTH,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  fetchAdminActionIdempotency,
  isActorTypeBatchError,
  isAdminAllowedForStoreSettings,
  recoverFromCreateBatchFailure,
  sha256Hex,
  startedIdempotencyStatement,
  storeExists,
  succeededIdempotencyStatement,
  trimAndCap,
  type IdempotencyRow
} from "./settings-common";

// Tier C.3 4c — store_closures editor. Admin manages source='admin' rows
// (google_external_block source is reserved for the sync layer and never
// written through this endpoint). The schema has no `active` column, so
// DELETE here is a hard delete — there is no FK pointing at closures
// from other tables, so the operator can drop them freely. The audit
// log preserves the row history.

export type AdminClosureCreateRequest = {
  storeId: string;
  startsAt: string;
  endsAt: string;
  reason: string | null;
  idempotencyKey: string;
};

export type AdminClosureUpdateRequest = {
  storeId: string;
  startsAt: string;
  endsAt: string;
  reason: string | null;
};

export type AdminClosureCreateError =
  | "forbidden"
  | "invalid_request"
  | "missing_database"
  | "store_not_found"
  | "overlapping_reservations"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "write_failed";

export type AdminClosureUpdateError =
  | "forbidden"
  | "invalid_request"
  | "not_found"
  | "missing_database"
  | "store_not_found"
  | "immutable_source"
  | "immutable_store"
  | "overlapping_reservations"
  | "write_failed";

export type AdminClosureDeleteError =
  | "forbidden"
  | "invalid_request"
  | "not_found"
  | "missing_database"
  | "immutable_source"
  | "write_failed";

export type AdminClosureCreateResult =
  | { ok: true; closureId: string; replayed: boolean }
  | { ok: false; error: AdminClosureCreateError };

export type AdminClosureUpdateResult =
  | { ok: true; closureId: string }
  | { ok: false; error: AdminClosureUpdateError };

export type AdminClosureDeleteResult =
  | { ok: true; closureId: string }
  | { ok: false; error: AdminClosureDeleteError };

const MAX_REASON_LENGTH = 500;

// parseIsoInstant delegates to the shared parseIsoInstantToCanonical from
// ./parse-iso-instant which round-trips through Date.UTC, rejects invalid
// calendar dates, and normalises to the canonical `YYYY-MM-DDTHH:MM:SS.sssZ`
// form for sortable SQLite TEXT storage.
const parseIsoInstant = parseIsoInstantToCanonical;

const parseOptionalReason = (value: unknown): string | null | undefined => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_REASON_LENGTH) return undefined;
  return trimmed;
};

const parseCommonMutationFields = (body: unknown): AdminClosureUpdateRequest | null => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const raw = body as Record<string, unknown>;
  const storeId = trimAndCap(raw.storeId, MAX_ID_LENGTH);
  if (!storeId) return null;
  const startsAt = parseIsoInstant(raw.startsAt);
  const endsAt = parseIsoInstant(raw.endsAt);
  if (!startsAt || !endsAt) return null;
  if (Date.parse(startsAt) >= Date.parse(endsAt)) return null;
  const reason = parseOptionalReason(raw.reason);
  if (reason === undefined) return null;
  return { storeId, startsAt, endsAt, reason };
};

export const parseAdminClosureCreateRequest = (
  body: unknown
): AdminClosureCreateRequest | null => {
  const common = parseCommonMutationFields(body);
  if (!common) return null;
  const raw = body as Record<string, unknown>;
  const idempotencyKey = trimAndCap(raw.idempotencyKey, MAX_IDEMPOTENCY_KEY_LENGTH);
  if (!idempotencyKey) return null;
  return { ...common, idempotencyKey };
};

export const parseAdminClosureUpdateRequest = (
  body: unknown
): AdminClosureUpdateRequest | null => parseCommonMutationFields(body);

const createClosureRequestHash = async (input: AdminClosureUpdateRequest) =>
  sha256Hex(
    JSON.stringify({
      storeId: input.storeId,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      reason: input.reason
    })
  );

const resolveCreateIdempotency = (
  idempotency: IdempotencyRow | null,
  requestHash: string
): AdminClosureCreateResult | undefined => {
  if (!idempotency) return undefined;
  if (idempotency.request_hash !== requestHash) {
    return { ok: false, error: "idempotency_conflict" };
  }
  if (idempotency.status === "succeeded" && idempotency.target_id) {
    return { ok: true, closureId: idempotency.target_id, replayed: true };
  }
  return { ok: false, error: "idempotency_in_progress" };
};

type ClosureRow = {
  id: string;
  store_id: string;
  starts_at: string;
  ends_at: string;
  reason: string | null;
  source: "admin" | "google_external_block";
};

const fetchClosure = async (db: D1Database, id: string): Promise<ClosureRow | null> =>
  db
    .prepare(
      `SELECT id, store_id, starts_at, ends_at, reason, source FROM store_closures WHERE id = ?`
    )
    .bind(id)
    .first<ClosureRow>();

// Booking + reschedule paths treat any overlapping store_closures row as
// closed time. Creating or extending a closure across a window that still
// contains pending_approval / confirmed reservations would silently strand
// the customers inside the closure — the booking UI hides the slot but
// admin tools still see the row as confirmed. Block the write and force
// the operator to cancel or move the reservations first.
export const countOverlappingReservationsForClosure = async (input: {
  db: D1Database;
  storeId: string;
  startsAt: string;
  endsAt: string;
}): Promise<number> => {
  const row = await input.db
    .prepare(
      `SELECT COUNT(*) AS count FROM reservations
       WHERE store_id = ?
         AND status IN ('pending_approval', 'confirmed')
         AND start_at < ?
         AND end_at > ?`
    )
    .bind(input.storeId, input.endsAt, input.startsAt)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
};

async function handleClosureUpdateBatchError(
  db: D1Database,
  error: unknown,
  closureId: string
): Promise<AdminClosureUpdateResult> {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("overlapping_reservations")) {
    return { ok: false, error: "overlapping_reservations" };
  }
  if (isActorTypeBatchError(error)) {
    const fresh = await fetchClosure(db, closureId);
    if (!fresh) return { ok: false, error: "not_found" };
    if (fresh.source !== "admin") return { ok: false, error: "immutable_source" };
    return { ok: false, error: "write_failed" };
  }
  console.error("updateAdminClosure batch failed", {
    closureId,
    error: error instanceof Error ? error.message : String(error)
  });
  return { ok: false, error: "write_failed" };
}

export const createAdminClosure = async (input: {
  db: D1Database;
  admin: AdminUser;
  closureId?: string;
  request: AdminClosureCreateRequest;
  now?: () => number;
}): Promise<AdminClosureCreateResult> => {
  if (!isAdminAllowedForStoreSettings(input.admin, input.request.storeId)) {
    return { ok: false, error: "forbidden" };
  }
  const requestHash = await createClosureRequestHash(input.request);
  // Derive the idempotency clock before the TTL read so the read, the expires_at write, and the catch re-read share one injected now (B8).
  const { nowIso, expiresAt, idempotencyId } = buildCreateContext(input.now);
  const existingIdempotency = await fetchAdminActionIdempotency(input.db, input.request.idempotencyKey, nowIso);
  const idempotencyResult = resolveCreateIdempotency(existingIdempotency, requestHash);
  if (idempotencyResult) return idempotencyResult;

  if (!(await storeExists(input.db, input.request.storeId))) {
    return { ok: false, error: "store_not_found" };
  }
  const overlapCount = await countOverlappingReservationsForClosure({
    db: input.db,
    storeId: input.request.storeId,
    startsAt: input.request.startsAt,
    endsAt: input.request.endsAt
  });
  if (overlapCount > 0) {
    return { ok: false, error: "overlapping_reservations" };
  }
  const id = input.closureId ?? crypto.randomUUID();

  try {
    await input.db.batch([
      adminWriteGuard(input.db, input.admin),
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
          `INSERT INTO store_closures (
             id, store_id, starts_at, ends_at, reason, source, created_at
           ) VALUES (?, ?, ?, ?, ?, 'admin', ?)`
        )
        .bind(
          id,
          input.request.storeId,
          input.request.startsAt,
          input.request.endsAt,
          input.request.reason,
          nowIso
        ),
      input.db
        .prepare(
          `INSERT INTO audit_logs (
             id, actor_type, actor_id, action, target_type, target_id, metadata_json
           ) VALUES (?, 'staff', ?, 'settings.closures.create', 'store_closure', ?, ?)`
        )
        .bind(
          crypto.randomUUID(),
          input.admin.id,
          id,
          JSON.stringify({
            closureId: id,
            storeId: input.request.storeId,
            startsAt: input.request.startsAt,
            endsAt: input.request.endsAt,
            reason: input.request.reason,
            adminRole: input.admin.role
          })
        ),
      succeededIdempotencyStatement({
        db: input.db,
        idempotencyId,
        targetType: "store_closure",
        targetId: id,
        nowIso
      })
    ]);
  } catch (error) {
    if (await adminWriteWasRevoked(input.db, input.admin, error)) {
      return { ok: false, error: "forbidden" };
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("overlapping_reservations")) {
      return { ok: false, error: "overlapping_reservations" };
    }
    return recoverFromCreateBatchFailure({
      db: input.db,
      idempotencyKey: input.request.idempotencyKey,
      error,
      errorLabel: "createAdminClosure",
      nowIso,
      resolveReplay: (row) => resolveCreateIdempotency(row, requestHash)
    });
  }

  return { ok: true, closureId: id, replayed: false };
};

export const updateAdminClosure = async (input: {
  db: D1Database;
  admin: AdminUser;
  closureId: string;
  request: AdminClosureUpdateRequest;
  now?: () => number;
}): Promise<AdminClosureUpdateResult> => {
  const current = await fetchClosure(input.db, input.closureId);
  if (!current) {
    return { ok: false, error: "not_found" };
  }
  // Store scope is checked against the closure's authoritative store
  // (current.store_id), mirroring updateAdminService — a staff member can
  // only touch closures of their own store. Fetch → authz → storeExists is
  // the same order as updateAdminService, so an unauthorized staff request
  // cannot probe store existence via store_not_found.
  if (!isAdminAllowedForStoreSettings(input.admin, current.store_id)) {
    return { ok: false, error: "forbidden" };
  }
  if (!(await storeExists(input.db, input.request.storeId))) {
    return { ok: false, error: "store_not_found" };
  }
  // google_external_block-sourced closures are mirrored from Google Calendar
  // by the sync layer; allowing the admin endpoint to edit them would
  // silently desync the next reconcile. Refuse explicitly so the operator
  // adjusts the upstream Google event instead.
  if (current.source !== "admin") {
    return { ok: false, error: "immutable_source" };
  }
  // A closure belongs to its store; the update form must not relocate it to a
  // different store by sending another storeId in the body. Reject cross-store
  // moves so a privileged admin cannot reassign a closure across stores (parity
  // with the other settings mutations, e.g. settings-resources/services).
  const storeGuard = guardImmutableStore(current.store_id, input.request.storeId);
  if (storeGuard) return storeGuard;
  const overlapCount = await countOverlappingReservationsForClosure({
    db: input.db,
    // Check the closure's authoritative store (current.store_id), not the
    // request's, so the overlap guard always evaluates the store whose
    // reservations the closure actually affects. (After guardImmutableStore the
    // two are equal, but binding the DB value keeps this correct independently.)
    storeId: current.store_id,
    startsAt: input.request.startsAt,
    endsAt: input.request.endsAt
  });
  if (overlapCount > 0) {
    return { ok: false, error: "overlapping_reservations" };
  }

  try {
    await input.db.batch([
      adminWriteGuard(input.db, input.admin),
      input.db
        .prepare(
          `UPDATE store_closures
           SET store_id = ?, starts_at = ?, ends_at = ?, reason = ?
           WHERE id = ? AND source = 'admin'`
        )
        .bind(
          input.request.storeId,
          input.request.startsAt,
          input.request.endsAt,
          input.request.reason,
          input.closureId
        ),
      input.db
        .prepare(
          `INSERT INTO audit_logs (
             id, actor_type, actor_id, action, target_type, target_id, metadata_json
           ) VALUES (
             ?,
             CASE WHEN changes() = 1 THEN 'staff' ELSE 'closure_update_conflict' END,
             ?, 'settings.closures.update', 'store_closure', ?, ?
           )`
        )
        .bind(
          crypto.randomUUID(),
          input.admin.id,
          input.closureId,
          JSON.stringify({
            closureId: input.closureId,
            before: {
              storeId: current.store_id,
              startsAt: current.starts_at,
              endsAt: current.ends_at,
              reason: current.reason
            },
            after: {
              storeId: input.request.storeId,
              startsAt: input.request.startsAt,
              endsAt: input.request.endsAt,
              reason: input.request.reason
            },
            adminRole: input.admin.role
          })
        )
    ]);
  } catch (error) {
    if (await adminWriteWasRevoked(input.db, input.admin, error)) {
      return { ok: false, error: "forbidden" };
    }
    return handleClosureUpdateBatchError(input.db, error, input.closureId);
  }

  return { ok: true, closureId: input.closureId };
};

export const deleteAdminClosure = async (input: {
  db: D1Database;
  admin: AdminUser;
  closureId: string;
}): Promise<AdminClosureDeleteResult> => {
  const current = await fetchClosure(input.db, input.closureId);
  if (!current) {
    return { ok: false, error: "not_found" };
  }
  if (!isAdminAllowedForStoreSettings(input.admin, current.store_id)) {
    return { ok: false, error: "forbidden" };
  }
  if (current.source !== "admin") {
    return { ok: false, error: "immutable_source" };
  }

  try {
    await input.db.batch([
      adminWriteGuard(input.db, input.admin),
      input.db
        .prepare(`DELETE FROM store_closures WHERE id = ? AND source = 'admin'`)
        .bind(input.closureId),
      input.db
        .prepare(
          `INSERT INTO audit_logs (
             id, actor_type, actor_id, action, target_type, target_id, metadata_json
           ) VALUES (
             ?,
             CASE WHEN changes() = 1 THEN 'staff' ELSE 'closure_update_conflict' END,
             ?, 'settings.closures.delete', 'store_closure', ?, ?
           )`
        )
        .bind(
          crypto.randomUUID(),
          input.admin.id,
          input.closureId,
          JSON.stringify({
            closureId: input.closureId,
            before: {
              storeId: current.store_id,
              startsAt: current.starts_at,
              endsAt: current.ends_at,
              reason: current.reason
            },
            hardDelete: true,
            adminRole: input.admin.role
          })
        )
    ]);
  } catch (error) {
    if (await adminWriteWasRevoked(input.db, input.admin, error)) {
      return { ok: false, error: "forbidden" };
    }
    if (isActorTypeBatchError(error)) {
      const fresh = await fetchClosure(input.db, input.closureId);
      if (!fresh) return { ok: false, error: "not_found" };
      return { ok: false, error: "immutable_source" };
    }
    safeCaptureException(error instanceof Error ? error : new Error(String(error)), {
      tags: { component: "closures", op: "delete_batch_failed" },
      contexts: { closure: { closureId: input.closureId, storeId: current.store_id } }
    });
    console.error("deleteAdminClosure batch failed", {
      closureId: input.closureId,
      error: error instanceof Error ? error.message : String(error)
    });
    return { ok: false, error: "write_failed" };
  }

  return { ok: true, closureId: input.closureId };
};
