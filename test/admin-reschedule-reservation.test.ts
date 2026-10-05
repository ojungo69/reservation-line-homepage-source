import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/sentry-helpers", () => ({
  captureBatchWriteFailure: vi.fn(),
  safeCaptureException: vi.fn()
}));

import { createApp } from "../src/app";
import { rescheduleAdminReservation } from "../src/admin/reservation-reschedule";
import { captureBatchWriteFailure } from "../src/sentry-helpers";
import { createAccessJwksFetchMock, createAccessJwtFixture, insertAdminUser as insertAdminUserHelper } from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

beforeEach(() => {
  vi.mocked(captureBatchWriteFailure).mockClear();
});

const TEAM_DOMAIN = "https://team.example.cloudflareaccess.com";
const ACCESS_AUD = "admin-access-aud";
const ADMIN_EMAIL = "owner@example.com";
const ADMIN_ACCESS_SUBJECT = "access-subject-admin-reschedule";
const RESERVATION_ID = "reservation_reschedule_1";
const CUSTOMER_ID = "customer_reschedule_1";
const LINE_IDENTITY_ID = "line_identity_reschedule_1";
const LINE_USER_ID = "line_user_reschedule_1";

const createAdminRescheduleAccessFixture = () =>
  createAccessJwtFixture({
    issuer: TEAM_DOMAIN,
    audience: ACCESS_AUD,
    keyId: "admin-reschedule-key-1",
    claims: { email: ADMIN_EMAIL, sub: ADMIN_ACCESS_SUBJECT }
  });

const insertAdminUser = (db: SqliteD1Database) =>
  insertAdminUserHelper(db, {
    id: "admin_reschedule_owner_1",
    email: ADMIN_EMAIL,
    accessSubject: ADMIN_ACCESS_SUBJECT,
    role: "owner",
    updatedAt: "2026-05-09T00:00:00.000Z",
  });

const baseEnv = (db: SqliteD1Database): Record<string, unknown> => ({
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  ACCESS_AUD,
  DB: db
});

// Mirrors src/admin/reservation-reschedule.ts createRequestHash so a seeded idempotency
// row's request_hash can match a real reschedule request and exercise the in-flight replay
// branch. Start-only reschedules (durationMinutes omitted) keep the legacy 2-field shape;
// treatment-duration changes add durationMinutes.
const rescheduleRequestHash = (
  reservationId: string,
  normalizedStartAt: string,
  durationMinutes?: number
) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        durationMinutes === undefined
          ? { reservationId, startAt: normalizedStartAt }
          : { reservationId, startAt: normalizedStartAt, durationMinutes }
      )
    )
    .digest("hex");

const insertConfirmedReservation = (
  db: SqliteD1Database,
  input: {
    id?: string;
    customerId?: string;
    lineIdentityId?: string;
    lineUserId?: string;
    startAt?: string;
    endAt?: string;
    status?: "confirmed" | "completed";
  } = {}
) => {
  const reservationId = input.id ?? RESERVATION_ID;
  const customerId = input.customerId ?? CUSTOMER_ID;
  const lineIdentityId = input.lineIdentityId ?? LINE_IDENTITY_ID;
  const lineUserId = input.lineUserId ?? LINE_USER_ID;
  const startAt = input.startAt ?? "2026-06-01T01:00:00.000Z";
  const endAt = input.endAt ?? "2026-06-01T02:00:00.000Z";
  const status = input.status ?? "confirmed";

  db.sqlite
    .prepare(
      `
        INSERT INTO customers (
          id,
          display_name,
          display_name_kana,
          phone_normalized,
          phone_hash,
          block_status,
          updated_at
        ) VALUES (?, '変更 顧客', 'ヘンコウ コキャク', ?, ?, 'active', '2026-05-09T00:00:00.000Z')
      `
    )
    .run(customerId, `075000${customerId.slice(-4)}`, `phone_hash_${customerId}`);
  db.sqlite
    .prepare(
      `
        INSERT INTO line_identities (
          id,
          customer_id,
          channel_id,
          line_user_id,
          friend_flag,
          official_friend_status,
          last_friend_checked_at,
          updated_at
        ) VALUES (?, ?, 'line_channel_id', ?, 1, 'friend', '2026-05-09T00:00:00.000Z', '2026-05-09T00:00:00.000Z')
      `
    )
    .run(lineIdentityId, customerId, lineUserId);
  db.sqlite
    .prepare(
      `
        INSERT INTO reservations (
          id,
          store_id,
          service_id,
          customer_id,
          resource_id,
          line_identity_id,
          source,
          status,
          start_at,
          end_at,
          duration_minutes,
          created_by,
          updated_by,
          idempotency_key,
          google_sync_state,
          version,
          updated_at
        ) VALUES (
          ?,
          'kyoto',
          'service_kyoto_default_60',
          ?,
          'resource_kyoto_calendar',
          ?,
          'web_line',
          ?,
          ?,
          ?,
          60,
          'fixture',
          'fixture',
          ?,
          'pending',
          1,
          '2026-05-09T00:00:00.000Z'
        )
      `
    )
    .run(reservationId, customerId, lineIdentityId, status, startAt, endAt, `fixture_${reservationId}`);

  for (const [index, slotAt] of [
    startAt,
    new Date(new Date(startAt).getTime() + 15 * 60 * 1000).toISOString(),
    new Date(new Date(startAt).getTime() + 30 * 60 * 1000).toISOString(),
    new Date(new Date(startAt).getTime() + 45 * 60 * 1000).toISOString()
  ].entries()) {
    db.sqlite
      .prepare(
        `
          INSERT INTO slot_locks (
            id,
            store_id,
            resource_id,
            slot_at,
            owner_type,
            owner_id,
            lock_status,
            expires_at
          ) VALUES (?, 'kyoto', 'resource_kyoto_calendar', ?, 'reservation', ?, 'confirmed', NULL)
        `
      )
      .run(`slot_lock_${reservationId}_${index}`, slotAt, reservationId);
    db.sqlite
      .prepare(
        `
          INSERT INTO customer_time_locks (
            id,
            customer_id,
            slot_at,
            owner_type,
            owner_id,
            lock_status,
            expires_at
          ) VALUES (?, ?, ?, 'reservation', ?, 'confirmed', NULL)
        `
      )
      .run(`customer_lock_${reservationId}_${index}`, customerId, slotAt, reservationId);
  }
};

