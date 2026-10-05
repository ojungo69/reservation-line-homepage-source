import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/sentry-helpers", () => ({
  captureBatchWriteFailure: vi.fn(),
  safeCaptureException: vi.fn()
}));

import type { AdminUser } from "../src/admin/access";
import { updateAdminReservationCapSettings } from "../src/admin/settings-reservation-cap";
import { createApp } from "../src/app";
import { captureBatchWriteFailure } from "../src/sentry-helpers";
import { createAccessJwksFetchMock, createAccessJwtFixture, insertAdminUser as insertAdminUserHelper, type AdminRole } from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const TEAM_DOMAIN = "https://team.example.cloudflareaccess.com";
const ACCESS_AUD = "admin-settings-cap-aud";
const ADMIN_EMAIL = "owner@example.com";
const ADMIN_ACCESS_SUBJECT = "access-subject-admin-settings-cap";
const ACCESS_KEY_ID = "admin-settings-cap-key-1";


const createAccessFixture = () =>
  createAccessJwtFixture({
    issuer: TEAM_DOMAIN,
    audience: ACCESS_AUD,
    keyId: ACCESS_KEY_ID,
    claims: { email: ADMIN_EMAIL, sub: ADMIN_ACCESS_SUBJECT }
  });

const insertAdminUser = (db: SqliteD1Database, role: AdminRole = "owner") =>
  insertAdminUserHelper(db, {
    id: "admin_settings_cap_1",
    email: ADMIN_EMAIL,
    accessSubject: ADMIN_ACCESS_SUBJECT,
    role,
    updatedAt: "2026-05-19T00:00:00.000Z",
  });

const seedStore = (db: SqliteD1Database, id = "store_test") => {
  db.sqlite.prepare(`INSERT INTO stores (id, name, timezone) VALUES (?, ?, 'Asia/Tokyo')`).run(id, `Store ${id}`);
};

const seedStoreSettings = (db: SqliteD1Database, storeId: string, cap = 3) => {
  db.sqlite
    .prepare(
      `INSERT INTO store_settings (
         store_id, reservation_approval_mode, google_controlled_edit_mode,
         max_active_reservations_per_customer, created_at, updated_at
       ) VALUES (?, 'existing_customer_auto', 0, ?, '2026-05-19T00:00:00.000Z', '2026-05-19T00:00:00.000Z')`
    )
    .run(storeId, cap);
};

const baseEnv = (db: SqliteD1Database): Record<string, unknown> => ({
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  ACCESS_AUD,
  DB: db
});

const putCap = (db: SqliteD1Database, token: string | null, body?: Record<string, unknown>) => {
  const app = createApp();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Cf-Access-Jwt-Assertion"] = token;
  return app.request(
    "/api/admin/settings/reservation-cap",
    { method: "PUT", headers, body: body ? JSON.stringify(body) : undefined },
    baseEnv(db)
  );
};

const readJson = async (response: Response) => response.json() as Promise<Record<string, unknown>>;

describe("updateAdminReservationCapSettings telemetry", () => {
  it("keeps the console error and captures a batch failure", async () => {
    const db = createMigratedSqliteD1();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      seedStore(db, "store_test");
      seedStoreSettings(db, "store_test", 3);
      const batchError = new Error("injected reservation cap batch failure");
      const failingDb = {
        prepare: db.prepare.bind(db),
        batch: vi.fn().mockRejectedValue(batchError)
      } as unknown as D1Database;
      const admin: AdminUser = {
        id: "admin_settings_cap_1",
        email: ADMIN_EMAIL,
        role: "owner",
        staff_member_id: null,
        store_id: null
      };

      const result = await updateAdminReservationCapSettings({
        db: failingDb,
        admin,
        request: { storeId: "store_test", maxActiveReservationsPerCustomer: 10 }
      });

      expect(result).toEqual({ ok: false, error: "write_failed" });
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(captureBatchWriteFailure).toHaveBeenCalledTimes(1);
      expect(captureBatchWriteFailure).toHaveBeenCalledWith(batchError, {
        component: "settings-reservation-cap",
        op: "batch_write_failed",
        helper: "updateAdminReservationCapSettings"
      });
    } finally {
      consoleError.mockRestore();
      db.sqlite.close();
    }
  });
});

