import { safeCaptureException } from "../sentry-helpers";
import { classifyD1SweepFailure } from "../outbound-timeout";
import { toIso } from "../time-utils";
import { buildClosePendingChangeRequestsStatement } from "./transitions";

export type ExpirePendingReservationsResult =
  | {
      ok: true;
      expiredCount: number;
    }
  | {
      ok: false;
      reason: "missing_database" | "write_failed" | "d1_export_locked" | "transient_d1";
    };

type ExpiringReservationRow = {
  id: string;
  version: number;
};

const DEFAULT_MAX_RESERVATIONS = 50;
const SUPERSEDED_BY_EXPIRY = "superseded_by_reservation_expiry";

export const limitBatchSize = (value: number | undefined) => {
  // The `value === undefined` check is load-bearing for the type system, not
  // dead code: Number.isInteger is typed `(n: unknown) => boolean`, not a type
  // guard, so it does not narrow away `undefined` on its own. Keep it so the
  // `value` below is `number` (it is a runtime no-op since
  // Number.isInteger(undefined) is already false).
  if (value === undefined || !Number.isInteger(value)) {
    return DEFAULT_MAX_RESERVATIONS;
  }
  return Math.min(Math.max(value, 1), 200);
};

// A pending_approval reservation expires when EITHER its approval TTL elapsed
// (pending_expires_at) OR its appointment time has fully passed (end_at <= now).
// The latter matters for short-lead bookings: a slot booked ~minutes before it
// starts can end while pending_expires_at (created_at + TTL) is still in the
// future. Such a defunct reservation is unapprovable in practice yet would keep
// occupying the `one pending per line` UNIQUE index — blocking the customer's
// next booking and dead-ending the recovery link (the my-reservations page hides
// it via `end_at > now`). Expiring on end_at clears the block at appointment end.
const fetchExpiringReservations = async (
  db: D1Database,
  nowIso: string,
  maxReservations: number
) => {
  const rows = await db
    .prepare(
      `
        SELECT id, version
        FROM reservations
        WHERE status = 'pending_approval'
          AND (
            (pending_expires_at IS NOT NULL AND pending_expires_at <= ?)
            OR end_at <= ?
          )
        ORDER BY pending_expires_at ASC, created_at ASC
        LIMIT ?
      `
    )
    .bind(nowIso, nowIso, maxReservations)
    .all<ExpiringReservationRow>();
  return rows.results ?? [];
};

