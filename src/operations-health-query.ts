import type { WorkerBindings } from "./bindings";
import { isGoogleImportEnabled } from "./runtime-config";

type HealthRow = {
  calendar: number;
  google_import: number;
  notification: number;
};

const STALE_SECONDS = 20 * 60;

// Filter by the existing status indexes before checking timestamps. D1 stores
// both ISO and SQLite timestamps, so epoch comparison is required.
// Exhausted processing claims still need the dispatcher to dead-letter them;
// a stopped sweeper must remain visible even after the retry cap is reached.
const HEALTH_SQL = `
WITH clock AS (SELECT ? AS now_seconds, ? AS stale_seconds)
SELECT
  EXISTS (
    SELECT 1 FROM calendar_sync_jobs AS j
    LEFT JOIN reservations AS r ON j.owner_type = 'reservation' AND r.id = j.owner_id
    LEFT JOIN external_blocks AS b ON j.owner_type = 'external_block' AND b.id = j.owner_id
    JOIN stores AS s ON s.id = COALESCE(r.store_id, b.store_id)
    WHERE j.status IN ('queued', 'retryable', 'processing')
      AND j.google_action IN ('upsert', 'delete')
      AND s.google_calendar_id IS NOT NULL
      AND CAST(strftime('%s', j.updated_at) AS INTEGER) <= (SELECT stale_seconds FROM clock)
      AND (
        (j.status IN ('queued', 'retryable')
          AND CAST(strftime('%s', j.available_at) AS INTEGER) <= (SELECT stale_seconds FROM clock))
        OR (j.status = 'processing'
          AND CAST(strftime('%s', j.locked_until) AS INTEGER) < (SELECT now_seconds FROM clock))
      )
      AND (
        (j.owner_type = 'reservation' AND r.id IS NOT NULL AND
          ((j.google_action = 'upsert' AND r.status IN
            ('pending_approval', 'confirmed', 'completed', 'no_show', 'rejected',
             'expired', 'cancelled_by_customer', 'cancelled_by_admin'))
           OR (j.google_action = 'delete' AND r.status IN
            ('rejected', 'expired', 'cancelled_by_customer', 'cancelled_by_admin'))))
        OR (j.owner_type = 'external_block' AND b.id IS NOT NULL AND
          ((j.google_action = 'upsert' AND b.status IN ('active', 'cancelled'))
           OR (j.google_action = 'delete' AND b.status = 'cancelled')))
      )
    LIMIT 1
  ) AS calendar,
  (? = 1 AND EXISTS (
    SELECT 1 FROM google_calendar_import_jobs AS j
    WHERE j.status IN ('queued', 'retryable', 'processing')
      AND CAST(strftime('%s', j.updated_at) AS INTEGER) <= (SELECT stale_seconds FROM clock)
      AND (
        (j.status IN ('queued', 'retryable')
          AND CAST(strftime('%s', j.next_run_at) AS INTEGER) <= (SELECT stale_seconds FROM clock))
        OR (j.status = 'processing'
          AND CAST(strftime('%s', j.locked_until) AS INTEGER) < (SELECT now_seconds FROM clock))
      )
    LIMIT 1
  )) AS google_import,
  EXISTS (
    SELECT 1 FROM notification_jobs AS j
    LEFT JOIN reservations AS r ON r.id = j.reservation_id
    WHERE j.status IN ('queued', 'retryable', 'processing')
      AND CAST(strftime('%s', j.updated_at) AS INTEGER) <= (SELECT stale_seconds FROM clock)
      AND (
        (j.status IN ('queued', 'retryable')
          AND CAST(strftime('%s', j.available_at) AS INTEGER) <= (SELECT stale_seconds FROM clock))
        OR (j.status = 'processing'
          AND CAST(strftime('%s', j.locked_until) AS INTEGER) < (SELECT now_seconds FROM clock))
      )
      AND NOT EXISTS (
        SELECT 1 FROM audit_logs AS a
        WHERE a.target_type = 'notification_jobs'
          AND a.target_id = j.id
          AND a.action = 'admin_sync_job_acknowledged'
      )
      AND (
        (j.recipient_type IN ('customer', 'owner') AND r.id IS NOT NULL
          AND (
            (j.template_key IN
              ('reservation_pending_received', 'reservation_new_customer', 'pending_approval_created')
              AND r.status = 'pending_approval'
              AND (r.pending_expires_at IS NULL OR
                CAST(strftime('%s', r.pending_expires_at) AS INTEGER) > (SELECT now_seconds FROM clock)))
            OR (j.template_key IN ('reservation_confirmed', 'reservation_reminder')
              AND r.status = 'confirmed'
              AND (j.template_key != 'reservation_reminder' OR
                CAST(strftime('%s', r.start_at) AS INTEGER) > (SELECT now_seconds FROM clock)))
            OR (j.template_key = 'reservation_time_changed'
              AND r.status IN ('pending_approval', 'confirmed'))
            OR (j.template_key = 'reservation_rejected' AND r.status = 'rejected')
            OR (j.template_key = 'reservation_cancelled_by_admin'
              AND r.status = 'cancelled_by_admin')
          ))
        OR (? = 1 AND j.reservation_id IS NULL AND j.recipient_type = 'owner'
          AND j.template_key IN ('google_drift_alert', 'google_conflict_burst_alert', 'daily_ops_summary'))
      )
    LIMIT 1
  ) AS notification
`.trim();

export async function readOperationsHealth(
  db: D1Database,
  env: Partial<WorkerBindings>,
  nowMs = Date.now()
): Promise<{ calendar: boolean; import: boolean; notification: boolean }> {
  const nowSeconds = Math.floor(nowMs / 1000);
  const branchBEnabled = (
    env.GOOGLE_DRIFT_ALERT_LIVE === "true" ||
    env.GOOGLE_CONFLICT_BURST_ALERT_LIVE === "true" ||
    env.DAILY_OPS_SUMMARY_DISPATCH_ENABLED === "true"
  );
  const row = await db.prepare(HEALTH_SQL)
    .bind(nowSeconds, nowSeconds - STALE_SECONDS, isGoogleImportEnabled(env) ? 1 : 0, branchBEnabled ? 1 : 0)
    .first<HealthRow>();
  if (!row || ![row.calendar, row.google_import, row.notification].every((value) => value === 0 || value === 1)) {
    throw new Error("operations_health_invalid_result");
  }
  return { calendar: row.calendar === 1, import: row.google_import === 1, notification: row.notification === 1 };
}
