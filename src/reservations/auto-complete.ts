import type { AdminUser } from "../admin/access";
import { adminWriteGuard, adminWriteWasRevoked } from "../admin/write-authorization";
import { classifyD1SweepFailure } from "../outbound-timeout";
import { safeCaptureException } from "../sentry-helpers";
import { toIso } from "../time-utils";
import { limitBatchSize } from "./expiration";
import { buildClosePendingChangeRequestsStatement } from "./transitions";

export type AutoCompleteReservationsResult =
  | { ok: true; completedCount: number }
  | {
      ok: false;
      reason: "forbidden" | "missing_database" | "write_failed" | "d1_export_locked" | "transient_d1";
    };

type AutoCompleteReservationRow = {
  id: string;
  customer_id: string;
  store_id: string;
  start_at: string;
  source: string;
  checked_in_at: string | null;
};

// 自動完了の猶予とスケジュールはここが正本。監視側 (日次サマリー) が別の値を
// 持つと、処理が正常でも「未処理」と報告したり、停止を検知できなくなる。
// cron 文字列そのものは wrangler.jsonc にあるので、test/auto-complete-schedule.test.ts
// が `5 16 * * *` とこの定数の一致を固定している。
/** 終了後この時間だけオーナーの手動操作を待ってから自動完了する。 */
export const AUTO_COMPLETE_GRACE_MS = 2 * 24 * 60 * 60 * 1000;
/** sweep が走る JST 時刻 (00:00 からの分)。cron `5 16 * * *` UTC = 01:05 JST。 */
export const AUTO_COMPLETE_SWEEP_JST_MINUTES = 65;

const fetchAutoCompleteReservations = async (
  db: D1Database,
  cutoffIso: string,
  maxReservations: number
) => {
  const rows = await db
    .prepare(
      `
        SELECT id, customer_id, store_id, start_at, source, checked_in_at
        FROM reservations
        WHERE status = 'confirmed' AND end_at <= ?
        ORDER BY end_at ASC
        LIMIT ?
      `
    )
    .bind(cutoffIso, maxReservations)
    .all<AutoCompleteReservationRow>();
  return rows.results ?? [];
};

