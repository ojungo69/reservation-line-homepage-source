/**
 * safeCaptureException is the single capture choke point used by every B1-B8
 * callsite. It must SKIP the transient D1 long-running-export error (suppressed
 * app-wide so the many per-job catch sites don't each open Sentry noise during
 * the weekly backup-verify export) while still capturing genuine errors, honoring
 * the captureTransientD1 opt-in for request boundaries, and never throwing.
 * Sentry RESERVATION-LINE-HOMEPAGE-D.
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
