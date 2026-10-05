import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Sentry capture helper so the DO RPC timeout test can assert the
// `rpc_timeout` tag without a live Sentry client. Default impl is a no-op
// spy, leaving the other fail-closed tests unaffected.
vi.mock("../src/sentry-helpers", () => ({
  safeCaptureException: vi.fn()
}));

import {
  acquireLineRateBudget,
  processDueLineNotificationJobs
} from "../src/line/notifications";
import { BUCKET_CAPACITY, RATE_PER_MS } from "../src/line/rate-limiter-do";
import { safeCaptureException } from "../src/sentry-helpers";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

// ── Constants ───────────────────────────────────────────────────────
const NOW_MS = Date.parse("2026-09-01T00:00:00.000Z");
const NOW_ISO = "2026-09-01T00:00:00.000Z";
const CUSTOMER_LINE_USER_ID = "U" + "c".repeat(32);

// ── Mock DO stub ────────────────────────────────────────────────────
// Simulates the LineRateLimiter DO with a simple in-memory token bucket
// so we can test the dispatcher integration deterministically.

function createMockRateLimiterNamespace(opts?: {
  capacity?: number;
  ratePerMs?: number;
}) {
  const capacity = opts?.capacity ?? BUCKET_CAPACITY;
  const ratePerMs = opts?.ratePerMs ?? RATE_PER_MS;
  let tokens = capacity;
  let lastRefillMs = NOW_MS;

  const stub = {
    acquire: vi.fn(async (count: number) => {
      const nowMs = Date.now();
      const elapsed = nowMs - lastRefillMs;
      if (elapsed > 0) {
        const refill = Math.floor(elapsed * ratePerMs);
        if (refill > 0) {
          tokens = Math.min(tokens + refill, capacity);
          lastRefillMs = nowMs;
        }
      }

      if (tokens >= count) {
        tokens -= count;
        lastRefillMs = nowMs;
        return { ok: true as const };
      }

      const deficit = count - tokens;
      return {
        ok: false as const,
        retryAfterMs: Math.ceil(deficit / ratePerMs)
      };
    }),
    // Expose for assertions.
    _getTokens: () => tokens,
    _reset: () => {
      tokens = capacity;
      lastRefillMs = NOW_MS;
    }
  };

  const namespace = {
    idFromName: vi.fn((_name: string) => ({ id: "singleton" })),
    get: vi.fn((_id: unknown) => stub)
  };

  return { namespace, stub };
}

// ── Test data seeders ───────────────────────────────────────────────
const seedBaseData = (d1: SqliteD1Database) => {
  d1.sqlite
    .prepare("INSERT INTO stores (id, name, timezone) VALUES (?, ?, ?)")
    .run("store_rl", "Rate Limit Salon", "Asia/Tokyo");
  d1.sqlite
    .prepare("INSERT INTO store_resources (id, store_id, name) VALUES (?, ?, ?)")
    .run("resource_rl", "store_rl", "Room A");
  d1.sqlite
    .prepare("INSERT INTO services (id, store_id, name, duration_minutes) VALUES (?, ?, ?, ?)")
    .run("svc_rl", "store_rl", "Cut", 60);
  d1.sqlite
    .prepare("INSERT INTO customers (id, display_name, phone_normalized, phone_hash) VALUES (?, ?, ?, ?)")
    .run("customer_rl", "レート 太郎", "070000333", "ph_rl");
  d1.sqlite
    .prepare(
      "INSERT INTO line_identities (id, customer_id, provider, channel_id, line_user_id) VALUES (?, ?, ?, ?, ?)"
    )
    .run("identity_rl", "customer_rl", "line", "ch_rl", CUSTOMER_LINE_USER_ID);
};

const seedReservationAndJob = (d1: SqliteD1Database, index: number) => {
  const reservationId = `res_rl_${index}`;
  const jobId = `job_rl_${index}`;
  const idemKey = `idem_rl_${index}`;
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
      "store_rl",
      "svc_rl",
      "customer_rl",
      "resource_rl",
      "identity_rl",
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
    .run(jobId, dedupeKey, CUSTOMER_LINE_USER_ID, reservationId, "queued", NOW_ISO, NOW_ISO);

  return { reservationId, jobId };
};

