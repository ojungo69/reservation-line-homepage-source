import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import { createAccessJwksFetchMock, createAccessJwtFixture, insertAdminUser as insertAdminUserHelper, type AdminRole } from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const TEAM_DOMAIN = "https://team.example.cloudflareaccess.com";
const ACCESS_AUD = "admin-settings-reminder-aud";
const ADMIN_EMAIL = "owner@example.com";
const ADMIN_ACCESS_SUBJECT = "access-subject-admin-settings-reminder";
const ACCESS_KEY_ID = "admin-settings-reminder-key-1";


const createAdminAccessFixture = () =>
  createAccessJwtFixture({
    issuer: TEAM_DOMAIN,
    audience: ACCESS_AUD,
    keyId: ACCESS_KEY_ID,
    claims: { email: ADMIN_EMAIL, sub: ADMIN_ACCESS_SUBJECT }
  });

const insertAdminUser = (db: SqliteD1Database, role: AdminRole = "owner") =>
  insertAdminUserHelper(db, {
    id: "admin_settings_reminder_1",
    email: ADMIN_EMAIL,
    accessSubject: ADMIN_ACCESS_SUBJECT,
    role,
    updatedAt: "2026-05-19T00:00:00.000Z",
  });

const seedStore = (db: SqliteD1Database, id = "store_test") => {
  db.sqlite
    .prepare(`INSERT INTO stores (id, name, timezone) VALUES (?, ?, 'Asia/Tokyo')`)
    .run(id, `Store ${id}`);
};

const seedStoreSettings = (
  db: SqliteD1Database,
  input: { storeId: string; offsetMinutes?: number | null }
) => {
  db.sqlite
    .prepare(
      `INSERT INTO store_settings (
         store_id, reservation_approval_mode, google_controlled_edit_mode,
         reservation_reminder_offset_minutes, created_at, updated_at
       ) VALUES (?, 'existing_customer_auto', 0, ?, '2026-05-19T00:00:00.000Z', '2026-05-19T00:00:00.000Z')`
    )
    .run(input.storeId, input.offsetMinutes ?? null);
};

const baseEnv = (db: SqliteD1Database): Record<string, unknown> => ({
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  ACCESS_AUD,
  DB: db
});

