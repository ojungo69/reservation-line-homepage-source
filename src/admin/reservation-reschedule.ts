import type { AdminUser } from "./access";
import { parseStrictIsoOffsetInstantMs } from "./parse-iso-instant";
import { isNonEmptyString, toIso, addMinutes, parseStartAt } from "./reservation-time-utils";
import { IDEMPOTENCY_TTL_MS, sha256Hex } from "./settings-common";
import { ensureBusinessTime } from "../reservations/business-hours";
import {
  generateSlotTimesForDuration,
  MAX_TOTAL_SERVICE_DURATION_MINUTES,
  RESERVATION_INTERVAL_MINUTES,
  SLOT_LOCK_INTERVAL_MINUTES
} from "../reservations/slot-times";
import {
  buildRescheduleStatements as buildTransitionRescheduleStatements,
  CUSTOMER_TIME_LOCK_PHONE_HASH_SQL
} from "../reservations/transitions";
import { classifyReservationWriteError } from "../reservations/write-error";
import { captureBatchWriteFailure } from "../sentry-helpers";
import { adminWriteGuard, adminWriteSnapshot, adminWriteWasRevoked } from "./write-authorization";

export type AdminRescheduleReservationRequest = {
  idempotencyKey: string;
  startAt: string;
  treatmentMinutes?: number;
};

export const RESCHEDULE_PREVIEW_CONTRACT = "calendar-interactions-v1";

export type AdminReschedulePreviewRequest = {
  contractVersion: typeof RESCHEDULE_PREVIEW_CONTRACT;
  expectedVersion: number;
  intent:
    | { kind: "move"; startAt: string }
    | { kind: "resize"; treatmentMinutes: number }
    | { kind: "undo"; inverseOfOperationId: string };
};

export type AdminRescheduleCommitRequest = AdminReschedulePreviewRequest & {
  idempotencyKey: string;
  previewFingerprint: string;
};

type AdminRescheduleReservationSuccess = {
  ok: true;
  reservationId: string;
  status: "pending_approval" | "confirmed";
  startAt: string;
  endAt: string;
  replayed: boolean;
};

type AdminRescheduleReservationFailure = {
  ok: false;
  reason:
    | "invalid_request"
    | "forbidden"
    | "not_found"
    | "invalid_transition"
    | "idempotency_conflict"
    | "idempotency_in_progress"
    | "invalid_time"
    | "outside_business_hours"
    | "store_closed"
    | "slot_unavailable"
    | "customer_time_conflict"
    | "write_failed";
};

export type AdminRescheduleReservationResult =
  | AdminRescheduleReservationSuccess
  | AdminRescheduleReservationFailure;

type ReservationRow = {
  id: string;
  store_id: string;
  customer_id: string;
  resource_id: string;
  line_identity_id: string | null;
  status:
    | "pending_approval"
    | "confirmed"
    | "rejected"
    | "expired"
    | "cancelled_by_customer"
    | "cancelled_by_admin"
    | "completed"
    | "no_show";
  start_at: string;
  end_at: string;
  duration_minutes: number;
  pending_expires_at: string | null;
  version: number;
  timezone: string;
  checked_in_at: string | null;
};

type IdempotencyRow = {
  status: "started" | "succeeded" | "failed";
  target_id: string | null;
  request_hash: string | null;
};

type ReservationResultRow = {
  id: string;
  status: "pending_approval" | "confirmed";
  start_at: string;
  end_at: string;
};

const fetchReservation = async (db: D1Database, reservationId: string, admin?: AdminUser) => {
  const authorization = admin && adminWriteSnapshot(admin);
  return await db
    .prepare(
      `
        SELECT
          reservations.id,
          reservations.store_id,
          reservations.customer_id,
          reservations.resource_id,
          reservations.line_identity_id,
          reservations.status,
          reservations.start_at,
          reservations.end_at,
          reservations.duration_minutes,
          reservations.pending_expires_at,
          reservations.version,
          reservations.checked_in_at,
          stores.timezone${authorization ? `, ${authorization.sql} AS actor_authorized` : ""}
        FROM reservations
        JOIN stores ON stores.id = reservations.store_id
        WHERE reservations.id = ?
        LIMIT 1
      `
    )
    .bind(...(authorization?.bindings ?? []), reservationId)
    .first<ReservationRow & { actor_authorized?: number }>();
};

const fetchAuthorizedRescheduleReservation = async (
  db: D1Database, admin: AdminUser, reservationId: string, checkCurrentActor = false
) => {
  const reservation = await fetchReservation(db, reservationId, checkCurrentActor ? admin : undefined);
  if (!reservation) return { ok: false, reason: "not_found" } as const;
  // Staff can change reservations at their own store on any date.
  if ((checkCurrentActor && !reservation.actor_authorized) ||
    (admin.role === "staff" && (!admin.store_id || reservation.store_id !== admin.store_id))) {
    return { ok: false, reason: "forbidden" } as const;
  }
  return { ok: true, reservation } as const;
};

const createRequestHash = async (input: {
  reservationId: string;
  normalizedStartAt: string;
  durationMinutes: number | undefined;
}) => {
  // 開始移動モード(durationMinutes 未指定)は旧来の { reservationId, startAt } 形を維持する。
  // これを変えると、デプロイ直前に成功した開始移動 reschedule の idempotency 行(旧2フィールド
  // hash)が、応答喪失後 24h TTL 内の同キー再送で hash 不一致になり、replay されずに
  // idempotency_conflict を返してしまう(既存パスの後方互換退行)。施術時間変更モードだけ
  // durationMinutes を hash に含め、開始同一で長さのみ変更した操作を別扱いにする。
  return sha256Hex(
    JSON.stringify(
      input.durationMinutes === undefined
        ? {
            reservationId: input.reservationId,
            startAt: input.normalizedStartAt
          }
        : {
            reservationId: input.reservationId,
            startAt: input.normalizedStartAt,
            durationMinutes: input.durationMinutes
          }
    )
  );
};

