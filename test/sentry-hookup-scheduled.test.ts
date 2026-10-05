/**
 * D2 + D5: Sentry hookup tests for scheduled and queue handlers.
 *
 * Mocks @sentry/cloudflare to verify:
 * - safeCaptureException is called with correct tags at each callsite
 * - scheduled handler returns an aggregated promise (D5)
 * - queue handler rethrows after capture (retry semantics)
 * - Promise.allSettled aggregation works for multi-task reject (D5)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock @sentry/cloudflare BEFORE importing the module under test.
// withMonitor is a pass-through that invokes the callback (so the wrapped
// task body still runs) while letting tests assert the slug/config args.
vi.mock("@sentry/cloudflare", () => ({
  withSentry: (_opts: unknown, handler: unknown) => handler,
  // src/index.ts wraps the workflow export at module init — a pass-through keeps
  // the class importable under the mock.
  instrumentWorkflowWithSentry: (_opts: unknown, WorkflowClass: unknown) => WorkflowClass,
  captureException: vi.fn(),
  init: vi.fn(),
  withMonitor: vi.fn(
    (_slug: string, callback: () => unknown, _config?: unknown) => callback()
  )
}));

// Mock sub-modules to isolate scheduled/queue handler logic
vi.mock("../src/app", () => ({
  createApp: () => ({
    fetch: vi.fn(async () => new Response("ok"))
  }),
  isAdminHost: () => false,
  isAdminPrivatePath: () => false
}));

vi.mock("../src/google/channel-watch", () => ({
  ensureGoogleCalendarWatchChannels: vi.fn(async () => {})
}));
vi.mock("../src/google/calendar-sync", () => ({
  processDueCalendarSyncJobs: vi.fn(async () => {})
}));
vi.mock("../src/google/conflict-burst-detector", () => ({
  detectConflictBursts: vi.fn(async () => {})
}));
vi.mock("../src/google/import-sync", () => ({
  enqueueGoogleCalendarMaintenanceJobs: vi.fn(async () => {}),
  processDueGoogleCalendarImportJobs: vi.fn(async () => {}),
  pruneGoogleEventHistory: vi.fn(async () => {})
}));
vi.mock("../src/line/notifications", () => ({
  processDueLineNotificationJobs: vi.fn(async () => ({
    processed: 0, succeeded: 0, failed: 0
  }))
}));
vi.mock("../src/notifications/daily-ops-summary", () => ({
  dispatchDailyOpsSummary: vi.fn(async () => ({ enqueued: 0, skipped: 0 }))
}));
vi.mock("../src/notifications/reminder-dispatcher", () => ({
  dispatchReservationReminders: vi.fn(async () => ({ scanned: 0, enqueued: 0 }))
}));
vi.mock("../src/reservations/expiration", () => ({
  expirePendingReservations: vi.fn(async () => ({ ok: true, expired: 0, reason: undefined }))
}));
vi.mock("../src/reservations/auto-complete", async (importOriginal) => ({
  // 定数 (AUTO_COMPLETE_GRACE_MS など) は実体を使う。cron の呼び出しだけ差し替える。
  ...(await importOriginal<typeof import("../src/reservations/auto-complete")>()),
  runAutoCompleteForCron: vi.fn(async () => {})
}));
vi.mock("../src/retention-sweep", () => ({
  runRetentionSweepPhase1: vi.fn(async () => ({ skipped: false, deleted: {} }))
}));
vi.mock("../src/line/quota", () => ({
  notifyLowLineQuota: vi.fn(async () => {}),
  refreshLineQuotaSnapshot: vi.fn(async () => null),
  readLineQuotaStatus: vi.fn(async () => null),
  optionalPushHeadroom: vi.fn(() => Infinity)
}));

import * as Sentry from "@sentry/cloudflare";
import { dispatchDailyOpsSummary } from "../src/notifications/daily-ops-summary";
import { dispatchReservationReminders } from "../src/notifications/reminder-dispatcher";
import { processDueLineNotificationJobs } from "../src/line/notifications";
import {
  enqueueGoogleCalendarMaintenanceJobs,
  processDueGoogleCalendarImportJobs,
  pruneGoogleEventHistory
} from "../src/google/import-sync";
import { runRetentionSweepPhase1 } from "../src/retention-sweep";
import { runAutoCompleteForCron } from "../src/reservations/auto-complete";
import { notifyLowLineQuota, refreshLineQuotaSnapshot } from "../src/line/quota";
import { ensureGoogleCalendarWatchChannels } from "../src/google/channel-watch";
import { expirePendingReservations } from "../src/reservations/expiration";
import {
  D1_DR_FREEZE_HEADER_NAME,
  D1_DR_FREEZE_MAINTENANCE_MODE,
  D1_DR_FREEZE_RETRY_DELAY_SECONDS,
  D1_DR_FREEZE_SENTINEL_PATH
} from "../src/runtime-config";

// Import the default export which is the wrapped handler object
import workerHandlers, { surfaceMaintenanceCronRejections } from "../src/index";

const mockEnv = {
  DB: {} as D1Database,
  ASSETS: { fetch: vi.fn() } as unknown as Fetcher,
  GOOGLE_SYNC_QUEUE: {} as Queue<unknown>,
  LINE_NOTIFICATION_QUEUE: {} as Queue<unknown>,
  ENVIRONMENT: "staging",
  SPEC_VERSION: "test",
  ACCESS_TEAM_DOMAIN: "",
  ACCESS_AUD: "",
  LINE_CHANNEL_ID: "",
  LINE_LIFF_ID: "",
  LINE_CHANNEL_SECRET: "",
  LINE_OFFICIAL_ACCOUNT_ID: "",
  LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "",
  GOOGLE_CALENDAR_WEBHOOK_URL: "",
  GOOGLE_IMPORT_ENABLED: "false",
  GOOGLE_LIVE_AVAILABILITY_ENABLED: "false",
  GOOGLE_SERVICE_ACCOUNT_EMAIL: "",
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "",
  TURNSTILE_SECRET_KEY: "",
  TURNSTILE_SITE_KEY: "",
  TURNSTILE_EXPECTED_HOSTNAME: "",
  TURNSTILE_EXPECTED_ACTION: "",
  RESERVATION_NOTICE_VERSION: "",
  RESERVATION_CANCELLATION_POLICY_VERSION: "",
  RESERVATION_PRIVACY_POLICY_VERSION: "",
  RESERVATION_MINOR_GUARDIAN_VERSION: "",
  RESERVATION_DUPLICATE_WARNING_VERSION: "",
  LINE_OPERATIONS_USER_IDS: "",
  PENDING_APPROVAL_OWNER_EMAIL: "",
  OPERATIONS_NOTIFICATION_EMAIL: "",
  GOOGLE_DRIFT_ALERT_LIVE: "false",
  GOOGLE_CONFLICT_BURST_ALERT_LIVE: "false",
  RESERVATION_REMINDER_DISPATCH_ENABLED: "true",
  SENTRY_DSN: "",
  DAILY_OPS_SUMMARY_DISPATCH_ENABLED: "true"
};

function createMockCtx() {
  const waitUntilPromises: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: vi.fn((p: Promise<unknown>) => {
        waitUntilPromises.push(p);
      }),
      passThroughOnException: vi.fn(),
      exports: {} as never,
      props: undefined as never
    } as unknown as ExecutionContext,
    waitUntilPromises
  };
}

describe("scheduled handler Sentry integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // D5: scheduled handler returns aggregated promise
  it("returns a promise (promise-returning design for withSentry)", async () => {
    const { ctx } = createMockCtx();
    const result = workerHandlers.scheduled(
      { cron: "*/10 * * * *", scheduledTime: Date.now(), noRetry: vi.fn() },
      mockEnv,
      ctx
    );
    // The handler must return a promise (not void) for withSentry lifecycle
    expect(result).toBeInstanceOf(Promise);
    await result;
  });

  it("D1 DR freeze maintenance mode returns a monitored no-op without touching D1", async () => {
    const { ctx } = createMockCtx();
    const result = workerHandlers.scheduled(
      { cron: "*/10 * * * *", scheduledTime: Date.now(), noRetry: vi.fn() },
      { ...mockEnv, MAINTENANCE_MODE: D1_DR_FREEZE_MAINTENANCE_MODE },
      ctx
    );

    await result;

    expect(Sentry.withMonitor).toHaveBeenCalledWith(
      "maintenance-10min",
      expect.any(Function),
      expect.any(Object)
    );
    expect(expirePendingReservations).not.toHaveBeenCalled();
    expect(ctx.waitUntil).toHaveBeenCalledWith(result);
  });

  // B2: daily_ops_summary dispatcher failure captures to Sentry
  it("B2: captures daily_ops_summary dispatch failure", async () => {
    const testError = new Error("daily_ops_db_failure");
    vi.mocked(dispatchDailyOpsSummary).mockRejectedValueOnce(testError);

    const { ctx } = createMockCtx();
    const result = workerHandlers.scheduled(
      { cron: "0 11 * * *", scheduledTime: Date.now(), noRetry: vi.fn() },
      mockEnv,
      ctx
    );

    // The aggregated promise should reject (error propagates)
    await expect(result).rejects.toThrow("daily_ops_db_failure");

    expect(Sentry.captureException).toHaveBeenCalledWith(
      testError,
      expect.objectContaining({
        tags: { cron: "0 11 * * *", dispatcher: "daily_ops_summary" }
      })
    );
  });

  // B8: reservation_reminder dispatcher failure captures to Sentry
  it("B8: captures reservation_reminder dispatch failure", async () => {
    const testError = new Error("reminder_db_failure");
    vi.mocked(dispatchReservationReminders).mockRejectedValueOnce(testError);

    const { ctx } = createMockCtx();
    const result = workerHandlers.scheduled(
      { cron: "*/10 * * * *", scheduledTime: Date.now(), noRetry: vi.fn() },
      mockEnv,
      ctx
    );

    await expect(result).rejects.toThrow("reminder_db_failure");

    expect(Sentry.captureException).toHaveBeenCalledWith(
      testError,
      expect.objectContaining({
        tags: { cron: "*/10 * * * *", dispatcher: "reservation_reminder" }
      })
    );
  });

  it("reminder dispatch が失敗しても fan-out の兄弟タスクは実行される", async () => {
    vi.mocked(dispatchReservationReminders).mockRejectedValueOnce(
      new Error("reminder_fanout_failure")
    );

    const { ctx } = createMockCtx();
    const result = workerHandlers.scheduled(
      { cron: "*/10 * * * *", scheduledTime: Date.now(), noRetry: vi.fn() },
      { ...mockEnv, GOOGLE_IMPORT_ENABLED: "true" },
      ctx
    );

    await expect(result).rejects.toThrow("reminder_fanout_failure");
    expect(processDueGoogleCalendarImportJobs).toHaveBeenCalledTimes(1);
    expect(processDueLineNotificationJobs).toHaveBeenCalledTimes(1);
  });

  // 失敗の保持は boolean で行う。`error !== undefined` を番兵に使うと
  // `Promise.reject()` / `throw undefined` が「失敗なし」に化けて、
  // 握り潰しを直すための実装が握り潰しに戻る。
  it("reminder dispatch が undefined で reject しても cron は失敗する", async () => {
    vi.mocked(dispatchReservationReminders).mockRejectedValueOnce(undefined);

    const { ctx } = createMockCtx();
    const result = workerHandlers.scheduled(
      { cron: "*/10 * * * *", scheduledTime: Date.now(), noRetry: vi.fn() },
      mockEnv,
      ctx
    );

    await expect(result).rejects.toBeUndefined();
    expect(processDueLineNotificationJobs).toHaveBeenCalledTimes(1);
  });

  // reminder の再throwは surfaceMaintenanceCronRejections の後ろに置いてある。
  // 前に出すと兄弟タスクの二次capture(Sentry)が丸ごと飛ぶため、兄弟も失敗した
  // ときは兄弟side の理由が表面化する、という順序をここで固定する。
  it("兄弟タスクも失敗したときは兄弟側の理由が表面化する", async () => {
    vi.mocked(dispatchReservationReminders).mockRejectedValueOnce(
      new Error("reminder_fanout_failure")
    );
    vi.mocked(processDueGoogleCalendarImportJobs).mockRejectedValueOnce(
      new Error("sibling_import_failure")
    );

    const { ctx } = createMockCtx();
    const result = workerHandlers.scheduled(
      { cron: "*/10 * * * *", scheduledTime: Date.now(), noRetry: vi.fn() },
      { ...mockEnv, GOOGLE_IMPORT_ENABLED: "true" },
      ctx
    );

    await expect(result).rejects.toThrow("sibling_import_failure");
  });

  // D5: Promise.allSettled — multiple tasks, one rejects
  it("D5: aggregated promise rejects when a cron branch task rejects", async () => {
    const testError = new Error("branch_failure");
    vi.mocked(dispatchReservationReminders).mockRejectedValueOnce(testError);

    const { ctx } = createMockCtx();
    const result = workerHandlers.scheduled(
      { cron: "*/10 * * * *", scheduledTime: Date.now(), noRetry: vi.fn() },
      mockEnv,
      ctx
    );

    await expect(result).rejects.toThrow("branch_failure");
    // waitUntil was called with the aggregated promise
    expect(ctx.waitUntil).toHaveBeenCalled();
  });

  // D5: successful scheduled run resolves
  it("D5: aggregated promise resolves on success", async () => {
    const { ctx } = createMockCtx();
    const result = workerHandlers.scheduled(
      { cron: "*/10 * * * *", scheduledTime: Date.now(), noRetry: vi.fn() },
      mockEnv,
      ctx
    );
    await expect(result).resolves.toBeUndefined();
  });

  // B9: withMonitor wraps each known cron with its registered slug+config
  it("B9: */10 cron wraps with maintenance-10min monitor slug", async () => {
    const { ctx } = createMockCtx();
    await workerHandlers.scheduled(
      { cron: "*/10 * * * *", scheduledTime: Date.now(), noRetry: vi.fn() },
      mockEnv,
      ctx
    );
    expect(Sentry.withMonitor).toHaveBeenCalledTimes(1);
    expect(Sentry.withMonitor).toHaveBeenCalledWith(
      "maintenance-10min",
      expect.any(Function),
      expect.objectContaining({
        schedule: { type: "crontab", value: "*/10 * * * *" },
        timezone: "Etc/UTC"
      })
    );
  });

  it("B9: 3 19 cron wraps with reservation-reminder-dispatch slug", async () => {
    const { ctx } = createMockCtx();
    await workerHandlers.scheduled(
      { cron: "3 19 * * *", scheduledTime: Date.now(), noRetry: vi.fn() },
      mockEnv,
      ctx
    );
    expect(Sentry.withMonitor).toHaveBeenCalledWith(
      "reservation-reminder-dispatch",
      expect.any(Function),
      expect.objectContaining({
        schedule: { type: "crontab", value: "3 19 * * *" },
        timezone: "Etc/UTC"
      })
    );
  });

  it("B9: 0 11 cron wraps with daily-ops-summary slug", async () => {
    const { ctx } = createMockCtx();
    await workerHandlers.scheduled(
      { cron: "0 11 * * *", scheduledTime: Date.now(), noRetry: vi.fn() },
      mockEnv,
      ctx
    );
    expect(Sentry.withMonitor).toHaveBeenCalledWith(
      "daily-ops-summary",
      expect.any(Function),
      expect.objectContaining({
        schedule: { type: "crontab", value: "0 11 * * *" },
        timezone: "Etc/UTC"
      })
    );
  });

  it("5 16 * * * で notifyLowLineQuota が1回呼ばれる", async () => {
    const { ctx } = createMockCtx();
    await workerHandlers.scheduled(
      { cron: "5 16 * * *", scheduledTime: Date.now(), noRetry: vi.fn() },
      mockEnv,
      ctx
    );

    expect(notifyLowLineQuota).toHaveBeenCalledTimes(1);
  });

  // 残枠アラートを 0 11 に戻すと、同じ tick の processDueLineNotificationJobs が
  // 送る分を読み落として閾値の跨ぎを翌日まで報告できなくなる。「5 16 で呼ばれる」
  // だけでは両方の cron に積んだ実装も通ってしまうので、不在側も固定する。
  it("0 11 * * * では notifyLowLineQuota を呼ばない (送信と同じ tick を避ける)", async () => {
    const { ctx } = createMockCtx();
    await workerHandlers.scheduled(
      { cron: "0 11 * * *", scheduledTime: Date.now(), noRetry: vi.fn() },
      mockEnv,
      ctx
    );

    expect(notifyLowLineQuota).not.toHaveBeenCalled();
  });

  // 「呼ばれたこと」だけでは、呼び出し側で catch する・tasks に積まない・返却
  // promise から切り離す、といった変更を検出できない。残枠アラートの送信失敗が
  // cron を赤にする、という新しい運用契約そのものをここで固定する。
  it("notifyLowLineQuota が失敗したら 5 16 cron も失敗する", async () => {
    vi.mocked(notifyLowLineQuota).mockRejectedValueOnce(new Error("line_quota_alert_no_recipient"));

    const { ctx } = createMockCtx();
    const result = workerHandlers.scheduled(
      { cron: "5 16 * * *", scheduledTime: Date.now(), noRetry: vi.fn() },
      mockEnv,
      ctx
    );

    await expect(result).rejects.toThrow("line_quota_alert_no_recipient");
    // 兄弟の掃除タスクは道連れにしない。
    expect(runRetentionSweepPhase1).toHaveBeenCalledTimes(1);
    expect(runAutoCompleteForCron).toHaveBeenCalledTimes(1);
  });

  // B9: unknown cron spec bypasses withMonitor (no false-positive monitors)
  it("B9: unknown cron spec bypasses withMonitor", async () => {
    const { ctx } = createMockCtx();
    await workerHandlers.scheduled(
      { cron: "0 0 * * 0", scheduledTime: Date.now(), noRetry: vi.fn() },
      mockEnv,
      ctx
    );
    expect(Sentry.withMonitor).not.toHaveBeenCalled();
  });

  it("B9: 5 16 daily-cleanup cron wraps with daily-cleanup slug", async () => {
    const { ctx } = createMockCtx();
    await workerHandlers.scheduled(
      { cron: "5 16 * * *", scheduledTime: Date.now(), noRetry: vi.fn() },
      mockEnv,
      ctx
    );
    expect(Sentry.withMonitor).toHaveBeenCalledWith(
      "daily-cleanup",
      expect.any(Function),
      expect.objectContaining({
        schedule: { type: "crontab", value: "5 16 * * *" },
        timezone: "Etc/UTC"
      })
    );
  });

  it("daily-cleanup runs prune + retention and NOT the */10 dispatch subtasks", async () => {
    const { ctx } = createMockCtx();
    await workerHandlers.scheduled(
      { cron: "5 16 * * *", scheduledTime: Date.now(), noRetry: vi.fn() },
      { ...mockEnv, GOOGLE_IMPORT_ENABLED: "true" },
      ctx
    );
    // Owns the heavy daily sweeps...
    expect(pruneGoogleEventHistory).toHaveBeenCalledTimes(1);
    expect(runRetentionSweepPhase1).toHaveBeenCalledTimes(1);
    expect(runAutoCompleteForCron).toHaveBeenCalledTimes(1);
    // ...but NOT the hot-path dispatch / import-processing work.
    expect(processDueLineNotificationJobs).not.toHaveBeenCalled();
    expect(processDueGoogleCalendarImportJobs).not.toHaveBeenCalled();
    expect(dispatchReservationReminders).not.toHaveBeenCalled();
    expect(enqueueGoogleCalendarMaintenanceJobs).not.toHaveBeenCalled();
  });

  it("cron prelude expiration is bounded (drain:false) so a backlog cannot run unbounded under the prelude budget", async () => {
    const { ctx } = createMockCtx();
    await workerHandlers.scheduled(
      { cron: "*/10 * * * *", scheduledTime: Date.now(), noRetry: vi.fn() },
      mockEnv,
      ctx
    );
    // The */10 prelude must NOT drain an unbounded backlog under its fixed
    // PRELUDE_TASK_TIMEOUT_MS budget — it processes at most one bounded batch.
    expect(expirePendingReservations).toHaveBeenCalledWith(
      expect.objectContaining({ drain: false, maxReservations: 200 })
    );
  });

  it("0 11 daily-ops prelude expiration is also bounded (drain:false)", async () => {
    const { ctx } = createMockCtx();
    await workerHandlers.scheduled(
      { cron: "0 11 * * *", scheduledTime: Date.now(), noRetry: vi.fn() },
      mockEnv,
      ctx
    );
    expect(expirePendingReservations).toHaveBeenCalledWith(
      expect.objectContaining({ drain: false, maxReservations: 200 })
    );
  });

  it("*/10 maintenance no longer runs prune or retention (moved to daily-cleanup)", async () => {
    const { ctx } = createMockCtx();
    await workerHandlers.scheduled(
      { cron: "*/10 * * * *", scheduledTime: Date.now(), noRetry: vi.fn() },
      { ...mockEnv, GOOGLE_IMPORT_ENABLED: "true" },
      ctx
    );
    expect(pruneGoogleEventHistory).not.toHaveBeenCalled();
    expect(runRetentionSweepPhase1).not.toHaveBeenCalled();
    // The hot path still dispatches notifications + processes import jobs.
    expect(processDueLineNotificationJobs).toHaveBeenCalledTimes(1);
    expect(processDueGoogleCalendarImportJobs).toHaveBeenCalledTimes(1);
  });

  it("refresh_quota stays best-effort: a hung quota refresh is bounded but does NOT abort the tick", async () => {
    vi.useFakeTimers();
    try {
      // Quota refresh hangs forever → its 90s per-task timeout fires, but it is
      // swallowed (best-effort) so notification dispatch still proceeds and the
      // tick RESOLVES rather than rejecting.
      vi.mocked(refreshLineQuotaSnapshot).mockImplementationOnce(
        () => new Promise(() => {}) as ReturnType<typeof refreshLineQuotaSnapshot>
      );

      const { ctx } = createMockCtx();
      const result = workerHandlers.scheduled(
        { cron: "*/10 * * * *", scheduledTime: Date.now(), noRetry: vi.fn() },
        mockEnv,
        ctx
      );
      const assertion = expect(result).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(90 * 1000);
      await assertion;
      // Dispatch was NOT aborted by the quota stall — the whole point of keeping
      // refresh_quota best-effort.
      expect(processDueLineNotificationJobs).toHaveBeenCalledTimes(1);
      // The stalled refresh was surfaced to Sentry, not silently dropped.
      expect(Sentry.captureException).toHaveBeenCalledWith(
        expect.objectContaining({ message: "cron_task_timeout:refresh_quota" }),
        expect.objectContaining({ tags: expect.objectContaining({ task: "refresh_quota" }) })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("allSettled: waits for a slower legitimate dispatcher before surfacing a light sibling timeout", async () => {
    vi.useFakeTimers();
    try {
      // A light Google sibling hangs (fires its 90s budget). LINE dispatch is
      // legitimately slower and resolves at 120s (well under its 270s claim
      // budget). With the OLD Promise.all the aggregate would have failed-fast
      // at 90s and let the runtime tear down the in-flight LINE dispatcher;
      // Promise.allSettled instead waits for LINE to finish, THEN surfaces the
      // named light timeout.
      vi.mocked(ensureGoogleCalendarWatchChannels).mockImplementationOnce(
        () => new Promise(() => {}) as ReturnType<typeof ensureGoogleCalendarWatchChannels>
      );
      vi.mocked(processDueLineNotificationJobs).mockImplementationOnce(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ processed: 0, succeeded: 0, failed: 0 }), 120 * 1000)
          ) as ReturnType<typeof processDueLineNotificationJobs>
      );

      const { ctx } = createMockCtx();
      const result = workerHandlers.scheduled(
        { cron: "*/10 * * * *", scheduledTime: Date.now(), noRetry: vi.fn() },
        { ...mockEnv, GOOGLE_IMPORT_ENABLED: "true" },
        ctx
      );
      let settled = false;
      const assertion = expect(result).rejects.toThrow(
        "cron_task_timeout:ensure_watch_channels"
      );
      void Promise.resolve(result).then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );

      // At 90s the light sibling has timed out, but the tick must NOT settle yet
      // — it is still waiting for the slower LINE dispatcher (old Promise.all
      // would already have rejected here).
      await vi.advanceTimersByTimeAsync(90 * 1000);
      expect(settled).toBe(false);

      // After the LINE dispatcher finishes (120s total) the aggregate settles
      // and surfaces the named light-sibling timeout.
      await vi.advanceTimersByTimeAsync(30 * 1000);
      await assertion;
      expect(processDueLineNotificationJobs).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("daily-cleanup: a hung retention sweep surfaces a named cron_task_timeout", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(runRetentionSweepPhase1).mockImplementationOnce(
        () => new Promise(() => {}) as ReturnType<typeof runRetentionSweepPhase1>
      );

      const { ctx } = createMockCtx();
      const result = workerHandlers.scheduled(
        { cron: "5 16 * * *", scheduledTime: Date.now(), noRetry: vi.fn() },
        mockEnv,
        ctx
      );
      const assertion = expect(result).rejects.toThrow(
        "cron_task_timeout:retention_sweep"
      );
      // 5 min per-task budget on the daily-cleanup cron.
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  // Per-task timeout: a hung subtask now fails fast WITH ITS NAME
  // (`cron_task_timeout:line_notifications`) at the 90s per-task budget —
  // BEFORE the 7-minute branch watchdog — so the surfaced error pinpoints the
  // stalled subtask instead of the generic branch-level timeout. withMonitor
  // still wraps the same aggregate function.
  it("per-task timeout: hung subtask rejects aggregate with its named cron_task_timeout", async () => {
    // try/finally so a mid-test assertion failure cannot leak fake timers
    // into the rest of the suite.
    vi.useFakeTimers();
    try {
      // Make the LINE dispatch hang forever so its per-task timeout fires.
      vi.mocked(processDueLineNotificationJobs).mockImplementationOnce(
        () => new Promise(() => {}) as ReturnType<typeof processDueLineNotificationJobs>
      );

      const { ctx, waitUntilPromises } = createMockCtx();
      const result = workerHandlers.scheduled(
        { cron: "*/10 * * * *", scheduledTime: Date.now(), noRetry: vi.fn() },
        mockEnv,
        ctx
      );

      // withMonitor wraps the aggregate fn even when it later times out.
      expect(Sentry.withMonitor).toHaveBeenCalledWith(
        "maintenance-10min",
        expect.any(Function),
        expect.any(Object)
      );

      const assertion = expect(result).rejects.toThrow(
        "cron_task_timeout:line_notifications"
      );
      // The same aggregated promise was handed to waitUntil.
      expect(ctx.waitUntil).toHaveBeenCalled();
      const waitUntilAssertion = expect(waitUntilPromises[0]).rejects.toThrow(
        "cron_task_timeout:line_notifications"
      );

      // Advance past the shared claim-task budget (270s, sized for up to 500
      // rate-limited LINE jobs and < the 5-min job lock so it can't relock-race;
      // still < the 7-minute branch watchdog) so the NAMED per-task timeout
      // fires first.
      await vi.advanceTimersByTimeAsync(270 * 1000);
      await assertion;
      await waitUntilAssertion;
    } finally {
      vi.useRealTimers();
    }
  });

  // Regression (codex round-7): the prelude tasks (expire → reminder enqueue →
  // quota refresh) run SEQUENTIALLY before the concurrent claim fan-out, so a
  // slow prelude pushes the fan-out start later into the cron window. Their
  // budgets must be small enough that even a worst-case prelude leaves a FULL
  // claim budget of branch-watchdog headroom — otherwise a hung claim dispatcher
  // would be torn down by the 420s branch watchdog BEFORE its own named timeout,
  // re-orphaning claimed jobs (duplicate send) and hiding the culprit behind the
  // generic cron_watchdog_timeout. Prove the NAMED claim timeout still wins.
  it("slow prelude + hung claim dispatcher: fails via the NAMED claim timeout, never the branch watchdog", async () => {
    vi.useFakeTimers();
    try {
      const slow = <T>(value: T, ms: number): Promise<T> =>
        new Promise<T>((resolve) => {
          setTimeout(() => resolve(value), ms);
        });
      // Worst-case prelude: each of the three sequential prelude awaits runs to
      // its full 40s budget (120s total) before the fan-out starts.
      vi.mocked(expirePendingReservations).mockImplementationOnce(
        () =>
          slow({ ok: true, expiredCount: 0 }, 40 * 1000) as unknown as ReturnType<
            typeof expirePendingReservations
          >
      );
      vi.mocked(dispatchReservationReminders).mockImplementationOnce(
        () => slow({ scanned: 0, enqueued: 0 }, 40 * 1000) as ReturnType<typeof dispatchReservationReminders>
      );
      vi.mocked(refreshLineQuotaSnapshot).mockImplementationOnce(
        () => slow(null, 40 * 1000) as ReturnType<typeof refreshLineQuotaSnapshot>
      );
      // Then the claim dispatcher hangs forever.
      vi.mocked(processDueLineNotificationJobs).mockImplementationOnce(
        () => new Promise(() => {}) as ReturnType<typeof processDueLineNotificationJobs>
      );

      const { ctx } = createMockCtx();
      const result = workerHandlers.scheduled(
        { cron: "*/10 * * * *", scheduledTime: Date.now(), noRetry: vi.fn() },
        mockEnv,
        ctx
      );
      let settled = false;
      const assertion = expect(result).rejects.toThrow(
        "cron_task_timeout:line_notifications"
      );
      void Promise.resolve(result).then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );

      // Prelude (120s) + just under the claim budget (269s) = 389s: the claim
      // dispatcher is still running and the 420s branch watchdog has NOT fired.
      await vi.advanceTimersByTimeAsync(120 * 1000 + 269 * 1000);
      expect(settled).toBe(false);

      // At 390s the claim task's OWN named timeout fires — strictly before the
      // 420s branch watchdog — so the surfaced error names the culprit.
      await vi.advanceTimersByTimeAsync(1 * 1000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  // B9: rethrow preserved when monitored callback fails
  it("B9: withMonitor rethrow propagates dispatch failure", async () => {
    const testError = new Error("monitored_dispatch_failure");
    vi.mocked(dispatchReservationReminders).mockRejectedValueOnce(testError);

    const { ctx } = createMockCtx();
    const result = workerHandlers.scheduled(
      { cron: "3 19 * * *", scheduledTime: Date.now(), noRetry: vi.fn() },
      mockEnv,
      ctx
    );
    await expect(result).rejects.toThrow("monitored_dispatch_failure");
    expect(Sentry.withMonitor).toHaveBeenCalledWith(
      "reservation-reminder-dispatch",
      expect.any(Function),
      expect.any(Object)
    );
  });
});

describe("queue handler Sentry integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // B4: queue handler captures and rethrows
  it("B4: captures exception and rethrows for retry semantics", async () => {
    // Trigger queue error via unknown queue name — handler throws
    // `unsupported_queue:...` after classifyReservationQueue returns undefined.
    const mockBatch = {
      queue: "unknown-queue-name",
      messages: [],
      ackAll: vi.fn(),
      retryAll: vi.fn(),
      metadata: { consumedOffsets: [] }
    } as unknown as MessageBatch<unknown>;

    const { ctx } = createMockCtx();
    await expect(
      workerHandlers.queue(mockBatch, mockEnv, ctx)
    ).rejects.toThrow(/unsupported_queue/);

    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { queue: "unknown-queue-name", handler: "queue" }
      })
    );
  });

  it("DLQ batch: captures alert, acks all messages, and does not throw", async () => {
    const ackAll = vi.fn();
    const mockBatch = {
      queue: "reservation-line-homepage-production-google-sync-dlq",
      messages: [{ body: { kind: "kick" } }, { body: { kind: "kick" } }],
      ackAll,
      retryAll: vi.fn(),
      metadata: { consumedOffsets: [] }
    } as unknown as MessageBatch<unknown>;

    const { ctx } = createMockCtx();
    await workerHandlers.queue(mockBatch, mockEnv, ctx);

    // The alert is surfaced to Sentry with the DLQ-specific tags...
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("queue_dead_letter_messages") }),
      expect.objectContaining({
        tags: {
          queue: "reservation-line-homepage-production-google-sync-dlq",
          handler: "queue_dlq"
        },
        contexts: { dlq: { message_count: 2 } }
      })
    );
    // ...and the batch is acked so the DLQ cannot silently accumulate.
    expect(ackAll).toHaveBeenCalled();
  });

  it("DLQ alert never leaks message body contents to console or Sentry", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const mockBatch = {
        queue: "reservation-line-homepage-production-line-notifications-dlq",
        messages: [{ body: { job_id: "job-123", line_user_id: "U-SECRET-PII" } }],
        ackAll: vi.fn(),
        retryAll: vi.fn(),
        metadata: { consumedOffsets: [] }
      } as unknown as MessageBatch<unknown>;

      const { ctx } = createMockCtx();
      await workerHandlers.queue(mockBatch, mockEnv, ctx);

      // Only queue name + message count are emitted — never body fields.
      const consolePayload = JSON.stringify(consoleSpy.mock.calls);
      expect(consolePayload).not.toContain("U-SECRET-PII");
      expect(consolePayload).not.toContain("job-123");
      const sentryPayload = JSON.stringify(vi.mocked(Sentry.captureException).mock.calls);
      expect(sentryPayload).not.toContain("U-SECRET-PII");
      expect(sentryPayload).not.toContain("job-123");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("D1 DR freeze maintenance mode still surfaces and acks DLQ batches", async () => {
    const ackAll = vi.fn();
    const retryAll = vi.fn();
    const mockBatch = {
      queue: "reservation-line-homepage-production-google-sync-dlq",
      messages: [{ body: { kind: "kick" } }],
      ackAll,
      retryAll,
      metadata: { consumedOffsets: [] }
    } as unknown as MessageBatch<unknown>;

    const { ctx } = createMockCtx();
    await workerHandlers.queue(
      mockBatch,
      { ...mockEnv, MAINTENANCE_MODE: D1_DR_FREEZE_MAINTENANCE_MODE },
      ctx
    );

    expect(retryAll).not.toHaveBeenCalled();
    expect(ackAll).toHaveBeenCalled();
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("queue_dead_letter_messages") }),
      expect.objectContaining({
        tags: {
          queue: "reservation-line-homepage-production-google-sync-dlq",
          handler: "queue_dlq"
        }
      })
    );
    expect(expirePendingReservations).not.toHaveBeenCalled();
  });

  it("D1 DR freeze maintenance mode retries queue batches without touching D1 or acking", async () => {
    const retryAll = vi.fn();
    const ackAll = vi.fn();
    const mockBatch = {
      queue: "reservation-line-homepage-production-google-sync",
      messages: [{ body: { kind: "kick" } }],
      ackAll,
      retryAll,
      metadata: { consumedOffsets: [] }
    } as unknown as MessageBatch<unknown>;

    const { ctx } = createMockCtx();
    await workerHandlers.queue(
      mockBatch,
      { ...mockEnv, MAINTENANCE_MODE: D1_DR_FREEZE_MAINTENANCE_MODE },
      ctx
    );

    expect(retryAll).toHaveBeenCalledWith({ delaySeconds: D1_DR_FREEZE_RETRY_DELAY_SECONDS });
    expect(ackAll).not.toHaveBeenCalled();
    expect(expirePendingReservations).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("does not capture on successful queue processing", async () => {
    // Provide a valid queue name — expiration is mocked to succeed
    const mockBatch = {
      queue: "reservation-line-notifications",
      messages: [],
      ackAll: vi.fn(),
      retryAll: vi.fn(),
      metadata: { consumedOffsets: [] }
    } as unknown as MessageBatch<unknown>;

    const { ctx } = createMockCtx();
    await workerHandlers.queue(mockBatch, mockEnv, ctx);

    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(mockBatch.ackAll).toHaveBeenCalled();
  });
});

