import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import { createAccessJwksFetchMock, createAccessJwtFixture, insertAdminUser as insertAdminUserHelper, type AdminRole } from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const TEAM_DOMAIN = "https://team.example.cloudflareaccess.com";
const ACCESS_AUD = "admin-biz-hours-aud";
const ADMIN_EMAIL = "owner@example.com";
const ADMIN_ACCESS_SUBJECT = "access-subject-admin-biz-hours";
const ACCESS_KEY_ID = "admin-biz-hours-key-1";

const createBizHoursAccessFixture = () =>
  createAccessJwtFixture({
    issuer: TEAM_DOMAIN,
    audience: ACCESS_AUD,
    keyId: ACCESS_KEY_ID,
    claims: { email: ADMIN_EMAIL, sub: ADMIN_ACCESS_SUBJECT }
  });

const createFetchMock = (jwk: Parameters<typeof createAccessJwksFetchMock>[1]) =>
  createAccessJwksFetchMock(TEAM_DOMAIN, jwk);

const insertAdminUser = (db: SqliteD1Database, role: AdminRole = "owner") =>
  insertAdminUserHelper(db, {
    id: "admin_biz_hours_1",
    email: ADMIN_EMAIL,
    accessSubject: ADMIN_ACCESS_SUBJECT,
    role,
    updatedAt: "2026-05-19T00:00:00.000Z",
  });

// staff の store スコープは admin_users.staff_member_id → staff_members.store_id
// の JOIN で決まる (src/admin/access.ts)。店舗に紐付いた staff アカウントを作る。
const insertStaffAdminLinkedToStore = (db: SqliteD1Database, storeId: string) => {
  db.sqlite
    .prepare(
      `INSERT INTO staff_members (id, store_id, display_name, role, active, created_at, updated_at)
       VALUES ('sm_biz_hours_1', ?, 'テストスタッフ', 'staff', 1, '2026-05-19T00:00:00.000Z', '2026-05-19T00:00:00.000Z')`
    )
    .run(storeId);
  db.sqlite
    .prepare(
      `INSERT INTO admin_users (id, email, access_subject, role, active, staff_member_id, updated_at)
       VALUES ('admin_biz_hours_1', ?, ?, 'staff', 1, 'sm_biz_hours_1', '2026-05-19T00:00:00.000Z')`
    )
    .run(ADMIN_EMAIL, ADMIN_ACCESS_SUBJECT);
};

const seedStore = (db: SqliteD1Database, id = "store_test") => {
  db.sqlite
    .prepare(`INSERT INTO stores (id, name, timezone) VALUES (?, ?, 'Asia/Tokyo')`)
    .run(id, `Store ${id}`);
};

const baseEnv = (db: SqliteD1Database): Record<string, unknown> => ({
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  ACCESS_AUD,
  DB: db
});

const adminRequest = (
  db: SqliteD1Database,
  token: string | null,
  method: "GET" | "PUT",
  path: string,
  body?: Record<string, unknown>
) => {
  const app = createApp();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Cf-Access-Jwt-Assertion"] = token;
  return app.request(
    path,
    { method, headers, body: body ? JSON.stringify(body) : undefined },
    baseEnv(db)
  );
};

const readJson = async (response: Response) => response.json() as Promise<Record<string, unknown>>;

const defaultHours = [
  { weekday: 0, opensAt: "10:00", closesAt: "19:00", closed: false },
  { weekday: 1, opensAt: "10:00", closesAt: "19:00", closed: false },
  { weekday: 2, opensAt: "10:00", closesAt: "19:00", closed: false },
  { weekday: 3, opensAt: "10:00", closesAt: "19:00", closed: true },
  { weekday: 4, opensAt: "10:00", closesAt: "19:00", closed: false },
  { weekday: 5, opensAt: "10:00", closesAt: "19:00", closed: false },
  { weekday: 6, opensAt: "09:00", closesAt: "18:00", closed: false }
];

