import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CHUNK_THROTTLE_FLOOR_MS,
  PARALLEL_CHUNK_SIZE,
  processDueLineNotificationJobs
} from "../src/line/notifications";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const NOW_MS = Date.parse("2026-09-01T00:00:00.000Z");
const NOW_ISO = "2026-09-01T00:00:00.000Z";

const CUSTOMER_LINE_USER_ID = "U" + "c".repeat(32);

/**
 * Seeds the prerequisite reference rows (store, resource, service, customer,
 * line_identity) that notification_jobs rows reference via reservation_id.
 */
const seedBaseData = (d1: SqliteD1Database) => {
  d1.sqlite
    .prepare("INSERT INTO stores (id, name, timezone) VALUES (?, ?, ?)")
    .run("store_par", "Parallel Salon", "Asia/Tokyo");
  d1.sqlite
    .prepare("INSERT INTO store_resources (id, store_id, name) VALUES (?, ?, ?)")
    .run("resource_par", "store_par", "Room A");
  d1.sqlite
    .prepare("INSERT INTO services (id, store_id, name, duration_minutes) VALUES (?, ?, ?, ?)")
    .run("svc_par", "store_par", "Cut", 60);
  d1.sqlite
    .prepare("INSERT INTO customers (id, display_name, phone_normalized, phone_hash) VALUES (?, ?, ?, ?)")
    .run("customer_par", "並列 太郎", "070000222", "ph_par");
  d1.sqlite
    .prepare(
      "INSERT INTO line_identities (id, customer_id, provider, channel_id, line_user_id) VALUES (?, ?, ?, ?, ?)"
    )
    .run("identity_par", "customer_par", "line", "ch_par", CUSTOMER_LINE_USER_ID);
};

/**
 * Seeds a reservation and a queued notification job for it. Each call produces
 * a unique reservation + job pair. The job's available_at is set to NOW_ISO so
 * it is immediately eligible for dispatch.
 */