describe("fetch handler D1 DR freeze maintenance mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a no-store 503 sentinel before normal routing can touch D1 or assets", async () => {
    const { ctx } = createMockCtx();
    const response = await workerHandlers.fetch(
      new Request("https://reserve.example.invalid/api/health"),
      { ...mockEnv, MAINTENANCE_MODE: D1_DR_FREEZE_MAINTENANCE_MODE },
      ctx
    );

    expect(response.status).toBe(503);
    expect(response.headers.get(D1_DR_FREEZE_HEADER_NAME)).toBe(D1_DR_FREEZE_MAINTENANCE_MODE);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Strict-Transport-Security")).toContain("max-age=");
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "maintenance",
      reason: D1_DR_FREEZE_MAINTENANCE_MODE,
      sentinel: false
    });
    expect(expirePendingReservations).not.toHaveBeenCalled();
    expect(mockEnv.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it("marks the documented sentinel path in the maintenance response body", async () => {
    const { ctx } = createMockCtx();
    const response = await workerHandlers.fetch(
      new Request(`https://reserve.example.invalid${D1_DR_FREEZE_SENTINEL_PATH}`),
      { ...mockEnv, MAINTENANCE_MODE: D1_DR_FREEZE_MAINTENANCE_MODE },
      ctx
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "maintenance",
      reason: D1_DR_FREEZE_MAINTENANCE_MODE,
      sentinel: true
    });
  });
});

