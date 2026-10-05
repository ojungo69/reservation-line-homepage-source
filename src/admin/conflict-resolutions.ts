import { adminWriteGuard, adminWriteWasRevoked } from "./write-authorization";
import type { AdminUser } from "./access";
import { parseDateJstToUtcIso } from "../date-parse";
import { captureBatchWriteFailure } from "../sentry-helpers";
import {
  buildCreateContext,
  fetchAdminActionIdempotency,
  isAdminPrivileged,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  sha256Hex,
  startedIdempotencyStatement,
  succeededIdempotencyStatement,
  trimAndCap
} from "./settings-common";
import { compactDedupeKey } from "../google/dedupe-key";
import { buildClosePendingChangeRequestsStatement } from "../reservations/transitions";
import { countOverlappingReservationsForClosure } from "./settings-closures";

// Types

type ConflictRow = {
  id: string;
  store_id: string;
  calendar_id: string;
  google_event_id: string;
  reservation_id: string | null;
  conflict_type: string;
  resolution_status: string;
  google_safe_snapshot_json: string;
};

type GoogleSnapshot = {
  start_at?: unknown;
  end_at?: unknown;
  summary?: unknown;
  /** Raw YYYY-MM-DD from Google all-day event `start.date` */
  start_date?: unknown;
  /** Raw YYYY-MM-DD from Google all-day event `end.date` (exclusive) */
  end_date?: unknown;
  all_day?: unknown;
};

type ReservationForCancel = {
  id: string;
  store_id: string;
  customer_id: string;
  status: string;
  version: number;
  line_identity_id: string | null;
  source: string;
};

type FailureReason =
  | "forbidden"
  | "invalid_request"
  | "not_found"
  | "invalid_conflict_type"
  | "already_resolved"
  | "invalid_snapshot"
  | "invalid_state"
  | "reservation_not_found"
  | "no_active_resource"
  | "overlapping_reservations"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "write_failed";

export type AllDayApproveRequest = {
  idempotencyKey: string;
  closureScope?: {
    reason?: string;
  };
};

export type AllDayRejectRequest = {
  idempotencyKey: string;
  reason?: string;
};

export type AllDayApproveResult =
  | { ok: true; closureId: string; replayed: boolean }
  | { ok: false; reason: FailureReason };

export type AllDayRejectResult =
  | { ok: true; replayed: boolean }
  | { ok: false; reason: FailureReason };

export type CancelApprovalRequest = {
  idempotencyKey: string;
  reason: string | null;
};

export type CancelApprovalResult =
  | { ok: true; reservationId: string; replayed: boolean }
  | { ok: false; reason: FailureReason };

export type RejectDeleteRequest = {
  idempotencyKey: string;
  reason: string | null;
};

export type RejectDeleteResult =
  | { ok: true; replayed: boolean }
  | { ok: false; reason: FailureReason };

// Helpers

/**
 * Validate that a string is a parseable UTC ISO timestamp in canonical form.
 * Rejects JS-normalized values like '2026-02-30T00:00:00.000Z' which
 * Date.parse accepts but silently shifts to March 2.
 */
const isValidIsoTimestamp = (s: string): boolean => {
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return false;
  // Canonical equality: the input must already be in the form that
  // toISOString() produces. Non-canonical inputs (e.g. Feb 30, offset
  // strings, missing fractional seconds) are rejected.
  return s === new Date(ms).toISOString();
};

const parseSnapshotDates = (json: string): { startAt: string; endAt: string; summary: string | null } | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const snapshot = parsed as GoogleSnapshot;

  // Primary: use start_at / end_at (always present for dateTime events,
  // and for date-only events that were imported by the updated import-sync).
  let startAt = typeof snapshot.start_at === "string" ? snapshot.start_at : undefined;
  let endAt = typeof snapshot.end_at === "string" ? snapshot.end_at : undefined;

  // Fallback: date-only snapshots from Google all-day events may have
  // start_date / end_date (YYYY-MM-DD) but no start_at / end_at in
  // legacy snapshots. Convert via JST midnight interpretation.
  if (!startAt && typeof snapshot.start_date === "string") {
    startAt = parseDateJstToUtcIso(snapshot.start_date) ?? undefined;
  }
  if (!endAt && typeof snapshot.end_date === "string") {
    endAt = parseDateJstToUtcIso(snapshot.end_date) ?? undefined;
  }

  if (!startAt || !endAt) return null;

  // Validate timestamps are parseable and start < end
  if (!isValidIsoTimestamp(startAt) || !isValidIsoTimestamp(endAt)) return null;
  const startMs = new Date(startAt).getTime();
  const endMs = new Date(endAt).getTime();
  if (startMs >= endMs) return null;

  const summary = typeof snapshot.summary === "string" && snapshot.summary.trim().length > 0
    ? snapshot.summary.trim()
    : null;
  return { startAt, endAt, summary };
};

