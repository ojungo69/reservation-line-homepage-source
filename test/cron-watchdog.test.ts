/**
 * Tests for the cron watchdog that races task aggregation against a timer so
 * a stalled scheduled() invocation fails fast instead of being held to the
 * 15-minute wall limit.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLAIM_LOCK_TTL_MS,
  CLAIM_TASK_TIMEOUT_MS,
  CRON_WATCHDOG_MS,
  DAILY_CLEANUP_WATCHDOG_MS,
  DAILY_TASK_TIMEOUT_MS,
  MAX_SEQUENTIAL_PRELUDE_TASKS,
  PER_TASK_TIMEOUT_MS,
  PRELUDE_TASK_TIMEOUT_MS,
  runTasksWithWatchdog,
  withTaskTimeout
} from "../src/cron-watchdog";
import { LOCK_TTL_MS as LINE_LOCK_TTL_MS } from "../src/line/notifications";
import { LOCK_TTL_MS as IMPORT_LOCK_TTL_MS } from "../src/google/import-sync";
import { LOCK_TTL_MS as CALENDAR_LOCK_TTL_MS } from "../src/google/calendar-sync";

describe("runTasksWithWatchdog", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("resolves when all tasks succeed and leaves no lingering timer", async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");

    await runTasksWithWatchdog(
      [Promise.resolve(), Promise.resolve()],
      "*/10 * * * *"
    );

    expect(clearSpy).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("surfaces the first rejection reason (current semantics)", async () => {
    const boom = new Error("task_failure");
    await expect(
      runTasksWithWatchdog(
        [Promise.resolve(), Promise.reject(boom)],
        "*/10 * * * *"
      )
    ).rejects.toThrow("task_failure");
  });

  it("throws cron_watchdog_timeout when a task never settles", async () => {
    vi.useFakeTimers();
    const neverSettles = new Promise<void>(() => {});

    const pending = runTasksWithWatchdog(
      [neverSettles],
      "maintenance",
      5_000
    );
    const assertion = expect(pending).rejects.toThrow(
      "cron_watchdog_timeout:maintenance"
    );

    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it("clears the watchdog timer after a timeout fires", async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const neverSettles = new Promise<void>(() => {});

    const pending = runTasksWithWatchdog([neverSettles], "label", 1_000);
    const assertion = expect(pending).rejects.toThrow(/cron_watchdog_timeout/);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;

    expect(clearSpy).toHaveBeenCalled();
  });

  it("uses a 7-minute default under the Sentry 8-minute maxRuntime", () => {
    expect(CRON_WATCHDOG_MS).toBe(7 * 60 * 1000);
    expect(CRON_WATCHDOG_MS).toBeLessThan(8 * 60 * 1000);
  });
});

describe("withTaskTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("resolves with the task value when it settles before the timeout", async () => {
    await expect(
      withTaskTimeout("fast", Promise.resolve("ok"), 5_000)
    ).resolves.toBe("ok");
  });

  it("clears the timer on a fast resolve so no timer lingers", async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");

    await withTaskTimeout("fast", Promise.resolve(), 5_000);

    expect(clearSpy).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates the task's own rejection (not the timeout) when it fails fast", async () => {
    await expect(
      withTaskTimeout("boom", Promise.reject(new Error("task_failure")), 5_000)
    ).rejects.toThrow("task_failure");
  });

  it("rejects with cron_task_timeout:<label> naming the stalled subtask", async () => {
    vi.useFakeTimers();
    const neverSettles = new Promise<void>(() => {});

    const pending = withTaskTimeout("line_notifications", neverSettles, 90_000);
    const assertion = expect(pending).rejects.toThrow(
      "cron_task_timeout:line_notifications"
    );

    await vi.advanceTimersByTimeAsync(90_000);
    await assertion;
  });

  it("clears the timer after a timeout fires", async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const neverSettles = new Promise<void>(() => {});

    const pending = withTaskTimeout("import_jobs", neverSettles, 1_000);
    const assertion = expect(pending).rejects.toThrow(/cron_task_timeout/);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;

    expect(clearSpy).toHaveBeenCalled();
  });

  it("layers every per-task budget strictly under its OWN branch watchdog", () => {
    // The */10 maintenance tasks must fire (and name their subtask) before the
    // generic 7-minute branch watchdog.
    for (const budget of [
      PER_TASK_TIMEOUT_MS,
          CLAIM_TASK_TIMEOUT_MS
    ]) {
      expect(budget).toBeLessThan(CRON_WATCHDOG_MS);
    }
    expect(PER_TASK_TIMEOUT_MS).toBeLessThan(CLAIM_TASK_TIMEOUT_MS);
    // The dedicated daily-cleanup cron gets a larger branch budget than */10,
    // and its prune/retention task budget must fire before THAT watchdog (the
    // governing invariant for DAILY_TASK_TIMEOUT_MS — it never runs under the
    // */10 7-minute watchdog).
    expect(DAILY_CLEANUP_WATCHDOG_MS).toBeGreaterThan(CRON_WATCHDOG_MS);
    expect(DAILY_TASK_TIMEOUT_MS).toBeLessThan(DAILY_CLEANUP_WATCHDOG_MS);
  });

  it("keeps the SEQUENTIAL prelude + a claim budget under the branch watchdog (no late-claim preemption)", () => {
    // CRITICAL time-composed invariant: the prelude tasks (expire → reminder/
    // daily-ops enqueue → refresh_quota) run ONE AFTER ANOTHER before the
    // concurrent claim fan-out, so their budgets STACK. The claim fan-out must
    // still start with a FULL claim budget of watchdog headroom left — otherwise
    // a claim dispatcher would be torn down by the branch watchdog BEFORE its own
    // named cron_task_timeout fired, re-orphaning claimed jobs (duplicate send)
    // and surfacing the generic culprit. Assert the whole worst-case prelude plus
    // one claim budget stays strictly under the */10 branch watchdog.
    expect(
      MAX_SEQUENTIAL_PRELUDE_TASKS * PRELUDE_TASK_TIMEOUT_MS +
        CLAIM_TASK_TIMEOUT_MS
    ).toBeLessThan(CRON_WATCHDOG_MS);
    // Prelude tasks are light D1-only work, so their budget is well below the
    // generic per-task budget (they never perform an inline outbound send).
    expect(PRELUDE_TASK_TIMEOUT_MS).toBeLessThan(PER_TASK_TIMEOUT_MS);
  });

  it("keeps claim-based budgets strictly below the job claim lock TTL (no duplicate-on-relock)", () => {
    // CRITICAL invariant: a claim-based task's timeout must fire BEFORE its job
    // lock expires, otherwise another invocation (queue consumer / next tick)
    // could re-claim a still-in-flight job and duplicate the customer
    // notification. The three claim-based processors share the same lock TTL;
    // assert against the REAL exported values so a future lock-TTL change can't
    // silently break this.
    expect(LINE_LOCK_TTL_MS).toBe(CLAIM_LOCK_TTL_MS);
    expect(IMPORT_LOCK_TTL_MS).toBe(CLAIM_LOCK_TTL_MS);
    expect(CALENDAR_LOCK_TTL_MS).toBe(CLAIM_LOCK_TTL_MS);
    expect(CLAIM_TASK_TIMEOUT_MS).toBeLessThan(LINE_LOCK_TTL_MS);
    expect(CLAIM_TASK_TIMEOUT_MS).toBeLessThan(IMPORT_LOCK_TTL_MS);
    expect(CLAIM_TASK_TIMEOUT_MS).toBeLessThan(CALENDAR_LOCK_TTL_MS);
  });
});