const buildAutoCompleteStatements = (input: {
  db: D1Database;
  reservation: AutoCompleteReservationRow;
  nowIso: string;
  cutoffIso: string;
}) => {
  // Each dependent statement is gated on the row having been completed by THIS run
  // (status flipped to completed with this run's nowIso). Mirrors expiration.ts.
  // ponytail: the guard keys on updated_at, not a per-run token, so two sweeps that
  // pick the identical millisecond for the same still-confirmed row could both pass
  // the guard and collide on customer_visits.reservation_id UNIQUE (batch throws,
  // surfaces via the cron wrapper, self-heals on the next idempotent run). Acceptable
  // because the only two callers — the daily cron and the owner backfill endpoint —
  // are not run concurrently in practice; add a per-run token if that ever changes.
  const completedGuardSql = `EXISTS (
              SELECT 1
              FROM reservations
              WHERE id = ?
                AND status = 'completed'
                AND updated_by = 'system'
                AND updated_at = ?
            )`;
  // keep-in-sync with buildCompleteVisitStatement (visited_at = start_at, source mapping).
  const visitSource =
    input.reservation.source === "phone_admin"
      ? "phone_admin_completed"
      : "reservation_completed";

  return [
    input.db
      .prepare(
        `
          UPDATE reservations
          SET status = 'completed',
              completed_at = ?,
              pending_expires_at = NULL,
              updated_by = 'system',
              version = version + 1,
              updated_at = ?
          WHERE id = ?
            AND status = 'confirmed'
            AND end_at <= ?
        `
      )
      .bind(input.nowIso, input.nowIso, input.reservation.id, input.cutoffIso),
    input.db
      .prepare(
        `
          INSERT INTO slot_lock_history (
            id,
            slot_lock_id,
            store_id,
            resource_id,
            old_slot_at,
            old_owner_id,
            action,
            actor_type,
            actor_id,
            reason
          )
          SELECT
            lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6))),
            id,
            store_id,
            resource_id,
            slot_at,
            owner_id,
            'released',
            'system',
            'system',
            'auto_complete'
          FROM slot_locks
          WHERE owner_type = 'reservation'
            AND owner_id = ?
            AND ${completedGuardSql}
        `
      )
      .bind(input.reservation.id, input.reservation.id, input.nowIso),
    input.db
      .prepare(
        `
          DELETE FROM slot_locks
          WHERE owner_type = 'reservation'
            AND owner_id = ?
            AND ${completedGuardSql}
        `
      )
      .bind(input.reservation.id, input.reservation.id, input.nowIso),
    input.db
      .prepare(
        `
          DELETE FROM customer_time_locks
          WHERE owner_type = 'reservation'
            AND owner_id = ?
            AND ${completedGuardSql}
        `
      )
      .bind(input.reservation.id, input.reservation.id, input.nowIso),
    buildClosePendingChangeRequestsStatement({
      db: input.db,
      reservationId: input.reservation.id,
      nowIso: input.nowIso,
      terminalGuardSql: completedGuardSql,
      terminalGuardBinds: [input.reservation.id, input.nowIso]
    }),
    input.db
      .prepare(
        `
          -- Always insert a visit, regardless of customer archived/merged state.
          -- Skipping here would leave a completed reservation with no visit
          -- history and break the core invariant that complete == one valid visit.
          -- Manual buildCompleteVisitStatement already inserts unconditionally;
          -- this path must match so auto and manual complete cannot diverge.
          INSERT INTO customer_visits (
            id,
            customer_id,
            reservation_id,
            store_id,
            visited_at,
            visit_source,
            recorded_by
          )
          SELECT ?, r.customer_id, r.id, r.store_id, r.start_at, ?, 'system'
          FROM reservations r
          WHERE r.id = ?
            AND r.status = 'completed'
            AND r.updated_by = 'system'
            AND r.updated_at = ?
        `
      )
      .bind(crypto.randomUUID(), visitSource, input.reservation.id, input.nowIso),
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
          )
          SELECT ?, 'system', 'system', 'system_reservation_auto_completed', 'reservation', ?, ?
          WHERE ${completedGuardSql}
        `
      )
      .bind(
        crypto.randomUUID(),
        input.reservation.id,
        JSON.stringify({
          previousStatus: input.reservation.checked_in_at ? "checked_in" : "confirmed",
          nextStatus: "completed"
        }),
        input.reservation.id,
        input.nowIso
      )
  ];
};

export async function autoCompleteReservations(input: {
  db?: D1Database;
  admin?: AdminUser;
  now?: () => number;
  graceMs?: number;
  maxReservations?: number;
  drain?: boolean;
}): Promise<AutoCompleteReservationsResult> {
  if (!input.db) {
    return {
      ok: false,
      reason: "missing_database"
    };
  }

  if (input.admin?.role === "staff") return { ok: false, reason: "forbidden" };
  const graceMs = input.graceMs ?? 0;
  // Read the clock once so nowIso (the completion timestamp) and cutoffIso (the
  // end_at eligibility boundary) derive from the same instant.
  const nowMs = input.now?.() ?? Date.now();
  const nowIso = toIso(new Date(nowMs));
  const cutoffIso = toIso(new Date(nowMs - graceMs));
  const maxReservations = limitBatchSize(input.maxReservations);

  try {
    let completedCount = 0;
    let shouldContinue = true;
    while (shouldContinue) {
      const reservations = await fetchAutoCompleteReservations(
        input.db,
        cutoffIso,
        maxReservations
      );
      for (const reservation of reservations) {
        await input.db.batch([
          ...(input.admin ? [adminWriteGuard(input.db, input.admin)] : []),
          ...buildAutoCompleteStatements({
            db: input.db,
            reservation,
            nowIso,
            cutoffIso
          })
        ]);
      }
      completedCount += reservations.length;
      shouldContinue = input.drain === true && reservations.length === maxReservations;
    }

    return {
      ok: true,
      completedCount
    };
  } catch (error) {
    if (input.admin && await adminWriteWasRevoked(input.db, input.admin, error)) return { ok: false, reason: "forbidden" };
    // retryable D1 障害は次回 sweep へ回すが、internal error は export ロック専用の
    // capture 抑止対象に含めず、Sentry RESERVATION-LINE-HOMEPAGE-E/F に観測を残す。
    safeCaptureException(error, {
      tags: { operation: "reservation_auto_completion" }
    });
    return {
      ok: false,
      reason: classifyD1SweepFailure(error)
    };
  }
}

// Cron entrypoint. autoCompleteReservations soft-fails (never throws) so the owner
// backfill endpoint can return a structured result, but the daily-cleanup cron's
// contract is that a genuine failure SHOULD surface to the Sentry monitor (its
// siblings pruneGoogleEventHistory / runRetentionSweepPhase1 rethrow — see
// src/index.ts). Mirror expireReservationsBeforeSideEffects: re-throw non-transient
// failures; keep retryable D1 infrastructure failures soft so the next cron can
// retry them. internal errors remain captured by safeCaptureException above.
export async function runAutoCompleteForCron(input: {
  db?: D1Database;
  graceMs: number;
  now?: () => number;
}): Promise<void> {
  const result = await autoCompleteReservations({
    db: input.db,
    now: input.now,
    graceMs: input.graceMs,
    drain: true,
    maxReservations: 200
  });
  if (
    !result.ok &&
    result.reason !== "d1_export_locked" &&
    result.reason !== "transient_d1"
  ) {
    throw new Error(`reservation_auto_completion_${result.reason}`);
  }
}