const createRequestHash = async (payload: Record<string, unknown>): Promise<string> =>
  sha256Hex(JSON.stringify(payload));

const checkApprovalIdempotency = async (
  db: D1Database,
  idempotencyKey: string,
  requestHash: string,
  nowIso: string
): Promise<AllDayApproveResult | null> => {
  const existing = await fetchAdminActionIdempotency(db, idempotencyKey, nowIso);
  if (!existing) return null;
  if (existing.request_hash !== requestHash) {
    return { ok: false, reason: "idempotency_conflict" };
  }
  if (existing.status === "succeeded" && existing.target_id) {
    return { ok: true, closureId: existing.target_id, replayed: true };
  }
  return { ok: false, reason: "idempotency_in_progress" };
};

const checkRejectIdempotency = async (
  db: D1Database,
  idempotencyKey: string,
  requestHash: string,
  nowIso: string
): Promise<AllDayRejectResult | null> => {
  const existing = await fetchAdminActionIdempotency(db, idempotencyKey, nowIso);
  if (!existing) return null;
  if (existing.request_hash !== requestHash) {
    return { ok: false, reason: "idempotency_conflict" };
  }
  if (existing.status === "succeeded") {
    return { ok: true, replayed: true };
  }
  return { ok: false, reason: "idempotency_in_progress" };
};

type ConflictValidation = "not_found" | "invalid_conflict_type" | "already_resolved" | null;

const validateConflictType = (
  conflict: ConflictRow | null,
  expectedType: "google_all_day_event" | "reservation_event_deleted"
): ConflictValidation => {
  if (!conflict) return "not_found";
  if (conflict.conflict_type !== expectedType) return "invalid_conflict_type";
  if (conflict.resolution_status !== "open") return "already_resolved";
  return null;
};

// 期待する conflict_type を呼び出し側の引数にすると、全日イベント側の経路で
// 誤って "reservation_event_deleted" を渡しても型が通る (引数が両方の union
// なので)。本体は1つのまま、経路ごとに名前付きの入口を残して取り違えを防ぐ。
const validateConflictForAllDay = (conflict: ConflictRow | null): ConflictValidation =>
  validateConflictType(conflict, "google_all_day_event");

const validateConflictForReservationDelete = (conflict: ConflictRow | null): ConflictValidation =>
  validateConflictType(conflict, "reservation_event_deleted");

const revertConflictTo = async (
  db: D1Database,
  conflictId: string,
  adminId: string,
  fromStatus: "approved_as_closure" | "rejected" | "approved_as_cancel",
  claimedAt: string
): Promise<void> => {
  try {
    await db
      .prepare(
        `UPDATE google_calendar_conflicts
         SET resolution_status = 'open',
             resolved_at = NULL,
             resolved_by = NULL
         WHERE id = ?
           AND resolution_status = ?
           AND resolved_by = ? AND resolved_at = ?`
      )
      .bind(conflictId, fromStatus, adminId, claimedAt)
      .run();
  } catch {
    // best-effort; rare given batch already failed once
  }
};

const claimResolutionTransition = async (
  db: D1Database,
  conflictId: string,
  admin: AdminUser,
  toStatus: "approved_as_closure" | "rejected" | "approved_as_cancel",
  nowIso: string
): Promise<"claimed" | "already_resolved" | "forbidden" | "write_failed"> => {
  try {
    const results = await db.batch([
      adminWriteGuard(db, admin),
      db.prepare(`UPDATE google_calendar_conflicts
        SET resolution_status = ?, resolved_at = ?, resolved_by = ?
        WHERE id = ? AND resolution_status = 'open'`)
        .bind(toStatus, nowIso, admin.id, conflictId)
    ]);
    return Number(results[1].meta?.changes ?? 0) > 0 ? "claimed" : "already_resolved";
  } catch (error) {
    if (await adminWriteWasRevoked(db, admin, error)) return "forbidden";
    captureBatchWriteFailure(error, { component: "conflict-resolutions", op: "claim_failed" });
    return "write_failed";
  }
};

const handleResolutionBatchFailureForApprove = async (
  db: D1Database,
  conflictId: string,
  admin: AdminUser,
  idempotencyKey: string,
  requestHash: string,
  nowIso: string,
  error: unknown
): Promise<AllDayApproveResult> => {
  await revertConflictTo(db, conflictId, admin.id, "approved_as_closure", nowIso);
  if (await adminWriteWasRevoked(db, admin, error)) return { ok: false, reason: "forbidden" };
  try {
    const concurrent = await fetchAdminActionIdempotency(db, idempotencyKey, nowIso);
    if (
      concurrent?.request_hash === requestHash &&
      concurrent?.status === "succeeded" &&
      concurrent?.target_id
    ) {
      return { ok: true, closureId: concurrent.target_id, replayed: true };
    }
  } catch (lookupError) {
    captureBatchWriteFailure(lookupError, { component: "conflict-resolutions", op: "idempotency_lookup_failed", helper: "all_day_approve" });
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("overlapping_reservations")) {
    return { ok: false, reason: "overlapping_reservations" };
  }
  // Genuine batch-write failure (not a concurrent replay).
  captureBatchWriteFailure(error, { component: "conflict-resolutions", op: "batch_write_failed", helper: "all_day_approve" });
  return { ok: false, reason: "write_failed" };
};

