import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import { createAccessJwksFetchMock, createAccessJwtFixture, type AccessJwk } from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const TEAM_DOMAIN = "https://team.example.cloudflareaccess.com";
const ACCESS_AUD = "admin-merge-candidates-aud";
const ACCESS_SUBJECT_OWNER = "access_sub_owner_1";
const ACCESS_SUBJECT_STAFF = "access_sub_staff_1";
const OWNER_EMAIL = "owner@example.com";
const STAFF_EMAIL = "staff@example.com";
const ACCESS_KEY_ID = "admin-merge-candidates-key-1";

const OWNER_ID = "admin_owner_mc";
const STAFF_ID = "admin_staff_mc";
const STORE_ID = "store_mc";
const CUSTOMER_A_ID = "customer_mc_a";
const CUSTOMER_B_ID = "customer_mc_b";
const DUP_PHONE_HASH = "phash_dup";

const createAccessJwt = (subject: string, email: string) =>
  createAccessJwtFixture({
    issuer: TEAM_DOMAIN,
    audience: ACCESS_AUD,
    keyId: ACCESS_KEY_ID,
    claims: { email, sub: subject }
  });

const stubAccessJwks = (jwk: AccessJwk) => {
  vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, jwk));
};

const baseEnv = (db: SqliteD1Database): Record<string, unknown> => ({
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  ACCESS_AUD,
  DB: db
});

const adminRequest = (db: SqliteD1Database, token: string, path: string) => {
  const app = createApp();
  const headers = new Headers();
  headers.set("Cf-Access-Jwt-Assertion", token);
  return app.request(path, { method: "GET", headers }, baseEnv(db));
};

// Seeds an owner + staff admin_users row and two customers sharing one
// phone_hash under a single store, both non-tombstoned (merged_into_id IS NULL).
const seedMergeCandidateFixture = (db: SqliteD1Database) => {
  db.sqlite
    .prepare(
      `INSERT INTO admin_users (id, email, access_subject, role, active, updated_at)
       VALUES (?, ?, ?, 'owner', 1, '2026-05-09T00:00:00.000Z')`
    )
    .run(OWNER_ID, OWNER_EMAIL, ACCESS_SUBJECT_OWNER);
  db.sqlite
    .prepare(
      `INSERT INTO admin_users (id, email, access_subject, role, active, updated_at)
       VALUES (?, ?, ?, 'staff', 1, '2026-05-09T00:00:00.000Z')`
    )
    .run(STAFF_ID, STAFF_EMAIL, ACCESS_SUBJECT_STAFF);
  db.sqlite
    .prepare(`INSERT INTO stores (id, name, timezone) VALUES (?, ?, ?)`)
    .run(STORE_ID, "Store MC", "Asia/Tokyo");
  db.sqlite
    .prepare(
      `INSERT INTO customers (id, display_name, phone_normalized, phone_hash) VALUES (?, ?, ?, ?)`
    )
    .run(CUSTOMER_A_ID, "Duplicate A", "0700001111", DUP_PHONE_HASH);
  db.sqlite
    .prepare(
      `INSERT INTO customers (id, display_name, phone_normalized, phone_hash) VALUES (?, ?, ?, ?)`
    )
    .run(CUSTOMER_B_ID, "Duplicate B", "0700001111", DUP_PHONE_HASH);
};

describe("admin customer merge-candidates API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GET /api/admin/customers/merge-candidates returns 200 with the duplicate group for owner", async () => {
    const db = createMigratedSqliteD1();
    try {
      const owner = createAccessJwt(ACCESS_SUBJECT_OWNER, OWNER_EMAIL);
      stubAccessJwks(owner.jwk);
      seedMergeCandidateFixture(db);

      const response = await adminRequest(
        db,
        owner.token,
        "/api/admin/customers/merge-candidates"
      );
      expect(response.status).toBe(200);
      const json = (await response.json()) as {
        ok: boolean;
        groups: Array<{ groupId: string; phoneHash?: string; customers: Array<{ id: string }> }>;
        truncated: boolean;
      };
      expect(json.ok).toBe(true);
      expect(json.truncated).toBe(false);
      expect(json.groups).toHaveLength(1);
      // phone_hash must NOT leak to the client; the group is keyed by an opaque id.
      expect(json.groups[0]).not.toHaveProperty("phoneHash");
      expect(typeof json.groups[0].groupId).toBe("string");
      expect(json.groups[0].groupId.length).toBeGreaterThan(0);
      const ids = json.groups[0].customers.map((customer) => customer.id).sort();
      expect(ids).toEqual([CUSTOMER_A_ID, CUSTOMER_B_ID].sort());
    } finally {
      db.sqlite.close();
    }
  });

  it("GET /api/admin/customers/merge-candidates returns 403 for staff", async () => {
    const db = createMigratedSqliteD1();
    try {
      const staff = createAccessJwt(ACCESS_SUBJECT_STAFF, STAFF_EMAIL);
      stubAccessJwks(staff.jwk);
      seedMergeCandidateFixture(db);

      const response = await adminRequest(
        db,
        staff.token,
        "/api/admin/customers/merge-candidates"
      );
      expect(response.status).toBe(403);
      const json = (await response.json()) as { ok: boolean; reason: string };
      expect(json).toEqual({ ok: false, reason: "forbidden" });
    } finally {
      db.sqlite.close();
    }
  });
});
