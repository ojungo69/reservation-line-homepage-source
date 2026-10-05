import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import type { WorkerBindings } from "../src/bindings";
import worker from "../src/index";
import {
  listPendingReservations,
  runAdminReservationAction,
  type AdminReservationAction
} from "../src/admin/reservations";
import { rescheduleAdminReservation } from "../src/admin/reservation-reschedule";
import { listAdminReservations, listAdminReservationsForPeriod } from "../src/admin/operations";
import { reservationCsvLine } from "../src/admin/csv";
import type { AdminUser } from "../src/admin/access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";
import { createAccessJwtFixture as createAccessJwtFixtureFromHelper, requestUrl, type AccessJwk, type AccessJwtFixture, insertAdminUser as insertAdminUserHelper, type AdminRole } from "./helpers/admin-access";

const TEAM_DOMAIN = "https://team.example.cloudflareaccess.com";
const ACCESS_AUD = "admin-access-aud";
const ADMIN_EMAIL = "owner@example.com";
const ADMIN_ACCESS_SUBJECT = "access-subject-1";
const LINE_USER_ID = "line_user_admin_test";
const RESERVATION_ID = "reservation_admin_pending_1";
const CUSTOMER_ID = "customer_admin_1";
const LINE_IDENTITY_ID = "line_identity_admin_1";

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

const createAccessJwtFixture = (
  claims: Record<string, unknown> = {},
  keyId = "test-access-key-1"
): AccessJwtFixture =>
  createAccessJwtFixtureFromHelper({
    issuer: TEAM_DOMAIN,
    audience: ACCESS_AUD,
    keyId,
    claims: { email: ADMIN_EMAIL, sub: ADMIN_ACCESS_SUBJECT, ...claims }
  });

const createFetchMock = (
  jwk: AccessJwk,
  lineProfileStatus = 200
) => {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = requestUrl(input);
    if (url === `${TEAM_DOMAIN}/cdn-cgi/access/certs`) {
      return Response.json({
        keys: [jwk]
      });
    }
    if (url === `https://api.line.me/v2/bot/profile/${LINE_USER_ID}`) {
      return Response.json(
        lineProfileStatus === 200 ? { userId: LINE_USER_ID } : { message: "not found" },
        { status: lineProfileStatus }
      );
    }
    return Response.json({ message: "unexpected test URL" }, { status: 404 });
  });
};

const createThrowingDb = (message = "forced admin database failure"): D1Database =>
  ({
    prepare: vi.fn(() => {
      throw new Error(message);
    })
  }) as unknown as D1Database;

const baseEnv = (db: SqliteD1Database | D1Database): Record<string, unknown> => ({
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  ACCESS_AUD,
  LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "line_bot_token",
  DB: db
});

const insertAdminUser = (db: SqliteD1Database, role: AdminRole = "owner") =>
  insertAdminUserHelper(db, {
    id: "admin_owner_1",
    email: ADMIN_EMAIL,
    accessSubject: ADMIN_ACCESS_SUBJECT,
    role,
    updatedAt: "2026-05-09T00:00:00.000Z",
  });

const insertPendingReservation = (db: SqliteD1Database, status: "pending_approval" | "confirmed" = "pending_approval") => {
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
        ) VALUES (?, '予約 太郎', 'ヨヤク タロウ', '0751234567', 'phone_hash_admin_1', 'active', '2026-05-09T00:00:00.000Z')
      `
    )
    .run(CUSTOMER_ID);
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
    .run(LINE_IDENTITY_ID, CUSTOMER_ID, LINE_USER_ID);
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
          pending_expires_at,
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
          '2026-06-01T01:00:00.000Z',
          '2026-06-01T02:00:00.000Z',
          60,
          '2099-01-01T00:00:00.000Z',
          'line_user_admin_test',
          'line_user_admin_test',
          'public_submit_admin_fixture',
          'pending',
          1,
          '2026-05-09T00:00:00.000Z'
        )
      `
    )
    .run(RESERVATION_ID, CUSTOMER_ID, LINE_IDENTITY_ID, status);

  for (const [index, slotAt] of [
    "2026-06-01T01:00:00.000Z",
    "2026-06-01T01:15:00.000Z",
    "2026-06-01T01:30:00.000Z",
    "2026-06-01T01:45:00.000Z"
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
          ) VALUES (?, 'kyoto', 'resource_kyoto_calendar', ?, 'reservation', ?, ?, '2026-06-02T01:00:00.000Z')
        `
      )
      .run(`slot_lock_admin_${index}`, slotAt, RESERVATION_ID, status === "confirmed" ? "confirmed" : "pending");
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
          ) VALUES (?, ?, ?, 'reservation', ?, ?, '2026-06-02T01:00:00.000Z')
        `
      )
      .run(`customer_lock_admin_${index}`, CUSTOMER_ID, slotAt, RESERVATION_ID, status === "confirmed" ? "confirmed" : "pending");
  }
};

const adminRequest = async (
  db: SqliteD1Database,
  path: string,
  token: string,
  body?: Record<string, unknown>
) => {
  const app = createApp();
  return app.request(
    path,
    {
      method: body ? "POST" : "GET",
      body: body ? JSON.stringify(body) : undefined,
      headers: {
        "Content-Type": "application/json",
        "Cf-Access-Jwt-Assertion": token
      }
    },
    baseEnv(db)
  );
};

const stubExecutionContext = () =>
  ({
    waitUntil: () => undefined,
    passThroughOnException: () => undefined
  }) as unknown as ExecutionContext;

const adminWorkerRequest = (db: D1Database, path: string, token: string) =>
  worker.fetch(
    new Request(`https://reservation.test${path}`, {
      headers: { "Cf-Access-Jwt-Assertion": token }
    }),
    baseEnv(db) as unknown as WorkerBindings,
    stubExecutionContext()
  );

const expectPrivateAdminResponse = (response: Response) => {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("pragma")).toBe("no-cache");
};