const handleResolutionBatchFailureForReject = async (
  db: D1Database,
  conflictId: string,
  admin: AdminUser,
  idempotencyKey: string,
  requestHash: string,
  nowIso: string,
  error: unknown
): Promise<AllDayRejectResult> => {
  await revertConflictTo(db, conflictId, admin.id, "rejected", nowIso);
  if (await adminWriteWasRevoked(db, admin, error)) return { ok: false, reason: "forbidden" };
  try {
    const concurrent = await fetchAdminActionIdempotency(db, idempotencyKey, nowIso);
    if (
      concurrent?.request_hash === requestHash &&
      concurrent?.status === "succeeded"
    ) {
      return { ok: true, replayed: true };
    }
  } catch (lookupError) {
    captureBatchWriteFailure(lookupError, { component: "conflict-resolutions", op: "idempotency_lookup_failed", helper: "conflict_reject" });
  }
  // Genuine batch-write failure (not a concurrent replay). See approve helper.
  captureBatchWriteFailure(error, { component: "conflict-resolutions", op: "batch_write_failed", helper: "conflict_reject" });
  return { ok: false, reason: "write_failed" };
};

// Approve: all-day conflict → closure + calendar_sync_job

export async function approveAllDayAsClosure(input: {
  db: D1Database;
  admin: AdminUser;
  conflictId: string;
  request: AllDayApproveRequest;
  now?: () => number;
}): Promise<AllDayApproveResult> {
  // Role gate: owner + system_admin only
  if (!isAdminPrivileged(input.admin.role)) {
    return { ok: false, reason: "forbidden" };
  }

  const idempotencyKey = trimAndCap(input.request.idempotencyKey, MAX_IDEMPOTENCY_KEY_LENGTH);
  if (!idempotencyKey) {
    return { ok: false, reason: "invalid_request" };
  }

  const closureReason = input.request.closureScope?.reason === undefined
    ? null
    : trimAndCap(input.request.closureScope.reason, 500);

  const requestHash = await createRequestHash({
    action: "all_day_approve_as_closure",
    conflictId: input.conflictId,
    closureReason
  });

  // Derive the idempotency clock before the TTL read so the read, the
  // `expires_at` write, and the catch re-read all judge expiry against one
  // injected `now` (B8: no wall-clock/injected-clock skew at the TTL boundary).
  const nowMs = (input.now ?? Date.now)();
  const nowIso = new Date(nowMs).toISOString();

  const idempotencyResult = await checkApprovalIdempotency(input.db, idempotencyKey, requestHash, nowIso);
  if (idempotencyResult) return idempotencyResult;

  const conflict = await fetchConflict(input.db, input.conflictId);
  const validationError = validateConflictForAllDay(conflict);
  if (validationError) return { ok: false, reason: validationError };
  const validConflict = conflict as ConflictRow;

  const snapshot = parseSnapshotDates(validConflict.google_safe_snapshot_json);
  if (!snapshot) {
    return { ok: false, reason: "invalid_snapshot" };
  }

  const overlapCount = await countOverlappingReservationsForClosure({
    db: input.db,
    storeId: validConflict.store_id,
    startsAt: snapshot.startAt,
    endsAt: snapshot.endAt
  });
  if (overlapCount > 0) {
    return { ok: false, reason: "overlapping_reservations" };
  }

  const { expiresAt, idempotencyId } = buildCreateContext(() => nowMs);
  const closureId = crypto.randomUUID();
  const reason = closureReason ?? `Google全日予定からの休業承認 (${snapshot.summary ?? validConflict.google_event_id})`;

  // Validate that the conflict's calendar_id matches the store's current
  // google_calendar_id. Google event IDs are only unique per calendar, so
  // enqueuing a sync job against the wrong calendar could mutate or link
  // the wrong event after calendar configuration drift.
  const storeCalendar = await input.db
    .prepare(
      `SELECT google_calendar_id FROM stores WHERE id = ? LIMIT 1`
    )
    .bind(validConflict.store_id)
    .first<{ google_calendar_id: string | null }>();

  if (!storeCalendar?.google_calendar_id || storeCalendar.google_calendar_id !== validConflict.calendar_id) {
    return { ok: false, reason: "invalid_request" };
  }

  // Fetch the representative resource for this store.
  // Deterministic: ORDER BY created_at ASC, id ASC → always picks the same resource.
  const representativeResource = await input.db
    .prepare(
      `SELECT id FROM store_resources
       WHERE store_id = ? AND active = 1
       ORDER BY created_at ASC, id ASC
       LIMIT 1`
    )
    .bind(validConflict.store_id)
    .first<{ id: string }>();

  if (!representativeResource) {
    return { ok: false, reason: "no_active_resource" };
  }

  // Race-condition guard: claim the conflict transition first as a single
  // statement. If a concurrent request with a different idempotency key
  // already claimed the transition, this matches 0 rows and we abort BEFORE
  // creating duplicate closure / audit / idempotency rows.
  const claim = await claimResolutionTransition(input.db, input.conflictId, input.admin, "approved_as_closure", nowIso);
  if (claim !== "claimed") return { ok: false, reason: claim };

  // Publish round-trip: in addition to the store_closures record, create
  // an external_blocks row linked to the representative resource and the
  // original Google event. Then enqueue a calendar_sync_job so the sync
  // worker can upsert the block back to the Google Calendar.
  const externalBlockId = crypto.randomUUID();
  const syncJobDedupeKey = compactDedupeKey(
    `external_block:${externalBlockId}:google:upsert:closure:${closureId}`,
    "calendar-sync:external-block-upsert"
  );

  try {
    await input.db.batch([
      adminWriteGuard(input.db, input.admin),
      startedIdempotencyStatement({
        db: input.db,
        id: idempotencyId,
        key: idempotencyKey,
        requestHash,
        expiresAt,
        nowIso
      }),
      input.db
        .prepare(
          `INSERT INTO store_closures (id, store_id, starts_at, ends_at, reason, source, created_at)
           VALUES (?, ?, ?, ?, ?, 'admin', ?)`
        )
        .bind(closureId, validConflict.store_id, snapshot.startAt, snapshot.endAt, reason, nowIso),
      // External block: links closure to the representative resource and
      // the original Google event id for round-trip sync.
      input.db
        .prepare(
          `INSERT INTO external_blocks (
             id, store_id, resource_id, source, title_snapshot,
             start_at, end_at, status, google_event_id,
             created_by, created_at, updated_at
           ) VALUES (?, ?, ?, 'admin_block', ?, ?, ?, 'active', ?, ?, ?, ?)`
        )
        .bind(
          externalBlockId,
          validConflict.store_id,
          representativeResource.id,
          snapshot.summary,
          snapshot.startAt,
          snapshot.endAt,
          validConflict.google_event_id,
          input.admin.id,
          nowIso,
          nowIso
        ),
      // Calendar sync job: tells the sync worker to upsert this block
      // back to Google Calendar.
      input.db
        .prepare(
          `INSERT OR IGNORE INTO calendar_sync_jobs (
             id, dedupe_key, owner_type, owner_id, google_action, status, available_at
           ) VALUES (?, ?, 'external_block', ?, 'upsert', 'queued', ?)`
        )
        .bind(
          crypto.randomUUID(),
          syncJobDedupeKey,
          externalBlockId,
          nowIso
        ),
      input.db
        .prepare(
          `INSERT INTO audit_logs (
             id, actor_type, actor_id, action, target_type, target_id, metadata_json
           ) VALUES (?, 'staff', ?, 'all_day_conflict_approved_as_closure', 'google_calendar_conflict', ?, ?)`
        )
        .bind(
          crypto.randomUUID(),
          input.admin.id,
          input.conflictId,
          JSON.stringify({
            conflictId: input.conflictId,
            closureId,
            externalBlockId,
            resourceId: representativeResource.id,
            syncJobDedupeKey,
            storeId: validConflict.store_id,
            startsAt: snapshot.startAt,
            endsAt: snapshot.endAt,
            reason,
            adminRole: input.admin.role
          })
        ),
      succeededIdempotencyStatement({
        db: input.db,
        idempotencyId,
        targetType: "all_day_approval",
        targetId: closureId,
        nowIso
      })
    ]);
  } catch (error) {
    return handleResolutionBatchFailureForApprove(
      input.db,
      input.conflictId,
      input.admin,
      idempotencyKey,
      requestHash,
      nowIso,
      error
    );
  }

  return { ok: true, closureId, replayed: false };
}

