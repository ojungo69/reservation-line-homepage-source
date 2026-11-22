import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import {
  createAccessJwksFetchMock,
  createAccessJwtFixture,
  createAccessSigningKey,
  insertAdminUser,
  type AdminRole,
} from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const TEAM_DOMAIN = "https://team.example.cloudflareaccess.com";
const ACCESS_AUD = "admin-reschedule-preview-aud";
const CONTRACT_VERSION = "calendar-interactions-v1";
const RESERVATION_ID = "preview-reservation";
const CUSTOMER_ID = "preview-customer";
const LINE_IDENTITY_ID = "preview-line-identity";
const MOVE = { kind: "move", startAt: "2026-06-01T09:40:00+09:00" };
const signingKey = createAccessSigningKey("preview-key");

const expectFailure = async (response: Response, status: number, reason: string) => {
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toEqual({ ok: false, reason });
};

describe("admin reservation reschedule preview", () => {
  let db: SqliteD1Database;
  let ownerToken: string;

  const postPreview = (body: unknown, {
    token = ownerToken, reservationId = RESERVATION_ID, bindings = {},
  }: { token?: string | null; reservationId?: string; bindings?: Record<string, unknown> } = {}) => createApp().request(
    `/api/admin/reservations/${reservationId}/reschedule/preview`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { "Cf-Access-Jwt-Assertion": token } : {}) },
      body: JSON.stringify(body),
    },
    {
      DB: db,
      ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
      ACCESS_AUD,
      ENVIRONMENT: "staging",
      ADMIN_CALENDAR_V2_ENABLED: "true",
      ...bindings,
    },
  );

  const preview = (intent: unknown = MOVE, options?: Parameters<typeof postPreview>[1]) =>
    postPreview({ contractVersion: CONTRACT_VERSION, expectedVersion: 3, intent }, options);

  const seedActor = (id: string, role: AdminRole = "owner", staffMemberId?: string) => {
    const email = `${id}@example.com`;
    const sub = `${id}-subject`;
    insertAdminUser(db, { id, email, accessSubject: sub, role, staffMemberId });
    return createAccessJwtFixture({
      issuer: TEAM_DOMAIN, audience: ACCESS_AUD, keyId: "preview-key", signingKey,
      claims: { email, sub, exp: Date.parse("2026-06-02T00:00:00.000Z") / 1000 },
    }).token;
  };

  const insertSlotLock = (slotAt: string, ownerId: string, lockStatus = "confirmed", expiresAt: string | null = null) => {
    db.sqlite.prepare(`
      INSERT INTO slot_locks (id, store_id, resource_id, slot_at, owner_type, owner_id, lock_status, expires_at)
      VALUES (?, 'kyoto', 'resource_kyoto_calendar', ?, 'reservation', ?, ?, ?)
    `).run(`slot-${ownerId}`, slotAt, ownerId, lockStatus, expiresAt);
  };

  const insertCustomerTimeLock = (slotAt: string, ownerId: string, customerId: string, phoneHash: string | null = null) => {
    db.sqlite.prepare(`
      INSERT INTO customer_time_locks (id, customer_id, slot_at, owner_type, owner_id, lock_status, phone_hash)
      VALUES (?, ?, ?, 'reservation', ?, 'confirmed', ?)
    `).run(`customer-lock-${ownerId}`, customerId, slotAt, ownerId, phoneHash);
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    db = createMigratedSqliteD1();
    ownerToken = seedActor("preview-owner");
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, signingKey.jwk));

    db.sqlite.prepare("UPDATE store_business_hours SET opens_at = '09:30' WHERE weekday = 1").run();
    db.sqlite.prepare(`
      INSERT INTO customers (id, display_name, phone_normalized, phone_hash, block_status)
      VALUES (?, 'Preview Customer', '0750000001', 'preview-phone-hash', 'active')
    `).run(CUSTOMER_ID);
    db.sqlite.prepare(`
      INSERT INTO line_identities (id, customer_id, channel_id, line_user_id)
      VALUES (?, ?, 'preview-channel', 'preview-line-user')
    `).run(LINE_IDENTITY_ID, CUSTOMER_ID);
    db.sqlite.prepare(`
      INSERT INTO reservations (
        id, store_id, service_id, customer_id, resource_id, line_identity_id, source,
        status, start_at, end_at, duration_minutes, created_by, updated_by, idempotency_key, version
      ) VALUES (?, 'kyoto', 'service_kyoto_default_60', ?, 'resource_kyoto_calendar', ?, 'admin',
        'confirmed', '2026-06-01T01:00:00.000Z', '2026-06-01T02:00:00.000Z', 60, 'fixture', 'fixture', 'preview-fixture', 3)
    `).run(RESERVATION_ID, CUSTOMER_ID, LINE_IDENTITY_ID);
    insertSlotLock("2026-06-01T01:00:00.000Z", RESERVATION_ID);
    insertCustomerTimeLock("2026-06-01T01:00:00.000Z", RESERVATION_ID, CUSTOMER_ID, "preview-phone-hash");
  });

  afterEach(() => {
    db.sqlite.close();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("API-06 previews a move to 09:40 JST and returns the confirmation", async () => {
    const response = await preview();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      contractVersion: CONTRACT_VERSION,
      reservationId: RESERVATION_ID,
      version: 3,
      intent: { kind: "move", startAt: "2026-06-01T00:40:00.000Z" },
      storeId: "kyoto",
      resourceId: "resource_kyoto_calendar",
      status: "confirmed",
      before: {
        startAt: "2026-06-01T01:00:00.000Z",
        treatmentEndAt: "2026-06-01T01:55:00.000Z",
        endAt: "2026-06-01T02:00:00.000Z",
        occupancyMinutes: 60,
        treatmentMinutes: 55,
      },
      after: {
        startAt: "2026-06-01T00:40:00.000Z",
        treatmentEndAt: "2026-06-01T01:35:00.000Z",
        endAt: "2026-06-01T01:40:00.000Z",
        occupancyMinutes: 60,
        treatmentMinutes: 55,
      },
      notificationPlan: { kind: "time_changed", reason: "start_changed" },
      calendarPlan: "enqueue_upsert",
      previewFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it.each([
    [{ kind: "move", startAt: "2026-06-01T09:40:01+09:00" }, "invalid_time"],
    [{ kind: "move", startAt: "2026-06-01T09:40:00.001+09:00" }, "invalid_time"],
    [{ kind: "move", startAt: "2026-06-01T09:41:00+09:00" }, "invalid_time"],
    [{ kind: "move", startAt: "2026-06-01T09:40:00" }, "invalid_time"],
    [{ kind: "move", startAt: "2026-06-31T09:40:00+09:00" }, "invalid_time"],
    [{ kind: "resize", treatmentMinutes: 240 }, "invalid_request"],
    [{ kind: "resize", treatmentMinutes: 57 }, "invalid_request"],
    [{ kind: "resize", treatmentMinutes: 0 }, "invalid_request"],
  ])("API-06 rejects %j with %s", async (intent, reason) => {
    await expectFailure(await preview(intent), 400, reason);
  });

  it("API-07 rejects cleanup overlapping the next reservation and accepts an exact boundary", async () => {
    db.sqlite.prepare(`
      INSERT INTO reservations (
        id, store_id, service_id, customer_id, resource_id, source, status,
        start_at, end_at, duration_minutes, created_by, updated_by, idempotency_key
      ) VALUES ('next-reservation', 'kyoto', 'service_kyoto_default_60', ?, 'resource_kyoto_calendar', 'admin', 'confirmed',
        '2026-06-01T01:40:00.000Z', '2026-06-01T02:40:00.000Z', 60, 'fixture', 'fixture', 'next-fixture')
    `).run(CUSTOMER_ID);
    insertSlotLock("2026-06-01T01:40:00.000Z", "next-reservation");

    await expectFailure(await preview({ kind: "move", startAt: "2026-06-01T09:45:00+09:00" }), 409, "slot_unavailable");
    const response = await preview();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ after: { endAt: "2026-06-01T01:40:00.000Z" } });
  });

  it("API-07 rejects cleanup overlapping a closure and accepts an exact boundary", async () => {
    db.sqlite.prepare(`
      INSERT INTO store_closures (id, store_id, starts_at, ends_at, source)
      VALUES ('preview-closure', 'kyoto', '2026-06-01T02:40:00.000Z', '2026-06-01T03:00:00.000Z', 'admin')
    `).run();

    await expectFailure(await preview({ kind: "move", startAt: "2026-06-01T10:45:00+09:00" }), 400, "store_closed");
    const response = await preview({ kind: "move", startAt: "2026-06-01T10:40:00+09:00" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ after: { endAt: "2026-06-01T02:40:00.000Z" } });
  });

  it("API-07 rejects cleanup after closing and accepts finishing at closing time", async () => {
    await expectFailure(await preview({ kind: "move", startAt: "2026-06-01T19:05:00+09:00" }), 400, "outside_business_hours");
    const response = await preview({ kind: "move", startAt: "2026-06-01T19:00:00+09:00" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ after: { endAt: "2026-06-01T11:00:00.000Z" } });
  });

  it("API-07 rejects an active external block even without a corresponding slot lock", async () => {
    db.sqlite.prepare(`
      INSERT INTO external_blocks (id, store_id, resource_id, source, status, start_at, end_at, title_snapshot)
      VALUES ('other-block', 'kyoto', 'resource_kyoto_calendar', 'admin_block', 'active',
        '2026-06-01T01:42:00.000Z', '2026-06-01T02:00:00.000Z', 'Private appointment')
    `).run();

    await expectFailure(await preview({ kind: "move", startAt: "2026-06-01T09:45:00+09:00" }), 409, "slot_unavailable");
    expect((await preview()).status).toBe(200);
  });

  it("rejects a customer time lock from another reservation", async () => {
    insertCustomerTimeLock("2026-06-01T01:35:00.000Z", "other-customer-reservation", CUSTOMER_ID);

    await expectFailure(await preview(), 409, "customer_time_conflict");
  });

  it("checks shared phone hashes using the write path's source policy", async () => {
    db.sqlite.prepare(`
      INSERT INTO customers (id, display_name, phone_normalized, phone_hash, block_status)
      VALUES ('other-preview-customer', 'Another Customer', '0750000001', 'preview-phone-hash', 'active')
    `).run();
    insertCustomerTimeLock("2026-06-01T01:35:00.000Z", "other-phone-reservation", "other-preview-customer", "preview-phone-hash");

    await expectFailure(await preview(), 409, "customer_time_conflict");
    db.sqlite.prepare("UPDATE reservations SET source = 'web_line' WHERE id = ?").run(RESERVATION_ID);
    expect((await preview()).status).toBe(200);
  });

  it.each([
    [40, "2026-06-01T01:40:00.000Z", "2026-06-01T01:45:00.000Z", 45],
    [65, "2026-06-01T02:05:00.000Z", "2026-06-01T02:10:00.000Z", 70],
    [235, "2026-06-01T04:55:00.000Z", "2026-06-01T05:00:00.000Z", 240],
  ])("API-08 allows a %i-minute resize after the reservation starts", async (treatmentMinutes, treatmentEndAt, endAt, occupancyMinutes) => {
    vi.setSystemTime(new Date("2026-06-01T01:10:00.000Z"));
    const response = await preview({ kind: "resize", treatmentMinutes });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      after: { startAt: "2026-06-01T01:00:00.000Z", treatmentEndAt, endAt, treatmentMinutes, occupancyMinutes },
      notificationPlan: { kind: "none", reason: "start_unchanged" },
      calendarPlan: "enqueue_upsert",
    });
  });

  it("API-08 rejects moving the start into the past", async () => {
    vi.setSystemTime(new Date("2026-06-01T00:50:00.000Z"));
    await expectFailure(await preview(), 400, "invalid_time");
  });

  it.each([
    ["confirmed", "2026-06-01T00:10:00.000Z"],
    ["completed", null],
    ["cancelled_by_admin", null],
    ["cancelled_by_customer", null],
  ])("API-08 rejects status=%s with check-in at %s", async (status, checkedInAt) => {
    db.sqlite.prepare("UPDATE reservations SET status = ?, checked_in_at = ? WHERE id = ?")
      .run(status, checkedInAt, RESERVATION_ID);

    await expectFailure(await preview(), 409, "invalid_transition");
  });

  it("keeps an expired pending slot busy until the lock is removed", async () => {
    insertSlotLock("2026-06-01T01:35:00.000Z", "expired-pending", "pending", "2026-05-31T23:55:00.000Z");
    await expectFailure(await preview(), 409, "slot_unavailable");

    db.sqlite.prepare("DELETE FROM slot_locks WHERE owner_id = 'expired-pending'").run();
    expect((await preview()).status).toBe(200);
  });

  it("API-10 allows staff at their own store and rejects the same reservation after reassignment", async () => {
    const token = seedActor("preview-staff", "staff", "staff_owner_kyoto");
    expect((await preview(MOVE, { token })).status).toBe(200);

    db.sqlite.prepare("UPDATE admin_users SET staff_member_id = 'staff_owner_osaka' WHERE id = 'preview-staff'").run();
    await expectFailure(await preview(MOVE, { token }), 403, "forbidden");
  });

  it.each([
    ["storeId", "osaka"],
    ["resourceId", "resource_osaka_calendar"],
    ["staffId", "staff_owner_osaka"],
  ])("API-11 rejects a client-supplied %s at either level", async (key, value) => {
    const request = { contractVersion: CONTRACT_VERSION, expectedVersion: 3, intent: MOVE };
    await expectFailure(await postPreview({ ...request, [key]: value }), 400, "invalid_request");
    await expectFailure(await preview({ ...MOVE, [key]: value }), 400, "invalid_request");
  });

  it.each([
    { ...MOVE, treatmentMinutes: 50 },
    { ...MOVE, endAt: "2026-06-01T01:30:00.000Z" },
    { kind: "resize", treatmentMinutes: 50, suppressNotification: true },
    { kind: "resize", treatmentMinutes: "50" },
    { kind: "move" },
    { kind: "create", startAt: MOVE.startAt },
  ])("rejects mixed, incomplete or unknown intent %j", async (intent) => {
    await expectFailure(await preview(intent), 400, "invalid_request");
  });

  it.each([undefined, 0, 1.5, 9007199254740992, "3"])("requires a positive safe integer version, got %j", async (expectedVersion) => {
    await expectFailure(await postPreview({ contractVersion: CONTRACT_VERSION, expectedVersion, intent: MOVE }), 400, "invalid_request");
  });

  it("distinguishes missing and unsupported contract versions", async () => {
    await expectFailure(await postPreview({ expectedVersion: 3, intent: MOVE }), 400, "invalid_request");
    await expectFailure(await postPreview({ contractVersion: "calendar-interactions-v2", expectedVersion: 3, intent: MOVE }), 400, "unsupported_contract");
  });

  it("API-12 moves a five-minute legacy reservation on an inactive resource", async () => {
    db.sqlite.prepare("UPDATE store_resources SET active = 0 WHERE id = 'resource_kyoto_calendar'").run();
    db.sqlite.prepare("UPDATE reservations SET duration_minutes = 5, end_at = '2026-06-01T01:05:00.000Z' WHERE id = ?").run(RESERVATION_ID);
    const response = await preview();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      resourceId: "resource_kyoto_calendar",
      before: { treatmentEndAt: "2026-06-01T01:00:00.000Z", endAt: "2026-06-01T01:05:00.000Z", occupancyMinutes: 5, treatmentMinutes: 0 },
      after: { treatmentEndAt: "2026-06-01T00:40:00.000Z", endAt: "2026-06-01T00:45:00.000Z", occupancyMinutes: 5, treatmentMinutes: 0 },
    });
  });

  it.each([
    { kind: "move", startAt: "2026-06-01T10:00:00+09:00" },
    { kind: "resize", treatmentMinutes: 55 },
  ])("API-13 returns no_change when start and occupancy are unchanged for %j", async (intent) => {
    await expectFailure(await preview(intent), 409, "no_change");
  });

  it("API-23 leaves reservation, lock, history, idempotency and job rows unchanged", async () => {
    const tables = [
      "reservations", "slot_locks", "customer_time_locks", "slot_lock_history",
      "audit_logs", "idempotency_keys", "notification_jobs", "calendar_sync_jobs",
    ];
    const snapshot = () => tables.map((table) => db.sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
    const before = snapshot();

    expect((await preview()).status).toBe(200);
    expect(snapshot()).toEqual(before);

    insertSlotLock("2026-06-01T00:40:00.000Z", "other-slot-owner");
    await expectFailure(await preview(), 409, "slot_unavailable");
  });

  it("API-23 binds the fingerprint to the normalized change, actor and version", async () => {
    const fingerprint = async (response: Response) => {
      expect(response.status).toBe(200);
      const result = await response.json() as { previewFingerprint: string };
      expect(result.previewFingerprint).toMatch(/^[0-9a-f]{64}$/);
      return result.previewFingerprint;
    };
    const first = await fingerprint(await preview());
    vi.setSystemTime(new Date("2026-06-01T00:05:00.000Z"));
    const normalizedRequest = {
      intent: { startAt: "2026-06-01T00:40:00Z", kind: "move" },
      expectedVersion: 3,
      contractVersion: CONTRACT_VERSION,
    };
    expect(await fingerprint(await postPreview(normalizedRequest))).toBe(first);
    expect(await fingerprint(await preview({ kind: "move", startAt: "2026-06-01T09:45:00+09:00" }))).not.toBe(first);

    const token = seedActor("preview-system-admin", "system_admin");
    expect(await fingerprint(await preview(MOVE, { token }))).not.toBe(first);
    db.sqlite.prepare("UPDATE reservations SET version = 4 WHERE id = ?").run(RESERVATION_ID);
    expect(await fingerprint(await postPreview({ ...normalizedRequest, expectedVersion: 4 }))).not.toBe(first);
  });

  it.each([
    ["pending_approval", LINE_IDENTITY_ID, "pending_approval"],
    ["confirmed", null, "no_line_identity"],
  ])("plans no notification for status=%s and LINE identity=%s", async (status, lineIdentityId, reason) => {
    const initial = await (await preview()).json() as { previewFingerprint: string };
    db.sqlite.prepare("UPDATE reservations SET status = ?, line_identity_id = ? WHERE id = ?")
      .run(status, lineIdentityId, RESERVATION_ID);
    const response = await preview();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      status,
      notificationPlan: { kind: "none", reason },
      calendarPlan: "enqueue_upsert",
    });
    expect(body).not.toMatchObject({ previewFingerprint: initial.previewFingerprint });
  });

  it.each([
    ["staging", "false"],
    ["production", "true"],
  ])("API-25 gates %s with flag %s only after authorization", async (environment, flag) => {
    const bindings = { ENVIRONMENT: environment, ADMIN_CALENDAR_V2_ENABLED: flag };
    const token = seedActor("preview-staff", "staff", "staff_owner_osaka");
    await expectFailure(await preview(MOVE, { bindings, token: null }), 403, "admin_auth_failed");
    await expectFailure(await preview(MOVE, { bindings, token }), 403, "forbidden");
    await expectFailure(await preview(MOVE, { bindings, reservationId: "missing" }), 404, "not_found");
    await expectFailure(
      await postPreview({ contractVersion: CONTRACT_VERSION, expectedVersion: 2, intent: MOVE }, { bindings }),
      404, "feature_disabled",
    );
  });

  it("uses env.DB for the version check when a D1 read session is available", async () => {
    const replicaPrepare = vi.fn();
    const withSession = vi.fn(() => ({ prepare: replicaPrepare, getBookmark: () => null }));
    Object.assign(db, { withSession });
    const response = await postPreview(
      { contractVersion: CONTRACT_VERSION, expectedVersion: 2, intent: MOVE },
      { bindings: { D1_SESSION_ENABLED: "true" } },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ ok: false, reason: "version_conflict", version: 3, status: "confirmed" });
    expect(withSession).toHaveBeenCalledOnce();
    expect(replicaPrepare).not.toHaveBeenCalled();
  });

  it("recognizes the undo intent while the operation history is unavailable", async () => {
    await expectFailure(await preview({ kind: "undo", inverseOfOperationId: "previous-operation" }), 409, "undo_not_available");
  });
});