describe("admin reservation API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects admin API calls without a Cloudflare Access JWT", async () => {
    const db = createMigratedSqliteD1();
    try {
      const app = createApp();
      const response = await app.request("/api/admin/reservations/pending", {}, baseEnv(db));

      expect(response.status).toBe(403);
      expectPrivateAdminResponse(response);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "admin_auth_failed"
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("keeps private cache headers on unexpected admin API errors", async () => {
    const app = createApp();
    const access = createAccessJwtFixture();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      const response = await app.request(
        "/api/admin/reservations/pending",
        {
          headers: {
            "Cf-Access-Jwt-Assertion": access.token
          }
        },
        {
          ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
          ACCESS_AUD,
          DB: createThrowingDb()
        }
      );

      expect(response.status).toBe(500);
      expectPrivateAdminResponse(response);
      await expect(response.json()).resolves.toEqual({
        error: "internal_server_error"
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("keeps pending reservations available when the pre-request sweep hits a retryable D1 error", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    const internalError = new Error("D1_ERROR: internal error; reference = x");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      insertPendingReservation(db);
      const failingDb = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === "prepare") {
            return (sql: string) => {
              if (sql.includes("ORDER BY pending_expires_at ASC, created_at ASC")) {
                throw internalError;
              }
              return target.prepare(sql);
            };
          }
          return Reflect.get(target, prop, receiver);
        }
      }) as unknown as D1Database;

      const response = await adminWorkerRequest(
        failingDb,
        "/api/admin/reservations/pending",
        access.token
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        reservations: [{ id: RESERVATION_ID }]
      });
      expect(warnSpy).toHaveBeenCalledWith(
        "pending_reservation_expiration_transient_d1",
        { event: "transient_d1" }
      );
    } finally {
      warnSpy.mockRestore();
      db.sqlite.close();
    }
  });

  it("does not log secret values from unexpected admin API errors", async () => {
    const app = createApp();
    const access = createAccessJwtFixture();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      await app.request(
        "/api/admin/reservations/pending",
        {
          headers: {
            "Cf-Access-Jwt-Assertion": access.token
          }
        },
        {
          ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
          ACCESS_AUD,
          DB: createThrowingDb("database failed with token secret_access_token_forbidden")
        }
      );

      const logArgs = errorSpy.mock.calls.flat();
      expect(logArgs).toContain("Unhandled application error");
      expect(logArgs).toContainEqual({ category: "error" });
      expect(logArgs.some((arg) => String(arg).includes("secret_access_token_forbidden"))).toBe(false);
      expect(logArgs.some((arg) => arg instanceof Error && arg.message.includes("secret_access_token_forbidden"))).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rejects valid Access JWTs when the email is not registered as an active admin user", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      const response = await adminRequest(db, "/api/admin/reservations/pending", access.token);

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "admin_not_registered"
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects Access JWTs when the email matches but the Access subject does not", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture({ sub: "access-subject-reassigned" });
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      const response = await adminRequest(db, "/api/admin/reservations/pending", access.token);

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "admin_not_registered"
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("reuses Cloudflare Access JWKS for repeated admin requests in the same isolate", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    const fetchMock = createFetchMock(access.jwk);
    vi.stubGlobal("fetch", fetchMock);

    try {
      insertAdminUser(db);
      insertPendingReservation(db);

      const first = await adminRequest(db, "/api/admin/reservations/pending", access.token);
      const second = await adminRequest(db, "/api/admin/reservations/pending", access.token);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const certFetchCalls = vi
        .mocked(fetchMock)
        .mock.calls.filter(([input]) => String(input) === `${TEAM_DOMAIN}/cdn-cgi/access/certs`);
      expect(certFetchCalls).toHaveLength(1);
    } finally {
      db.sqlite.close();
    }
  });

  it("does not cache empty Cloudflare Access JWKS responses", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    let certRequestCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === `${TEAM_DOMAIN}/cdn-cgi/access/certs`) {
        certRequestCount += 1;
        return Response.json(certRequestCount === 1 ? { keys: [] } : { keys: [access.jwk] });
      }
      return Response.json({ message: "unexpected test URL" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      insertAdminUser(db);
      insertPendingReservation(db);

      const first = await adminRequest(db, "/api/admin/reservations/pending", access.token);
      const second = await adminRequest(db, "/api/admin/reservations/pending", access.token);

      expect(first.status).toBe(403);
      expect(second.status).toBe(200);
      expect(certRequestCount).toBe(2);
    } finally {
      db.sqlite.close();
    }
  });

  it("throttles Access JWKS refetches for repeated unknown JWT key IDs", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    const unknownKeyAccess = createAccessJwtFixture({}, "unknown-access-key");
    const fetchMock = createFetchMock(access.jwk);
    vi.stubGlobal("fetch", fetchMock);

    try {
      insertAdminUser(db);
      insertPendingReservation(db);

      const warm = await adminRequest(db, "/api/admin/reservations/pending", access.token);
      const firstUnknown = await adminRequest(db, "/api/admin/reservations/pending", unknownKeyAccess.token);
      const secondUnknown = await adminRequest(db, "/api/admin/reservations/pending", unknownKeyAccess.token);

      expect(warm.status).toBe(200);
      expect(firstUnknown.status).toBe(403);
      expect(secondUnknown.status).toBe(403);
      const certFetchCalls = vi
        .mocked(fetchMock)
        .mock.calls.filter(([input]) => String(input) === `${TEAM_DOMAIN}/cdn-cgi/access/certs`);
      expect(certFetchCalls).toHaveLength(2);
    } finally {
      db.sqlite.close();
    }
  });

  it("throttles Access JWKS refetches even when forced refresh fails", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    const unknownKeyAccess = createAccessJwtFixture({}, "unknown-access-key");
    let certRequestCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === `${TEAM_DOMAIN}/cdn-cgi/access/certs`) {
        certRequestCount += 1;
        return certRequestCount === 1
          ? Response.json({ keys: [access.jwk] })
          : Response.json({ message: "temporary cert fetch failure" }, { status: 503 });
      }
      return Response.json({ message: "unexpected test URL" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      insertAdminUser(db);
      insertPendingReservation(db);

      const warm = await adminRequest(db, "/api/admin/reservations/pending", access.token);
      const firstUnknown = await adminRequest(db, "/api/admin/reservations/pending", unknownKeyAccess.token);
      const secondUnknown = await adminRequest(db, "/api/admin/reservations/pending", unknownKeyAccess.token);

      expect(warm.status).toBe(200);
      expect(firstUnknown.status).toBe(403);
      expect(secondUnknown.status).toBe(403);
      expect(certRequestCount).toBe(2);
    } finally {
      db.sqlite.close();
    }
  });

  it("throttles Access JWKS refetches for repeated bad JWT signatures", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    const fetchMock = createFetchMock(access.jwk);
    vi.stubGlobal("fetch", fetchMock);

    try {
      insertAdminUser(db);
      insertPendingReservation(db);

      const parts = access.token.split(".");
      const tamperedToken = `${parts[0]}.${parts[1]}.invalid-signature`;
      const warm = await adminRequest(db, "/api/admin/reservations/pending", access.token);
      const firstTampered = await adminRequest(db, "/api/admin/reservations/pending", tamperedToken);
      const secondTampered = await adminRequest(db, "/api/admin/reservations/pending", tamperedToken);

      expect(warm.status).toBe(200);
      expect(firstTampered.status).toBe(403);
      expect(secondTampered.status).toBe(403);
      const certFetchCalls = vi
        .mocked(fetchMock)
        .mock.calls.filter(([input]) => String(input) === `${TEAM_DOMAIN}/cdn-cgi/access/certs`);
      expect(certFetchCalls).toHaveLength(2);
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects admin API calls when the Access JWT audience is wrong", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture({ aud: ["wrong-access-aud"] });
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      const response = await adminRequest(db, "/api/admin/reservations/pending", access.token);

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "admin_auth_failed"
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects admin API calls when the Access JWT issuer is wrong", async () => {
    const access = createAccessJwtFixture({ iss: "https://attacker.example.cloudflareaccess.com" });
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db);

      const response = await adminRequest(db, "/api/admin/reservations/pending", access.token);

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "admin_auth_failed"
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects admin API calls when the Access JWT is expired", async () => {
    const now = Math.floor(Date.now() / 1000);
    const access = createAccessJwtFixture({ exp: now - 120 });
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db);

      const response = await adminRequest(db, "/api/admin/reservations/pending", access.token);

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "admin_auth_failed"
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects admin API calls when the Access JWT signature is invalid", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      const parts = access.token.split(".");
      const tamperedToken = `${parts[0]}.${parts[1]}.invalid-signature`;
      const response = await adminRequest(db, "/api/admin/reservations/pending", tamperedToken);

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "admin_auth_failed"
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("lists pending reservations for active admin users without exposing raw sync internals", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      insertPendingReservation(db);

      const response = await adminRequest(db, "/api/admin/reservations/pending", access.token);

      expect(response.status).toBe(200);
      expectPrivateAdminResponse(response);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        reservations: [
          {
            id: RESERVATION_ID,
            status: "pending_approval",
            storeId: "kyoto",
            storeName: "ExampleStore A",
            serviceNames: "マッサージ｜サンプル 04",
            startAt: "2026-06-01T01:00:00.000Z",
            endAt: "2026-06-01T02:00:00.000Z",
            customerDisplayName: "予約 太郎",
            lineFriendStatus: "friend",
            createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
            pendingExpiresAt: "2099-01-01T00:00:00.000Z",
            version: 1
          }
        ]
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("joins multi-menu pending reservations with ' / ' in display_order", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      insertPendingReservation(db);
      db.sqlite
        .prepare(
          `
            DELETE FROM reservation_services WHERE reservation_id = ?
          `
        )
        .run(RESERVATION_ID);
      db.sqlite
        .prepare(
          `
            INSERT INTO reservation_services
              (reservation_id, service_id, display_order, name_snapshot, duration_minutes)
            VALUES
              (?, 'service_kyoto_hair_removal_full_60', 1, 'フェイシャル 60分', 60),
              (?, 'service_kyoto_default_60', 0, 'リンパ 60分', 60)
          `
        )
        .run(RESERVATION_ID, RESERVATION_ID);

      const response = await adminRequest(db, "/api/admin/reservations/pending", access.token);
      expect(response.status).toBe(200);
      const json = (await response.json()) as {
        ok: boolean;
        reservations: Array<{ serviceNames: string }>;
      };
      expect(json.reservations[0]?.serviceNames).toBe("リンパ 60分 / フェイシャル 60分");
    } finally {
      db.sqlite.close();
    }
  });

  it("falls back to services.name when reservation_services has no rows", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      insertPendingReservation(db);
      db.sqlite
        .prepare("DELETE FROM reservation_services WHERE reservation_id = ?")
        .run(RESERVATION_ID);
      const fallbackName = db.sqlite
        .prepare("SELECT name FROM services WHERE id = (SELECT service_id FROM reservations WHERE id = ?)")
        .get(RESERVATION_ID) as { name: string };

      const response = await adminRequest(db, "/api/admin/reservations/pending", access.token);
      expect(response.status).toBe(200);
      const json = (await response.json()) as {
        ok: boolean;
        reservations: Array<{ serviceNames: string }>;
      };
      expect(json.reservations[0]?.serviceNames).toBe(fallbackName.name);
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects unsupported admin reservation action values before touching D1", async () => {
    const result = await runAdminReservationAction({
      db: createThrowingDb(),
      env: {},
      admin: {
        id: "admin_owner_1",
        email: ADMIN_EMAIL,
        role: "owner",
  staff_member_id: null,
      store_id: null
      },
      reservationId: RESERVATION_ID,
      action: "archive" as AdminReservationAction,
      request: {
        idempotencyKey: "admin-invalid-action-1"
      }
    });

    expect(result).toEqual({
      ok: false,
      reason: "invalid_request"
    });
  });

  it("approves pending reservations only after confirming LINE message reachability", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      insertPendingReservation(db);

      const response = await adminRequest(
        db,
        `/api/admin/reservations/${RESERVATION_ID}/approve`,
        access.token,
        {
          idempotencyKey: "admin-approve-1"
        }
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        reservationId: RESERVATION_ID,
        status: "confirmed",
        replayed: false
      });

      const reservation = db.sqlite
        .prepare("SELECT status, version FROM reservations WHERE id = ?")
        .get(RESERVATION_ID) as { status: string; version: number };
      const pendingLocks = db.sqlite
        .prepare("SELECT COUNT(*) AS count FROM slot_locks WHERE owner_id = ? AND lock_status = 'pending'")
        .get(RESERVATION_ID) as { count: number };
      const confirmedLocks = db.sqlite
        .prepare("SELECT COUNT(*) AS count FROM customer_time_locks WHERE owner_id = ? AND lock_status = 'confirmed' AND expires_at IS NULL")
        .get(RESERVATION_ID) as { count: number };
      const confirmedNotification = db.sqlite
        .prepare("SELECT COUNT(*) AS count FROM notification_jobs WHERE reservation_id = ? AND template_key = 'reservation_confirmed'")
        .get(RESERVATION_ID) as { count: number };
      const calendarJob = db.sqlite
        .prepare("SELECT COUNT(*) AS count FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'upsert'")
        .get(RESERVATION_ID) as { count: number };

      expect(reservation).toEqual({
        status: "confirmed",
        version: 2
      });
      expect(pendingLocks.count).toBe(0);
      expect(confirmedLocks.count).toBe(4);
      expect(confirmedNotification.count).toBe(1);
      expect(calendarJob.count).toBe(1);
    } finally {
      db.sqlite.close();
    }
  });

  it("returns store_closed when approving a legacy pending reservation that overlaps a closure", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      insertPendingReservation(db);
      // Model an overlap that predates migration 0044: bypass only the closure
      // INSERT guard while keeping the reservation UPDATE guard under test.
      db.sqlite.exec("DROP TRIGGER trg_store_closures_reject_active_reservation_insert");
      db.sqlite
        .prepare(
          `INSERT INTO store_closures (id, store_id, starts_at, ends_at, reason, source)
           VALUES (?, 'kyoto', '2026-06-01T01:30:00.000Z', '2026-06-01T02:30:00.000Z', ?, 'admin')`
        )
        .run("closure_legacy_overlap", "migration前の重複");

      const response = await adminRequest(
        db,
        `/api/admin/reservations/${RESERVATION_ID}/approve`,
        access.token,
        { idempotencyKey: "admin-approve-legacy-closure-overlap" }
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ ok: false, reason: "store_closed" });
      expect(
        db.sqlite
          .prepare("SELECT status, version FROM reservations WHERE id = ?")
          .get(RESERVATION_ID)
      ).toEqual({ status: "pending_approval", version: 1 });
      expect(
        db.sqlite
          .prepare("SELECT COUNT(*) AS count FROM idempotency_keys WHERE idempotency_key = ?")
          .get("admin-approve-legacy-closure-overlap")
      ).toEqual({ count: 0 });
    } finally {
      db.sqlite.close();
    }
  });

  it("approves when expectedVersion matches the current reservation version", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      insertPendingReservation(db);

      const response = await adminRequest(
        db,
        `/api/admin/reservations/${RESERVATION_ID}/approve`,
        access.token,
        {
          idempotencyKey: "admin-approve-ev-match-1",
          expectedVersion: 1
        }
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        status: "confirmed"
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects a stale expectedVersion with 409 stale_snapshot and leaves the reservation untouched", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      insertPendingReservation(db);
      // 確認スナップショット (version 1) の取得後に、別管理者の変更で version が
      // 進んだ状況を再現する。
      db.sqlite
        .prepare("UPDATE reservations SET version = 2 WHERE id = ?")
        .run(RESERVATION_ID);

      const response = await adminRequest(
        db,
        `/api/admin/reservations/${RESERVATION_ID}/approve`,
        access.token,
        {
          idempotencyKey: "admin-approve-ev-stale-1",
          expectedVersion: 1
        }
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "stale_snapshot"
      });

      const reservation = db.sqlite
        .prepare("SELECT status, version FROM reservations WHERE id = ?")
        .get(RESERVATION_ID) as { status: string; version: number };
      expect(reservation).toEqual({ status: "pending_approval", version: 2 });
      const sideEffects = db.sqlite
        .prepare(
          "SELECT (SELECT COUNT(*) FROM notification_jobs WHERE reservation_id = ?) + (SELECT COUNT(*) FROM calendar_sync_jobs WHERE owner_id = ?) AS count"
        )
        .get(RESERVATION_ID, RESERVATION_ID) as { count: number };
      expect(sideEffects.count).toBe(0);
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects a non-numeric expectedVersion with 400 before touching the reservation", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      insertPendingReservation(db);

      const response = await adminRequest(
        db,
        `/api/admin/reservations/${RESERVATION_ID}/approve`,
        access.token,
        {
          idempotencyKey: "admin-approve-ev-invalid-1",
          expectedVersion: "1"
        }
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "invalid_request"
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("classifies a version bump between the precheck and the batch as stale_snapshot", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db);
      insertPendingReservation(db);
      // 事前チェック (version 1 一致) の通過後、batch 直前に status を変えず
      // version だけが進む競合を注入する。guard が batch を巻き戻したうえで、
      // 応答が write_failed ではなく stale_snapshot に分類されることを固定する。
      const racingDb = {
        prepare(sql: string) {
          return (db as unknown as D1Database).prepare(sql);
        },
        batch(statements: D1PreparedStatement[]) {
          db.sqlite
            .prepare("UPDATE reservations SET version = version + 1 WHERE id = ?")
            .run(RESERVATION_ID);
          return db.batch(statements);
        }
      } as unknown as D1Database;

      const result = await runAdminReservationAction({
        db: racingDb,
        env: {
          LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "line_bot_token"
        },
        admin: {
          id: "admin_owner_1",
          email: ADMIN_EMAIL,
          role: "owner",
          staff_member_id: null,
          store_id: null
        },
        reservationId: RESERVATION_ID,
        action: "approve",
        request: {
          idempotencyKey: "admin-approve-ev-late-race-1",
          expectedVersion: 1
        },
        fetcher: createFetchMock(createAccessJwtFixture().jwk),
        now: () => Date.parse("2026-05-09T23:05:00.000Z")
      });

      expect(result).toEqual({
        ok: false,
        reason: "stale_snapshot"
      });
      const reservation = db.sqlite
        .prepare("SELECT status, version FROM reservations WHERE id = ?")
        .get(RESERVATION_ID) as { status: string; version: number };
      expect(reservation).toEqual({ status: "pending_approval", version: 2 });
      const sideEffects = db.sqlite
        .prepare(
          "SELECT (SELECT COUNT(*) FROM notification_jobs WHERE reservation_id = ?) + (SELECT COUNT(*) FROM calendar_sync_jobs WHERE owner_id = ?) AS count"
        )
        .get(RESERVATION_ID, RESERVATION_ID) as { count: number };
      expect(sideEffects.count).toBe(0);
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects approval after pending_expires_at has passed (fail-closed against reclaimed locks)", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      insertPendingReservation(db);
      // Deadline lapsed but the expiry sweep has not run yet: the pending
      // slot_locks may already be reclaimed by another writer (public submit
      // self-heal / external-block creation), so approve must fail closed.
      db.sqlite
        .prepare("UPDATE reservations SET pending_expires_at = '2026-05-09T22:00:00.000Z' WHERE id = ?")
        .run(RESERVATION_ID);

      const response = await adminRequest(
        db,
        `/api/admin/reservations/${RESERVATION_ID}/approve`,
        access.token,
        {
          idempotencyKey: "admin-approve-deadline-passed-1"
        }
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "invalid_transition"
      });
      const reservation = db.sqlite
        .prepare("SELECT status FROM reservations WHERE id = ?")
        .get(RESERVATION_ID) as { status: string };
      expect(reservation.status).toBe("pending_approval");
    } finally {
      db.sqlite.close();
    }
  });

  it("keeps a reservation pending when approval cannot re-confirm LINE reachability", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk, 404));

    try {
      insertAdminUser(db);
      insertPendingReservation(db);

      const response = await adminRequest(
        db,
        `/api/admin/reservations/${RESERVATION_ID}/approve`,
        access.token,
        {
          idempotencyKey: "admin-approve-line-fail-1"
        }
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "line_not_reachable"
      });

      const reservation = db.sqlite
        .prepare("SELECT status FROM reservations WHERE id = ?")
        .get(RESERVATION_ID) as { status: string };
      expect(reservation.status).toBe("pending_approval");
      const lineIdentity = db.sqlite
        .prepare("SELECT friend_flag, official_friend_status FROM line_identities WHERE id = ?")
        .get(LINE_IDENTITY_ID) as { friend_flag: number; official_friend_status: string };
      expect(lineIdentity).toEqual({
        friend_flag: 1,
        official_friend_status: "friend"
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("does not run approve side effects when the guarded status update loses a race", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db);
      insertPendingReservation(db);
      const racingDb = {
        prepare(sql: string) {
          return (db as unknown as D1Database).prepare(sql);
        },
        batch(statements: D1PreparedStatement[]) {
          db.sqlite
            .prepare(
              `
                UPDATE reservations
                SET status = 'rejected',
                    version = version + 1,
                    updated_at = '2026-05-09T23:04:59.999Z'
                WHERE id = ?
              `
            )
            .run(RESERVATION_ID);
          return db.batch(statements);
        }
      } as unknown as D1Database;

      const result = await runAdminReservationAction({
        db: racingDb,
        env: {
          LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "line_bot_token"
        },
        admin: {
          id: "admin_owner_1",
          email: ADMIN_EMAIL,
          role: "owner",
  staff_member_id: null,
        store_id: null
        },
        reservationId: RESERVATION_ID,
        action: "approve",
        request: {
          idempotencyKey: "admin-approve-race-1"
        },
        fetcher: createFetchMock(createAccessJwtFixture().jwk),
        now: () => Date.parse("2026-05-09T23:05:00.000Z")
      });

      expect(result).toEqual({
        ok: false,
        reason: "write_failed"
      });
      const reservation = db.sqlite
        .prepare("SELECT status FROM reservations WHERE id = ?")
        .get(RESERVATION_ID) as { status: string };
      expect(reservation.status).toBe("rejected");
      const locks = db.sqlite
        .prepare(
          `
            SELECT
              (SELECT COUNT(*) FROM slot_locks WHERE owner_id = ? AND lock_status = 'confirmed') AS confirmedSlotLocks,
              (SELECT COUNT(*) FROM customer_time_locks WHERE owner_id = ? AND lock_status = 'confirmed') AS confirmedCustomerLocks,
              (SELECT COUNT(*) FROM notification_jobs WHERE reservation_id = ? AND template_key = 'reservation_confirmed') AS confirmedNotifications,
              (SELECT COUNT(*) FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'upsert') AS calendarUpserts,
              (SELECT COUNT(*) FROM audit_logs WHERE target_id = ? AND action = 'admin_reservation_approved') AS approveAudits
          `
        )
        .get(RESERVATION_ID, RESERVATION_ID, RESERVATION_ID, RESERVATION_ID, RESERVATION_ID) as {
        confirmedSlotLocks: number;
        confirmedCustomerLocks: number;
        confirmedNotifications: number;
        calendarUpserts: number;
        approveAudits: number;
      };
      expect(locks).toEqual({
        confirmedSlotLocks: 0,
        confirmedCustomerLocks: 0,
        confirmedNotifications: 0,
        calendarUpserts: 0,
        approveAudits: 0
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("maps an admin action idempotency insert race to in progress without side effects", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();

    try {
      insertAdminUser(db);
      insertPendingReservation(db);
      const requestHash = sha256Hex(
        JSON.stringify({
          reservationId: RESERVATION_ID,
          action: "approve",
          reason: null,
          adminId: "admin_owner_1"
        })
      );
      let injectedRace = false;
      const racingDb = {
        prepare(sql: string) {
          return (db as unknown as D1Database).prepare(sql);
        },
        batch(statements: D1PreparedStatement[]) {
          if (!injectedRace) {
            injectedRace = true;
            db.sqlite
              .prepare(
                `
                  INSERT INTO idempotency_keys (
                    id,
                    scope,
                    idempotency_key,
                    status,
                    request_hash,
                    expires_at
                  ) VALUES (
                    'admin_action_peer_idempotency_1',
                    'admin_action',
                    'admin-approve-idempotency-race-1',
                    'started',
                    ?,
                    '2026-05-10T23:05:00.000Z'
                  )
                `
              )
              .run(requestHash);
          }
          return db.batch(statements);
        }
      } as unknown as D1Database;

      const result = await runAdminReservationAction({
        db: racingDb,
        env: {
          LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "line_bot_token"
        },
        admin: {
          id: "admin_owner_1",
          email: ADMIN_EMAIL,
          role: "owner",
  staff_member_id: null,
        store_id: null
        },
        reservationId: RESERVATION_ID,
        action: "approve",
        request: {
          idempotencyKey: "admin-approve-idempotency-race-1"
        },
        fetcher: createFetchMock(access.jwk),
        now: () => Date.parse("2026-05-09T23:05:00.000Z")
      });

      expect(result).toEqual({
        ok: false,
        reason: "idempotency_in_progress"
      });
      const state = db.sqlite
        .prepare(
          `
            SELECT
              (SELECT status FROM reservations WHERE id = ?) AS reservationStatus,
              (SELECT COUNT(*) FROM notification_jobs WHERE reservation_id = ?) AS notificationCount,
              (SELECT COUNT(*) FROM audit_logs WHERE target_id = ?) AS auditCount
          `
        )
        .get(RESERVATION_ID, RESERVATION_ID, RESERVATION_ID) as {
        reservationStatus: string;
        notificationCount: number;
        auditCount: number;
      };
      expect(state).toEqual({
        reservationStatus: "pending_approval",
        notificationCount: 0,
        auditCount: 0
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("ignores an expired started idempotency row instead of returning idempotency_in_progress", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();

    try {
      insertAdminUser(db);
      insertPendingReservation(db);
      const requestHash = sha256Hex(
        JSON.stringify({
          reservationId: RESERVATION_ID,
          action: "approve",
          reason: null,
          adminId: "admin_owner_1"
        })
      );
      // A "started" row left behind by a crashed request, already past its TTL
      // relative to the action clock below (expires 2026-05-09, now 2026-05-12).
      db.sqlite
        .prepare(
          `
            INSERT INTO idempotency_keys (
              id,
              scope,
              idempotency_key,
              status,
              request_hash,
              expires_at
            ) VALUES (
              'admin_action_expired_started_1',
              'admin_action',
              'admin-approve-expired-started-1',
              'started',
              ?,
              '2026-05-09T00:00:00.000Z'
            )
          `
        )
        .run(requestHash);

      const result = await runAdminReservationAction({
        db: db as unknown as D1Database,
        env: {
          LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "line_bot_token"
        },
        admin: {
          id: "admin_owner_1",
          email: ADMIN_EMAIL,
          role: "owner",
          staff_member_id: null,
          store_id: null
        },
        reservationId: RESERVATION_ID,
        action: "approve",
        request: {
          idempotencyKey: "admin-approve-expired-started-1"
        },
        fetcher: createFetchMock(access.jwk),
        now: () => Date.parse("2026-05-12T00:00:00.000Z")
      });

      // The expired row no longer blocks with idempotency_in_progress: the TTL
      // read skips it, the flow proceeds, and the fresh started INSERT collides
      // with the still-present row on the UNIQUE key → write_failed. Crucially
      // it is NOT idempotency_in_progress (the old, permanently-stuck behaviour).
      expect(result).toEqual({
        ok: false,
        reason: "write_failed"
      });
      const state = db.sqlite
        .prepare(
          `
            SELECT
              (SELECT status FROM reservations WHERE id = ?) AS reservationStatus,
              (SELECT COUNT(*) FROM notification_jobs WHERE reservation_id = ?) AS notificationCount,
              (SELECT COUNT(*) FROM audit_logs WHERE target_id = ?) AS auditCount
          `
        )
        .get(RESERVATION_ID, RESERVATION_ID, RESERVATION_ID) as {
        reservationStatus: string;
        notificationCount: number;
        auditCount: number;
      };
      expect(state).toEqual({
        reservationStatus: "pending_approval",
        notificationCount: 0,
        auditCount: 0
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects pending reservations and releases all active locks", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      insertPendingReservation(db);

      const response = await adminRequest(
        db,
        `/api/admin/reservations/${RESERVATION_ID}/reject`,
        access.token,
        {
          idempotencyKey: "admin-reject-1"
        }
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        reservationId: RESERVATION_ID,
        status: "rejected"
      });

      const locks = db.sqlite
        .prepare(
          `
            SELECT
              (SELECT COUNT(*) FROM slot_locks WHERE owner_id = ?) AS slotCount,
              (SELECT COUNT(*) FROM customer_time_locks WHERE owner_id = ?) AS customerLockCount
          `
        )
        .get(RESERVATION_ID, RESERVATION_ID) as { slotCount: number; customerLockCount: number };
      const rejectedNotification = db.sqlite
        .prepare("SELECT COUNT(*) AS count FROM notification_jobs WHERE reservation_id = ? AND template_key = 'reservation_rejected'")
        .get(RESERVATION_ID) as { count: number };
      const calendarDelete = db.sqlite
        .prepare("SELECT COUNT(*) AS count FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'delete'")
        .get(RESERVATION_ID) as { count: number };

      expect(locks).toEqual({
        slotCount: 0,
        customerLockCount: 0
      });
      expect(rejectedNotification.count).toBe(1);
      expect(calendarDelete.count).toBe(1);
    } finally {
      db.sqlite.close();
    }
  });

  it("records the trimmed reject reason in the audit metadata", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      insertPendingReservation(db);

      const response = await adminRequest(
        db,
        `/api/admin/reservations/${RESERVATION_ID}/reject`,
        access.token,
        {
          idempotencyKey: "admin-reject-reason-1",
          reason: "  予定が重複したため  "
        }
      );
      expect(response.status).toBe(200);

      const audit = db.sqlite
        .prepare(
          "SELECT metadata_json FROM audit_logs WHERE action = 'admin_reservation_reject' AND target_id = ?"
        )
        .get(RESERVATION_ID) as { metadata_json: string };
      const metadata = JSON.parse(audit.metadata_json) as Record<string, unknown>;
      expect(metadata).toMatchObject({
        previousStatus: "pending_approval",
        nextStatus: "rejected",
        reason: "予定が重複したため"
      });

      // 却下理由は reservations.rejection_reason にも保存され、顧客向け
      // reservation_rejected 通知の本文に使われる。
      const reservation = db.sqlite
        .prepare("SELECT status, rejection_reason FROM reservations WHERE id = ?")
        .get(RESERVATION_ID) as { status: string; rejection_reason: string | null };
      expect(reservation.status).toBe("rejected");
      expect(reservation.rejection_reason).toBe("予定が重複したため");
    } finally {
      db.sqlite.close();
    }
  });

  it("strips invisible control characters from the reject reason but keeps newlines", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      insertPendingReservation(db);

      // bidi 上書き (U+202E)・NUL・行区切り (U+2028) は監査ログ表示の偽装に使えるため
      // 除去する。Textarea 由来の改行は正当な複数行入力なので残す。
      const response = await adminRequest(
        db,
        `/api/admin/reservations/${RESERVATION_ID}/reject`,
        access.token,
        {
          idempotencyKey: "admin-reject-reason-ctrl-1",
          reason: "予定が\u202E重複\u0000した\u2028ため\u200B\r\nお客様に連絡済み"
        }
      );
      expect(response.status).toBe(200);

      const audit = db.sqlite
        .prepare(
          "SELECT metadata_json FROM audit_logs WHERE action = 'admin_reservation_reject' AND target_id = ?"
        )
        .get(RESERVATION_ID) as { metadata_json: string };
      const metadata = JSON.parse(audit.metadata_json) as Record<string, unknown>;
      expect(metadata.reason).toBe("予定が重複したため\nお客様に連絡済み");
    } finally {
      db.sqlite.close();
    }
  });

  it("normalizes a missing reject reason to null in the audit metadata", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      insertPendingReservation(db);

      // 管理画面は理由未入力時 reason: "" を送るが、route の getString が空文字を
      // undefined に落とすため、保存層には未指定として届く (null 正規化を固定)。
      const response = await adminRequest(
        db,
        `/api/admin/reservations/${RESERVATION_ID}/reject`,
        access.token,
        {
          idempotencyKey: "admin-reject-no-reason-1",
          reason: ""
        }
      );
      expect(response.status).toBe(200);

      const audit = db.sqlite
        .prepare(
          "SELECT metadata_json FROM audit_logs WHERE action = 'admin_reservation_reject' AND target_id = ?"
        )
        .get(RESERVATION_ID) as { metadata_json: string };
      const metadata = JSON.parse(audit.metadata_json) as Record<string, unknown>;
      expect("reason" in metadata).toBe(true);
      expect(metadata.reason).toBeNull();
    } finally {
      db.sqlite.close();
    }
  });

  it("cancels confirmed reservations without depending on Google Calendar deletion", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      insertPendingReservation(db, "confirmed");

      const response = await adminRequest(
        db,
        `/api/admin/reservations/${RESERVATION_ID}/cancel`,
        access.token,
        {
          idempotencyKey: "admin-cancel-1"
        }
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        status: "cancelled_by_admin"
      });

      const reservation = db.sqlite
        .prepare("SELECT status, cancelled_by FROM reservations WHERE id = ?")
        .get(RESERVATION_ID) as { status: string; cancelled_by: string };
      const visits = db.sqlite
        .prepare("SELECT COUNT(*) AS count FROM customer_visits WHERE reservation_id = ?")
        .get(RESERVATION_ID) as { count: number };

      expect(reservation.status).toBe("cancelled_by_admin");
      expect(reservation.cancelled_by).toBe("admin_owner_1");
      expect(visits.count).toBe(0);
    } finally {
      db.sqlite.close();
    }
  });

  it("emits one slot_lock_history released row per existing slot_lock and stays stable on idempotent replay", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      insertPendingReservation(db, "confirmed");

      const initialSlotLocks = (
        db.sqlite
          .prepare(`SELECT COUNT(*) AS count FROM slot_locks WHERE owner_id = ?`)
          .get(RESERVATION_ID) as { count: number }
      ).count;
      expect(initialSlotLocks).toBeGreaterThan(0);

      const first = await adminRequest(
        db,
        `/api/admin/reservations/${RESERVATION_ID}/cancel`,
        access.token,
        { idempotencyKey: "admin-cancel-history-1" }
      );
      expect(first.status).toBe(200);

      const releasedRows = db.sqlite
        .prepare(
          `SELECT COUNT(*) AS count FROM slot_lock_history WHERE action = 'released' AND old_owner_id = ?`
        )
        .get(RESERVATION_ID) as { count: number };
      expect(releasedRows.count).toBe(initialSlotLocks);

      const replay = await adminRequest(
        db,
        `/api/admin/reservations/${RESERVATION_ID}/cancel`,
        access.token,
        { idempotencyKey: "admin-cancel-history-1" }
      );
      expect(replay.status).toBe(200);

      const releasedRowsAfter = db.sqlite
        .prepare(
          `SELECT COUNT(*) AS count FROM slot_lock_history WHERE action = 'released' AND old_owner_id = ?`
        )
        .get(RESERVATION_ID) as { count: number };
      expect(releasedRowsAfter.count).toBe(initialSlotLocks);
    } finally {
      db.sqlite.close();
    }
  });

  it.each([true, false])("queues manual cancellation notifications only with a linked identity (linked=%s)", async (linked) => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      insertPendingReservation(db, "confirmed");
      db.sqlite
        .prepare(
          `
            UPDATE reservations
            SET source = 'phone_admin',
                line_identity_id = CASE WHEN ? THEN line_identity_id ELSE NULL END
            WHERE id = ?
          `
        )
        .run(linked ? 1 : 0, RESERVATION_ID);

      const response = await adminRequest(
        db,
        `/api/admin/reservations/${RESERVATION_ID}/cancel`,
        access.token,
        {
          idempotencyKey: "admin-cancel-phone-no-line-1"
        }
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        status: "cancelled_by_admin"
      });
      const state = db.sqlite
        .prepare(
          `
            SELECT
              (SELECT COUNT(*) FROM notification_jobs WHERE reservation_id = ?) AS notificationCount,
              (SELECT COUNT(*) FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'delete') AS calendarDeleteCount
          `
        )
        .get(RESERVATION_ID, RESERVATION_ID) as { notificationCount: number; calendarDeleteCount: number };
      expect(state).toEqual({
        notificationCount: linked ? 1 : 0,
        calendarDeleteCount: 1
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects staff attempts to cancel confirmed reservations", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "staff");
      insertPendingReservation(db, "confirmed");

      const response = await adminRequest(
        db,
        `/api/admin/reservations/${RESERVATION_ID}/cancel`,
        access.token,
        {
          idempotencyKey: "staff-cancel-forbidden-1"
        }
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "forbidden"
      });

      const reservation = db.sqlite
        .prepare("SELECT status, cancelled_by FROM reservations WHERE id = ?")
        .get(RESERVATION_ID) as { status: string; cancelled_by: string | null };
      expect(reservation).toEqual({
        status: "confirmed",
        cancelled_by: null
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("marks confirmed reservations complete exactly once and creates one visit record", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      insertPendingReservation(db, "confirmed");

      const first = await adminRequest(
        db,
        `/api/admin/reservations/${RESERVATION_ID}/complete`,
        access.token,
        {
          idempotencyKey: "admin-complete-1"
        }
      );
      const replay = await adminRequest(
        db,
        `/api/admin/reservations/${RESERVATION_ID}/complete`,
        access.token,
        {
          idempotencyKey: "admin-complete-1"
        }
      );

      expect(first.status).toBe(200);
      await expect(first.json()).resolves.toMatchObject({
        ok: true,
        status: "completed",
        replayed: false
      });
      expect(replay.status).toBe(200);
      await expect(replay.json()).resolves.toMatchObject({
        ok: true,
        status: "completed",
        replayed: true
      });

      const visits = db.sqlite
        .prepare("SELECT COUNT(*) AS count FROM customer_visits WHERE reservation_id = ? AND status = 'valid'")
        .get(RESERVATION_ID) as { count: number };
      expect(visits.count).toBe(1);

      // visited_at must be the appointment time (start_at), NOT the complete-click
      // time — owners complete late/in batches, so the visit date must reflect
      // when the customer actually came (the reservation's start_at).
      const visitRow = db.sqlite
        .prepare("SELECT visited_at FROM customer_visits WHERE reservation_id = ? LIMIT 1")
        .get(RESERVATION_ID) as { visited_at: string };
      expect(visitRow.visited_at).toBe("2026-06-01T01:00:00.000Z");
    } finally {
      db.sqlite.close();
    }
  });

  it("creates a visit on manual complete even when the customer is archived", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      insertPendingReservation(db, "confirmed");
      db.sqlite
        .prepare("UPDATE customers SET archived_at = ? WHERE id = ?")
        .run("2026-06-08T00:00:00.000Z", CUSTOMER_ID);

      const response = await adminRequest(
        db,
        `/api/admin/reservations/${RESERVATION_ID}/complete`,
        access.token,
        {
          idempotencyKey: "admin-complete-archived-1"
        }
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        status: "completed"
      });
      const visits = db.sqlite
        .prepare("SELECT COUNT(*) AS count FROM customer_visits WHERE reservation_id = ?")
        .get(RESERVATION_ID) as { count: number };
      expect(visits.count).toBe(1);
    } finally {
      db.sqlite.close();
    }
  });

  it("creates a visit on manual complete even when the customer is merged away", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      insertPendingReservation(db, "confirmed");
      db.sqlite
        .prepare(
          `INSERT INTO customers (id, display_name, display_name_kana, phone_normalized, phone_hash, block_status, updated_at)
           VALUES ('customer_merge_target_manual', '統合 先', 'トウゴウ サキ', '0759999999', 'phone_hash_merge_target_manual', 'active', '2026-05-09T00:00:00.000Z')`
        )
        .run();
      db.sqlite
        .prepare("UPDATE customers SET merged_into_id = ? WHERE id = ?")
        .run("customer_merge_target_manual", CUSTOMER_ID);

      const response = await adminRequest(
        db,
        `/api/admin/reservations/${RESERVATION_ID}/complete`,
        access.token,
        {
          idempotencyKey: "admin-complete-merged-1"
        }
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        status: "completed"
      });
      const visits = db.sqlite
        .prepare("SELECT COUNT(*) AS count FROM customer_visits WHERE reservation_id = ?")
        .get(RESERVATION_ID) as { count: number };
      expect(visits.count).toBe(1);
    } finally {
      db.sqlite.close();
    }
  });

  const OWNER_ADMIN = {
    id: "admin_owner_unit_1",
    email: ADMIN_EMAIL,
    role: "owner" as const,
    staff_member_id: null as string | null,
    store_id: null as string | null
  };
  const STAFF_ADMIN = {
    id: "admin_staff_unit_1",
    email: "staff@example.com",
    role: "staff" as const,
    staff_member_id: "staff_owner_kyoto" as string | null,
    store_id: "kyoto" as string | null
  };

  const seedUnitActors = (db: SqliteD1Database) => {
    for (const actor of [OWNER_ADMIN, STAFF_ADMIN]) {
      insertAdminUserHelper(db, { id: actor.id, email: actor.email, accessSubject: actor.id, role: actor.role, staffMemberId: actor.staff_member_id });
    }
  };

  const setReservationStartAt = (db: SqliteD1Database, startAt: string, endAt: string) => {
    db.sqlite
      .prepare("UPDATE reservations SET start_at = ?, end_at = ? WHERE id = ?")
      .run(startAt, endAt, RESERVATION_ID);
  };

  const cancelInvocation = (input: {
    db: D1Database;
    admin: typeof OWNER_ADMIN | typeof STAFF_ADMIN;
    reservationId?: string;
    idempotencyKey: string;
    reason?: string;
    nowMs: number;
  }) =>
    runAdminReservationAction({
      db: input.db,
      env: {
        LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "line_bot_token"
      },
      admin: input.admin,
      reservationId: input.reservationId ?? RESERVATION_ID,
      action: "cancel",
      request: {
        idempotencyKey: input.idempotencyKey,
        reason: input.reason
      },
      now: () => input.nowMs
    });

  it("allows a staff cancel when the reservation starts on the same JST day", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedUnitActors(db);
      insertPendingReservation(db, "confirmed");
      setReservationStartAt(db, "2026-05-12T03:00:00.000Z", "2026-05-12T04:00:00.000Z");

      const result = await cancelInvocation({
        db: db as unknown as D1Database,
        admin: STAFF_ADMIN,
        idempotencyKey: "staff-cancel-same-day-1",
        reason: "customer no-call",
        nowMs: Date.parse("2026-05-11T16:00:00.000Z")
      });

      expect(result).toMatchObject({
        ok: true,
        reservationId: RESERVATION_ID,
        status: "cancelled_by_admin",
        replayed: false
      });
      const reservation = db.sqlite
        .prepare("SELECT status FROM reservations WHERE id = ?")
        .get(RESERVATION_ID) as { status: string };
      expect(reservation.status).toBe("cancelled_by_admin");
    } finally {
      db.sqlite.close();
    }
  });

  it("allows a staff cancel when the reservation starts on the next JST day (2026-07-14: 当日ガード撤廃)", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedUnitActors(db);
      insertPendingReservation(db, "confirmed");
      setReservationStartAt(db, "2026-05-12T15:00:00.000Z", "2026-05-12T16:00:00.000Z");

      const result = await cancelInvocation({
        db: db as unknown as D1Database,
        admin: STAFF_ADMIN,
        idempotencyKey: "staff-cancel-next-day-1",
        nowMs: Date.parse("2026-05-12T05:00:00.000Z")
      });

      expect(result).toMatchObject({ ok: true, status: "cancelled_by_admin" });
      const reservation = db.sqlite
        .prepare("SELECT status FROM reservations WHERE id = ?")
        .get(RESERVATION_ID) as { status: string };
      expect(reservation.status).toBe("cancelled_by_admin");
    } finally {
      db.sqlite.close();
    }
  });

  it("allows a staff cancel when the reservation starts on a previous JST day", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedUnitActors(db);
      insertPendingReservation(db, "confirmed");
      setReservationStartAt(db, "2026-05-11T03:00:00.000Z", "2026-05-11T04:00:00.000Z");

      const result = await cancelInvocation({
        db: db as unknown as D1Database,
        admin: STAFF_ADMIN,
        idempotencyKey: "staff-cancel-prev-day-1",
        nowMs: Date.parse("2026-05-12T05:00:00.000Z")
      });

      expect(result).toMatchObject({ ok: true, status: "cancelled_by_admin" });
    } finally {
      db.sqlite.close();
    }
  });

  it("forbids a staff cancel of another store's reservation (店舗 scope は維持)", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedUnitActors(db);
      insertPendingReservation(db, "confirmed");
      // 予約は kyoto。osaka 所属の staff からは日付に関わらず操作不可。
      setReservationStartAt(db, "2026-05-12T03:00:00.000Z", "2026-05-12T04:00:00.000Z");

      const result = await cancelInvocation({
        db: db as unknown as D1Database,
        admin: { ...STAFF_ADMIN, store_id: "osaka" },
        idempotencyKey: "staff-cancel-cross-store-1",
        nowMs: Date.parse("2026-05-12T05:00:00.000Z")
      });

      expect(result).toEqual({ ok: false, reason: "forbidden" });
      const reservation = db.sqlite
        .prepare("SELECT status FROM reservations WHERE id = ?")
        .get(RESERVATION_ID) as { status: string };
      expect(reservation.status).toBe("confirmed");
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects an idempotency-key replay when a different actor tries to reuse it", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedUnitActors(db);
      insertPendingReservation(db, "confirmed");
      // Reservation starts in JST tomorrow so staff cannot legitimately cancel.
      setReservationStartAt(db, "2026-05-13T03:00:00.000Z", "2026-05-13T04:00:00.000Z");

      const ownerResult = await cancelInvocation({
        db: db as unknown as D1Database,
        admin: OWNER_ADMIN,
        idempotencyKey: "shared-cancel-key-1",
        reason: "owner cancel",
        nowMs: Date.parse("2026-05-12T05:00:00.000Z")
      });
      expect(ownerResult).toMatchObject({ ok: true, status: "cancelled_by_admin" });

      const staffReplay = await cancelInvocation({
        db: db as unknown as D1Database,
        admin: STAFF_ADMIN,
        idempotencyKey: "shared-cancel-key-1",
        reason: "owner cancel",
        nowMs: Date.parse("2026-05-12T05:00:00.000Z")
      });
      expect(staffReplay).toEqual({ ok: false, reason: "idempotency_conflict" });
    } finally {
      db.sqlite.close();
    }
  });

  it("returns the cached success when the same actor replays the same idempotency key", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedUnitActors(db);
      insertPendingReservation(db, "confirmed");
      setReservationStartAt(db, "2026-05-13T03:00:00.000Z", "2026-05-13T04:00:00.000Z");

      const first = await cancelInvocation({
        db: db as unknown as D1Database,
        admin: OWNER_ADMIN,
        idempotencyKey: "owner-replay-key-1",
        reason: "owner cancel",
        nowMs: Date.parse("2026-05-12T05:00:00.000Z")
      });
      expect(first).toMatchObject({ ok: true, status: "cancelled_by_admin", replayed: false });

      const replay = await cancelInvocation({
        db: db as unknown as D1Database,
        admin: OWNER_ADMIN,
        idempotencyKey: "owner-replay-key-1",
        reason: "owner cancel",
        nowMs: Date.parse("2026-05-12T05:00:00.000Z")
      });
      expect(replay).toMatchObject({ ok: true, status: "cancelled_by_admin", replayed: true });
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects a same-actor key reuse against a different reservation", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedUnitActors(db);
      insertPendingReservation(db, "confirmed");
      setReservationStartAt(db, "2026-05-13T03:00:00.000Z", "2026-05-13T04:00:00.000Z");

      const first = await cancelInvocation({
        db: db as unknown as D1Database,
        admin: OWNER_ADMIN,
        idempotencyKey: "owner-cross-reservation-key-1",
        reason: "owner cancel",
        nowMs: Date.parse("2026-05-12T05:00:00.000Z")
      });
      expect(first).toMatchObject({ ok: true, status: "cancelled_by_admin" });

      const reuse = await cancelInvocation({
        db: db as unknown as D1Database,
        admin: OWNER_ADMIN,
        reservationId: "reservation_other_unit_1",
        idempotencyKey: "owner-cross-reservation-key-1",
        reason: "owner cancel",
        nowMs: Date.parse("2026-05-12T05:00:00.000Z")
      });
      expect(reuse).toEqual({ ok: false, reason: "idempotency_conflict" });
    } finally {
      db.sqlite.close();
    }
  });

  describe("staff store-scope for reject/complete/no-show/reschedule (2026-07-14: 当日ガード撤廃)", () => {
    type GatedAction = "reject" | "complete" | "no-show" | "reschedule";

    const initialStatusFor = (action: GatedAction) =>
      action === "reject" ? "pending_approval" : "confirmed";

    const runAction = (input: {
      db: SqliteD1Database;
      action: GatedAction;
      admin: typeof OWNER_ADMIN | typeof STAFF_ADMIN;
      idempotencyKey: string;
      startAt: string;
      endAt: string;
      nowMs: number;
      newStartAt?: string;
    }) => {
      seedUnitActors(input.db);
      insertPendingReservation(input.db, initialStatusFor(input.action));
      setReservationStartAt(input.db, input.startAt, input.endAt);
      const desiredNewStart = input.newStartAt ?? "2026-05-12T07:00:00.000Z";
      if (input.action === "reschedule") {
        return rescheduleAdminReservation({
          db: input.db as unknown as D1Database,
          admin: input.admin,
          reservationId: RESERVATION_ID,
          request: { idempotencyKey: input.idempotencyKey, startAt: desiredNewStart },
          now: () => input.nowMs
        });
      }
      return runAdminReservationAction({
        db: input.db as unknown as D1Database,
        env: {
          LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "line_bot_token"
        },
        admin: input.admin,
        reservationId: RESERVATION_ID,
        action: input.action,
        request: { idempotencyKey: input.idempotencyKey },
        now: () => input.nowMs
      });
    };

    // 2026-07-14: staff の当日ガードを全撤廃。reject は元々対象外 (承認業務は全期間)、
    // complete / no-show / reschedule も staff が自店舗であれば日付を問わず操作できる。
    // 残る制約は店舗 scope のみ (下の cross-store テストで担保)。
    const actions: GatedAction[] = ["complete", "no-show", "reschedule"];
    const ownerActions: GatedAction[] = ["reject", "complete", "no-show", "reschedule"];

    it("allows staff reject of a future-day pending reservation in their own store", async () => {
      const db = createMigratedSqliteD1();
      try {
        const result = await runAction({
          db,
          action: "reject",
          admin: STAFF_ADMIN,
          idempotencyKey: "staff-reject-next-day-1",
          startAt: "2026-05-12T15:00:00.000Z",
          endAt: "2026-05-12T16:00:00.000Z",
          nowMs: Date.parse("2026-05-12T05:00:00.000Z")
        });
        expect(result).toMatchObject({ ok: true, status: "rejected" });
      } finally {
        db.sqlite.close();
      }
    });

    it("forbids staff reject when the reservation belongs to another store", async () => {
      const db = createMigratedSqliteD1();
      try {
        const result = await runAction({
          db,
          action: "reject",
          admin: { ...STAFF_ADMIN, store_id: "osaka" },
          idempotencyKey: "staff-reject-cross-store-1",
          startAt: "2026-05-12T15:00:00.000Z",
          endAt: "2026-05-12T16:00:00.000Z",
          nowMs: Date.parse("2026-05-12T05:00:00.000Z")
        });
        expect(result).toEqual({ ok: false, reason: "forbidden" });
      } finally {
        db.sqlite.close();
      }
    });

    it.each(actions)(
      "allows staff %s on a future-day reservation in their own store (2026-07-14: 当日ガード撤廃)",
      async (action) => {
        const db = createMigratedSqliteD1();
        try {
          const result = await runAction({
            db,
            action,
            admin: STAFF_ADMIN,
            idempotencyKey: `staff-${action}-future-1`,
            startAt: "2026-06-01T05:00:00.000Z",
            endAt: "2026-06-01T06:00:00.000Z",
            nowMs: Date.parse("2026-05-12T05:00:00.000Z"),
            newStartAt: "2026-06-01T03:00:00.000Z"
          });
          if (!result.ok) {
            throw new Error(`expected ok:true, got reason=${result.reason}`);
          }
        } finally {
          db.sqlite.close();
        }
      }
    );

    it.each(actions)(
      "forbids staff %s when the reservation belongs to another store (店舗 scope は維持)",
      async (action) => {
        const db = createMigratedSqliteD1();
        try {
          const result = await runAction({
            db,
            action,
            admin: { ...STAFF_ADMIN, store_id: "osaka" },
            idempotencyKey: `staff-${action}-cross-store-1`,
            startAt: "2026-06-01T05:00:00.000Z",
            endAt: "2026-06-01T06:00:00.000Z",
            nowMs: Date.parse("2026-05-12T05:00:00.000Z"),
            newStartAt: "2026-06-01T03:00:00.000Z"
          });
          expect(result).toEqual({ ok: false, reason: "forbidden" });
        } finally {
          db.sqlite.close();
        }
      }
    );

    it.each(ownerActions)("allows owner %s on a future-day reservation", async (action) => {
      const db = createMigratedSqliteD1();
      try {
        const result = await runAction({
          db,
          action,
          admin: OWNER_ADMIN,
          idempotencyKey: `owner-${action}-future-1`,
          startAt: "2026-06-01T05:00:00.000Z",
          endAt: "2026-06-01T06:00:00.000Z",
          nowMs: Date.parse("2026-05-12T05:00:00.000Z"),
          newStartAt: "2026-06-01T03:00:00.000Z"
        });
        if (!result.ok) {
          throw new Error(`expected ok:true, got reason=${result.reason}`);
        }
      } finally {
        db.sqlite.close();
      }
    });

    // 当日ガード撤廃後、staff の action を状態面で守るのは validateReservationTransition
    // のみになった。自店舗・全期間の staff でも、reject が confirmed 予約に作用しないこと
    // (status guard が load-bearing であること) を回帰テストで固定する。
    it("blocks a staff reject of a confirmed reservation via the transition guard (not the removed date-gate)", async () => {
      const db = createMigratedSqliteD1();
      try {
        seedUnitActors(db);
        insertPendingReservation(db, "confirmed");
        setReservationStartAt(db, "2026-06-01T05:00:00.000Z", "2026-06-01T06:00:00.000Z");

        const result = await runAdminReservationAction({
          db: db as unknown as D1Database,
          env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "line_bot_token" },
          admin: STAFF_ADMIN,
          reservationId: RESERVATION_ID,
          action: "reject",
          request: { idempotencyKey: "staff-reject-confirmed-1" },
          now: () => Date.parse("2026-05-12T05:00:00.000Z")
        });

        expect(result).toEqual({ ok: false, reason: "invalid_transition" });
        const reservation = db.sqlite
          .prepare("SELECT status FROM reservations WHERE id = ?")
          .get(RESERVATION_ID) as { status: string };
        expect(reservation.status).toBe("confirmed");
      } finally {
        db.sqlite.close();
      }
    });
  });

  it("marks no-show reservations without increasing visit count", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      insertPendingReservation(db, "confirmed");

      const response = await adminRequest(
        db,
        `/api/admin/reservations/${RESERVATION_ID}/no-show`,
        access.token,
        {
          idempotencyKey: "admin-no-show-1"
        }
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        status: "no_show"
      });

      const visits = db.sqlite
        .prepare("SELECT COUNT(*) AS count FROM customer_visits WHERE reservation_id = ?")
        .get(RESERVATION_ID) as { count: number };
      expect(visits.count).toBe(0);

      // no_show は「キャンセル料未納」フラグ (cancellation_fee_unpaid_at) を立てる。
      const reservation = db.sqlite
        .prepare("SELECT cancellation_fee_unpaid_at FROM reservations WHERE id = ?")
        .get(RESERVATION_ID) as { cancellation_fee_unpaid_at: string | null };
      expect(reservation.cancellation_fee_unpaid_at).not.toBeNull();
    } finally {
      db.sqlite.close();
    }
  });

  it("does NOT set the cancellation-fee-unpaid flag for complete/cancel/reject", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      insertPendingReservation(db, "confirmed");

      const response = await adminRequest(
        db,
        `/api/admin/reservations/${RESERVATION_ID}/complete`,
        access.token,
        { idempotencyKey: "admin-complete-fee-1" }
      );
      expect(response.status).toBe(200);

      const reservation = db.sqlite
        .prepare("SELECT status, cancellation_fee_unpaid_at FROM reservations WHERE id = ?")
        .get(RESERVATION_ID) as { status: string; cancellation_fee_unpaid_at: string | null };
      expect(reservation.status).toBe("completed");
      expect(reservation.cancellation_fee_unpaid_at).toBeNull();
    } finally {
      db.sqlite.close();
    }
  });
});

