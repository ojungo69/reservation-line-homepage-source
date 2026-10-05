import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import { createAccessJwksFetchMock, createAccessJwtFixture, insertAdminUser as insertAdminUserHelper, type AdminRole } from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const TEAM_DOMAIN = "https://team.example.cloudflareaccess.com";
const ACCESS_AUD = "admin-settings-window-aud";
const ADMIN_EMAIL = "owner@example.com";
const ADMIN_ACCESS_SUBJECT = "access-subject-admin-settings-window";
const ACCESS_KEY_ID = "admin-settings-window-key-1";


const createAccessJwt = () =>
  createAccessJwtFixture({
    issuer: TEAM_DOMAIN,
    audience: ACCESS_AUD,
    keyId: ACCESS_KEY_ID,
    claims: { email: ADMIN_EMAIL, sub: ADMIN_ACCESS_SUBJECT }
  });

const insertAdminUser = (db: SqliteD1Database, role: AdminRole = "owner") =>
  insertAdminUserHelper(db, {
    id: "admin_settings_window_1",
    email: ADMIN_EMAIL,
    accessSubject: ADMIN_ACCESS_SUBJECT,
    role,
    updatedAt: "2026-05-19T00:00:00.000Z",
  });

const seedStore = (db: SqliteD1Database, id = "store_test") => {
  db.sqlite.prepare(`INSERT INTO stores (id, name, timezone) VALUES (?, ?, 'Asia/Tokyo')`).run(id, `Store ${id}`);
};

const seedStoreSettings = (db: SqliteD1Database, storeId: string, windowDays = 30) => {
  db.sqlite
    .prepare(
      `INSERT INTO store_settings (
         store_id, reservation_approval_mode, google_controlled_edit_mode,
         booking_window_days, created_at, updated_at
       ) VALUES (?, 'existing_customer_auto', 0, ?, '2026-05-19T00:00:00.000Z', '2026-05-19T00:00:00.000Z')`
    )
    .run(storeId, windowDays);
};

const baseEnv = (db: SqliteD1Database): Record<string, unknown> => ({
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  ACCESS_AUD,
  DB: db
});

const putWindow = (db: SqliteD1Database, token: string | null, body?: Record<string, unknown>) => {
  const app = createApp();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Cf-Access-Jwt-Assertion"] = token;
  return app.request(
    "/api/admin/settings/booking-window",
    { method: "PUT", headers, body: body ? JSON.stringify(body) : undefined },
    baseEnv(db)
  );
};

const readJson = async (response: Response) => response.json() as Promise<Record<string, unknown>>;

describe("admin settings — booking window endpoint (PUT /api/admin/settings/booking-window)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("updates an existing store_settings row and writes before/after audit (200)", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db, "store_test");
      seedStoreSettings(db, "store_test", 30);
      const access = createAccessJwt();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const response = await putWindow(db, access.token, {
        storeId: "store_test",
        bookingWindowDays: 14
      });

      expect(response.status).toBe(200);
      expect(await readJson(response)).toMatchObject({
        ok: true,
        storeId: "store_test",
        bookingWindowDays: 14
      });

      const row = db.sqlite
        .prepare(
          "SELECT booking_window_days AS days, reservation_approval_mode AS mode FROM store_settings WHERE store_id = ?"
        )
        .get("store_test") as { days: number; mode: string };
      expect(row.days).toBe(14);
      expect(row.mode).toBe("existing_customer_auto"); // UPSERT must not clobber siblings.

      const audit = db.sqlite
        .prepare("SELECT target_id, metadata_json FROM audit_logs WHERE action = 'settings.booking_window.update'")
        .get() as { target_id: string; metadata_json: string };
      expect(audit.target_id).toBe("store_test");
      expect(JSON.parse(audit.metadata_json)).toMatchObject({
        before: { bookingWindowDays: 30 },
        after: { bookingWindowDays: 14 },
        adminRole: "owner"
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("UPSERTs when no store_settings row exists yet, taking sibling defaults (200)", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db, "store_test"); // no seedStoreSettings
      const access = createAccessJwt();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const response = await putWindow(db, access.token, {
        storeId: "store_test",
        bookingWindowDays: 60
      });

      expect(response.status).toBe(200);
      const row = db.sqlite
        .prepare(
          "SELECT booking_window_days AS days, reservation_approval_mode AS mode, max_active_reservations_per_customer AS cap FROM store_settings WHERE store_id = ?"
        )
        .get("store_test") as { days: number; mode: string; cap: number };
      expect(row.days).toBe(60);
      expect(row.mode).toBe("existing_customer_auto");
      expect(row.cap).toBe(1); // new store_settings rows use the application default.

      // Audit `before` reflects the EFFECTIVE prior window (default 30), not null,
      // even though no store_settings row existed beforehand.
      const audit = db.sqlite
        .prepare("SELECT metadata_json FROM audit_logs WHERE action = 'settings.booking_window.update'")
        .get() as { metadata_json: string };
      expect(JSON.parse(audit.metadata_json)).toMatchObject({
        before: { bookingWindowDays: 30 },
        after: { bookingWindowDays: 60 }
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("accepts the boundary values 1 and 90 (200)", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db, "store_test");
      const access = createAccessJwt();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const lower = await putWindow(db, access.token, { storeId: "store_test", bookingWindowDays: 1 });
      expect(lower.status).toBe(200);
      const upper = await putWindow(db, access.token, { storeId: "store_test", bookingWindowDays: 90 });
      expect(upper.status).toBe(200);
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 403 forbidden when caller has staff role", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "staff");
      seedStore(db, "store_test");
      seedStoreSettings(db, "store_test", 30);
      const access = createAccessJwt();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const response = await putWindow(db, access.token, { storeId: "store_test", bookingWindowDays: 45 });
      expect(response.status).toBe(403);
      // The staff-forbidden request must not mutate the window.
      const row = db.sqlite
        .prepare("SELECT booking_window_days AS days FROM store_settings WHERE store_id = ?")
        .get("store_test") as { days: number };
      expect(row.days).toBe(30);
    } finally {
      db.sqlite.close();
    }
  });

  it("system_admin role succeeds (privileged parity with owner)", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "system_admin");
      seedStore(db, "store_test");
      const access = createAccessJwt();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const response = await putWindow(db, access.token, { storeId: "store_test", bookingWindowDays: 7 });
      expect(response.status).toBe(200);
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 404 store_not_found for a missing store", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      const access = createAccessJwt();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const response = await putWindow(db, access.token, { storeId: "nope", bookingWindowDays: 30 });
      expect(response.status).toBe(404);
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 400 invalid_request for out-of-range, fractional, or missing window values", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db, "store_test");
      const access = createAccessJwt();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      for (const bad of [0, 91, -1, 2.5]) {
        const r = await putWindow(db, access.token, { storeId: "store_test", bookingWindowDays: bad });
        expect(r.status, `window=${bad}`).toBe(400);
      }
      // Missing key must not silently default.
      const missing = await putWindow(db, access.token, { storeId: "store_test" });
      expect(missing.status).toBe(400);
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 403 when no Cf-Access-Jwt-Assertion header is supplied", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db, "store_test");
      const access = createAccessJwt();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const response = await putWindow(db, null, { storeId: "store_test", bookingWindowDays: 30 });
      expect(response.status).toBe(403);
    } finally {
      db.sqlite.close();
    }
  });
});
