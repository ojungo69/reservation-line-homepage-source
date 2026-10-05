import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import { jstYearMonth } from "../src/line/quota";
import { createAccessJwksFetchMock, createAccessJwtFixture, type AccessJwtFixture } from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const TEAM_DOMAIN = "https://team.example.cloudflareaccess.com";
const ACCESS_AUD = "admin-line-quota-aud";
const ACCESS_KEY_ID = "admin-line-quota-key-1";
const ACCESS_SUBJECT_OWNER = "access_sub_owner_lq";
const ACCESS_SUBJECT_STAFF = "access_sub_staff_lq";
const OWNER_EMAIL = "owner-lq@example.com";
const STAFF_EMAIL = "staff-lq@example.com";

const createAccessJwt = (subject: string, email: string): AccessJwtFixture =>
  createAccessJwtFixture({
    issuer: TEAM_DOMAIN,
    audience: ACCESS_AUD,
    keyId: ACCESS_KEY_ID,
    claims: { email, sub: subject }
  });

const stubAccessJwks = (jwk: AccessJwtFixture["jwk"]) => {
  vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, jwk));
};

const baseEnv = (db: SqliteD1Database): Record<string, unknown> => ({
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  ACCESS_AUD,
  DB: db
});

const adminGet = (db: SqliteD1Database, token: string, path: string) => {
  const headers = new Headers();
  headers.set("Cf-Access-Jwt-Assertion", token);
  return createApp().request(path, { method: "GET", headers }, baseEnv(db));
};

const seedAdmins = (db: SqliteD1Database) => {
  db.sqlite
    .prepare(`INSERT INTO admin_users (id, email, access_subject, role, active, updated_at) VALUES (?, ?, ?, 'owner', 1, '2026-05-09T00:00:00.000Z')`)
    .run("admin_owner_lq", OWNER_EMAIL, ACCESS_SUBJECT_OWNER);
  db.sqlite
    .prepare(`INSERT INTO admin_users (id, email, access_subject, role, active, updated_at) VALUES (?, ?, ?, 'staff', 1, '2026-05-09T00:00:00.000Z')`)
    .run("admin_staff_lq", STAFF_EMAIL, ACCESS_SUBJECT_STAFF);
};

describe("admin line-quota API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns 200 with the current month's quota for owner", async () => {
    const db = createMigratedSqliteD1();
    try {
      const owner = createAccessJwt(ACCESS_SUBJECT_OWNER, OWNER_EMAIL);
      stubAccessJwks(owner.jwk);
      seedAdmins(db);
      const month = jstYearMonth(Date.now());
      db.sqlite
        .prepare(`INSERT INTO line_quota_snapshots (year_month, total_usage, quota_value, fetched_at) VALUES (?, ?, ?, ?)`)
        .run(month, 42, 200, "2026-05-30T00:00:00.000Z");

      const response = await adminGet(db, owner.token, "/api/admin/line-quota");
      expect(response.status).toBe(200);
      const json = (await response.json()) as { ok: boolean; quota: { used: number; limit: number; remaining: number; softCap: number } | null };
      expect(json.ok).toBe(true);
      expect(json.quota).toMatchObject({ used: 42, limit: 200, remaining: 158, softCap: 180 });
    } finally {
      db.sqlite.close();
    }
  });

  it("returns quota:null for owner when no snapshot exists yet", async () => {
    const db = createMigratedSqliteD1();
    try {
      const owner = createAccessJwt(ACCESS_SUBJECT_OWNER, OWNER_EMAIL);
      stubAccessJwks(owner.jwk);
      seedAdmins(db);
      const response = await adminGet(db, owner.token, "/api/admin/line-quota");
      expect(response.status).toBe(200);
      const json = (await response.json()) as { ok: boolean; quota: unknown };
      expect(json).toEqual({ ok: true, quota: null });
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 403 for staff (owner-only)", async () => {
    const db = createMigratedSqliteD1();
    try {
      const staff = createAccessJwt(ACCESS_SUBJECT_STAFF, STAFF_EMAIL);
      stubAccessJwks(staff.jwk);
      seedAdmins(db);
      const response = await adminGet(db, staff.token, "/api/admin/line-quota");
      expect(response.status).toBe(403);
    } finally {
      db.sqlite.close();
    }
  });
});
