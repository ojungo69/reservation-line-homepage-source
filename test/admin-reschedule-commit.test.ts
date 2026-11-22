import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import type { commitAdminRescheduleReservation } from "../src/admin/reservation-reschedule";
import {
  createAccessJwksFetchMock,
  createAccessJwtFixture,
  createAccessSigningKey,
  insertAdminUser,
  type AdminRole,
} from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const TEAM_DOMAIN = "https://team.example.cloudflareaccess.com";
const ACCESS_AUD = "admin-reschedule-commit-aud";
const CONTRACT = "calendar-interactions-v1";
const RESERVATION = "commit-reservation";
const CUSTOMER = "commit-customer";
const RESOURCE = "resource_kyoto_calendar";
const INITIAL_START = "2026-06-01T01:00:00.000Z";
const MOVE = { kind: "move", startAt: "2026-06-01T09:40:00+09:00" };
const KEY = createAccessSigningKey("commit-key");
const OFF = { bindings: { ADMIN_CALENDAR_V2_ENABLED: "false" } };

type RequestOptions = {
  token?: string | null;
  reservationId?: string;
  bindings?: Record<string, unknown>;
  headers?: Record<string, string>;
};

const expectError = async (response: Response, status: number, reason: string) => {
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toMatchObject({ ok: false, reason });
};

const readSuccess = async (response: Response) => {
  expect(response.status).toBe(200);
  return await response.json() as Extract<Awaited<ReturnType<typeof commitAdminRescheduleReservation>>, { ok: true }>;
};

const makeRequest = (previewFingerprint: string, intent: object, expectedVersion = 3) => ({
  contractVersion: CONTRACT,
  intent,
  expectedVersion,
  previewFingerprint,
  idempotencyKey: `calendar-v1:${randomUUID()}:${createHash("sha256").update(previewFingerprint).digest("hex")}`,
});

const pause = () => {
  let release!: () => void;
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  return { entered, release, wait: async () => { enter(); await released; } };
};

