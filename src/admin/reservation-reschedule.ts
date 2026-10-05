import type { AdminUser } from "./access";
import { isNonEmptyString, toIso, addMinutes, parseStartAt } from "./reservation-time-utils";
import { IDEMPOTENCY_TTL_MS, sha256Hex } from "./settings-common";
import { ensureBusinessTime } from "../reservations/business-hours";
import {
  generateSlotTimesForDuration,
  MAX_TOTAL_SERVICE_DURATION_MINUTES,
  RESERVATION_INTERVAL_MINUTES,
  SLOT_LOCK_INTERVAL_MINUTES
} from "../reservations/slot-times";
import { buildRescheduleStatements as buildTransitionRescheduleStatements } from "../reservations/transitions";
import { classifyReservationWriteError } from "../reservations/write-error";
import { captureBatchWriteFailure } from "../sentry-helpers";
import { adminWriteGuard, adminWriteWasRevoked } from "./write-authorization";

export type AdminRescheduleReservationRequest = {
  idempotencyKey: string;
  startAt: string;
  treatmentMinutes?: number;
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

const fetchReservation = async (db: D1Database, reservationId: string) => {
  return db
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
          stores.timezone
        FROM reservations
        JOIN stores ON stores.id = reservations.store_id
        WHERE reservations.id = ?
        LIMIT 1
      `
    )
    .bind(reservationId)
    .first<ReservationRow>();
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
    if (
      !Number.isInteger(treatmentMinutes) ||
      treatmentMinutes < SLOT_LOCK_INTERVAL_MINUTES ||
      treatmentMinutes > MAX_TOTAL_SERVICE_DURATION_MINUTES ||
      treatmentMinutes % SLOT_LOCK_INTERVAL_MINUTES !== 0
    ) {
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

const validateRescheduleReservation = (
  reservation: ReservationRow
): AdminRescheduleReservationFailure | undefined => {
  if (isReschedulableReservation(reservation)) {
    return undefined;
  }
  return {
    ok: false,
    reason: "invalid_transition"
  };
};

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

  if (
    input.reservation.status === "confirmed" &&
    input.reservation.line_identity_id &&
    !input.suppressNotification
  ) {
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
          `reservation:${input.reservation.id}:template:reservation_time_changed:revision:${nextVersion}`,
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
        `reservation:${input.reservation.id}:google:upsert:revision:${nextVersion}`,
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

  const reservation = await fetchReservation(input.db, input.reservationId);
  if (!reservation) {
    return {
      ok: false,
      reason: "not_found"
    };
  }
  // staff は自店舗 scope のみ (2026-07-14 当日ガード撤廃 — reservations.ts の
  // validateAdminActionAuthorization と同一方針: 日付を問わず自店舗予約を操作可)。
  if (input.admin.role === "staff" && (!input.admin.store_id || reservation.store_id !== input.admin.store_id)) {
    return { ok: false, reason: "forbidden" };
  }
  const transitionError = validateRescheduleReservation(reservation);
  if (transitionError) {
    return transitionError;
  }

  // 過去時刻ガードは開始時刻を「動かす」ときだけ適用する。施術時間変更(開始不変)は、既に
  // 始まった予約を延長/短縮するという正当な用途があるため、開始が過去でも許可する。開始を動かす
  // リクエスト(通常の時間変更、または start と treatmentMinutes を同時指定する混在)は従来どおり
  // 過去への移動を拒否する。開始不変の判定は ISO 表現差に影響されないよう instant で比較する。
  const startUnchanged = startAt.getTime() === new Date(reservation.start_at).getTime();
  if (!startUnchanged && startAt.getTime() <= nowMs) {
    return { ok: false, reason: "invalid_time" };
  }

  const effectiveDuration = durationOverride ?? reservation.duration_minutes;
  const endAt = addMinutes(startAt, effectiveDuration);
  const slotTimes = generateSlotTimesForDuration(startAt, effectiveDuration, SLOT_LOCK_INTERVAL_MINUTES);
  if (!slotTimes || slotTimes.length > 48) {
    // 48-slot upper bound mirrors the 4h cap enforced by the shared transition
    // builder. Any reservation row with duration_minutes > 240 (legacy data or
    // future feature drift) would otherwise throw deep inside the builder and
    // bypass the API failure enum mapping.
    return {
      ok: false,
      reason: "invalid_time"
    };
  }

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
