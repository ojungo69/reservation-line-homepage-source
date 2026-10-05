/**
 * Reservation reminder auto-dispatch.
 *
 * Scans confirmed reservations whose start_at falls within the per-store
 * reminder window (reservation_reminder_offset_minutes) and enqueues
 * `reservation_reminder` notification_jobs. Each row is dedupe'd by
 * reservation id + template + version so:
 *
 *   1. Repeated cron ticks are idempotent (INSERT OR IGNORE on dedupe_key).
 *   2. A reservation edit (version bump) re-triggers a fresh reminder.
 *
 * The dispatcher is gated by RESERVATION_REMINDER_DISPATCH_ENABLED and by the
 * per-store offset being non-null / > 0.
 */

import { safeCaptureException } from "../sentry-helpers";
import { mapConcurrent } from "../concurrency";

export type ReminderDispatchResult = {
  scanned: number;
  enqueued: number;
};

export type ReminderDispatchOptions = {
  /**
   * Upper bound on rows scanned + inserted per invocation. Keeps the cron
   * tick under D1/Worker time budget at 25K-reservation scale; remaining
   * candidates are picked up by subsequent ticks (every 10 min).
   */
  maxCandidates?: number;
};

const DEFAULT_MAX_CANDIDATES = 500;

type ReminderCandidateRow = {
  reservation_id: string;
  line_identity_id: string | null;
  store_id: string;
  version: number;
};

/**
 * Find confirmed reservations within each store's reminder window.
 *
 * A reservation is eligible when:
 *   - status = 'confirmed'
 *   - The store has a non-null, positive reservation_reminder_offset_minutes
 *   - start_at is in the future (> nowIso)
 *   - The reminder trigger time has already passed:
 *       datetime(r.start_at, '-' || ss.reservation_reminder_offset_minutes || ' minutes') <= datetime(?)
 *   - The reservation has a line_identity_id (required to send LINE push)
 *   - No notification_jobs row already exists for this reservation+template+version
 *     (NOT EXISTS pre-filter avoids re-touching rows already enqueued by
 *     prior cron ticks; INSERT OR IGNORE is the second line of defense).
 *
 * SQLite datetime arithmetic handles the per-store offset comparison
 * without pulling all rows to JS. ORDER BY r.start_at ASC + LIMIT ?
 * keeps each tick bounded; remaining work drains across subsequent
 * 10-minute cron ticks.
 */
// No JOIN stores: r.store_id is NOT NULL + FK to stores(id) (0001_initial), so
// that join was a pass-through. Re-add if the FK declaration is ever dropped.
const FIND_ELIGIBLE_SQL = `
  SELECT
    r.id AS reservation_id,
    r.line_identity_id AS line_identity_id,
    r.store_id AS store_id,
    r.version AS version
  FROM reservations r
  JOIN store_settings ss ON ss.store_id = r.store_id
  WHERE r.status = 'confirmed'
    AND r.line_identity_id IS NOT NULL
    AND ss.reservation_reminder_offset_minutes IS NOT NULL
    AND ss.reservation_reminder_offset_minutes > 0
    AND r.start_at > ?
    AND datetime(r.start_at, '-' || ss.reservation_reminder_offset_minutes || ' minutes') <= datetime(?)
    AND NOT EXISTS (
      SELECT 1 FROM notification_jobs nj
      WHERE nj.dedupe_key = 'reservation:' || r.id || ':template:reservation_reminder:revision:' || r.version
    )
  ORDER BY r.start_at ASC
  LIMIT ?
`;

/**
 * INSERT OR IGNORE ensures idempotency: if the same dedupe_key already exists
 * (from a prior cron tick or a test double-invoke), the row is silently
 * skipped. The `:revision:` segment in the dedupe_key means that if the
 * reservation is edited (version bumps), a new reminder will be enqueued.
 */
const ENQUEUE_SQL = `
  INSERT OR IGNORE INTO notification_jobs (
    id,
    dedupe_key,
    template_key,
    recipient_type,
    recipient_id,
    reservation_id,
    status
  ) VALUES (?, ?, 'reservation_reminder', 'customer', ?, ?, 'queued')
`;

const buildDedupeKey = (reservationId: string, version: number): string =>
  `reservation:${reservationId}:template:reservation_reminder:revision:${version}`;

export async function dispatchReservationReminders(
  db: D1Database,
  nowMs: number,
  options: ReminderDispatchOptions = {}
): Promise<ReminderDispatchResult> {
  const nowIso = new Date(nowMs).toISOString();
  const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;

  const { results: candidates } = await db
    .prepare(FIND_ELIGIBLE_SQL)
    .bind(nowIso, nowIso, maxCandidates)
    .all<ReminderCandidateRow>();

  const result: ReminderDispatchResult = {
    scanned: candidates.length,
    enqueued: 0
  };

  await mapConcurrent(candidates, async (row) => {
    // line_identity_id is guaranteed non-null by the SQL WHERE clause, but
    // the D1 type system returns string | null. Guard defensively.
    if (!row.line_identity_id) return;

    const dedupeKey = buildDedupeKey(row.reservation_id, row.version);
    try {
      const insertResult = await db
        .prepare(ENQUEUE_SQL)
        .bind(
          crypto.randomUUID(),
          dedupeKey,
          row.line_identity_id,
          row.reservation_id
        )
        .run();
      // D1 meta.changes is 1 when the row was inserted, 0 when OR IGNORE
      // triggered (dedupe_key already exists).
      if (Number(insertResult.meta?.changes ?? 0) > 0) {
        result.enqueued += 1;
      }
    } catch (error) {
      // Log and continue — a single row failure should not abort the batch.
      console.error("reservation_reminder_enqueue_failed", {
        reservation_id: row.reservation_id,
        store_id: row.store_id,
        error: error instanceof Error ? error.message : String(error)
      });
      // B1: per-row enqueue failure — no PII in contexts (line_identity_id excluded)
      safeCaptureException(error, {
        tags: { dispatcher: "reminder" },
        contexts: {
          reservation: {
            id: row.reservation_id,
            store_id: row.store_id
          }
        }
      });
    }
  });

  if (result.enqueued > 0) {
    console.log("reservation_reminder_dispatch", {
      scanned: result.scanned,
      enqueued: result.enqueued
    });
  }

  return result;
}