describe("surfaceMaintenanceCronRejections (D1 export-lock / transient soft-skip)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const rejected = (reason: unknown): PromiseSettledResult<unknown> => ({
    status: "rejected",
    reason
  });
  const fulfilled = (): PromiseSettledResult<unknown> => ({
    status: "fulfilled",
    value: undefined
  });
  const exportLockError = () =>
    new Error("D1_ERROR: Currently processing a long-running export.");
  const networkLostError = () => new Error("D1_ERROR: Network connection lost.");

  it("does NOT throw or capture when every rejection is a D1 export-lock", () => {
    expect(() =>
      surfaceMaintenanceCronRejections(
        [fulfilled(), rejected(exportLockError()), rejected(exportLockError())],
        "*/10 * * * *"
      )
    ).not.toThrow();
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "maintenance_cron_d1_export_locked",
      expect.objectContaining({ event: "d1_export_locked", subtasks: 2 })
    );
  });

  it("does NOT throw or capture Network connection lost; warns as transient_d1 with message", () => {
    const networkLost = networkLostError();
    expect(() =>
      surfaceMaintenanceCronRejections(
        [fulfilled(), rejected(networkLost)],
        "*/10 * * * *"
      )
    ).not.toThrow();
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "maintenance_cron_transient_d1",
      expect.objectContaining({
        event: "transient_d1",
        subtasks: 1,
        reasons: expect.arrayContaining([networkLost.message])
      })
    );
  });

  it("does NOT throw when every rejection is retryable D1 (mixed export-lock + transient)", () => {
    expect(() =>
      surfaceMaintenanceCronRejections(
        [rejected(exportLockError()), rejected(networkLostError())],
        "*/10 * * * *"
      )
    ).not.toThrow();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("warns export-lock and transient_d1 separately when both appear in one batch", () => {
    const networkLost = networkLostError();
    expect(() =>
      surfaceMaintenanceCronRejections(
        [rejected(exportLockError()), rejected(networkLost)],
        "*/10 * * * *"
      )
    ).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      "maintenance_cron_d1_export_locked",
      expect.objectContaining({ event: "d1_export_locked", subtasks: 1 })
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "maintenance_cron_transient_d1",
      expect.objectContaining({
        event: "transient_d1",
        subtasks: 1,
        reasons: expect.arrayContaining([networkLost.message])
      })
    );
  });

  it("throws the GENUINE reason (skipping the export-lock) on a mixed batch", () => {
    const genuine = new Error("genuine subtask failure");
    expect(() =>
      surfaceMaintenanceCronRejections(
        [rejected(exportLockError()), rejected(genuine)],
        "*/10 * * * *"
      )
    ).toThrow(genuine);
    // A single genuine failure is rethrown (primary surfaces upward), not captured.
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("throws genuine[0] and captures the remaining genuine failures (export-lock excluded)", () => {
    const first = new Error("first genuine");
    const second = new Error("second genuine");
    expect(() =>
      surfaceMaintenanceCronRejections(
        [rejected(first), rejected(exportLockError()), rejected(second)],
        "*/10 * * * *"
      )
    ).toThrow(first);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(second, expect.anything());
  });

  it("throws write_failed and captures secondary genuine when retryable is mixed in", () => {
    const first = new Error("write_failed");
    const second = new Error("write_failed_sibling");
    expect(() =>
      surfaceMaintenanceCronRejections(
        [rejected(first), rejected(networkLostError()), rejected(second)],
        "*/10 * * * *"
      )
    ).toThrow(first);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(second, expect.anything());
    // Transient soft-skipped, not captured as secondary.
    expect(Sentry.captureException).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Network connection lost") }),
      expect.anything()
    );
  });

  it("does not throw when there are no rejections", () => {
    expect(() =>
      surfaceMaintenanceCronRejections([fulfilled(), fulfilled()], "*/10 * * * *")
    ).not.toThrow();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  // Generic "Network connection lost" (no D1_ERROR) can come from Google/LINE
  // outbound fetches — must not soft-skip as transient_d1.
  it("throws Network connection lost without D1_ERROR prefix (not soft-skipped)", () => {
    const genericNetwork = new Error("Network connection lost");
    expect(() =>
      surfaceMaintenanceCronRejections(
        [fulfilled(), rejected(genericNetwork)],
        "*/10 * * * *"
      )
    ).toThrow(genericNetwork);
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalledWith(
      "maintenance_cron_transient_d1",
      expect.anything()
    );
  });

  it("captures secondary non-D1_ERROR failures when multiple genuine rejections", () => {
    const first = new Error("Network connection lost");
    const second = new Error("Network connection lost");
    expect(() =>
      surfaceMaintenanceCronRejections(
        [rejected(first), rejected(second)],
        "*/10 * * * *"
      )
    ).toThrow(first);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(second, expect.anything());
  });

  it("captures secondary plain { message } failures with their real message", () => {
    const first = new Error("first genuine failure");
    const second = { message: "second genuine failure" };
    expect(() =>
      surfaceMaintenanceCronRejections(
        [rejected(first), rejected(second)],
        "*/10 * * * *"
      )
    ).toThrow(first);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: second.message }),
      expect.anything()
    );
  });

  // Export lock is unique enough to soft-skip without D1_ERROR. Rethrows often
  // strip the client prefix; plain { message } objects arrive the same way.
  it("soft-skips export lock Error without D1_ERROR prefix as d1_export_locked", () => {
    const bareExportLock = new Error("Currently processing a long-running export");
    expect(() =>
      surfaceMaintenanceCronRejections(
        [fulfilled(), rejected(bareExportLock)],
        "*/10 * * * *"
      )
    ).not.toThrow();
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "maintenance_cron_d1_export_locked",
      expect.objectContaining({ event: "d1_export_locked", subtasks: 1 })
    );
  });

  // Same plain-object shape, retryable-but-generic message: the D1_ERROR marker
  // is only reachable through readErrorMessage, not String(reason).
  it("soft-skips plain { message } D1_ERROR transient object as transient_d1", () => {
    const plainObject = { message: "D1_ERROR: Network connection lost." };
    expect(() =>
      surfaceMaintenanceCronRejections(
        [fulfilled(), rejected(plainObject)],
        "*/10 * * * *"
      )
    ).not.toThrow();
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "maintenance_cron_transient_d1",
      expect.objectContaining({
        event: "transient_d1",
        subtasks: 1,
        reasons: expect.arrayContaining([plainObject.message])
      })
    );
  });

  it("soft-skips plain { message } export-lock object as d1_export_locked", () => {
    const plainObject = { message: "Currently processing a long-running export" };
    expect(() =>
      surfaceMaintenanceCronRejections(
        [fulfilled(), rejected(plainObject)],
        "*/10 * * * *"
      )
    ).not.toThrow();
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "maintenance_cron_d1_export_locked",
      expect.objectContaining({ event: "d1_export_locked", subtasks: 1 })
    );
  });
});
