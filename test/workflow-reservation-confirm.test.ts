import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/sentry-helpers", () => ({
  captureBatchWriteFailure: vi.fn(),
  safeCaptureException: vi.fn()
}));
vi.mock("../src/line/notifications", () => ({
  processDueLineNotificationJobs: vi.fn()
}));

import { NonRetryableError } from "cloudflare:workflows";

import { processDueLineNotificationJobs } from "../src/line/notifications";
import { isWorkflowEnabled } from "../src/runtime-config";
import { captureBatchWriteFailure } from "../src/sentry-helpers";
import { createMigratedSqliteD1 } from "./helpers/sqlite-d1";
import { LINE_MONTHLY_QUOTA_EXHAUSTED } from "../src/line/quota";

describe("isWorkflowEnabled", () => {
  it("returns false when WORKFLOW_ENABLED is undefined", () => {
    expect(isWorkflowEnabled({})).toBe(false);
  });

  it("returns false when WORKFLOW_ENABLED is 'false'", () => {
    expect(isWorkflowEnabled({ WORKFLOW_ENABLED: "false" })).toBe(false);
  });

  it("returns false when WORKFLOW_ENABLED is empty string", () => {
    expect(isWorkflowEnabled({ WORKFLOW_ENABLED: "" })).toBe(false);
  });

  it("returns true when WORKFLOW_ENABLED is 'true'", () => {
    expect(isWorkflowEnabled({ WORKFLOW_ENABLED: "true" })).toBe(true);
  });
});

describe("triggerReservationWorkflow", () => {
  const makeContext = (opts: {
    workflow?: { create: ReturnType<typeof vi.fn> };
    queueKickCalled?: { value: boolean };
  }) => {
    const queueKickCalled = opts.queueKickCalled ?? { value: false };
    return {
      env: {
        RESERVATION_WORKFLOW: opts.workflow,
        GOOGLE_SYNC_QUEUE: {
          send: vi.fn().mockResolvedValue(undefined)
        },
        LINE_NOTIFICATION_QUEUE: {
          send: vi.fn().mockResolvedValue(undefined)
        }
      },
      executionCtx: {
        waitUntil: vi.fn((p: Promise<unknown>) => void p.catch(() => {}))
      },
      queueKickCalled
    };
  };

  it("falls back to queue kick when binding is undefined", async () => {
    const { triggerReservationWorkflow } = await import("../src/routes/shared");
    const ctx = makeContext({});
    triggerReservationWorkflow(
      ctx as never,
      "res-123",
      2
    );
    expect(ctx.env.GOOGLE_SYNC_QUEUE.send).toHaveBeenCalled();
    expect(ctx.env.LINE_NOTIFICATION_QUEUE.send).toHaveBeenCalled();
  });

  it("creates workflow instance with deterministic ID", async () => {
    const { triggerReservationWorkflow } = await import("../src/routes/shared");
    const create = vi.fn().mockResolvedValue({ id: "approve-res-123-v2" });
    const ctx = makeContext({ workflow: { create } });
    triggerReservationWorkflow(ctx as never, "res-123", 2);
    expect(create).toHaveBeenCalledWith({
      id: "approve-res-123-v2",
      params: { reservationId: "res-123", version: 2 }
    });
    expect(ctx.env.GOOGLE_SYNC_QUEUE.send).not.toHaveBeenCalled();
  });

  it("treats duplicate instance error as no-op without queue fallback", async () => {
    const { triggerReservationWorkflow } = await import("../src/routes/shared");
    const create = vi.fn().mockRejectedValue(new Error("Instance already exists"));
    const ctx = makeContext({ workflow: { create } });
    triggerReservationWorkflow(ctx as never, "res-123", 2);
    await new Promise((r) => setTimeout(r, 10));
    expect(ctx.env.GOOGLE_SYNC_QUEUE.send).not.toHaveBeenCalled();
  });

  it("falls back to queue kick on non-duplicate error", async () => {
    const { triggerReservationWorkflow } = await import("../src/routes/shared");
    const create = vi.fn().mockRejectedValue(new Error("Network timeout"));
    const ctx = makeContext({ workflow: { create } });
    triggerReservationWorkflow(ctx as never, "res-123", 2);
    await new Promise((r) => setTimeout(r, 10));
    expect(ctx.env.GOOGLE_SYNC_QUEUE.send).toHaveBeenCalled();
  });
});

