import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { processDueLineNotificationJobs } from "../src/line/notifications";
import type { LineRateLimiter } from "../src/line/rate-limiter-do";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

// NOW = 2026-08-01T00:00Z → 2026-08 in JST. Seed the snapshot for the same month.
const NOW_MS = Date.parse("2026-08-01T00:00:00.000Z");
const CUSTOMER_LINE_USER_ID = "U" + "1".repeat(32);

const seed = (d1: SqliteD1Database) => {
  d1.sqlite.prepare(`INSERT INTO stores (id, name, timezone) VALUES (?, ?, ?)`).run("store_q", "Salon", "Asia/Tokyo");
  d1.sqlite.prepare(`INSERT INTO store_resources (id, store_id, name) VALUES (?, ?, ?)`).run("res_q", "store_q", "R");
  d1.sqlite
    .prepare(`INSERT INTO customers (id, display_name, phone_normalized, phone_hash) VALUES (?, ?, ?, ?)`)
    .run("cust_q", "予約 太郎", "070000111", "ph_q");
  d1.sqlite
    .prepare(`INSERT INTO line_identities (id, customer_id, provider, channel_id, line_user_id) VALUES (?, ?, ?, ?, ?)`)
    .run("ident_q", "cust_q", "line", "ch_q", CUSTOMER_LINE_USER_ID);
  d1.sqlite
    .prepare(`INSERT INTO services (id, store_id, name, duration_minutes) VALUES (?, ?, ?, ?)`)
    .run("svc_q", "store_q", "カット", 60);
  d1.sqlite
    .prepare(
      `INSERT INTO reservations (
         id, store_id, service_id, customer_id, resource_id, line_identity_id, source, status,
         start_at, end_at, duration_minutes, idempotency_key, version
       ) VALUES ('resv_q', 'store_q', 'svc_q', 'cust_q', 'res_q', 'ident_q', 'web_line', 'confirmed',
                 '2026-08-05T03:00:00.000Z', '2026-08-05T04:00:00.000Z', 60, 'idem_q', 1)`
    )
    .run();
};

const seedSnapshot = (d1: SqliteD1Database, totalUsage: number) => {
  d1.sqlite
    .prepare(`INSERT INTO line_quota_snapshots (year_month, total_usage, quota_value, fetched_at) VALUES (?, ?, ?, ?)`)
    .run("2026-08", totalUsage, 200, "2026-08-01T00:00:00.000Z");
};

const seedJob = (d1: SqliteD1Database, jobId: string, templateKey: string, availableAt = "2026-08-01T00:00:00.000Z") => {
  d1.sqlite
    .prepare(
      `INSERT INTO notification_jobs (
         id, dedupe_key, template_key, recipient_type, recipient_id, reservation_id,
         status, attempts, available_at, updated_at
       ) VALUES (?, ?, ?, 'customer', ?, 'resv_q', 'queued', 0, ?, ?)`
    )
    .run(jobId, `resv_q:${templateKey}:${jobId}`, templateKey, CUSTOMER_LINE_USER_ID, availableAt, "2026-08-01T00:00:00.000Z");
};

