import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processDueLineNotificationJobs } from "../src/line/notifications";
import { dispatchReservationReminders } from "../src/notifications/reminder-dispatcher";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const NOW_ISO = "2026-08-01T00:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const env = { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "fixture-token", ENVIRONMENT: "production" };

function seed(db: SqliteD1Database, count = 1) {
  db.sqlite.exec(`
    INSERT INTO customers (id, display_name, phone_hash) VALUES ('consistency-c', 'Fixture', 'consistency-ph');
    INSERT INTO line_identities (id,customer_id,provider,channel_id,line_user_id)
      VALUES ('consistency-i','consistency-c','line','fixture-channel','U00000000000000000000000000000000');
    UPDATE store_settings SET reservation_reminder_offset_minutes=30 WHERE store_id='kyoto';
  `);
  for (let i = 0; i < count; i++) seedReservation(db, i);
}

function seedReservation(db: SqliteD1Database, index: number) {
  db.sqlite.prepare(`
    INSERT INTO reservations (id,store_id,service_id,customer_id,resource_id,line_identity_id,source,status,
      start_at,end_at,duration_minutes,idempotency_key,version)
    VALUES (?, 'kyoto','service_kyoto_default_60','consistency-c','resource_kyoto_calendar','consistency-i','admin','confirmed',
      '2026-08-01T00:25:00.000Z','2026-08-01T01:25:00.000Z',60,?,1)
  `).run(`consistency-r${index}`, `consistency-idem${index}`);
}

function enqueue(db: SqliteD1Database, id: string, reservationId: string, template = "reservation_time_changed") {
  db.sqlite.prepare(`INSERT INTO notification_jobs
    (id,dedupe_key,template_key,recipient_type,recipient_id,reservation_id,status,available_at,created_at)
    VALUES (?,?,?,'customer','consistency-c',?,'queued',?,?)`)
    .run(id, id, template, reservationId, NOW_ISO, NOW_ISO);
}

