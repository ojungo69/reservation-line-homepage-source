import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import { createAccessJwksFetchMock, createAccessJwtFixture as createAccessJwtFixtureHelper, insertAdminUser as insertAdminUserHelper, type AdminRole } from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const TEAM_DOMAIN = "https://team.example.cloudflareaccess.com";
const ACCESS_AUD = "staging-drift-sweep-aud";
const ADMIN_EMAIL = "drift-admin@example.com";
const ADMIN_ACCESS_SUBJECT = "access-subject-drift-admin";
const KEY_ID = "staging-drift-sweep-key-1";
// Store "kyoto" with google_calendar_id "calendar-kyoto@example.invalid" is already
// seeded by seeds/dev.sql. We reuse it — do not re-INSERT.
const STORE_ID = "kyoto";
const CALENDAR_ID = "calendar-a@example.invalid";

const createAccessJwtFixture = (
  overrides: Partial<{
    email: string;
    sub: string;
    aud: string;
  }> = {}
) =>
  createAccessJwtFixtureHelper({
    issuer: TEAM_DOMAIN,
    audience: overrides.aud ?? ACCESS_AUD,
    keyId: KEY_ID,
    claims: {
      email: overrides.email ?? ADMIN_EMAIL,
      sub: overrides.sub ?? ADMIN_ACCESS_SUBJECT
    }
  });

const createFetchMock = (jwk: ReturnType<typeof createAccessJwtFixture>["jwk"]) =>
  createAccessJwksFetchMock(TEAM_DOMAIN, jwk);

const insertAdminUser = (db: SqliteD1Database, role: AdminRole) =>
  insertAdminUserHelper(db, {
    id: "admin_drift_sweep_1",
    email: ADMIN_EMAIL,
    accessSubject: ADMIN_ACCESS_SUBJECT,
    role,
    updatedAt: "2026-05-20T00:00:00.000Z",
  });

const baseEnv = (db: SqliteD1Database): Record<string, unknown> => ({
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  ACCESS_AUD,
  DB: db,
  ENVIRONMENT: "staging",
  GOOGLE_DRIFT_ALERT_LIVE: "true",
  LINE_OPERATIONS_USER_IDS: "U" + "a".repeat(32),
  GOOGLE_SERVICE_ACCOUNT_EMAIL: "unused@invalid",
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
});

const driftSweepRequest = (
  db: SqliteD1Database,
  token: string,
  body: Record<string, unknown>,
  envOverrides: Record<string, unknown> = {}
) => {
  const app = createApp();
  const headers = new Headers();
  headers.set("Cf-Access-Jwt-Assertion", token);
  headers.set("Content-Type", "application/json");
  return app.request(
    "/api/admin/staging/drift-sweep",
    { method: "POST", headers, body: JSON.stringify(body) },
    { ...baseEnv(db), ...envOverrides }
  );
};

describe("driftSweepHandler role gate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("allows system_admin to trigger drift sweep", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "system_admin");


      const response = await driftSweepRequest(db, access.token, {
        storeId: STORE_ID,
        injectCount: 11,
        cleanupExisting: true,
        kickQueue: false,
        syncDispatch: false
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ ok: true, storeId: STORE_ID });
    } finally {
      db.sqlite.close();
    }
  });

  it("dispatches staging drift alerts by owner email without the LINE channel guard", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "system_admin");
      const emailSend = vi.fn(async () => ({ messageId: "email_staging_drift" }));

      const response = await driftSweepRequest(
        db,
        access.token,
        {
          storeId: STORE_ID,
          injectCount: 11,
          cleanupExisting: true,
          kickQueue: false,
          syncDispatch: true
        },
        {
          LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "tok",
          PENDING_APPROVAL_OWNER_EMAIL: "owner@example.com",
          OPERATIONS_NOTIFICATION_EMAIL: "",
          EMAIL: { send: emailSend } as unknown as SendEmail
        }
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        jobIds: string[];
        dispatchedCount: number;
        succeededJobIds: string[];
      };

      expect(body.jobIds.length).toBeGreaterThan(0);
      expect(body.dispatchedCount).toBe(body.jobIds.length);
      expect(body.succeededJobIds).toEqual(body.jobIds);
      expect(emailSend).toHaveBeenCalledTimes(body.jobIds.length);

      const rows = db.sqlite
        .prepare(
          `SELECT status, last_error FROM notification_jobs WHERE id IN (${body.jobIds
            .map(() => "?")
            .join(",")})`
        )
        .all(...body.jobIds) as Array<{ status: string; last_error: string | null }>;
      expect(rows).toHaveLength(body.jobIds.length);
      for (const row of rows) {
        expect(row.status).toBe("succeeded");
        expect(row.last_error).toBeNull();
      }
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 403 for staff role", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "staff");


      const response = await driftSweepRequest(db, access.token, {
        storeId: STORE_ID,
        injectCount: 11,
        cleanupExisting: true,
        kickQueue: false,
        syncDispatch: false
      });

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body).toMatchObject({ ok: false, reason: "forbidden" });
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 403 for owner role", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "owner");


      const response = await driftSweepRequest(db, access.token, {
        storeId: STORE_ID,
        injectCount: 11,
        cleanupExisting: true,
        kickQueue: false,
        syncDispatch: false
      });

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body).toMatchObject({ ok: false, reason: "forbidden" });
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 404 when ENVIRONMENT is not staging", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "system_admin");


      const app = createApp();
      const headers = new Headers();
      headers.set("Cf-Access-Jwt-Assertion", access.token);
      headers.set("Content-Type", "application/json");
      const env = { ...baseEnv(db), ENVIRONMENT: "production" };
      const response = await app.request(
        "/api/admin/staging/drift-sweep",
        {
          method: "POST",
          headers,
          body: JSON.stringify({ storeId: STORE_ID, injectCount: 11 })
        },
        env
      );

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body).toMatchObject({ ok: false, reason: "not_found" });
    } finally {
      db.sqlite.close();
    }
  });
});
