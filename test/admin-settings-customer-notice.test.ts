import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import { createAccessJwksFetchMock, createAccessJwtFixture, insertAdminUser as insertAdminUserHelper, type AdminRole } from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const TEAM_DOMAIN = "https://team.example.cloudflareaccess.com";
const ACCESS_AUD = "admin-settings-notice-aud";
const ADMIN_EMAIL = "owner@example.com";
const ADMIN_ACCESS_SUBJECT = "access-subject-admin-settings-notice";
const KEY_ID = "admin-settings-notice-key-1";


const createNoticeAccessFixture = () =>
  createAccessJwtFixture({
    issuer: TEAM_DOMAIN,
    audience: ACCESS_AUD,
    keyId: KEY_ID,
    claims: { email: ADMIN_EMAIL, sub: ADMIN_ACCESS_SUBJECT }
  });


const insertAdminUser = (db: SqliteD1Database, role: AdminRole = "owner") =>
  insertAdminUserHelper(db, {
    id: "admin_settings_notice_1",
    email: ADMIN_EMAIL,
    accessSubject: ADMIN_ACCESS_SUBJECT,
    role,
    updatedAt: "2026-05-19T00:00:00.000Z",
  });

const seedStore = (db: SqliteD1Database, id = "store_test") => {
  db.sqlite.prepare(`INSERT INTO stores (id, name, timezone) VALUES (?, ?, 'Asia/Tokyo')`).run(id, `Store ${id}`);
};

const seedStoreSettings = (db: SqliteD1Database, storeId: string, notice: string | null = null) => {
  db.sqlite
    .prepare(
      `INSERT INTO store_settings (
         store_id, reservation_approval_mode, google_controlled_edit_mode,
         customer_notice, created_at, updated_at
       ) VALUES (?, 'existing_customer_auto', 0, ?, '2026-05-19T00:00:00.000Z', '2026-05-19T00:00:00.000Z')`
    )
    .run(storeId, notice);
};

const baseEnv = (db: SqliteD1Database): Record<string, unknown> => ({
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  ACCESS_AUD,
  DB: db
});

const putNotice = (db: SqliteD1Database, token: string | null, body?: Record<string, unknown>) => {
  const app = createApp();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Cf-Access-Jwt-Assertion"] = token;
  return app.request(
    "/api/admin/settings/customer-notice",
    { method: "PUT", headers, body: body ? JSON.stringify(body) : undefined },
    baseEnv(db)
  );
};

const readJson = async (response: Response) => response.json() as Promise<Record<string, unknown>>;

const readNotice = (db: SqliteD1Database, storeId: string): string | null => {
  const row = db.sqlite
    .prepare("SELECT customer_notice AS notice FROM store_settings WHERE store_id = ?")
    .get(storeId) as { notice: string | null } | undefined;
  return row?.notice ?? null;
};