const guardRescheduleTransitionApplied = (input: {
  db: D1Database;
  idempotencyId: string;
  idempotencyKey: string;
  requestHash: string;
  idempotencyExpiresAt: string;
  reservation: ReservationRow;
  nextVersion: number;
  adminId: string;
  nowIso: string;
}) => [
  input.db
    .prepare(
      `
        UPDATE idempotency_keys
        SET target_type = 'reservation_reschedule_transition',
            target_id = ?,
            updated_at = ?
        WHERE id = ?
          AND changes() > 0
          AND EXISTS (
            SELECT 1
            FROM reservations
            WHERE id = ?
              AND status = ?
              AND version = ?
              AND updated_by = ?
              AND updated_at = ?
          )
      `
    )
    .bind(
      input.reservation.id,
      input.nowIso,
      input.idempotencyId,
      input.reservation.id,
      input.reservation.status,
      input.nextVersion,
      input.adminId,
      input.nowIso
    ),
  input.db
    .prepare(
      `
        INSERT INTO idempotency_keys (
          id,
          scope,
          idempotency_key,
          status,
          request_hash,
          expires_at,
          updated_at
        )
        SELECT ?, 'admin_action', ?, 'started', ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1
          FROM idempotency_keys
          WHERE id = ?
            AND target_type = 'reservation_reschedule_transition'
        )
      `
    )
    .bind(
      crypto.randomUUID(),
      input.idempotencyKey,
      input.requestHash,
      input.idempotencyExpiresAt,
      input.nowIso,
      input.idempotencyId
    )
];

const readReservationResult = async (
  db: D1Database,
  reservationId: string,
  replayed: boolean
): Promise<AdminRescheduleReservationResult> => {
  const row = await db
    .prepare(
      `
        SELECT id, status, start_at, end_at
        FROM reservations
        WHERE id = ?
        LIMIT 1
      `
    )
    .bind(reservationId)
    .first<ReservationResultRow>();

  if (!row || (row.status !== "pending_approval" && row.status !== "confirmed")) {
    return {
      ok: false,
      reason: "write_failed"
    };
  }

  return {
    ok: true,
    reservationId: row.id,
    status: row.status,
    startAt: row.start_at,
    endAt: row.end_at,
    replayed
  };
};

const mapBatchError = (error: unknown): AdminRescheduleReservationFailure => {
  const sharedReason = classifyReservationWriteError(error);
  if (sharedReason) {
    return {
      ok: false,
      reason: sharedReason
    };
  }
  // An idempotency_keys UNIQUE collision is handled by resolveRescheduleBatchFailure (a
  // TTL-aware re-resolve), not here: a concurrent in-flight request replays
  // cached/idempotency_in_progress, while a post-TTL expired row falls through to this
  // terminal write_failed (F-6.1). See [[idempotency-ttl-invariant]].
  return {
    ok: false,
    reason: "write_failed"
  };
};

type RescheduleRequestValidation =
  | {
      ok: true;
      startAt: Date;
      durationOverrideMinutes: number | undefined;
    }
  | AdminRescheduleReservationFailure;

const isValidRescheduleTreatmentMinutes = (minutes: number) =>
  Number.isInteger(minutes) &&
  minutes >= SLOT_LOCK_INTERVAL_MINUTES &&
  minutes <= MAX_TOTAL_SERVICE_DURATION_MINUTES &&
  minutes % SLOT_LOCK_INTERVAL_MINUTES === 0;

const validateRescheduleRequest = (input: {
  reservationId: string;
  request: AdminRescheduleReservationRequest;
}): RescheduleRequestValidation => {
  if (
    !isNonEmptyString(input.reservationId, 128) ||
    !isNonEmptyString(input.request.idempotencyKey, 256) ||
    !isNonEmptyString(input.request.startAt, 64)
  ) {
    return {
      ok: false,
      reason: "invalid_request"
    };
  }

  // Same grid as admin create: a booking taken at 09:40 must stay movable to 09:40-like
  // times. 5 is the floor for the same reason — see reservation-create.ts. The
  // "start must be in the future" guard is applied later (only when the start actually
  // moves), so a duration-only change on an already-started reservation is not rejected here.
  const startAt = parseStartAt(input.request.startAt, SLOT_LOCK_INTERVAL_MINUTES);
  if (!startAt) {
    return {
      ok: false,
      reason: "invalid_time"
    };
  }

  // 施術時間変更モード: treatmentMinutes が来たら占有 = 施術 + バッファ。
  let durationOverrideMinutes: number | undefined;
  if (input.request.treatmentMinutes !== undefined) {
    const treatmentMinutes = input.request.treatmentMinutes;
    if (!isValidRescheduleTreatmentMinutes(treatmentMinutes)) {
      return {
        ok: false,
        reason: "invalid_request"
      };
    }
    durationOverrideMinutes = treatmentMinutes + RESERVATION_INTERVAL_MINUTES;
  }

  return {
    ok: true,
    startAt,
    durationOverrideMinutes
  };
};

// Single source of truth for "may this reservation still be rescheduled".
// Shared with the available-slots route's reschedule mode so the picker's
// fail-closed gate can never drift from what this write path accepts.
export const isReschedulableReservation = (reservation: {
  status: string;
  checked_in_at: string | null;
}): boolean =>
  !reservation.checked_in_at &&
  (reservation.status === "pending_approval" || reservation.status === "confirmed");

const validateRescheduleTime = (reservation: ReservationRow, startAt: Date, durationMinutes: number, nowMs: number) => {
  // Changing only the duration is allowed after the reservation has started.
  const startUnchanged = startAt.getTime() === new Date(reservation.start_at).getTime();
  if (!startUnchanged && startAt.getTime() <= nowMs) {
    return { ok: false, reason: "invalid_time" } as const;
  }

  // Bound the stored duration before generating slots for a move.
  if (durationMinutes > MAX_TOTAL_SERVICE_DURATION_MINUTES + RESERVATION_INTERVAL_MINUTES) {
    return { ok: false, reason: "invalid_time" } as const;
  }
  const slotTimes = generateSlotTimesForDuration(startAt, durationMinutes, SLOT_LOCK_INTERVAL_MINUTES);
  if (!slotTimes) {
    return { ok: false, reason: "invalid_time" } as const;
  }
  return { ok: true, startUnchanged, endAt: addMinutes(startAt, durationMinutes), slotTimes } as const;
};

const planRescheduleNotification = (reservation: ReservationRow, suppressNotification: boolean) => {
  if (reservation.status !== "confirmed") return { kind: "none", reason: "pending_approval" } as const;
  if (suppressNotification) return { kind: "none", reason: "start_unchanged" } as const;
  if (!reservation.line_identity_id) return { kind: "none", reason: "no_line_identity" } as const;
  return { kind: "time_changed", reason: "start_changed" } as const;
};