const makeSuccessFetcher = () =>
  vi.fn(async () =>
    Response.json({ sentMessages: [{ id: "msg_ok" }] })
  ) as unknown as typeof fetch;

// ── Tests ───────────────────────────────────────────────────────────

describe("acquireLineRateBudget", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true when DO binding is absent (graceful degradation)", async () => {
    const env = { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token" };
    const result = await acquireLineRateBudget(env, 5);
    expect(result).toBe(true);
  });

  it("returns true when count is 0", async () => {
    const { namespace } = createMockRateLimiterNamespace();
    const env = {
      LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token",
      LINE_RATE_LIMITER: namespace as unknown as DurableObjectNamespace<import("../src/line/rate-limiter-do").LineRateLimiter>
    };
    const result = await acquireLineRateBudget(env, 0);
    expect(result).toBe(true);
    // Should not have called the DO.
    expect(namespace.idFromName).not.toHaveBeenCalled();
  });

  it("acquires tokens successfully on first attempt", async () => {
    const { namespace, stub } = createMockRateLimiterNamespace();
    const env = {
      LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token",
      LINE_RATE_LIMITER: namespace as unknown as DurableObjectNamespace<import("../src/line/rate-limiter-do").LineRateLimiter>
    };
    vi.spyOn(Date, "now").mockReturnValue(NOW_MS);

    const result = await acquireLineRateBudget(env, 5);
    expect(result).toBe(true);
    expect(stub.acquire).toHaveBeenCalledWith(5);
  });

  it("retries when bucket is temporarily empty and succeeds after refill", async () => {
    // Drain a capacity=5 bucket first, then immediately request 5 more.
    // The second acquire fails (tokens=0 < 5), forces sleep, and the
    // mock's refill across the synthetic sleep restores enough tokens.
    const { namespace, stub } = createMockRateLimiterNamespace({ capacity: 5 });
    const env = {
      LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token",
      LINE_RATE_LIMITER: namespace as unknown as DurableObjectNamespace<import("../src/line/rate-limiter-do").LineRateLimiter>
    };

    let currentTime = NOW_MS;
    vi.spyOn(Date, "now").mockImplementation(() => currentTime);

    // Drain the bucket to 0 first.
    await acquireLineRateBudget(env, 5);
    const callsAfterDrain = stub.acquire.mock.calls.length;

    const sleepMock = vi.fn(async (ms: number) => {
      // Advance time by the sleep duration to simulate refill.
      currentTime += ms;
    });

    const result = await acquireLineRateBudget(env, 5, sleepMock);
    expect(result).toBe(true);
    // After drain: first call denies (tokens=0), sleep, second call eventually succeeds.
    expect(stub.acquire.mock.calls.length).toBeGreaterThan(callsAfterDrain + 1);
    expect(sleepMock).toHaveBeenCalled();
  });

  it("returns false when budget is exhausted after all retries", async () => {
    // Create a bucket with capacity=2 and request 100 tokens. Even after
    // retries (which advance time), the bucket can never satisfy 100 in one
    // acquire call because the mock does not accumulate enough refill.
    const { namespace } = createMockRateLimiterNamespace({ capacity: 2 });
    const env = {
      LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token",
      LINE_RATE_LIMITER: namespace as unknown as DurableObjectNamespace<import("../src/line/rate-limiter-do").LineRateLimiter>
    };

    let currentTime = NOW_MS;
    vi.spyOn(Date, "now").mockImplementation(() => currentTime);

    const sleepMock = vi.fn(async (ms: number) => {
      // Only advance a tiny amount -- not enough to refill 100 tokens.
      currentTime += Math.min(ms, 10);
    });

    const result = await acquireLineRateBudget(env, 100, sleepMock);
    expect(result).toBe(false);
  });

  it("fails closed when DO stub throws (binding present, RPC unhealthy)", async () => {
    // When LINE_RATE_LIMITER is bound but the DO call throws, we must NOT
    // silently bypass the limiter — that would let scheduled+queue
    // handlers exceed the shared 2000 req/min budget. Caller breaks the
    // chunk loop and retries on the next invocation.
    const namespace = {
      idFromName: vi.fn(() => ({ id: "singleton" })),
      get: vi.fn(() => ({
        acquire: vi.fn(async () => {
          throw new Error("DO unavailable");
        })
      }))
    };
    const env = {
      LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token",
      LINE_RATE_LIMITER: namespace as unknown as DurableObjectNamespace<import("../src/line/rate-limiter-do").LineRateLimiter>
    };

    const result = await acquireLineRateBudget(env, 5);
    expect(result).toBe(false);
  });

  it("passes through when binding is absent (explicit bypass for tests/local)", async () => {
    // Binding-absence is a deploy-time signal (not configured yet), distinct
    // from runtime failure. Bypass is safe here because no production
    // environment ships without LINE_RATE_LIMITER bound.
    const env = { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token" };
    const result = await acquireLineRateBudget(env, 5);
    expect(result).toBe(true);
  });

  it("fails closed and tags rpc_timeout when the DO acquire RPC hangs", async () => {
    // A DO acquire() that never resolves would stall the dispatcher just like
    // a bare fetch. The 10s RPC race must fire, fail closed (return false),
    // and capture with the `rpc_timeout` tag.
    vi.useFakeTimers();
    vi.mocked(safeCaptureException).mockClear();

    const hangingStub = {
      acquire: vi.fn(() => new Promise<never>(() => {}))
    };
    const namespace = {
      idFromName: vi.fn(() => ({ id: "singleton" })),
      get: vi.fn(() => hangingStub)
    };
    const env = {
      LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token",
      LINE_RATE_LIMITER: namespace as unknown as DurableObjectNamespace<import("../src/line/rate-limiter-do").LineRateLimiter>
    };

    const pending = acquireLineRateBudget(env, 5);
    // Advance past the 10s RPC timeout so the race rejects.
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    expect(result).toBe(false);
    expect(safeCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({
          component: "line_rate_limiter_do",
          action: "rpc_timeout"
        })
      })
    );

    vi.useRealTimers();
  });
});

