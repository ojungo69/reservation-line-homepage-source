import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import { createAccessJwtFixture, createAccessJwksFetchMock, insertAdminUser as insertAdminUserHelper, type AdminRole } from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const TEAM_DOMAIN = "https://team.example.cloudflareaccess.com";
const ACCESS_AUD = "admin-settings-google-edit-aud";
const ADMIN_EMAIL = "owner@example.com";
const ADMIN_ACCESS_SUBJECT = "access-subject-admin-settings-google-edit";
const ACCESS_KEY_ID = "admin-settings-google-edit-key-1";


const createTestAccessFixture = () =>
  createAccessJwtFixture({
    issuer: TEAM_DOMAIN,
    audience: ACCESS_AUD,
    keyId: ACCESS_KEY_ID,
    claims: { email: ADMIN_EMAIL, sub: ADMIN_ACCESS_SUBJECT }
  });

const insertAdminUser = (db: SqliteD1Database, role: AdminRole = "owner") =>
  insertAdminUserHelper(db, {
    id: "admin_google_edit_1",
    email: ADMIN_EMAIL,
    accessSubject: ADMIN_ACCESS_SUBJECT,
    role,
    updatedAt: "2026-05-27T00:00:00.000Z",
  });

const seedStore = (db: SqliteD1Database, id = "store_test") => {
  db.sqlite
    .prepare(`INSERT INTO stores (id, name, timezone) VALUES (?, ?, 'Asia/Tokyo')`)
    .run(id, `Store ${id}`);
};

const seedStoreSettings = (
  db: SqliteD1Database,
  input: { storeId: string; editMode?: number }
) => {
  db.sqlite
    .prepare(
      `INSERT INTO store_settings (
         store_id, reservation_approval_mode, google_controlled_edit_mode,
         created_at, updated_at
       ) VALUES (?, 'existing_customer_auto', ?, '2026-05-27T00:00:00.000Z', '2026-05-27T00:00:00.000Z')`
    )
    .run(input.storeId, input.editMode ?? 0);
};

const baseEnv = (db: SqliteD1Database): Record<string, unknown> => ({
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  ACCESS_AUD,
  DB: db
});

const adminRequest = (
  db: SqliteD1Database,
  token: string | null,
  body?: Record<string, unknown>
) => {
  const app = createApp();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Cf-Access-Jwt-Assertion"] = token;
  return app.request(
    "/api/admin/settings/google-edit-mode",
    { method: "PUT", headers, body: body ? JSON.stringify(body) : undefined },
    baseEnv(db)
  );
};

const readJson = async (response: Response) => response.json() as Promise<Record<string, unknown>>;

describe("admin settings — google edit mode endpoint", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("enables google_controlled_edit_mode and writes audit (200)", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db, "store_test");
      seedStoreSettings(db, { storeId: "store_test", editMode: 0 });
      const access = createTestAccessFixture();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const response = await adminRequest(db, access.token, { storeId: "store_test", enabled: true });

      expect(response.status).toBe(200);
      const body = await readJson(response);
      expect(body).toMatchObject({ ok: true, storeId: "store_test", enabled: true });

      const row = db.sqlite
        .prepare("SELECT google_controlled_edit_mode AS mode, reservation_approval_mode AS approval FROM store_settings WHERE store_id = ?")
        .get("store_test") as { mode: number; approval: string };
      expect(row.mode).toBe(1);
      expect(row.approval).toBe("existing_customer_auto");

      const audit = db.sqlite
        .prepare("SELECT action, metadata_json FROM audit_logs WHERE action = 'settings.google_edit_mode.update'")
        .get() as { action: string; metadata_json: string };
      expect(audit.action).toBe("settings.google_edit_mode.update");
      const meta = JSON.parse(audit.metadata_json);
      expect(meta.before.enabled).toBe(false);
      expect(meta.after.enabled).toBe(true);
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects staff role with 403", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "staff");
      seedStore(db, "store_test");
      seedStoreSettings(db, { storeId: "store_test" });
      const access = createTestAccessFixture();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const response = await adminRequest(db, access.token, { storeId: "store_test", enabled: true });

      expect(response.status).toBe(403);
      const body = await readJson(response);
      expect(body).toMatchObject({ ok: false, error: "forbidden" });
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 400 for invalid body", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      const access = createTestAccessFixture();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const response = await adminRequest(db, access.token, { storeId: "store_test", enabled: "yes" });

      expect(response.status).toBe(400);
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 404 for nonexistent store", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      const access = createTestAccessFixture();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const response = await adminRequest(db, access.token, { storeId: "nonexistent", enabled: true });

      expect(response.status).toBe(404);
    } finally {
      db.sqlite.close();
    }
  });

  it("UPSERT creates store_settings row if none exists", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "system_admin");
      seedStore(db, "new_store");
      const access = createTestAccessFixture();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const response = await adminRequest(db, access.token, { storeId: "new_store", enabled: true });

      expect(response.status).toBe(200);
      const row = db.sqlite
        .prepare(
          "SELECT google_controlled_edit_mode AS mode, max_active_reservations_per_customer AS cap FROM store_settings WHERE store_id = ?"
        )
        .get("new_store") as { mode: number; cap: number };
      expect(row.mode).toBe(1);
      expect(row.cap).toBe(1);
    } finally {
      db.sqlite.close();
    }
  });
});