const describeRescheduleWindow = (startAt: Date, endAt: Date, occupancyMinutes: number) => {
  const treatmentMinutes = Math.max(0, occupancyMinutes - RESERVATION_INTERVAL_MINUTES);
  return {
    startAt: toIso(startAt),
    treatmentEndAt: toIso(addMinutes(startAt, treatmentMinutes)),
    endAt: toIso(endAt),
    occupancyMinutes,
    treatmentMinutes
  };
};

const notificationJobKey = (reservationId: string, version: number) =>
  `reservation:${reservationId}:template:reservation_time_changed:revision:${version}`;

const calendarJobKey = (reservationId: string, version: number) =>
  `reservation:${reservationId}:google:upsert:revision:${version}`;

type AdminReschedulePreviewResult = {
  ok: true;
  contractVersion: typeof RESCHEDULE_PREVIEW_CONTRACT;
  reservationId: string;
  version: number;
  intent: AdminReschedulePreviewRequest["intent"];
  storeId: string;
  resourceId: string;
  status: ReservationRow["status"];
  before: ReturnType<typeof describeRescheduleWindow>;
  after: ReturnType<typeof describeRescheduleWindow>;
  notificationPlan: ReturnType<typeof planRescheduleNotification>;
  calendarPlan: "enqueue_upsert";
  previewFingerprint: string;
} | {
  ok: false;
  reason: "invalid_request" | "forbidden" | "not_found" | "feature_disabled" | "invalid_transition"
    | "undo_not_available" | "invalid_time" | "no_change" | "outside_business_hours" | "store_closed"
    | "slot_unavailable" | "customer_time_conflict";
} | {
  ok: false;
  reason: "version_conflict";
  version: number;
  status: ReservationRow["status"] | "checked_in";
};

type RescheduleProposal = Extract<AdminReschedulePreviewResult, { ok: true }>;
type RescheduleWindow = RescheduleProposal["before"];

const SUCCEEDED_UNDO_SOURCE_SQL = "operation_id = ? AND reservation_id = ? AND status = 'succeeded'";

const readUndoSource = (db: D1Database, reservationId: string, operationId: string) => db.prepare(`
  SELECT applied_version, before_snapshot_json FROM reservation_change_operations WHERE ${SUCCEEDED_UNDO_SOURCE_SQL}
`).bind(operationId, reservationId).first<{ applied_version: number; before_snapshot_json: string }>();

const undoSourceCondition = (reservationId: string, intent: AdminReschedulePreviewRequest["intent"], version?: number) => {
  if (intent.kind !== "undo") return { sql: "", bindings: [] };
  const bindings: (string | number)[] = [intent.inverseOfOperationId, reservationId];
  if (version !== undefined) bindings.push(version);
  return {
    sql: `AND EXISTS (SELECT 1 FROM reservation_change_operations WHERE ${SUCCEEDED_UNDO_SOURCE_SQL}
      ${version === undefined ? "" : "AND applied_version = ?"})`,
    bindings,
  };
};

// Resolve the start and occupancy using the same validation for preview and commit.
const resolvePreviewChange = (
  reservation: ReservationRow, intent: AdminReschedulePreviewRequest["intent"], nowMs: number,
  undo?: RescheduleWindow
) => {
  if (intent.kind === "resize" && !isValidRescheduleTreatmentMinutes(intent.treatmentMinutes)) {
    return { ok: false, reason: "invalid_request" } as const;
  }
  const rawStartAt = intent.kind === "move" ? intent.startAt : undo?.startAt ?? reservation.start_at;
  if (intent.kind === "move" && parseStrictIsoOffsetInstantMs(rawStartAt) === null) {
    return { ok: false, reason: "invalid_time" } as const;
  }
  const startAt = parseStartAt(rawStartAt, SLOT_LOCK_INTERVAL_MINUTES);
  if (!startAt) return { ok: false, reason: "invalid_time" } as const;
  const durationMinutes = intent.kind === "resize"
    ? intent.treatmentMinutes + RESERVATION_INTERVAL_MINUTES
    : undo?.occupancyMinutes ?? reservation.duration_minutes;
  const time = validateRescheduleTime(reservation, startAt, durationMinutes, nowMs);
  if (!time.ok) return time;
  if (time.startUnchanged && durationMinutes === reservation.duration_minutes) {
    return { ok: false, reason: "no_change" } as const;
  }
  return { ok: true, startAt, durationMinutes, time } as const;
};

const ACTIVE_EXTERNAL_BLOCK_OVERLAP_SQL = `SELECT 1 FROM external_blocks
  WHERE store_id = ? AND resource_id = ? AND status = 'active' AND start_at < ? AND end_at > ?`;

// Reads only: the overlaps the write path's unique locks reject, plus active external blocks (contract ch.3).
const findPreviewConflict = async (
  db: D1Database,
  reservation: ReservationRow,
  slotTimes: string[],
  startAt: Date,
  endAt: Date
): Promise<"slot_unavailable" | "customer_time_conflict" | undefined> => {
  const slotPlaceholders = slotTimes.map(() => "?").join(", ");
  const occupied = await db.prepare(`
    SELECT 1 FROM slot_locks
    WHERE store_id = ? AND resource_id = ?
      AND slot_at IN (${slotPlaceholders})
      AND NOT (owner_type = 'reservation' AND owner_id = ?)
    UNION ALL
    ${ACTIVE_EXTERNAL_BLOCK_OVERLAP_SQL}
    LIMIT 1
  `).bind(
    reservation.store_id, reservation.resource_id, ...slotTimes, reservation.id,
    reservation.store_id, reservation.resource_id, toIso(endAt), toIso(startAt)
  ).first();
  if (occupied) return "slot_unavailable";
  // Match both unique lock keys, including the write path's source-specific phone hash.
  const customerConflict = await db.prepare(`
    SELECT 1 FROM customer_time_locks
    WHERE slot_at IN (${slotPlaceholders})
      AND owner_id <> ?
      AND (customer_id = ? OR phone_hash = ${CUSTOMER_TIME_LOCK_PHONE_HASH_SQL})
    LIMIT 1
  `).bind(...slotTimes, reservation.id, reservation.customer_id, reservation.id).first();
  if (customerConflict) return "customer_time_conflict";
  return undefined;
};