describe("admin settings — business hours endpoints", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("GET returns 7 weekday rows with defaults when none seeded", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db);
      const access = createBizHoursAccessFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(
        db,
        access.token,
        "GET",
        "/api/admin/settings/business-hours/store_test"
      );
      expect(response.status).toBe(200);
      const body = await readJson(response);
      expect(body.ok).toBe(true);
      const hours = body.businessHours as Array<Record<string, unknown>>;
      expect(hours).toHaveLength(7);
      // Default values for all weekdays
      for (let i = 0; i < 7; i++) {
        expect(hours[i]).toMatchObject({
          weekday: i,
          opensAt: "10:00",
          closesAt: "19:00",
          closed: false
        });
      }
    } finally {
      db.sqlite.close();
    }
  });

  it("GET returns 401 without auth", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedStore(db);

      const response = await adminRequest(
        db,
        null,
        "GET",
        "/api/admin/settings/business-hours/store_test"
      );
      expect(response.status).toBe(403);
      const body = await readJson(response);
      expect(body.ok).toBe(false);
    } finally {
      db.sqlite.close();
    }
  });

  it("PUT upserts all 7 rows with Wednesday closed", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db);
      const access = createBizHoursAccessFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const putResponse = await adminRequest(
        db,
        access.token,
        "PUT",
        "/api/admin/settings/business-hours/store_test",
        { hours: defaultHours }
      );
      expect(putResponse.status).toBe(200);
      const putBody = await readJson(putResponse);
      expect(putBody).toMatchObject({ ok: true });

      // Verify DB state
      const rows = db.sqlite
        .prepare(
          "SELECT weekday, opens_at, closes_at, active FROM store_business_hours WHERE store_id = ? ORDER BY weekday"
        )
        .all("store_test") as Array<{ weekday: number; opens_at: string; closes_at: string; active: number }>;
      expect(rows).toHaveLength(7);
      // Wednesday (weekday 3) should be closed (active=0)
      const wednesday = rows.find((r) => r.weekday === 3);
      expect(wednesday).toMatchObject({ active: 0, opens_at: "10:00", closes_at: "19:00" });
      // Monday (weekday 1) should be open (active=1)
      const monday = rows.find((r) => r.weekday === 1);
      expect(monday).toMatchObject({ active: 1, opens_at: "10:00", closes_at: "19:00" });
      // Saturday (weekday 6) should have custom hours
      const saturday = rows.find((r) => r.weekday === 6);
      expect(saturday).toMatchObject({ active: 1, opens_at: "09:00", closes_at: "18:00" });

      // GET should reflect the saved state
      const getResponse = await adminRequest(
        db,
        access.token,
        "GET",
        "/api/admin/settings/business-hours/store_test"
      );
      expect(getResponse.status).toBe(200);
      const getBody = await readJson(getResponse);
      expect(getBody.ok).toBe(true);
      const getHours = getBody.businessHours as Array<Record<string, unknown>>;
      expect(getHours).toHaveLength(7);
      const getWed = getHours.find((h) => h.weekday === 3);
      expect(getWed).toMatchObject({ closed: true });
    } finally {
      db.sqlite.close();
    }
  });

  it("PUT returns 403 for staff with no store link", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "staff");
      seedStore(db);
      const access = createBizHoursAccessFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(
        db,
        access.token,
        "PUT",
        "/api/admin/settings/business-hours/store_test",
        { hours: defaultHours }
      );
      expect(response.status).toBe(403);
      const body = await readJson(response);
      expect(body).toMatchObject({ ok: false, error: "forbidden" });
    } finally {
      db.sqlite.close();
    }
  });

  it("PUT succeeds for staff of the same store", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedStore(db);
      insertStaffAdminLinkedToStore(db, "store_test");
      const access = createBizHoursAccessFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(
        db,
        access.token,
        "PUT",
        "/api/admin/settings/business-hours/store_test",
        { hours: defaultHours }
      );
      expect(response.status).toBe(200);
      const rows = db.sqlite
        .prepare("SELECT COUNT(*) AS count FROM store_business_hours WHERE store_id = 'store_test'")
        .get() as { count: number };
      expect(rows.count).toBe(7);
      // 監査ログは before/after と実行者ロールを持つ (staff の変更を後から復元できる)。
      const audit = db.sqlite
        .prepare("SELECT metadata_json FROM audit_logs WHERE action = 'business_hours.update'")
        .get() as { metadata_json: string };
      const metadata = JSON.parse(audit.metadata_json);
      expect(metadata.adminRole).toBe("staff");
      expect(metadata.after).toHaveLength(7);
      expect(metadata.before).toHaveLength(7);
    } finally {
      db.sqlite.close();
    }
  });

  it("PUT returns 403 for staff of a different store", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedStore(db);
      seedStore(db, "store_other");
      insertStaffAdminLinkedToStore(db, "store_other");
      const access = createBizHoursAccessFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(
        db,
        access.token,
        "PUT",
        "/api/admin/settings/business-hours/store_test",
        { hours: defaultHours }
      );
      expect(response.status).toBe(403);
      const body = await readJson(response);
      expect(body).toMatchObject({ ok: false, error: "forbidden" });
    } finally {
      db.sqlite.close();
    }
  });

  it("PUT returns 400 for invalid payload (not 7 rows)", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db);
      const access = createBizHoursAccessFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      // Only 3 rows instead of 7
      const response = await adminRequest(
        db,
        access.token,
        "PUT",
        "/api/admin/settings/business-hours/store_test",
        {
          hours: [
            { weekday: 0, opensAt: "10:00", closesAt: "19:00", closed: false },
            { weekday: 1, opensAt: "10:00", closesAt: "19:00", closed: false },
            { weekday: 2, opensAt: "10:00", closesAt: "19:00", closed: false }
          ]
        }
      );
      expect(response.status).toBe(400);
      const body = await readJson(response);
      expect(body).toMatchObject({ ok: false, error: "invalid_request" });
    } finally {
      db.sqlite.close();
    }
  });
});