// Reject: all-day conflict → rejected (no closure, no sync_job)

export async function rejectAllDayConflict(input: {
  db: D1Database;
  admin: AdminUser;
  conflictId: string;
  request: AllDayRejectRequest;
  now?: () => number;
}): Promise<AllDayRejectResult> {
  // Role gate: owner + system_admin only
  if (!isAdminPrivileged(input.admin.role)) {
    return { ok: false, reason: "forbidden" };
  }

  const idempotencyKey = trimAndCap(input.request.idempotencyKey, MAX_IDEMPOTENCY_KEY_LENGTH);
  if (!idempotencyKey) {
    return { ok: false, reason: "invalid_request" };
  }

  const rejectReason = input.request.reason === undefined
    ? null
    : trimAndCap(input.request.reason, 500);

  const requestHash = await createRequestHash({
    action: "all_day_reject",
    conflictId: input.conflictId,
    reason: rejectReason
  });

  // Derive the idempotency clock before the TTL read so read + write + catch
  // re-read share one injected `now` (B8).
  const nowMs = (input.now ?? Date.now)();
  const nowIso = new Date(nowMs).toISOString();

  const idempotencyResult = await checkRejectIdempotency(input.db, idempotencyKey, requestHash, nowIso);
  if (idempotencyResult) return idempotencyResult;

  const conflict = await fetchConflict(input.db, input.conflictId);
  const validationError = validateConflictForAllDay(conflict);
  if (validationError) return { ok: false, reason: validationError };
  const validConflict = conflict as ConflictRow;

  const { expiresAt, idempotencyId } = buildCreateContext(() => nowMs);

  const claim = await claimResolutionTransition(input.db, input.conflictId, input.admin, "rejected", nowIso);
  if (claim !== "claimed") return { ok: false, reason: claim };

  try {
    await input.db.batch([
      adminWriteGuard(input.db, input.admin),
      startedIdempotencyStatement({
        db: input.db,
        id: idempotencyId,
        key: idempotencyKey,
        requestHash,
        expiresAt,
        nowIso
      }),
      input.db
        .prepare(
          `INSERT INTO audit_logs (
             id, actor_type, actor_id, action, target_type, target_id, metadata_json
           ) VALUES (?, 'staff', ?, 'all_day_conflict_rejected', 'google_calendar_conflict', ?, ?)`
        )
        .bind(
          crypto.randomUUID(),
          input.admin.id,
          input.conflictId,
          JSON.stringify({
            conflictId: input.conflictId,
            storeId: validConflict.store_id,
            reason: rejectReason,
            adminRole: input.admin.role
          })
        ),
      succeededIdempotencyStatement({
        db: input.db,
        idempotencyId,
        targetType: "all_day_rejection",
        targetId: input.conflictId,
        nowIso
      })
    ]);
  } catch (error) {
    return handleResolutionBatchFailureForReject(
      input.db,
      input.conflictId,
      input.admin,
      idempotencyKey,
      requestHash,
      nowIso,
      error
    );
  }

  return { ok: true, replayed: false };
}

