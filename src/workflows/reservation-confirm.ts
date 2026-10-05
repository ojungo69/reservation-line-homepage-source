import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";

import { processDueCalendarSyncJobs } from "../google/calendar-sync";
import { processDueLineNotificationJobs } from "../line/notifications";
import { LINE_MONTHLY_QUOTA_EXHAUSTED } from "../line/quota";
import { isD1DrFreezeMaintenanceMode } from "../runtime-config";

import type { WorkerBindings } from "../bindings";

export type ReservationConfirmWorkflowParams = {
  reservationId: string;
  version: number;
};

const TERMINAL_STATUSES = new Set(["sent", "succeeded", "superseded", "superseded_by_external_block_cancellation"]);

// Sentry telemetry ownership: the job processors (processDueCalendarSyncJobs /
// processDueLineNotificationJobs) capture their OWN dead-transition failures —
// for BOTH cron and workflow callers — via safeCaptureException (transient-D1
// export-lock suppression included). This workflow therefore captures nothing:
// the SDK step instrumentation's auto-capture (mechanism
// auto.faas.cloudflare.workflow) is dropped centrally in beforeSend
// (dropSdkWorkflowEvent) precisely because it would be a tagless duplicate of
// the processor capture. The narrow gap left uncaptured is processor-EXTERNAL
// step failures (a findJobId/assertJobTerminal D1 read, a non-dead terminal
// mismatch, a raw step timeout) — rare, and D1-read failures are export-lock
// transients we suppress anyway. Tracked in issue #467.
const findJobIdByDedupeKey = async (
  db: D1Database,
  table: "calendar_sync_jobs" | "notification_jobs",
  dedupeKey: string
): Promise<string | null> => {
  // `table` is a closed union of two literals (never user input), so interpolating
  // it is injection-safe and mirrors the existing FROM ${table} pattern in
  // retention-sweep.ts / admin/operations.ts.
  const sql = `SELECT id FROM ${table} WHERE dedupe_key = ? AND status IN ('queued', 'retryable') LIMIT 1`;
  const row = await db.prepare(sql).bind(dedupeKey).first<{ id: string }>();
  return row?.id ?? null;
};

const assertJobTerminal = async (
  db: D1Database,
  table: "calendar_sync_jobs" | "notification_jobs",
  dedupeKey: string,
  label: string
): Promise<void> => {
  // Closed union literal (see findJobIdByDedupeKey) — interpolation is safe.
  const sql = `SELECT status, last_error FROM ${table} WHERE dedupe_key = ? LIMIT 1`;
  const row = await db.prepare(sql).bind(dedupeKey).first<{ status: string; last_error: string | null }>();
  if (!row) return;
  if (row.status === "dead") {
    // The no-resend policy is fulfilled. Keep the failed delivery evidence in
    // D1 without leaving a second, unacknowledgeable Workflow error behind.
    if (table === "notification_jobs" && row.last_error === LINE_MONTHLY_QUOTA_EXHAUSTED) return;
    throw new NonRetryableError(`${label} job reached dead state`);
  }
  if (TERMINAL_STATUSES.has(row.status)) return;
  throw new Error(`${label} job still in ${row.status} state`);
};

export class ReservationConfirmWorkflow extends WorkflowEntrypoint<WorkerBindings, ReservationConfirmWorkflowParams> {
  async run(
    event: WorkflowEvent<ReservationConfirmWorkflowParams>,
    step: WorkflowStep
  ) {
    const { reservationId, version } = event.payload;
    if (isD1DrFreezeMaintenanceMode(this.env)) {
      console.warn(JSON.stringify({
        event_type: "d1_dr_freeze_workflow_noop",
        outcome: "noop",
        environment: typeof this.env.ENVIRONMENT === "string" ? this.env.ENVIRONMENT : "unknown",
        reservation_id: reservationId,
        version
      }));
      return;
    }

    const calendarDedupeKey = `reservation:${reservationId}:google:upsert:revision:${version}`;
    const notificationDedupeKey = `reservation:${reservationId}:template:reservation_confirmed:revision:${version}`;

    let calendarFailed = false;
    try {
      await step.do(
        "calendar-sync",
        {
          retries: { limit: 5, delay: "10 second", backoff: "exponential" },
          timeout: "5 minutes"
        },
        async () => {
          const jobId = await findJobIdByDedupeKey(
            this.env.DB,
            "calendar_sync_jobs",
            calendarDedupeKey
          );
          if (jobId) {
            const result = await processDueCalendarSyncJobs({
              db: this.env.DB,
              env: this.env,
              maxJobs: 1,
              jobIdsFilter: [jobId]
            });
            if (result.failed > 0) {
              throw new Error(`calendar sync job failed for ${reservationId}`);
            }
          }
          await assertJobTerminal(this.env.DB, "calendar_sync_jobs", calendarDedupeKey, "calendar-sync");
        }
      );
    } catch {
      // Capture is owned by processDueCalendarSyncJobs (see the ownership note
      // above); this catch only records that the step failed so the LINE step
      // still runs, then rethrows below.
      calendarFailed = true;
    }

    await step.do(
      "line-notification",
      {
        retries: { limit: 5, delay: "5 minute", backoff: "exponential" },
        timeout: "30 minutes"
      },
      async () => {
        const jobId = await findJobIdByDedupeKey(
          this.env.DB,
          "notification_jobs",
          notificationDedupeKey
        );
        if (jobId) {
          await processDueLineNotificationJobs({
            db: this.env.DB,
            env: this.env,
            maxJobs: 1,
            jobIdsFilter: [jobId]
          });
        }
        await assertJobTerminal(this.env.DB, "notification_jobs", notificationDedupeKey, "line-notification");
      }
    );

    if (calendarFailed) {
      throw new Error(
        `calendar-sync step exhausted retries for reservation ${reservationId}`
      );
    }
  }
}