export async function previewAdminRescheduleReservation(input: {
  db: D1Database;
  admin: AdminUser;
  reservationId: string;
  request: AdminReschedulePreviewRequest;
  featureEnabled: boolean;
}): Promise<AdminReschedulePreviewResult> {
  if (!isNonEmptyString(input.reservationId, 128)) return { ok: false, reason: "invalid_request" };
  const target = await fetchAuthorizedRescheduleReservation(input.db, input.admin, input.reservationId, true);
  if (!target.ok) return target;
  if (!input.featureEnabled) return { ok: false, reason: "feature_disabled" };
  return validateRescheduleProposal(input.db, input.admin, target.reservation, input.request);
}

const rescheduleVersionConflict = (reservation: ReservationRow) => ({
  ok: false,
  reason: "version_conflict",
  version: reservation.version,
  status: reservation.status === "confirmed" && reservation.checked_in_at ? "checked_in" : reservation.status
} as const);

async function validateRescheduleProposal(
  db: D1Database, admin: AdminUser, reservation: ReservationRow, request: AdminReschedulePreviewRequest
): Promise<AdminReschedulePreviewResult> {
  const { contractVersion, expectedVersion, intent } = request;
  if (reservation.version !== expectedVersion) {
    return rescheduleVersionConflict(reservation);
  }
  if (!isReschedulableReservation(reservation)) return { ok: false, reason: "invalid_transition" };

  let undo: RescheduleWindow | undefined;
  if (intent.kind === "undo") {
    const source = await readUndoSource(db, reservation.id, intent.inverseOfOperationId);
    if (!source || source.applied_version !== expectedVersion) return { ok: false, reason: "undo_not_available" };
    undo = JSON.parse(source.before_snapshot_json) as RescheduleWindow;
  }

  const change = resolvePreviewChange(reservation, intent, Date.now(), undo);
  if (!change.ok) return change;
  const { startAt, durationMinutes, time } = change;
  const businessTimeError = await ensureBusinessTime(db, reservation.store_id, reservation.timezone, startAt, time.endAt);
  if (businessTimeError) return businessTimeError;
  const conflict = await findPreviewConflict(db, reservation, time.slotTimes, startAt, time.endAt);
  if (conflict) return { ok: false, reason: conflict };

  const confirmation = {
    contractVersion,
    reservationId: reservation.id,
    intent: intent.kind === "move" ? { kind: "move", startAt: toIso(startAt) } as const : intent,
    before: describeRescheduleWindow(new Date(reservation.start_at), new Date(reservation.end_at), reservation.duration_minutes),
    after: describeRescheduleWindow(startAt, time.endAt, durationMinutes),
    notificationPlan: planRescheduleNotification(reservation, time.startUnchanged),
    calendarPlan: "enqueue_upsert"
  } as const;
  const previewFingerprint = await sha256Hex(JSON.stringify({
    ...confirmation,
    actorId: admin.id,
    expectedVersion
  }));
  return {
    ok: true,
    ...confirmation,
    version: reservation.version,
    storeId: reservation.store_id,
    resourceId: reservation.resource_id,
    status: reservation.status,
    previewFingerprint
  };
}

const resolveRescheduleIdempotency = async (input: {
  db: D1Database;
  idempotencyKey: string;
  requestHash: string;
  nowIso: string;
}): Promise<AdminRescheduleReservationResult | undefined> => {
  // Filter on expires_at so a "started" row from a crashed request stops
  // blocking this idempotency_key once its TTL has elapsed, matching the audited
  // canonical resolver (settings-common.ts fetchAdminActionIdempotency,
  // docs/SECURITY-AUDIT-2026-05-27.md F-6.1). Bind the caller's nowIso (the same
  // clock that stamps expires_at on insert) so read and write stay deterministic
  // under time-travel tests; wrap both sides in datetime(...) because expires_at
  // is an ISO string whose `T` separator would lexically mis-order a bare `>`.
  const idempotency = await input.db
    .prepare(
      `
        SELECT status, target_id, request_hash
        FROM idempotency_keys
        WHERE scope = 'admin_action'
          AND idempotency_key = ?
          AND (expires_at IS NULL OR datetime(expires_at) > datetime(?))
        LIMIT 1
      `
    )
    .bind(input.idempotencyKey, input.nowIso)
    .first<IdempotencyRow>();

  if (!idempotency) {
    return undefined;
  }
  if (idempotency.request_hash !== input.requestHash) {
    return {
      ok: false,
      reason: "idempotency_conflict"
    };
  }
  if (idempotency.status === "succeeded" && idempotency.target_id) {
    return readReservationResult(input.db, idempotency.target_id, true);
  }
  return {
    ok: false,
    reason: "idempotency_in_progress"
  };
};

const resolveRescheduleBatchFailure = async (
  db: D1Database,
  idempotencyKey: string,
  requestHash: string,
  nowIso: string,
  error: unknown,
  admin: AdminUser
): Promise<AdminRescheduleReservationResult> => {
  if (await adminWriteWasRevoked(db, admin, error)) {
    return { ok: false, reason: "forbidden" };
  }
  // An idempotency_keys UNIQUE collision at the batch INSERT means either a concurrent
  // in-flight request (valid TTL) or a post-TTL expired "started" row. Re-resolve with
  // the TTL filter so the former replays cached/idempotency_in_progress while the latter,
  // no longer in flight, falls through to mapBatchError's terminal write_failed (F-6.1,
  // matching reservations.ts). [[idempotency-ttl-invariant]]
  try {
    const concurrent = await resolveRescheduleIdempotency({ db, idempotencyKey, requestHash, nowIso });
    if (concurrent) {
      return concurrent;
    }
  } catch {
    // fall through to the structured batch-error mapping
  }
  return mapBatchError(error);
};