describe("P2 admin reservation list date scope", () => {
  const NOW_ISO = "2026-06-01T05:00:00.000Z";
  const NOW_MS = Date.parse(NOW_ISO);
  const TODAY_KEY = "2026-06-01";

  const asD1 = (db: SqliteD1Database): D1Database => db as unknown as D1Database;

  const ownerUser = (): AdminUser => ({ id: "admin_owner_1", email: ADMIN_EMAIL, role: "owner",
  staff_member_id: null, store_id: null });
  const staffUser = (): AdminUser => ({ id: "admin_staff_1", email: "staff@example.com", role: "staff",
  staff_member_id: null, store_id: "kyoto" });
  const sysAdminUser = (): AdminUser => ({
    id: "admin_sys_1",
    email: "sys@example.com",
    role: "system_admin",
  staff_member_id: null,
  store_id: null
  });

  const seedCustomerOnce = (db: SqliteD1Database) => {
    db.sqlite
      .prepare("UPDATE store_settings SET max_active_reservations_per_customer = 50")
      .run();
    db.sqlite
      .prepare(
        `INSERT OR IGNORE INTO customers (id, display_name, display_name_kana, phone_normalized, phone_hash, block_status, updated_at)
         VALUES (?, '予約 太郎', 'ヨヤク タロウ', '0751234567', 'phone_hash_p2', 'active', '2026-05-09T00:00:00.000Z')`
      )
      .run(CUSTOMER_ID);
  };

  const seedReservation = (
    db: SqliteD1Database,
    opts: {
      id: string;
      startAtIso: string;
      endAtIso: string;
      status: "pending_approval" | "confirmed";
      storeId?: "kyoto" | "osaka";
      // trg_reservations_web_cap を跨ぐ seed 用に admin source を選べる。
      source?: "web_line" | "admin";
    }
  ) => {
    seedCustomerOnce(db);
    const storeId = opts.storeId ?? "kyoto";
    db.sqlite
      .prepare(
        `INSERT INTO reservations (
            id, store_id, service_id, customer_id, resource_id,
            line_identity_id, source, status, start_at, end_at,
            duration_minutes, pending_expires_at, created_by, updated_by,
            idempotency_key, google_sync_state, version, updated_at
          ) VALUES (?, ?, ?, ?, ?,
            NULL, ?, ?, ?, ?, 60, ?, 'tester', 'tester', ?, 'pending', 1, '2026-05-09T00:00:00.000Z')`
      )
      .run(
        opts.id,
        storeId,
        `service_${storeId}_default_60`,
        CUSTOMER_ID,
        `resource_${storeId}_calendar`,
        opts.source ?? "web_line",
        opts.status,
        opts.startAtIso,
        opts.endAtIso,
        opts.startAtIso,
        `idem_${opts.id}`
      );
  };

  it("(a) owner+date returns rows for the requested JST window", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedReservation(db, {
        id: "res_today",
        startAtIso: "2026-06-01T01:00:00.000Z",
        endAtIso: "2026-06-01T02:00:00.000Z",
        status: "confirmed"
      });
      seedReservation(db, {
        id: "res_may15",
        startAtIso: "2026-05-14T16:00:00.000Z",
        endAtIso: "2026-05-14T17:00:00.000Z",
        status: "confirmed"
      });

      const result = await listAdminReservations({
        db: asD1(db),
        range: "date",
        date: "2026-05-15",
        admin: ownerUser(),
        now: () => NOW_MS
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.reservations.map((r) => r.id)).toEqual(["res_may15"]);
    } finally {
      db.sqlite.close();
    }
  });

  it("(b) staff+date returns the requested JST window (2026-07-14: 当日 clamp 撤廃)", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedReservation(db, {
        id: "res_today",
        startAtIso: "2026-06-01T01:00:00.000Z",
        endAtIso: "2026-06-01T02:00:00.000Z",
        status: "confirmed"
      });
      seedReservation(db, {
        id: "res_may15",
        startAtIso: "2026-05-14T16:00:00.000Z",
        endAtIso: "2026-05-14T17:00:00.000Z",
        status: "confirmed"
      });

      const result = await listAdminReservations({
        db: asD1(db),
        range: "date",
        date: "2026-05-15",
        admin: staffUser(),
        now: () => NOW_MS
      });

      // 旧実装は staff を当日へ clamp して res_today を返していた。現在は要求日を
      // そのまま解決し、staff も過去/未来のスケジュールを閲覧できる。
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.reservations.map((r) => r.id)).toEqual(["res_may15"]);
    } finally {
      db.sqlite.close();
    }
  });

  it("(b2) staff+date stays scoped to their own store (店舗越え不可は維持)", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedReservation(db, {
        id: "res_kyoto_may15",
        startAtIso: "2026-05-14T16:00:00.000Z",
        endAtIso: "2026-05-14T17:00:00.000Z",
        status: "confirmed",
        storeId: "kyoto"
      });
      seedReservation(db, {
        id: "res_osaka_may15",
        startAtIso: "2026-05-14T16:30:00.000Z",
        endAtIso: "2026-05-14T17:30:00.000Z",
        status: "confirmed",
        storeId: "osaka",
        source: "admin"
      });

      const result = await listAdminReservations({
        db: asD1(db),
        range: "date",
        date: "2026-05-15",
        admin: staffUser(),
        now: () => NOW_MS
      });

      // 当日制限は消えても店舗 scope は残る: kyoto の staff に osaka の予約は見えない。
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.reservations.map((r) => r.id)).toEqual(["res_kyoto_may15"]);
    } finally {
      db.sqlite.close();
    }
  });

  it("(c) returns invalid_date for malformed date", async () => {
    const db = createMigratedSqliteD1();
    try {
      const result = await listAdminReservations({
        db: asD1(db),
        range: "date",
        date: "2026-13-99",
        admin: ownerUser(),
        now: () => NOW_MS
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("invalid_date");
    } finally {
      db.sqlite.close();
    }
  });

  it("(d) returns invalid_date when range=date and date is missing", async () => {
    const db = createMigratedSqliteD1();
    try {
      const result = await listAdminReservations({
        db: asD1(db),
        range: "date",
        admin: ownerUser(),
        now: () => NOW_MS
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("invalid_date");
    } finally {
      db.sqlite.close();
    }
  });

  it("(e) staff+tomorrow returns tomorrow's rows (2026-07-14: 当日 clamp 撤廃)", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedReservation(db, {
        id: "res_today",
        startAtIso: "2026-06-01T01:00:00.000Z",
        endAtIso: "2026-06-01T02:00:00.000Z",
        status: "confirmed"
      });
      seedReservation(db, {
        id: "res_tomorrow",
        startAtIso: "2026-06-02T01:00:00.000Z",
        endAtIso: "2026-06-02T02:00:00.000Z",
        status: "confirmed"
      });

      const result = await listAdminReservations({
        db: asD1(db),
        range: "tomorrow",
        admin: staffUser(),
        now: () => NOW_MS
      });

      // 旧実装は staff の tomorrow を当日へ clamp していた。現在は翌日をそのまま返す。
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.reservations.map((r) => r.id)).toEqual(["res_tomorrow"]);
    } finally {
      db.sqlite.close();
    }
  });

  it("(e2) owner+tomorrow returns tomorrow's rows with null notice", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedReservation(db, {
        id: "res_today",
        startAtIso: "2026-06-01T01:00:00.000Z",
        endAtIso: "2026-06-01T02:00:00.000Z",
        status: "confirmed"
      });
      seedReservation(db, {
        id: "res_tomorrow",
        startAtIso: "2026-06-02T01:00:00.000Z",
        endAtIso: "2026-06-02T02:00:00.000Z",
        status: "confirmed"
      });

      const result = await listAdminReservations({
        db: asD1(db),
        range: "tomorrow",
        admin: ownerUser(),
        now: () => NOW_MS
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.reservations.map((r) => r.id)).toEqual(["res_tomorrow"]);
    } finally {
      db.sqlite.close();
    }
  });

  it("(f) listPendingReservations: owner sees all stores; staff sees own store across ALL dates (approval queue)", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedReservation(db, {
        id: "pending_today",
        startAtIso: "2026-06-01T01:00:00.000Z",
        endAtIso: "2026-06-01T02:00:00.000Z",
        status: "pending_approval"
      });
      seedReservation(db, {
        id: "pending_tomorrow",
        startAtIso: "2026-06-02T01:00:00.000Z",
        endAtIso: "2026-06-02T02:00:00.000Z",
        status: "pending_approval"
      });
      seedReservation(db, {
        id: "pending_next_week",
        startAtIso: "2026-06-08T01:00:00.000Z",
        endAtIso: "2026-06-08T02:00:00.000Z",
        status: "pending_approval"
      });
      // 他店舗の pending は staff (kyoto) の承認キューに出てはならない。
      // (4件目なので web cap trigger を避けて admin source で seed する)
      seedReservation(db, {
        id: "pending_other_store",
        startAtIso: "2026-06-03T01:00:00.000Z",
        endAtIso: "2026-06-03T02:00:00.000Z",
        status: "pending_approval",
        storeId: "osaka",
        source: "admin"
      });

      const owner = await listPendingReservations({ db: asD1(db), admin: ownerUser() });
      const sys = await listPendingReservations({ db: asD1(db), admin: sysAdminUser() });
      const staff = await listPendingReservations({ db: asD1(db), admin: staffUser() });

      expect(owner.map((r) => r.id).sort()).toEqual(
        ["pending_next_week", "pending_other_store", "pending_today", "pending_tomorrow"]
      );
      expect(sys.map((r) => r.id).sort()).toEqual(
        ["pending_next_week", "pending_other_store", "pending_today", "pending_tomorrow"]
      );
      // 全予約承認制: staff は自店舗の承認待ちを日付制限なく全件見る (却下/承認業務のキュー)。
      expect(staff.map((r) => r.id).sort()).toEqual(
        ["pending_next_week", "pending_today", "pending_tomorrow"]
      );
    } finally {
      db.sqlite.close();
    }
  });

  it.each([
    { label: "earliest expiry", earlyCreated: "2026-05-30 01:00:00", laterCreated: "2026-05-30T02:00:00.000Z", earlyExpiry: "2026-05-31T01:00:00.000Z", laterExpiry: "2026-05-31T02:00:00.000Z" },
    { label: "expiry milliseconds", earlyCreated: "2026-05-30T01:00:00.000Z", laterCreated: "2026-05-30T01:00:00.000Z", earlyExpiry: "2026-05-31T01:00:00.001Z", laterExpiry: "2026-05-31T01:00:00.002Z" },
    { label: "receipt milliseconds after tied expiry", earlyCreated: "2026-05-30T01:00:00.001Z", laterCreated: "2026-05-30T01:00:00.002Z", earlyExpiry: "2026-05-31T01:00:00.000Z", laterExpiry: "2026-05-31T01:00:00.000Z" }
  ])("pending queue exposes dates and prioritizes $label", async ({ earlyCreated, laterCreated, earlyExpiry, laterExpiry }) => {
    const db = createMigratedSqliteD1();
    try {
      seedReservation(db, { id: "pending_soon_visit", startAtIso: "2026-06-01T01:00:00.000Z", endAtIso: "2026-06-01T02:00:00.000Z", status: "pending_approval" });
      seedReservation(db, { id: "pending_soon_expiry", startAtIso: "2026-06-02T01:00:00.000Z", endAtIso: "2026-06-02T02:00:00.000Z", status: "pending_approval" });
      const update = db.sqlite.prepare("UPDATE reservations SET created_at=?, pending_expires_at=? WHERE id=?");
      update.run(earlyCreated, earlyExpiry, "pending_soon_expiry");
      update.run(laterCreated, laterExpiry, "pending_soon_visit");
      const pending = await listPendingReservations({ db: asD1(db), admin: ownerUser() });
      expect(pending.map((row) => row.id)).toEqual(["pending_soon_expiry", "pending_soon_visit"]);
      expect(pending[0]).toMatchObject({ createdAt: earlyCreated.includes("T") ? earlyCreated : "2026-05-30T01:00:00.000Z", pendingExpiresAt: earlyExpiry });
    } finally {
      db.sqlite.close();
    }
  });

  it("staff range=today returns today rows", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedReservation(db, {
        id: "res_today_s",
        startAtIso: "2026-06-01T01:00:00.000Z",
        endAtIso: "2026-06-01T02:00:00.000Z",
        status: "confirmed"
      });

      const result = await listAdminReservations({
        db: asD1(db),
        range: "today",
        admin: staffUser(),
        now: () => NOW_MS
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.reservations.map((r) => r.id)).toEqual(["res_today_s"]);
    } finally {
      db.sqlite.close();
    }
  });

  it("staff date=today returns today rows", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedReservation(db, {
        id: "res_today_match",
        startAtIso: "2026-06-01T01:00:00.000Z",
        endAtIso: "2026-06-01T02:00:00.000Z",
        status: "confirmed"
      });

      const result = await listAdminReservations({
        db: asD1(db),
        range: "date",
        date: TODAY_KEY,
        admin: staffUser(),
        now: () => NOW_MS
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.reservations.map((r) => r.id)).toEqual(["res_today_match"]);
    } finally {
      db.sqlite.close();
    }
  });

  it("returns invalid_date for a semantically-invalid date that passes the regex (2026-02-30)", async () => {
    const db = createMigratedSqliteD1();
    try {
      const result = await listAdminReservations({
        db: asD1(db),
        range: "date",
        date: "2026-02-30",
        admin: ownerUser(),
        now: () => NOW_MS
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("invalid_date");
    } finally {
      db.sqlite.close();
    }
  });

  it("JST midnight boundary: UTC 14:59:59.999 is the prior JST day; UTC 15:00:00.000 is the next JST day", async () => {
    const db = createMigratedSqliteD1();
    try {
      // UTC 2026-05-31T14:59:59.999Z == JST 2026-05-31T23:59:59.999 (prior JST day)
      seedReservation(db, {
        id: "res_boundary_prior_jst_day",
        startAtIso: "2026-05-31T14:59:59.999Z",
        endAtIso: "2026-05-31T15:30:00.000Z",
        status: "confirmed"
      });
      // UTC 2026-05-31T15:00:00.000Z == JST 2026-06-01T00:00:00.000 (first instant of TODAY_KEY)
      seedReservation(db, {
        id: "res_boundary_first_jst_today",
        startAtIso: "2026-05-31T15:00:00.000Z",
        endAtIso: "2026-05-31T15:30:00.000Z",
        status: "confirmed"
      });

      const result = await listAdminReservations({
        db: asD1(db),
        range: "date",
        date: TODAY_KEY,
        admin: ownerUser(),
        now: () => NOW_MS
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Only the row at UTC 15:00 (== JST 2026-06-01 00:00) belongs to TODAY_KEY.
      expect(result.reservations.map((r) => r.id)).toEqual(["res_boundary_first_jst_today"]);
    } finally {
      db.sqlite.close();
    }
  });

  // ── Per-customer LINE friend-status resolution ────────────────────────
  // lineFriendStatus is resolved from the customer's most-recent LINE
  // identity (RESERVATION_LINE_FRIEND_STATUS_SUBQUERY), NOT from the
  // reservation's line_identity_id FK. seedReservation always sets
  // line_identity_id = NULL, so these tests exercise the customer-level path
  // that fixes "LINE紐付け済みなのに不明" on phone/admin-booked reservations.
  const seedLineIdentity = (
    db: SqliteD1Database,
    opts: { id: string; lineUserId: string; status: string; updatedAt: string }
  ) => {
    db.sqlite
      .prepare(
        `INSERT INTO line_identities (
            id, customer_id, channel_id, line_user_id, friend_flag,
            official_friend_status, created_at, updated_at
          ) VALUES (?, ?, 'line_channel_id', ?, 1, ?, ?, ?)`
      )
      .run(opts.id, CUSTOMER_ID, opts.lineUserId, opts.status, opts.updatedAt, opts.updatedAt);
  };

  it("(g) listAdminReservations resolves lineFriendStatus from the customer when line_identity_id is NULL", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedReservation(db, {
        id: "res_phone_linked",
        startAtIso: "2026-06-01T01:00:00.000Z",
        endAtIso: "2026-06-01T02:00:00.000Z",
        status: "confirmed"
      });
      seedLineIdentity(db, {
        id: "li_g_friend",
        lineUserId: "U_g_friend",
        status: "friend",
        updatedAt: "2026-05-09T00:00:00.000Z"
      });

      const result = await listAdminReservations({
        db: asD1(db),
        range: "today",
        admin: ownerUser(),
        now: () => NOW_MS
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.reservations).toHaveLength(1);
      expect(result.reservations[0]?.lineFriendStatus).toBe("friend");
    } finally {
      db.sqlite.close();
    }
  });

  it("(h) listPendingReservations resolves lineFriendStatus from the customer when line_identity_id is NULL", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedReservation(db, {
        id: "pending_linked",
        startAtIso: "2026-06-01T01:00:00.000Z",
        endAtIso: "2026-06-01T02:00:00.000Z",
        status: "pending_approval"
      });
      seedLineIdentity(db, {
        id: "li_h_friend",
        lineUserId: "U_h_friend",
        status: "friend",
        updatedAt: "2026-05-09T00:00:00.000Z"
      });

      const pending = await listPendingReservations({ db: asD1(db), admin: ownerUser() });

      expect(pending).toHaveLength(1);
      expect(pending[0]?.lineFriendStatus).toBe("friend");
    } finally {
      db.sqlite.close();
    }
  });

  it("(i) multiple identities: newest updated_at wins and the reservation row is NOT duplicated", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedReservation(db, {
        id: "res_multi",
        startAtIso: "2026-06-01T01:00:00.000Z",
        endAtIso: "2026-06-01T02:00:00.000Z",
        status: "confirmed"
      });
      // Older identity is a friend; the customer later blocked / re-linked, so
      // the newest identity is blocked. The newest (by updated_at) must win.
      seedLineIdentity(db, {
        id: "li_i_friend_old",
        lineUserId: "U_i_friend_old",
        status: "friend",
        updatedAt: "2026-05-01T00:00:00.000Z"
      });
      seedLineIdentity(db, {
        id: "li_i_blocked_new",
        lineUserId: "U_i_blocked_new",
        status: "blocked",
        updatedAt: "2026-05-20T00:00:00.000Z"
      });

      const result = await listAdminReservations({
        db: asD1(db),
        range: "today",
        admin: ownerUser(),
        now: () => NOW_MS
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Scalar subquery (LIMIT 1) must NOT fan the reservation into 2 rows.
      expect(result.reservations).toHaveLength(1);
      expect(result.reservations[0]?.lineFriendStatus).toBe("blocked");
    } finally {
      db.sqlite.close();
    }
  });

  it("(j) no LINE identity at all: pending lineFriendStatus is 'unknown' (不明)", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedReservation(db, {
        id: "pending_no_line",
        startAtIso: "2026-06-01T01:00:00.000Z",
        endAtIso: "2026-06-01T02:00:00.000Z",
        status: "pending_approval"
      });

      const pending = await listPendingReservations({ db: asD1(db), admin: ownerUser() });

      expect(pending).toHaveLength(1);
      expect(pending[0]?.lineFriendStatus).toBe("unknown");
    } finally {
      db.sqlite.close();
    }
  });

  it("(k) CSV export resolves the LINE column from the customer (友だち) for a NULL-FK reservation", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedReservation(db, {
        id: "res_csv_linked",
        startAtIso: "2026-06-01T01:00:00.000Z",
        endAtIso: "2026-06-01T02:00:00.000Z",
        status: "confirmed"
      });
      seedLineIdentity(db, {
        id: "li_k_friend",
        lineUserId: "U_k_friend",
        status: "friend",
        updatedAt: "2026-05-09T00:00:00.000Z"
      });

      const period = await listAdminReservationsForPeriod({
        db: asD1(db),
        from: "2026-06-01",
        to: "2026-06-01",
        limit: 100,
        isStaff: false
      });

      expect(period.ok).toBe(true);
      if (!period.ok) return;
      expect(period.rows).toHaveLength(1);
      expect(period.rows[0]?.lineFriendStatus).toBe("friend");
      // The rendered CSV LINE column must show the Japanese label, not 不明.
      expect(reservationCsvLine(period.rows[0]!)).toContain("友だち");
    } finally {
      db.sqlite.close();
    }
  });

  it("(k2) staff must not see googleEventId in period rows (search/CSV); owner does", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedReservation(db, {
        id: "res_geid",
        startAtIso: "2026-06-01T01:00:00.000Z",
        endAtIso: "2026-06-01T02:00:00.000Z",
        status: "confirmed"
      });
      db.sqlite
        .prepare("UPDATE reservations SET google_event_id = 'gcal_evt_123' WHERE id = 'res_geid'")
        .run();

      const staffView = await listAdminReservationsForPeriod({
        db: asD1(db), from: "2026-06-01", to: "2026-06-01", limit: 100, isStaff: true
      });
      const ownerView = await listAdminReservationsForPeriod({
        db: asD1(db), from: "2026-06-01", to: "2026-06-01", limit: 100, isStaff: false
      });

      expect(staffView.ok && ownerView.ok).toBe(true);
      if (!staffView.ok || !ownerView.ok) return;
      // Staff: redacted (parity with getAdminReservationDetail). Owner: visible.
      expect(staffView.rows[0]?.googleEventId).toBeNull();
      expect(ownerView.rows[0]?.googleEventId).toBe("gcal_evt_123");
    } finally {
      db.sqlite.close();
    }
  });

  it("(l) equal updated_at ties are deterministic: id DESC wins (matches the customer panel ORDER BY)", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedReservation(db, {
        id: "res_tie",
        startAtIso: "2026-06-01T01:00:00.000Z",
        endAtIso: "2026-06-01T02:00:00.000Z",
        status: "confirmed"
      });
      // Two identities share updated_at AND created_at. The subquery's final
      // tiebreaker is `id DESC`, so "li_tie_zzz" (> "li_tie_aaa") must win.
      // The customer-detail query uses the identical ORDER BY, so both panels
      // resolve to the same identity.
      seedLineIdentity(db, {
        id: "li_tie_aaa",
        lineUserId: "U_tie_aaa",
        status: "friend",
        updatedAt: "2026-05-09T00:00:00.000Z"
      });
      seedLineIdentity(db, {
        id: "li_tie_zzz",
        lineUserId: "U_tie_zzz",
        status: "blocked",
        updatedAt: "2026-05-09T00:00:00.000Z"
      });

      const result = await listAdminReservations({
        db: asD1(db),
        range: "today",
        admin: ownerUser(),
        now: () => NOW_MS
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.reservations).toHaveLength(1);
      expect(result.reservations[0]?.lineFriendStatus).toBe("blocked");
    } finally {
      db.sqlite.close();
    }
  });

  it("(m) cross-customer isolation: a reservation resolves ONLY its own customer's LINE identity", async () => {
    const db = createMigratedSqliteD1();
    try {
      // Customer A (CUSTOMER_ID) owns a friend identity.
      seedCustomerOnce(db);
      seedLineIdentity(db, {
        id: "li_m_friend_a",
        lineUserId: "U_m_friend_a",
        status: "friend",
        updatedAt: "2026-05-09T00:00:00.000Z"
      });
      // Customer B is a different person with NO LINE identity, with a
      // reservation today. The correlated subquery (WHERE li.customer_id =
      // reservations.customer_id) must NOT leak A's friend status to B; a
      // dropped/relaxed WHERE would surface another customer's LINE state.
      db.sqlite
        .prepare(
          `INSERT INTO customers (id, display_name, display_name_kana, phone_normalized, phone_hash, block_status, updated_at)
           VALUES ('customer_isolation_b', '別 顧客', 'ベツ コキャク', '0759990000', 'phone_hash_iso_b', 'active', '2026-05-09T00:00:00.000Z')`
        )
        .run();
      db.sqlite
        .prepare(
          `INSERT INTO reservations (
             id, store_id, service_id, customer_id, resource_id,
             line_identity_id, source, status, start_at, end_at,
             duration_minutes, created_by, updated_by, idempotency_key,
             google_sync_state, version, updated_at
           ) VALUES ('res_iso_b', 'kyoto', 'service_kyoto_default_60', 'customer_isolation_b', 'resource_kyoto_calendar',
             NULL, 'phone_admin', 'confirmed', '2026-06-01T01:00:00.000Z', '2026-06-01T02:00:00.000Z',
             60, 'tester', 'tester', 'idem_res_iso_b', 'pending', 1, '2026-05-09T00:00:00.000Z')`
        )
        .run();

      const result = await listAdminReservations({
        db: asD1(db),
        range: "today",
        admin: ownerUser(),
        now: () => NOW_MS
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const resB = result.reservations.find((r) => r.id === "res_iso_b");
      expect(resB).toBeDefined();
      // B has no identity of its own; A's friend status must NOT cross over.
      expect(resB?.lineFriendStatus ?? null).toBeNull();
    } finally {
      db.sqlite.close();
    }
  });
});