const buildExpireStatements = (input: {
  db: D1Database;
  reservation: ExpiringReservationRow;
  nowIso: string;
}) => {
  const nextVersion = input.reservation.version + 1;
  return [
    input.db
      .prepare(
        `
          UPDATE reservations
          SET status = 'expired',
              pending_expires_at = NULL,
              updated_by = 'system',
              version = version + 1,
              updated_at = ?
          WHERE id = ?
            AND status = 'pending_approval'
            AND (
              (pending_expires_at IS NOT NULL AND pending_expires_at <= ?)
              OR end_at <= ?
            )
        `
      )
      .bind(input.nowIso, input.reservation.id, input.nowIso, input.nowIso),
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
            'expired',
            'system',
            'reservation-expiry',
            'pending_approval_expired'
          FROM slot_locks
          WHERE owner_type = 'reservation'
            AND owner_id = ?
            AND EXISTS (
              SELECT 1
              FROM reservations
              WHERE id = ?
                AND status = 'expired'
                AND updated_by = 'system'
                AND updated_at = ?
            )
        `
      )
      .bind(input.reservation.id, input.reservation.id, input.nowIso),
    input.db
      .prepare(
        `
          DELETE FROM slot_locks
          WHERE owner_type = 'reservation'
            AND owner_id = ?
            AND EXISTS (
              SELECT 1
              FROM reservations
              WHERE id = ?
                AND status = 'expired'
                AND updated_by = 'system'
                AND updated_at = ?
            )
        `
      )
      .bind(input.reservation.id, input.reservation.id, input.nowIso),
    input.db
      .prepare(
        `
          DELETE FROM customer_time_locks
          WHERE owner_type = 'reservation'
            AND owner_id = ?
            AND EXISTS (
              SELECT 1
              FROM reservations
              WHERE id = ?
                AND status = 'expired'
                AND updated_by = 'system'
                AND updated_at = ?
            )
        `
      )
      .bind(input.reservation.id, input.reservation.id, input.nowIso),
    input.db
      .prepare(
        `
          UPDATE calendar_sync_jobs
          SET status = 'succeeded',
              locked_until = NULL,
              last_error = ?,
              updated_at = ?
          WHERE owner_type = 'reservation'
            AND owner_id = ?
            AND google_action = 'upsert'
            AND status IN ('queued', 'retryable', 'processing')
            AND EXISTS (
              SELECT 1
              FROM reservations
              WHERE id = ?
                AND status = 'expired'
                AND updated_by = 'system'
                AND updated_at = ?
            )
        `
      )
      .bind(
        SUPERSEDED_BY_EXPIRY,
        input.nowIso,
        input.reservation.id,
        input.reservation.id,
        input.nowIso
      ),
    input.db
      .prepare(
        `
          UPDATE notification_jobs
          SET status = 'succeeded',
              locked_until = NULL,
              last_error = ?,
              updated_at = ?
          WHERE reservation_id = ?
            AND template_key IN ('reservation_pending_received', 'pending_approval_created', 'reservation_new_customer')
            AND status IN ('queued', 'retryable', 'processing')
            AND EXISTS (
              SELECT 1
              FROM reservations
              WHERE id = ?
                AND status = 'expired'
                AND updated_by = 'system'
                AND updated_at = ?
            )
        `
      )
      .bind(
        SUPERSEDED_BY_EXPIRY,
        input.nowIso,
        input.reservation.id,
        input.reservation.id,
        input.nowIso
      ),
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
          )
          SELECT ?, ?, 'reservation', ?, 'delete', 'queued', ?
          WHERE EXISTS (
            SELECT 1
            FROM reservations
            WHERE id = ?
              AND status = 'expired'
              AND updated_by = 'system'
              AND updated_at = ?
          )
        `
      )
      .bind(
        crypto.randomUUID(),
        `reservation:${input.reservation.id}:google:delete:revision:${nextVersion}`,
        input.reservation.id,
        input.nowIso,
        input.reservation.id,
        input.nowIso
      ),
    // 失効した予約への pending 変更申請を閉じる (terminal 遷移の共通処理。ガードは
    // 本 batch の予約 UPDATE と同一条件)。decided_by_admin_id は付けない (システム閉鎖)。
    buildClosePendingChangeRequestsStatement({
      db: input.db,
      reservationId: input.reservation.id,
      nowIso: input.nowIso,
      terminalGuardSql: `EXISTS (
              SELECT 1
              FROM reservations
              WHERE id = ?
                AND status = 'expired'
                AND updated_by = 'system'
                AND updated_at = ?
            )`,
      terminalGuardBinds: [input.reservation.id, input.nowIso]
    }),
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
          SELECT ?, 'system', 'reservation-expiry', 'system_reservation_expired', 'reservation', ?, ?
          WHERE EXISTS (
            SELECT 1
            FROM reservations
            WHERE id = ?
              AND status = 'expired'
              AND updated_by = 'system'
              AND updated_at = ?
          )
        `
      )
      .bind(
        crypto.randomUUID(),
        input.reservation.id,
        JSON.stringify({
          previousStatus: "pending_approval",
          nextStatus: "expired"
        }),
        input.reservation.id,
        input.nowIso
      )
  ];
};

export async function expirePendingReservations(input: {
  db?: D1Database;
  now?: () => number;
  maxReservations?: number;
  drain?: boolean;
}): Promise<ExpirePendingReservationsResult> {
  if (!input.db) {
    return {
      ok: false,
      reason: "missing_database"
    };
  }

  const nowIso = toIso(new Date(input.now?.() ?? Date.now()));
  const maxReservations = limitBatchSize(input.maxReservations);

  try {
    let expiredCount = 0;
    let shouldContinue = true;
    while (shouldContinue) {
      const reservations = await fetchExpiringReservations(input.db, nowIso, maxReservations);
      for (const reservation of reservations) {
        await input.db.batch(
          buildExpireStatements({
            db: input.db,
            reservation,
            nowIso
          })
        );
      }
      expiredCount += reservations.length;
      shouldContinue = input.drain === true && reservations.length === maxReservations;
    }

    return {
      ok: true,
      expiredCount
    };
  } catch (error) {
    // 元の D1 エラーを握り潰すと再発時に原因究明できないため、原エラーだけ Sentry
    // に記録する（safeCaptureException 側で D1 の long-running export ロックは抑止
    // される）。export ロック時は従来の専用 reason、それ以外の retryable D1 障害は
    // transient_d1 を返し、呼び出し側が soft スキップして次 tick で retry できる
    // ようにする。internal error は capture 抑止対象へ広げず観測を残す。
    // Sentry RESERVATION-LINE-HOMEPAGE-D/E/F。
    safeCaptureException(error, {
      tags: { operation: "pending_reservation_expiration" }
    });
    return {
      ok: false,
      reason: classifyD1SweepFailure(error)
    };
  }
}