const buildRescheduleStatements = (input: {
  db: D1Database;
  admin: AdminUser;
  reservation: ReservationRow;
  idempotencyId: string;
  idempotencyKey: string;
  requestHash: string;
  idempotencyExpiresAt: string;
  startAt: Date;
  endAt: Date;
  durationMinutes: number;
  suppressNotification: boolean;
  nowIso: string;
}) => {
  const endAtIso = toIso(input.endAt);
  const lockStatus = input.reservation.status === "confirmed" ? "confirmed" : "pending";
  const lockExpiresAt = input.reservation.status === "confirmed" ? null : input.reservation.pending_expires_at;
  const nextVersion = input.reservation.version + 1;

  // Shared transition (reservation UPDATE + lock release/insert/history).
  // Returns [UPDATE, release history, DELETE slot_locks, DELETE customer_time_locks, ...per-slot triples].
  const transition = buildTransitionRescheduleStatements({
    db: input.db,
    reservationId: input.reservation.id,
    customerId: input.reservation.customer_id,
    storeId: input.reservation.store_id,
    resourceId: input.reservation.resource_id,
    expectedStatusList: ["pending_approval", "confirmed"],
    newStartAt: toIso(input.startAt),
    newEndAt: endAtIso,
    newDurationMinutes: input.durationMinutes,
    nowIso: input.nowIso,
    newLockExpiresAt: lockExpiresAt,
    newLockStatus: lockStatus,
    actor: { kind: "admin", adminId: input.admin.id }
  });

  const statements: D1PreparedStatement[] = [
    adminWriteGuard(input.db, input.admin),
    input.db
      .prepare(
        `
          INSERT INTO idempotency_keys (
            id,
            scope,
            idempotency_key,
            status,
            request_hash,
            expires_at,
            updated_at
          ) VALUES (?, 'admin_action', ?, 'started', ?, ?, ?)
        `
      )
      .bind(input.idempotencyId, input.idempotencyKey, input.requestHash, input.idempotencyExpiresAt, input.nowIso),
    transition[0],
    ...guardRescheduleTransitionApplied({
      db: input.db,
      idempotencyId: input.idempotencyId,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      idempotencyExpiresAt: input.idempotencyExpiresAt,
      reservation: input.reservation,
      nextVersion,
      adminId: input.admin.id,
      nowIso: input.nowIso
    }),
    ...transition.slice(1)
  ];

  if (planRescheduleNotification(input.reservation, input.suppressNotification).kind === "time_changed") {
    statements.push(
      input.db
        .prepare(
          `
            INSERT OR IGNORE INTO notification_jobs (
              id,
              dedupe_key,
              template_key,
              recipient_type,
              recipient_id,
              reservation_id,
              status
            ) VALUES (?, ?, 'reservation_time_changed', 'customer', ?, ?, 'queued')
          `
        )
        .bind(
          crypto.randomUUID(),
          notificationJobKey(input.reservation.id, nextVersion),
          input.reservation.customer_id,
          input.reservation.id
        )
    );
  }

  statements.push(
    input.db
      .prepare(
        `
          INSERT OR IGNORE INTO calendar_sync_jobs (
            id,
            dedupe_key,
            owner_type,
            owner_id,
            google_action,
            status,
            available_at
          ) VALUES (?, ?, 'reservation', ?, 'upsert', 'queued', ?)
        `
      )
      .bind(
        crypto.randomUUID(),
        calendarJobKey(input.reservation.id, nextVersion),
        input.reservation.id,
        input.nowIso
      ),
    input.db
      .prepare(
        `
          INSERT INTO audit_logs (
            id,
            actor_type,
            actor_id,
            action,
            target_type,
            target_id,
            metadata_json
          ) VALUES (?, 'staff', ?, 'admin_reservation_rescheduled', 'reservation', ?, ?)
        `
      )
      .bind(
        crypto.randomUUID(),
        input.admin.id,
        input.reservation.id,
        JSON.stringify({
          previousStartAt: input.reservation.start_at,
          previousEndAt: input.reservation.end_at,
          nextStartAt: toIso(input.startAt),
          nextEndAt: endAtIso,
          previousDurationMinutes: input.reservation.duration_minutes,
          nextDurationMinutes: input.durationMinutes
        })
      ),
    input.db
      .prepare(
        `
          UPDATE idempotency_keys
          SET status = 'succeeded',
              target_type = 'reservation',
              target_id = ?,
              updated_at = ?
          WHERE id = ?
        `
      )
      .bind(input.reservation.id, input.nowIso, input.idempotencyId)
  );

  return statements;
};

export async function rescheduleAdminReservation(input: {
  db: D1Database;
  admin: AdminUser;
  reservationId: string;
  request: AdminRescheduleReservationRequest;
  now?: () => number;
}): Promise<AdminRescheduleReservationResult> {
  const now = input.now ?? Date.now;
  // Single clock for the whole request: the future-start guard, the idempotency TTL write,
  // and the TTL read all read the same instant (F-6.1, deterministic under time-travel tests).
  const nowMs = now();
  const requestValidation = validateRescheduleRequest({
    reservationId: input.reservationId,
    request: input.request
  });
  if (!requestValidation.ok) {
    return requestValidation;
  }
  const startAt = requestValidation.startAt;
  const durationOverride = requestValidation.durationOverrideMinutes;

  const target = await fetchAuthorizedRescheduleReservation(input.db, input.admin, input.reservationId);
  if (!target.ok) return target;
  const { reservation } = target;
  if (!isReschedulableReservation(reservation)) return { ok: false, reason: "invalid_transition" };

  const effectiveDuration = durationOverride ?? reservation.duration_minutes;
  const time = validateRescheduleTime(reservation, startAt, effectiveDuration, nowMs);
  if (!time.ok) return time;
  const { endAt, startUnchanged } = time;

  // Staff rescheduling intentionally omits serviceIds so it remains a manual
  // recovery path outside the customer-facing men's booking window.
  const businessTimeError = await ensureBusinessTime(input.db, reservation.store_id, reservation.timezone, startAt, endAt);
  if (businessTimeError) {
    return businessTimeError;
  }

  const requestHash = await createRequestHash({
    reservationId: input.reservationId,
    normalizedStartAt: toIso(startAt),
    durationMinutes: durationOverride
  });
  const nowIso = toIso(new Date(nowMs));
  const idempotencyResult = await resolveRescheduleIdempotency({
    db: input.db,
    idempotencyKey: input.request.idempotencyKey,
    requestHash,
    nowIso
  });
  if (idempotencyResult) {
    return idempotencyResult;
  }

  const idempotencyId = crypto.randomUUID();
  const idempotencyExpiresAt = toIso(new Date(nowMs + IDEMPOTENCY_TTL_MS));
  // 通知抑止は「施術時間変更モード かつ 開始時刻が動いていない」ときだけ(startUnchanged は上で算出)。
  // 開始が動くリクエスト(start も treatmentMinutes も同時指定するような混在呼び出し)は、実際に
  // 予約時刻が変わるので従来どおり顧客へ通知する。
  const statements = buildRescheduleStatements({
    db: input.db,
    admin: input.admin,
    reservation,
    idempotencyId,
    idempotencyKey: input.request.idempotencyKey,
    requestHash,
    idempotencyExpiresAt,
    startAt,
    endAt,
    durationMinutes: effectiveDuration,
    suppressNotification: durationOverride !== undefined && startUnchanged,
    nowIso
  });

  try {
    await input.db.batch(statements);
  } catch (error) {
    const result = await resolveRescheduleBatchFailure(input.db, input.request.idempotencyKey, requestHash, nowIso, error, input.admin);
    if (!result.ok && result.reason === "write_failed") {
      captureBatchWriteFailure(error, {
        component: "reservation-reschedule",
        op: "batch_write_failed",
        helper: "rescheduleAdminReservation"
      });
    }
    return result;
  }

  return readReservationResult(input.db, reservation.id, false);
}