describe("processDueLineNotificationJobs with rate limiter DO", () => {
  let d1: SqliteD1Database;

  beforeEach(() => {
    d1 = createMigratedSqliteD1();
    seedBaseData(d1);
  });

  afterEach(() => {
    d1.sqlite.close();
    vi.restoreAllMocks();
  });

  it("calls rate limiter before each chunk dispatch", async () => {
    // Seed 10 jobs (2 full chunks of 5).
    for (let i = 0; i < 10; i += 1) {
      seedReservationAndJob(d1, i);
    }
    const fetchMock = makeSuccessFetcher();
    const { namespace, stub } = createMockRateLimiterNamespace();

    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: {
        LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token",
        LINE_RATE_LIMITER: namespace as unknown as DurableObjectNamespace<import("../src/line/rate-limiter-do").LineRateLimiter>
      },
      fetcher: fetchMock,
      now: () => NOW_MS,
      maxJobs: 10,
      _sleep: async () => {}
    });

    expect(result).toEqual({ processed: 10, succeeded: 10, failed: 0 });
    // Rate limiter should have been called once per chunk (2 chunks).
    expect(stub.acquire).toHaveBeenCalledTimes(2);
    // Each call should request the chunk size (5).
    expect(stub.acquire).toHaveBeenCalledWith(5);
  });

  it("stops dispatch when rate budget is exhausted AND rolls back attempts", async () => {
    // Seed 10 jobs.
    for (let i = 0; i < 10; i += 1) {
      seedReservationAndJob(d1, i);
    }
    const fetchMock = makeSuccessFetcher();

    // Create a namespace that always returns ok:false.
    const alwaysDeniedStub = {
      acquire: vi.fn(async (_count: number) => ({
        ok: false as const,
        retryAfterMs: 100
      }))
    };
    const namespace = {
      idFromName: vi.fn(() => ({ id: "singleton" })),
      get: vi.fn(() => alwaysDeniedStub)
    };

    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: {
        LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token",
        LINE_RATE_LIMITER: namespace as unknown as DurableObjectNamespace<import("../src/line/rate-limiter-do").LineRateLimiter>
      },
      fetcher: fetchMock,
      now: () => NOW_MS,
      maxJobs: 10,
      _sleep: async () => {}
    });

    // First chunk was claimed but rate-limiter denied → rollback.
    expect(result.processed).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();

    // Every job should be back in 'queued' with attempts=0 (rolled back).
    const remaining = d1.sqlite
      .prepare(
        "SELECT id, status, attempts, locked_until FROM notification_jobs ORDER BY id"
      )
      .all() as Array<{
        id: string;
        status: string;
        attempts: number;
        locked_until: string | null;
      }>;
    expect(remaining).toHaveLength(10);
    for (const row of remaining) {
      expect(row.status).toBe("queued");
      expect(row.attempts).toBe(0);
      expect(row.locked_until).toBeNull();
    }
  });

  it("keeps every owner job out of the LINE budget and delivers it when exhausted", async () => {
    // reservation_new_customer is now email-only too, so it must neither take a
    // token nor be held hostage by the LINE limiter.
    for (let i = 0; i < 2; i += 1) {
      seedReservationAndJob(d1, i);
    }
    // Its own reservation, still awaiting approval — the owner alert is only
    // eligible while the reservation is pending.
    d1.sqlite
      .prepare(
        `INSERT INTO reservations (
           id, store_id, service_id, customer_id, resource_id, line_identity_id,
           source, status, start_at, end_at, duration_minutes, idempotency_key, version
         ) VALUES (?, 'store_rl', 'svc_rl', 'customer_rl', 'resource_rl', 'identity_rl',
                   'admin', 'pending_approval', ?, ?, 60, ?, 1)`
      )
      .run("res_rl_email", "2026-09-11T03:00:00.000Z", "2026-09-11T04:00:00.000Z", "idem_rl_email");
    d1.sqlite
      .prepare(
        `INSERT INTO notification_jobs (
           id, dedupe_key, template_key, recipient_type, recipient_id,
           reservation_id, status, attempts, available_at, updated_at
         ) VALUES (?, ?, 'reservation_new_customer', 'owner', ?, ?, 'queued', 0, ?, ?)`
      )
      .run(
        "job_rl_email",
        "reservation:res_rl_email:template:reservation_new_customer:recipient:email",
        "email:owner",
        "res_rl_email",
        NOW_ISO,
        NOW_ISO
      );

    const fetchMock = makeSuccessFetcher();
    const emailSend = vi.fn(async () => ({ messageId: "email_rl" }));
    const alwaysDeniedStub = {
      acquire: vi.fn(async (_count: number) => ({ ok: false as const, retryAfterMs: 100 }))
    };
    const namespace = { idFromName: vi.fn(() => ({ id: "singleton" })), get: vi.fn(() => alwaysDeniedStub) };

    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: {
        LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token",
        PENDING_APPROVAL_OWNER_EMAIL: "owner@example.com",
        EMAIL: { send: emailSend } as unknown as SendEmail,
        LINE_RATE_LIMITER: namespace as unknown as DurableObjectNamespace<import("../src/line/rate-limiter-do").LineRateLimiter>
      },
      fetcher: fetchMock,
      now: () => NOW_MS,
      maxJobs: 10,
      _sleep: async () => {}
    });

    // Tokens requested for the two LINE jobs only, not the email one.
    expect(alwaysDeniedStub.acquire).toHaveBeenCalledWith(2);
    // The email went out even though the LINE budget was denied.
    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    expect(emailSend).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();

    const rows = d1.sqlite
      .prepare("SELECT id, status, attempts FROM notification_jobs ORDER BY id")
      .all() as Array<{ id: string; status: string; attempts: number }>;
    expect(rows.find((row) => row.id === "job_rl_email")).toMatchObject({ status: "succeeded" });
    // The LINE jobs were rolled back untouched and stay claimable next sweep.
    for (const row of rows.filter((r) => r.id !== "job_rl_email")) {
      expect(row).toMatchObject({ status: "queued", attempts: 0 });
    }
  });

  it("rolls back attempts when DO RPC fails (fail-closed)", async () => {
    for (let i = 0; i < 5; i += 1) {
      seedReservationAndJob(d1, i);
    }
    const fetchMock = makeSuccessFetcher();

    const throwingStub = {
      acquire: vi.fn(async () => {
        throw new Error("DO unavailable");
      })
    };
    const namespace = {
      idFromName: vi.fn(() => ({ id: "singleton" })),
      get: vi.fn(() => throwingStub)
    };

    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: {
        LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token",
        LINE_RATE_LIMITER: namespace as unknown as DurableObjectNamespace<import("../src/line/rate-limiter-do").LineRateLimiter>
      },
      fetcher: fetchMock,
      now: () => NOW_MS,
      maxJobs: 5,
      _sleep: async () => {}
    });

    expect(result.processed).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();

    const remaining = d1.sqlite
      .prepare("SELECT status, attempts FROM notification_jobs")
      .all() as Array<{ status: string; attempts: number }>;
    for (const row of remaining) {
      expect(row.status).toBe("queued");
      expect(row.attempts).toBe(0);
    }
  });

  it("works without DO binding (backward compatible)", async () => {
    // Seed 5 jobs.
    for (let i = 0; i < 5; i += 1) {
      seedReservationAndJob(d1, i);
    }
    const fetchMock = makeSuccessFetcher();

    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token" },
      fetcher: fetchMock,
      now: () => NOW_MS,
      maxJobs: 5,
      _sleep: async () => {}
    });

    // All jobs should process without the rate limiter.
    expect(result).toEqual({ processed: 5, succeeded: 5, failed: 0 });
    expect(vi.mocked(fetchMock).mock.calls).toHaveLength(5);
  });

  it("two concurrent dispatchers share a single bucket — combined dispatch bounded by capacity (no refill)", async () => {
    // Deterministic cross-handler invariant: two dispatchers run via
    // Promise.all on independent D1 instances + separate fetch mocks but
    // a SHARED rate-limiter namespace. With ratePerMs=0 (no refill) the
    // bucket can serve at most `capacity` LINE sends in total before
    // both handlers hit fail-closed denial and roll back. If the limiter
    // were per-handler (or always granted), combined sends would equal
    // 20 (each handler's full job count) — the test would fail.

    const d1_a = createMigratedSqliteD1();
    seedBaseData(d1_a);
    const d1_b = createMigratedSqliteD1();
    seedBaseData(d1_b);

    for (let i = 0; i < 10; i += 1) {
      seedReservationAndJob(d1_a, i);
      seedReservationAndJob(d1_b, 100 + i);
    }

    const fetchMock_a = makeSuccessFetcher();
    const fetchMock_b = makeSuccessFetcher();

    // No refill: ratePerMs=0 freezes the bucket at its initial 10 tokens.
    const { namespace } = createMockRateLimiterNamespace({ capacity: 10, ratePerMs: 0 });

    const [resultA, resultB] = await Promise.all([
      processDueLineNotificationJobs({
        db: d1_a as unknown as D1Database,
        env: {
          LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token",
          LINE_RATE_LIMITER: namespace as unknown as DurableObjectNamespace<import("../src/line/rate-limiter-do").LineRateLimiter>
        },
        fetcher: fetchMock_a,
        now: () => NOW_MS,
        maxJobs: 10,
        _sleep: async () => {}
      }),
      processDueLineNotificationJobs({
        db: d1_b as unknown as D1Database,
        env: {
          LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token",
          LINE_RATE_LIMITER: namespace as unknown as DurableObjectNamespace<import("../src/line/rate-limiter-do").LineRateLimiter>
        },
        fetcher: fetchMock_b,
        now: () => NOW_MS,
        maxJobs: 10,
        _sleep: async () => {}
      })
    ]);

    const combinedSucceeded = resultA.succeeded + resultB.succeeded;
    // Hard upper bound: shared bucket of 10 tokens, no refill → combined
    // sends MUST be ≤ 10. If both handlers had independent buckets, this
    // would be 20.
    expect(combinedSucceeded).toBeLessThanOrEqual(10);
    expect(combinedSucceeded).toBeGreaterThan(0);

    // Combined LINE provider sends also bounded — counted across both fetch mocks.
    const combinedFetchCalls =
      vi.mocked(fetchMock_a).mock.calls.length + vi.mocked(fetchMock_b).mock.calls.length;
    expect(combinedFetchCalls).toBeLessThanOrEqual(10);

    d1_a.sqlite.close();
    d1_b.sqlite.close();
  });
});
