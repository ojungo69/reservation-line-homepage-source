import type { WorkerBindings } from "../bindings";
import { logGoogleEvent } from "../logging";
import { safeCaptureException } from "../sentry-helpers";
import { sha256Hex } from "../crypto-utils";
import { OWNER_EMAIL_RECIPIENT_ID } from "../notifications/operations-email";
import { mapConcurrent } from "../concurrency";

// Conflict burst alert — Tier D.3.
// A burst of conflicts in a short rolling window often signals a systemic
// issue (mass cancellation upstream, Google API outage, sync bug). Without
// this detector the owner only finds out from the next morning's sync
// dashboard scan. With it the owner email arrives within minutes.
//
// Mirrors the Step 3 google_drift_alert path:
//   - one owner-email sentinel recipient
//   - INSERT OR IGNORE on notification_jobs with a dedupe_key shaped
//     `google_conflict_burst_alert:v1:<window-bucket>:store:<storeId>:cal:<sha256-16B>:recipient:<sha256-16B>`
//   - notification_jobs.payload_json carries {store_id, calendar_id,
//     window_minutes, conflict_count, threshold} only — no PII.

export type ConflictBurstDetectorEnv = Pick<
  WorkerBindings,
  "GOOGLE_CONFLICT_BURST_ALERT_LIVE"
>;

const CONFLICT_BURST_WINDOW_SECONDS = 5 * 60;
const CONFLICT_BURST_THRESHOLD = 10;

// 16-byte (32 hex char) digest — slice of the canonical 64-hex sha256Hex.
const sha256Hex16 = (value: string): Promise<string> =>
  sha256Hex(value).then((h) => h.slice(0, 32));

type ConflictBurstRow = {
  store_id: string;
  calendar_id: string;
  conflict_count: number;
};

const queryBurstClusters = async (
  db: D1Database,
  windowStartSeconds: number
): Promise<ConflictBurstRow[]> => {
  // datetime() on both sides normalizes against the codebase's two
  // last_seen_at-style formats (CURRENT_TIMESTAMP + ISO toISOString). Even
  // though google_calendar_conflicts.created_at is CURRENT_TIMESTAMP by
  // default today, the normalization keeps the query honest if a future
  // writer switches to ISO.
  const result = await db
    .prepare(
      `
        SELECT store_id, calendar_id, COUNT(*) AS conflict_count
        FROM google_calendar_conflicts
        WHERE resolution_status = 'open'
          AND datetime(created_at) >= datetime(?, 'unixepoch')
        GROUP BY store_id, calendar_id
        HAVING COUNT(*) >= ?
      `
    )
    .bind(windowStartSeconds, CONFLICT_BURST_THRESHOLD)
    .all<ConflictBurstRow>();
  return result.results ?? [];
};

const enqueueConflictBurstNotifications = async (input: {
  db: D1Database;
  env: ConflictBurstDetectorEnv;
  storeId: string;
  calendarId: string;
  conflictCount: number;
  nowMs: number;
}): Promise<void> => {
  // Window bucket = floor(nowMs / WINDOW_MS). A burst lasting longer than
  // one window will dedupe per-bucket, so the owner gets at most one email
  // per 5-minute window — not a flood for a
  // single ongoing incident.
  const windowBucket = Math.floor(input.nowMs / (CONFLICT_BURST_WINDOW_SECONDS * 1000));
  const calHash = await sha256Hex16(input.calendarId);
  const recHash = await sha256Hex16(OWNER_EMAIL_RECIPIENT_ID);
  const safeConflictCount = Math.max(0, Math.floor(input.conflictCount));
  const payloadJson = JSON.stringify({
    store_id: input.storeId,
    calendar_id: input.calendarId,
    window_minutes: CONFLICT_BURST_WINDOW_SECONDS / 60,
    conflict_count: safeConflictCount,
    threshold: CONFLICT_BURST_THRESHOLD
  });

  const dedupeKey = `google_conflict_burst_alert:v1:${windowBucket}:store:${input.storeId}:cal:${calHash}:recipient:${recHash}`;
  try {
    await input.db
      .prepare(
        `INSERT OR IGNORE INTO notification_jobs (
           id, dedupe_key, template_key, recipient_type, recipient_id,
           reservation_id, status, payload_json
         ) VALUES (?, ?, 'google_conflict_burst_alert', 'owner', ?, NULL, 'queued', ?)`
      )
      .bind(crypto.randomUUID(), dedupeKey, OWNER_EMAIL_RECIPIENT_ID, payloadJson)
      .run();
  } catch (error) {
    safeCaptureException(error, {
      tags: { google_module: "conflict-burst-detector", operation: "burst_alert_enqueue" },
      contexts: { d1_query: { calendar_id: input.calendarId, store_id: input.storeId } }
    });
    logGoogleEvent({
      event_type: "google_conflict_burst_alert_enqueue_failed",
      outcome: "failure",
      calendar_id: input.calendarId,
      store_id: input.storeId,
      error_class: "unexpected"
    });
  }
};

export const detectConflictBursts = async (input: {
  db: D1Database;
  env: ConflictBurstDetectorEnv;
  nowMs: number;
}): Promise<void> => {
  // Always run the detection query (so log analysis can graph burst
  // frequency offline), but gate the live LINE enqueue on the feature
  // flag. Mirrors the GOOGLE_DRIFT_ALERT_LIVE pattern from Step 3.
  const windowStartSeconds = Math.floor(input.nowMs / 1000) - CONFLICT_BURST_WINDOW_SECONDS;
  let clusters: ConflictBurstRow[];
  try {
    clusters = await queryBurstClusters(input.db, windowStartSeconds);
  } catch (error) {
    safeCaptureException(error, {
      tags: { google_module: "conflict-burst-detector", operation: "query_burst_clusters" },
      contexts: { d1_query: { window_start_seconds: windowStartSeconds } }
    });
    logGoogleEvent({
      event_type: "google_conflict_burst_check_failed",
      outcome: "failure",
      error_class: "unexpected"
    });
    return;
  }

  await mapConcurrent(clusters, async (cluster) => {
    logGoogleEvent({
      event_type: "google_conflict_burst_alert",
      outcome: "noop",
      calendar_id: cluster.calendar_id,
      store_id: cluster.store_id,
      conflict_count: cluster.conflict_count,
      threshold: CONFLICT_BURST_THRESHOLD,
      window_minutes: CONFLICT_BURST_WINDOW_SECONDS / 60
    });

    if (input.env.GOOGLE_CONFLICT_BURST_ALERT_LIVE === "true") {
      await enqueueConflictBurstNotifications({
        db: input.db,
        env: input.env,
        storeId: cluster.store_id,
        calendarId: cluster.calendar_id,
        conflictCount: cluster.conflict_count,
        nowMs: input.nowMs
      });
    }
  });
};

export const __testing__ = {
  CONFLICT_BURST_WINDOW_SECONDS,
  CONFLICT_BURST_THRESHOLD,
  sha256Hex16,
  queryBurstClusters,
  enqueueConflictBurstNotifications
};
