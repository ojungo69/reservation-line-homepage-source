// Drift threshold alert — post-full_reconcile owner email notification.
//
// After each daily full_reconcile completes the importer computes the drift
// (absolute difference between Google event count and D1 event count). When
// drift >= DRIFT_ALERT_THRESHOLD and the feature flag is enabled, this
// module enqueues one owner-email notification job.
//
// Mirrors the conflict-burst-detector.ts notification pattern:
//   - one email sentinel recipient
//   - INSERT OR IGNORE on notification_jobs with a date+store+cal+recipient
//     scoped dedupe_key
//   - notification_jobs.payload_json carries counts only — no PII
//
// Extracted from import-sync.ts to keep the module focused and testable.

import type { WorkerBindings } from "../bindings";
import { logGoogleEvent } from "../logging";
import { safeCaptureException } from "../sentry-helpers";
import { sha256Hex } from "../crypto-utils";
import { OWNER_EMAIL_RECIPIENT_ID } from "../notifications/operations-email";

export type DriftThresholdAlertEnv = Pick<
  WorkerBindings,
  "GOOGLE_DRIFT_ALERT_LIVE"
>;

export const DRIFT_ALERT_THRESHOLD = 10;

// 16-byte (32 hex char) digest — slice of the canonical 64-hex sha256Hex.
const sha256Hex16 = (value: string): Promise<string> =>
  sha256Hex(value).then((h) => h.slice(0, 32));

export type DriftAlertEnqueueResult = {
  insertedCount: number;
  existingCount: number;
  jobIds: string[];
};

/**
 * Enqueue one drift alert owner-email job.
 *
 * The notification is deduped by `google_drift_alert:v1:<utcDate>:store:<storeId>:cal:<sha256>:recipient:<sha256>`
 * so at most one email is sent per day per store/calendar pair.
 */
export const enqueueDriftAlertNotifications = async (input: {
  db: D1Database;
  env: DriftThresholdAlertEnv;
  storeId: string;
  calendarId: string;
  googleCount: number;
  d1Count: number;
  drift: number;
  nowMs: number;
}): Promise<DriftAlertEnqueueResult> => {
  const result: DriftAlertEnqueueResult = { insertedCount: 0, existingCount: 0, jobIds: [] };
  const utcDate = new Date(input.nowMs).toISOString().slice(0, 10);
  const calHash = await sha256Hex16(input.calendarId);
  const recHash = await sha256Hex16(OWNER_EMAIL_RECIPIENT_ID);
  const safeGoogleCount = Math.max(0, Math.floor(input.googleCount));
  const safeD1Count = Math.max(0, Math.floor(input.d1Count));
  const safeDrift = Math.max(0, Math.floor(input.drift));
  const payloadJson = JSON.stringify({
    store_id: input.storeId,
    google_count: safeGoogleCount,
    d1_count: safeD1Count,
    drift: safeDrift,
    threshold: DRIFT_ALERT_THRESHOLD
  });
  const dedupeKey = `google_drift_alert:v1:${utcDate}:store:${input.storeId}:cal:${calHash}:recipient:${recHash}`;
  const jobId = crypto.randomUUID();
  try {
    const insertResult = await input.db
      .prepare(
        `INSERT OR IGNORE INTO notification_jobs (
           id, dedupe_key, template_key, recipient_type, recipient_id,
           reservation_id, status, payload_json
         ) VALUES (?, ?, 'google_drift_alert', 'owner', ?, NULL, 'queued', ?)`
      )
      .bind(jobId, dedupeKey, OWNER_EMAIL_RECIPIENT_ID, payloadJson)
      .run();
    if (Number(insertResult.meta?.changes ?? 0) > 0) {
      result.insertedCount = 1;
      result.jobIds.push(jobId);
    } else {
      result.existingCount = 1;
    }
  } catch (error) {
    safeCaptureException(error, {
      tags: { google_module: "drift-threshold-alert", operation: "drift_alert_enqueue" },
      contexts: { d1_query: { calendar_id: input.calendarId, store_id: input.storeId } }
    });
    logGoogleEvent({
      event_type: "google_drift_alert_enqueue_failed",
      outcome: "failure",
      calendar_id: input.calendarId,
      store_id: input.storeId,
      error_class: "unexpected"
    });
  }
  return result;
};

/**
 * Evaluate drift counts against the threshold and conditionally enqueue
 * an owner email notification.
 *
 * This is the top-level entry point called by runImportJob after a
 * full_reconcile completes.
 *
 * @returns Whether an alert was dispatched (true) or suppressed (false).
 */
export const evaluateDriftThreshold = async (input: {
  db: D1Database;
  env: DriftThresholdAlertEnv;
  storeId: string;
  calendarId: string;
  googleCount: number;
  d1Count: number;
  drift: number;
  nowMs: number;
}): Promise<{ alerted: boolean; enqueueResult: DriftAlertEnqueueResult | null }> => {
  if (input.drift < DRIFT_ALERT_THRESHOLD) {
    return { alerted: false, enqueueResult: null };
  }

  // Always log the drift alert event (for offline analysis) regardless of
  // the feature flag.
  logGoogleEvent({
    event_type: "google_drift_alert",
    outcome: "noop",
    calendar_id: input.calendarId,
    store_id: input.storeId,
    google_tracked_count: input.googleCount,
    d1_tracked_count: input.d1Count,
    drift: input.drift
  });

  // Gate live owner-email enqueue on the feature flag. Default false everywhere;
  // staging flips first, prod after user confirmation.
  if (input.env.GOOGLE_DRIFT_ALERT_LIVE !== "true") {
    return { alerted: false, enqueueResult: null };
  }

  const enqueueResult = await enqueueDriftAlertNotifications({
    db: input.db,
    env: input.env,
    storeId: input.storeId,
    calendarId: input.calendarId,
    googleCount: input.googleCount,
    d1Count: input.d1Count,
    drift: input.drift,
    nowMs: input.nowMs
  });

  return { alerted: true, enqueueResult };
};

// Internal helpers exposed for unit tests.
export const __testing__ = {
  DRIFT_ALERT_THRESHOLD,
  sha256Hex16,
  enqueueDriftAlertNotifications
};
