/**
 * safeCaptureException is the single capture choke point used by every B1-B8
 * callsite. It must SKIP the transient D1 long-running-export error (suppressed
 * app-wide so the many per-job catch sites don't each open Sentry noise during
 * the weekly backup-verify export) while still capturing genuine errors, honoring
 * the captureTransientD1 opt-in for request boundaries, and never throwing.
 * Sentry RESERVATION-LINE-HOMEPAGE-D. The other Cloudflare-retryable D1 errors are
 * kept but sent as a warning grouped by the callsite tags (RESERVATION-LINE-HOMEPAGE-K).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/cloudflare", () => ({
  captureException: vi.fn()
}));

import * as Sentry from "@sentry/cloudflare";
import { dropSdkWorkflowEvent, safeCaptureException } from "../src/sentry-helpers";

describe("safeCaptureException", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("skips the transient D1 long-running-export error (no capture)", () => {
    safeCaptureException(new Error("D1_ERROR: Currently processing a long-running export."), {
      tags: { component: "line-notifications" }
    });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("skips the raw 'during handling' variant too", () => {
    safeCaptureException(new Error("Currently processing a long-running export."), {});
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("captures the export-lock error when the caller opts in (request boundary)", () => {
    const err = new Error("D1_ERROR: Currently processing a long-running export.");
    safeCaptureException(err, { tags: { method: "POST" }, captureTransientD1: true });
    // Opt-in keeps export-lock visible, and the flag itself is stripped from the
    // context handed to the Sentry SDK (it is not a CaptureContext field).
    expect(Sentry.captureException).toHaveBeenCalledWith(err, { tags: { method: "POST" } });
  });

  it("captures genuine errors with their context", () => {
    const err = new Error("real subtask failure");
    const context = { tags: { component: "x" } };
    safeCaptureException(err, context);
    expect(Sentry.captureException).toHaveBeenCalledWith(err, context);
  });

  it("captures a background D1 'Network connection lost' as a warning grouped by the callsite tags", () => {
    // The callsite re-runs the work on the next tick, so a recovered infra blip is
    // one warning issue per callsite instead of an error issue per stack trace.
    // Sentry RESERVATION-LINE-HOMEPAGE-12/13/16/17/K/Q.
    const err = new Error("D1_ERROR: Network connection lost.");
    const contexts = { d1_query: { job_id: "job-1" } };
    safeCaptureException(err, {
      tags: { google_module: "import-sync", operation: "process_claimed_job" },
      contexts
    });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "D1_ERROR: Network connection lost.", cause: err }),
      {
        tags: { google_module: "import-sync", operation: "process_claimed_job" },
        contexts,
        level: "warning",
        fingerprint: ["d1-retryable", "google_module=import-sync", "operation=process_claimed_job"]
      }
    );
    // Identity, not equality: toEqual treats two Errors with the same message as equal.
    expect(vi.mocked(Sentry.captureException).mock.calls[0][0]).not.toBe(err);
  });

  it("downgrades the other Cloudflare-retryable D1 errors the same way", () => {
    for (const message of [
      "D1_ERROR: internal error; reference = x",
      "D1_ERROR: Internal error in D1 DB storage caused object to be reset.",
      "D1_ERROR: D1 DB reset because its code was updated."
    ]) {
      const err = new Error(message);
      safeCaptureException(err, { tags: { component: "line-quota", op: "snapshot_write" } });
      expect(Sentry.captureException).toHaveBeenLastCalledWith(
        expect.objectContaining({ message, cause: err }),
        {
          tags: { component: "line-quota", op: "snapshot_write" },
          level: "warning",
          fingerprint: ["d1-retryable", "component=line-quota", "op=snapshot_write"]
        }
      );
    }
  });

  it("groups an untagged retryable D1 error under the bare fingerprint", () => {
    const err = new Error("D1_ERROR: Network connection lost.");
    safeCaptureException(err, {});
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "D1_ERROR: Network connection lost.", cause: err }),
      { level: "warning", fingerprint: ["d1-retryable"] }
    );
  });

  it("leaves a rethrown retryable D1 error capturable at error level by the request boundary", () => {
    // Model of the SDK client's dedupe (checkOrSetAlreadyCaught in @sentry/core's
    // client.ts): a captured object is marked and every later capture of it is dropped.
    const seen = new WeakSet<object>();
    const landed: unknown[][] = [];
    const sdkDedupe = (exception: unknown, hint?: unknown) => {
      if (typeof exception === "object" && exception !== null) {
        if (seen.has(exception)) return "";
        seen.add(exception);
      }
      landed.push([exception, hint]);
      return "";
    };
    vi.mocked(Sentry.captureException).mockImplementationOnce(sdkDedupe).mockImplementationOnce(sdkDedupe);
    const err = new Error("D1_ERROR: Network connection lost.");
    safeCaptureException(err, { tags: { component: "admin-push" } }); // inner catch, then rethrow
    safeCaptureException(err, { tags: { method: "POST" }, captureTransientD1: true }); // app.onError
    expect(landed).toContainEqual([err, { tags: { method: "POST" } }]);
  });

  it("keeps a retryable D1 error at error level when the caller opts in (request boundary)", () => {
    const err = new Error("D1_ERROR: Network connection lost.");
    safeCaptureException(err, { tags: { method: "POST" }, captureTransientD1: true });
    expect(Sentry.captureException).toHaveBeenCalledWith(err, { tags: { method: "POST" } });
  });

  it("keeps a 'Network connection lost' that did not come from D1 at error level", () => {
    // A Google / LINE fetch can throw the same text; only D1_ERROR proves D1 origin.
    const err = new TypeError("Network connection lost.");
    safeCaptureException(err, { tags: { component: "google-fetch" } });
    expect(Sentry.captureException).toHaveBeenCalledWith(err, { tags: { component: "google-fetch" } });
  });

  it("keeps a non-retryable D1 error at error level", () => {
    const err = new Error("D1_ERROR: no such table: reservations: SQLITE_ERROR");
    safeCaptureException(err, { tags: { component: "x" } });
    expect(Sentry.captureException).toHaveBeenCalledWith(err, { tags: { component: "x" } });
  });

  it("never throws even if the Sentry SDK throws", () => {
    (Sentry.captureException as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("sdk boom");
    });
    expect(() => safeCaptureException(new Error("genuine"), {})).not.toThrow();
  });
});

describe("dropSdkWorkflowEvent", () => {
  it("drops every SDK-captured workflow-mechanism event (manual catch owns capture)", () => {
    const workflowEvent = {
      exception: { values: [{ mechanism: { type: "auto.faas.cloudflare.workflow" } }] }
    };
    expect(dropSdkWorkflowEvent(workflowEvent)).toBeNull();
  });

  it("drops a workflow event whose mechanism entry was pushed back by a linked-error chain", () => {
    // linkedErrorsIntegration prepends Error.cause entries (mechanism "chained"),
    // so the SDK's workflow mechanism may not be at index 0.
    const chainedEvent = {
      exception: {
        values: [
          { mechanism: { type: "chained" } },
          { mechanism: { type: "auto.faas.cloudflare.workflow" } }
        ]
      }
    };
    expect(dropSdkWorkflowEvent(chainedEvent)).toBeNull();
  });

  it("keeps non-workflow events, including manual captures", () => {
    const manualEvent = { exception: { values: [{ mechanism: { type: "generic" } }] } };
    expect(dropSdkWorkflowEvent(manualEvent)).toBe(manualEvent);
    const manualChainedEvent = {
      exception: {
        values: [{ mechanism: { type: "chained" } }, { mechanism: { type: "generic" } }]
      }
    };
    expect(dropSdkWorkflowEvent(manualChainedEvent)).toBe(manualChainedEvent);
    const bareEvent = {};
    expect(dropSdkWorkflowEvent(bareEvent)).toBe(bareEvent);
  });
});