describe("admin settings — reservation cap endpoint (PUT /api/admin/settings/reservation-cap)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("updates an existing store_settings row and writes before/after audit (200)", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db, "store_test");
      seedStoreSettings(db, "store_test", 3);
      const access = createAccessFixture();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const response = await putCap(db, access.token, {
        storeId: "store_test",
        maxActiveReservationsPerCustomer: 10
      });

      expect(response.status).toBe(200);
      expect(await readJson(response)).toMatchObject({
        ok: true,
        storeId: "store_test",
        maxActiveReservationsPerCustomer: 10
      });

      const row = db.sqlite
        .prepare(
          "SELECT max_active_reservations_per_customer AS cap, reservation_approval_mode AS mode FROM store_settings WHERE store_id = ?"
        )
        .get("store_test") as { cap: number; mode: string };
      expect(row.cap).toBe(10);
      expect(row.mode).toBe("existing_customer_auto"); // UPSERT must not clobber siblings.

      const audit = db.sqlite
        .prepare("SELECT target_id, metadata_json FROM audit_logs WHERE action = 'settings.reservation_cap.update'")
        .get() as { target_id: string; metadata_json: string };
      expect(audit.target_id).toBe("store_test");
      expect(JSON.parse(audit.metadata_json)).toMatchObject({
        before: { maxActiveReservationsPerCustomer: 3 },
        after: { maxActiveReservationsPerCustomer: 10 },
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
      const access = createAccessFixture();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const response = await putCap(db, access.token, {
        storeId: "store_test",
        maxActiveReservationsPerCustomer: 5
      });

      expect(response.status).toBe(200);
      const row = db.sqlite
        .prepare(
          "SELECT max_active_reservations_per_customer AS cap, reservation_approval_mode AS mode FROM store_settings WHERE store_id = ?"
        )
        .get("store_test") as { cap: number; mode: string };
      expect(row.cap).toBe(5);
      expect(row.mode).toBe("existing_customer_auto");

      // Audit `before` reflects the EFFECTIVE prior cap (default 1), not null,
      // even though no store_settings row existed beforehand.
      const audit = db.sqlite
        .prepare("SELECT metadata_json FROM audit_logs WHERE action = 'settings.reservation_cap.update'")
        .get() as { metadata_json: string };
      expect(JSON.parse(audit.metadata_json)).toMatchObject({
        before: { maxActiveReservationsPerCustomer: 1 },
        after: { maxActiveReservationsPerCustomer: 5 }
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("accepts the boundary values 1 and 50 (200)", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db, "store_test");
      const access = createAccessFixture();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const lower = await putCap(db, access.token, { storeId: "store_test", maxActiveReservationsPerCustomer: 1 });
      expect(lower.status).toBe(200);
      const upper = await putCap(db, access.token, { storeId: "store_test", maxActiveReservationsPerCustomer: 50 });
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
      seedStoreSettings(db, "store_test", 3);
      const access = createAccessFixture();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const response = await putCap(db, access.token, { storeId: "store_test", maxActiveReservationsPerCustomer: 9 });
      expect(response.status).toBe(403);
      // The staff-forbidden request must not mutate the cap.
      const row = db.sqlite
        .prepare("SELECT max_active_reservations_per_customer AS cap FROM store_settings WHERE store_id = ?")
        .get("store_test") as { cap: number };
      expect(row.cap).toBe(3);
    } finally {
      db.sqlite.close();
    }
  });

  it("system_admin role succeeds (privileged parity with owner)", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "system_admin");
      seedStore(db, "store_test");
      const access = createAccessFixture();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const response = await putCap(db, access.token, { storeId: "store_test", maxActiveReservationsPerCustomer: 7 });
      expect(response.status).toBe(200);
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 404 store_not_found for a missing store", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      const access = createAccessFixture();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const response = await putCap(db, access.token, { storeId: "nope", maxActiveReservationsPerCustomer: 5 });
      expect(response.status).toBe(404);
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 400 invalid_request for out-of-range, fractional, or missing cap values", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db, "store_test");
      const access = createAccessFixture();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      for (const bad of [0, 51, -1, 2.5]) {
        const r = await putCap(db, access.token, { storeId: "store_test", maxActiveReservationsPerCustomer: bad });
        expect(r.status, `cap=${bad}`).toBe(400);
      }
      // Missing key must not silently default.
      const missing = await putCap(db, access.token, { storeId: "store_test" });
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
      const access = createAccessFixture();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const response = await putCap(db, null, { storeId: "store_test", maxActiveReservationsPerCustomer: 5 });
      expect(response.status).toBe(403);
    } finally {
      db.sqlite.close();
    }
  });
});