type RescheduleEffects = {
  notification: RescheduleProposal["notificationPlan"] & { jobId?: string; status?: string };
  calendar: { kind: "enqueue_upsert"; jobId: string; status?: string };
};
type RescheduleOperation = {
  operation_id: string;
  reservation_id: string;
  request_hash: string;
} & ({ status: "started" | "not_applied" } | {
  status: "succeeded";
  before_version: number;
  applied_version: number;
  before_snapshot_json: string;
  after_snapshot_json: string;
  effects_json: string;
});

type RescheduleCommitResult = Exclude<AdminReschedulePreviewResult, { ok: true }> | {
  ok: false;
  reason: "idempotency_conflict" | "idempotency_in_progress" | "operation_not_applied" | "preview_stale" | "write_failed";
} | {
  ok: true;
  contractVersion: typeof RESCHEDULE_PREVIEW_CONTRACT;
  replayed: boolean;
  operationId: string;
  change: { beforeVersion: number; appliedVersion: number; before: RescheduleWindow; after: RescheduleWindow };
  reservation: {
    id: string; version: number; status: ReservationRow["status"] | "checked_in"; storeId: string; resourceId: string;
    startAt: string; endAt: string; occupancyMinutes: number;
  };
  effects: RescheduleEffects;
};

type RescheduleCommitInput = {
  db: D1Database;
  admin: AdminUser;
  reservationId: string;
  request: AdminRescheduleCommitRequest;
  featureEnabled: boolean;
  check: boolean;
};
type RescheduleCommit = RescheduleCommitInput & { requestHash: string };

const readChangeOperation = ({ db, admin, request }: RescheduleCommitInput) => db.prepare(`
  SELECT operation_id, reservation_id, request_hash, status, before_version, applied_version,
         before_snapshot_json, after_snapshot_json, effects_json
  FROM reservation_change_operations WHERE actor_id = ? AND idempotency_key = ?
`).bind(admin.id, request.idempotencyKey).first<RescheduleOperation>();

const readCommitTarget = ({ db, admin, reservationId }: RescheduleCommitInput) =>
  fetchAuthorizedRescheduleReservation(db, admin, reservationId, true);

const startedOperationCondition = (input: RescheduleCommit, operationId: string) => ({
  sql: `operation_id = ? AND reservation_id = ? AND actor_id = ?
    AND idempotency_key = ? AND request_hash = ? AND status = 'started'`,
  bindings: [operationId, input.reservationId, input.admin.id, input.request.idempotencyKey, input.requestHash],
});

const readChangeSuccess = async (
  input: RescheduleCommit, operation: Extract<RescheduleOperation, { status: "succeeded" }>, replayed: boolean
): Promise<RescheduleCommitResult> => {
  const target = await readCommitTarget(input);
  if (!target.ok) return target;

  const { reservation } = target;
  const effects = JSON.parse(operation.effects_json) as RescheduleEffects;
  const statuses = await input.db.prepare(`
    SELECT (SELECT status FROM notification_jobs WHERE id = ?) AS notification,
           (SELECT status FROM calendar_sync_jobs WHERE id = ?) AS calendar
  `).bind(effects.notification.jobId ?? null, effects.calendar.jobId).first<{
    notification: string | null; calendar: string | null;
  }>();
  if (statuses?.notification) effects.notification.status = statuses.notification;
  if (statuses?.calendar) effects.calendar.status = statuses.calendar;

  return {
    ok: true,
    contractVersion: RESCHEDULE_PREVIEW_CONTRACT,
    replayed,
    operationId: operation.operation_id,
    change: {
      beforeVersion: operation.before_version,
      appliedVersion: operation.applied_version,
      before: JSON.parse(operation.before_snapshot_json) as RescheduleWindow,
      after: JSON.parse(operation.after_snapshot_json) as RescheduleWindow,
    },
    reservation: {
      id: reservation.id,
      version: reservation.version,
      status: reservation.status === "confirmed" && reservation.checked_in_at ? "checked_in" : reservation.status,
      storeId: reservation.store_id,
      resourceId: reservation.resource_id,
      startAt: reservation.start_at,
      endAt: reservation.end_at,
      occupancyMinutes: reservation.duration_minutes,
    },
    effects,
  };
};

const resolveChangeOperation = async (
  input: RescheduleCommit, operation: RescheduleOperation | null
): Promise<RescheduleCommitResult | undefined> => {
  if (!operation) return undefined;
  if (operation.reservation_id !== input.reservationId || operation.request_hash !== input.requestHash) {
    return { ok: false, reason: "idempotency_conflict" };
  }
  if (operation.status === "succeeded") return readChangeSuccess(input, operation, true);
  if (operation.status === "started") {
    if (input.featureEnabled && input.check) return undefined;
    return { ok: false, reason: "idempotency_in_progress" };
  }
  if (input.featureEnabled) return { ok: false, reason: "operation_not_applied" };
  return undefined;
};

const changeWriteAuthorization = (input: RescheduleCommit, reservation: ReservationRow) => {
  const actor = adminWriteSnapshot(input.admin);
  const undo = undoSourceCondition(reservation.id, input.request.intent);
  return {
    sql: `${actor.sql} AND EXISTS (SELECT 1 FROM reservations WHERE id = ? AND store_id = ?) ${undo.sql}`,
    bindings: [...actor.bindings, reservation.id, reservation.store_id, ...undo.bindings],
  };
};

