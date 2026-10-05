/**
 * Daily operations summary auto-dispatch.
 *
 * Enqueues one `daily_ops_summary` owner-email job at 20:00 JST
 * (0 11 * * * UTC cron). The summary includes per-store reservation
 * counts for today and tomorrow, open conflict count, recent dead job
 * counts (24h window), and auto-complete observability: still-confirmed
 * past end (N), still confirmed past this morning's sweep cutoff (M),
 * and today's auto-complete count (K).
 *
 * Each row is dedupe'd by `daily_ops_summary:{YYYY-MM-DD}:email:owner`
 * so repeated cron fires within the same JST day are idempotent (INSERT OR
 * IGNORE on dedupe_key).
 *
 * The dispatcher is gated by DAILY_OPS_SUMMARY_DISPATCH_ENABLED.
 */

import type { WorkerBindings } from "../bindings";
import { NOTIFICATION_ACKNOWLEDGEMENT_SQL } from "../admin/sync-recovery";
import { isDailyOpsSummaryDispatchEnabled } from "../runtime-config";
import { OWNER_EMAIL_RECIPIENT_ID } from "./operations-email";
import { JST_OFFSET_MS } from "../time-utils";
import {
  AUTO_COMPLETE_GRACE_MS,
  AUTO_COMPLETE_SWEEP_JST_MINUTES
} from "../reservations/auto-complete";

export type DailyOpsSummaryResult = {
  enqueued: number;
};

type StoreReservationCount = {
  store_id: string;
  store_name: string;
  count: number;
};

export type DailyOpsStats = {
  today_reservations: StoreReservationCount[];
  tomorrow_reservations: StoreReservationCount[];
  open_conflicts: number;
  dead_notification_jobs_24h: number;
  dead_calendar_sync_jobs_24h: number;
  past_end_still_confirmed: StoreReservationCount[];
  unswept_past_grace: StoreReservationCount[];
  auto_completed_today: number;
  daily_cleanup_last_run_at: string | null;
};

export type DailyOpsPayload = {
  stats: DailyOpsStats;
  date_jst: string;
};

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Format a UTC ms timestamp as JST YYYY-MM-DD.
 */
const formatJstDate = (utcMs: number): string => {
  const jst = new Date(utcMs + JST_OFFSET_MS);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jst.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const collectStoreReservationCounts = async (
  db: D1Database,
  rangeStartIso: string,
  rangeEndIso: string
): Promise<StoreReservationCount[]> => {
  const { results } = await db
    .prepare(
      `
      SELECT
        r.store_id AS store_id,
        s.name AS store_name,
        COUNT(*) AS count
      FROM reservations r
      JOIN stores s ON s.id = r.store_id
      WHERE r.status IN ('pending_approval', 'confirmed')
        AND r.start_at >= ?
        AND r.start_at < ?
      GROUP BY r.store_id
      ORDER BY s.name ASC
      `
    )
    .bind(rangeStartIso, rangeEndIso)
    .all<StoreReservationCount>();
  return results;
};

const collectOpenConflicts = async (db: D1Database): Promise<number> => {
  const row = await db
    .prepare("SELECT COUNT(*) AS cnt FROM google_calendar_conflicts WHERE resolution_status = 'open'")
    .first<{ cnt: number }>();
  return row?.cnt ?? 0;
};

const collectDeadNotificationJobs = async (db: D1Database, sinceIso: string): Promise<number> => {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM notification_jobs
       WHERE status = 'dead' AND updated_at >= ?
         AND NOT EXISTS (${NOTIFICATION_ACKNOWLEDGEMENT_SQL})`
    )
    .bind(sinceIso)
    .first<{ cnt: number }>();
  return row?.cnt ?? 0;
};

const collectDeadCalendarSyncJobs = async (db: D1Database, sinceIso: string): Promise<number> => {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM calendar_sync_jobs
       WHERE status = 'dead' AND updated_at >= ?`
    )
    .bind(sinceIso)
    .first<{ cnt: number }>();
  return row?.cnt ?? 0;
};