describe("ReservationConfirmWorkflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The workflow captures NOTHING: telemetry is owned by the job processors
  // (processDueCalendarSyncJobs / processDueLineNotificationJobs capture their
  // own dead-transition failures for cron + workflow callers). The SDK step
  // instrumentation's auto-capture is dropped centrally in beforeSend
  // (dropSdkWorkflowEvent) as a tagless duplicate. So every workflow failure
  // path must rethrow WITHOUT calling captureBatchWriteFailure.
  it("rethrows a calendar step failure without capturing (processor owns telemetry)", async () => {
    const { ReservationConfirmWorkflow } = await import("../src/workflows/reservation-confirm");
    const calendarError = new Error("calendar step permanently failed");
    const step = {
      do: vi.fn().mockRejectedValueOnce(calendarError).mockResolvedValueOnce(undefined),
      sleep: vi.fn(),
      sleepUntil: vi.fn(),
      waitForEvent: vi.fn()
    };

    await expect(
      ReservationConfirmWorkflow.prototype.run.call(
        { env: { DB: {} } },
        {
          timestamp: new Date("2026-06-13T00:00:00.000Z"),
          instanceId: "workflow-calendar-failure",
          workflowName: "reservation-line-homepage-test-confirm-workflow",
          payload: { reservationId: "res-123", version: 2 }
        },
        step
      )
    ).rejects.toThrow("calendar-sync step exhausted retries for reservation res-123");

    expect(step.do).toHaveBeenCalledTimes(2);
    expect(captureBatchWriteFailure).not.toHaveBeenCalled();
  });

  it("rethrows a retryable LINE state without capturing (processor owns telemetry)", async () => {
    // Runs the REAL step callbacks (step.do mock invokes them): the LINE
    // processor reports failed=1 after capturing internally; D1 remains the
    // source of truth for whether the workflow should retry or terminate.
    const { ReservationConfirmWorkflow } = await import("../src/workflows/reservation-confirm");
    vi.mocked(processDueLineNotificationJobs).mockResolvedValue({
      processed: 1,
      succeeded: 0,
      failed: 1
    });
    // first() sequence: calendar findJobIdByDedupeKey → no job,
    // calendar assertJobTerminal → no row, line findJobIdByDedupeKey → job hit.
    const first = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "job-line-1" })
      .mockResolvedValueOnce({ status: "retryable", last_error: "line-http-429" });
    const db = { prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first })) })) };
    const env = { DB: db };
    const step = {
      do: vi.fn(async (_name: string, configOrCb: unknown, maybeCb?: () => Promise<unknown>) => {
        const callback = (maybeCb ?? configOrCb) as () => Promise<unknown>;
        return callback();
      }),
      sleep: vi.fn(),
      sleepUntil: vi.fn(),
      waitForEvent: vi.fn()
    };

    await expect(
      ReservationConfirmWorkflow.prototype.run.call(
        { env },
        {
          timestamp: new Date("2026-06-13T00:00:00.000Z"),
          instanceId: "workflow-line-result-failed",
          workflowName: "reservation-line-homepage-test-confirm-workflow",
          payload: { reservationId: "res-123", version: 2 }
        },
        step as never
      )
    ).rejects.toThrow("line-notification job still in retryable state");

    expect(processDueLineNotificationJobs).toHaveBeenCalledWith({
      db,
      env,
      maxJobs: 1,
      jobIdsFilter: ["job-line-1"]
    });
    expect(captureBatchWriteFailure).not.toHaveBeenCalled();
  });

  it("rethrows a dead-job NonRetryableError from the line step without capturing", async () => {
    const { ReservationConfirmWorkflow } = await import("../src/workflows/reservation-confirm");
    const deadError = new NonRetryableError("line-notification job reached dead state");
    const step = {
      do: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(deadError),
      sleep: vi.fn(),
      sleepUntil: vi.fn(),
      waitForEvent: vi.fn()
    };

    await expect(
      ReservationConfirmWorkflow.prototype.run.call(
        { env: { DB: {} } },
        {
          timestamp: new Date("2026-06-13T00:00:00.000Z"),
          instanceId: "workflow-line-dead",
          workflowName: "reservation-line-homepage-test-confirm-workflow",
          payload: { reservationId: "res-123", version: 2 }
        },
        step
      )
    ).rejects.toThrow("line-notification job reached dead state");

    expect(captureBatchWriteFailure).not.toHaveBeenCalled();
  });

  it.each([
    ["queued", LINE_MONTHLY_QUOTA_EXHAUSTED, false, null],
    ["dead", LINE_MONTHLY_QUOTA_EXHAUSTED, false, null],
    ["dead", "line-http-429", false, "line-notification job reached dead state"],
    ["dead", "line-http-503", false, "line-notification job reached dead state"],
    ["dead", LINE_MONTHLY_QUOTA_EXHAUSTED, true, "calendar-sync step exhausted retries"]
  ] as const)("settles %s / %s without hiding calendar failure=%s", async (status, reason, calendarFailed, error) => {
    const { ReservationConfirmWorkflow } = await import("../src/workflows/reservation-confirm");
    const db = createMigratedSqliteD1();
    try {
      db.sqlite.prepare(`INSERT INTO notification_jobs (id, dedupe_key, template_key, recipient_type, recipient_id, status, last_error)
        VALUES ('workflow-quota', 'reservation:res-123:template:reservation_confirmed:revision:2', 'reservation_confirmed', 'customer', 'fixture-recipient', ?, ?)`)
        .run(status, reason);
      if (calendarFailed) {
        db.sqlite.prepare(`INSERT INTO calendar_sync_jobs (id, dedupe_key, owner_type, owner_id, google_action, status, last_error)
          VALUES ('calendar-dead', 'reservation:res-123:google:upsert:revision:2', 'reservation', 'res-123', 'upsert', 'dead', ?)`)
          .run(LINE_MONTHLY_QUOTA_EXHAUSTED);
      }
      vi.mocked(processDueLineNotificationJobs).mockImplementation(async () => {
        db.sqlite.prepare("UPDATE notification_jobs SET status = 'dead', last_error = ? WHERE id = 'workflow-quota'").run(reason);
        return { processed: 1, succeeded: 0, failed: 1 };
      });
      const step = {
        do: vi.fn(async (_name: string, _config: unknown, callback: () => Promise<unknown>) => callback()),
        sleep: vi.fn(), sleepUntil: vi.fn(), waitForEvent: vi.fn()
      };
      const run = () => ReservationConfirmWorkflow.prototype.run.call({ env: { DB: db } }, {
        timestamp: new Date("2026-09-12T00:00:00.000Z"), instanceId: "quota-workflow", workflowName: "test",
        payload: { reservationId: "res-123", version: 2 }
      }, step as never);
      const result = run();
      if (error) {
        await expect(result).rejects.toThrow(error);
        if (!calendarFailed) await expect(result).rejects.toBeInstanceOf(NonRetryableError);
      } else {
        await expect(result).resolves.toBeUndefined();
      }
      expect(processDueLineNotificationJobs).toHaveBeenCalledTimes(status === "queued" ? 1 : 0);
      expect(db.sqlite.prepare("SELECT status, last_error FROM notification_jobs WHERE id = 'workflow-quota'").get())
        .toEqual({ status: "dead", last_error: reason });
      expect(captureBatchWriteFailure).not.toHaveBeenCalled();
    } finally {
      vi.mocked(processDueLineNotificationJobs).mockReset();
      db.sqlite.close();
    }
  });

  it("does not run workflow D1 writer steps during D1 DR freeze maintenance", async () => {
    const { ReservationConfirmWorkflow } = await import("../src/workflows/reservation-confirm");
    const step = {
      do: vi.fn(),
      sleep: vi.fn(),
      sleepUntil: vi.fn(),
      waitForEvent: vi.fn()
    };

    await ReservationConfirmWorkflow.prototype.run.call(
      {
        env: {
          MAINTENANCE_MODE: "d1-dr-freeze",
          DB: {
            prepare: vi.fn(() => {
              throw new Error("DB should not be touched during maintenance freeze");
            })
          }
        }
      },
      {
        timestamp: new Date("2026-06-13T00:00:00.000Z"),
        instanceId: "workflow-test-instance",
        workflowName: "reservation-line-homepage-test-confirm-workflow",
        payload: {
          reservationId: "res-123",
          version: 2
        }
      },
      step
    );

    expect(step.do).not.toHaveBeenCalled();
  });
});

describe("processDueCalendarSyncJobs jobIdsFilter contract", () => {
  it("returns zero results for empty array filter", async () => {
    const { processDueCalendarSyncJobs } = await import(
      "../src/google/calendar-sync"
    );
    const result = await processDueCalendarSyncJobs({
      db: {} as D1Database,
      env: {} as never,
      jobIdsFilter: []
    });
    expect(result).toEqual({ processed: 0, succeeded: 0, failed: 0 });
  });
});
