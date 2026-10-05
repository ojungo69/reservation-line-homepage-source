import { safeCaptureException } from "./sentry-helpers";

/**
 * Phase 1 data-retention sweep — periodic cleanup of operational/transient
 * tables only. Customer records, reservations, visits, consent records and
 * audit logs are explicitly OUT OF SCOPE for Phase 1 (see
 * docs/policies/data-retention.md, PR #335).
 *
 * Execution model: invoked from the maintenance cron once per tick, but
 * guarded by a persistent daily-bucket marker (INSERT OR IGNORE into
 * google_calendar_history_maintenance_runs) so the actual DELETEs run at most
 * once per UTC day. This mirrors pruneGoogleEventHistory's idempotency
 * pattern (src/google/import-sync.ts) and reuses the same marker table with a
 * distinct task_key.
 *
 * D1 load control: each table is capped at DELETE_BATCH_LIMIT rows per run via
 * the `rowid IN (SELECT rowid ... LIMIT n)` idiom (SQLite DELETE does not
 * accept a LIMIT clause unless compiled with SQLITE_ENABLE_UPDATE_DELETE_LIMIT,
 * which D1 is not). Backlogs drain over successive daily runs.
 */

const RETENTION_TASK_KEY = "retention_sweep_phase1";
// Completion marker, distinct from RETENTION_TASK_KEY above. That one is a
// pre-work lock: it is written BEFORE the sweep, and the DELETE that releases it
// only runs if the sweep actually rejects. A hung sweep never settles at all
// (`withTaskTimeout` stops waiting but cannot cancel — see src/cron-watchdog.ts),
// so the lock survives a stall and therefore cannot attest that the work
// finished. The daily-ops heartbeat reads THIS key instead.
const RETENTION_COMPLETED_TASK_KEY = "retention_sweep_phase1_completed";

/** Max rows deleted per table per run, to bound D1 work. */
const DELETE_BATCH_LIMIT = 500;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Grace period (days) applied AFTER expires_at before a transient row is purged. */
const EXPIRY_GRACE_DAYS = 7;

const WEBHOOK_EVENT_RETENTION_DAYS = 90;
const GOOGLE_NOTIFICATION_RETENTION_DAYS = 90;
const RATE_LIMIT_EVENT_RETENTION_DAYS = 60;
const RESOLVED_CONFLICT_RETENTION_DAYS = 180;
// Terminal Google sync/import job rows (succeeded/failed/dead). Import jobs are
// kept longer as a full_reconcile audit trail. (notification_jobs are NOT swept
// here — see the rule comment below: data-retention.md reserves them for Phase 2.)
const CALENDAR_SYNC_JOB_RETENTION_DAYS = 90;
const IMPORT_JOB_RETENTION_DAYS = 180;
// Google calendar event tombstones (status cancelled/deleted). 'active' rows back the
// sync dedup UNIQUE and 'conflict'/'ignored' drive conflict-noise tracking — kept.
// (reservation_change_requests is deliberately NOT swept: data-retention.md classifies
// it as 予約履歴/任意, out of Phase 1, and §3.2 leaves its accounting/tax retention
// window unresolved. Owner decision 2026-06-24: do not auto-delete change requests.)
const GOOGLE_EVENT_DELETED_RETENTION_DAYS = 90;
// Grace applied to an orphaned CONFIRMED lock before release: only purge a lock whose
// backing reservation has had NO activity for this long (or is gone entirely), so a
// just-cancelled reservation whose lock-DELETE is still in flight is never raced.
const ORPHANED_CONFIRMED_LOCK_GRACE_DAYS = 1;

const toIso = (ms: number): string => new Date(ms).toISOString();

// SQLite-side v4-shaped UUID for history rows (mirrors src/reservations/expiration.ts).
const UUID_SQL =
  "lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || " +
  "lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6)))";

/**
 * Predicate for an ORPHANED confirmed lock on `table` (slot_locks / customer_time_locks).
 * A lock is orphaned when it is confirmed, owned by a reservation, that reservation is
 * no longer active (terminal OR gone), AND no reservation row for it was touched within
 * the grace window. The second NOT EXISTS handles BOTH the dangling case (no reservation
 * row at all → swept immediately, nothing to race) and the grace case (a terminal row
 * updated recently → kept until the window passes). Bind param: grace cutoff ISO.
 */