describe("admin settings — customer notice endpoint (PUT /api/admin/settings/customer-notice)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("owner sets a notice, persists it, and writes before/after audit (200)", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db, "store_test");
      seedStoreSettings(db, "store_test", null);
      const access = createNoticeAccessFixture();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const response = await putNotice(db, access.token, {
        storeId: "store_test",
        customerNotice: "  水曜・土曜はメンズデーとなっております。  "
      });

      expect(response.status).toBe(200);
      expect(await readJson(response)).toMatchObject({
        ok: true,
        storeId: "store_test",
        customerNotice: "水曜・土曜はメンズデーとなっております。"
      });

      // Trimmed on the way in, siblings untouched.
      const row = db.sqlite
        .prepare("SELECT customer_notice AS notice, reservation_approval_mode AS mode FROM store_settings WHERE store_id = ?")
        .get("store_test") as { notice: string; mode: string };
      expect(row.notice).toBe("水曜・土曜はメンズデーとなっております。");
      expect(row.mode).toBe("existing_customer_auto");

      const audit = db.sqlite
        .prepare("SELECT target_id, metadata_json FROM audit_logs WHERE action = 'settings.customer_notice.update'")
        .get() as { target_id: string; metadata_json: string };
      expect(audit.target_id).toBe("store_test");
      // Exhaustive equality: the audit metadata must never grow extra
      // (potentially sensitive) keys unnoticed.
      expect(JSON.parse(audit.metadata_json)).toEqual({
        storeId: "store_test",
        before: { customerNotice: null },
        after: { customerNotice: "水曜・土曜はメンズデーとなっております。" },
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
      const access = createNoticeAccessFixture();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const response = await putNotice(db, access.token, {
        storeId: "store_test",
        customerNotice: "初回行のお知らせです。"
      });

      expect(response.status).toBe(200);
      const row = db.sqlite
        .prepare(
          "SELECT customer_notice AS notice, reservation_approval_mode AS mode, booking_window_days AS days, max_active_reservations_per_customer AS cap FROM store_settings WHERE store_id = ?"
        )
        .get("store_test") as { notice: string; mode: string; days: number; cap: number };
      expect(row.notice).toBe("初回行のお知らせです。");
      // Sibling columns keep their effective application defaults on first insert.
      expect(row.mode).toBe("existing_customer_auto");
      expect(row.days).toBe(30);
      expect(row.cap).toBe(1);

      // No row existed, so the audit `before` is null (no notice was in force).
      const audit = db.sqlite
        .prepare("SELECT metadata_json FROM audit_logs WHERE action = 'settings.customer_notice.update'")
        .get() as { metadata_json: string };
      expect(JSON.parse(audit.metadata_json)).toEqual({
        storeId: "store_test",
        before: { customerNotice: null },
        after: { customerNotice: "初回行のお知らせです。" },
        adminRole: "owner"
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects an unauthenticated request (403, requireAdminContext) and does not mutate", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db, "store_test");
      seedStoreSettings(db, "store_test", "既存のお知らせ");

      const response = await putNotice(db, null, { storeId: "store_test", customerNotice: "変更" });
      expect(response.status).toBe(403);
      expect(readNotice(db, "store_test")).toBe("既存のお知らせ");
    } finally {
      db.sqlite.close();
    }
  });

  it("system_admin can set a notice (200)", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "system_admin");
      seedStore(db, "store_test");
      seedStoreSettings(db, "store_test", null);
      const access = createNoticeAccessFixture();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const response = await putNotice(db, access.token, {
        storeId: "store_test",
        customerNotice: "システム管理者からのお知らせ"
      });
      expect(response.status).toBe(200);
      expect(readNotice(db, "store_test")).toBe("システム管理者からのお知らせ");
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 403 forbidden when caller has staff role and does not mutate", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "staff");
      seedStore(db, "store_test");
      seedStoreSettings(db, "store_test", "既存のお知らせ");
      const access = createNoticeAccessFixture();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const response = await putNotice(db, access.token, { storeId: "store_test", customerNotice: "変更" });
      expect(response.status).toBe(403);
      expect(readNotice(db, "store_test")).toBe("既存のお知らせ");
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 400 invalid_request for a 501-char notice, non-string, and a missing key", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db, "store_test");
      const access = createNoticeAccessFixture();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const tooLong = await putNotice(db, access.token, {
        storeId: "store_test",
        customerNotice: "あ".repeat(501)
      });
      expect(tooLong.status).toBe(400);

      const nonString = await putNotice(db, access.token, { storeId: "store_test", customerNotice: 42 });
      expect(nonString.status).toBe(400);

      // Missing key must not silently clear the notice.
      const missing = await putNotice(db, access.token, { storeId: "store_test" });
      expect(missing.status).toBe(400);
    } finally {
      db.sqlite.close();
    }
  });

  it("stores NULL when an empty string is sent (clears via blank)", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db, "store_test");
      seedStoreSettings(db, "store_test", "消される予定のお知らせ");
      const access = createNoticeAccessFixture();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const response = await putNotice(db, access.token, { storeId: "store_test", customerNotice: "   " });
      expect(response.status).toBe(200);
      expect(await readJson(response)).toMatchObject({ ok: true, customerNotice: null });
      expect(readNotice(db, "store_test")).toBeNull();
    } finally {
      db.sqlite.close();
    }
  });

  it("clears the notice when null is sent explicitly", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db, "store_test");
      seedStoreSettings(db, "store_test", "既存のお知らせ");
      const access = createNoticeAccessFixture();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const response = await putNotice(db, access.token, { storeId: "store_test", customerNotice: null });
      expect(response.status).toBe(200);
      expect(await readJson(response)).toMatchObject({ ok: true, customerNotice: null });
      expect(readNotice(db, "store_test")).toBeNull();
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 404 store_not_found for a missing store", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      const access = createNoticeAccessFixture();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const response = await putNotice(db, access.token, { storeId: "nope", customerNotice: "x" });
      expect(response.status).toBe(404);
    } finally {
      db.sqlite.close();
    }
  });
});
