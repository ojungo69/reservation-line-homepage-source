/**
 * Cron watchdog.
 *
 * Defensive backstop for the scheduled() handler: even with outbound fetch
 * timeouts in place, any new bare `await` that can hang would re-introduce
 * the 15-minute exceededCpu zombie. This races the task aggregation against
 * a watchdog timer so a stuck invocation fails fast (≤7 min) instead of
 * being held to the wall limit by Sentry.withMonitor + ctx.waitUntil.
 *
 * The watchdog throw is caught by withSentry → Sentry monitor logs an error
 * check-in and Cloudflare logs the cron failure, turning a silent 15-minute
 * hang into an explicit, observable failure.
 */
// Kept under the Sentry monitor's maxRuntime (8 min) so the watchdog fires
// first and produces a clean error check-in rather than a maxRuntime miss.
export const CRON_WATCHDOG_MS = 7 * 60 * 1000;

// Branch-level watchdog for the dedicated daily-cleanup cron (5 16 * * *). Its
// prune/retention DELETE sweeps can legitimately run longer than the */10 hot
// path, so it gets a larger budget — still under the Cloudflare 15-minute wall
// and its Sentry monitor maxRuntime (12 min).
export const DAILY_CLEANUP_WATCHDOG_MS = 10 * 60 * 1000;

// Per-subtask labeled timeouts (see `withTaskTimeout`). Each is the per-task
// backstop for that task's only UNBOUNDED await (D1; EMAIL.send is separately
// bounded to 15s). TWO sizing rules:
//  1. A budget must EXCEED the task's legitimate worst-case runtime, or it would
//     false-kill valid in-flight work.
//  2. For CLAIM-based job processors it must also stay BELOW the job claim
//     `LOCK_TTL_MS` (5 min, identical across LINE / Google import / Google
//     calendar sync). A timeout that fired AFTER the lock expired would let
//     another invocation (queue consumer / next tick) re-claim a still-in-flight
//     job and DUPLICATE the customer notification — exactly what we are
//     preventing. `withTaskTimeout` cannot cancel the underlying work, so the
//     budget < lock invariant is what bounds the duplicate window.
// All budgets are < the */10 branch watchdog (7 min) so a genuine stall fails
// fast WITH ITS NAME (`cron_task_timeout:<label>`) before the generic timeout.
//   light (small bounded D1: expire/reminders/refresh_quota/ensure_watch/
//   enqueue/detect_conflict)                                    90s
//   claim-based (line_notifications ≤500 rate-limited jobs / import full
//                     reconcile ≤10 pages / calendar 30s base + ≤5 jobs × 40s
//                     = 230s worst case; the 40s per-job ceiling is derived in
//                     src/google/calendar-sync.ts next to the constants it
//                     depends on — change it there, not here) — one
//                     shared budget < the shared 5-min claim lock      270s
//   daily-cleanup prune/retention (capped/daily-bucketed DELETEs)   300s
// Mirrors the per-module LOCK_TTL_MS (exported and asserted in tests so a future
// lock-TTL change cannot silently break the budget < lock invariant).
export const CLAIM_LOCK_TTL_MS = 5 * 60 * 1000;
export const PER_TASK_TIMEOUT_MS = 90 * 1000;
export const CLAIM_TASK_TIMEOUT_MS = 270 * 1000;
export const DAILY_TASK_TIMEOUT_MS = 300 * 1000;

// PRELUDE budget — for the few light D1-only tasks that run SEQUENTIALLY before
// the concurrent claim fan-out on the */10 maintenance and 0 11 daily-ops
// branches (expire_reservations → reminder/daily-ops enqueue → refresh_quota).
//
// Why a SEPARATE, smaller budget instead of reusing PER_TASK_TIMEOUT_MS: the
// fan-out siblings run CONCURRENTLY (their budgets do not stack — the branch
// wall time is max(sibling budget) ≈ CLAIM_TASK_TIMEOUT_MS), but the prelude
// awaits run ONE AFTER ANOTHER, so THEIR budgets STACK ahead of the claim
// fan-out. If the prelude could consume up to 3 × PER_TASK_TIMEOUT_MS (270s),
// the claim fan-out might not start until ~270s in and a claim dispatcher
// (270s budget) would then be torn down by the 7-min branch watchdog BEFORE its
// own named `cron_task_timeout` fired — re-orphaning claimed jobs (duplicate
// customer send) and surfacing the generic culprit. The governing invariant is
// therefore TIME-COMPOSED, not per-task:
//
//   MAX_SEQUENTIAL_PRELUDE_TASKS * PRELUDE_TASK_TIMEOUT_MS
//     + CLAIM_TASK_TIMEOUT_MS  <  CRON_WATCHDOG_MS
//   (3 * 40s) + 270s = 390s  <  420s   (30s margin; asserted in tests)
//
// 40s is far above each prelude task's legitimate PER-TICK worst case — every
// one is BOUNDED per tick and none performs an inline outbound send:
//   - expire_reservations: a SINGLE non-draining batch (≤200 rows; the cron call
//     passes drain:false so it never loops over an unbounded backlog — overflow
//     drains over later ticks and the on-read request path),
//   - reminder/daily-ops enqueue: ≤500 capped INSERT OR IGNORE rows,
//   - refresh_quota: one AbortSignal-capped (≤5s) fetch.
// So the 40s budget never false-kills valid work, while still guaranteeing the
// claim fan-out starts with a full claim budget of watchdog headroom left. (If a
// prelude task were ever made unbounded again, that would break this contract —
// keep cron-prelude work bounded per tick.)
export const PRELUDE_TASK_TIMEOUT_MS = 40 * 1000;
export const MAX_SEQUENTIAL_PRELUDE_TASKS = 3;

/**
 * Race a single cron subtask against a labeled timeout. A stall rejects with
 * `cron_task_timeout:<label>` so the surfaced error NAMES the culprit subtask,
 * instead of every hang collapsing into the generic branch-level
 * `cron_watchdog_timeout`. Modeled on `runTasksWithWatchdog` and
 * `acquireWithTimeout` (line/notifications.ts): the timer is always cleared in
 * `finally` so a fast subtask leaves no timer tail, and a fired timeout does
 * NOT cancel the underlying work (Workers has no cancellation) — it just stops
 * the aggregate from waiting on it.
 *
 * This complements (does not replace) `runTasksWithWatchdog`, which still
 * guards code paths outside the labeled subtasks.
 */
export const withTaskTimeout = async <T>(
  label: string,
  task: Promise<T>,
  timeoutMs: number
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`cron_task_timeout:${label}`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Await `Promise.allSettled(tasks)` but fail fast if the aggregate does not
 * settle within `timeoutMs`. Preserves the caller's "surface the first
 * rejection" semantics so Cloudflare still logs the underlying cron failure.
 *
 * On normal completion the watchdog timer is cleared in `finally` so it
 * never extends the invocation.
 */
export const runTasksWithWatchdog = async (
  tasks: Promise<void>[],
  label: string,
  timeoutMs: number = CRON_WATCHDOG_MS
): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`cron_watchdog_timeout:${label}`));
    }, timeoutMs);
  });
  try {
    const results = await Promise.race([Promise.allSettled(tasks), watchdog]);
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected"
    );
    if (rejected.length > 0) {
      // Surface the first rejection so Cloudflare logs the cron failure.
      throw rejected[0].reason;
    }
  } finally {
    clearTimeout(timer);
  }
};