const orphanedConfirmedLockPredicate = (table: string): string =>
  `lock_status = 'confirmed'
   AND owner_type = 'reservation'
   AND NOT EXISTS (
     SELECT 1 FROM reservations
     WHERE reservations.id = ${table}.owner_id
       AND (
         reservations.status IN ('pending_approval', 'confirmed')
         OR datetime(reservations.updated_at) >= datetime(?)
       )
   )`;

export type RetentionSweepResult =
  | { skipped: true; reason: "already_ran_today" }
  | { skipped: false; deleted: Record<string, number> };

type SweepRule = {
  /** Logical name used as the key in the deleted-counts map and structured log. */
  table: string;
  /** Parameterized DELETE statement; the bound params come from `params`. */
  sql: string;
  /** Bound parameters for the statement, in order. */
  params: string[];
};

/**
 * Build the per-table DELETE rules for a given `now`. Cutoffs are computed once
 * so every table in a single run shares a consistent clock.
 *
 * Schema notes verified against migrations/0001_initial.sql:
 *  - slot_locks / customer_time_locks: only `lock_status = 'pending'` rows are
 *    expiry-driven, and expires_at is NULLABLE. Confirmed locks block bookings
 *    regardless of expires_at, so the sweep never touches them; NULL expiries
 *    are likewise never purged.
 *  - idempotency_keys / auth_states / google_calendar_outbound_writes have a
 *    NOT NULL expires_at.
 *  - google_calendar_notifications has NEITHER created_at NOR expires_at —
 *    age is measured by received_at.
 *  - rate_limit_events has NEITHER created_at NOR expires_at — age is measured
 *    by occurred_at.
 *  - google_calendar_conflicts: age by created_at, and only purge once the
 *    conflict is no longer open (resolution_status != 'open').
 *
 * All time comparisons are normalized with datetime() on BOTH sides: the
 * codebase has two coexisting TEXT timestamp formats — SQLite
 * CURRENT_TIMESTAMP defaults ('YYYY-MM-DD HH:MM:SS') from production INSERTs
 * and ISO with T+Z from app writers/tests. A raw '<' on TEXT would mis-order
 * them (' ' sorts before 'T'), deleting rows up to ~a day early. Mirrors the
 * cutoff handling in src/admin/operations.ts (listAdminAuditLogs).
 */