// terminal action (reject / cancel / complete / no-show) は、その予約に対する
// pending の変更申請を 'expired' に閉じる。放置すると staff の変更申請キューに
// 永久滞留し、reject で既に消えた予約の却下 LINE が顧客へ飛ぶ。
describe("terminal admin actions close pending change requests", () => {
  const NOW_ISO = "2026-06-01T05:00:00.000Z";
  const NOW_MS = Date.parse(NOW_ISO);

  const asD1 = (db: SqliteD1Database): D1Database => db as unknown as D1Database;
  const owner = (): AdminUser => ({
    id: "admin_owner_1",
    email: ADMIN_EMAIL,
    role: "owner",
    staff_member_id: null,
    store_id: null
  });

  const seed = (
    db: SqliteD1Database,
    opts: {
      status: "pending_approval" | "confirmed";
      startAtIso: string;
      endAtIso: string;
      changeRequestStatus?: "pending" | "withdrawn";
    }
  ) => {
    insertAdminUser(db);
    db.sqlite
      .prepare(
        `INSERT INTO customers (id, display_name, display_name_kana, phone_normalized, phone_hash, block_status, updated_at)
         VALUES (?, '申請 太郎', 'シンセイ タロウ', '0759998888', 'phone_hash_cr_close', 'active', '2026-05-09T00:00:00.000Z')`
      )
      .run("customer_cr_close_1");
    db.sqlite
      .prepare(
        `INSERT INTO reservations (
            id, store_id, service_id, customer_id, resource_id,
            line_identity_id, source, status, start_at, end_at,
            duration_minutes, pending_expires_at, created_by, updated_by,
            idempotency_key, google_sync_state, version, updated_at
          ) VALUES (?, 'kyoto', 'service_kyoto_default_60', ?, 'resource_kyoto_calendar',
            NULL, 'admin', ?, ?, ?, 60, NULL, 'tester', 'tester', ?, 'pending', 1, '2026-05-09T00:00:00.000Z')`
      )
      .run(
        "reservation_cr_close_1",
        "customer_cr_close_1",
        opts.status,
        opts.startAtIso,
        opts.endAtIso,
        "idem_reservation_cr_close_1"
      );
    db.sqlite
      .prepare(
        `INSERT INTO reservation_change_requests (
            id, reservation_id, customer_id, request_type, status,
            reservation_version_at_request, current_start_at, current_end_at
          ) VALUES (?, ?, ?, 'cancel', ?, 1, ?, ?)`
      )
      .run(
        "change_request_cr_close_1",
        "reservation_cr_close_1",
        "customer_cr_close_1",
        opts.changeRequestStatus ?? "pending",
        opts.startAtIso,
        opts.endAtIso
      );
  };

  const changeRequestStatus = (db: SqliteD1Database) =>
    (
      db.sqlite
        .prepare("SELECT status FROM reservation_change_requests WHERE id = 'change_request_cr_close_1'")
        .get() as { status: string }
    ).status;

  const runAction = (db: SqliteD1Database, action: AdminReservationAction) =>
    runAdminReservationAction({
      db: asD1(db),
      env: {},
      admin: owner(),
      reservationId: "reservation_cr_close_1",
      action,
      request: { idempotencyKey: `idem_cr_close_${action}`, reason: "テスト理由" },
      now: () => NOW_MS
    });

  // reject は pending_approval から、cancel は未来の confirmed から、
  // complete / no-show は終了済みの confirmed から遷移する。
  const CASES: Array<{
    action: AdminReservationAction;
    status: "pending_approval" | "confirmed";
    startAtIso: string;
    endAtIso: string;
  }> = [
    { action: "reject", status: "pending_approval", startAtIso: "2026-06-02T01:00:00.000Z", endAtIso: "2026-06-02T02:00:00.000Z" },
    { action: "cancel", status: "confirmed", startAtIso: "2026-06-02T01:00:00.000Z", endAtIso: "2026-06-02T02:00:00.000Z" },
    { action: "complete", status: "confirmed", startAtIso: "2026-06-01T01:00:00.000Z", endAtIso: "2026-06-01T02:00:00.000Z" },
    { action: "no-show", status: "confirmed", startAtIso: "2026-06-01T01:00:00.000Z", endAtIso: "2026-06-01T02:00:00.000Z" }
  ];

  for (const testCase of CASES) {
    it(`${testCase.action} closes the reservation's pending change request as 'expired'`, async () => {
      const db = createMigratedSqliteD1();
      try {
        seed(db, testCase);

        const result = await runAction(db, testCase.action);

        expect(result.ok).toBe(true);
        expect(changeRequestStatus(db)).toBe("expired");
      } finally {
        db.sqlite.close();
      }
    });
  }

  it("reject does not touch a change request that is already withdrawn", async () => {
    const db = createMigratedSqliteD1();
    try {
      seed(db, {
        status: "pending_approval",
        startAtIso: "2026-06-02T01:00:00.000Z",
        endAtIso: "2026-06-02T02:00:00.000Z",
        changeRequestStatus: "withdrawn"
      });

      const result = await runAction(db, "reject");

      expect(result.ok).toBe(true);
      expect(changeRequestStatus(db)).toBe("withdrawn");
    } finally {
      db.sqlite.close();
    }
  });
});

