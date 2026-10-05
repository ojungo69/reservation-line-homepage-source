import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  processDueLineNotificationJobs
} from "../src/line/notifications";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const NOW_MS = Date.parse("2026-09-01T00:00:00.000Z");
const NOW_ISO = "2026-09-01T00:00:00.000Z";

const CUSTOMER_LINE_USER_ID_A = "U" + "a".repeat(32);
const CUSTOMER_LINE_USER_ID_B = "U" + "b".repeat(32);

const seedStore = (d1: SqliteD1Database) => {
  d1.sqlite
    .prepare("INSERT INTO stores (id, name, timezone) VALUES (?, ?, ?)")
    .run("store_fifo", "FIFO Salon", "Asia/Tokyo");
  d1.sqlite
    .prepare("INSERT INTO store_resources (id, store_id, name) VALUES (?, ?, ?)")
    .run("resource_fifo", "store_fifo", "Room A");
  d1.sqlite
    .prepare("INSERT INTO services (id, store_id, name, duration_minutes) VALUES (?, ?, ?, ?)")
    .run("svc_fifo", "store_fifo", "Cut", 60);
};

const seedCustomer = (
  d1: SqliteD1Database,
  customerId: string,
  lineUserId: string
) => {
  d1.sqlite
    .prepare("INSERT INTO customers (id, display_name, phone_normalized, phone_hash) VALUES (?, ?, ?, ?)")
    .run(customerId, `Customer ${customerId}`, `0700000${customerId.slice(-4)}`, `ph_${customerId}`);
  d1.sqlite
    .prepare(
      "INSERT INTO line_identities (id, customer_id, provider, channel_id, line_user_id) VALUES (?, ?, ?, ?, ?)"
    )
    .run(`identity_${customerId}`, customerId, "line", "ch_fifo", lineUserId);
};