const buildSweepRules = (nowMs: number): SweepRule[] => {
  const expiryCutoffIso = toIso(nowMs - EXPIRY_GRACE_DAYS * MS_PER_DAY);
  const webhookCutoffIso = toIso(nowMs - WEBHOOK_EVENT_RETENTION_DAYS * MS_PER_DAY);
  const googleNotificationCutoffIso = toIso(
    nowMs - GOOGLE_NOTIFICATION_RETENTION_DAYS * MS_PER_DAY
  );
  const rateLimitCutoffIso = toIso(nowMs - RATE_LIMIT_EVENT_RETENTION_DAYS * MS_PER_DAY);
  const resolvedConflictCutoffIso = toIso(
    nowMs - RESOLVED_CONFLICT_RETENTION_DAYS * MS_PER_DAY
  );
  const calendarSyncJobCutoffIso = toIso(nowMs - CALENDAR_SYNC_JOB_RETENTION_DAYS * MS_PER_DAY);
  const importJobCutoffIso = toIso(nowMs - IMPORT_JOB_RETENTION_DAYS * MS_PER_DAY);
  const googleEventDeletedCutoffIso = toIso(nowMs - GOOGLE_EVENT_DELETED_RETENTION_DAYS * MS_PER_DAY);

  // Helper: cap each DELETE at DELETE_BATCH_LIMIT rows via a rowid subquery,
  // since SQLite/D1 DELETE does not support a LIMIT clause directly.
  const cappedDelete = (table: string, predicate: string): string =>
    `DELETE FROM ${table} WHERE rowid IN (` +
    `SELECT rowid FROM ${table} WHERE ${predicate} LIMIT ${DELETE_BATCH_LIMIT})`;

  return [
    // ── expires_at + grace (transient operational rows) ──────────────
    {
      table: "idempotency_keys",
      sql: cappedDelete("idempotency_keys", "datetime(expires_at) < datetime(?)"),
      params: [expiryCutoffIso]
    },
    {
      table: "auth_states",
      sql: cappedDelete("auth_states", "datetime(expires_at) < datetime(?)"),
      params: [expiryCutoffIso]
    },
    {
      table: "slot_locks",
      // Only pending locks are expiry-driven. The booking path treats
      // confirmed locks as blocking REGARDLESS of expires_at (defensive
      // data-anomaly handling, covered by
      // test/public-availability-google-live.test.ts), so the sweep must
      // mirror that and never purge a confirmed lock even if it anomalously
      // retains a stale non-NULL expires_at. expires_at is also nullable —
      // NULL rows are never purged.
      sql: cappedDelete(
        "slot_locks",
        "lock_status = 'pending' AND expires_at IS NOT NULL AND datetime(expires_at) < datetime(?)"
      ),
      params: [expiryCutoffIso]
    },
    {
      table: "customer_time_locks",
      // Same pending-only + non-NULL guard as slot_locks (same schema shape).
      sql: cappedDelete(
        "customer_time_locks",
        "lock_status = 'pending' AND expires_at IS NOT NULL AND datetime(expires_at) < datetime(?)"
      ),
      params: [expiryCutoffIso]
    },
    {
      table: "google_calendar_outbound_writes",
      sql: cappedDelete("google_calendar_outbound_writes", "datetime(expires_at) < datetime(?)"),
      params: [expiryCutoffIso]
    },
    // ── fixed-age operational logs ───────────────────────────────────
    {
      table: "line_webhook_events",
      sql: cappedDelete("line_webhook_events", "datetime(created_at) < datetime(?)"),
      params: [webhookCutoffIso]
    },
    {
      table: "google_calendar_notifications",
      // No created_at/expires_at column — age measured by received_at.
      sql: cappedDelete("google_calendar_notifications", "datetime(received_at) < datetime(?)"),
      params: [googleNotificationCutoffIso]
    },
    {
      table: "rate_limit_events",
      // No created_at/expires_at column — age measured by occurred_at.
      sql: cappedDelete("rate_limit_events", "datetime(occurred_at) < datetime(?)"),
      params: [rateLimitCutoffIso]
    },
    // ── resolved conflicts only (open conflicts are never purged) ─────
    {
      table: "google_calendar_conflicts",
      sql: cappedDelete(
        "google_calendar_conflicts",
        "resolution_status != 'open' AND datetime(created_at) < datetime(?)"
      ),
      params: [resolvedConflictCutoffIso]
    },
    // ── terminal Google sync/import job rows, by updated_at (last activity) ──
    // Only terminal statuses ('succeeded'/'failed'/'dead') are purged; in-flight
    // rows ('queued'/'processing'/'retryable') are never touched so a job mid-
    // retry is never deleted. The terminal triple mirrors the full_reconcile
    // guard in import-sync.ts. Both tables previously had no retention rule and
    // grew unbounded. These are 運用 (operational) job queues with no PII and no
    // delivery evidence — data-retention.md §2 ("Google 連携の現況・ジョブ … 終端
    // ジョブ 90日〜1年") / §4 Phase 1 designate terminal rows as auto-purgeable.
    //
    // notification_jobs / notification_logs are deliberately NOT swept here:
    // data-retention.md §2 classifies notification logs as 送達証跡 (delivery
    // evidence, 1–2yr reference window) and §4 reserves their automatic deletion
    // for Phase 2, pending an owner-approved retention window. Sweeping them on a
    // 90-day clock would destroy that evidence before that decision.
    //
    // Age is measured by updated_at, not created_at: a job created long ago can
    // reach a terminal state *recently* (a long-stale processing row gets dead-
    // lettered, or an operator retries an old job and it fails again). Keying off
    // created_at would sweep that row on the next daily cleanup — before the new
    // failure is seen in the admin attention list or the 24h ops failure counts
    // (both keyed off current status/updated_at). updated_at >= created_at always,
    // so this also subsumes the created_at cutoff for the normal create≈process
    // case. The retention window thus means "N days since last activity".
    {
      table: "calendar_sync_jobs",
      // google_calendar_outbound_writes (calendar_sync_job_id … ON DELETE SET NULL)
      // survive with a nulled FK — the dedupe_key still guards replay.
      sql: cappedDelete(
        "calendar_sync_jobs",
        "status IN ('succeeded', 'failed', 'dead') AND datetime(updated_at) < datetime(?)"
      ),
      params: [calendarSyncJobCutoffIso]
    },
    {
      table: "google_calendar_import_jobs",
      sql: cappedDelete(
        "google_calendar_import_jobs",
        "status IN ('succeeded', 'failed', 'dead') AND datetime(updated_at) < datetime(?)"
      ),
      params: [importJobCutoffIso]
    },
    // reservation_change_requests is deliberately NOT swept here: data-retention.md
    // classifies it as 予約履歴 (reservation history, 区分=任意), out of Phase 1, and
    // §3.2 leaves its accounting/tax retention window unresolved. Deleting it would
    // erase the customer's cancel/reschedule decision trail and null the
    // notification_jobs.change_request_id FK. Owner decision 2026-06-24: keep it.
    // ── Google calendar event tombstones (active/conflict/ignored kept) ───────
    {
      table: "google_calendar_events",
      // Only cancelled/deleted tombstones are purged, aged by last_seen_at (the
      // sole timestamp column). 'active' backs the UNIQUE(calendar_id,
      // google_event_id) sync dedup; 'conflict'/'ignored' drive conflict-noise
      // suppression — none of those are swept.
      sql: cappedDelete(
        "google_calendar_events",
        "status IN ('cancelled', 'deleted') AND datetime(last_seen_at) < datetime(?)"
      ),
      params: [googleEventDeletedCutoffIso]
    }
  ];
};