/**
 * Confirmed reservations whose end_at is at or before `cutoffIso`, grouped by
 * store. N and M share this shape but not the cutoff: merging them into one
 * query would hide a stopped sweep behind "still in grace" rows.
 */
const collectConfirmedEndedByStore = async (
  db: D1Database,
  cutoffIso: string
): Promise<StoreReservationCount[]> => {
  const { results } = await db
    .prepare(
      `
      SELECT
        r.store_id AS store_id,
        s.name AS store_name,
        COUNT(*) AS count
      FROM reservations r
      JOIN stores s ON s.id = r.store_id
      WHERE r.status = 'confirmed'
        AND r.end_at <= ?
      GROUP BY r.store_id
      ORDER BY s.name ASC
      `
    )
    .bind(cutoffIso)
    .all<StoreReservationCount>();
  return results;
};

const collectAutoCompletedToday = async (
  db: D1Database,
  jstDayStartIso: string
): Promise<number> => {
  // datetime() on both sides: audit_logs.created_at is DEFAULT CURRENT_TIMESTAMP
  // (space-separated). A lexical >= against an ISO bound drops those rows
  // because ' ' (0x20) < 'T' (0x54). The writer in auto-complete.ts stays
  // unchanged so a cutover day still counts mixed-format rows.
  const row = await db
    .prepare(
      // target_type は idx_audit_logs_target の先頭列。等値で絞ってから
       // datetime() で正確に判定する。created_at の素の範囲比較を前段に足しては
       // いけない (空白形式の行が境界で落ちる)。
      `SELECT COUNT(*) AS cnt FROM audit_logs
       WHERE target_type = 'reservation'
         AND action = 'system_reservation_auto_completed'
         AND datetime(created_at) >= datetime(?)`
    )
    .bind(jstDayStartIso)
    .first<{ cnt: number }>();
  return row?.cnt ?? 0;
};

const collectDailyCleanupLastRunAt = async (db: D1Database): Promise<string | null> => {
  // The completion marker, not the pre-work lock `retention_sweep_phase1`: the
  // lock is written before the sweep and only released when the sweep *rejects*,
  // so a hung sweep leaves it in place and would read as success — precisely the
  // stall this heartbeat exists to surface (src/retention-sweep.ts).
  // `runRetentionSweepPhase1` is called from exactly one place, the 01:05 JST
  // daily-cleanup cron branch (src/index.ts), so this attests that cron.
  const row = await db
    .prepare(
      `SELECT completed_at FROM google_calendar_history_maintenance_runs
       WHERE task_key = 'retention_sweep_phase1_completed'
       ORDER BY completed_at DESC
       LIMIT 1`
    )
    .first<{ completed_at: string }>();
  return row?.completed_at ?? null;
};

const collectDailyStats = async (
  db: D1Database,
  todayStartIso: string,
  tomorrowStartIso: string,
  dayAfterIso: string,
  dead24hStartIso: string,
  nowIso: string,
  sweepCutoffIso: string
): Promise<DailyOpsStats> => {
  const [
    todayRes,
    tomorrowRes,
    openConflicts,
    deadNotif,
    deadSync,
    pastEndStillConfirmed,
    unsweptPastGrace,
    autoCompletedToday,
    dailyCleanupLastRunAt
  ] = await Promise.all([
    collectStoreReservationCounts(db, todayStartIso, tomorrowStartIso),
    collectStoreReservationCounts(db, tomorrowStartIso, dayAfterIso),
    collectOpenConflicts(db),
    collectDeadNotificationJobs(db, dead24hStartIso),
    collectDeadCalendarSyncJobs(db, dead24hStartIso),
    collectConfirmedEndedByStore(db, nowIso),
    collectConfirmedEndedByStore(db, sweepCutoffIso),
    collectAutoCompletedToday(db, todayStartIso),
    collectDailyCleanupLastRunAt(db)
  ]);
  return {
    today_reservations: todayRes,
    tomorrow_reservations: tomorrowRes,
    open_conflicts: openConflicts,
    dead_notification_jobs_24h: deadNotif,
    dead_calendar_sync_jobs_24h: deadSync,
    past_end_still_confirmed: pastEndStillConfirmed,
    unswept_past_grace: unsweptPastGrace,
    auto_completed_today: autoCompletedToday,
    daily_cleanup_last_run_at: dailyCleanupLastRunAt
  };
};