describe("admin reservation reschedule commit", () => {
  let db: SqliteD1Database;
  let ownerToken: string;

  const seedActor = (id: string, role: AdminRole = "owner", staffMemberId?: string) => {
    const email = `${id}@example.com`;
    const sub = `${id}-subject`;
    insertAdminUser(db, { id, email, accessSubject: sub, role, staffMemberId });
    return createAccessJwtFixture({
      issuer: TEAM_DOMAIN, audience: ACCESS_AUD, keyId: KEY.jwk.kid, signingKey: KEY,
      claims: { email, sub, exp: Date.parse("2026-06-04T00:00:00Z") / 1000 },
    }).token;
  };

  const post = (endpoint: string, body: unknown, {
    token = ownerToken, reservationId = RESERVATION, bindings = {}, headers = {},
  }: RequestOptions = {}) => createApp().request(
    `/api/admin/reservations/${reservationId}/reschedule${endpoint}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { "Cf-Access-Jwt-Assertion": token } : {}), ...headers },
      body: JSON.stringify(body),
    },
    { DB: db, ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD,
      ENVIRONMENT: "staging", ADMIN_CALENDAR_V2_ENABLED: "true", ...bindings },
  );

  const confirm = async (intent: object = MOVE, expectedVersion = 3, options?: RequestOptions) => {
    const response = await post("/preview", { contractVersion: CONTRACT, expectedVersion, intent }, options);
    expect(response.status).toBe(200);
    const { previewFingerprint } = await response.json() as { previewFingerprint: string };
    return makeRequest(previewFingerprint, intent, expectedVersion);
  };

  const domainState = () => Object.fromEntries([
    "reservations", "slot_locks", "customer_time_locks", "slot_lock_history", "audit_logs",
    "idempotency_keys", "notification_jobs", "calendar_sync_jobs",
  ].map((table) => [table, db.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));

  const operations = () => db.sqlite.prepare("SELECT * FROM reservation_change_operations ORDER BY rowid").all();

  const holdNextBatch = () => {
    const batch = db.batch.bind(db);
    const held = pause();
    vi.spyOn(db, "batch").mockImplementationOnce(async (statements) => {
      await held.wait();
      return batch(statements);
    });
    return held;
  };

  const holdNextStatement = (sqlFragment: string, timing: "beforeRun" | "afterFirst") => {
    const prepare = db.prepare.bind(db);
    const held = pause();
    let intercepted = false;
    db.prepare = (sql) => {
      const statement = prepare(sql);
      if (intercepted || !sql.includes(sqlFragment)) return statement;
      intercepted = true;
      const bind = statement.bind.bind(statement);
      statement.bind = (...values) => {
        const bound = bind(...values);
        if (timing === "beforeRun") {
          const run = bound.run.bind(bound);
          bound.run = async <T>() => { await held.wait(); return run<T>(); };
        } else {
          const first = bound.first.bind(bound);
          bound.first = async <T>() => { const row = await first<T>(); await held.wait(); return row; };
        }
        return bound;
      };
      return statement;
    };
    return held;
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
    db = createMigratedSqliteD1();
    ownerToken = seedActor("commit-owner");
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, KEY.jwk));

    db.sqlite.exec(`
      UPDATE store_business_hours SET opens_at = '09:30' WHERE weekday = 1;
      INSERT INTO customers (id, display_name, phone_normalized, phone_hash, block_status)
        VALUES ('commit-customer', 'Commit Customer', '0750000001', 'commit-phone', 'active');
      INSERT INTO line_identities (id, customer_id, channel_id, line_user_id)
        VALUES ('commit-line', 'commit-customer', 'commit-channel', 'commit-line-user');
      INSERT INTO reservations (
        id, store_id, service_id, customer_id, resource_id, line_identity_id, source,
        status, start_at, end_at, duration_minutes, created_by, updated_by, idempotency_key, version
      ) VALUES ('commit-reservation', 'kyoto', 'service_kyoto_default_60', 'commit-customer',
        'resource_kyoto_calendar', 'commit-line', 'admin', 'confirmed', '2026-06-01T01:00:00.000Z',
        '2026-06-01T02:00:00.000Z', 60, 'fixture', 'fixture', 'commit-fixture', 3);
      INSERT INTO slot_locks (id, store_id, resource_id, slot_at, owner_type, owner_id, lock_status)
        VALUES ('old-slot', 'kyoto', 'resource_kyoto_calendar', '2026-06-01T01:00:00.000Z',
          'reservation', 'commit-reservation', 'confirmed');
      INSERT INTO customer_time_locks (id, customer_id, slot_at, owner_type, owner_id, lock_status, phone_hash)
        VALUES ('old-customer-slot', 'commit-customer', '2026-06-01T01:00:00.000Z',
          'reservation', 'commit-reservation', 'confirmed', 'commit-phone');
    `);
  });

  afterEach(() => {
    db.sqlite.close();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("API-18 applies a confirmed move with one audit mark and one job per queue", async () => {
    const result = await readSuccess(await post("/commit", await confirm()));
    expect(result).toEqual({
      ok: true, contractVersion: CONTRACT, replayed: false, operationId: expect.any(String),
      change: {
        beforeVersion: 3, appliedVersion: 4,
        before: {
          startAt: INITIAL_START, treatmentEndAt: "2026-06-01T01:55:00.000Z", endAt: "2026-06-01T02:00:00.000Z",
          occupancyMinutes: 60, treatmentMinutes: 55,
        },
        after: {
          startAt: "2026-06-01T00:40:00.000Z", treatmentEndAt: "2026-06-01T01:35:00.000Z",
          endAt: "2026-06-01T01:40:00.000Z", occupancyMinutes: 60, treatmentMinutes: 55,
        },
      },
      reservation: { id: RESERVATION, version: 4, status: "confirmed", storeId: "kyoto", resourceId: RESOURCE,
        startAt: "2026-06-01T00:40:00.000Z", endAt: "2026-06-01T01:40:00.000Z", occupancyMinutes: 60 },
      effects: {
        notification: { kind: "time_changed", reason: "start_changed", jobId: expect.any(String), status: "queued" },
        calendar: { kind: "enqueue_upsert", jobId: expect.any(String), status: "queued" },
      },
    });
    expect(db.sqlite.prepare("SELECT updated_by FROM reservations WHERE id = ?").get(RESERVATION))
      .toEqual({ updated_by: "commit-owner" });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM slot_locks WHERE owner_id = ?").get(RESERVATION))
      .toEqual({ count: 12 });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM customer_time_locks WHERE owner_id = ?").get(RESERVATION))
      .toEqual({ count: 12 });
    expect(db.sqlite.prepare("SELECT action, actor_id FROM audit_logs WHERE id = ?").get(result.operationId))
      .toEqual({ action: "admin_reservation_rescheduled", actor_id: "commit-owner" });
    expect(db.sqlite.prepare("SELECT status, before_version, applied_version FROM reservation_change_operations").all())
      .toEqual([{ status: "succeeded", before_version: 3, applied_version: 4 }]);
    expect(db.sqlite.prepare("SELECT id, dedupe_key FROM notification_jobs").all()).toEqual([{
      id: result.effects.notification.jobId,
      dedupe_key: "reservation:commit-reservation:template:reservation_time_changed:revision:4",
    }]);
    expect(db.sqlite.prepare("SELECT id, dedupe_key FROM calendar_sync_jobs").all()).toEqual([{
      id: result.effects.calendar.jobId, dedupe_key: "reservation:commit-reservation:google:upsert:revision:4",
    }]);
  });

  it("API-27 records not_applied when check arrives before the commit claims its key", async () => {
    const request = await confirm();
    const before = domainState();

    await expectError(await post("/commit?mode=check", request), 409, "operation_not_applied");
    expect(operations()).toEqual([expect.objectContaining({ status: "not_applied", applied_version: null })]);
    const afterCheck = operations();
    await expectError(await post("/commit", request), 409, "operation_not_applied");
    expect(operations()).toEqual(afterCheck);
    expect(domainState()).toEqual(before);
  });

  it("API-27 closes a started operation with check before the batch and leaves all domain tables untouched", async () => {
    const request = await confirm();
    const before = domainState();
    const held = holdNextBatch();
    const commit = post("/commit", request);

    try {
      await held.entered;
      expect(operations()).toEqual([expect.objectContaining({ status: "started" })]);
      await expectError(await post("/commit", request), 409, "idempotency_in_progress");
      await expectError(await post("/commit?mode=check", request), 409, "operation_not_applied");
    } finally {
      held.release();
    }

    await expectError(await commit, 409, "operation_not_applied");
    expect(operations()).toEqual([expect.objectContaining({ status: "not_applied", applied_version: null })]);
    expect(domainState()).toEqual(before);
  });

  it("API-04/27 applies only one of two commits from version 3 and finalizes the loser", async () => {
    const first = await confirm();
    const secondToken = seedActor("second-owner");
    const second = await confirm({ kind: "move", startAt: "2026-06-01T10:45:00+09:00" }, 3, { token: secondToken });
    const held = holdNextBatch();
    const loser = post("/commit", first);
    await held.entered;

    let afterWinner;
    try {
      const winner = await post("/commit", second, { token: secondToken });
      expect(winner.status).toBe(200);
      await expect(winner.json()).resolves.toMatchObject({
        reservation: { startAt: "2026-06-01T01:45:00.000Z", version: 4 },
      });
      afterWinner = domainState();
    } finally {
      held.release();
    }

    const lost = await loser;
    expect(lost.status).toBe(409);
    await expect(lost.json()).resolves.toEqual({ ok: false, reason: "version_conflict", version: 4, status: "confirmed" });
    expect(domainState()).toEqual(afterWinner);
    expect(afterWinner.notification_jobs).toHaveLength(1);
    expect(afterWinner.calendar_sync_jobs).toHaveLength(1);
    expect(operations()).toEqual([
      expect.objectContaining({ actor_id: "commit-owner", status: "not_applied", applied_version: null }),
      expect.objectContaining({ actor_id: "second-owner", status: "succeeded", applied_version: 4 }),
    ]);
    await expectError(await post("/commit?mode=check", first), 409, "operation_not_applied");
  });

  it.each(["new", "legacy"] as const)("API-27 the %s writer can win a race with the other API", async (winner) => {
    const request = await confirm();
    const legacy = { idempotencyKey: "legacy-overlap", startAt: MOVE.startAt };
    const win = winner === "new" ? () => post("/commit", request) : () => post("", legacy);
    const lose = winner === "new" ? () => post("", legacy) : () => post("/commit", request);
    const held = holdNextBatch();
    const loser = lose();
    await held.entered;
    let afterWinner;
    try {
      expect((await win()).status).toBe(200);
      afterWinner = domainState();
    } finally {
      held.release();
    }
    expect((await loser).status).toBe(winner === "new" ? 500 : 409);
    expect(domainState()).toEqual(afterWinner);
    expect(afterWinner.reservations).toEqual([expect.objectContaining({ version: 4, start_at: "2026-06-01T00:40:00.000Z" })]);
    expect(afterWinner.notification_jobs).toEqual([expect.objectContaining({
      dedupe_key: "reservation:commit-reservation:template:reservation_time_changed:revision:4",
    })]);
    expect(afterWinner.calendar_sync_jobs).toEqual([expect.objectContaining({
      dedupe_key: "reservation:commit-reservation:google:upsert:revision:4",
    })]);
    expect(afterWinner.audit_logs).toHaveLength(1);
  });

  it.each([
    ["success record", "BEFORE UPDATE OF status ON reservation_change_operations WHEN NEW.status = 'succeeded'"],
    ["audit mark", "BEFORE INSERT ON audit_logs WHEN NEW.action = 'admin_reservation_rescheduled'"],
  ])("API-27 rolls back the entire batch when the %s is silently skipped", async (_record, trigger) => {
    const request = await confirm();
    const before = domainState();
    db.sqlite.exec(`CREATE TRIGGER skip_required_record ${trigger} BEGIN SELECT RAISE(IGNORE); END`);

    await expectError(await post("/commit", request), 500, "write_failed");
    expect(domainState()).toEqual(before);
    expect(operations()).toEqual([expect.objectContaining({ status: "started", applied_version: null })]);
    await expectError(await post("/commit?mode=check", request), 409, "operation_not_applied");
    expect(domainState()).toEqual(before);
  });

  it("API-14/27 replays a committed batch whose response was lost without creating any jobs", async () => {
    const request = await confirm();
    const batch = db.batch.bind(db);
    vi.spyOn(db, "batch").mockImplementationOnce(async (statements) => {
      await batch(statements);
      throw new Error("simulated D1 response loss");
    });

    await expectError(await post("/commit", request), 500, "write_failed");
    const afterCommit = domainState();
    const changeOperations = operations();
    expect(changeOperations).toEqual([expect.objectContaining({ status: "succeeded", applied_version: 4 })]);
    const checked = await post("/commit?mode=check", {
      ...request, intent: { kind: "move", startAt: "2026-06-01T00:40:00Z" },
    });
    expect(checked.status).toBe(200);
    await expect(checked.json()).resolves.toMatchObject({
      ok: true, replayed: true,
      change: { beforeVersion: 3, appliedVersion: 4 },
      reservation: { version: 4, startAt: "2026-06-01T00:40:00.000Z" },
    });
    expect(domainState()).toEqual(afterCommit);
    expect(operations()).toEqual(changeOperations);
  });

  it("API-27 keeps started when the batch has no known result and lets a check settle it", async () => {
    const request = await confirm();
    const before = domainState();
    vi.spyOn(db, "batch").mockRejectedValueOnce(new Error("simulated D1 connection failure"));

    await expectError(await post("/commit", request), 500, "write_failed");
    expect(operations()).toEqual([expect.objectContaining({ status: "started" })]);
    expect(domainState()).toEqual(before);
    await expectError(await post("/commit?mode=check", request), 409, "operation_not_applied");
    await expectError(await post("/commit", request), 409, "operation_not_applied");
    expect(domainState()).toEqual(before);
  });

  it("API-20/21 commits the inverse of a successful move as a new audited and notified operation", async () => {
    const { operationId } = await readSuccess(await post("/commit", await confirm()));
    const undoRequest = await confirm({ kind: "undo", inverseOfOperationId: operationId }, 4);
    const undone = await readSuccess(await post("/commit", undoRequest));
    expect(undone).toMatchObject({
      ok: true, replayed: false,
      change: { beforeVersion: 4, appliedVersion: 5, after: { startAt: INITIAL_START, occupancyMinutes: 60 } },
      reservation: { version: 5, startAt: INITIAL_START },
      effects: { notification: { kind: "time_changed", status: "queued" }, calendar: { status: "queued" } },
    });
    expect(undone.operationId).not.toBe(operationId);
    expect(operations()).toEqual([
      expect.objectContaining({ operation_id: operationId, kind: "move", inverse_of_operation_id: null, status: "succeeded" }),
      expect.objectContaining({ operation_id: undone.operationId, kind: "undo", inverse_of_operation_id: operationId,
        status: "succeeded", applied_version: 5 }),
    ]);
    expect(domainState().audit_logs).toHaveLength(2);
    expect(domainState().notification_jobs).toHaveLength(2);
    expect(domainState().calendar_sync_jobs).toHaveLength(2);
  });

  it("API-03/04/11 rejects malformed, cross-resource, stale-version and unknown-mode requests without writes", async () => {
    const request = await confirm();
    const before = domainState();
    for (const body of [
      { ...request, expectedVersion: undefined },
      { ...request, expectedVersion: "3" },
      { ...request, expectedVersion: 0 },
      { ...request, contractVersion: undefined },
      { ...request, idempotencyKey: undefined },
      { ...request, idempotencyKey: "legacy-key" },
      { ...request, previewFingerprint: undefined },
      { ...request, previewFingerprint: "short" },
      { ...request, storeId: "osaka" },
      { ...request, resourceId: "resource_osaka_calendar" },
      { ...request, intent: { ...MOVE, staffId: "staff_owner_osaka" } },
      { ...request, intent: { kind: "cancel" } },
      { ...request, intent: { ...MOVE, treatmentMinutes: 45 } },
    ]) {
      await expectError(await post("/commit", body), 400, "invalid_request");
    }
    await expectError(await post("/commit", { ...request, contractVersion: "v2" }), 400, "unsupported_contract");
    for (const query of ["?mode=save", "?mode=", "?mode=check&mode=check", "?mode=check&%6dode=check"]) {
      await expectError(await post(`/commit${query}`, request), 400, "invalid_request");
    }
    await expectError(await post("/commit", { ...request, expectedVersion: 2 }), 409, "version_conflict");
    expect(domainState()).toEqual(before);
    expect(operations()).toEqual([]);
  });

  it("API-17 applies current store authorization before replay or check", async () => {
    const token = seedActor("moving-staff", "staff", "staff_owner_kyoto");
    const request = await confirm(MOVE, 3, { token });
    const legacy = { idempotencyKey: "legacy-success", startAt: "2026-06-01T10:45:00+09:00" };
    await readSuccess(await post("/commit", request, { token }));
    expect((await post("", legacy, { token })).status).toBe(200);
    db.sqlite.prepare("UPDATE admin_users SET staff_member_id = 'staff_owner_osaka' WHERE id = 'moving-staff'").run();

    const before = domainState();
    const saved = operations();
    for (const endpoint of ["/commit", "/commit?mode=check"]) {
      const response = await post(endpoint, request, {
        token, bindings: { ADMIN_CALENDAR_V2_ENABLED: "false" },
      });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ ok: false, reason: "forbidden" });
      await expectError(await post(endpoint, request, { token }), 403, "forbidden");
    }
    await expectError(await post("", legacy, { token }), 400, "forbidden");
    expect(domainState()).toEqual(before);
    expect(operations()).toEqual(saved);
  });

  it("API-08/18 resizes an already-started reservation without sending a time change notification", async () => {
    const request = await confirm({ kind: "resize", treatmentMinutes: 65 });
    vi.setSystemTime(new Date("2026-06-01T01:10:00.000Z"));
    const result = await readSuccess(await post("/commit", request));

    expect(result).toMatchObject({
      reservation: { startAt: INITIAL_START, endAt: "2026-06-01T02:10:00.000Z", occupancyMinutes: 70 },
      change: { after: { treatmentMinutes: 65, treatmentEndAt: "2026-06-01T02:05:00.000Z" } },
      effects: {
        notification: { kind: "none", reason: "start_unchanged" },
        calendar: { kind: "enqueue_upsert", status: "queued" },
      },
    });
    expect(result.effects.notification).not.toHaveProperty("jobId");
    expect(domainState().notification_jobs).toEqual([]);
    expect(domainState().calendar_sync_jobs).toHaveLength(1);
  });

  it("API-18/27 finalizes a move with an empty LINE job result when there is no LINE identity", async () => {
    db.sqlite.prepare("UPDATE reservations SET line_identity_id = NULL WHERE id = ?").run(RESERVATION);
    const result = await readSuccess(await post("/commit", await confirm()));

    expect(result.effects.notification).toEqual({ kind: "none", reason: "no_line_identity" });
    expect(result.effects.calendar).toMatchObject({ kind: "enqueue_upsert", status: "queued" });
    expect(domainState().notification_jobs).toEqual([]);
    expect(domainState().calendar_sync_jobs).toHaveLength(1);
    expect(operations()).toEqual([expect.objectContaining({ status: "succeeded", applied_version: 4 })]);
  });

  it("API-09/18 moves pending reservations with the existing approval expiry and no LINE job", async () => {
    db.sqlite.prepare(`
      UPDATE reservations SET status = 'pending_approval', pending_expires_at = '2026-06-01T00:20:00.000Z' WHERE id = ?
    `).run(RESERVATION);
    const result = await readSuccess(await post("/commit", await confirm()));

    expect(result.reservation.status).toBe("pending_approval");
    expect(result.effects.notification).toEqual({ kind: "none", reason: "pending_approval" });
    expect(domainState().notification_jobs).toEqual([]);
    expect(domainState().calendar_sync_jobs).toHaveLength(1);
    expect(db.sqlite.prepare("SELECT pending_expires_at FROM reservations WHERE id = ?").get(RESERVATION))
      .toEqual({ pending_expires_at: "2026-06-01T00:20:00.000Z" });
    for (const table of ["slot_locks", "customer_time_locks"]) {
      expect(db.sqlite.prepare(`SELECT DISTINCT lock_status, expires_at FROM ${table} WHERE owner_id = ?`).all(RESERVATION))
        .toEqual([{ lock_status: "pending", expires_at: "2026-06-01T00:20:00.000Z" }]);
    }
  });

  it("API-25 replays saved operations and leaves new and not_applied keys untouched while stopped", async () => {
    const first = await confirm();
    const saved = await readSuccess(await post("/commit", first));
    const fresh = await confirm({ kind: "resize", treatmentMinutes: 45 }, 4);
    const unapplied = await confirm({ kind: "resize", treatmentMinutes: 65 }, 4);
    await expectError(await post("/commit?mode=check", unapplied), 409, "operation_not_applied");

    const before = domainState();
    const beforeOperations = operations();
    const queueSend = vi.fn(async () => {});
    const stopped = { bindings: { ...OFF.bindings, LINE_NOTIFICATION_QUEUE: { send: queueSend }, GOOGLE_SYNC_QUEUE: { send: queueSend } } };
    for (const endpoint of ["/commit", "/commit?mode=check"]) {
      expect(await readSuccess(await post(endpoint, first, stopped))).toEqual({ ...saved, replayed: true });
      await expectError(await post(endpoint, fresh, stopped), 404, "feature_disabled");
      await expectError(await post(endpoint, unapplied, stopped), 404, "feature_disabled");
      await expectError(await post(endpoint, { ...first, expectedVersion: 2 }, stopped), 409, "idempotency_conflict");
    }
    expect(queueSend).not.toHaveBeenCalled();
    expect(domainState()).toEqual(before);
    expect(operations()).toEqual(beforeOperations);

    const legacy = { idempotencyKey: "legacy-while-stopped", startAt: "2026-06-01T10:50:00+09:00" };
    expect((await post("", legacy, OFF)).status).toBe(200);
    const afterLegacy = domainState();
    const replay = await post("", legacy, OFF);
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ replayed: true, startAt: "2026-06-01T01:50:00.000Z" });
    expect(domainState()).toEqual(afterLegacy);
    expect(operations()).toEqual(beforeOperations);
  });

  it("API-25/30 reports in-progress and key conflict while stopped without settling the started operation", async () => {
    const request = await confirm();
    const before = domainState();
    const held = holdNextBatch();
    const pending = post("/commit", request);
    try {
      await held.entered;
      const started = operations();
      for (const endpoint of ["/commit", "/commit?mode=check"]) {
        await expectError(await post(endpoint, request, OFF), 409, "idempotency_in_progress");
        await expectError(await post(endpoint, { ...request, expectedVersion: 2 }, OFF), 409, "idempotency_conflict");
      }
      expect(domainState()).toEqual(before);
      expect(operations()).toEqual(started);
    } finally {
      held.release();
    }
    const saved = await readSuccess(await pending);
    expect(await readSuccess(await post("/commit?mode=check", request, OFF))).toEqual({ ...saved, replayed: true });
  });

  it.each(["applies", "stays unapplied"] as const)("API-30 checks the old input again after a pre-claim stop when it %s", async (outcome) => {
    const request = await confirm();
    const before = domainState();
    const held = holdNextStatement("INSERT INTO reservation_change_operations", "beforeRun");
    const original = post("/commit", request);
    try {
      await held.entered;
      await expectError(await post("/commit?mode=check", request, OFF), 404, "feature_disabled");
      expect(operations()).toEqual([]);
      expect(domainState()).toEqual(before);
      if (outcome === "stays unapplied") {
        await expectError(await post("/commit?mode=check", request), 409, "operation_not_applied");
      }
    } finally {
      held.release();
    }
    if (outcome === "applies") {
      const saved = await readSuccess(await original);
      expect(await readSuccess(await post("/commit?mode=check", request))).toEqual({ ...saved, replayed: true });
    } else {
      await expectError(await original, 409, "operation_not_applied");
      expect(domainState()).toEqual(before);
    }
  });

  it("API-26 rereads the operation on the primary when the original commits after the first key lookup", async () => {
    const request = await confirm();
    const claim = holdNextStatement("INSERT INTO reservation_change_operations", "beforeRun");
    const original = post("/commit", request);
    await claim.entered;

    const replicaPrepare = vi.fn(() => { throw new Error("replica still has version 3 and no operation"); });
    const withSession = vi.fn(() => ({ prepare: replicaPrepare, getBookmark: () => null }));
    Object.assign(db, { withSession });
    const firstLookup = holdNextStatement("FROM reservation_change_operations WHERE actor_id", "afterFirst");
    const retry = post("/commit", request, {
      bindings: { D1_SESSION_ENABLED: "true" }, headers: { "x-d1-bookmark": "stale-bookmark" },
    });
    let saved;
    try {
      await firstLookup.entered;
      claim.release();
      saved = await readSuccess(await original);
    } finally {
      claim.release();
      firstLookup.release();
    }
    expect(await readSuccess(await retry)).toEqual({ ...saved, replayed: true });
    expect(withSession).toHaveBeenCalledWith("stale-bookmark");
    expect(replicaPrepare).not.toHaveBeenCalled();
    expect(domainState().notification_jobs).toHaveLength(1);
  });

  it("API-16/28 rejects a key paired with another preview before and after key reservation", async () => {
    const request = await confirm();
    const other = await confirm({ kind: "resize", treatmentMinutes: 65 });
    const mismatch = { ...other, idempotencyKey: request.idempotencyKey };
    const before = domainState();
    for (const endpoint of ["/commit", "/commit?mode=check"]) {
      await expectError(await post(endpoint, mismatch), 409, "idempotency_conflict");
      await expectError(await post(endpoint, mismatch, OFF), 404, "feature_disabled");
    }
    expect(operations()).toEqual([]);
    expect(domainState()).toEqual(before);
    const held = holdNextBatch();
    const original = post("/commit", request);
    try {
      await held.entered;
      await expectError(await post("/commit", mismatch), 409, "idempotency_conflict");
      await expectError(await post("/commit?mode=check", { ...request, intent: other.intent }), 409, "idempotency_conflict");
      expect(operations()).toEqual([expect.objectContaining({ status: "started" })]);
      expect(domainState()).toEqual(before);
    } finally {
      held.release();
    }
    const saved = await readSuccess(await original);
    await expectError(await post("/commit", mismatch), 409, "idempotency_conflict");
    expect(await readSuccess(await post("/commit", request))).toEqual({ ...saved, replayed: true });
  });

  it("API-15/19/26/29 retains the original snapshot past 24 hours and returns the live reservation and job states", async () => {
    const request = await confirm();
    const original = await readSuccess(await post("/commit", request));
    const nextMove = await confirm({ kind: "move", startAt: "2026-06-01T10:50:00+09:00" }, 4);
    await readSuccess(await post("/commit", nextMove));
    db.sqlite.prepare("UPDATE notification_jobs SET status = 'failed' WHERE id = ?").run(original.effects.notification.jobId!);
    db.sqlite.prepare("UPDATE calendar_sync_jobs SET status = 'retryable' WHERE id = ?").run(original.effects.calendar.jobId);
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));

    const before = domainState();
    const afterOperations = operations();
    const result = await readSuccess(await post("/commit?mode=check", request));
    expect(result.operationId).toBe(original.operationId);
    expect(result.change).toEqual(original.change);
    expect(result.reservation).toMatchObject({ version: 5, startAt: "2026-06-01T01:50:00.000Z" });
    expect(result.effects.notification).toMatchObject({ jobId: original.effects.notification.jobId, status: "failed" });
    expect(result.effects.calendar).toMatchObject({ jobId: original.effects.calendar.jobId, status: "retryable" });
    expect(domainState()).toEqual(before);
    expect(operations()).toEqual(afterOperations);
    db.sqlite.prepare("DELETE FROM reservations WHERE id = ?").run(RESERVATION);
    expect(operations()).toEqual([]);
    await expectError(await post("/commit?mode=check", request), 404, "not_found");
  });

  it("API-27 replays when the batch wins just before the check's conditional UPDATE", async () => {
    const request = await confirm();
    const held = holdNextBatch();
    const original = post("/commit", request);
    await held.entered;
    const checkWrite = holdNextStatement("SET status = 'not_applied', updated_at", "beforeRun");
    const check = post("/commit?mode=check", request);
    let saved;
    try {
      await checkWrite.entered;
      held.release();
      saved = await readSuccess(await original);
    } finally {
      held.release();
      checkWrite.release();
    }
    expect(await readSuccess(await check)).toEqual({ ...saved, replayed: true });
    expect(operations()).toEqual([expect.objectContaining({ status: "succeeded", applied_version: 4 })]);
    expect(domainState().notification_jobs).toHaveLength(1);
  });

  it.each(["insert", "update"] as const)("API-17/28 checks current authorization in the not_applied %s", async (method) => {
    const token = seedActor("revoked-staff", "staff", "staff_owner_kyoto");
    const options = { token };
    const request = await confirm(MOVE, 3, options);
    const before = domainState();
    const held = method === "update" ? holdNextBatch() : undefined;
    const original = held && post("/commit", request, options);
    await held?.entered;
    const beforeOperations = operations();
    const checkWrite = holdNextStatement(
      method === "insert" ? "INSERT INTO reservation_change_operations" : "SET status = 'not_applied', updated_at",
      "beforeRun",
    );
    const check = post("/commit?mode=check", request, options);
    try {
      await checkWrite.entered;
      db.sqlite.prepare("UPDATE admin_users SET staff_member_id = 'staff_owner_osaka' WHERE id = 'revoked-staff'").run();
    } finally {
      checkWrite.release();
      held?.release();
    }

    await expectError(await check, 403, "forbidden");
    if (original) await expectError(await original, 403, "forbidden");
    expect(domainState()).toEqual(before);
    expect(operations()).toEqual(beforeOperations);
  });

  it("API-29 keeps the same key independent for different authenticated actors", async () => {
    const request = await confirm();
    const owner1Result = await readSuccess(await post("/commit", request));
    const token = seedActor("second-owner");
    const before = domainState();
    await expectError(await post("/commit?mode=check", request, { token }), 409, "operation_not_applied");
    expect(await readSuccess(await post("/commit?mode=check", request))).toEqual({ ...owner1Result, replayed: true });
    expect(operations()).toEqual([
      expect.objectContaining({ actor_id: "commit-owner", idempotency_key: request.idempotencyKey, status: "succeeded" }),
      expect.objectContaining({ actor_id: "second-owner", idempotency_key: request.idempotencyKey, status: "not_applied" }),
    ]);
    expect(domainState()).toEqual(before);
  });

  it.each(["after preview", "after preflight"])("API-05/07/23 rejects an active external block without a lock %s", async (when) => {
    const request = await confirm();
    const held = when === "after preflight" ? holdNextBatch() : undefined;
    const pending = held && post("/commit", request);
    await held?.entered;
    try {
      db.sqlite.exec(`
        INSERT INTO external_blocks (id, store_id, resource_id, source, status, start_at, end_at, title_snapshot)
        VALUES ('unlocked-block', 'kyoto', 'resource_kyoto_calendar', 'admin_block', 'active',
          '2026-06-01T01:36:00.000Z', '2026-06-01T01:50:00.000Z', 'Private appointment')
      `);
    } finally {
      held?.release();
    }
    const before = domainState();
    const response = await (pending ?? post("/commit", request));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ ok: false, reason: "slot_unavailable" });
    expect(domainState()).toEqual(before);
    expect(operations()).toEqual(held ? [expect.objectContaining({ status: "not_applied" })] : []);
  });

  it("API-05/23 keeps the original locks when a new phone-hash conflict appears after preview", async () => {
    const request = await confirm();
    db.sqlite.exec(`
      INSERT INTO customers (id, display_name, phone_normalized, phone_hash, block_status)
        VALUES ('other-customer', 'Other customer', '0750000001', 'commit-phone', 'active');
      INSERT INTO customer_time_locks (id, customer_id, slot_at, owner_type, owner_id, lock_status, phone_hash)
        VALUES ('other-customer-slot', 'other-customer', '2026-06-01T01:35:00.000Z',
          'reservation', 'other-reservation', 'confirmed', 'commit-phone');
    `);
    const before = domainState();

    const response = await post("/commit", request);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ ok: false, reason: "customer_time_conflict" });
    expect(domainState()).toEqual(before);
    expect(operations()).toEqual([]);
  });

  it("API-05/07 rolls back if a slot is taken after commit preflight", async () => {
    const request = await confirm();
    const held = holdNextBatch();
    const commit = post("/commit", request);
    await held.entered;
    let before;
    try {
      db.sqlite.exec(`
        INSERT INTO slot_locks (id, store_id, resource_id, slot_at, owner_type, owner_id, lock_status)
        VALUES ('taken-slot', 'kyoto', 'resource_kyoto_calendar', '2026-06-01T01:35:00.000Z',
          'reservation', 'other-reservation', 'confirmed')
      `);
      before = domainState();
    } finally {
      held.release();
    }

    await expectError(await commit, 409, "slot_unavailable");
    expect(domainState()).toEqual(before);
    expect(operations()).toEqual([expect.objectContaining({ status: "started" })]);
  });

  it("API-13/23 rejects no-change and a stale preview when the notification plan changes", async () => {
    const request = await confirm();
    db.sqlite.prepare("UPDATE reservations SET line_identity_id = NULL WHERE id = ?").run(RESERVATION);
    const before = domainState();

    await expectError(await post("/commit", request), 409, "preview_stale");
    await expectError(await post("/commit", makeRequest("b".repeat(64), { kind: "move", startAt: INITIAL_START })),
      409, "no_change");
    expect(domainState()).toEqual(before);
    expect(operations()).toEqual([]);
  });

  it.each([
    ["later version", "version_conflict", 409],
    ["occupied original slot", "slot_unavailable", 409],
    ["past original start", "invalid_time", 400],
    ["completed reservation", "invalid_transition", 409],
  ] as const)("API-20 rejects Undo with a %s", async (cause, reason, status) => {
    const saved = await readSuccess(await post("/commit", await confirm()));
    const request = await confirm({ kind: "undo", inverseOfOperationId: saved.operationId }, 4);
    if (cause === "later version") {
      const later = await confirm({ kind: "resize", treatmentMinutes: 65 }, 4);
      await readSuccess(await post("/commit", later));
    } else if (cause === "occupied original slot") {
      db.sqlite.exec(`
        INSERT INTO slot_locks (id, store_id, resource_id, slot_at, owner_type, owner_id, lock_status)
        VALUES ('undo-taken-slot', 'kyoto', 'resource_kyoto_calendar', '2026-06-01T01:45:00.000Z',
          'reservation', 'other-reservation', 'confirmed')
      `);
    } else if (cause === "past original start") {
      vi.setSystemTime(new Date("2026-06-01T01:10:00Z"));
    } else {
      db.sqlite.prepare("UPDATE reservations SET status = 'completed' WHERE id = ?").run(RESERVATION);
    }

    const before = domainState();
    const beforeOperations = operations();
    await expectError(await post("/commit", request), status, reason);
    if (cause === "later version") {
      await expectError(await post("/commit", { ...request, expectedVersion: 5 }), 409, "undo_not_available");
    }
    expect(domainState()).toEqual(before);
    expect(operations()).toEqual(beforeOperations);
  });

  it("API-20 requires a succeeded original operation on the same reservation", async () => {
    const request = await confirm();
    await expectError(await post("/commit?mode=check", request), 409, "operation_not_applied");
    const { operation_id: unappliedId } = operations()[0] as { operation_id: string };
    const saved = await readSuccess(await post("/commit", await confirm()));
    db.sqlite.prepare(`
      INSERT INTO reservations (id, store_id, service_id, customer_id, resource_id, source, status,
        start_at, end_at, duration_minutes, idempotency_key, version)
      VALUES ('other-reservation', 'osaka', 'service_osaka_default_60', ?, 'resource_osaka_calendar', 'admin',
        'confirmed', '2026-06-01T03:00:00.000Z', '2026-06-01T04:00:00.000Z', 60, 'other-reservation-key', 4)
    `).run(CUSTOMER);
    const before = domainState();
    const beforeOperations = operations();
    const wrongReservation = makeRequest("a".repeat(64), { kind: "undo", inverseOfOperationId: saved.operationId }, 4);
    const wrongStatus = makeRequest("a".repeat(64), { kind: "undo", inverseOfOperationId: unappliedId }, 4);

    for (const endpoint of ["/commit", "/commit?mode=check"]) {
      await expectError(await post(endpoint, wrongReservation, { reservationId: "other-reservation" }), 409, "undo_not_available");
      await expectError(await post(endpoint, wrongStatus), 409, "undo_not_available");
    }
    expect(domainState()).toEqual(before);
    expect(operations()).toEqual(beforeOperations);
  });

  it("API-12/22 restores exactly five minutes of legacy occupancy on an inactive resource", async () => {
    db.sqlite.prepare("UPDATE store_resources SET active = 0 WHERE id = ?").run(RESOURCE);
    db.sqlite.prepare("UPDATE reservations SET duration_minutes = 5, end_at = '2026-06-01T01:05:00.000Z' WHERE id = ?")
      .run(RESERVATION);
    const resized = await readSuccess(await post("/commit", await confirm({ kind: "resize", treatmentMinutes: 15 })));
    const undone = await readSuccess(await post("/commit", await confirm({ kind: "undo", inverseOfOperationId: resized.operationId }, 4)));

    expect(undone.change.after).toEqual({
      startAt: INITIAL_START, treatmentEndAt: INITIAL_START, endAt: "2026-06-01T01:05:00.000Z",
      occupancyMinutes: 5, treatmentMinutes: 0,
    });
    expect(undone.reservation).toMatchObject({ version: 5, occupancyMinutes: 5, endAt: "2026-06-01T01:05:00.000Z" });
    expect(undone.effects.notification).toEqual({ kind: "none", reason: "start_unchanged" });
    expect(domainState().slot_locks).toEqual([expect.objectContaining({ owner_id: RESERVATION, slot_at: INITIAL_START })]);
    expect(domainState().customer_time_locks).toHaveLength(1);
    expect(domainState().notification_jobs).toEqual([]);
    await expectError(await post("/commit", makeRequest("a".repeat(64), { kind: "resize", treatmentMinutes: 0 }, 5)),
      400, "invalid_request");
  });

  it("API-25 keeps the same off-switch behavior for Undo before, during and after its batch", async () => {
    const saved = await readSuccess(await post("/commit", await confirm()));
    const undoRequest = await confirm({ kind: "undo", inverseOfOperationId: saved.operationId }, 4);
    const before = domainState();
    const beforeOperations = operations();
    const endpoints = ["/commit", "/commit?mode=check"];
    for (const path of endpoints) await expectError(await post(path, undoRequest, OFF), 404, "feature_disabled");
    expect(domainState()).toEqual(before);
    expect(operations()).toEqual(beforeOperations);

    const held = holdNextBatch();
    const pending = post("/commit", undoRequest);
    try {
      await held.entered;
      const started = operations();
      for (const path of endpoints) {
        await expectError(await post(path, undoRequest, OFF), 409, "idempotency_in_progress");
        await expectError(await post(path, { ...undoRequest, expectedVersion: 3 }, OFF), 409, "idempotency_conflict");
      }
      expect(domainState()).toEqual(before);
      expect(operations()).toEqual(started);
    } finally {
      held.release();
    }
    const undone = await readSuccess(await pending);
    const after = domainState();
    const afterOperations = operations();
    for (const path of endpoints) expect(await readSuccess(await post(path, undoRequest, OFF))).toEqual({ ...undone, replayed: true });
    expect(domainState()).toEqual(after);
    expect(operations()).toEqual(afterOperations);
  });

  it("API-10/25 retains the authentication, CSRF and rate-limit gates while stopped", async () => {
    const request = await confirm();
    const before = domainState();
    await expectError(await post("/commit", request, { ...OFF, token: null }), 403, "admin_auth_failed");
    const csrf = await post("/commit?mode=check", request, {
      ...OFF, headers: { "Sec-Fetch-Site": "cross-site" },
    });
    expect(csrf.status).toBe(403);
    await expect(csrf.json()).resolves.toEqual({ ok: false, error: "forbidden" });

    const key = createHash("sha256").update("admin_mutation:commit-owner").digest("hex");
    db.sqlite.prepare(`
      WITH RECURSIVE attempts(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM attempts WHERE n < 300)
      INSERT INTO rate_limit_events (id, action, rate_limit_key, occurred_at)
      SELECT 'admin-attempt-' || n, 'admin_mutation', ?, '2026-06-01T00:00:00.000Z' FROM attempts
    `).run(key);
    await expectError(await post("/commit", request, OFF), 429, "rate_limited");
    await expectError(await post("/commit?mode=check", request, OFF), 429, "rate_limited");
    expect(domainState()).toEqual(before);
    expect(operations()).toEqual([]);
  });

  it("API-27 keeps the result unknown when a transport error happens to name a lock table", async () => {
    const request = await confirm();
    const before = domainState();
    vi.spyOn(db, "batch").mockRejectedValueOnce(new Error("D1 connection closed while reading slot_locks batch results"));
    await expectError(await post("/commit", request), 500, "write_failed");
    expect(domainState()).toEqual(before);
    expect(operations()).toEqual([expect.objectContaining({ status: "started" })]);
  });
});