const insertChangeOperation = async (
  input: RescheduleCommit, reservation: ReservationRow, operationId: string, status: "started" | "not_applied"
) => {
  const authorization = changeWriteAuthorization(input, reservation);
  const { intent, idempotencyKey } = input.request;
  const nowIso = toIso(new Date());
  return input.db.prepare(`
    INSERT INTO reservation_change_operations (
      operation_id, reservation_id, actor_id, idempotency_key, request_hash, kind, inverse_of_operation_id,
      status, created_at, updated_at
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${authorization.sql}
    ON CONFLICT (actor_id, idempotency_key) DO NOTHING
  `).bind(operationId, reservation.id, input.admin.id, idempotencyKey, input.requestHash, intent.kind,
    intent.kind === "undo" ? intent.inverseOfOperationId : null, status, nowIso, nowIso,
    ...authorization.bindings).run();
};

const setChangeNotApplied = (input: RescheduleCommit, reservation: ReservationRow, operationId: string) => {
  const authorization = changeWriteAuthorization(input, reservation);
  const started = startedOperationCondition(input, operationId);
  return input.db.prepare(`
    UPDATE reservation_change_operations SET status = 'not_applied', updated_at = ?
    WHERE ${started.sql} AND ${authorization.sql}
  `).bind(toIso(new Date()), ...started.bindings, ...authorization.bindings).run();
};

const readAfterChangeWrite = async (input: RescheduleCommit): Promise<RescheduleCommitResult> => {
  const authorized = await readCommitTarget(input);
  if (!authorized.ok) return authorized;
  return await resolveChangeOperation({ ...input, check: false }, await readChangeOperation(input))
    ?? { ok: false, reason: "write_failed" };
};

const checkChangeOperation = async (
  input: RescheduleCommit, reservation: ReservationRow, operation: RescheduleOperation | null
): Promise<RescheduleCommitResult> => {
  const { intent } = input.request;
  if (intent.kind === "undo" && !await readUndoSource(input.db, reservation.id, intent.inverseOfOperationId)) {
    return { ok: false, reason: "undo_not_available" };
  }
  if (!operation) {
    const inserted = await insertChangeOperation(input, reservation, crypto.randomUUID(), "not_applied");
    if (inserted.meta.changes === 1) return { ok: false, reason: "operation_not_applied" };

    const authorized = await readCommitTarget(input);
    if (!authorized.ok) return authorized;
    operation = await readChangeOperation(input);
    const existing = await resolveChangeOperation(input, operation);
    if (existing) return existing;
  }
  if (operation?.status !== "started") return { ok: false, reason: "write_failed" };

  const updated = await setChangeNotApplied(input, reservation, operation.operation_id);
  if (updated.meta.changes === 1) return { ok: false, reason: "operation_not_applied" };
  return readAfterChangeWrite(input);
};

const finishUnappliedCommit = async (input: RescheduleCommit, operationId: string): Promise<RescheduleCommitResult> => {
  const target = await readCommitTarget(input);
  if (!target.ok) return target;
  const { reservation } = target;
  const updated = await setChangeNotApplied(input, reservation, operationId);
  if (updated.meta.changes !== 1) return readAfterChangeWrite(input);

  const proposal = await validateRescheduleProposal(input.db, input.admin, reservation, input.request);
  if (!proposal.ok) return proposal;
  if (proposal.previewFingerprint !== input.request.previewFingerprint) return { ok: false, reason: "preview_stale" };
  return { ok: false, reason: "operation_not_applied" };
};

const buildCommitRescheduleStatements = (
  input: RescheduleCommit, reservation: ReservationRow, proposal: RescheduleProposal, operationId: string
) => {
  const { db, admin, request } = input;
  const { before, after, notificationPlan } = proposal;
  const nextVersion = request.expectedVersion + 1;
  const nowIso = toIso(new Date());
  // A batch-local value lets the last statement distinguish our UPDATE from a concurrent writer at the same version.
  const updatedBy = `reservation-change:${operationId}`;
  const started = startedOperationCondition(input, operationId);
  const updated = `EXISTS (SELECT 1 FROM reservations WHERE id = ? AND version = ? AND updated_by = ?)`;
  const updatedBindings = [reservation.id, nextVersion, updatedBy];
  const marked = `EXISTS (SELECT 1 FROM audit_logs WHERE id = ? AND target_type = 'reservation' AND target_id = ?)`;
  const markedBindings = [operationId, reservation.id];
  const applied = { sql: `${updated} AND ${marked}`, bindings: [...updatedBindings, ...markedBindings] };
  const confirmed = reservation.status === "confirmed";
  const undo = undoSourceCondition(reservation.id, request.intent, request.expectedVersion);
  const [updateReservation, ...locks] = buildTransitionRescheduleStatements({
    db,
    reservationId: reservation.id,
    customerId: reservation.customer_id,
    storeId: reservation.store_id,
    resourceId: reservation.resource_id,
    expectedStatusList: [confirmed ? "confirmed" : "pending_approval"],
    newStartAt: after.startAt,
    newEndAt: after.endAt,
    newDurationMinutes: after.occupancyMinutes,
    nowIso,
    newLockExpiresAt: confirmed ? null : reservation.pending_expires_at,
    newLockStatus: confirmed ? "confirmed" : "pending",
    actor: { kind: "admin", adminId: admin.id },
    versioned: {
      updatedBy,
      applied,
      update: {
        sql: `version = ? AND line_identity_id IS ? AND resource_id = ? AND customer_id = ? AND pending_expires_at IS ?
          AND EXISTS (SELECT 1 FROM reservation_change_operations WHERE ${started.sql})
          AND NOT EXISTS (${ACTIVE_EXTERNAL_BLOCK_OVERLAP_SQL}) ${undo.sql}`,
        bindings: [request.expectedVersion, reservation.line_identity_id, reservation.resource_id,
          reservation.customer_id, reservation.pending_expires_at, ...started.bindings,
          reservation.store_id, reservation.resource_id, after.endAt, after.startAt, ...undo.bindings],
      },
    },
  });
  const mark = db.prepare(`
    INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, metadata_json)
    SELECT ?, 'staff', ?, 'admin_reservation_rescheduled', 'reservation', ?, ?
    WHERE changes() = 1 AND ${updated}
  `).bind(operationId, admin.id, reservation.id, JSON.stringify({
    previousStartAt: reservation.start_at,
    previousEndAt: reservation.end_at,
    nextStartAt: after.startAt,
    nextEndAt: after.endAt,
    previousDurationMinutes: before.occupancyMinutes,
    nextDurationMinutes: after.occupancyMinutes,
    kind: request.intent.kind,
    ...(request.intent.kind === "undo" && { inverseOfOperationId: request.intent.inverseOfOperationId }),
  }), ...updatedBindings);

  const notificationJobId = notificationPlan.kind === "time_changed" ? crypto.randomUUID() : null;
  const effects: RescheduleEffects = {
    notification: { ...notificationPlan, ...(notificationJobId && { jobId: notificationJobId }) },
    calendar: { kind: "enqueue_upsert", jobId: crypto.randomUUID() },
  };
  const statements = [adminWriteGuard(db, admin), updateReservation, mark, ...locks];

  if (notificationJobId) {
    statements.push(db.prepare(`
      INSERT INTO notification_jobs (id, dedupe_key, template_key, recipient_type, recipient_id, reservation_id, status)
      SELECT ?, ?, 'reservation_time_changed', 'customer', ?, ?, 'queued' WHERE ${applied.sql}
    `).bind(notificationJobId, notificationJobKey(reservation.id, nextVersion),
      reservation.customer_id, reservation.id, ...applied.bindings));
  }

  statements.push(db.prepare(`
    INSERT INTO calendar_sync_jobs (id, dedupe_key, owner_type, owner_id, google_action, status, available_at)
    SELECT ?, ?, 'reservation', ?, 'upsert', 'queued', ? WHERE ${applied.sql}
  `).bind(effects.calendar.jobId, calendarJobKey(reservation.id, nextVersion), reservation.id, nowIso, ...applied.bindings));

  statements.push(db.prepare(`
    UPDATE reservation_change_operations
    SET status = 'succeeded', updated_at = ?, before_version = ?, applied_version = ?,
        before_snapshot_json = ?, after_snapshot_json = ?, effects_json = ?
    WHERE ${started.sql} AND ${applied.sql}
      AND EXISTS (SELECT 1 FROM calendar_sync_jobs WHERE id = ?)
      AND (? IS NULL OR EXISTS (SELECT 1 FROM notification_jobs WHERE id = ?))
  `).bind(nowIso, request.expectedVersion, nextVersion, JSON.stringify(before), JSON.stringify(after),
    JSON.stringify(effects), ...started.bindings, ...applied.bindings,
    effects.calendar.jobId, notificationJobId, notificationJobId));

  // Restore actor attribution only after checking both durable records. Version zero violates the reservations CHECK
  // and rolls back the batch if our UPDATE ran but either the mark or the success record is missing.
  statements.push(db.prepare(`
    UPDATE reservations SET updated_by = ?, version = CASE WHEN version = ? AND ${marked} AND EXISTS (
      SELECT 1 FROM reservation_change_operations
      WHERE operation_id = ? AND status = 'succeeded' AND applied_version = ?
    ) THEN version ELSE 0 END
    WHERE id = ? AND updated_by = ?
  `).bind(admin.id, nextVersion, ...markedBindings, operationId, nextVersion, reservation.id, updatedBy));
  return statements;
};