describe("LINE notification monthly budget guard", () => {
  let d1: SqliteD1Database;
  beforeEach(() => {
    d1 = createMigratedSqliteD1();
    seed(d1);
  });
  afterEach(() => d1.sqlite.close());

  const run = async (fetchMock: typeof fetch) =>
    processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "tok" },
      fetcher: fetchMock,
      now: () => NOW_MS,
      maxJobs: 5
    });

  it.each(["reservation_confirmed", "reservation_reminder"])(
    "ends %s without sending or retrying when the monthly quota is exhausted",
    async (template) => {
      seedSnapshot(d1, 200);
      seedJob(d1, "monthly_limit", template);
      const fetchMock = vi.fn(async () => Response.json({ sentMessages: [] }));

      expect(await run(fetchMock)).toEqual({ processed: 1, succeeded: 0, failed: 1 });
      expect(await run(fetchMock)).toEqual({ processed: 0, succeeded: 0, failed: 0 });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(d1.sqlite.prepare("SELECT status, attempts, last_error FROM notification_jobs WHERE id = 'monthly_limit'").get())
        .toEqual({ status: "dead", attempts: 1, last_error: "line-monthly-quota-exhausted" });
      expect(d1.sqlite.prepare("SELECT status, sent_count FROM notification_logs WHERE notification_job_id = 'monthly_limit'").get())
        .toEqual({ status: "failed", sent_count: 0 });
    }
  );

  it.each([
    ["You have reached your monthly limit.", "dead", "line-monthly-quota-exhausted"],
    ["The API rate limit has been exceeded.", "retryable", "line-http-429"],
    ["unknown provider error", "retryable", "line-http-429"]
  ])("classifies the provider's 429 message: %s", async (message, status, lastError) => {
    seedJob(d1, "provider_limit", "reservation_confirmed");
    const fetchMock = vi.fn(async () => Response.json({ message }, { status: 429 }));
    expect((await run(fetchMock)).failed).toBe(1);
    expect(d1.sqlite.prepare("SELECT status, last_error FROM notification_jobs WHERE id = 'provider_limit'").get())
      .toEqual({ status, last_error: lastError });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    if (status === "dead") {
      // A later monthly reset must not make this old notification sendable again.
      await processDueLineNotificationJobs({
        db: d1 as unknown as D1Database,
        env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "tok" },
        fetcher: fetchMock,
        now: () => Date.parse("2026-09-01T00:00:00.000Z")
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps an unparseable 429 retryable", async () => {
    seedJob(d1, "malformed_limit", "reservation_confirmed");
    await run(vi.fn(async () => new Response("not JSON", { status: 429 })));
    expect(d1.sqlite.prepare("SELECT status, last_error FROM notification_jobs WHERE id = 'malformed_limit'").get())
      .toEqual({ status: "retryable", last_error: "line-http-429" });
  });

  it("does not use a previous month's exhausted quota to stop new notifications", async () => {
    seedSnapshot(d1, 200);
    d1.sqlite.prepare("UPDATE line_quota_snapshots SET year_month = '2026-07'").run();
    seedJob(d1, "new_month", "reservation_confirmed");
    const fetchMock = vi.fn(async () => Response.json({ sentMessages: [] }));
    expect((await run(fetchMock)).succeeded).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not carry a quota stop across the month boundary during a running sweep", async () => {
    seedSnapshot(d1, 200);
    seedJob(d1, "midnight", "reservation_confirmed");
    let nowMs = Date.parse("2026-08-31T14:59:59.000Z");
    const prepare = d1.prepare.bind(d1);
    vi.spyOn(d1, "prepare").mockImplementation((sql) => {
      if (sql.includes("JOIN reservations") && sql.includes("FROM notification_jobs")) {
        nowMs = Date.parse("2026-08-31T15:00:00.000Z");
      }
      return prepare(sql);
    });
    const fetchMock = vi.fn(async () => Response.json({ sentMessages: [] }));
    expect(await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database, env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "tok" },
      fetcher: fetchMock, now: () => nowMs
    })).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the provider when an exhausted snapshot has an invalid timestamp", async () => {
    seedSnapshot(d1, 200);
    d1.sqlite.prepare("UPDATE line_quota_snapshots SET fetched_at = 'invalid'").run();
    seedJob(d1, "invalid_snapshot", "reservation_confirmed");
    const fetchMock = vi.fn(async () => Response.json({ sentMessages: [] }));
    expect((await run(fetchMock)).succeeded).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("terminates known quota failures without waiting for a denied rate budget", async () => {
    seedSnapshot(d1, 200);
    seedJob(d1, "quota_without_budget", "reservation_confirmed");
    const acquire = vi.fn(async () => ({ ok: false, retryAfterMs: 1 }));
    const fetchMock = vi.fn(async () => Response.json({ sentMessages: [] }));
    const namespace = { idFromName: () => "quota", get: () => ({ acquire }) };
    expect(await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "tok", LINE_RATE_LIMITER: namespace as unknown as DurableObjectNamespace<LineRateLimiter> },
      fetcher: fetchMock, now: () => NOW_MS, _sleep: async () => {}
    })).toEqual({ processed: 1, succeeded: 0, failed: 1 });
    expect(acquire).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(d1.sqlite.prepare("SELECT status FROM notification_jobs WHERE id = 'quota_without_budget'").get()).toEqual({ status: "dead" });
  });

  it("suppresses optional pushes (reminder) once usage reaches the soft cap, without sending", async () => {
    seedSnapshot(d1, 180); // soft cap default 180 → suppress
    seedJob(d1, "job_reminder", "reservation_reminder");

    const fetchMock = vi.fn(async () => Response.json({ sentMessages: [] })) as unknown as typeof fetch;
    const result = await run(fetchMock);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    const row = d1.sqlite.prepare(`SELECT status, last_error FROM notification_jobs WHERE id = 'job_reminder'`).get() as {
      status: string;
      last_error: string;
    };
    expect(row.status).toBe("succeeded");
    expect(row.last_error).toBe("suppressed_line_monthly_soft_cap");
  });

  it("carries optional-send accounting across dispatcher invocations (179/180 sends only once)", async () => {
    seedSnapshot(d1, 179); // one optional slot left at fetch time
    seedJob(d1, "job_reminder_first", "reservation_reminder");
    seedJob(d1, "job_reminder_second", "reservation_reminder");

    const fetchMock = vi.fn(async () => Response.json({ sentMessages: [{ id: "m" }] })) as unknown as typeof fetch;
    const runOne = () =>
      processDueLineNotificationJobs({
        db: d1 as unknown as D1Database,
        env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "tok" },
        fetcher: fetchMock,
        now: () => NOW_MS,
        maxJobs: 1
      });

    // The snapshot is NOT refreshed between invocations (that only happens on the
    // 10-minute cron) — the second invocation must see the first send in
    // notification_logs and suppress instead of spending the same last slot.
    await runOne();
    await runOne();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const rows = d1.sqlite
      .prepare(`SELECT status, last_error FROM notification_jobs`)
      .all() as Array<{ status: string; last_error: string | null }>;
    expect(rows.filter((r) => r.last_error === "suppressed_line_monthly_soft_cap")).toHaveLength(1);
    expect(rows.every((r) => r.status === "succeeded")).toBe(true);
  });

  it("counts a send completed after a mid-send snapshot refresh (created_at is completion time)", async () => {
    seedSnapshot(d1, 179); // one optional slot left at fetch time
    seedJob(d1, "job_reminder_first", "reservation_reminder");
    seedJob(d1, "job_reminder_second", "reservation_reminder");

    // Mutable clock: the send mock refreshes the snapshot mid-send (as the
    // 10-minute cron would) WITHOUT counting the in-flight send, then advances
    // the clock so the success log lands after the new snapshot's fetched_at.
    let clockMs = NOW_MS;
    const fetchMock = vi.fn(async () => {
      d1.sqlite
        .prepare(`UPDATE line_quota_snapshots SET fetched_at = ? WHERE year_month = '2026-08'`)
        .run("2026-08-01T00:00:05.000Z");
      clockMs = NOW_MS + 10_000;
      return Response.json({ sentMessages: [{ id: "m" }] });
    }) as unknown as typeof fetch;
    const runOne = () =>
      processDueLineNotificationJobs({
        db: d1 as unknown as D1Database,
        env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "tok" },
        fetcher: fetchMock,
        now: () => clockMs,
        maxJobs: 1
      });

    await runOne();
    await runOne();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const rows = d1.sqlite
      .prepare(`SELECT status, last_error FROM notification_jobs`)
      .all() as Array<{ status: string; last_error: string | null }>;
    expect(rows.filter((r) => r.last_error === "suppressed_line_monthly_soft_cap")).toHaveLength(1);
    expect(rows.every((r) => r.status === "succeeded")).toBe(true);
  });

  it("still sends critical/transactional pushes (confirmed) at the soft cap", async () => {
    seedSnapshot(d1, 195);
    seedJob(d1, "job_confirmed", "reservation_confirmed");

    const fetchMock = vi.fn(async () => Response.json({ sentMessages: [{ id: "m" }] })) as unknown as typeof fetch;
    const result = await run(fetchMock);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
  });

  it("does not suppress when below the soft cap", async () => {
    seedSnapshot(d1, 100);
    seedJob(d1, "job_reminder", "reservation_reminder");

    const fetchMock = vi.fn(async () => Response.json({ sentMessages: [{ id: "m" }] })) as unknown as typeof fetch;
    await run(fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("bounds a single sweep to the remaining headroom (cannot overshoot the soft cap)", async () => {
    // 178/180 → only 2 optional slots left; a 3-reminder sweep sends 2, suppresses 1.
    seedSnapshot(d1, 178);
    seedJob(d1, "job_r1", "reservation_reminder");
    seedJob(d1, "job_r2", "reservation_reminder");
    seedJob(d1, "job_r3", "reservation_reminder");

    const fetchMock = vi.fn(async () => Response.json({ sentMessages: [{ id: "m" }] })) as unknown as typeof fetch;
    const result = await run(fetchMock);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.processed).toBe(3);
    const suppressed = d1.sqlite
      .prepare(`SELECT COUNT(*) AS c FROM notification_jobs WHERE last_error = 'suppressed_line_monthly_soft_cap'`)
      .get() as { c: number };
    expect(suppressed.c).toBe(1);
  });

  it("counts transactional sends against the same budget so optional cannot slip past the cap", async () => {
    // 179/180 → 1 slot left. Both jobs are due; the critical one (earlier
    // available_at) is dispatched first and consumes the slot, so the reminder in
    // the same sweep is suppressed.
    seedSnapshot(d1, 179);
    seedJob(d1, "job_confirmed", "reservation_confirmed", "2026-07-31T23:59:59.000Z");
    seedJob(d1, "job_reminder", "reservation_reminder", "2026-08-01T00:00:00.000Z");

    const fetchMock = vi.fn(async () => Response.json({ sentMessages: [{ id: "m" }] })) as unknown as typeof fetch;
    await run(fetchMock);

    // Only the critical push went out; the reminder was suppressed.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const reminder = d1.sqlite
      .prepare(`SELECT status, last_error FROM notification_jobs WHERE id = 'job_reminder'`)
      .get() as { status: string; last_error: string };
    expect(reminder.last_error).toBe("suppressed_line_monthly_soft_cap");
  });

  it("returns the reserved slot when a send fails, so a later optional push is not needlessly suppressed", async () => {
    // 179/180 → 1 slot. The critical job (first) fails to send and must release the
    // slot; the reminder then still has headroom and is sent (not suppressed).
    seedSnapshot(d1, 179);
    seedJob(d1, "job_confirmed", "reservation_confirmed", "2026-07-31T23:59:59.000Z");
    seedJob(d1, "job_reminder", "reservation_reminder", "2026-08-01T00:00:00.000Z");

    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      return call === 1 ? Response.json({}, { status: 500 }) : Response.json({ sentMessages: [{ id: "m" }] });
    }) as unknown as typeof fetch;
    await run(fetchMock);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const reminder = d1.sqlite
      .prepare(`SELECT status, last_error FROM notification_jobs WHERE id = 'job_reminder'`)
      .get() as { status: string; last_error: string | null };
    expect(reminder.status).toBe("succeeded");
    expect(reminder.last_error).not.toBe("suppressed_line_monthly_soft_cap");
  });
});

