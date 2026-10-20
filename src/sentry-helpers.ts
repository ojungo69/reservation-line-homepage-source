/**
 * Sentry capture helper — wraps Sentry.captureException so SDK failure
 * never interrupts the original control flow.
 *
 * All B1-B8 callsites use this instead of calling Sentry.captureException
 * directly. If the SDK throws (misconfigured DSN, init failure, etc.) the
 * error is silently swallowed and business logic continues unchanged.
 */
import * as Sentry from "@sentry/cloudflare";
import { isRetryableD1Error, isTransientD1Error, readErrorMessage } from "./outbound-timeout";

export function safeCaptureException(
  error: unknown,
  context: {
    tags?: Record<string, string>;
    contexts?: Record<string, Record<string, unknown>>;
    // Opt OUT of the transient-D1-export suppression (and the retryable-D1 warning
    // downgrade) below. Set by the request
    // boundary (app.onError) where an export-lock surfaces as a RAW 500 to a
    // customer: suppressing it there would hide a user-facing failure twice over
    // (broken response AND no telemetry). Background/handled callsites omit it —
    // they retry unattended (cron/queue) or return a structured error the user
    // sees (admin write_failed), so the export-lock is expected noise to drop.
    captureTransientD1?: boolean;
  }
): void {
  const { captureTransientD1, ...sentryContext } = context;
  // A long-running D1 export (the backup-verify workflow's weekly `wrangler d1
  // export`) makes EVERY D1 write reject for the export's duration. That is an
  // expected, transient infra condition — not an actionable fault. Suppress it at
  // this single capture choke point so the many per-job catch sites across the app
  // (cron subtasks, queue processors, reminder / LINE-notification dispatchers)
  // don't each open Sentry noise during the weekly export window. Genuine errors
  // still capture, and callers that opt in via captureTransientD1 (request paths)
  // keep export-lock visibility. Sentry RESERVATION-LINE-HOMEPAGE-D.
  if (!captureTransientD1 && isTransientD1Error(error)) {
    // Keep the caller's tags + the message so a suppressed event stays
    // attributable to its originating callsite (this choke point funnels every
    // B1-B8 site, so a bare log would hide WHICH subsystem was export-locked).
    console.warn("sentry_capture_skipped_d1_export_lock", {
      event: "d1_export_locked",
      tags: context.tags,
      message: error instanceof Error ? error.message : String(error)
    });
    return;
  }
  // The other Cloudflare-retryable D1 infra errors ("Network connection lost", storage
  // reset, ...) get the cron fan-out's transient_d1 treatment: the work re-runs on its
  // own, so keep it visible as ONE warning per callsite (grouped by the caller's tags)
  // instead of an error issue per stack trace. D1_ERROR proves D1 origin — a Google /
  // LINE fetch can throw the same text and must stay an error.
  // Sentry RESERVATION-LINE-HOMEPAGE-12/13/16/17/K/Q.
  const retryableD1 =
    !captureTransientD1 && readErrorMessage(error).includes("D1_ERROR") && isRetryableD1Error(error);
  try {
    if (retryableD1) {
      // Capture a wrapper, not `error`: the SDK marks a captured object and drops every
      // later capture of it, so capturing `error` here would leave a request boundary
      // that catches the same rethrown error (app.onError, error level) with only this
      // warning. The original stays attached as `cause`, stack included.
      Sentry.captureException(new Error(readErrorMessage(error), { cause: error }), {
        ...sentryContext,
        level: "warning",
        fingerprint: [
          "d1-retryable",
          ...Object.entries(sentryContext.tags ?? {}).map(([key, value]) => `${key}=${value}`)
        ]
      });
    } else {
      Sentry.captureException(error, sentryContext);
    }
  } catch {
    // Sentry SDK failure must never break the original control flow.
  }
}

/**
 * Capture a swallowed batch/idempotency write failure.
 *
 * Admin/background write paths catch db.batch() failures and return a
 * structured `write_failed` (or classified) result the operator sees. Without
 * this the failure has no telemetry. Normalizes non-Error throwables and hands
 * off to safeCaptureException. captureTransientD1 is intentionally NOT set: the
 * caller surfaces a structured error, so the weekly D1-export lock is expected
 * noise the central choke point (safeCaptureException) drops while genuine
 * failures still capture. `tags` names the callsite (component/op/helper).
 */
export function captureBatchWriteFailure(error: unknown, tags: Record<string, string>): void {
  safeCaptureException(error instanceof Error ? error : new Error(String(error)), { tags });
}

type WorkflowMechanismEvent = {
  exception?: { values?: Array<{ mechanism?: { type?: string } }> };
};

/**
 * beforeSend guard: drop every SDK-auto-captured workflow step event
 * (mechanism "auto.faas.cloudflare.workflow"). Capture ownership for workflow
 * step failures lives in the JOB PROCESSORS — processDueCalendarSyncJobs /
 * processDueLineNotificationJobs capture their own dead-transition and
 * stale-sweep failures for cron and workflow callers alike, with dispatcher
 * tags and safeCaptureException's transient-D1 suppression. The workflow's
 * catch blocks are control-flow only and capture NOTHING (a manual capture
 * there would be disarmed anyway: the SDK step instrumentation captures the
 * final-attempt exception first and marks it __sentry_captured__). The SDK
 * event is thus always a tagless duplicate of the processor capture (the SDK
 * disables dedupe for workflows). Manual captures elsewhere get mechanism
 * "generic" and pass through untouched. Any future WorkflowEntrypoint must
 * likewise delegate capture to the job processor it invokes, not its own
 * catch blocks.
 */
export function dropSdkWorkflowEvent<T extends WorkflowMechanismEvent>(event: T): T | null {
  // Check EVERY exception entry, not just [0]: linkedErrorsIntegration prepends
  // Error.cause chain entries (mechanism "chained"), pushing the SDK's
  // workflow-mechanism entry to a later index.
  const hasSdkWorkflowMechanism = event.exception?.values?.some(
    (value) => value.mechanism?.type === "auto.faas.cloudflare.workflow"
  );
  return hasSdkWorkflowMechanism ? null : event;
}