// Cancel Approval idempotency helpers

const checkCancelApprovalIdempotency = async (
  db: D1Database,
  idempotencyKey: string,
  requestHash: string,
  nowIso: string
): Promise<CancelApprovalResult | null> => {
  const existing = await fetchAdminActionIdempotency(db, idempotencyKey, nowIso);
  if (!existing) return null;
  if (existing.request_hash !== requestHash) {
    return { ok: false, reason: "idempotency_conflict" };
  }
  if (existing.status === "succeeded" && existing.target_id) {
    return { ok: true, reservationId: existing.target_id, replayed: true };
  }
  return { ok: false, reason: "idempotency_in_progress" };
};

const handleResolutionBatchFailureForCancelApproval = async (
  db: D1Database,
  conflictId: string,
  admin: AdminUser,
  idempotencyKey: string,
  requestHash: string,
  nowIso: string,
  error: unknown
): Promise<CancelApprovalResult> => {
  await revertConflictTo(db, conflictId, admin.id, "approved_as_cancel", nowIso);
  if (await adminWriteWasRevoked(db, admin, error)) return { ok: false, reason: "forbidden" };
  try {
    const concurrent = await fetchAdminActionIdempotency(db, idempotencyKey, nowIso);
    if (
      concurrent?.request_hash === requestHash &&
      concurrent?.status === "succeeded" &&
      concurrent?.target_id
    ) {
      return { ok: true, reservationId: concurrent.target_id, replayed: true };
    }
  } catch (lookupError) {
    captureBatchWriteFailure(lookupError, { component: "conflict-resolutions", op: "idempotency_lookup_failed", helper: "reservation_cancel_approval" });
  }
  // Genuine batch-write failure (not a concurrent replay). See approve helper.
  captureBatchWriteFailure(error, { component: "conflict-resolutions", op: "batch_write_failed", helper: "reservation_cancel_approval" });
  return { ok: false, reason: "write_failed" };
};

const fetchConflict = async (db: D1Database, conflictId: string): Promise<ConflictRow | null> =>
  db
    .prepare(
      `SELECT id, store_id, calendar_id, google_event_id, reservation_id,
              conflict_type, resolution_status, google_safe_snapshot_json
       FROM google_calendar_conflicts
       WHERE id = ?
       LIMIT 1`
    )
    .bind(conflictId)
    .first<ConflictRow>();

// Approve: reservation_event_deleted → cancel reservation + release locks