export async function commitAdminRescheduleReservation(input: RescheduleCommitInput): Promise<RescheduleCommitResult> {
  if (!isNonEmptyString(input.reservationId, 128)) return { ok: false, reason: "invalid_request" };

  const { db, admin, request } = input;
  let intent = request.intent;
  if (intent.kind === "move") {
    const startMs = parseStrictIsoOffsetInstantMs(intent.startAt);
    if (startMs === null) return { ok: false, reason: "invalid_time" };
    intent = { kind: "move", startAt: toIso(new Date(startMs)) };
  }
  const commit: RescheduleCommit = {
    ...input,
    request: { ...request, intent },
    requestHash: await sha256Hex(JSON.stringify({
      contractVersion: request.contractVersion,
      reservationId: input.reservationId,
      expectedVersion: request.expectedVersion,
      intent,
      previewFingerprint: request.previewFingerprint,
    })),
  };

  const target = await readCommitTarget(commit);
  if (!target.ok) return target;
  const prior = await readChangeOperation(commit);
  const existing = await resolveChangeOperation(commit, prior);
  if (existing) return existing;
  if (!input.featureEnabled) return { ok: false, reason: "feature_disabled" };
  const fingerprintHash = await sha256Hex(request.previewFingerprint);
  if (!request.idempotencyKey.endsWith(`:${fingerprintHash}`)) return { ok: false, reason: "idempotency_conflict" };
  if (commit.check) return checkChangeOperation(commit, target.reservation, prior);

  const current = await readCommitTarget(commit);
  if (!current.ok) return current;
  const { reservation } = current;
  const proposal = await validateRescheduleProposal(db, admin, reservation, commit.request);
  if (!proposal.ok) {
    if (proposal.reason === "version_conflict") {
      return await resolveChangeOperation(commit, await readChangeOperation(commit)) ?? proposal;
    }
    return proposal;
  }
  if (proposal.previewFingerprint !== request.previewFingerprint) return { ok: false, reason: "preview_stale" };
  if (request.expectedVersion === Number.MAX_SAFE_INTEGER) return { ok: false, reason: "write_failed" };

  const operationId = crypto.randomUUID();
  const claim = await insertChangeOperation(commit, reservation, operationId, "started");
  if (claim.meta.changes !== 1) {
    return readAfterChangeWrite(commit);
  }

  let applied: number | undefined;
  try {
    const results = await db.batch(buildCommitRescheduleStatements(commit, reservation, proposal, operationId));
    // The reservation UPDATE follows the authorization guard and precedes the audit mark.
    applied = results[1]?.meta.changes;
  } catch (error) {
    if (await adminWriteWasRevoked(db, admin, error)) return { ok: false, reason: "forbidden" };
    const message = error instanceof Error ? error.message : String(error);
    if (/UNIQUE constraint failed: (?:slot_locks|customer_time_locks)\./.test(message) ||
      /(?:^|:\s)store_closed(?:$|:\s)/.test(message)) {
      const reason = classifyReservationWriteError(error);
      if (reason) return { ok: false, reason };
    }
    captureBatchWriteFailure(error, {
      component: "reservation-reschedule", op: "batch_write_failed", helper: "commitAdminRescheduleReservation",
    });
    return { ok: false, reason: "write_failed" };
  }

  if (applied === 0) return finishUnappliedCommit(commit, operationId);
  if (applied === 1) {
    const operation = await readChangeOperation(commit);
    if (operation?.status === "succeeded") return readChangeSuccess(commit, operation, false);
  }
  return { ok: false, reason: "write_failed" };
}
