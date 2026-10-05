import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/sentry-helpers", () => ({
  captureBatchWriteFailure: vi.fn(),
  safeCaptureException: vi.fn()
}));

import { createApp } from "../src/app";
import { createAccessJwksFetchMock, createAccessJwtFixture, type AccessJwk, insertAdminUser as insertAdminUserHelper, type AdminRole } from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const TEAM_DOMAIN = "https://team.example.cloudflareaccess.com";
const ACCESS_AUD = "admin-access-aud";
const KID = "auto-complete-endpoint-key-1";

const OWNER_EMAIL = "owner@example.com";
const OWNER_SUBJECT = "access-subject-owner-auto-complete";
const STAFF_EMAIL = "staff@example.com";
const STAFF_SUBJECT = "access-subject-staff-auto-complete";

// A fixed "now" in the future of the seeded reservations so their end_at is in the
// past relative to the endpoint's graceMs=0 cutoff.
const NOW_ISO = "2026-06-15T00:00:00.000Z";
const PAST_START = "2026-06-10T01:00:00.000Z";
const PAST_END = "2026-06-10T02:00:00.000Z";

const createAccessJwt = (email: string, subject: string) =>
  createAccessJwtFixture({
    issuer: TEAM_DOMAIN,
    audience: ACCESS_AUD,
    keyId: KID,
    claims: { email, sub: subject }
  });

const createFetchMock = (jwk: AccessJwk) => createAccessJwksFetchMock(TEAM_DOMAIN, jwk);

const insertAdminUser = (
  db: SqliteD1Database,
  id: string,
  email: string,
  subject: string,
  role: AdminRole
) =>
  insertAdminUserHelper(db, {
    id,
    email,
    accessSubject: subject,
    role,
    updatedAt: "2026-05-09T00:00:00.000Z",
  });

const linkStaff = (db: SqliteD1Database, adminUserId: string, storeId: string) => {
  db.sqlite
    .prepare(
      `INSERT INTO staff_members (id, store_id, display_name, role, active, updated_at)
       VALUES (?, ?, '担当 太郎', 'staff', 1, '2026-05-09T00:00:00.000Z')`
    )
    .run(`staff_member_${adminUserId}`, storeId);
  db.sqlite
    .prepare(`UPDATE admin_users SET staff_member_id = ? WHERE id = ?`)
    .run(`staff_member_${adminUserId}`, adminUserId);
};

const insertPastConfirmedReservation = (db: SqliteD1Database, id: string) => {
  db.sqlite
    .prepare(
      `INSERT INTO customers (id, display_name, display_name_kana, phone_normalized, phone_hash, block_status, updated_at)
       VALUES (?, '過去 顧客', 'カコ コキャク', ?, ?, 'active', '2026-05-09T00:00:00.000Z')`
    )
    .run(`cust_${id}`, `090000${id.slice(-4)}`, `phone_hash_${id}`);
  db.sqlite
    .prepare(
      `INSERT INTO reservations (
        id, store_id, service_id, customer_id, resource_id, line_identity_id,
        source, status, start_at, end_at, duration_minutes, pending_expires_at,
        created_by, updated_by, idempotency_key, google_sync_state, version, updated_at
      ) VALUES (
        ?, 'kyoto', 'service_kyoto_default_60', ?, 'resource_kyoto_calendar', NULL,
        'phone_admin', 'confirmed', ?, ?, 60, NULL,
        'fixture', 'fixture', ?, 'pending', 1, '2026-05-09T00:00:00.000Z'
      )`
    )
    .run(id, `cust_${id}`, PAST_START, PAST_END, `idem_${id}`);
};

const baseEnv = (db: SqliteD1Database | D1Database): Record<string, unknown> => ({
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  ACCESS_AUD,
  DB: db
});

const postAutoComplete = (db: SqliteD1Database | D1Database, token: string) =>
  createApp().request(
    "/api/admin/reservations/auto-complete-overdue",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cf-Access-Jwt-Assertion": token
      }
    },
    baseEnv(db)
  );

const readStatus = (db: SqliteD1Database, id: string) =>
  db.sqlite.prepare(`SELECT status FROM reservations WHERE id = ?`).get(id) as
    | { status: string }
    | undefined;

const countVisits = (db: SqliteD1Database, reservationId: string) =>
  (db.sqlite
    .prepare(`SELECT COUNT(*) AS n FROM customer_visits WHERE reservation_id = ?`)
    .get(reservationId) as { n: number }).n;