export async function approveReservationDeleteAsCancel(input: {
  db: D1Database;
  admin: AdminUser;
  conflictId: string;
  request: CancelApprovalRequest;
  now?: () => number;
}): Promise<CancelApprovalResult> {
  if (!isAdminPrivileged(input.admin.role)) {
    return { ok: false, reason: "forbidden" };
  }

  const idempotencyKey = trimAndCap(input.request.idempotencyKey, MAX_IDEMPOTENCY_KEY_LENGTH);
  if (!idempotencyKey) {
    return { ok: false, reason: "invalid_request" };
  }

  const requestHash = await createRequestHash({
    action: "reservation_delete_approve_as_cancel",
    conflictId: input.conflictId,
    reason: input.request.reason
  });

  // Derive the idempotency clock before the TTL read so read + write + catch
  // re-read share one injected `now` (B8).
  const nowMs = (input.now ?? Date.now)();
  const nowIso = new Date(nowMs).toISOString();

  const idempotencyResult = await checkCancelApprovalIdempotency(input.db, idempotencyKey, requestHash, nowIso);
  if (idempotencyResult) return idempotencyResult;

  const conflict = await fetchConflict(input.db, input.conflictId);
  const validationError = validateConflictForReservationDelete(conflict);
  if (validationError) return { ok: false, reason: validationError };
  const validConflict = conflict as ConflictRow;

  if (!validConflict.reservation_id) {
    return { ok: false, reason: "reservation_not_found" };
  }

  // Fetch the reservation for version + eligibility checks
  const reservation = await input.db
    .prepare(
      `SELECT id, store_id, customer_id, status, version, line_identity_id, source
       FROM reservations
       WHERE id = ?
       LIMIT 1`
    )
    .bind(validConflict.reservation_id)
    .first<ReservationForCancel>();

  if (!reservation) {
    return { ok: false, reason: "reservation_not_found" };
  }
  if (reservation.status !== "pending_approval" && reservation.status !== "confirmed") {
    return { ok: false, reason: "invalid_state" };
  }

  const eligibleForCustomerLine = reservation.line_identity_id !== null;

  const { expiresAt, idempotencyId } = buildCreateContext(() => nowMs);
  const newVersion = reservation.version + 1;
  const reason = input.request.reason ?? `Google削除に基づく予約キャンセル承認 (conflict: ${input.conflictId})`;

  // Compute the canonical restore dedupe_key that import-sync would have created
  const restoreDedupeKey = compactDedupeKey(
    `reservation:${reservation.id}:google:upsert:restore:${validConflict.google_event_id}`,
    "calendar-sync:reservation-restore"
  );

  // Race-safe claim
  const claim = await claimResolutionTransition(input.db, input.conflictId, input.admin, "approved_as_cancel", nowIso);
  if (claim !== "claimed") return { ok: false, reason: claim };

  // Build the EXISTS guard that ensures all side-effects only fire when
  // THIS operation's reservation UPDATE actually took effect.
  const existsGuard = `EXISTS (SELECT 1 FROM reservations WHERE id = ? AND status = 'cancelled_by_admin' AND version = ? AND cancelled_at = ? AND cancelled_by = ?)`;
  const existsBindings = [reservation.id, newVersion, nowIso, input.admin.id] as const;

  const notificationDedupeKey = `reservation:${reservation.id}:notif:cancelled_by_admin:approved_as_cancel:v${newVersion}`;

  try {
    const statements: D1PreparedStatement[] = [
      adminWriteGuard(input.db, input.admin),
      // (1) idempotency started
      startedIdempotencyStatement({
        db: input.db,
        id: idempotencyId,
        key: idempotencyKey,
        requestHash,
        expiresAt,
        nowIso
      }),
      // (2) UPDATE reservation
      input.db
        .prepare(
          `UPDATE reservations
           SET status = 'cancelled_by_admin',
               cancelled_at = ?,
               cancelled_by = ?,
               version = ?,
               updated_at = ?
           WHERE id = ?
             AND status IN ('pending_approval', 'confirmed')
             AND version = ?`
        )
        .bind(nowIso, input.admin.id, newVersion, nowIso, reservation.id, reservation.version),
      // (3) INSERT slot_lock_history
      input.db
        .prepare(
          `INSERT INTO slot_lock_history (id, slot_lock_id, store_id, resource_id, old_slot_at, new_slot_at, old_owner_id, new_owner_id, action, actor_type, actor_id, reason, created_at)
           SELECT lower(hex(randomblob(16))), id, store_id, resource_id, slot_at, NULL, owner_id, NULL, 'released', 'staff', ?, ?, ?
           FROM slot_locks
           WHERE owner_type = 'reservation' AND owner_id = ?
             AND ${existsGuard}`
        )
        .bind(input.admin.id, reason, nowIso, reservation.id, ...existsBindings),
      // (4) DELETE slot_locks
      input.db
        .prepare(
          `DELETE FROM slot_locks
           WHERE owner_type = 'reservation' AND owner_id = ?
             AND ${existsGuard}`
        )
        .bind(reservation.id, ...existsBindings),
      // (5) DELETE customer_time_locks
      input.db
        .prepare(
          `DELETE FROM customer_time_locks
           WHERE owner_type = 'reservation' AND owner_id = ?
             AND ${existsGuard}`
        )
        .bind(reservation.id, ...existsBindings),
      // (5b) この予約に対する pending の変更申請を閉じる (terminal 遷移の共通処理)。
      buildClosePendingChangeRequestsStatement({
        db: input.db,
        reservationId: reservation.id,
        nowIso,
        terminalGuardSql: existsGuard,
        terminalGuardBinds: existsBindings
      })
    ];

    // (6) notification_jobs (only for eligible customers)
    if (eligibleForCustomerLine) {
      statements.push(
        input.db
          .prepare(
            `INSERT OR IGNORE INTO notification_jobs (
               id, dedupe_key, template_key, recipient_type, recipient_id,
               reservation_id, status, attempts, available_at, payload_json
             )
             SELECT ?, ?, 'reservation_cancelled_by_admin', 'customer', customer_id,
                    id, 'queued', 0, ?, NULL
             FROM reservations
             WHERE id = ? AND status = 'cancelled_by_admin' AND version = ?
               AND cancelled_at = ? AND cancelled_by = ?`
          )
          .bind(
            crypto.randomUUID(),
            notificationDedupeKey,
            nowIso,
            reservation.id,
            newVersion,
            nowIso,
            input.admin.id
          )
      );
    }

    // (7) supersede canonical-restore calendar_sync_job
    statements.push(
      input.db
        .prepare(
          `UPDATE calendar_sync_jobs
           SET status = 'succeeded',
               last_error = 'superseded_by_approved_cancel',
               updated_at = ?
           WHERE owner_type = 'reservation' AND owner_id = ?
             AND google_action = 'upsert'
             AND status IN ('queued', 'retryable')
             AND dedupe_key = ?
             AND ${existsGuard}`
        )
        .bind(nowIso, reservation.id, restoreDedupeKey, ...existsBindings)
    );

    // (7b) Enqueue a Google delete job to clean up if the restore already
    // succeeded (i.e. the event was re-created on Google before the operator
    // approved the cancel). Without this, a succeeded restore leaves a zombie
    // Google event that no longer corresponds to a live D1 reservation.
    const deleteDedupeKey = compactDedupeKey(
      `reservation:${reservation.id}:google:delete:approved_as_cancel:v${newVersion}`,
      "calendar-sync:reservation-delete"
    );
    // (8) delete sync job + audit_logs + (9) idempotency succeeded
    statements.push(
      input.db
        .prepare(
          `INSERT OR IGNORE INTO calendar_sync_jobs (
             id, dedupe_key, owner_type, owner_id, google_action, status, available_at
           )
           SELECT ?, ?, 'reservation', ?, 'delete', 'queued', ?
           WHERE ${existsGuard}`
        )
        .bind(
          crypto.randomUUID(),
          deleteDedupeKey,
          reservation.id,
          nowIso,
          ...existsBindings
        ),
      input.db
        .prepare(
          `INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, metadata_json)
           SELECT ?, 'staff', ?, 'reservation_event_deleted_approved_as_cancel', 'google_calendar_conflict', ?, ?
           WHERE ${existsGuard}`
        )
        .bind(
          crypto.randomUUID(),
          input.admin.id,
          input.conflictId,
          JSON.stringify({
            conflictId: input.conflictId,
            reservationId: reservation.id,
            storeId: validConflict.store_id,
            reason,
            previousVersion: reservation.version,
            newVersion,
            adminRole: input.admin.role,
            eligibleForCustomerLine
          }),
          ...existsBindings
        ),
      input.db
        .prepare(
          `UPDATE idempotency_keys
           SET status = 'succeeded', target_type = 'reservation_cancel_approval', target_id = ?, updated_at = ?
           WHERE id = ?
             AND ${existsGuard}`
        )
        .bind(reservation.id, nowIso, idempotencyId, ...existsBindings)
    );

    await input.db.batch(statements);
  } catch (error) {
    return handleResolutionBatchFailureForCancelApproval(
      input.db,
      input.conflictId,
      input.admin,
      idempotencyKey,
      requestHash,
      nowIso,
      error
    );
  }

  // Post-batch verification: confirm THIS operation's reservation UPDATE took
  // effect. All 4 columns must match — status + version + cancelled_at + cancelled_by.
  // Without the cancelled_at/cancelled_by check, a concurrent cancel by a
  // different admin that coincidentally lands on the same newVersion would
  // pass the 2-column check, returning ok:true for side-effects that the
  // EXISTS guard silently dropped (cancelled_by mismatch).
  const postReservation = await input.db
    .prepare(
      `SELECT status, version, cancelled_at, cancelled_by
       FROM reservations WHERE id = ? LIMIT 1`
    )
    .bind(reservation.id)
    .first<{ status: string; version: number; cancelled_at: string | null; cancelled_by: string | null }>();

  if (
    postReservation?.status !== "cancelled_by_admin" ||
    postReservation?.version !== newVersion ||
    postReservation?.cancelled_at !== nowIso ||
    postReservation?.cancelled_by !== input.admin.id
  ) {
    // Race lost: revert conflict to open
    await revertConflictTo(input.db, input.conflictId, input.admin.id, "approved_as_cancel", nowIso);
    return { ok: false, reason: "invalid_state" };
  }

  return { ok: true, reservationId: reservation.id, replayed: false };
}