const seedReservationAndJob = (
  d1: SqliteD1Database,
  index: number,
  overrides?: { status?: string }
) => {
  const reservationId = `res_par_${index}`;
  const jobId = `job_par_${index}`;
  const idemKey = `idem_par_${index}`;
  const dedupeKey = `confirm:${reservationId}:template:reservation_confirmed:recipient:${CUSTOMER_LINE_USER_ID}`;

  d1.sqlite
    .prepare(
      `INSERT INTO reservations (
         id, store_id, service_id, customer_id, resource_id, line_identity_id,
         source, status, start_at, end_at, duration_minutes, idempotency_key, version
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      reservationId,
      "store_par",
      "svc_par",
      "customer_par",
      "resource_par",
      "identity_par",
      // 'admin' (not 'web_line') so the many fixtures for one customer are exempt from
      // the per-customer web-booking cap trigger; source is irrelevant to dispatch.
      "admin",
      "confirmed",
      "2026-09-10T03:00:00.000Z",
      "2026-09-10T04:00:00.000Z",
      60,
      idemKey,
      1
    );

  d1.sqlite
    .prepare(
      `INSERT INTO notification_jobs (
         id, dedupe_key, template_key, recipient_type, recipient_id,
         reservation_id, status, attempts, available_at, updated_at
       ) VALUES (?, ?, 'reservation_confirmed', 'customer', ?, ?, ?, 0, ?, ?)`
    )
    .run(
      jobId,
      dedupeKey,
      CUSTOMER_LINE_USER_ID,
      reservationId,
      overrides?.status ?? "queued",
      NOW_ISO,
      NOW_ISO
    );

  return { reservationId, jobId };
};

const makeSuccessFetcher = () =>
  vi.fn(async () =>
    Response.json({ sentMessages: [{ id: "msg_ok" }] })
  ) as unknown as typeof fetch;

const makeFailFetcher = () =>
  vi.fn(async () => new Response("Unauthorized", { status: 401 })) as unknown as typeof fetch;

/**
 * Creates a fetcher that succeeds for the first `succeedCount` calls and
 * fails for the rest.
 */
const makeMixedFetcher = (succeedCount: number) => {
  let callCount = 0;
  return vi.fn(async () => {
    callCount += 1;
    if (callCount <= succeedCount) {
      return Response.json({ sentMessages: [{ id: `msg_ok_${callCount}` }] });
    }
    return new Response("Rate limited", { status: 429 });
  }) as unknown as typeof fetch;
};

describe("LINE notification parallel dispatch", () => {
  let d1: SqliteD1Database;

  beforeEach(() => {
    d1 = createMigratedSqliteD1();
    seedBaseData(d1);
  });

  afterEach(() => {
    d1.sqlite.close();
  });

  it("dispatches 10 jobs across multiple chunks, all succeeding", async () => {
    for (let i = 0; i < 10; i += 1) {
      seedReservationAndJob(d1, i);
    }
    const fetchMock = makeSuccessFetcher();

    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token" },
      fetcher: fetchMock,
      now: () => NOW_MS,
      maxJobs: 10,
      _sleep: async () => {}
    });

    expect(result).toEqual({ processed: 10, succeeded: 10, failed: 0 });
    expect(vi.mocked(fetchMock).mock.calls).toHaveLength(10);

    // Verify all jobs reached 'succeeded' in the DB
    const jobs = d1.sqlite
      .prepare("SELECT status FROM notification_jobs ORDER BY id")
      .all() as Array<{ status: string }>;
    expect(jobs.every((j) => j.status === "succeeded")).toBe(true);
  });

  it("handles mixed success/failure within the same chunk", async () => {
    for (let i = 0; i < 5; i += 1) {
      seedReservationAndJob(d1, i);
    }
    // First 3 succeed, last 2 fail
    const fetchMock = makeMixedFetcher(3);

    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token" },
      fetcher: fetchMock,
      now: () => NOW_MS,
      maxJobs: 5,
      _sleep: async () => {}
    });

    expect(result.processed).toBe(5);
    expect(result.succeeded).toBe(3);
    expect(result.failed).toBe(2);
  });

  it("handles all-fail chunk without aborting", async () => {
    for (let i = 0; i < 5; i += 1) {
      seedReservationAndJob(d1, i);
    }
    const fetchMock = makeFailFetcher();

    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token" },
      fetcher: fetchMock,
      now: () => NOW_MS,
      maxJobs: 5,
      _sleep: async () => {}
    });

    expect(result.processed).toBe(5);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(5);
  });

  it("handles chunk boundary: last chunk smaller than PARALLEL_CHUNK_SIZE", async () => {
    // 7 jobs with chunk size 5 → chunk 1 = 5 jobs, chunk 2 = 2 jobs
    for (let i = 0; i < 7; i += 1) {
      seedReservationAndJob(d1, i);
    }
    const fetchMock = makeSuccessFetcher();

    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token" },
      fetcher: fetchMock,
      now: () => NOW_MS,
      maxJobs: 7,
      _sleep: async () => {}
    });

    expect(result).toEqual({ processed: 7, succeeded: 7, failed: 0 });
    expect(vi.mocked(fetchMock).mock.calls).toHaveLength(7);
  });

  it("throttles after every chunk when more jobs might remain in the queue", async () => {
    // Two chunks of jobs, both fully claimed via maxJobs. The trailing
    // throttle must run after BOTH chunks because the DB has not been
    // observed as exhausted — additional invocations may still pull
    // queued jobs immediately.
    const jobCount = PARALLEL_CHUNK_SIZE + 2;
    for (let i = 0; i < jobCount; i += 1) {
      seedReservationAndJob(d1, i);
    }
    const fetchMock = makeSuccessFetcher();
    const sleepMock = vi.fn(async (_ms: number) => {});

    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token" },
      fetcher: fetchMock,
      now: () => NOW_MS,
      maxJobs: jobCount,
      _sleep: sleepMock
    });

    expect(result.processed).toBe(jobCount);
    expect(result.succeeded).toBe(jobCount);

    // Both chunks throttle: addresses cross-invocation rate cap so the
    // next consumer invocation cannot start its first chunk before the
    // previous chunk's floor has elapsed.
    expect(sleepMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenCalledWith(CHUNK_THROTTLE_FLOOR_MS);
  });

  it("throttles after the only chunk when maxJobs reached but DB not observed empty", async () => {
    // Exactly one chunk worth of jobs — claimed equals maxJobs but the
    // fetcher never returned null, so exhausted stays false. The
    // trailing throttle must still run.
    for (let i = 0; i < PARALLEL_CHUNK_SIZE; i += 1) {
      seedReservationAndJob(d1, i);
    }
    const fetchMock = makeSuccessFetcher();
    const sleepMock = vi.fn(async (_ms: number) => {});

    await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token" },
      fetcher: fetchMock,
      now: () => NOW_MS,
      maxJobs: PARALLEL_CHUNK_SIZE,
      _sleep: sleepMock
    });

    expect(sleepMock).toHaveBeenCalledTimes(1);
    expect(sleepMock).toHaveBeenCalledWith(CHUNK_THROTTLE_FLOOR_MS);
  });

  it("skips throttle when the queue is observed empty (exhausted)", async () => {
    // Fewer jobs than PARALLEL_CHUNK_SIZE → the chunk fetch returns null
    // before filling, so exhausted=true and the trailing sleep is
    // skipped.
    const jobCount = 2; // < PARALLEL_CHUNK_SIZE
    for (let i = 0; i < jobCount; i += 1) {
      seedReservationAndJob(d1, i);
    }
    const fetchMock = makeSuccessFetcher();
    const sleepMock = vi.fn(async (_ms: number) => {});

    await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token" },
      fetcher: fetchMock,
      now: () => NOW_MS,
      maxJobs: PARALLEL_CHUNK_SIZE,
      _sleep: sleepMock
    });

    expect(sleepMock).not.toHaveBeenCalled();
  });

  it("does not throttle when elapsed time exceeds the budget floor", async () => {
    const jobCount = PARALLEL_CHUNK_SIZE + 1;
    for (let i = 0; i < jobCount; i += 1) {
      seedReservationAndJob(d1, i);
    }
    const fetchMock = makeSuccessFetcher();
    const sleepMock = vi.fn(async (_ms: number) => {});

    // Simulate time passing: first call at NOW_MS, then each subsequent
    // now() call advances by 200ms. By the time the chunk finishes
    // dispatching, elapsed > CHUNK_THROTTLE_FLOOR_MS (150ms), so no sleep.
    let clockMs = NOW_MS;
    const advancingNow = () => {
      const current = clockMs;
      clockMs += 200;
      return current;
    };

    await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token" },
      fetcher: fetchMock,
      now: advancingNow,
      maxJobs: jobCount,
      _sleep: sleepMock
    });

    // Elapsed always exceeds floor → sleep should never be called
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it("verifies PARALLEL_CHUNK_SIZE and CHUNK_THROTTLE_FLOOR_MS constants", () => {
    expect(PARALLEL_CHUNK_SIZE).toBe(5);
    // (5 / 2000) * 60000 = 150
    expect(CHUNK_THROTTLE_FLOOR_MS).toBe(150);
  });

  // ── Issue #130: expanded coverage for PR-α (FIFO + state-aware
  //    eligibility) and back-to-back / concurrent dispatcher behavior in
  //    the parallel test file. PR-β rate-limiter DO integration is
  //    covered by test/line-notifications-rate-cap.test.ts; these tests
  //    intentionally omit LINE_RATE_LIMITER so they exercise the pure
  //    dispatcher path without DO coordination.

  it("back-to-back invocations: second call processes the leftover queued jobs", async () => {
    // 8 jobs total. First invocation processes 5 (one full chunk). Second
    // invocation processes the remaining 3. Verifies that the dispatcher
    // can be re-invoked safely after a maxJobs ceiling — claimed rows from
    // the first call have settled into 'succeeded' state and the second
    // call picks up the leftover 'queued' rows without double-dispatch.
    const total = 8;
    for (let i = 0; i < total; i += 1) {
      seedReservationAndJob(d1, i);
    }
    const fetchMock = makeSuccessFetcher();

    const result1 = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token" },
      fetcher: fetchMock,
      now: () => NOW_MS,
      maxJobs: PARALLEL_CHUNK_SIZE,
      _sleep: async () => {}
    });
    expect(result1).toEqual({
      processed: PARALLEL_CHUNK_SIZE,
      succeeded: PARALLEL_CHUNK_SIZE,
      failed: 0
    });

    const result2 = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token" },
      fetcher: fetchMock,
      now: () => NOW_MS,
      maxJobs: PARALLEL_CHUNK_SIZE,
      _sleep: async () => {}
    });
    expect(result2.processed).toBe(total - PARALLEL_CHUNK_SIZE);
    expect(result2.succeeded).toBe(total - PARALLEL_CHUNK_SIZE);

    // All jobs succeeded across the two invocations.
    const succeededCount = (
      d1.sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM notification_jobs WHERE status = 'succeeded'"
        )
        .get() as { n: number }
    ).n;
    expect(succeededCount).toBe(total);
  });

  it("two concurrent invocations on the same D1 do not double-dispatch jobs (claim CAS guards)", async () => {
    // Without the rate-limiter DO (binding absent), two parallel dispatcher
    // invocations on the SAME D1 instance compete for the same notification_jobs
    // rows via markJobProcessing's CAS UPDATE. Each row may be claimed by exactly
    // one invocation. Verifies total LINE provider calls = job count, not 2×.
    const jobCount = 6;
    for (let i = 0; i < jobCount; i += 1) {
      seedReservationAndJob(d1, i);
    }
    const fetchA = makeSuccessFetcher();
    const fetchB = makeSuccessFetcher();

    const [resultA, resultB] = await Promise.all([
      processDueLineNotificationJobs({
        db: d1 as unknown as D1Database,
        env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token" },
        fetcher: fetchA,
        now: () => NOW_MS,
        maxJobs: jobCount,
        _sleep: async () => {}
      }),
      processDueLineNotificationJobs({
        db: d1 as unknown as D1Database,
        env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token" },
        fetcher: fetchB,
        now: () => NOW_MS,
        maxJobs: jobCount,
        _sleep: async () => {}
      })
    ]);

    // Combined succeeded count = exactly jobCount (no double-dispatch).
    expect(resultA.succeeded + resultB.succeeded).toBe(jobCount);
    expect(
      vi.mocked(fetchA).mock.calls.length + vi.mocked(fetchB).mock.calls.length
    ).toBe(jobCount);

    // Every row should reach 'succeeded' exactly once.
    const succeededCount = (
      d1.sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM notification_jobs WHERE status = 'succeeded'"
        )
        .get() as { n: number }
    ).n;
    expect(succeededCount).toBe(jobCount);

    // Every row's attempts counter must be exactly 1 — markJobProcessing's
    // CAS guard prevents both invocations from incrementing the same row.
    const attempts = d1.sqlite
      .prepare("SELECT attempts FROM notification_jobs ORDER BY id")
      .all() as Array<{ attempts: number }>;
    expect(attempts.every((row) => row.attempts === 1)).toBe(true);
  });

  it("inverted enqueue order: newer state-superseding job suppresses older retry", async () => {
    // Insert an older `reservation_confirmed` retry first (created_at =
    // 2026-08-31T23:59), then a newer `reservation_time_changed` job
    // (created_at = 2026-09-01T00:00). FIFO order would claim the older
    // confirmed retry first; per PR-α (#129) the state-aware supersedence
    // check (hasSupersedingJob) detects the newer time_changed row and
    // marks the older retry as supersede-skipped — the dispatcher must
    // never call the LINE API for it.
    const reservationId = "res_par_invert";

    d1.sqlite
      .prepare(
        `INSERT INTO reservations (
           id, store_id, service_id, customer_id, resource_id, line_identity_id,
           source, status, start_at, end_at, duration_minutes, idempotency_key, version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        reservationId,
        "store_par",
        "svc_par",
        "customer_par",
        "resource_par",
        "identity_par",
        "web_line",
        // status='confirmed' makes BOTH templates base-eligible:
        // reservation_confirmed needs status='confirmed',
        // reservation_time_changed accepts 'confirmed' or 'pending_approval'.
        // The older confirmed retry must be suppressed by supersedence,
        // not by base eligibility, for this test to exercise PR-α (#129).
        "confirmed",
        "2026-09-10T05:00:00.000Z",
        "2026-09-10T06:00:00.000Z",
        60,
        "idem_par_invert",
        2
      );

    // Older retry job: reservation_confirmed (created earlier).
    d1.sqlite
      .prepare(
        `INSERT INTO notification_jobs (
           id, dedupe_key, template_key, recipient_type, recipient_id,
           reservation_id, status, attempts, available_at, updated_at, created_at
         ) VALUES (?, ?, 'reservation_confirmed', 'customer', ?, ?, 'queued', 0, ?, ?, ?)`
      )
      .run(
        "job_invert_old_confirmed",
        `confirm:${reservationId}:template:reservation_confirmed:recipient:${CUSTOMER_LINE_USER_ID}`,
        CUSTOMER_LINE_USER_ID,
        reservationId,
        NOW_ISO,
        NOW_ISO,
        "2026-08-31T23:59:00.000Z" // older
      );

    // Newer state-transition job: reservation_time_changed (created later).
    d1.sqlite
      .prepare(
        `INSERT INTO notification_jobs (
           id, dedupe_key, template_key, recipient_type, recipient_id,
           reservation_id, status, attempts, available_at, updated_at, created_at
         ) VALUES (?, ?, 'reservation_time_changed', 'customer', ?, ?, 'queued', 0, ?, ?, ?)`
      )
      .run(
        "job_invert_new_time_changed",
        `confirm:${reservationId}:template:reservation_time_changed:recipient:${CUSTOMER_LINE_USER_ID}`,
        CUSTOMER_LINE_USER_ID,
        reservationId,
        NOW_ISO,
        NOW_ISO,
        "2026-09-01T00:00:00.000Z" // newer
      );

    const fetchMock = makeSuccessFetcher();

    await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token" },
      fetcher: fetchMock,
      now: () => NOW_MS,
      maxJobs: 10,
      _sleep: async () => {}
    });

    // Only the newer reservation_time_changed should have reached the LINE API.
    expect(vi.mocked(fetchMock).mock.calls).toHaveLength(1);

    // Verify the dispatched message text contains the time_changed lead,
    // not the confirmed lead — proves the correct template was sent
    // (the supersede-skipped older retry never reached the API).
    const fetchArgs = vi.mocked(fetchMock).mock.calls[0];
    const fetchBody = JSON.parse(
      (fetchArgs[1] as RequestInit).body as string
    ) as { messages: Array<{ text: string }> };
    expect(fetchBody.messages[0].text).toContain("予約日時が変更されました");
    expect(fetchBody.messages[0].text).not.toContain("予約が確定しました");

    // The older reservation_confirmed retry is supersede-skipped: it
    // resolves to 'succeeded' (terminal eligibility-skip), not 'failed'.
    const oldJob = d1.sqlite
      .prepare(
        "SELECT status FROM notification_jobs WHERE id = 'job_invert_old_confirmed'"
      )
      .get() as { status: string };
    expect(oldJob.status).toBe("succeeded");

    const newJob = d1.sqlite
      .prepare(
        "SELECT status FROM notification_jobs WHERE id = 'job_invert_new_time_changed'"
      )
      .get() as { status: string };
    expect(newJob.status).toBe("succeeded");
  });
});