describe("admin reservation corrections (completed <-> no_show)", () => {
  const OWNER: AdminUser = {
    id: "admin_owner_1",
    email: ADMIN_EMAIL,
    role: "owner",
    staff_member_id: null,
    store_id: null
  };

  const runCorrection = (
    db: SqliteD1Database | D1Database,
    action: "complete" | "no-show" | "correct-no-show" | "restore-completed",
    request: { idempotencyKey: string; expectedVersion?: number },
    admin: AdminUser = OWNER,
    nowIso = "2026-06-03T02:00:00.000Z"
  ) =>
    runAdminReservationAction({
      db: db as D1Database,
      env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "line_bot_token" },
      admin,
      reservationId: RESERVATION_ID,
      action,
      request,
      fetcher: createFetchMock(createAccessJwtFixture().jwk),
      now: () => Date.parse(nowIso)
    });

  /** confirmed -> complete まで進めて「訂正できる状態」を作る。 */
  const seedCompleted = async (db: SqliteD1Database) => {
    insertAdminUser(db);
    insertPendingReservation(db, "confirmed");
    const completed = await runCorrection(db, "complete", { idempotencyKey: "seed-complete-1" });
    expect(completed).toMatchObject({ ok: true, status: "completed" });
    return completed as { ok: true; version: number };
  };

  const visitRows = (db: SqliteD1Database) =>
    db.sqlite
      .prepare(
        `SELECT id, status, voided_by, voided_at, void_reason, visited_at, visit_source, recorded_by
         FROM customer_visits WHERE reservation_id = ?`
      )
      .all(RESERVATION_ID) as Array<Record<string, unknown>>;

  const auditRows = (db: SqliteD1Database) =>
    db.sqlite
      .prepare(`SELECT action, metadata_json FROM audit_logs WHERE target_id = ? ORDER BY rowid`)
      .all(RESERVATION_ID) as Array<{ action: string; metadata_json: string | null }>;

  const reservationRow = (db: SqliteD1Database) =>
    db.sqlite
      .prepare(
        `SELECT status, version, completed_at, no_show_at, cancellation_fee_unpaid_at
         FROM reservations WHERE id = ?`
      )
      .get(RESERVATION_ID) as Record<string, unknown>;

  it("voids the visit, flags the unpaid fee, and audits the real previous status", async () => {
    const db = createMigratedSqliteD1();
    try {
      const completed = await seedCompleted(db);

      const result = await runCorrection(db, "correct-no-show", {
        idempotencyKey: "correct-1",
        expectedVersion: completed.version
      });

      expect(result).toMatchObject({ ok: true, status: "no_show" });

      const reservation = reservationRow(db);
      expect(reservation.status).toBe("no_show");
      expect(reservation.completed_at).toBeNull();
      expect(reservation.no_show_at).not.toBeNull();
      // 既存の no-show と同じく、訂正でもキャンセル料未納が立つ。
      expect(reservation.cancellation_fee_unpaid_at).not.toBeNull();

      // 行は消さず voided にする。CHECK 制約どおり 3 列そろって埋まる。
      const visits = visitRows(db);
      expect(visits).toHaveLength(1);
      expect(visits[0]).toMatchObject({
        status: "voided",
        voided_by: "admin_owner_1",
        void_reason: "reservation_corrected_to_no_show"
      });
      expect(visits[0].voided_at).not.toBeNull();

      const audit = auditRows(db);
      const correction = audit.find((row) => row.action === "admin_reservation_correct_no_show");
      // replace ではなく replaceAll でないと "correct_no-show" になる。
      expect(correction).toBeDefined();
      expect(JSON.parse(correction!.metadata_json ?? "{}")).toMatchObject({
        previousStatus: "completed",
        nextStatus: "no_show"
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("restores the same visit row without overwriting its recorded fields", async () => {
    const db = createMigratedSqliteD1();
    try {
      const completed = await seedCompleted(db);
      const before = visitRows(db)[0];

      const corrected = await runCorrection(db, "correct-no-show", {
        idempotencyKey: "correct-2",
        expectedVersion: completed.version
      });
      expect(corrected).toMatchObject({ ok: true });

      // 復元は別のオーナーが行う。同じ管理者だと recorded_by の保持を検証できない
      // (上書きされても同じ値になる)。
      insertAdminUserHelper(db, {
        id: "admin_owner_2",
        email: "owner2@example.com",
        accessSubject: "owner-2-subject",
        role: "owner",
        updatedAt: "2026-05-09T00:00:00.000Z"
      });
      const restored = await runCorrection(
        db,
        "restore-completed",
        { idempotencyKey: "restore-2", expectedVersion: (corrected as { version: number }).version },
        { ...OWNER, id: "admin_owner_2", email: "owner2@example.com" }
      );
      expect(restored).toMatchObject({ ok: true, status: "completed" });

      const visits = visitRows(db);
      expect(visits).toHaveLength(1);
      // 同一行が戻る (新しい行を作らない)。記録済みの値は上書きしない。
      expect(visits[0].id).toBe(before.id);
      expect(visits[0].visited_at).toBe(before.visited_at);
      expect(visits[0].visit_source).toBe(before.visit_source);
      // 記録者は最初に完了させたオーナーのまま (復元した別オーナーで上書きしない)。
      expect(visits[0].recorded_by).toBe("admin_owner_1");
      expect(visits[0].recorded_by).toBe(before.recorded_by);
      expect(visits[0]).toMatchObject({
        status: "valid",
        voided_by: null,
        voided_at: null,
        void_reason: null
      });

      // 未納一覧のクエリは status を見ないので、復元でフラグを消さないと
      // 完了済みの予約が未納一覧に残る。
      expect(reservationRow(db).cancellation_fee_unpaid_at).toBeNull();
      expect(reservationRow(db).no_show_at).toBeNull();
    } finally {
      db.sqlite.close();
    }
  });

  it("creates a visit when restoring a reservation that never had one", async () => {
    const db = createMigratedSqliteD1();
    try {
      const completed = await seedCompleted(db);
      const corrected = await runCorrection(db, "correct-no-show", {
        idempotencyKey: "correct-3",
        expectedVersion: completed.version
      });
      // 過去の不整合データを模して、来店記録を物理的に消す。
      db.sqlite.prepare("DELETE FROM customer_visits WHERE reservation_id = ?").run(RESERVATION_ID);

      const restored = await runCorrection(db, "restore-completed", {
        idempotencyKey: "restore-3",
        expectedVersion: (corrected as { version: number }).version
      });
      expect(restored).toMatchObject({ ok: true, status: "completed" });

      const visits = visitRows(db);
      expect(visits).toHaveLength(1);
      expect(visits[0]).toMatchObject({ status: "valid", recorded_by: "admin_owner_1" });
      // 訂正を押した時刻ではなく予約の開始時刻を来店日にする。
      expect(visits[0].visited_at).toBe("2026-06-01T01:00:00.000Z");
    } finally {
      db.sqlite.close();
    }
  });

  it("succeeds on a completed reservation that has no visit row at all", async () => {
    const db = createMigratedSqliteD1();
    try {
      const completed = await seedCompleted(db);
      db.sqlite.prepare("DELETE FROM customer_visits WHERE reservation_id = ?").run(RESERVATION_ID);

      const result = await runCorrection(db, "correct-no-show", {
        idempotencyKey: "correct-4",
        expectedVersion: completed.version
      });

      expect(result).toMatchObject({ ok: true, status: "no_show" });
      expect(visitRows(db)).toHaveLength(0);
      expect(
        auditRows(db).some((row) => row.action === "admin_reservation_correct_no_show")
      ).toBe(true);
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects a correction from a non-terminal status without any side effect", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db);
      insertPendingReservation(db, "confirmed");

      const result = await runCorrection(db, "correct-no-show", {
        idempotencyKey: "correct-5",
        expectedVersion: 1
      });

      expect(result).toEqual({ ok: false, reason: "invalid_transition" });
      expect(visitRows(db)).toHaveLength(0);
      expect(auditRows(db)).toHaveLength(0);
      expect(reservationRow(db).status).toBe("confirmed");
    } finally {
      db.sqlite.close();
    }
  });

  it("records the terminal status, not checked_in, when the reservation was checked in", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db);
      insertPendingReservation(db, "confirmed");
      db.sqlite
        .prepare("UPDATE reservations SET checked_in_at = ? WHERE id = ?")
        .run("2026-06-01T00:55:00.000Z", RESERVATION_ID);

      const completed = await runCorrection(db, "complete", { idempotencyKey: "seed-complete-ci" });
      const corrected = await runCorrection(db, "correct-no-show", {
        idempotencyKey: "correct-ci",
        expectedVersion: (completed as { version: number }).version
      });
      const restored = await runCorrection(db, "restore-completed", {
        idempotencyKey: "restore-ci",
        expectedVersion: (corrected as { version: number }).version
      });
      expect(restored).toMatchObject({ ok: true });

      const audit = auditRows(db);
      const correctMeta = JSON.parse(
        audit.find((r) => r.action === "admin_reservation_correct_no_show")!.metadata_json ?? "{}"
      );
      const restoreMeta = JSON.parse(
        audit.find((r) => r.action === "admin_reservation_restore_completed")!.metadata_json ?? "{}"
      );
      // checked_in_at が入っていても、訂正の遷移元は終端状態そのもの。
      expect(correctMeta.previousStatus).toBe("completed");
      expect(restoreMeta.previousStatus).toBe("no_show");
    } finally {
      db.sqlite.close();
    }
  });

  it("requires expectedVersion and reports concurrent drift as stale_snapshot", async () => {
    const db = createMigratedSqliteD1();
    try {
      const completed = await seedCompleted(db);

      const missing = await runCorrection(db, "correct-no-show", { idempotencyKey: "correct-6" });
      expect(missing).toEqual({ ok: false, reason: "invalid_request" });

      const stale = await runCorrection(db, "correct-no-show", {
        idempotencyKey: "correct-7",
        expectedVersion: completed.version + 5
      });
      expect(stale).toEqual({ ok: false, reason: "stale_snapshot" });

      // どちらも副作用ゼロ。
      expect(reservationRow(db).status).toBe("completed");
      expect(visitRows(db)[0].status).toBe("valid");
    } finally {
      db.sqlite.close();
    }
  });

  it("replays a correction key as success even after the reverse correction ran", async () => {
    const db = createMigratedSqliteD1();
    try {
      const completed = await seedCompleted(db);

      const corrected = await runCorrection(db, "correct-no-show", {
        idempotencyKey: "correct-roundtrip",
        expectedVersion: completed.version
      });
      expect(corrected).toMatchObject({ ok: true, status: "no_show" });

      const restored = await runCorrection(db, "restore-completed", {
        idempotencyKey: "restore-roundtrip",
        expectedVersion: (corrected as { version: number }).version
      });
      expect(restored).toMatchObject({ ok: true, status: "completed" });

      // 逆向きの訂正が挟まっても、成功済みキーの再送は成功として返る。
      // status は「その操作が書いた値」ではなく現在値になる。
      const replay = await runCorrection(db, "correct-no-show", {
        idempotencyKey: "correct-roundtrip",
        expectedVersion: completed.version
      });
      expect(replay).toMatchObject({ ok: true, replayed: true, status: "completed" });

      // 再送で副作用は増えない。
      expect(visitRows(db)).toHaveLength(1);
      expect(visitRows(db)[0].status).toBe("valid");
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects staff restoration before touching the idempotency ledger or the reservation row", async () => {
    const db = createMigratedSqliteD1();
    try {
      const completed = await seedCompleted(db);
      const staff: AdminUser = { ...OWNER, id: "admin_staff_1", role: "staff", store_id: "kyoto" };

      // 成功済みキーの再送: 権限判定が replay より後ろにあると ok:true が返ってしまう。
      const replay = await runCorrection(
        db,
        "restore-completed",
        { idempotencyKey: "seed-complete-1", expectedVersion: completed.version },
        staff
      );
      expect(replay).toEqual({ ok: false, reason: "forbidden" });

      // 存在しない予約: 権限判定が fetch より後ろにあると not_found で存在有無が漏れる。
      const missing = await runAdminReservationAction({
        db: db as unknown as D1Database,
        env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "line_bot_token" },
        admin: staff,
        reservationId: "reservation_does_not_exist",
        action: "restore-completed",
        request: { idempotencyKey: "staff-missing-1", expectedVersion: 1 },
        fetcher: createFetchMock(createAccessJwtFixture().jwk),
        now: () => Date.parse("2026-06-03T02:00:00.000Z")
      });
      expect(missing).toEqual({ ok: false, reason: "forbidden" });
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects unbound staff before querying even a missing reservation", async () => {
    const result = await runAdminReservationAction({
      db: createThrowingDb("unbound staff must not query reservations or idempotency"),
      env: {},
      admin: { ...OWNER, role: "staff", store_id: null },
      reservationId: "missing-reservation",
      action: "correct-no-show",
      request: { idempotencyKey: "unbound-missing", expectedVersion: 1 }
    });
    expect(result).toEqual({ ok: false, reason: "forbidden" });
  });

  it("re-dates the unpaid fee when a correction round trip puts the reservation back to no_show", async () => {
    const db = createMigratedSqliteD1();
    try {
      const completed = await seedCompleted(db);
      const first = await runCorrection(db, "correct-no-show", {
        idempotencyKey: "fee-1",
        expectedVersion: completed.version
      });
      expect(reservationRow(db).cancellation_fee_unpaid_at).toBe("2026-06-03T02:00:00.000Z");

      // 復元は未納を必ず消す (完了済みの予約が未納一覧に居座らないため)。
      const restored = await runCorrection(db, "restore-completed", {
        idempotencyKey: "fee-2",
        expectedVersion: (first as { ok: true; version: number }).version
      });
      expect(reservationRow(db).cancellation_fee_unpaid_at).toBeNull();

      // もう一度訂正すると未納は「最後に訂正した日」で立ち直る。初回の発生日は
      // 復元時点で消えており、どこにも残らない (許容した振る舞い)。
      await runCorrection(
        db,
        "correct-no-show",
        { idempotencyKey: "fee-3", expectedVersion: (restored as { ok: true; version: number }).version },
        OWNER,
        "2026-06-10T02:00:00.000Z"
      );
      expect(reservationRow(db).cancellation_fee_unpaid_at).toBe("2026-06-10T02:00:00.000Z");
    } finally {
      db.sqlite.close();
    }
  });

  it("reports success when the reverse correction lands between the batch and the read", async () => {
    const db = createMigratedSqliteD1();
    try {
      const completed = await seedCompleted(db);
      const originalBatch = db.batch.bind(db);
      let injected = false;
      db.batch = async (statements) => {
        const result = await originalBatch(statements);
        if (!injected) {
          injected = true;
          // 別のオーナーが逆向きの訂正を成功させた状態を作る。
          db.sqlite
            .prepare(
              `UPDATE reservations
               SET status = 'completed', completed_at = ?, no_show_at = NULL, version = version + 1
               WHERE id = ?`
            )
            .run("2026-06-03T02:00:00.000Z", RESERVATION_ID);
        }
        return result;
      };

      const result = await runCorrection(db, "correct-no-show", {
        idempotencyKey: "drift-1",
        expectedVersion: completed.version
      });

      // 自分の batch はコミット済みなので write_failed (500) にはしない。
      // 応答の status は replay と同じく「その時点の現在値」。
      // replayed は false — この呼び出しは実際に書いている。
      expect(result).toMatchObject({ ok: true, status: "completed", replayed: false });
    } finally {
      db.sqlite.close();
    }
  });

  it("emits its own metric events so completed / no_show counts are not inflated", async () => {
    const db = createMigratedSqliteD1();
    try {
      const completed = await seedCompleted(db);
      const points: string[] = [];
      const env = {
        LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "line_bot_token",
        METRICS: {
          writeDataPoint: (point: { blobs?: unknown[] }) => {
            points.push(String(point.blobs?.[0]));
          }
        }
      } as unknown as Parameters<typeof runAdminReservationAction>[0]["env"];

      const corrected = await runAdminReservationAction({
        db: db as unknown as D1Database,
        env,
        admin: OWNER,
        reservationId: RESERVATION_ID,
        action: "correct-no-show",
        request: { idempotencyKey: "metric-1", expectedVersion: completed.version },
        fetcher: createFetchMock(createAccessJwtFixture().jwk),
        now: () => Date.parse("2026-06-03T02:00:00.000Z")
      });
      expect(corrected).toMatchObject({ ok: true, status: "no_show" });

      await runAdminReservationAction({
        db: db as unknown as D1Database,
        env,
        admin: OWNER,
        reservationId: RESERVATION_ID,
        action: "restore-completed",
        request: {
          idempotencyKey: "metric-2",
          expectedVersion: (corrected as { ok: true; version: number }).version
        },
        fetcher: createFetchMock(createAccessJwtFixture().jwk),
        now: () => Date.parse("2026-06-03T02:00:00.000Z")
      });

      expect(points).toEqual(["corrected_no_show", "restored_completed"]);
      // 往復させても実績カウントは動かない。
      expect(points).not.toContain("completed");
      expect(points).not.toContain("no_show");
    } finally {
      db.sqlite.close();
    }
  });

  it("allows own-store staff correction and rechecks store scope before replay", async () => {
    const db = createMigratedSqliteD1();
    try {
      const completed = await seedCompleted(db);
      const staff: AdminUser = { ...OWNER, id: "admin_correct_staff", role: "staff", staff_member_id: "staff_owner_kyoto", store_id: "kyoto" };
      insertAdminUserHelper(db, { id: staff.id, email: "staff-correct@example.com", accessSubject: staff.id, role: staff.role, staffMemberId: staff.staff_member_id });
      const request = { idempotencyKey: "correct-staff", expectedVersion: completed.version };

      const result = await runCorrection(db, "correct-no-show", request, staff);
      expect(result).toMatchObject({ ok: true, status: "no_show" });
      expect(visitRows(db)[0]).toMatchObject({ status: "voided", voided_by: staff.id });
      expect(reservationRow(db).cancellation_fee_unpaid_at).not.toBeNull();
      const before = { reservation: reservationRow(db), visits: visitRows(db), audits: auditRows(db) };

      expect(await runCorrection(db, "correct-no-show", request, staff))
        .toMatchObject({ ok: true, replayed: true, status: "no_show" });
      for (const store_id of ["osaka", null]) {
        expect(await runCorrection(db, "correct-no-show", request, { ...staff, store_id }))
          .toEqual({ ok: false, reason: "forbidden" });
      }
      expect({ reservation: reservationRow(db), visits: visitRows(db), audits: auditRows(db) }).toEqual(before);
    } finally {
      db.sqlite.close();
    }
  });

  it.each(["osaka", null])("rejects staff correction with store %s without side effects", async (store_id) => {
    const db = createMigratedSqliteD1();
    try {
      const completed = await seedCompleted(db);
      const before = { reservation: reservationRow(db), visits: visitRows(db), audits: auditRows(db) };
      const result = await runCorrection(db, "correct-no-show", {
        idempotencyKey: "correct-forbidden-staff", expectedVersion: completed.version
      }, { ...OWNER, role: "staff", store_id });
      expect(result).toEqual({ ok: false, reason: "forbidden" });
      expect({ reservation: reservationRow(db), visits: visitRows(db), audits: auditRows(db) }).toEqual(before);
      expect(db.sqlite.prepare("SELECT id FROM idempotency_keys WHERE idempotency_key = 'correct-forbidden-staff'").get()).toBeUndefined();
    } finally {
      db.sqlite.close();
    }
  });
});
