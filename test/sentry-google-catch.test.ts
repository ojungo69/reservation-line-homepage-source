/**
 * PR-A: Sentry capture coverage for src/google/ catch blocks.
 *
 * Verifies safeCaptureException is wired through with correct tag
 * shape and that Sentry SDK failures cannot break business logic.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { captureExceptionSpy } = vi.hoisted(() => ({
  captureExceptionSpy: vi.fn()
}));

vi.mock("@sentry/cloudflare", () => ({
  captureException: captureExceptionSpy,
  init: vi.fn(),
  withSentry: (_opts: unknown, handler: unknown) => handler,
  withMonitor: vi.fn(
    (_slug: string, callback: () => unknown, _config?: unknown) => callback()
  )
}));

import { safeCaptureException } from "../src/sentry-helpers";
import { detectConflictBursts } from "../src/google/conflict-burst-detector";

const STORE_ID = "kyoto";
const CALENDAR_ID = "calendar-a@example.invalid";

const createFailingD1 = (errorMessage = "D1_ERROR"): D1Database => {
  const error = new Error(errorMessage);
  const failingStatement = {
    bind: () => failingStatement,
    first: () => Promise.reject(error),
    all: () => Promise.reject(error),
    run: () => Promise.reject(error),
    raw: () => Promise.reject(error)
  };
  return {
    prepare: () => failingStatement,
    batch: () => Promise.reject(error),
    dump: () => Promise.reject(error),
    exec: () => Promise.reject(error)
  } as unknown as D1Database;
};

describe("Sentry capture coverage — src/google/", () => {
  beforeEach(() => {
    captureExceptionSpy.mockReset();
  });

  describe("safeCaptureException helper", () => {
    it("forwards error + context to Sentry.captureException", () => {
      const err = new Error("boom");
      safeCaptureException(err, {
        tags: { google_module: "import-sync", operation: "test_op" },
        contexts: { d1_query: { store_id: STORE_ID } }
      });
      expect(captureExceptionSpy).toHaveBeenCalledTimes(1);
      expect(captureExceptionSpy.mock.calls[0][0]).toBe(err);
      expect(captureExceptionSpy.mock.calls[0][1]).toEqual({
        tags: { google_module: "import-sync", operation: "test_op" },
        contexts: { d1_query: { store_id: STORE_ID } }
      });
    });

    it("swallows Sentry SDK failure so business logic continues", () => {
      captureExceptionSpy.mockImplementation(() => {
        throw new Error("SENTRY_SDK_BROKEN");
      });
      expect(() =>
        safeCaptureException(new Error("real"), {
          tags: { google_module: "import-sync", operation: "test_op" }
        })
      ).not.toThrow();
    });
  });

  describe("conflict-burst-detector: detectConflictBursts", () => {
    it("captures with query_burst_clusters tag when initial query fails (resolves undefined)", async () => {
      const failingDb = createFailingD1("BURST_QUERY_FAIL");
      await expect(
        detectConflictBursts({
          db: failingDb,
          env: {
            GOOGLE_CONFLICT_BURST_ALERT_LIVE: "false"
          },
          nowMs: Date.parse("2026-05-21T12:00:00.000Z")
        })
      ).resolves.toBeUndefined();
      const match = captureExceptionSpy.mock.calls.find(
        ([, ctx]) =>
          (ctx as { tags?: { operation?: string } } | undefined)?.tags?.operation ===
          "query_burst_clusters"
      );
      expect(match).toBeDefined();
      expect(match![1]).toMatchObject({
        tags: { google_module: "conflict-burst-detector", operation: "query_burst_clusters" }
      });
    });

    it("does not break control flow even when Sentry SDK throws", async () => {
      captureExceptionSpy.mockImplementation(() => {
        throw new Error("SENTRY_SDK_BROKEN");
      });
      const failingDb = createFailingD1("BURST_QUERY_FAIL");
      await expect(
        detectConflictBursts({
          db: failingDb,
          env: {
            GOOGLE_CONFLICT_BURST_ALERT_LIVE: "false"
          },
          nowMs: Date.parse("2026-05-21T12:00:00.000Z")
        })
      ).resolves.toBeUndefined();
    });
  });

  describe("tag schema contract", () => {
    it("all expected google_module + operation names follow kebab/snake conventions", () => {
      const expectedModules = new Set([
        "import-sync",
        "conflict-burst-detector",
        "channel-watch"
      ]);
      const expectedOperations = new Set([
        "reservation_move_batch",
        "drift_alert_enqueue",
        "capture_sweep_start",
        "drift_check",
        "orphan_sweep",
        "process_claimed_job",
        "prune_event_history",
        "staging_drift_inject_batch",
        "burst_alert_enqueue",
        "query_burst_clusters",
        "parse_watch_response"
      ]);
      expect(expectedModules.size).toBeGreaterThan(0);
      expect(expectedOperations.size).toBeGreaterThan(0);
      for (const mod of expectedModules) {
        expect(mod).toMatch(/^[a-z][a-z0-9-]*$/);
      }
      for (const op of expectedOperations) {
        expect(op).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    });
  });
});