export async function dispatchDailyOpsSummary(input: {
  db: D1Database;
  env: Partial<Pick<WorkerBindings, "DAILY_OPS_SUMMARY_DISPATCH_ENABLED">>;
  nowMs: number;
}): Promise<DailyOpsSummaryResult> {
  // Module-level flag-off guard (caller also checks, this is defence-in-depth)
  if (!isDailyOpsSummaryDispatchEnabled(input.env)) {
    return { enqueued: 0 };
  }
  // JST day boundaries in UTC
  const nowJst = new Date(input.nowMs + JST_OFFSET_MS);
  const todayJstStartUtcMs =
    Date.UTC(nowJst.getUTCFullYear(), nowJst.getUTCMonth(), nowJst.getUTCDate()) - JST_OFFSET_MS;
  const tomorrowJstStartUtcMs = todayJstStartUtcMs + MILLISECONDS_PER_DAY;
  const dayAfterJstStartUtcMs = tomorrowJstStartUtcMs + MILLISECONDS_PER_DAY;

  const todayStartIso = new Date(todayJstStartUtcMs).toISOString();
  const tomorrowStartIso = new Date(tomorrowJstStartUtcMs).toISOString();
  const dayAfterIso = new Date(dayAfterJstStartUtcMs).toISOString();
  const dead24hStartIso = new Date(input.nowMs - MILLISECONDS_PER_DAY).toISOString();
  const nowIso = new Date(input.nowMs).toISOString();
  // The cutoff this morning's sweep actually used. Both halves come from
  // auto-complete.ts so the monitor cannot drift away from the thing it
  // monitors. `nowMs - grace` is 20:00 JST minus grace and would flag
  // in-grace rows as unswept on a healthy night.
  const sweepCutoffIso = new Date(
    todayJstStartUtcMs + AUTO_COMPLETE_SWEEP_JST_MINUTES * 60 * 1000 - AUTO_COMPLETE_GRACE_MS
  ).toISOString();

  const stats = await collectDailyStats(
    input.db,
    todayStartIso,
    tomorrowStartIso,
    dayAfterIso,
    dead24hStartIso,
    nowIso,
    sweepCutoffIso
  );
  const dateJst = formatJstDate(todayJstStartUtcMs);
  const payload: DailyOpsPayload = { stats, date_jst: dateJst };
  const payloadJson = JSON.stringify(payload);

  const insert = await input.db
    .prepare(
      `
      INSERT OR IGNORE INTO notification_jobs (
        id, dedupe_key, template_key, recipient_type, recipient_id,
        reservation_id, status, attempts, available_at, payload_json
      ) VALUES (?, ?, 'daily_ops_summary', 'owner', ?, NULL, 'queued', 0, ?, ?)
      `
    )
    .bind(
      crypto.randomUUID(),
      `daily_ops_summary:${dateJst}:${OWNER_EMAIL_RECIPIENT_ID}`,
      OWNER_EMAIL_RECIPIENT_ID,
      nowIso,
      payloadJson
    )
    .run();

  const enqueued = insert.meta.changes;

  if (enqueued > 0) {
    console.log("daily_ops_summary_dispatch", {
      date_jst: dateJst,
      enqueued
    });
  }

  return { enqueued };
}