const postReschedule = async (
  db: SqliteD1Database,
  token: string,
  reservationId: string,
  body: Record<string, unknown>
) => {
  const app = createApp();
  return app.request(
    `/api/admin/reservations/${reservationId}/reschedule`,
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
        "Cf-Access-Jwt-Assertion": token
      }
    },
    baseEnv(db)
  );
};

describe("admin reservation reschedule API", () => {
  beforeEach(() => {
    // Freeze only Date (real timers preserved for async flow) so the hard-coded
    // 2026-06-01 slots stay in the future regardless of wall-clock run date.
    vi.useFakeTimers({ now: new Date("2026-05-09T00:00:00.000Z"), toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("moves confirmed reservations by replacing D1 locks and queuing notification and Google jobs", async () => {
    const db = createMigratedSqliteD1();
    const access = createAdminRescheduleAccessFixture();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

    try {
      insertAdminUser(db);
      insertConfirmedReservation(db);

      const response = await postReschedule(db, access.token, RESERVATION_ID, {
        idempotencyKey: "admin-reschedule-1",
        startAt: "2026-06-01T03:00:00.000Z"
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        reservationId: RESERVATION_ID,
        status: "confirmed",
        startAt: "2026-06-01T03:00:00.000Z",
        endAt: "2026-06-01T04:00:00.000Z",
        replayed: false
      });

      const counts = db.sqlite
        .prepare(
          `
            SELECT
              (SELECT COUNT(*) FROM slot_locks WHERE owner_id = ? AND slot_at < '2026-06-01T03:00:00.000Z') AS oldSlotCount,
              (SELECT COUNT(*) FROM slot_locks WHERE owner_id = ? AND slot_at >= '2026-06-01T03:00:00.000Z') AS newSlotCount,
              (SELECT COUNT(*) FROM customer_time_locks WHERE owner_id = ? AND slot_at >= '2026-06-01T03:00:00.000Z') AS newCustomerLockCount,
              (SELECT COUNT(*) FROM notification_jobs WHERE reservation_id = ? AND template_key = 'reservation_time_changed') AS notificationCount,
              (SELECT COUNT(*) FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'upsert') AS calendarJobCount,
              (SELECT COUNT(*) FROM audit_logs WHERE target_id = ? AND action = 'admin_reservation_rescheduled') AS auditCount
          `
        )
        .get(RESERVATION_ID, RESERVATION_ID, RESERVATION_ID, RESERVATION_ID, RESERVATION_ID, RESERVATION_ID) as {
          oldSlotCount: number;
          newSlotCount: number;
          newCustomerLockCount: number;
          notificationCount: number;
          calendarJobCount: number;
          auditCount: number;
        };

      expect(counts).toEqual({
        oldSlotCount: 0,
        newSlotCount: 12,
        newCustomerLockCount: 12,
        notificationCount: 1,
        calendarJobCount: 1,
        auditCount: 1
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("moves a reservation onto the 5-minute lock grid but rejects a finer start", async () => {
    const db = createMigratedSqliteD1();
    const access = createAdminRescheduleAccessFixture();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

    try {
      insertAdminUser(db);
      insertConfirmedReservation(db);

      // 12:40 JST — off the 15-minute public grid, on the slot_locks grid.
      const moved = await postReschedule(db, access.token, RESERVATION_ID, {
        idempotencyKey: "admin-reschedule-lock-grid-1",
        startAt: "2026-06-01T03:40:00.000Z"
      });
      expect(moved.status).toBe(200);
      await expect(moved.json()).resolves.toMatchObject({
        ok: true,
        startAt: "2026-06-01T03:40:00.000Z"
      });

      const offGrid = await postReschedule(db, access.token, RESERVATION_ID, {
        idempotencyKey: "admin-reschedule-lock-grid-2",
        startAt: "2026-06-01T03:42:00.000Z"
      });
      expect(offGrid.status).toBe(400);
      await expect(offGrid.json()).resolves.toEqual({
        ok: false,
        reason: "invalid_time"
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("emits slot_lock_history released=N + created=N rows for an N-slot reschedule", async () => {
    const db = createMigratedSqliteD1();
    const access = createAdminRescheduleAccessFixture();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

    try {
      insertAdminUser(db);
      insertConfirmedReservation(db);

      const originalSlotCount = (
        db.sqlite
          .prepare(`SELECT COUNT(*) AS count FROM slot_locks WHERE owner_id = ?`)
          .get(RESERVATION_ID) as { count: number }
      ).count;
      expect(originalSlotCount).toBeGreaterThan(0);

      const response = await postReschedule(db, access.token, RESERVATION_ID, {
        idempotencyKey: "admin-reschedule-history-1",
        startAt: "2026-06-01T03:00:00.000Z"
      });
      expect(response.status).toBe(200);

      const newSlotCount = (
        db.sqlite
          .prepare(`SELECT COUNT(*) AS count FROM slot_locks WHERE owner_id = ?`)
          .get(RESERVATION_ID) as { count: number }
      ).count;

      const history = db.sqlite
        .prepare(
          `
            SELECT
              (SELECT COUNT(*) FROM slot_lock_history WHERE action = 'released' AND old_owner_id = ?) AS released,
              (SELECT COUNT(*) FROM slot_lock_history WHERE action = 'created' AND new_owner_id = ?) AS created
          `
        )
        .get(RESERVATION_ID, RESERVATION_ID) as { released: number; created: number };

      expect(history.released).toBe(originalSlotCount);
      expect(history.created).toBe(newSlotCount);
    } finally {
      db.sqlite.close();
    }
  });

  it("returns invalid_time without throwing when the existing reservation duration exceeds the 4h cap", async () => {
    const db = createMigratedSqliteD1();
    const access = createAdminRescheduleAccessFixture();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

    try {
      insertAdminUser(db);
      // Customer + line identity scaffolding from the standard fixture, but
      // insert a hand-rolled reservation with duration_minutes > 240 so the
      // 4h-cap guard in rescheduleAdminReservation has something to reject.
      db.sqlite
        .prepare(
          `INSERT INTO customers (id, display_name, phone_normalized, phone_hash, block_status, updated_at)
           VALUES (?, 'OOH', '07500000000', 'phone_hash_long', 'active', '2026-05-09T00:00:00.000Z')`
        )
        .run(CUSTOMER_ID);
      db.sqlite
        .prepare(
          `INSERT INTO line_identities (id, customer_id, channel_id, line_user_id, friend_flag, official_friend_status, last_friend_checked_at, updated_at)
           VALUES (?, ?, 'line_channel_id', ?, 1, 'friend', '2026-05-09T00:00:00.000Z', '2026-05-09T00:00:00.000Z')`
        )
        .run(LINE_IDENTITY_ID, CUSTOMER_ID, LINE_USER_ID);
      db.sqlite
        .prepare(
          `INSERT INTO reservations (
            id, store_id, service_id, customer_id, resource_id, line_identity_id,
            source, status, start_at, end_at, duration_minutes, created_by, updated_by,
            idempotency_key, google_sync_state, version, updated_at
          ) VALUES (
            ?, 'kyoto', 'service_kyoto_default_60', ?, 'resource_kyoto_calendar', ?,
            'web_line', 'confirmed', '2026-06-01T01:00:00.000Z', '2026-06-01T05:05:00.000Z', 245,
            'fixture', 'fixture', 'fixture_long_duration', 'pending', 1, '2026-05-09T00:00:00.000Z'
          )`
        )
        .run(RESERVATION_ID, CUSTOMER_ID, LINE_IDENTITY_ID);

      const response = await postReschedule(db, access.token, RESERVATION_ID, {
        idempotencyKey: "admin-reschedule-cap-1",
        startAt: "2026-06-02T01:00:00.000Z"
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "invalid_time"
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("rolls back to original locks when the new slot conflicts", async () => {
    const db = createMigratedSqliteD1();
    const access = createAdminRescheduleAccessFixture();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

    try {
      insertAdminUser(db);
      insertConfirmedReservation(db);
      insertConfirmedReservation(db, {
        id: "reservation_conflict_1",
        customerId: "customer_conflict_1",
        lineIdentityId: "line_identity_conflict_1",
        lineUserId: "line_user_conflict_1",
        startAt: "2026-06-01T03:00:00.000Z",
        endAt: "2026-06-01T04:00:00.000Z"
      });

      const response = await postReschedule(db, access.token, RESERVATION_ID, {
        idempotencyKey: "admin-reschedule-conflict-1",
        startAt: "2026-06-01T03:00:00.000Z"
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "slot_unavailable"
      });

      const original = db.sqlite
        .prepare(
          `
            SELECT
              reservations.start_at AS startAt,
              (SELECT COUNT(*) FROM slot_locks WHERE owner_id = ? AND slot_at < '2026-06-01T02:00:00.000Z') AS originalLockCount
            FROM reservations
            WHERE reservations.id = ?
          `
        )
        .get(RESERVATION_ID, RESERVATION_ID) as {
          startAt: string;
          originalLockCount: number;
        };
      expect(original).toEqual({
        startAt: "2026-06-01T01:00:00.000Z",
        originalLockCount: 4
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("does not replace locks when the guarded reschedule update loses a race", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db);
      insertConfirmedReservation(db);
      const racingDb = {
        prepare(sql: string) {
          return (db as unknown as D1Database).prepare(sql);
        },
        batch(statements: D1PreparedStatement[]) {
          db.sqlite
            .prepare(
              `
                UPDATE reservations
                SET status = 'cancelled_by_admin',
                    version = version + 1,
                    updated_at = '2026-05-09T23:04:59.999Z'
                WHERE id = ?
              `
            )
            .run(RESERVATION_ID);
          return db.batch(statements);
        }
      } as unknown as D1Database;

      const result = await rescheduleAdminReservation({
        db: racingDb,
        admin: {
          id: "admin_reschedule_owner_1",
          email: ADMIN_EMAIL,
          role: "owner",
  staff_member_id: null,
        store_id: null
        },
        reservationId: RESERVATION_ID,
        request: {
          idempotencyKey: "admin-reschedule-race-1",
          startAt: "2026-06-01T03:00:00.000Z"
        },
        now: () => Date.parse("2026-05-09T23:05:00.000Z")
      });

      // The guarded-transition poison-pill fires a second same-key INSERT, so the whole
      // batch (including the first started row) rolls back and no idempotency row
      // survives. The TTL-aware re-resolve therefore finds nothing in flight and returns
      // terminal write_failed (matching reservations.ts), not the old idempotency_in_progress.
      expect(result).toEqual({
        ok: false,
        reason: "write_failed"
      });
      expect(captureBatchWriteFailure).toHaveBeenCalledTimes(1);
      expect(captureBatchWriteFailure).toHaveBeenCalledWith(expect.any(Error), {
        component: "reservation-reschedule",
        op: "batch_write_failed",
        helper: "rescheduleAdminReservation"
      });
      const state = db.sqlite
        .prepare(
          `
            SELECT
              reservations.status,
              reservations.start_at AS startAt,
              (SELECT COUNT(*) FROM slot_locks WHERE owner_id = ? AND slot_at < '2026-06-01T02:00:00.000Z') AS originalSlotLocks,
              (SELECT COUNT(*) FROM slot_locks WHERE owner_id = ? AND slot_at >= '2026-06-01T03:00:00.000Z') AS newSlotLocks,
              (SELECT COUNT(*) FROM notification_jobs WHERE reservation_id = ?) AS notificationCount,
              (SELECT COUNT(*) FROM calendar_sync_jobs WHERE owner_id = ?) AS calendarJobCount,
              (SELECT COUNT(*) FROM audit_logs WHERE target_id = ? AND action = 'admin_reservation_rescheduled') AS auditCount
            FROM reservations
            WHERE reservations.id = ?
          `
        )
        .get(RESERVATION_ID, RESERVATION_ID, RESERVATION_ID, RESERVATION_ID, RESERVATION_ID, RESERVATION_ID) as {
        status: string;
        startAt: string;
        originalSlotLocks: number;
        newSlotLocks: number;
        notificationCount: number;
        calendarJobCount: number;
        auditCount: number;
      };
      expect(state).toEqual({
        status: "cancelled_by_admin",
        startAt: "2026-06-01T01:00:00.000Z",
        originalSlotLocks: 4,
        newSlotLocks: 0,
        notificationCount: 0,
        calendarJobCount: 0,
        auditCount: 0
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("returns write_failed (not idempotency_in_progress) when the colliding reschedule idempotency row is expired", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db);
      insertConfirmedReservation(db);
      // A crashed request's "started" row, already past its TTL relative to the clock below.
      db.sqlite
        .prepare(
          `
            INSERT INTO idempotency_keys (
              id, scope, idempotency_key, status, request_hash, expires_at
            ) VALUES (
              'admin_reschedule_expired_started_1', 'admin_action',
              'admin-reschedule-expired-1', 'started', 'stale-request-hash',
              '2026-05-09T00:00:00.000Z'
            )
          `
        )
        .run();

      const result = await rescheduleAdminReservation({
        db: db as unknown as D1Database,
        admin: {
          id: "admin_reschedule_owner_1",
          email: ADMIN_EMAIL,
          role: "owner",
          staff_member_id: null,
          store_id: null
        },
        reservationId: RESERVATION_ID,
        request: {
          idempotencyKey: "admin-reschedule-expired-1",
          startAt: "2026-06-01T03:00:00.000Z"
        },
        now: () => Date.parse("2026-05-12T00:00:00.000Z")
      });

      expect(result).toEqual({ ok: false, reason: "write_failed" });
      const state = db.sqlite
        .prepare(
          `
            SELECT
              (SELECT start_at FROM reservations WHERE id = ?) AS startAt,
              (SELECT COUNT(*) FROM idempotency_keys WHERE idempotency_key = 'admin-reschedule-expired-1') AS idempotencyCount,
              (SELECT COUNT(*) FROM audit_logs WHERE target_id = ? AND action = 'admin_reservation_rescheduled') AS auditCount
          `
        )
        .get(RESERVATION_ID, RESERVATION_ID) as {
        startAt: string;
        idempotencyCount: number;
        auditCount: number;
      };
      // Atomic rollback: reservation start unchanged, only the pre-existing expired row remains.
      expect(state).toEqual({
        startAt: "2026-06-01T01:00:00.000Z",
        idempotencyCount: 1,
        auditCount: 0
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("returns idempotency_in_progress when a concurrent valid-TTL same-hash request wins the batch race", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db);
      insertConfirmedReservation(db);
      // Start-only reschedule (no treatmentMinutes) → legacy 2-field hash.
      const inFlightHash = rescheduleRequestHash(RESERVATION_ID, "2026-06-01T03:00:00.000Z");
      // A concurrent in-flight request inserts its valid-TTL started row in the window
      // between this request's initial TTL read and its batch.
      const racingDb = {
        prepare(sql: string) {
          return (db as unknown as D1Database).prepare(sql);
        },
        batch(statements: D1PreparedStatement[]) {
          db.sqlite
            .prepare(
              `
                INSERT INTO idempotency_keys (
                  id, scope, idempotency_key, status, request_hash, expires_at
                ) VALUES (
                  'concurrent_reschedule_inflight_1', 'admin_action',
                  'admin-reschedule-inflight-1', 'started', ?, '2999-01-01T00:00:00.000Z'
                )
              `
            )
            .run(inFlightHash);
          return db.batch(statements);
        }
      } as unknown as D1Database;

      const result = await rescheduleAdminReservation({
        db: racingDb,
        admin: {
          id: "admin_reschedule_owner_1",
          email: ADMIN_EMAIL,
          role: "owner",
          staff_member_id: null,
          store_id: null
        },
        reservationId: RESERVATION_ID,
        request: {
          idempotencyKey: "admin-reschedule-inflight-1",
          startAt: "2026-06-01T03:00:00.000Z"
        },
        now: () => Date.parse("2026-05-12T00:00:00.000Z")
      });

      // The re-resolve finds the concurrent valid-TTL row with a matching hash -> in flight.
      expect(result).toEqual({ ok: false, reason: "idempotency_in_progress" });
      expect(captureBatchWriteFailure).not.toHaveBeenCalled();
      const startAt = db.sqlite
        .prepare("SELECT start_at AS startAt FROM reservations WHERE id = ?")
        .get(RESERVATION_ID) as { startAt: string };
      expect(startAt).toEqual({ startAt: "2026-06-01T01:00:00.000Z" });
    } finally {
      db.sqlite.close();
    }
  });

  it("replays a start-only reschedule seeded with the legacy 2-field idempotency hash", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db);
      insertConfirmedReservation(db);
      // Pre-deploy code hashed { reservationId, startAt } only. A succeeded row written then must
      // still replay after this change — the start-only hash must stay 2-field (no durationMinutes),
      // or a lost-response retry crossing the deploy boundary would wrongly get idempotency_conflict.
      const legacyHash = rescheduleRequestHash(RESERVATION_ID, "2026-06-01T03:00:00.000Z");
      db.sqlite
        .prepare(
          `
            INSERT INTO idempotency_keys (
              id, scope, idempotency_key, status, target_type, target_id, request_hash, expires_at
            ) VALUES (
              'admin_reschedule_legacy_succeeded_1', 'admin_action',
              'admin-reschedule-legacy-1', 'succeeded', 'reservation', ?, ?, '2999-01-01T00:00:00.000Z'
            )
          `
        )
        .run(RESERVATION_ID, legacyHash);

      const result = await rescheduleAdminReservation({
        db: db as unknown as D1Database,
        admin: {
          id: "admin_reschedule_owner_1",
          email: ADMIN_EMAIL,
          role: "owner",
          staff_member_id: null,
          store_id: null
        },
        reservationId: RESERVATION_ID,
        request: {
          idempotencyKey: "admin-reschedule-legacy-1",
          startAt: "2026-06-01T03:00:00.000Z"
        },
        now: () => Date.parse("2026-05-12T00:00:00.000Z")
      });

      expect(result).toMatchObject({ ok: true, replayed: true });
    } finally {
      db.sqlite.close();
    }
  });

  it("returns idempotency_conflict when a different-hash row wins the batch race", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db);
      insertConfirmedReservation(db);
      // A concurrent request with the same key but a DIFFERENT payload wins the race.
      const racingDb = {
        prepare(sql: string) {
          return (db as unknown as D1Database).prepare(sql);
        },
        batch(statements: D1PreparedStatement[]) {
          db.sqlite
            .prepare(
              `
                INSERT INTO idempotency_keys (
                  id, scope, idempotency_key, status, request_hash, expires_at
                ) VALUES (
                  'concurrent_reschedule_conflict_1', 'admin_action',
                  'admin-reschedule-conflict-race-1', 'started', 'different-request-hash',
                  '2999-01-01T00:00:00.000Z'
                )
              `
            )
            .run();
          return db.batch(statements);
        }
      } as unknown as D1Database;

      const result = await rescheduleAdminReservation({
        db: racingDb,
        admin: {
          id: "admin_reschedule_owner_1",
          email: ADMIN_EMAIL,
          role: "owner",
          staff_member_id: null,
          store_id: null
        },
        reservationId: RESERVATION_ID,
        request: {
          idempotencyKey: "admin-reschedule-conflict-race-1",
          startAt: "2026-06-01T03:00:00.000Z"
        },
        now: () => Date.parse("2026-05-12T00:00:00.000Z")
      });

      // The re-resolve finds the valid-TTL row whose hash differs -> conflict (improvement
      // over the old blanket idempotency_in_progress).
      expect(result).toEqual({ ok: false, reason: "idempotency_conflict" });
      const startAt = db.sqlite
        .prepare("SELECT start_at AS startAt FROM reservations WHERE id = ?")
        .get(RESERVATION_ID) as { startAt: string };
      expect(startAt).toEqual({ startAt: "2026-06-01T01:00:00.000Z" });
    } finally {
      db.sqlite.close();
    }
  });

  it("replays identical reschedule requests by idempotency key", async () => {
    const db = createMigratedSqliteD1();
    const access = createAdminRescheduleAccessFixture();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

    try {
      insertAdminUser(db);
      insertConfirmedReservation(db);
      const body = {
        idempotencyKey: "admin-reschedule-replay-1",
        startAt: "2026-06-01T03:00:00.000Z"
      };

      const first = await postReschedule(db, access.token, RESERVATION_ID, body);
      const second = await postReschedule(db, access.token, RESERVATION_ID, body);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      await expect(second.json()).resolves.toMatchObject({
        ok: true,
        replayed: true
      });
      const jobCount = db.sqlite
        .prepare("SELECT COUNT(*) AS count FROM calendar_sync_jobs WHERE owner_id = ?")
        .get(RESERVATION_ID) as { count: number };
      expect(jobCount.count).toBe(1);
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects rescheduling to closed business days", async () => {
    const db = createMigratedSqliteD1();
    const access = createAdminRescheduleAccessFixture();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

    try {
      insertAdminUser(db);
      insertConfirmedReservation(db);

      const response = await postReschedule(db, access.token, RESERVATION_ID, {
        idempotencyKey: "admin-reschedule-friday-1",
        startAt: "2026-06-05T03:00:00.000Z"
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "outside_business_hours"
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("returns store_closed when a closure is committed after the reschedule precheck", async () => {
    const db = createMigratedSqliteD1();
    const access = createAdminRescheduleAccessFixture();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

    try {
      insertAdminUser(db);
      insertConfirmedReservation(db);
      const originalBatch = db.batch.bind(db);
      let injected = false;
      db.batch = async (statements) => {
        if (!injected) {
          injected = true;
          db.sqlite
            .prepare(
              `INSERT INTO store_closures (id, store_id, starts_at, ends_at, source)
               VALUES ('closure_admin_reschedule_race', 'kyoto',
                       '2026-06-01T03:00:00.000Z', '2026-06-01T04:00:00.000Z', 'admin')`
            )
            .run();
        }
        return originalBatch(statements);
      };

      const response = await postReschedule(db, access.token, RESERVATION_ID, {
        idempotencyKey: "admin-reschedule-closure-race",
        startAt: "2026-06-01T03:00:00.000Z"
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ ok: false, reason: "store_closed" });
      expect(captureBatchWriteFailure).not.toHaveBeenCalled();
      const row = db.sqlite
        .prepare("SELECT start_at, end_at, version FROM reservations WHERE id = ?")
        .get(RESERVATION_ID) as { start_at: string; end_at: string; version: number };
      expect(row).toEqual({
        start_at: "2026-06-01T01:00:00.000Z",
        end_at: "2026-06-01T02:00:00.000Z",
        version: 1
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("uses the customer's current phone_hash when it changes after the reschedule precheck", async () => {
    const db = createMigratedSqliteD1();
    const access = createAdminRescheduleAccessFixture();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

    try {
      insertAdminUser(db);
      insertConfirmedReservation(db);
      db.sqlite.prepare("UPDATE reservations SET source = 'phone_admin' WHERE id = ?").run(RESERVATION_ID);
      const currentPhoneHash = "phone_hash_admin_reschedule_after";
      const originalBatch = db.batch.bind(db);
      db.batch = async (statements) => {
        db.sqlite
          .prepare("UPDATE customers SET phone_normalized = '0900000022', phone_hash = ? WHERE id = ?")
          .run(currentPhoneHash, CUSTOMER_ID);
        return originalBatch(statements);
      };

      const response = await postReschedule(db, access.token, RESERVATION_ID, {
        idempotencyKey: "admin-reschedule-phone-hash-race",
        startAt: "2026-06-01T03:00:00.000Z"
      });

      expect(response.status).toBe(200);
      const lockHashes = db.sqlite
        .prepare("SELECT DISTINCT phone_hash FROM customer_time_locks WHERE owner_id = ?")
        .all(RESERVATION_ID) as Array<{ phone_hash: string | null }>;
      expect(lockHashes).toEqual([{ phone_hash: currentPhoneHash }]);
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects rescheduling inactive reservations", async () => {
    const db = createMigratedSqliteD1();
    const access = createAdminRescheduleAccessFixture();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

    try {
      insertAdminUser(db);
      insertConfirmedReservation(db, {
        status: "completed"
      });

      const response = await postReschedule(db, access.token, RESERVATION_ID, {
        idempotencyKey: "admin-reschedule-inactive-1",
        startAt: "2026-06-01T03:00:00.000Z"
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "invalid_transition"
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects reschedule when destination slot is held by another customer with the same phone_hash (codex #16)", async () => {
    const db = createMigratedSqliteD1();
    const access = createAdminRescheduleAccessFixture();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

    try {
      insertAdminUser(db);
      insertConfirmedReservation(db);
      const sharedPhoneHash = `phone_hash_${CUSTOMER_ID}`;

      db.sqlite
        .prepare("UPDATE reservations SET source = 'phone_admin' WHERE id = ?")
        .run(RESERVATION_ID);
      db.sqlite
        .prepare(
          `
            UPDATE customer_time_locks
            SET phone_hash = ?
            WHERE owner_id = ?
          `
        )
        .run(sharedPhoneHash, RESERVATION_ID);

      const ghostReservationId = "reservation_codex16_ghost";
      const ghostCustomerId = "customer_codex16_ghost";
      const ghostStartAt = "2026-06-01T03:00:00.000Z";
      db.sqlite
        .prepare(
          `
            INSERT INTO customers (
              id,
              display_name,
              phone_normalized,
              phone_hash,
              block_status,
              created_at,
              updated_at
            ) VALUES (?, '幽霊 顧客', '0750009999', ?, 'active', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')
          `
        )
        .run(ghostCustomerId, sharedPhoneHash);
      db.sqlite
        .prepare(
          `
            INSERT INTO reservations (
              id, store_id, service_id, customer_id, resource_id, line_identity_id,
              source, status, start_at, end_at, duration_minutes,
              created_by, updated_by, idempotency_key, google_sync_state, version, updated_at
            ) VALUES (
              ?, 'osaka', 'service_osaka_default_60', ?, 'resource_osaka_calendar', NULL,
              'phone_admin', 'confirmed', ?, '2026-06-01T04:00:00.000Z', 60,
              'fixture', 'fixture', 'fixture_codex16_ghost', 'pending', 1, '2026-05-09T00:00:00.000Z'
            )
          `
        )
        .run(ghostReservationId, ghostCustomerId, ghostStartAt);

      for (const [index, slotAt] of [
        ghostStartAt,
        new Date(new Date(ghostStartAt).getTime() + 15 * 60 * 1000).toISOString(),
        new Date(new Date(ghostStartAt).getTime() + 30 * 60 * 1000).toISOString(),
        new Date(new Date(ghostStartAt).getTime() + 45 * 60 * 1000).toISOString()
      ].entries()) {
        db.sqlite
          .prepare(
            `
              INSERT INTO customer_time_locks (
                id, customer_id, slot_at, owner_type, owner_id, lock_status, expires_at, phone_hash
              ) VALUES (?, ?, ?, 'reservation', ?, 'confirmed', NULL, ?)
            `
          )
          .run(`ghost_lock_${index}`, ghostCustomerId, slotAt, ghostReservationId, sharedPhoneHash);
      }

      const response = await postReschedule(db, access.token, RESERVATION_ID, {
        idempotencyKey: "admin-reschedule-codex16-1",
        startAt: ghostStartAt
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "customer_time_conflict"
      });

      const originalSlot = db.sqlite
        .prepare("SELECT start_at FROM reservations WHERE id = ?")
        .get(RESERVATION_ID) as { start_at: string };
      expect(originalSlot.start_at).toBe("2026-06-01T01:00:00.000Z");
    } finally {
      db.sqlite.close();
    }
  });

  it("preserves NULL phone_hash on the new lock when rescheduling a web_line reservation (codex #16)", async () => {
    const db = createMigratedSqliteD1();
    const access = createAdminRescheduleAccessFixture();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

    try {
      insertAdminUser(db);
      insertConfirmedReservation(db);

      const response = await postReschedule(db, access.token, RESERVATION_ID, {
        idempotencyKey: "admin-reschedule-codex16-webline-1",
        startAt: "2026-06-01T03:00:00.000Z"
      });

      expect(response.status).toBe(200);

      const newLocks = db.sqlite
        .prepare(
          `
            SELECT phone_hash
            FROM customer_time_locks
            WHERE owner_id = ?
              AND slot_at >= '2026-06-01T03:00:00.000Z'
              AND slot_at < '2026-06-01T04:00:00.000Z'
          `
        )
        .all(RESERVATION_ID) as Array<{ phone_hash: string | null }>;
      expect(newLocks.length).toBeGreaterThan(0);
      for (const lock of newLocks) {
        expect(lock.phone_hash).toBeNull();
      }
    } finally {
      db.sqlite.close();
    }
  });

  it("extends treatment duration and recomputes end/duration/locks", async () => {
    const db = createMigratedSqliteD1();
    const access = createAdminRescheduleAccessFixture();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

    try {
      insertAdminUser(db);
      insertConfirmedReservation(db);

      const response = await postReschedule(db, access.token, RESERVATION_ID, {
        idempotencyKey: "admin-reschedule-duration-extend-1",
        startAt: "2026-06-01T01:00:00.000Z",
        treatmentMinutes: 70
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        endAt: "2026-06-01T02:15:00.000Z",
        replayed: false
      });

      const state = db.sqlite
        .prepare(
          `
            SELECT
              reservations.duration_minutes AS durationMinutes,
              reservations.end_at AS endAt,
              (SELECT COUNT(*) FROM slot_locks WHERE owner_id = ?) AS lockCount,
              (SELECT COUNT(*) FROM slot_locks
                WHERE owner_id = ?
                  AND (slot_at < '2026-06-01T01:00:00.000Z'
                    OR slot_at >= '2026-06-01T02:15:00.000Z')) AS outsideLockCount,
              (SELECT metadata_json FROM audit_logs
                WHERE target_id = ? AND action = 'admin_reservation_rescheduled'
                LIMIT 1) AS metadataJson
            FROM reservations
            WHERE reservations.id = ?
          `
        )
        .get(RESERVATION_ID, RESERVATION_ID, RESERVATION_ID, RESERVATION_ID) as {
        durationMinutes: number;
        endAt: string;
        lockCount: number;
        outsideLockCount: number;
        metadataJson: string;
      };

      expect(state).toMatchObject({
        durationMinutes: 75,
        endAt: "2026-06-01T02:15:00.000Z",
        lockCount: 15,
        outsideLockCount: 0
      });
      expect(JSON.parse(state.metadataJson)).toMatchObject({
        previousDurationMinutes: 60,
        nextDurationMinutes: 75
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("shrinks treatment duration", async () => {
    const db = createMigratedSqliteD1();
    const access = createAdminRescheduleAccessFixture();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

    try {
      insertAdminUser(db);
      insertConfirmedReservation(db);

      const response = await postReschedule(db, access.token, RESERVATION_ID, {
        idempotencyKey: "admin-reschedule-duration-shrink-1",
        startAt: "2026-06-01T01:00:00.000Z",
        treatmentMinutes: 30
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        endAt: "2026-06-01T01:35:00.000Z"
      });
      const state = db.sqlite
        .prepare(
          `
            SELECT
              reservations.duration_minutes AS durationMinutes,
              reservations.end_at AS endAt,
              (SELECT COUNT(*) FROM slot_locks WHERE owner_id = ?) AS lockCount
            FROM reservations
            WHERE reservations.id = ?
          `
        )
        .get(RESERVATION_ID, RESERVATION_ID) as {
        durationMinutes: number;
        endAt: string;
        lockCount: number;
      };
      expect(state).toEqual({
        durationMinutes: 35,
        endAt: "2026-06-01T01:35:00.000Z",
        lockCount: 7
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("allows a duration-only change on a reservation whose start is already in the past", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db);
      insertConfirmedReservation(db); // start 01:00

      // The primary real-world use of 施術時間変更: the treatment is running long, so the slot is
      // extended after the appointment has already started. The unchanged (now-past) start must NOT
      // be rejected by the future-start guard — that guard only applies when the start actually moves.
      const result = await rescheduleAdminReservation({
        db: db as unknown as D1Database,
        admin: {
          id: "admin_reschedule_owner_1",
          email: ADMIN_EMAIL,
          role: "owner",
          staff_member_id: null,
          store_id: null
        },
        reservationId: RESERVATION_ID,
        request: {
          idempotencyKey: "admin-reschedule-past-start-duration-1",
          startAt: "2026-06-01T01:00:00.000Z",
          treatmentMinutes: 70
        },
        now: () => Date.parse("2026-06-01T01:30:00.000Z") // 30 min after the appointment started
      });

      expect(result).toMatchObject({ ok: true, endAt: "2026-06-01T02:15:00.000Z" });
      const row = db.sqlite
        .prepare("SELECT duration_minutes AS durationMinutes, end_at AS endAt FROM reservations WHERE id = ?")
        .get(RESERVATION_ID) as { durationMinutes: number; endAt: string };
      expect(row).toEqual({ durationMinutes: 75, endAt: "2026-06-01T02:15:00.000Z" });
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects a start-time move into the past", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db);
      insertConfirmedReservation(db); // start 01:00

      // A real start move (01:00 -> 00:30) into the past must still be rejected — the relaxed
      // future guard only skips the check when the start is unchanged.
      const result = await rescheduleAdminReservation({
        db: db as unknown as D1Database,
        admin: {
          id: "admin_reschedule_owner_1",
          email: ADMIN_EMAIL,
          role: "owner",
          staff_member_id: null,
          store_id: null
        },
        reservationId: RESERVATION_ID,
        request: {
          idempotencyKey: "admin-reschedule-past-move-1",
          startAt: "2026-06-01T00:30:00.000Z"
        },
        now: () => Date.parse("2026-06-01T01:30:00.000Z")
      });

      expect(result).toEqual({ ok: false, reason: "invalid_time" });
    } finally {
      db.sqlite.close();
    }
  });

  it.each([
    { label: "above the 235 cap", key: "admin-reschedule-duration-cap-1", treatmentMinutes: 240 },
    { label: "off the 5-minute grid", key: "admin-reschedule-duration-grid-1", treatmentMinutes: 37 },
    { label: "zero", key: "admin-reschedule-duration-zero-1", treatmentMinutes: 0 }
  ])("rejects treatment $label", async ({ key, treatmentMinutes }) => {
    const db = createMigratedSqliteD1();
    const access = createAdminRescheduleAccessFixture();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

    try {
      insertAdminUser(db);
      insertConfirmedReservation(db);

      const response = await postReschedule(db, access.token, RESERVATION_ID, {
        idempotencyKey: key,
        startAt: "2026-06-01T01:00:00.000Z",
        treatmentMinutes
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "invalid_request"
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects extension that collides with the next reservation", async () => {
    const db = createMigratedSqliteD1();
    const access = createAdminRescheduleAccessFixture();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

    try {
      insertAdminUser(db);
      insertConfirmedReservation(db);
      insertConfirmedReservation(db, {
        id: "reservation_duration_next_1",
        customerId: "customer_duration_next_1",
        lineIdentityId: "line_identity_duration_next_1",
        lineUserId: "line_user_duration_next_1",
        startAt: "2026-06-01T02:00:00.000Z",
        endAt: "2026-06-01T03:00:00.000Z"
      });

      const response = await postReschedule(db, access.token, RESERVATION_ID, {
        idempotencyKey: "admin-reschedule-duration-collision-1",
        startAt: "2026-06-01T01:00:00.000Z",
        treatmentMinutes: 70
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "slot_unavailable"
      });
      const unchanged = db.sqlite
        .prepare("SELECT duration_minutes, end_at FROM reservations WHERE id = ?")
        .get(RESERVATION_ID) as { duration_minutes: number; end_at: string };
      expect(unchanged).toEqual({
        duration_minutes: 60,
        end_at: "2026-06-01T02:00:00.000Z"
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("suppresses LINE notification but keeps calendar sync on duration change", async () => {
    const db = createMigratedSqliteD1();
    const access = createAdminRescheduleAccessFixture();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

    try {
      insertAdminUser(db);
      insertConfirmedReservation(db);

      const response = await postReschedule(db, access.token, RESERVATION_ID, {
        idempotencyKey: "admin-reschedule-duration-jobs-1",
        startAt: "2026-06-01T01:00:00.000Z",
        treatmentMinutes: 70
      });
      expect(response.status).toBe(200);

      const jobs = db.sqlite
        .prepare(
          `
            SELECT
              (SELECT COUNT(*) FROM notification_jobs
                WHERE reservation_id = ? AND template_key = 'reservation_time_changed') AS notificationCount,
              (SELECT COUNT(*) FROM calendar_sync_jobs
                WHERE owner_id = ? AND google_action = 'upsert') AS calendarJobCount
          `
        )
        .get(RESERVATION_ID, RESERVATION_ID) as {
        notificationCount: number;
        calendarJobCount: number;
      };
      expect(jobs).toEqual({
        notificationCount: 0,
        calendarJobCount: 1
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("notifies when a request moves the start time even if treatmentMinutes is also present", async () => {
    const db = createMigratedSqliteD1();
    const access = createAdminRescheduleAccessFixture();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

    try {
      insertAdminUser(db);
      insertConfirmedReservation(db); // start 01:00

      // Mixed request: start MOVES to 03:00 AND treatmentMinutes is set. The appointment start
      // actually changes, so suppression must NOT apply — the customer still gets notified.
      const response = await postReschedule(db, access.token, RESERVATION_ID, {
        idempotencyKey: "admin-reschedule-mixed-move-1",
        startAt: "2026-06-01T03:00:00.000Z",
        treatmentMinutes: 70
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        endAt: "2026-06-01T04:15:00.000Z" // 03:00 + (70 + 5 buffer)
      });

      const state = db.sqlite
        .prepare(
          `
            SELECT
              reservations.duration_minutes AS durationMinutes,
              (SELECT COUNT(*) FROM notification_jobs
                WHERE reservation_id = ? AND template_key = 'reservation_time_changed') AS notificationCount
            FROM reservations
            WHERE reservations.id = ?
          `
        )
        .get(RESERVATION_ID, RESERVATION_ID) as {
        durationMinutes: number;
        notificationCount: number;
      };
      expect(state).toEqual({
        durationMinutes: 75,
        notificationCount: 1
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("still notifies on start-only reschedule", async () => {
    const db = createMigratedSqliteD1();
    const access = createAdminRescheduleAccessFixture();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

    try {
      insertAdminUser(db);
      insertConfirmedReservation(db);

      const response = await postReschedule(db, access.token, RESERVATION_ID, {
        idempotencyKey: "admin-reschedule-start-only-regression-1",
        startAt: "2026-06-01T03:00:00.000Z"
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        endAt: "2026-06-01T04:00:00.000Z"
      });
      const state = db.sqlite
        .prepare(
          `
            SELECT
              reservations.duration_minutes AS durationMinutes,
              (SELECT COUNT(*) FROM notification_jobs
                WHERE reservation_id = ? AND template_key = 'reservation_time_changed') AS notificationCount
            FROM reservations
            WHERE reservations.id = ?
          `
        )
        .get(RESERVATION_ID, RESERVATION_ID) as {
        durationMinutes: number;
        notificationCount: number;
      };
      expect(state).toEqual({
        durationMinutes: 60,
        notificationCount: 1
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("replays duration-change with same idempotency key", async () => {
    const db = createMigratedSqliteD1();
    const access = createAdminRescheduleAccessFixture();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

    try {
      insertAdminUser(db);
      insertConfirmedReservation(db);
      const body = {
        idempotencyKey: "admin-reschedule-duration-replay-1",
        startAt: "2026-06-01T01:00:00.000Z",
        treatmentMinutes: 70
      };

      const first = await postReschedule(db, access.token, RESERVATION_ID, body);
      const second = await postReschedule(db, access.token, RESERVATION_ID, body);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      await expect(second.json()).resolves.toMatchObject({
        ok: true,
        replayed: true
      });

      const conflict = await postReschedule(db, access.token, RESERVATION_ID, {
        ...body,
        treatmentMinutes: 75
      });
      expect(conflict.status).toBe(409);
      await expect(conflict.json()).resolves.toEqual({
        ok: false,
        reason: "idempotency_conflict"
      });

      const sideEffects = db.sqlite
        .prepare(
          `
            SELECT
              (SELECT COUNT(*) FROM calendar_sync_jobs WHERE owner_id = ?) AS calendarJobCount,
              (SELECT COUNT(*) FROM audit_logs
                WHERE target_id = ? AND action = 'admin_reservation_rescheduled') AS auditCount
          `
        )
        .get(RESERVATION_ID, RESERVATION_ID) as {
        calendarJobCount: number;
        auditCount: number;
      };
      expect(sideEffects).toEqual({
        calendarJobCount: 1,
        auditCount: 1
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("forbids cross-store duration change for staff", async () => {
    const db = createMigratedSqliteD1();

    try {
      insertConfirmedReservation(db);

      const result = await rescheduleAdminReservation({
        db: db as unknown as D1Database,
        admin: {
          id: "admin_reschedule_staff_osaka_1",
          email: "staff-osaka@example.com",
          role: "staff",
          staff_member_id: null,
          store_id: "osaka"
        },
        reservationId: RESERVATION_ID,
        request: {
          idempotencyKey: "admin-reschedule-duration-cross-store-1",
          startAt: "2026-06-01T01:00:00.000Z",
          treatmentMinutes: 70
        },
        now: () => Date.parse("2026-05-09T00:00:00.000Z")
      });

      expect(result).toEqual({
        ok: false,
        reason: "forbidden"
      });
    } finally {
      db.sqlite.close();
    }
  });
});