const success = () => Response.json({ sentMessages: [{ id: "fixture-message" }] });
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("LINE notification consistency across edits and handlers", () => {
  let db: SqliteD1Database;
  beforeEach(() => { db = createMigratedSqliteD1(); seed(db); });
  afterEach(() => db.sqlite.close());

  it("skips a queued reminder for an old revision and sends the new revision in its own window", async () => {
    expect((await dispatchReservationReminders(db as unknown as D1Database, NOW_MS)).enqueued).toBe(1);
    db.sqlite.prepare("UPDATE notification_jobs SET available_at=?,created_at=?").run(NOW_ISO, NOW_ISO);
    db.sqlite.exec(`UPDATE reservations SET start_at='2026-09-01T00:25:00.000Z',
      end_at='2026-09-01T01:25:00.000Z',version=2 WHERE id='consistency-r0'`);
    enqueue(db, "consistency-change", "consistency-r0");
    expect((await dispatchReservationReminders(db as unknown as D1Database, NOW_MS)).scanned).toBe(0);

    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => success());
    const run = (nowMs: number) => processDueLineNotificationJobs({
      db: db as unknown as D1Database, env, fetcher, now: () => nowMs, maxJobs: 5, _sleep: async () => {}
    });
    await run(NOW_MS);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string).messages[0].text).toContain("予約日時が変更されました");

    const nextWindow = Date.parse("2026-09-01T00:00:00.000Z");
    expect((await dispatchReservationReminders(db as unknown as D1Database, nextWindow)).enqueued).toBe(1);
    db.sqlite.prepare("UPDATE notification_jobs SET available_at=? WHERE status='queued'")
      .run("2026-09-01T00:00:00.000Z");
    await run(nextWindow);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetcher.mock.calls[1][1]?.body as string).messages[0].text).toContain("ご予約のリマインダー");
  });

  it("leaves a newer change queued while another handler is sending the same reservation", async () => {
    enqueue(db, "consistency-old", "consistency-r0");
    const started = gate();
    const release = gate();
    const accepted: string[] = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const jobId = (init?.headers as Record<string, string>)["X-Line-Retry-Key"];
      if (jobId === "consistency-old") { started.resolve(); await release.promise; }
      accepted.push(jobId);
      return success();
    });
    const run = (jobId: string) => processDueLineNotificationJobs({
      db: db as unknown as D1Database, env, fetcher, now: () => NOW_MS,
      maxJobs: 1, jobIdsFilter: [jobId], _sleep: async () => {}
    });
    const old = run("consistency-old");
    await started.promise;
    let sendsWhileOldInflight = 0;
    try {
      db.sqlite.exec(`UPDATE reservations SET start_at='2026-08-01T02:25:00.000Z',
        end_at='2026-08-01T03:25:00.000Z',version=2 WHERE id='consistency-r0'`);
      enqueue(db, "consistency-new", "consistency-r0");
      await run("consistency-new");
      sendsWhileOldInflight = fetcher.mock.calls.length;
    } finally {
      release.resolve();
      await old;
    }
    expect(sendsWhileOldInflight).toBe(1);
    await run("consistency-new");
    expect(accepted).toEqual(["consistency-old", "consistency-new"]);
    expect(JSON.parse(fetcher.mock.calls[1][1]?.body as string).messages[0].text).toContain("11:25");
  });

  it("reserves the last optional monthly slot across concurrent handlers", async () => {
    seedReservation(db, 1);
    db.sqlite.prepare(`INSERT INTO line_quota_snapshots (year_month,total_usage,quota_value,fetched_at)
      VALUES ('2026-08',179,200,?)`).run(NOW_ISO);
    enqueue(db, "consistency-opt-a", "consistency-r0", "reservation_reminder");
    enqueue(db, "consistency-opt-b", "consistency-r1", "reservation_reminder");
    const started = gate();
    const release = gate();
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.headers as Record<string, string>)["X-Line-Retry-Key"] === "consistency-opt-a") {
        started.resolve(); await release.promise;
      }
      return success();
    });
    const run = (jobId: string) => processDueLineNotificationJobs({
      db: db as unknown as D1Database, env, fetcher, now: () => NOW_MS,
      maxJobs: 1, jobIdsFilter: [jobId], _sleep: async () => {}
    });
    const first = run("consistency-opt-a");
    await started.promise;
    try { await run("consistency-opt-b"); }
    finally { release.resolve(); await first; }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not send or retain an unused slot after losing its partition during a quota write", async () => {
    seedReservation(db, 1);
    db.sqlite.prepare(`INSERT INTO line_quota_snapshots (year_month,total_usage,quota_value,fetched_at)
      VALUES ('2026-08',178,200,?)`).run(NOW_ISO);
    enqueue(db, "consistency-stalled", "consistency-r0", "reservation_reminder");
    db.sqlite.exec("UPDATE notification_jobs SET dedupe_key='stalled:revision:1' WHERE id='consistency-stalled'");
    const started = gate();
    const release = gate();
    const prepare = db.prepare.bind(db);
    let paused = false;
    vi.spyOn(db, "prepare").mockImplementation((sql) => {
      if (!sql.includes("'started', 'line_notification_quota'")) return prepare(sql);
      return { bind: (...bindings: Array<string | number | null>) => ({ run: async () => {
        const result = await prepare(sql).bind(...bindings).run();
        if (!paused) { paused = true; started.resolve(); await release.promise; }
        return result;
      } }) } as unknown as D1PreparedStatement;
    });
    let clock = NOW_MS;
    const accepted: string[] = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      accepted.push((init?.headers as Record<string, string>)["X-Line-Retry-Key"]);
      return success();
    });
    const run = (jobId: string) => processDueLineNotificationJobs({
      db: db as unknown as D1Database, env, fetcher, now: () => clock,
      maxJobs: 1, jobIdsFilter: [jobId], _sleep: async () => {}
    });
    const stale = run("consistency-stalled");
    await started.promise;
    try {
      clock += 5 * 60_000 + 1;
      db.sqlite.exec(`UPDATE reservations SET start_at='2026-08-01T02:25:00.000Z',
        end_at='2026-08-01T03:25:00.000Z',version=2 WHERE id='consistency-r0'`);
      enqueue(db, "consistency-fresh", "consistency-r0");
      await run("consistency-fresh");
    } finally { release.resolve(); await stale; }
    enqueue(db, "consistency-remaining", "consistency-r1", "reservation_reminder");
    await run("consistency-remaining");
    expect(accepted).toEqual(["consistency-fresh", "consistency-remaining"]);
  });

  it("delivers a waiting optional job after the occupying send definitively fails", async () => {
    seedReservation(db, 1);
    db.sqlite.prepare(`INSERT INTO line_quota_snapshots (year_month,total_usage,quota_value,fetched_at)
      VALUES ('2026-08',179,200,?)`).run(NOW_ISO);
    enqueue(db, "consistency-failure", "consistency-r0", "reservation_reminder");
    enqueue(db, "consistency-waiting", "consistency-r1", "reservation_reminder");
    const started = gate();
    const release = gate();
    const accepted: string[] = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const jobId = (init?.headers as Record<string, string>)["X-Line-Retry-Key"];
      if (jobId === "consistency-failure") {
        started.resolve(); await release.promise;
        return new Response("Unauthorized", { status: 401 });
      }
      accepted.push(jobId);
      return success();
    });
    const run = (jobId: string) => processDueLineNotificationJobs({
      db: db as unknown as D1Database, env, fetcher, now: () => NOW_MS,
      maxJobs: 1, jobIdsFilter: [jobId], _sleep: async () => {}
    });
    const first = run("consistency-failure");
    await started.promise;
    try { await run("consistency-waiting"); }
    finally { release.resolve(); await first; }
    expect((await run("consistency-waiting")).succeeded).toBe(1);
    expect(accepted).toEqual(["consistency-waiting"]);
  });

  it("keeps an unknown send reserved and allows its retry-key recovery without a second slot", async () => {
    seedReservation(db, 1);
    db.sqlite.prepare(`INSERT INTO line_quota_snapshots (year_month,total_usage,quota_value,fetched_at)
      VALUES ('2026-08',179,200,?)`).run(NOW_ISO);
    enqueue(db, "consistency-unknown", "consistency-r0", "reservation_reminder");
    enqueue(db, "consistency-blocked", "consistency-r1", "reservation_reminder");
    let clock = NOW_MS;
    let attempts = 0;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)["X-Line-Retry-Key"]).toBe("consistency-unknown");
      attempts += 1;
      if (attempts === 1) throw new Error("response lost after provider acceptance");
      return new Response(null, { status: 409, headers: { "x-line-accepted-request-id": "fixture-accepted" } });
    });
    const run = (jobId: string) => processDueLineNotificationJobs({
      db: db as unknown as D1Database, env, fetcher, now: () => clock,
      maxJobs: 1, jobIdsFilter: [jobId], _sleep: async () => {}
    });
    expect((await run("consistency-unknown")).failed).toBe(1);
    await run("consistency-blocked");
    expect(fetcher).toHaveBeenCalledTimes(1);
    clock += 5 * 60_000;
    expect((await run("consistency-unknown")).succeeded).toBe(1);
    await run("consistency-blocked");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not overtake an earlier eligible claim while its SQL response is paused", async () => {
    enqueue(db, "consistency-earlier", "consistency-r0", "reservation_confirmed");
    enqueue(db, "consistency-later", "consistency-r0", "reservation_reminder");
    db.sqlite.exec(`UPDATE notification_jobs SET available_at='2026-07-31T23:58:00.000Z',
      created_at='2026-07-31T23:58:00.000Z' WHERE id='consistency-earlier'`);
    const started = gate();
    const release = gate();
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql) => {
      if (!sql.includes("SET status = 'processing'")) return prepare(sql);
      return { bind: (...bindings: Array<string | number | null>) => ({ run: async () => {
        const result = await prepare(sql).bind(...bindings).run();
        if (bindings[2] === "consistency-earlier") { started.resolve(); await release.promise; }
        return result;
      } }) } as unknown as D1PreparedStatement;
    });
    const accepted: string[] = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      accepted.push((init?.headers as Record<string, string>)["X-Line-Retry-Key"]);
      return success();
    });
    const run = (jobId: string) => processDueLineNotificationJobs({
      db: db as unknown as D1Database, env, fetcher, now: () => NOW_MS,
      maxJobs: 1, jobIdsFilter: [jobId], _sleep: async () => {}
    });
    const earlier = run("consistency-earlier");
    await started.promise;
    let overtakingSends = 0;
    try { await run("consistency-later"); overtakingSends = accepted.length; }
    finally { release.resolve(); await earlier; }
    expect(overtakingSends).toBe(0);
    await run("consistency-later");
    expect(accepted).toEqual(["consistency-earlier", "consistency-later"]);
  });

  it("waits for an earlier retry outside the ready window, then drains both jobs in order", async () => {
    enqueue(db, "consistency-retry", "consistency-r0", "reservation_confirmed");
    enqueue(db, "consistency-after-retry", "consistency-r0", "reservation_reminder");
    db.sqlite.exec(`UPDATE notification_jobs SET status='retryable', attempts=1,
      available_at='2026-08-01T00:05:00.000Z' WHERE id='consistency-retry'`);
    const accepted: string[] = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      accepted.push((init?.headers as Record<string, string>)["X-Line-Retry-Key"]);
      return success();
    });
    const run = (nowMs: number) => processDueLineNotificationJobs({
      db: db as unknown as D1Database, env, fetcher, now: () => nowMs, maxJobs: 5, _sleep: async () => {}
    });
    expect((await run(NOW_MS)).processed).toBe(0);
    await run(NOW_MS + 5 * 60_000);
    expect(accepted).toEqual(["consistency-retry", "consistency-after-retry"]);
  });

  it("does not let an ineligible predecessor outside the job filter block a cancellation", async () => {
    enqueue(db, "consistency-obsolete", "consistency-r0", "reservation_confirmed");
    enqueue(db, "consistency-cancel", "consistency-r0", "reservation_cancelled_by_admin");
    db.sqlite.exec("UPDATE reservations SET status='cancelled_by_admin', version=2 WHERE id='consistency-r0'");
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => success());
    await processDueLineNotificationJobs({
      db: db as unknown as D1Database, env, fetcher, now: () => NOW_MS,
      maxJobs: 1, jobIdsFilter: ["consistency-cancel"], _sleep: async () => {}
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((fetcher.mock.calls[0][1]?.headers as Record<string, string>)["X-Line-Retry-Key"]).toBe("consistency-cancel");
  });

  it("supersedes a reminder changed during quota reservation and releases only its unused slot", async () => {
    seedReservation(db, 1);
    seedReservation(db, 2);
    db.sqlite.prepare(`INSERT INTO line_quota_snapshots (year_month,total_usage,quota_value,fetched_at)
      VALUES ('2026-08',178,200,?)`).run(NOW_ISO);
    enqueue(db, "consistency-stale-quota", "consistency-r0", "reservation_reminder");
    db.sqlite.exec("UPDATE notification_jobs SET dedupe_key='reminder:revision:1' WHERE id='consistency-stale-quota'");
    const started = gate();
    const release = gate();
    const prepare = db.prepare.bind(db);
    let paused = false;
    vi.spyOn(db, "prepare").mockImplementation((sql) => {
      if (!sql.includes("'started', 'line_notification_quota'")) return prepare(sql);
      return { bind: (...bindings: Array<string | number | null>) => ({ run: async () => {
        const result = await prepare(sql).bind(...bindings).run();
        if (!paused) { paused = true; started.resolve(); await release.promise; }
        return result;
      } }) } as unknown as D1PreparedStatement;
    });
    const accepted: string[] = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      accepted.push((init?.headers as Record<string, string>)["X-Line-Retry-Key"]);
      return success();
    });
    const run = (jobId: string) => processDueLineNotificationJobs({
      db: db as unknown as D1Database, env, fetcher, now: () => NOW_MS,
      maxJobs: 1, jobIdsFilter: [jobId], _sleep: async () => {}
    });
    const stale = run("consistency-stale-quota");
    await started.promise;
    db.sqlite.exec(`UPDATE reservations SET start_at='2026-09-01T00:25:00.000Z',
      end_at='2026-09-01T01:25:00.000Z',version=2 WHERE id='consistency-r0'`);
    release.resolve();
    await stale;
    expect(accepted).toEqual([]);
    expect(db.sqlite.prepare("SELECT status,last_error FROM notification_jobs WHERE id='consistency-stale-quota'").get())
      .toEqual({ status: "succeeded", last_error: "superseded_by_reservation_state" });
    enqueue(db, "consistency-free-one", "consistency-r1", "reservation_reminder");
    enqueue(db, "consistency-free-two", "consistency-r2", "reservation_reminder");
    await run("consistency-free-one");
    await run("consistency-free-two");
    expect(accepted).toEqual(["consistency-free-one", "consistency-free-two"]);
  });

  it("retains an earlier unknown reservation when a retry becomes stale at the final gate", async () => {
    seedReservation(db, 1);
    db.sqlite.prepare(`INSERT INTO line_quota_snapshots (year_month,total_usage,quota_value,fetched_at)
      VALUES ('2026-08',179,200,?)`).run(NOW_ISO);
    enqueue(db, "consistency-old-unknown", "consistency-r0", "reservation_reminder");
    db.sqlite.exec("UPDATE notification_jobs SET dedupe_key='unknown:revision:1' WHERE id='consistency-old-unknown'");
    let clock = NOW_MS;
    const fetcher = vi.fn(async () => { throw new Error("provider acceptance unknown"); });
    const run = (jobId: string) => processDueLineNotificationJobs({
      db: db as unknown as D1Database, env, fetcher, now: () => clock,
      maxJobs: 1, jobIdsFilter: [jobId], _sleep: async () => {}
    });
    await run("consistency-old-unknown");
    const started = gate();
    const release = gate();
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql) => {
      if (!sql.includes("'started', 'line_notification_quota'")) return prepare(sql);
      return { bind: (...bindings: Array<string | number | null>) => ({ run: async () => {
        const result = await prepare(sql).bind(...bindings).run();
        started.resolve(); await release.promise;
        return result;
      } }) } as unknown as D1PreparedStatement;
    });
    clock += 5 * 60_000;
    const retry = run("consistency-old-unknown");
    await started.promise;
    db.sqlite.exec(`UPDATE reservations SET start_at='2026-09-01T00:25:00.000Z',
      end_at='2026-09-01T01:25:00.000Z',version=2 WHERE id='consistency-r0'`);
    release.resolve();
    await retry;
    enqueue(db, "consistency-unknown-held", "consistency-r1", "reservation_reminder");
    await run("consistency-unknown-held");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(db.sqlite.prepare("SELECT status,last_error FROM notification_jobs WHERE id='consistency-old-unknown'").get())
      .toEqual({ status: "succeeded", last_error: "superseded_by_reservation_state" });
  });

  it("renders a still-eligible change from the final validated reservation snapshot", async () => {
    db.sqlite.prepare(`INSERT INTO line_quota_snapshots (year_month,total_usage,quota_value,fetched_at)
      VALUES ('2026-08',178,200,?)`).run(NOW_ISO);
    enqueue(db, "consistency-fresh-body", "consistency-r0");
    const started = gate();
    const release = gate();
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql) => {
      if (!sql.includes("'started', 'line_notification_quota'")) return prepare(sql);
      return { bind: (...bindings: Array<string | number | null>) => ({ run: async () => {
        const result = await prepare(sql).bind(...bindings).run();
        started.resolve(); await release.promise;
        return result;
      } }) } as unknown as D1PreparedStatement;
    });
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => success());
    const pending = processDueLineNotificationJobs({
      db: db as unknown as D1Database, env, fetcher, now: () => NOW_MS,
      maxJobs: 1, jobIdsFilter: ["consistency-fresh-body"], _sleep: async () => {}
    });
    await started.promise;
    db.sqlite.exec(`UPDATE reservations SET start_at='2026-09-01T00:25:00.000Z',
      end_at='2026-09-01T01:25:00.000Z',version=2 WHERE id='consistency-r0'`);
    release.resolve();
    await pending;
    expect(fetcher).toHaveBeenCalledTimes(1);
    const text = JSON.parse(fetcher.mock.calls[0][1]?.body as string).messages[0].text;
    expect(text).toContain("2026/09/01 09:25");
    expect(text).not.toContain("2026/08/01");
  });

  it.each(["cancelled", "started"])("rechecks %s eligibility after a paused quota write", async (change) => {
    db.sqlite.prepare(`INSERT INTO line_quota_snapshots (year_month,total_usage,quota_value,fetched_at)
      VALUES ('2026-08',178,200,?)`).run(NOW_ISO);
    enqueue(db, "consistency-final-state", "consistency-r0",
      change === "cancelled" ? "reservation_confirmed" : "reservation_reminder");
    const started = gate();
    const release = gate();
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql) => {
      if (!sql.includes("'started', 'line_notification_quota'")) return prepare(sql);
      return { bind: (...bindings: Array<string | number | null>) => ({ run: async () => {
        const result = await prepare(sql).bind(...bindings).run();
        started.resolve(); await release.promise;
        return result;
      } }) } as unknown as D1PreparedStatement;
    });
    let clock = NOW_MS;
    const fetcher = vi.fn(async () => success());
    const pending = processDueLineNotificationJobs({
      db: db as unknown as D1Database, env, fetcher, now: () => clock,
      maxJobs: 1, jobIdsFilter: ["consistency-final-state"], _sleep: async () => {}
    });
    await started.promise;
    if (change === "cancelled") {
      db.sqlite.exec("UPDATE reservations SET status='cancelled_by_admin', version=2 WHERE id='consistency-r0'");
    } else { clock += 30 * 60_000; }
    release.resolve();
    await pending;
    expect(fetcher).not.toHaveBeenCalled();
    expect(db.sqlite.prepare("SELECT status,last_error FROM notification_jobs WHERE id='consistency-final-state'").get())
      .toEqual({ status: "succeeded", last_error: "superseded_by_reservation_state" });
  });

  it("does not release an earlier unknown slot when its retry is definitively rejected", async () => {
    seedReservation(db, 1);
    db.sqlite.prepare(`INSERT INTO line_quota_snapshots (year_month,total_usage,quota_value,fetched_at)
      VALUES ('2026-08',179,200,?)`).run(NOW_ISO);
    enqueue(db, "consistency-rejected-retry", "consistency-r0", "reservation_reminder");
    enqueue(db, "consistency-reserved-budget", "consistency-r1", "reservation_reminder");
    let clock = NOW_MS;
    let attempts = 0;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const jobId = (init?.headers as Record<string, string>)["X-Line-Retry-Key"];
      if (jobId !== "consistency-rejected-retry") return success();
      attempts += 1;
      if (attempts === 1) throw new Error("provider acceptance unknown");
      return new Response("Unauthorized", { status: 401 });
    });
    const run = (jobId: string) => processDueLineNotificationJobs({
      db: db as unknown as D1Database, env, fetcher, now: () => clock,
      maxJobs: 1, jobIdsFilter: [jobId], _sleep: async () => {}
    });
    await run("consistency-rejected-retry");
    clock += 5 * 60_000;
    await run("consistency-rejected-retry");
    await run("consistency-reserved-budget");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
