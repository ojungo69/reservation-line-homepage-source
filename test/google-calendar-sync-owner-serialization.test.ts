import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdminUser } from "../src/admin/access";
import { createAdminReservation } from "../src/admin/reservation-create";
import { rescheduleAdminReservation } from "../src/admin/reservation-reschedule";
import { runAdminReservationAction } from "../src/admin/reservations";
import { processDueCalendarSyncJobs } from "../src/google/calendar-sync";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const NOW_MS = Date.parse("2026-05-09T23:00:00.000Z");
const OLD_START = "2026-06-01T01:00:00.000Z";
const NEW_START = "2026-06-01T03:00:00.000Z";
const admin: AdminUser = { id: "calendar_owner", email: "calendar@example.invalid", role: "owner", staff_member_id: null, store_id: null };
const env = { GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar@example.iam.gserviceaccount.com", GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused" };

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

describe("Google sync owner serialization", () => {
  let db: SqliteD1Database;
  beforeEach(() => {
    db = createMigratedSqliteD1();
    db.sqlite.exec("INSERT INTO admin_users (id,email,access_subject,role,active) VALUES ('calendar_owner','calendar@example.invalid','calendar_owner','owner',1)");
  });
  afterEach(() => db.sqlite.close());

  const createReservation = async (key: string, startAt = OLD_START) => {
    const created = await createAdminReservation({
      db: db as unknown as D1Database, admin, now: () => NOW_MS,
      request: { idempotencyKey: key, source: "admin", storeId: "kyoto", serviceIds: ["service_kyoto_default_60"], resourceId: "resource_kyoto_calendar", startAt, customer: { displayName: "架空同期顧客", phone: "08099990001" } }
    });
    if (!created.ok) throw new Error(created.reason);
    db.sqlite.prepare("UPDATE reservations SET google_event_id=?,google_sync_state='synced' WHERE id=?")
      .run(`event_${created.reservationId}`, created.reservationId);
    const job = db.sqlite.prepare("SELECT id FROM calendar_sync_jobs WHERE owner_id=?").get(created.reservationId);
    if (typeof job?.id !== "string") throw new Error("missing sync job");
    return { reservationId: created.reservationId, jobId: job.id };
  };

  const moveReservation = async (reservationId: string) => {
    const moved = await rescheduleAdminReservation({ db: db as unknown as D1Database, admin, now: () => NOW_MS, reservationId, request: { idempotencyKey: "move", startAt: NEW_START } });
    expect(moved.ok).toBe(true);
    const job = db.sqlite.prepare("SELECT id FROM calendar_sync_jobs WHERE owner_id=? AND dedupe_key LIKE '%revision:2'").get(reservationId);
    if (typeof job?.id !== "string") throw new Error("missing moved sync job");
    return job.id;
  };

  const process = (fetcher: typeof fetch, jobIdsFilter?: string[], maxJobs = 1) => processDueCalendarSyncJobs({
    db: db as unknown as D1Database, env, fetcher, jobIdsFilter, maxJobs, now: () => NOW_MS, accessTokenProvider: async () => "fixture_token"
  });

  const pauseJobRead = (jobId: string) => {
    const selected = deferred();
    const resume = deferred();
    const prepare = db.prepare.bind(db);
    let paused = false;
    db.prepare = (sql) => {
      const statement = prepare(sql);
      const bind = statement.bind.bind(statement);
      statement.bind = (...values) => {
        const bound = bind(...values);
        if (!paused && sql.includes("calendar_sync_jobs.id AS job_id") && values.includes(jobId)) {
          const first = bound.first.bind(bound);
          bound.first = async <T>(column?: string) => {
            const row = column === undefined ? await first<T>() : await first<T>(column);
            paused = true;
            selected.resolve();
            await resume.promise;
            return row;
          };
        }
        return bound;
      };
      return statement;
    };
    return { selected, resume };
  };

  it("keeps a moved reservation queued while the old upsert runs, then writes the latest time", async () => {
    const first = await createReservation("first");
    const started = deferred();
    const release = deferred();
    const writes: string[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      const payload = JSON.parse(String(init?.body));
      if (payload.start.dateTime === OLD_START) { started.resolve(); await release.promise; }
      writes.push(payload.start.dateTime);
      return Response.json({ id: `event_${first.reservationId}` });
    };
    const old = process(fetcher, [first.jobId]);
    await started.promise;
    let nextId: string;
    try {
      nextId = await moveReservation(first.reservationId);
      expect(await process(fetcher, [nextId])).toEqual({ processed: 0, succeeded: 0, failed: 0 });
      expect(db.sqlite.prepare("SELECT status,attempts FROM calendar_sync_jobs WHERE id=?").get(nextId)).toEqual({ status: "queued", attempts: 0 });
    } finally {
      release.resolve();
      await old;
    }
    expect(db.sqlite.prepare("SELECT google_sync_state FROM reservations WHERE id=?").get(first.reservationId)).toEqual({ google_sync_state: "pending" });
    expect(await process(fetcher, [nextId])).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    expect(writes).toEqual([OLD_START, NEW_START]);
    expect(db.sqlite.prepare("SELECT start_at,google_sync_state FROM reservations WHERE id=?").get(first.reservationId)).toEqual({ start_at: NEW_START, google_sync_state: "synced" });
  });

  it("rechecks owner ownership atomically when two invocations select different jobs together", async () => {
    const first = await createReservation("first");
    const secondId = crypto.randomUUID();
    db.sqlite.prepare("INSERT INTO calendar_sync_jobs (id,dedupe_key,owner_type,owner_id,google_action,status,available_at) VALUES (?,?,'reservation',?,'upsert','queued',?)")
      .run(secondId, secondId, first.reservationId, new Date(NOW_MS).toISOString());
    const started = deferred();
    const release = deferred();
    let writes = 0;
    const fetcher: typeof fetch = async () => {
      writes += 1;
      if (writes === 1) { started.resolve(); await release.promise; }
      return Response.json({ id: `event_${first.reservationId}` });
    };
    const firstRun = process(fetcher, [first.jobId]);
    const secondRun = process(fetcher, [secondId]);
    await started.promise;
    try {
      expect(await secondRun).toEqual({ processed: 0, succeeded: 0, failed: 0 });
      expect(writes).toBe(1);
    } finally {
      release.resolve();
      await Promise.all([firstRun, secondRun]);
    }
    expect(db.sqlite.prepare("SELECT status,attempts FROM calendar_sync_jobs WHERE id=?").get(secondId)).toEqual({ status: "queued", attempts: 0 });
    expect(await process(fetcher, [secondId])).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    expect(writes).toBe(2);
  });

  it("skips a blocked owner in global scans so a different reservation can still sync", async () => {
    const first = await createReservation("first");
    const started = deferred();
    const release = deferred();
    const owners: string[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      const payload = JSON.parse(String(init?.body));
      const ownerId = payload.extendedProperties.private.reservation_id;
      if (ownerId === first.reservationId && payload.start.dateTime === OLD_START) { started.resolve(); await release.promise; }
      owners.push(ownerId);
      return Response.json({ id: `event_${ownerId}` });
    };
    const old = process(fetcher, [first.jobId]);
    await started.promise;
    try {
      const nextId = await moveReservation(first.reservationId);
      const other = await createReservation("other", "2026-06-01T05:00:00.000Z");
      expect(await process(fetcher, undefined, 2)).toEqual({ processed: 1, succeeded: 1, failed: 0 });
      expect(owners).toEqual([other.reservationId]);
      expect(db.sqlite.prepare("SELECT status FROM calendar_sync_jobs WHERE id=?").get(nextId)).toEqual({ status: "queued" });
    } finally {
      release.resolve();
      await old;
    }
  });

  it("allows an expired same-owner lease to be recovered without blocking newer jobs", async () => {
    const first = await createReservation("first");
    db.sqlite.prepare("UPDATE calendar_sync_jobs SET status='processing',attempts=1,locked_until=? WHERE id=?")
      .run(new Date(NOW_MS - 1).toISOString(), first.jobId);
    const nextId = await moveReservation(first.reservationId);
    const fetcher: typeof fetch = async () => Response.json({ id: `event_${first.reservationId}` });

    expect(await process(fetcher, [nextId])).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    expect(db.sqlite.prepare("SELECT google_sync_state FROM reservations WHERE id=?").get(first.reservationId)).toEqual({ google_sync_state: "pending" });
    expect(await process(fetcher, [first.jobId])).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    expect(db.sqlite.prepare("SELECT status,attempts FROM calendar_sync_jobs WHERE id=?").get(first.jobId)).toEqual({ status: "succeeded", attempts: 2 });
  });

  it("stays synced when an exhausted old lease expires just after the reaper and dies next tick", async () => {
    const first = await createReservation("first");
    db.sqlite.prepare("UPDATE calendar_sync_jobs SET status='processing',attempts=5,locked_until=? WHERE id=?")
      .run(new Date(NOW_MS + 1).toISOString(), first.jobId);
    const nextId = await moveReservation(first.reservationId);
    let clock = NOW_MS;
    const prepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      const statement = prepare(sql);
      if (sql.includes("last_error = 'exhausted_after_repeated_crash'")) {
        const bind = statement.bind.bind(statement);
        statement.bind = (...values) => {
          const bound = bind(...values);
          const run = bound.run.bind(bound);
          bound.run = async <T>() => {
            const result = await run<T>();
            clock = NOW_MS + 2;
            return result;
          };
          return bound;
        };
      }
      return statement;
    };
    const fetcher: typeof fetch = async () => Response.json({ id: `event_${first.reservationId}` });
    const tick = () => processDueCalendarSyncJobs({ db: db as unknown as D1Database, env, fetcher, jobIdsFilter: [nextId], maxJobs: 1, now: () => clock, accessTokenProvider: async () => "fixture_token" });

    expect(await tick()).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    expect(db.sqlite.prepare("SELECT status FROM calendar_sync_jobs WHERE id=?").get(first.jobId)).toEqual({ status: "processing" });
    expect(await tick()).toEqual({ processed: 0, succeeded: 0, failed: 0 });
    expect(db.sqlite.prepare("SELECT status FROM calendar_sync_jobs WHERE id=?").get(first.jobId)).toEqual({ status: "dead" });
    expect(db.sqlite.prepare("SELECT start_at,google_sync_state FROM reservations WHERE id=?").get(first.reservationId))
      .toEqual({ start_at: NEW_START, google_sync_state: "synced" });
  });

  it("keeps a same-owner delete queued during an upsert and preserves cancellation cleanup", async () => {
    const first = await createReservation("first");
    const started = deferred();
    const release = deferred();
    const methods: string[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      const method = init?.method ?? "GET";
      if (method === "PATCH") { started.resolve(); await release.promise; }
      methods.push(method);
      if (method === "DELETE") return new Response(null, { status: 204 });
      if (method === "GET") return Response.json({ items: [] });
      return Response.json({ id: `event_${first.reservationId}` });
    };
    const old = process(fetcher, [first.jobId]);
    await started.promise;
    let deleteId: string;
    try {
      const cancelled = await runAdminReservationAction({ db: db as unknown as D1Database, env: {}, admin, reservationId: first.reservationId, action: "cancel", request: { idempotencyKey: "cancel", reason: "取消" }, now: () => NOW_MS });
      expect(cancelled.ok).toBe(true);
      const job = db.sqlite.prepare("SELECT id FROM calendar_sync_jobs WHERE owner_id=? AND google_action='delete'").get(first.reservationId);
      if (typeof job?.id !== "string") throw new Error("missing delete job");
      deleteId = job.id;
      expect(await process(fetcher, [deleteId])).toEqual({ processed: 0, succeeded: 0, failed: 0 });
    } finally {
      release.resolve();
      await old;
    }
    expect(await process(fetcher, [deleteId])).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    expect(methods).toEqual(["PATCH", "DELETE"]);
    expect(db.sqlite.prepare("SELECT status,google_event_id FROM reservations WHERE id=?").get(first.reservationId)).toEqual({ status: "cancelled_by_admin", google_event_id: null });
  });

  it.each(["reschedule", "rename"])("re-reads the owner after claiming when a newer %s job completed after the original SELECT", async (change) => {
    const first = await createReservation("first");
    const held = pauseJobRead(first.jobId);
    const writes: Array<{ start: string; summary: string }> = [];
    const fetcher: typeof fetch = async (_url, init) => {
      const payload = JSON.parse(String(init?.body));
      writes.push({ start: payload.start.dateTime, summary: payload.summary });
      return Response.json({ id: `event_${first.reservationId}` });
    };
    const old = process(fetcher, [first.jobId]);
    await held.selected.promise;
    try {
      let nextId: string;
      if (change === "reschedule") {
        nextId = await moveReservation(first.reservationId);
      } else {
        db.sqlite.prepare("UPDATE customers SET display_name='最新の顧客名' WHERE id=(SELECT customer_id FROM reservations WHERE id=?)").run(first.reservationId);
        nextId = crypto.randomUUID();
        db.sqlite.prepare("INSERT INTO calendar_sync_jobs (id,dedupe_key,owner_type,owner_id,google_action,status,available_at) VALUES (?,?,'reservation',?,'upsert','queued',?)")
          .run(nextId, nextId, first.reservationId, new Date(NOW_MS).toISOString());
        expect(db.sqlite.prepare("SELECT version FROM reservations WHERE id=?").get(first.reservationId)).toEqual({ version: 1 });
      }
      expect(await process(fetcher, [nextId])).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    } finally {
      held.resume.resolve();
      await old;
    }

    expect(writes.every((write) => write.start === (change === "reschedule" ? NEW_START : OLD_START))).toBe(true);
    if (change === "rename") expect(writes.every((write) => write.summary.endsWith("最新の顧客名"))).toBe(true);
    expect(db.sqlite.prepare("SELECT status,attempts FROM calendar_sync_jobs WHERE id=?").get(first.jobId)).toEqual({ status: "succeeded", attempts: 1 });
    expect(db.sqlite.prepare("SELECT google_sync_state FROM reservations WHERE id=?").get(first.reservationId)).toEqual({ google_sync_state: "synced" });
  });

  it("releases a claim without consuming an attempt when its owner disappeared after selection", async () => {
    const first = await createReservation("first");
    const held = pauseJobRead(first.jobId);
    let writes = 0;
    const fetcher: typeof fetch = async () => { writes += 1; return Response.json({}); };
    const old = process(fetcher, [first.jobId]);
    await held.selected.promise;
    db.sqlite.prepare("DELETE FROM reservations WHERE id=?").run(first.reservationId);
    held.resume.resolve();

    expect(await old).toEqual({ processed: 0, succeeded: 0, failed: 0 });
    expect(writes).toBe(0);
    expect(db.sqlite.prepare("SELECT status,attempts,locked_until FROM calendar_sync_jobs WHERE id=?").get(first.jobId))
      .toEqual({ status: "queued", attempts: 0, locked_until: null });
  });

  it("starts the five-minute lease at claim time after a slow selection", async () => {
    const first = await createReservation("first");
    const held = pauseJobRead(first.jobId);
    let clock = NOW_MS;
    let lockedUntil: unknown;
    const fetcher: typeof fetch = async () => {
      lockedUntil = db.sqlite.prepare("SELECT locked_until FROM calendar_sync_jobs WHERE id=?").get(first.jobId)?.locked_until;
      return Response.json({ id: `event_${first.reservationId}` });
    };
    const old = processDueCalendarSyncJobs({ db: db as unknown as D1Database, env, fetcher, jobIdsFilter: [first.jobId], maxJobs: 1, now: () => clock, accessTokenProvider: async () => "fixture_token" });
    await held.selected.promise;
    clock += 60_000;
    held.resume.resolve();

    expect(await old).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    expect(lockedUntil).toBe("2026-05-09T23:06:00.000Z");
  });

  it("leaves the real retry intact when another attempt finished after the old SELECT", async () => {
    const first = await createReservation("first");
    const held = pauseJobRead(first.jobId);
    let clock = NOW_MS;
    let writes = 0;
    const fetcher: typeof fetch = async () => { writes += 1; return Response.json({}, { status: 500 }); };
    const old = processDueCalendarSyncJobs({ db: db as unknown as D1Database, env, fetcher, jobIdsFilter: [first.jobId], maxJobs: 1, now: () => clock, accessTokenProvider: async () => "fixture_token" });
    await held.selected.promise;
    try {
      expect(await process(fetcher, [first.jobId])).toEqual({ processed: 1, succeeded: 0, failed: 1 });
      clock += 3_600_000;
    } finally {
      held.resume.resolve();
    }

    expect(await old).toEqual({ processed: 0, succeeded: 0, failed: 0 });
    expect(writes).toBe(1);
    expect(db.sqlite.prepare("SELECT status,attempts,locked_until FROM calendar_sync_jobs WHERE id=?").get(first.jobId))
      .toEqual({ status: "retryable", attempts: 1, locked_until: null });
  });
});