const adminRequest = (
  db: SqliteD1Database,
  token: string | null,
  method: "PUT",
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

describe("admin settings — reminder notification endpoint", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("PUT /api/admin/settings/reminder", () => {
    it("updates an existing store_settings row and writes before/after audit (200)", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        seedStoreSettings(db, { storeId: "store_test", offsetMinutes: 30 });
        const access = createAdminAccessFixture();
        vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

        const response = await adminRequest(
          db,
          access.token,
          "PUT",
          "/api/admin/settings/reminder",
          { storeId: "store_test", offsetMinutes: 120 }
        );

        expect(response.status).toBe(200);
        const body = await readJson(response);
        expect(body).toMatchObject({ ok: true, storeId: "store_test", offsetMinutes: 120 });

        const row = db.sqlite
          .prepare(
            "SELECT reservation_reminder_offset_minutes AS offset, reservation_approval_mode AS mode FROM store_settings WHERE store_id = ?"
          )
          .get("store_test") as { offset: number; mode: string };
        expect(row.offset).toBe(120);
        // UPSERT must not clobber sibling columns.
        expect(row.mode).toBe("existing_customer_auto");

        const audit = db.sqlite
          .prepare(
            "SELECT action, target_type, target_id, metadata_json FROM audit_logs WHERE action = 'settings.reminder.update'"
          )
          .get() as { action: string; target_type: string; target_id: string; metadata_json: string };
        expect(audit).toMatchObject({
          action: "settings.reminder.update",
          target_type: "store",
          target_id: "store_test"
        });
        const meta = JSON.parse(audit.metadata_json);
        expect(meta).toMatchObject({
          storeId: "store_test",
          before: { offsetMinutes: 30 },
          after: { offsetMinutes: 120 },
          adminRole: "owner"
        });
      } finally {
        db.sqlite.close();
      }
    });

    it("UPSERTs when no store_settings row exists yet (200)", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        // Intentionally no seedStoreSettings — a freshly-bootstrapped store
        // may not have its singleton row yet.
        const access = createAdminAccessFixture();
        vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

        const response = await adminRequest(
          db,
          access.token,
          "PUT",
          "/api/admin/settings/reminder",
          { storeId: "store_test", offsetMinutes: 60 }
        );

        expect(response.status).toBe(200);
        const row = db.sqlite
          .prepare(
            "SELECT reservation_reminder_offset_minutes AS offset, reservation_approval_mode AS mode, max_active_reservations_per_customer AS cap FROM store_settings WHERE store_id = ?"
          )
          .get("store_test") as { offset: number; mode: string; cap: number };
        expect(row.offset).toBe(60);
        // Sibling columns must take their effective defaults on UPSERT-insert.
        expect(row.mode).toBe("existing_customer_auto");
        expect(row.cap).toBe(1);

        const audit = db.sqlite
          .prepare(
            "SELECT metadata_json FROM audit_logs WHERE action = 'settings.reminder.update'"
          )
          .get() as { metadata_json: string };
        expect(JSON.parse(audit.metadata_json)).toMatchObject({
          before: { offsetMinutes: null },
          after: { offsetMinutes: 60 }
        });
      } finally {
        db.sqlite.close();
      }
    });

    it("clears the offset back to null when payload sends offsetMinutes: null (200)", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        seedStoreSettings(db, { storeId: "store_test", offsetMinutes: 90 });
        const access = createAdminAccessFixture();
        vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

        const response = await adminRequest(
          db,
          access.token,
          "PUT",
          "/api/admin/settings/reminder",
          { storeId: "store_test", offsetMinutes: null }
        );

        expect(response.status).toBe(200);
        const body = await readJson(response);
        expect(body).toMatchObject({ ok: true, storeId: "store_test", offsetMinutes: null });

        const row = db.sqlite
          .prepare(
            "SELECT reservation_reminder_offset_minutes AS offset FROM store_settings WHERE store_id = ?"
          )
          .get("store_test") as { offset: number | null };
        expect(row.offset).toBeNull();
      } finally {
        db.sqlite.close();
      }
    });

    it("accepts the documented boundary values 0 and 4320 (200)", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        const access = createAdminAccessFixture();
        vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

        const lower = await adminRequest(
          db,
          access.token,
          "PUT",
          "/api/admin/settings/reminder",
          { storeId: "store_test", offsetMinutes: 0 }
        );
        expect(lower.status).toBe(200);

        const upper = await adminRequest(
          db,
          access.token,
          "PUT",
          "/api/admin/settings/reminder",
          { storeId: "store_test", offsetMinutes: 4320 }
        );
        expect(upper.status).toBe(200);

        const row = db.sqlite
          .prepare(
            "SELECT reservation_reminder_offset_minutes AS offset FROM store_settings WHERE store_id = ?"
          )
          .get("store_test") as { offset: number };
        expect(row.offset).toBe(4320);
      } finally {
        db.sqlite.close();
      }
    });

    it("returns 403 forbidden when caller has staff role", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "staff");
        seedStore(db, "store_test");
        seedStoreSettings(db, { storeId: "store_test", offsetMinutes: 30 });
        const access = createAdminAccessFixture();
        vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

        const response = await adminRequest(
          db,
          access.token,
          "PUT",
          "/api/admin/settings/reminder",
          { storeId: "store_test", offsetMinutes: 120 }
        );

        expect(response.status).toBe(403);
        await expect(readJson(response)).resolves.toMatchObject({
          ok: false,
          error: "forbidden"
        });

        // Staff caller must not produce any audit row (DB unchanged).
        const audit = db.sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'settings.reminder.update'"
          )
          .get() as { count: number };
        expect(audit.count).toBe(0);
        const row = db.sqlite
          .prepare(
            "SELECT reservation_reminder_offset_minutes AS offset FROM store_settings WHERE store_id = ?"
          )
          .get("store_test") as { offset: number };
        expect(row.offset).toBe(30);
      } finally {
        db.sqlite.close();
      }
    });

    it("system_admin role succeeds (privileged role parity with owner)", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "system_admin");
        seedStore(db, "store_test");
        const access = createAdminAccessFixture();
        vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

        const response = await adminRequest(
          db,
          access.token,
          "PUT",
          "/api/admin/settings/reminder",
          { storeId: "store_test", offsetMinutes: 45 }
        );

        expect(response.status).toBe(200);
        const audit = db.sqlite
          .prepare(
            "SELECT metadata_json FROM audit_logs WHERE action = 'settings.reminder.update'"
          )
          .get() as { metadata_json: string };
        expect(JSON.parse(audit.metadata_json)).toMatchObject({
          adminRole: "system_admin",
          after: { offsetMinutes: 45 }
        });
      } finally {
        db.sqlite.close();
      }
    });

    it("returns 404 store_not_found when storeId references a missing store", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        const access = createAdminAccessFixture();
        vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

        const response = await adminRequest(
          db,
          access.token,
          "PUT",
          "/api/admin/settings/reminder",
          { storeId: "store_does_not_exist", offsetMinutes: 30 }
        );

        expect(response.status).toBe(404);
        await expect(readJson(response)).resolves.toMatchObject({
          ok: false,
          error: "store_not_found"
        });
      } finally {
        db.sqlite.close();
      }
    });

    it("returns 400 invalid_request for negative offset", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        const access = createAdminAccessFixture();
        vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

        const response = await adminRequest(
          db,
          access.token,
          "PUT",
          "/api/admin/settings/reminder",
          { storeId: "store_test", offsetMinutes: -1 }
        );

        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toMatchObject({
          ok: false,
          error: "invalid_request"
        });
      } finally {
        db.sqlite.close();
      }
    });

    it("returns 400 invalid_request for non-integer (fractional) offset", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        const access = createAdminAccessFixture();
        vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

        const response = await adminRequest(
          db,
          access.token,
          "PUT",
          "/api/admin/settings/reminder",
          { storeId: "store_test", offsetMinutes: 30.5 }
        );

        expect(response.status).toBe(400);
      } finally {
        db.sqlite.close();
      }
    });

    it("returns 400 invalid_request when offset exceeds the 4320-minute (72h) maximum", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        const access = createAdminAccessFixture();
        vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

        const response = await adminRequest(
          db,
          access.token,
          "PUT",
          "/api/admin/settings/reminder",
          { storeId: "store_test", offsetMinutes: 4321 }
        );

        expect(response.status).toBe(400);
      } finally {
        db.sqlite.close();
      }
    });

    it("returns 400 invalid_request when offsetMinutes key is missing from the body", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        const access = createAdminAccessFixture();
        vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

        const response = await adminRequest(
          db,
          access.token,
          "PUT",
          "/api/admin/settings/reminder",
          { storeId: "store_test" }
        );

        expect(response.status).toBe(400);
      } finally {
        db.sqlite.close();
      }
    });

    it("returns 400 invalid_request when storeId is missing or blank", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");
        const access = createAdminAccessFixture();
        vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

        const response = await adminRequest(
          db,
          access.token,
          "PUT",
          "/api/admin/settings/reminder",
          { storeId: "  ", offsetMinutes: 30 }
        );

        expect(response.status).toBe(400);
      } finally {
        db.sqlite.close();
      }
    });

    it("returns 403 when no Cf-Access-Jwt-Assertion header is supplied", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, "owner");
        seedStore(db, "store_test");

        const response = await adminRequest(
          db,
          null,
          "PUT",
          "/api/admin/settings/reminder",
          { storeId: "store_test", offsetMinutes: 30 }
        );

        expect(response.status).toBe(403);
      } finally {
        db.sqlite.close();
      }
    });
  });
});