/**
 * Sweep ORPHANED confirmed locks (backlog ⑩). A confirmed lock whose backing
 * reservation is terminal/gone blocks its slot forever — slot_locks/customer_time_locks
 * carry no FK on owner_id, so a crash between the reservation's terminal transition and
 * the lock-DELETE (or a bulk-cleanup bug) leaves the lock stranded. The grace window
 * avoids racing a just-cancelled reservation whose normal lock release is still in flight.
 *
 * slot_locks releases are recorded to slot_lock_history before deletion (a permanent
 * slot block is serious enough to keep an audit trail). The history-INSERT and DELETE run
 * in a single D1 batch so they share one snapshot — the audited rows are exactly the
 * deleted rows. customer_time_locks has no history table, so it is cap-deleted directly.
 * Both run under the caller's try/catch (marker release + Sentry capture on failure).
 */
const sweepOrphanedConfirmedLocks = async (
  db: D1Database,
  graceCutoffIso: string
): Promise<{ slot_locks_orphaned: number; customer_time_locks_orphaned: number }> => {
  const slotPredicate = orphanedConfirmedLockPredicate("slot_locks");
  const slotBatch = await db.batch([
    db
      .prepare(
        `INSERT INTO slot_lock_history
           (id, slot_lock_id, store_id, resource_id, old_slot_at, old_owner_id,
            action, actor_type, actor_id, reason)
         SELECT ${UUID_SQL}, id, store_id, resource_id, slot_at, owner_id,
                'released', 'system', 'retention-sweep', 'orphaned_confirmed_lock'
         FROM slot_locks
         WHERE ${slotPredicate}
         ORDER BY rowid
         LIMIT ${DELETE_BATCH_LIMIT}`
      )
      .bind(graceCutoffIso),
    db
      .prepare(
        `DELETE FROM slot_locks WHERE rowid IN (
           SELECT rowid FROM slot_locks WHERE ${slotPredicate} ORDER BY rowid LIMIT ${DELETE_BATCH_LIMIT}
         )`
      )
      .bind(graceCutoffIso)
  ]);

  const ctlPredicate = orphanedConfirmedLockPredicate("customer_time_locks");
  const ctlResult = await db
    .prepare(
      `DELETE FROM customer_time_locks WHERE rowid IN (
         SELECT rowid FROM customer_time_locks WHERE ${ctlPredicate} ORDER BY rowid LIMIT ${DELETE_BATCH_LIMIT}
       )`
    )
    .bind(graceCutoffIso)
    .run();

  return {
    slot_locks_orphaned: slotBatch[1]?.meta?.changes ?? 0,
    customer_time_locks_orphaned: ctlResult.meta?.changes ?? 0
  };
};

/**
 * Run the Phase 1 retention sweep. Idempotent per UTC day via a persistent
 * marker row. Returns `{ skipped: true }` when today's sweep already ran.
 *
 * On a DELETE failure the daily marker is released so the next scheduled
 * invocation retries (rather than reporting a false "already_ran_today" until
 * midnight UTC), the error is reported to Sentry, and the error is rethrown
 * so direct callers/tests observe the failure. The maintenance cron call-site
 * (src/index.ts) catches the rejection — Sentry reporting already happened
 * here, and this lowest-priority cleanup must not reject the maintenance
 * Promise.all (an early rejection would settle ctx.waitUntil while sibling
 * tasks such as LINE notification dispatch are still in flight).
 */