const seedReservation = (
  d1: SqliteD1Database,
  reservationId: string,
  customerId: string,
  opts?: { status?: string }
) => {
  d1.sqlite
    .prepare(
      `INSERT INTO reservations (
         id, store_id, service_id, customer_id, resource_id, line_identity_id,
         source, status, start_at, end_at, duration_minutes, idempotency_key, version
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      reservationId,
      "store_fifo",
      "svc_fifo",
      customerId,
      "resource_fifo",
      `identity_${customerId}`,
      "web_line",
      opts?.status ?? "confirmed",
      "2026-09-10T03:00:00.000Z",
      "2026-09-10T04:00:00.000Z",
      60,
      `idem_${reservationId}`,
      1
    );
};

/**
 * Seed a notification job with precise control over created_at ordering.
 * `createdAtOffset` is seconds added to a base timestamp to enforce
 * deterministic FIFO ordering via created_at.
 */
const seedNotificationJob = (
  d1: SqliteD1Database,
  jobId: string,
  opts: {
    templateKey: string;
    recipientId: string;
    reservationId: string;
    createdAtOffset?: number;
    status?: string;
  }
) => {
  const baseCreatedAt = new Date("2026-08-31T23:50:00.000Z");
  if (opts.createdAtOffset) {
    baseCreatedAt.setSeconds(baseCreatedAt.getSeconds() + opts.createdAtOffset);
  }
  const createdAtIso = baseCreatedAt.toISOString();
  const dedupeKey = `fifo:${jobId}:${opts.templateKey}:${opts.recipientId}`;

  d1.sqlite
    .prepare(
      `INSERT INTO notification_jobs (
         id, dedupe_key, template_key, recipient_type, recipient_id,
         reservation_id, status, attempts, available_at, created_at, updated_at
       ) VALUES (?, ?, ?, 'customer', ?, ?, ?, 0, ?, ?, ?)`
    )
    .run(
      jobId,
      dedupeKey,
      opts.templateKey,
      opts.recipientId,
      opts.reservationId,
      opts.status ?? "queued",
      NOW_ISO,
      createdAtIso,
      NOW_ISO
    );
};

const makeSuccessFetcher = () =>
  vi.fn(async () =>
    Response.json({ sentMessages: [{ id: "msg_ok" }] })
  ) as unknown as typeof fetch;

/**
 * Creates a fetcher that records the order in which LINE user IDs are called,
 * allowing verification of dispatch sequencing.
 */
const makeOrderTrackingFetcher = () => {
  const callOrder: string[] = [];
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string);
    callOrder.push(body.to);
    return Response.json({ sentMessages: [{ id: "msg_ok" }] });
  }) as unknown as typeof fetch;
  return { fetcher, callOrder };
};

describe("LINE notification FIFO + state-aware eligibility", () => {
  let d1: SqliteD1Database;

  beforeEach(() => {
    d1 = createMigratedSqliteD1();
    seedStore(d1);
    seedCustomer(d1, "cust_a", CUSTOMER_LINE_USER_ID_A);
    seedCustomer(d1, "cust_b", CUSTOMER_LINE_USER_ID_B);
  });

  afterEach(() => {
    d1.sqlite.close();
  });

  // ─── State-aware eligibility tests ───────────────────────────────────

  describe("state-aware eligibility: supersedence", () => {
    it("suppresses reservation_confirmed retry when a newer reservation_time_changed exists", async () => {
      seedReservation(d1, "res_1", "cust_a", { status: "confirmed" });

      // Older: confirmed (retry)
      seedNotificationJob(d1, "job_confirmed_old", {
        templateKey: "reservation_confirmed",
        recipientId: CUSTOMER_LINE_USER_ID_A,
        reservationId: "res_1",
        createdAtOffset: 0
      });

      // Newer: time_changed — supersedes the confirmed retry
      seedNotificationJob(d1, "job_time_changed_new", {
        templateKey: "reservation_time_changed",
        recipientId: CUSTOMER_LINE_USER_ID_A,
        reservationId: "res_1",
        createdAtOffset: 10
      });

      const fetchMock = makeSuccessFetcher();
      const result = await processDueLineNotificationJobs({
        db: d1 as unknown as D1Database,
        env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token" },
        fetcher: fetchMock,
        now: () => NOW_MS,
        maxJobs: 10,
        _sleep: async () => {}
      });

      // The confirmed job is superseded (marked succeeded as "superseded"),
      // the time_changed job dispatches normally.
      expect(result.processed).toBe(2);
      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(0);

      // Only one actual LINE push should have been made (the time_changed one).
      expect(vi.mocked(fetchMock).mock.calls).toHaveLength(1);

      // Verify the old job was superseded, not dispatched
      const oldJob = d1.sqlite
        .prepare("SELECT status FROM notification_jobs WHERE id = ?")
        .get("job_confirmed_old") as { status: string };
      expect(oldJob.status).toBe("succeeded");
    });

    it("suppresses reservation_confirmed retry when a newer reservation_cancelled_by_admin exists", async () => {
      seedReservation(d1, "res_2", "cust_a", { status: "cancelled_by_admin" });

      seedNotificationJob(d1, "job_confirmed_2", {
        templateKey: "reservation_confirmed",
        recipientId: CUSTOMER_LINE_USER_ID_A,
        reservationId: "res_2",
        createdAtOffset: 0
      });

      seedNotificationJob(d1, "job_cancelled_2", {
        templateKey: "reservation_cancelled_by_admin",
        recipientId: CUSTOMER_LINE_USER_ID_A,
        reservationId: "res_2",
        createdAtOffset: 10
      });

      const fetchMock = makeSuccessFetcher();
      const result = await processDueLineNotificationJobs({
        db: d1 as unknown as D1Database,
        env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token" },
        fetcher: fetchMock,
        now: () => NOW_MS,
        maxJobs: 10,
        _sleep: async () => {}
      });

      // confirmed is superseded; cancelled dispatches normally.
      expect(result.processed).toBe(2);
      expect(result.succeeded).toBe(2);
      // Only the cancelled job triggers a LINE push
      expect(vi.mocked(fetchMock).mock.calls).toHaveLength(1);
    });

    it("suppresses reservation_time_changed when a newer reservation_rejected exists", async () => {
      seedReservation(d1, "res_3", "cust_a", { status: "rejected" });

      seedNotificationJob(d1, "job_time_changed_3", {
        templateKey: "reservation_time_changed",
        recipientId: CUSTOMER_LINE_USER_ID_A,
        reservationId: "res_3",
        createdAtOffset: 0
      });

      seedNotificationJob(d1, "job_rejected_3", {
        templateKey: "reservation_rejected",
        recipientId: CUSTOMER_LINE_USER_ID_A,
        reservationId: "res_3",
        createdAtOffset: 10
      });

      const fetchMock = makeSuccessFetcher();
      const result = await processDueLineNotificationJobs({
        db: d1 as unknown as D1Database,
        env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token" },
        fetcher: fetchMock,
        now: () => NOW_MS,
        maxJobs: 10,
        _sleep: async () => {}
      });

      expect(result.processed).toBe(2);
      expect(result.succeeded).toBe(2);
      expect(vi.mocked(fetchMock).mock.calls).toHaveLength(1);
    });

    it("suppresses reservation_reminder when a newer reservation_cancelled_by_admin exists", async () => {
      seedReservation(d1, "res_4", "cust_a", { status: "cancelled_by_admin" });

      seedNotificationJob(d1, "job_reminder_4", {
        templateKey: "reservation_reminder",
        recipientId: CUSTOMER_LINE_USER_ID_A,
        reservationId: "res_4",
        createdAtOffset: 0
      });

      seedNotificationJob(d1, "job_cancelled_4", {
        templateKey: "reservation_cancelled_by_admin",
        recipientId: CUSTOMER_LINE_USER_ID_A,
        reservationId: "res_4",
        createdAtOffset: 10
      });

      const fetchMock = makeSuccessFetcher();
      const result = await processDueLineNotificationJobs({
        db: d1 as unknown as D1Database,
        env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token" },
        fetcher: fetchMock,
        now: () => NOW_MS,
        maxJobs: 10,
        _sleep: async () => {}
      });

      expect(result.processed).toBe(2);
      expect(result.succeeded).toBe(2);
      // Reminder suppressed; only cancelled dispatches
      expect(vi.mocked(fetchMock).mock.calls).toHaveLength(1);
    });

    it("does NOT suppress when the superseding job is 'dead' (already failed out)", async () => {
      seedReservation(d1, "res_5", "cust_a", { status: "confirmed" });

      seedNotificationJob(d1, "job_confirmed_5", {
        templateKey: "reservation_confirmed",
        recipientId: CUSTOMER_LINE_USER_ID_A,
        reservationId: "res_5",
        createdAtOffset: 0
      });

      // The superseding job exists but has been marked dead — should not suppress
      seedNotificationJob(d1, "job_cancelled_5", {
        templateKey: "reservation_cancelled_by_admin",
        recipientId: CUSTOMER_LINE_USER_ID_A,
        reservationId: "res_5",
        createdAtOffset: 10,
        status: "dead"
      });

      const fetchMock = makeSuccessFetcher();
      const result = await processDueLineNotificationJobs({
        db: d1 as unknown as D1Database,
        env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token" },
        fetcher: fetchMock,
        now: () => NOW_MS,
        maxJobs: 10,
        _sleep: async () => {}
      });

      // confirmed should dispatch since the superseding job is dead
      expect(result.processed).toBe(1);
      expect(result.succeeded).toBe(1);
      expect(vi.mocked(fetchMock).mock.calls).toHaveLength(1);
    });

    it("inverted enqueue order: newer template first, then older retry — older is still suppressed", async () => {
      seedReservation(d1, "res_6", "cust_a", { status: "confirmed" });

      // time_changed enqueued first (lower createdAtOffset)
      seedNotificationJob(d1, "job_time_changed_6", {
        templateKey: "reservation_time_changed",
        recipientId: CUSTOMER_LINE_USER_ID_A,
        reservationId: "res_6",
        createdAtOffset: 0
      });

      // confirmed retry enqueued second — but older in lifecycle
      // The confirmed retry has a LATER created_at, but that does not matter:
      // the time_changed job already exists with a NEWER template. The
      // confirmed job must check: "is there a newer-lifecycle job created
      // after me?" — there isn't (time_changed was created before).
      // So confirmed is NOT suppressed, and both should send.
      // Actually: the confirmed retry was created AFTER the time_changed,
      // so time_changed does NOT supersede it (it's older, not newer).
      // This verifies that created_at ordering is respected.
      seedNotificationJob(d1, "job_confirmed_retry_6", {
        templateKey: "reservation_confirmed",
        recipientId: CUSTOMER_LINE_USER_ID_A,
        reservationId: "res_6",
        createdAtOffset: 10
      });

      const fetchMock = makeSuccessFetcher();
      const result = await processDueLineNotificationJobs({
        db: d1 as unknown as D1Database,
        env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token" },
        fetcher: fetchMock,
        now: () => NOW_MS,
        maxJobs: 10,
        _sleep: async () => {}
      });

      // Both jobs dispatch: the time_changed sends because it has no superseding,
      // and the confirmed retry also sends because the only superseding template
      // (time_changed) was created BEFORE it, not after.
      expect(result.processed).toBe(2);
      expect(result.succeeded).toBe(2);
      expect(vi.mocked(fetchMock).mock.calls).toHaveLength(2);
    });

    it("correctly suppresses confirmed when time_changed was enqueued AFTER it", async () => {
      seedReservation(d1, "res_7", "cust_a", { status: "confirmed" });

      // confirmed enqueued first
      seedNotificationJob(d1, "job_confirmed_7", {
        templateKey: "reservation_confirmed",
        recipientId: CUSTOMER_LINE_USER_ID_A,
        reservationId: "res_7",
        createdAtOffset: 0
      });

      // time_changed enqueued AFTER — this supersedes the confirmed job
      seedNotificationJob(d1, "job_time_changed_7", {
        templateKey: "reservation_time_changed",
        recipientId: CUSTOMER_LINE_USER_ID_A,
        reservationId: "res_7",
        createdAtOffset: 10
      });

      const fetchMock = makeSuccessFetcher();
      const result = await processDueLineNotificationJobs({
        db: d1 as unknown as D1Database,
        env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token" },
        fetcher: fetchMock,
        now: () => NOW_MS,
        maxJobs: 10,
        _sleep: async () => {}
      });

      // confirmed suppressed, time_changed sent
      expect(result.succeeded).toBe(2);
      expect(vi.mocked(fetchMock).mock.calls).toHaveLength(1);
    });
  });

  // ─── FIFO per-partition tests ────────────────────────────────────────

  describe("FIFO per-partition dispatch", () => {
    it("two independent recipients dispatch in parallel (both receive pushes)", async () => {
      seedReservation(d1, "res_a1", "cust_a");
      seedReservation(d1, "res_b1", "cust_b");

      seedNotificationJob(d1, "job_a1", {
        templateKey: "reservation_confirmed",
        recipientId: CUSTOMER_LINE_USER_ID_A,
        reservationId: "res_a1",
        createdAtOffset: 0
      });

      seedNotificationJob(d1, "job_b1", {
        templateKey: "reservation_confirmed",
        recipientId: CUSTOMER_LINE_USER_ID_B,
        reservationId: "res_b1",
        createdAtOffset: 0
      });

      const { fetcher, callOrder } = makeOrderTrackingFetcher();
      const result = await processDueLineNotificationJobs({
        db: d1 as unknown as D1Database,
        env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token" },
        fetcher,
        now: () => NOW_MS,
        maxJobs: 10,
        _sleep: async () => {}
      });

      expect(result.processed).toBe(2);
      expect(result.succeeded).toBe(2);
      // Both recipients were called
      expect(callOrder).toContain(CUSTOMER_LINE_USER_ID_A);
      expect(callOrder).toContain(CUSTOMER_LINE_USER_ID_B);
    });

    it("3 jobs for same recipient+reservation dispatch sequentially in FIFO order", async () => {
      seedReservation(d1, "res_seq", "cust_a", { status: "confirmed" });

      // 3 jobs for same recipient+reservation, staggered created_at
      seedNotificationJob(d1, "job_seq_1", {
        templateKey: "reservation_confirmed",
        recipientId: CUSTOMER_LINE_USER_ID_A,
        reservationId: "res_seq",
        createdAtOffset: 0
      });
      seedNotificationJob(d1, "job_seq_2", {
        templateKey: "reservation_confirmed",
        recipientId: CUSTOMER_LINE_USER_ID_A,
        reservationId: "res_seq",
        createdAtOffset: 5
      });
      seedNotificationJob(d1, "job_seq_3", {
        templateKey: "reservation_confirmed",
        recipientId: CUSTOMER_LINE_USER_ID_A,
        reservationId: "res_seq",
        createdAtOffset: 10
      });

      // Track the order of job_id claims via retry-key header
      const jobOrder: string[] = [];
      const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const retryKey = headers.get("X-Line-Retry-Key");
        if (retryKey) jobOrder.push(retryKey);
        return Response.json({ sentMessages: [{ id: "msg_ok" }] });
      }) as unknown as typeof fetch;

      const result = await processDueLineNotificationJobs({
        db: d1 as unknown as D1Database,
        env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token" },
        fetcher,
        now: () => NOW_MS,
        maxJobs: 10,
        _sleep: async () => {}
      });

      expect(result.processed).toBe(3);
      expect(result.succeeded).toBe(3);

      // All 3 must execute — verify ordering via retry-key (= job_id)
      // Note: the 2nd and 3rd jobs share the same confirmed template so
      // none is superseded (supersedence only applies across different
      // lifecycle templates).
      expect(jobOrder).toEqual(["job_seq_1", "job_seq_2", "job_seq_3"]);
    });

    it("mixed partitions: same-partition is sequential, cross-partition is parallel", async () => {
      seedReservation(d1, "res_mix_a", "cust_a", { status: "confirmed" });
      seedReservation(d1, "res_mix_b", "cust_b", { status: "confirmed" });

      // Partition A: 2 jobs
      seedNotificationJob(d1, "job_mix_a1", {
        templateKey: "reservation_confirmed",
        recipientId: CUSTOMER_LINE_USER_ID_A,
        reservationId: "res_mix_a",
        createdAtOffset: 0
      });
      seedNotificationJob(d1, "job_mix_a2", {
        templateKey: "reservation_confirmed",
        recipientId: CUSTOMER_LINE_USER_ID_A,
        reservationId: "res_mix_a",
        createdAtOffset: 5
      });

      // Partition B: 1 job
      seedNotificationJob(d1, "job_mix_b1", {
        templateKey: "reservation_confirmed",
        recipientId: CUSTOMER_LINE_USER_ID_B,
        reservationId: "res_mix_b",
        createdAtOffset: 0
      });

      const fetchMock = makeSuccessFetcher();
      const result = await processDueLineNotificationJobs({
        db: d1 as unknown as D1Database,
        env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token" },
        fetcher: fetchMock,
        now: () => NOW_MS,
        maxJobs: 10,
        _sleep: async () => {}
      });

      expect(result.processed).toBe(3);
      expect(result.succeeded).toBe(3);
      expect(vi.mocked(fetchMock).mock.calls).toHaveLength(3);
    });
  });

  // ─── Combined: FIFO + eligibility interaction ────────────────────────

  describe("combined: FIFO ordering + eligibility suppression", () => {
    it("within a partition, older confirmed is suppressed before newer time_changed dispatches", async () => {
      seedReservation(d1, "res_combo", "cust_a", { status: "confirmed" });

      seedNotificationJob(d1, "job_combo_confirmed", {
        templateKey: "reservation_confirmed",
        recipientId: CUSTOMER_LINE_USER_ID_A,
        reservationId: "res_combo",
        createdAtOffset: 0
      });

      seedNotificationJob(d1, "job_combo_time_changed", {
        templateKey: "reservation_time_changed",
        recipientId: CUSTOMER_LINE_USER_ID_A,
        reservationId: "res_combo",
        createdAtOffset: 10
      });

      const jobOrder: string[] = [];
      const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const retryKey = headers.get("X-Line-Retry-Key");
        if (retryKey) jobOrder.push(retryKey);
        return Response.json({ sentMessages: [{ id: "msg_ok" }] });
      }) as unknown as typeof fetch;

      const result = await processDueLineNotificationJobs({
        db: d1 as unknown as D1Database,
        env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token" },
        fetcher,
        now: () => NOW_MS,
        maxJobs: 10,
        _sleep: async () => {}
      });

      expect(result.processed).toBe(2);
      expect(result.succeeded).toBe(2);

      // Only the time_changed job should have made a LINE push;
      // the confirmed job was superseded and did not call the API.
      expect(jobOrder).toEqual(["job_combo_time_changed"]);
    });
  });

  // ─── Same-second supersedence (rowid determinism) ────────────────────
  // Issue #139: when multiple lifecycle jobs share the same created_at second,
  // supersedence must be determined by insertion order (rowid), not UUIDv4
  // lexicographic comparison (which is nondeterministic w.r.t. enqueue order).

  describe("same-second supersedence: rowid-based deterministic ordering", () => {
    /**
     * Seeds a notification job with the SAME created_at timestamp for all jobs,
     * relying on SQLite's rowid (insertion order) as the sole tiebreaker.
     * Jobs are inserted in the order they are called, so earlier calls have
     * lower rowids (= "older" in enqueue sense).
     */
    const seedSameSecondJob = (
      d1: SqliteD1Database,
      jobId: string,
      opts: {
        templateKey: string;
        recipientId: string;
        reservationId: string;
        status?: string;
      }
    ) => {
      // All jobs get the exact same created_at to force rowid as the only
      // differentiator.
      const createdAtIso = "2026-08-31T23:55:00.000Z";
      const dedupeKey = `samesec:${jobId}:${opts.templateKey}:${opts.recipientId}`;

      d1.sqlite
        .prepare(
          `INSERT INTO notification_jobs (
             id, dedupe_key, template_key, recipient_type, recipient_id,
             reservation_id, status, attempts, available_at, created_at, updated_at
           ) VALUES (?, ?, ?, 'customer', ?, ?, ?, 0, ?, ?, ?)`
        )
        .run(
          jobId,
          dedupeKey,
          opts.templateKey,
          opts.recipientId,
          opts.reservationId,
          opts.status ?? "queued",
          NOW_ISO,
          createdAtIso,
          NOW_ISO
        );
    };

    it("rapid-fire 3 jobs same second: only the last-inserted superseding template sends", async () => {
      // Scenario: pending -> confirmed -> time_changed all enqueued within 1s.
      // The confirmed job supersedes pending (not applicable here since pending
      // is not in SUPERSEDING_TEMPLATES), but time_changed supersedes confirmed.
      // Insertion order: confirmed first, then time_changed.
      // With UUIDv4 tiebreaker this was nondeterministic. With rowid it must
      // always suppress confirmed and send time_changed.
      seedReservation(d1, "res_rapid", "cust_a", { status: "confirmed" });

      // Insert confirmed FIRST (lower rowid)
      seedSameSecondJob(d1, "job_rapid_confirmed", {
        templateKey: "reservation_confirmed",
        recipientId: CUSTOMER_LINE_USER_ID_A,
        reservationId: "res_rapid"
      });

      // Insert time_changed SECOND (higher rowid) — supersedes confirmed
      seedSameSecondJob(d1, "job_rapid_time_changed", {
        templateKey: "reservation_time_changed",
        recipientId: CUSTOMER_LINE_USER_ID_A,
        reservationId: "res_rapid"
      });

      // Insert cancelled THIRD (highest rowid) — supersedes both confirmed + time_changed
      seedSameSecondJob(d1, "job_rapid_cancelled", {
        templateKey: "reservation_cancelled_by_admin",
        recipientId: CUSTOMER_LINE_USER_ID_A,
        reservationId: "res_rapid"
      });

      // Update reservation status to match the final state
      d1.sqlite
        .prepare("UPDATE reservations SET status = ? WHERE id = ?")
        .run("cancelled_by_admin", "res_rapid");

      const jobOrder: string[] = [];
      const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const retryKey = headers.get("X-Line-Retry-Key");
        if (retryKey) jobOrder.push(retryKey);
        return Response.json({ sentMessages: [{ id: "msg_ok" }] });
      }) as unknown as typeof fetch;

      const result = await processDueLineNotificationJobs({
        db: d1 as unknown as D1Database,
        env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token" },
        fetcher,
        now: () => NOW_MS,
        maxJobs: 10,
        _sleep: async () => {}
      });

      // All 3 processed: confirmed + time_changed superseded, cancelled sent
      expect(result.processed).toBe(3);
      expect(result.succeeded).toBe(3);
      expect(result.failed).toBe(0);

      // Only the cancelled_by_admin job should trigger a LINE push.
      // The confirmed and time_changed are superseded (rowid ordering).
      expect(jobOrder).toEqual(["job_rapid_cancelled"]);
    });

    it("same-second: UUID lexicographic inversion does not affect ordering", async () => {
      // Deliberately choose UUIDs where the "older" job has a lexicographically
      // HIGHER UUID than the "newer" job. Under the old `id > ?` predicate,
      // the older job would NOT be suppressed. Under rowid, insertion order wins.
      seedReservation(d1, "res_lex", "cust_a", { status: "confirmed" });

      // "zzz..." UUID — lexicographically high, but inserted FIRST (lower rowid)
      seedSameSecondJob(d1, "zzz_confirmed_lex", {
        templateKey: "reservation_confirmed",
        recipientId: CUSTOMER_LINE_USER_ID_A,
        reservationId: "res_lex"
      });

      // "aaa..." UUID — lexicographically low, but inserted SECOND (higher rowid)
      // This should supersede the confirmed job because it was enqueued after.
      seedSameSecondJob(d1, "aaa_time_changed_lex", {
        templateKey: "reservation_time_changed",
        recipientId: CUSTOMER_LINE_USER_ID_A,
        reservationId: "res_lex"
      });

      const jobOrder: string[] = [];
      const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const retryKey = headers.get("X-Line-Retry-Key");
        if (retryKey) jobOrder.push(retryKey);
        return Response.json({ sentMessages: [{ id: "msg_ok" }] });
      }) as unknown as typeof fetch;

      const result = await processDueLineNotificationJobs({
        db: d1 as unknown as D1Database,
        env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token" },
        fetcher,
        now: () => NOW_MS,
        maxJobs: 10,
        _sleep: async () => {}
      });

      // confirmed is superseded (even though its UUID is lex-higher)
      expect(result.processed).toBe(2);
      expect(result.succeeded).toBe(2);
      expect(jobOrder).toEqual(["aaa_time_changed_lex"]);
    });

    it("same-second: reverse insertion order — earlier-inserted superseding template does NOT suppress later insert", async () => {
      // Edge case: time_changed inserted BEFORE confirmed retry.
      // The confirmed retry has a higher rowid, so it is "newer" in enqueue
      // terms. time_changed (lower rowid) does NOT supersede it because
      // time_changed was inserted before (i.e. it is not "newer" than confirmed).
      seedReservation(d1, "res_rev", "cust_a", { status: "confirmed" });

      // time_changed inserted FIRST (lower rowid)
      seedSameSecondJob(d1, "job_rev_time_changed", {
        templateKey: "reservation_time_changed",
        recipientId: CUSTOMER_LINE_USER_ID_A,
        reservationId: "res_rev"
      });

      // confirmed retry inserted SECOND (higher rowid) — NOT superseded
      // because there is no superseding job with a HIGHER rowid.
      seedSameSecondJob(d1, "job_rev_confirmed", {
        templateKey: "reservation_confirmed",
        recipientId: CUSTOMER_LINE_USER_ID_A,
        reservationId: "res_rev"
      });

      const jobOrder: string[] = [];
      const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const retryKey = headers.get("X-Line-Retry-Key");
        if (retryKey) jobOrder.push(retryKey);
        return Response.json({ sentMessages: [{ id: "msg_ok" }] });
      }) as unknown as typeof fetch;

      const result = await processDueLineNotificationJobs({
        db: d1 as unknown as D1Database,
        env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token" },
        fetcher,
        now: () => NOW_MS,
        maxJobs: 10,
        _sleep: async () => {}
      });

      // Both should send: time_changed (no superseding templates above it),
      // confirmed retry (time_changed has LOWER rowid, so it's older, not newer).
      expect(result.processed).toBe(2);
      expect(result.succeeded).toBe(2);
      expect(jobOrder).toHaveLength(2);
      expect(jobOrder).toContain("job_rev_time_changed");
      expect(jobOrder).toContain("job_rev_confirmed");
    });
  });
});