// staging / local は本番と同じ LINE チャネルのトークンを共有しているため、
// これらの環境からの push は実在のお客様に届いてしまう。専用チャネルが発行されるまで
// 送信前に終端させる。判定は denylist なので、本番が抑止されないことも併せて固定する。
describe("LINE push cross-environment guard", () => {
  let d1: SqliteD1Database;
  beforeEach(() => {
    d1 = createMigratedSqliteD1();
    seed(d1);
  });
  afterEach(() => d1.sqlite.close());

  const runWithEnvironment = async (fetchMock: typeof fetch, environment?: string) =>
    processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "tok", ...(environment ? { ENVIRONMENT: environment } : {}) },
      fetcher: fetchMock,
      now: () => NOW_MS,
      maxJobs: 5
    });

  const readJob = (jobId: string) =>
    d1.sqlite.prepare(`SELECT status, last_error FROM notification_jobs WHERE id = ?`).get(jobId) as {
      status: string;
      last_error: string | null;
    };

  it.each(["staging", "local"])("does not push from ENVIRONMENT=%s and terminates the job", async (environment) => {
    seedJob(d1, "job_confirmed", "reservation_confirmed");
    const fetchMock = vi.fn(async () => Response.json({ sentMessages: [{ id: "m" }] })) as unknown as typeof fetch;

    const result = await runWithEnvironment(fetchMock, environment);

    expect(fetchMock).not.toHaveBeenCalled();
    // 送っていないものを succeeded に数えない (notification_sent メトリクスも出ない)。
    expect(result).toEqual({ processed: 1, succeeded: 0, failed: 0 });
    const row = readJob("job_confirmed");
    // D1 の行だけは終端させる (retryable にしない): この環境では何度試しても送れず、
    // retryable のままだと reservation-confirm Workflow の assertJobTerminal が
    // リトライを使い切るため。
    expect(row.status).toBe("succeeded");
    expect(row.last_error).toBe("suppressed_non_production_line_channel");
  });

  it("still pushes from ENVIRONMENT=production", async () => {
    seedJob(d1, "job_confirmed", "reservation_confirmed");
    const fetchMock = vi.fn(async () => Response.json({ sentMessages: [{ id: "m" }] })) as unknown as typeof fetch;

    await runWithEnvironment(fetchMock, "production");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readJob("job_confirmed").last_error).not.toBe("suppressed_non_production_line_channel");
  });

  // 既存テストの env fixture は ENVIRONMENT を持たない。denylist は fail-open なので
  // それらは従来どおり送信され続ける — この挙動を意図として固定する。
  it("still pushes when ENVIRONMENT is unset", async () => {
    seedJob(d1, "job_confirmed", "reservation_confirmed");
    const fetchMock = vi.fn(async () => Response.json({ sentMessages: [{ id: "m" }] })) as unknown as typeof fetch;

    await runWithEnvironment(fetchMock);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readJob("job_confirmed").last_error).not.toBe("suppressed_non_production_line_channel");
  });
});