export async function runRetentionSweepPhase1(input: {
  db: D1Database;
  now?: () => number;
}): Promise<RetentionSweepResult> {
  const nowMs = (input.now ?? Date.now)();
  const nowIso = toIso(nowMs);
  const dayBucket = nowIso.slice(0, 10);

  // Persistent daily-bucket dedupe + lock: INSERT OR IGNORE writes today's
  // marker; if another tick already wrote it the INSERT reports 0 changes and
  // we short-circuit. Reuses google_calendar_history_maintenance_runs with a
  // distinct task_key (no new migration required).
  let markerResult: D1Result;
  try {
    markerResult = await input.db
      .prepare(
        `
          INSERT OR IGNORE INTO google_calendar_history_maintenance_runs
            (task_key, day_bucket, completed_at)
          VALUES (?, ?, ?)
        `
      )
      .bind(RETENTION_TASK_KEY, dayBucket, nowIso)
      .run();
  } catch (error) {
    // The maintenance cron call-site swallows our rejection on the premise
    // that EVERY failure path here self-reports to Sentry. The marker INSERT
    // runs before the main try/catch below, so it needs its own capture —
    // otherwise a D1 failure here would be completely silent in production.
    // No marker release needed: nothing was written.
    safeCaptureException(error, {
      tags: { operation: "retention_sweep_phase1" },
      contexts: { retention_sweep: { day_bucket: dayBucket, stage: "marker_insert" } }
    });
    throw error;
  }
  if ((markerResult.meta?.changes ?? 0) === 0) {
    return { skipped: true, reason: "already_ran_today" };
  }

  const rules = buildSweepRules(nowMs);
  const deleted: Record<string, number> = {};

  try {
    for (const rule of rules) {
      const result = await input.db
        .prepare(rule.sql)
        .bind(...rule.params)
        .run();
      deleted[rule.table] = result.meta?.changes ?? 0;
    }

    // Orphaned confirmed-lock release (⑩) — separate from the single-DELETE rules
    // above because it audits to slot_lock_history. Counts use distinct keys so the
    // pending-expiry rule's slot_locks/customer_time_locks counts stay unambiguous.
    const graceCutoffIso = toIso(nowMs - ORPHANED_CONFIRMED_LOCK_GRACE_DAYS * MS_PER_DAY);
    const orphaned = await sweepOrphanedConfirmedLocks(input.db, graceCutoffIso);
    deleted.slot_locks_orphaned = orphaned.slot_locks_orphaned;
    deleted.customer_time_locks_orphaned = orphaned.customer_time_locks_orphaned;
  } catch (error) {
    safeCaptureException(error, {
      tags: { operation: "retention_sweep_phase1" },
      contexts: { retention_sweep: { day_bucket: dayBucket } }
    });
    // Release the daily marker so the next scheduled tick can retry instead of
    // being locked out until midnight UTC. A release failure is swallowed so
    // the ORIGINAL sweep error still propagates, but it is logged/reported —
    // otherwise the stale marker silently blocks same-day retries.
    await input.db
      .prepare(
        `
          DELETE FROM google_calendar_history_maintenance_runs
          WHERE task_key = ? AND day_bucket = ?
        `
      )
      .bind(RETENTION_TASK_KEY, dayBucket)
      .run()
      .catch((releaseError: unknown) => {
        console.error("retention_sweep_marker_release_failed", {
          day_bucket: dayBucket,
          error: releaseError instanceof Error ? releaseError.message : String(releaseError)
        });
        safeCaptureException(releaseError, {
          tags: { operation: "retention_sweep_marker_release" },
          contexts: { retention_sweep: { day_bucket: dayBucket } }
        });
      });
    throw error;
  }

  // Its own try/catch: a marker write failure must not fail a sweep that already
  // deleted rows, and one night reported as missing is safer than one hidden.
  try {
    await input.db
      .prepare(
        `
          INSERT OR REPLACE INTO google_calendar_history_maintenance_runs
            (task_key, day_bucket, completed_at)
          VALUES (?, ?, ?)
        `
      )
      .bind(RETENTION_COMPLETED_TASK_KEY, dayBucket, toIso((input.now ?? Date.now)()))
      .run();
  } catch (error) {
    safeCaptureException(error, {
      tags: { operation: "retention_sweep_phase1" },
      contexts: { retention_sweep: { day_bucket: dayBucket, stage: "completion_marker" } }
    });
  }

  // Structured observability log: one event with per-table delete counts.
  console.info("retention_sweep", {
    event: "retention_sweep",
    day_bucket: dayBucket,
    deleted
  });

  return { skipped: false, deleted };
}