// Reject: reservation_event_deleted → rejected (no reservation mutation)

export async function rejectReservationDeleteConflict(input: {
  db: D1Database;
  admin: AdminUser;
  conflictId: string;
  request: RejectDeleteRequest;
  now?: () => number;
}): Promise<RejectDeleteResult> {
  if (!isAdminPrivileged(input.admin.role)) {
    return { ok: false, reason: "forbidden" };
  }

  const idempotencyKey = trimAndCap(input.request.idempotencyKey, MAX_IDEMPOTENCY_KEY_LENGTH);
  if (!idempotencyKey) {
    return { ok: false, reason: "invalid_request" };
  }

  const rejectReason = input.request.reason == null
    ? null
    : trimAndCap(input.request.reason, 500);

  const requestHash = await createRequestHash({
    action: "reservation_delete_reject",
    conflictId: input.conflictId,
    reason: rejectReason
  });

  // Derive the idempotency clock before the TTL read so read + write + catch
  // re-read share one injected `now` (B8).
  const nowMs = (input.now ?? Date.now)();
  const nowIso = new Date(nowMs).toISOString();

  const idempotencyResult = await checkRejectIdempotency(input.db, idempotencyKey, requestHash, nowIso);
  if (idempotencyResult) return idempotencyResult;

  const conflict = await fetchConflict(input.db, input.conflictId);
  const validationError = validateConflictForReservationDelete(conflict);
  if (validationError) return { ok: false, reason: validationError };
  const validConflict = conflict as ConflictRow;

  const { expiresAt, idempotencyId } = buildCreateContext(() => nowMs);

  const claim = await claimResolutionTransition(input.db, input.conflictId, input.admin, "rejected", nowIso);
  if (claim !== "claimed") return { ok: false, reason: claim };

  // Ensure a restore job is queued so the Google event gets re-created.
  // If a prior restore already succeeded for a different etag the INSERT OR
  // IGNORE with a noEtag sentinel will create a fresh queued row. If one is
  // already queued/retryable the UNIQUE constraint on dedupe_key makes this
  // a no-op.
  const restoreDedupeKey = compactDedupeKey(
    `reservation:${validConflict.reservation_id}:google:upsert:restore:${validConflict.google_event_id}:etag:noEtag`,
    "calendar-sync:reservation-restore"
  );

  try {
    await input.db.batch([
      adminWriteGuard(input.db, input.admin),
      startedIdempotencyStatement({
        db: input.db,
        id: idempotencyId,
        key: idempotencyKey,
        requestHash,
        expiresAt,
        nowIso
      }),
      input.db
        .prepare(
          `INSERT INTO audit_logs (
             id, actor_type, actor_id, action, target_type, target_id, metadata_json
           ) VALUES (?, 'staff', ?, 'reservation_event_deleted_rejected', 'google_calendar_conflict', ?, ?)`
        )
        .bind(
          crypto.randomUUID(),
          input.admin.id,
          input.conflictId,
          JSON.stringify({
            conflictId: input.conflictId,
            reservationId: validConflict.reservation_id,
            storeId: validConflict.store_id,
            reason: rejectReason,
            adminRole: input.admin.role
          })
        ),
      // Enqueue a restore job so the deleted Google event gets re-created.
      // No EXISTS guard needed — the reject path does not mutate the
      // reservation, so the claim success is the only precondition.
      input.db
        .prepare(
          `INSERT OR IGNORE INTO calendar_sync_jobs (
             id, dedupe_key, owner_type, owner_id, google_action, status, available_at
           ) VALUES (?, ?, 'reservation', ?, 'upsert', 'queued', ?)`
        )
        .bind(
          crypto.randomUUID(),
          restoreDedupeKey,
          validConflict.reservation_id,
          nowIso
        ),
      succeededIdempotencyStatement({
        db: input.db,
        idempotencyId,
        targetType: "reservation_delete_rejection",
        targetId: input.conflictId,
        nowIso
      })
    ]);
  } catch (error) {
    return handleResolutionBatchFailureForReject(
      input.db,
      input.conflictId,
      input.admin,
      idempotencyKey,
      requestHash,
      nowIso,
      error
    );
  }

  return { ok: true, replayed: false };
}