describe("POST /api/admin/reservations/auto-complete-overdue", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date(NOW_ISO), toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("owner triggers the backfill: past confirmed reservations become completed with a visit row", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwt(OWNER_EMAIL, OWNER_SUBJECT);
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    insertAdminUser(db, "admin_owner_1", OWNER_EMAIL, OWNER_SUBJECT, "owner");
    insertPastConfirmedReservation(db, "rsv_past_1");
    insertPastConfirmedReservation(db, "rsv_past_2");

    const res = await postAutoComplete(db, access.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; completedCount?: number };
    expect(body.ok).toBe(true);
    expect(body.completedCount).toBe(2);

    expect(readStatus(db, "rsv_past_1")?.status).toBe("completed");
    expect(readStatus(db, "rsv_past_2")?.status).toBe("completed");
    expect(countVisits(db, "rsv_past_1")).toBe(1);
    expect(countVisits(db, "rsv_past_2")).toBe(1);
  });

  it("is idempotent: a second run completes nothing more", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwt(OWNER_EMAIL, OWNER_SUBJECT);
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    insertAdminUser(db, "admin_owner_1", OWNER_EMAIL, OWNER_SUBJECT, "owner");
    insertPastConfirmedReservation(db, "rsv_past_1");

    const first = (await (await postAutoComplete(db, access.token)).json()) as {
      completedCount: number;
    };
    expect(first.completedCount).toBe(1);
    const second = (await (await postAutoComplete(db, access.token)).json()) as {
      completedCount: number;
    };
    expect(second.completedCount).toBe(0);
    expect(countVisits(db, "rsv_past_1")).toBe(1);
  });

  it("returns 503 when the sweep hits a retryable D1 internal error", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwt(OWNER_EMAIL, OWNER_SUBJECT);
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "admin_owner_1", OWNER_EMAIL, OWNER_SUBJECT, "owner");
      const failingDb = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === "prepare") {
            return (sql: string) => {
              if (sql.includes("WHERE status = 'confirmed' AND end_at <= ?")) {
                throw new Error("D1_ERROR: internal error; reference = x");
              }
              return target.prepare(sql);
            };
          }
          return Reflect.get(target, prop, receiver);
        }
      }) as unknown as D1Database;

      const response = await postAutoComplete(failingDb, access.token);

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "transient_d1"
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("forbids staff (owner-only): reservation stays confirmed", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwt(STAFF_EMAIL, STAFF_SUBJECT);
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    insertAdminUser(db, "admin_staff_1", STAFF_EMAIL, STAFF_SUBJECT, "staff");
    linkStaff(db, "admin_staff_1", "kyoto");
    insertPastConfirmedReservation(db, "rsv_past_1");

    const res = await postAutoComplete(db, access.token);
    expect(res.status).toBe(403);
    expect(readStatus(db, "rsv_past_1")?.status).toBe("confirmed");
    expect(countVisits(db, "rsv_past_1")).toBe(0);
  });

  it("creates a visit for an archived customer", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwt(OWNER_EMAIL, OWNER_SUBJECT);
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "admin_owner_1", OWNER_EMAIL, OWNER_SUBJECT, "owner");
      insertPastConfirmedReservation(db, "rsv_archived");
      db.sqlite
        .prepare("UPDATE customers SET archived_at = ? WHERE id = ?")
        .run("2026-06-08T00:00:00.000Z", "cust_rsv_archived");

      const res = await postAutoComplete(db, access.token);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true, completedCount: 1 });
      expect(readStatus(db, "rsv_archived")?.status).toBe("completed");
      expect(countVisits(db, "rsv_archived")).toBe(1);
    } finally {
      db.sqlite.close();
    }
  });

  it("creates a visit for a merged-away customer", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwt(OWNER_EMAIL, OWNER_SUBJECT);
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "admin_owner_1", OWNER_EMAIL, OWNER_SUBJECT, "owner");
      insertPastConfirmedReservation(db, "rsv_merged");
      db.sqlite
        .prepare(
          `INSERT INTO customers (id, display_name, display_name_kana, phone_normalized, phone_hash, block_status, updated_at)
           VALUES ('customer_merge_target_http', '統合 先', 'トウゴウ サキ', '0759999999', 'phone_hash_merge_target_http', 'active', '2026-05-09T00:00:00.000Z')`
        )
        .run();
      db.sqlite
        .prepare("UPDATE customers SET merged_into_id = ? WHERE id = ?")
        .run("customer_merge_target_http", "cust_rsv_merged");

      const res = await postAutoComplete(db, access.token);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true, completedCount: 1 });
      expect(readStatus(db, "rsv_merged")?.status).toBe("completed");
      expect(countVisits(db, "rsv_merged")).toBe(1);
    } finally {
      db.sqlite.close();
    }
  });
});
