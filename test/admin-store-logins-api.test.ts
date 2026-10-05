import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import {
  createAccessJwksFetchMock,
  createAccessJwtFixture,
  createAccessSigningKey,
  type AccessSigningKey
} from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

// HTTP wiring tests for the owner-gated /api/admin/store-logins endpoints.
//
// These exercise the route layer (auth gate, owner privilege gate, JSON parse,
// status-code mapping) on top of the createApp() Hono app. The store-login
// DOMAIN logic (Case A/B/C upsert, fail-closed resolver, revoke guards) is
// covered exhaustively in test/settings-store-login.test.ts; here we confirm
// the routes wire the right identity, gate, and error→status mapping.
//
// Per-identity auth: authenticateAdmin resolves the verified JWT (email, sub)
// to an admin_users row via lower(email) + access_subject + is_service_token=0
// + active=1; the role on that row drives the owner gate. We seed an owner row
// and a staff row, each matched to a distinct JWT subject, so a single signing
// key can mint either identity.

const TEAM_DOMAIN = "https://team.example.cloudflareaccess.com";
const ACCESS_AUD = "admin-store-logins-aud";

const OWNER_EMAIL = "owner@example.com";
const OWNER_SUBJECT = "access_sub_owner_1";
const STAFF_EMAIL = "staff@example.com";
const STAFF_SUBJECT = "access_sub_staff_1";

const ACCESS_KEY_ID = "admin-store-logins-key-1";

// One RSA key pair signs every token in a test; identity is selected purely by
// the (email, sub) claims, which map to a seeded admin_users row.
const createSigningFixture = (): AccessSigningKey => createAccessSigningKey(ACCESS_KEY_ID);

const mintToken = (fixture: AccessSigningKey, subject: string, email: string): string =>
  createAccessJwtFixture({
    issuer: TEAM_DOMAIN,
    audience: ACCESS_AUD,
    keyId: ACCESS_KEY_ID,
    claims: { email, sub: subject },
    signingKey: fixture
  }).token;

const stubAccessJwks = (jwk: AccessSigningKey["jwk"]) => {
  vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, jwk));
};

const baseEnv = (db: SqliteD1Database): Record<string, unknown> => ({
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  ACCESS_AUD,
  DB: db
});

const adminRequest = (
  db: SqliteD1Database,
  token: string,
  path: string,
  init: RequestInit = {}
) => {
  const app = createApp();
  const headers = new Headers(init.headers);
  headers.set("Cf-Access-Jwt-Assertion", token);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return app.request(path, { ...init, headers }, baseEnv(db));
};

const seedOwnerAndStaff = (db: SqliteD1Database) => {
  db.sqlite
    .prepare(
      `INSERT INTO admin_users (id, email, access_subject, role, active, updated_at)
       VALUES (?, ?, ?, 'owner', 1, '2026-05-09T00:00:00.000Z')`
    )
    .run("admin_owner_1", OWNER_EMAIL, OWNER_SUBJECT);
  db.sqlite
    .prepare(
      `INSERT INTO admin_users (id, email, access_subject, role, active, updated_at)
       VALUES (?, ?, ?, 'staff', 1, '2026-05-09T00:00:00.000Z')`
    )
    .run("admin_staff_1", STAFF_EMAIL, STAFF_SUBJECT);
};

const insertStaffMember = (
  db: SqliteD1Database,
  options: { id: string; storeId: string; role?: string; active?: 0 | 1 }
) => {
  db.sqlite
    .prepare(
      `INSERT INTO staff_members (id, store_id, display_name, role, active)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(options.id, options.storeId, "店舗ログイン", options.role ?? "staff", options.active ?? 1);
};

const insertStoreLoginAdminUser = (
  db: SqliteD1Database,
  options: {
    id: string;
    email: string;
    accessSubject: string;
    role?: string;
    active?: 0 | 1;
    staffMemberId: string;
    updatedAt?: string;
  }
) => {
  db.sqlite
    .prepare(
      `INSERT INTO admin_users
        (id, staff_member_id, email, access_subject, role, active, is_service_token, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
    )
    .run(
      options.id,
      options.staffMemberId,
      options.email,
      options.accessSubject,
      options.role ?? "owner",
      options.active ?? 1,
      options.updatedAt ?? "2026-05-16T00:00:00.000Z"
    );
};

const readAdminUser = (db: SqliteD1Database, id: string) =>
  db.sqlite
    .prepare(`SELECT id, email, access_subject, role, active, staff_member_id FROM admin_users WHERE id = ?`)
    .get(id) as
    | { id: string; email: string; access_subject: string; role: string; active: number; staff_member_id: string | null }
    | undefined;

describe("admin store-logins API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 403 when no Cf-Access-Jwt-Assertion header is supplied", async () => {
    const db = createMigratedSqliteD1();
    try {
      const fx = createSigningFixture();
      stubAccessJwks(fx.jwk);
      seedOwnerAndStaff(db);

      const app = createApp();
      const response = await app.request(
        "/api/admin/store-logins",
        { method: "GET" },
        baseEnv(db)
      );
      expect(response.status).toBe(403);
    } finally {
      db.sqlite.close();
    }
  });

  it("GET /store-logins returns 200 with store login views for an owner", async () => {
    const db = createMigratedSqliteD1();
    try {
      const fx = createSigningFixture();
      stubAccessJwks(fx.jwk);
      seedOwnerAndStaff(db);

      // osaka is seeded by seeds/dev.sql; give it a pending store login.
      insertStaffMember(db, { id: "staff_login_osaka", storeId: "osaka" });
      insertStoreLoginAdminUser(db, {
        id: "au_osaka",
        email: "umeda@example.com",
        accessSubject: "pending:abc",
        role: "staff",
        staffMemberId: "staff_login_osaka"
      });

      const response = await adminRequest(
        db,
        mintToken(fx, OWNER_SUBJECT, OWNER_EMAIL),
        "/api/admin/store-logins"
      );
      expect(response.status).toBe(200);
      const json = (await response.json()) as {
        ok: boolean;
        storeLogins: Array<{ storeId: string; status: string; email: string | null }>;
      };
      expect(json.ok).toBe(true);
      expect(Array.isArray(json.storeLogins)).toBe(true);
      const osaka = json.storeLogins.find((v) => v.storeId === "osaka");
      expect(osaka).toMatchObject({ status: "pending", email: "umeda@example.com" });
    } finally {
      db.sqlite.close();
    }
  });

  it("GET /store-logins returns 403 for a staff identity (owner gate)", async () => {
    const db = createMigratedSqliteD1();
    try {
      const fx = createSigningFixture();
      stubAccessJwks(fx.jwk);
      seedOwnerAndStaff(db);

      const response = await adminRequest(
        db,
        mintToken(fx, STAFF_SUBJECT, STAFF_EMAIL),
        "/api/admin/store-logins"
      );
      expect(response.status).toBe(403);
      const json = (await response.json()) as { ok: boolean; error: string };
      expect(json).toEqual({ ok: false, error: "forbidden" });
    } finally {
      db.sqlite.close();
    }
  });

  it("POST /store-logins creates a pending login for a new store and returns 201", async () => {
    const db = createMigratedSqliteD1();
    try {
      const fx = createSigningFixture();
      stubAccessJwks(fx.jwk);
      seedOwnerAndStaff(db);

      const response = await adminRequest(
        db,
        mintToken(fx, OWNER_SUBJECT, OWNER_EMAIL),
        "/api/admin/store-logins",
        {
          method: "POST",
          body: JSON.stringify({
            storeId: "osaka",
            email: "umeda@example.com",
            role: "staff",
            idempotencyKey: "11111111-1111-4111-8111-111111111111"
          })
        }
      );
      expect(response.status).toBe(201);
      const json = (await response.json()) as { ok: boolean; storeId: string; replayed: boolean };
      expect(json).toEqual({ ok: true, storeId: "osaka", replayed: false });

      const row = db.sqlite
        .prepare(
          `SELECT email, access_subject, active FROM admin_users WHERE staff_member_id = ?`
        )
        .get("staff_login_osaka") as
        | { email: string; access_subject: string; active: number }
        | undefined;
      expect(row?.email).toBe("umeda@example.com");
      expect(row?.access_subject.startsWith("pending:")).toBe(true);
      expect(row?.active).toBe(1);
    } finally {
      db.sqlite.close();
    }
  });

  it("POST /store-logins returns 403 for a staff identity (owner gate)", async () => {
    const db = createMigratedSqliteD1();
    try {
      const fx = createSigningFixture();
      stubAccessJwks(fx.jwk);
      seedOwnerAndStaff(db);

      const response = await adminRequest(
        db,
        mintToken(fx, STAFF_SUBJECT, STAFF_EMAIL),
        "/api/admin/store-logins",
        {
          method: "POST",
          body: JSON.stringify({
            storeId: "osaka",
            email: "umeda@example.com",
            role: "staff",
            idempotencyKey: "22222222-2222-4222-8222-222222222222"
          })
        }
      );
      expect(response.status).toBe(403);
      const json = (await response.json()) as { ok: boolean; error: string };
      expect(json).toEqual({ ok: false, error: "forbidden" });
    } finally {
      db.sqlite.close();
    }
  });

  it("POST /store-logins returns 400 invalid_request for a malformed body", async () => {
    const db = createMigratedSqliteD1();
    try {
      const fx = createSigningFixture();
      stubAccessJwks(fx.jwk);
      seedOwnerAndStaff(db);

      const response = await adminRequest(
        db,
        mintToken(fx, OWNER_SUBJECT, OWNER_EMAIL),
        "/api/admin/store-logins",
        {
          method: "POST",
          body: JSON.stringify({ storeId: "osaka", email: "not-an-email", role: "staff" })
        }
      );
      expect(response.status).toBe(400);
      const json = (await response.json()) as { ok: boolean; error: string };
      expect(json).toEqual({ ok: false, error: "invalid_request" });
    } finally {
      db.sqlite.close();
    }
  });

  it("POST /store-logins returns 404 store_not_found for an unknown store", async () => {
    const db = createMigratedSqliteD1();
    try {
      const fx = createSigningFixture();
      stubAccessJwks(fx.jwk);
      seedOwnerAndStaff(db);

      const response = await adminRequest(
        db,
        mintToken(fx, OWNER_SUBJECT, OWNER_EMAIL),
        "/api/admin/store-logins",
        {
          method: "POST",
          body: JSON.stringify({
            storeId: "ghost",
            email: "umeda@example.com",
            role: "staff",
            idempotencyKey: "33333333-3333-4333-8333-333333333333"
          })
        }
      );
      expect(response.status).toBe(404);
      const json = (await response.json()) as { ok: boolean; error: string };
      expect(json).toEqual({ ok: false, error: "store_not_found" });
    } finally {
      db.sqlite.close();
    }
  });

  it("POST /store-logins returns 409 email_in_use when the email belongs to an unrelated admin row", async () => {
    const db = createMigratedSqliteD1();
    try {
      const fx = createSigningFixture();
      stubAccessJwks(fx.jwk);
      seedOwnerAndStaff(db);

      // An unrelated store-login for kyoto already owns this email.
      insertStaffMember(db, { id: "staff_login_kyoto", storeId: "kyoto" });
      insertStoreLoginAdminUser(db, {
        id: "au_kyoto",
        email: "shared@example.com",
        accessSubject: "real-kyoto",
        role: "owner",
        staffMemberId: "staff_login_kyoto"
      });

      const response = await adminRequest(
        db,
        mintToken(fx, OWNER_SUBJECT, OWNER_EMAIL),
        "/api/admin/store-logins",
        {
          method: "POST",
          body: JSON.stringify({
            storeId: "osaka",
            email: "shared@example.com",
            role: "staff",
            idempotencyKey: "44444444-4444-4444-8444-444444444444"
          })
        }
      );
      expect(response.status).toBe(409);
      const json = (await response.json()) as { ok: boolean; error: string };
      expect(json).toEqual({ ok: false, error: "email_in_use" });

      // unrelated row untouched
      expect(readAdminUser(db, "au_kyoto")?.access_subject).toBe("real-kyoto");
    } finally {
      db.sqlite.close();
    }
  });

  it("POST + DELETE return 400 invalid_request for an ambiguous store (two active human logins, no sentinel)", async () => {
    const db = createMigratedSqliteD1();
    try {
      const fx = createSigningFixture();
      stubAccessJwks(fx.jwk);
      seedOwnerAndStaff(db);

      // Two ordinary staff_members under osaka, each with an active human login,
      // and NO staff_login_osaka sentinel -> legacy fallback resolves ambiguous.
      insertStaffMember(db, { id: "sm_a", storeId: "osaka" });
      insertStaffMember(db, { id: "sm_b", storeId: "osaka" });
      insertStoreLoginAdminUser(db, {
        id: "au_a",
        email: "a@example.com",
        accessSubject: "real-a",
        role: "owner",
        staffMemberId: "sm_a"
      });
      insertStoreLoginAdminUser(db, {
        id: "au_b",
        email: "b@example.com",
        accessSubject: "real-b",
        role: "staff",
        staffMemberId: "sm_b"
      });

      const ownerToken = mintToken(fx, OWNER_SUBJECT, OWNER_EMAIL);

      const postResponse = await adminRequest(db, ownerToken, "/api/admin/store-logins", {
        method: "POST",
        body: JSON.stringify({
          storeId: "osaka",
          email: "c@example.com",
          role: "staff",
          idempotencyKey: "55555555-5555-4555-8555-555555555555"
        })
      });
      expect(postResponse.status).toBe(400);
      expect((await postResponse.json()) as unknown).toEqual({
        ok: false,
        error: "invalid_request"
      });

      const deleteResponse = await adminRequest(db, ownerToken, "/api/admin/store-logins/osaka", {
        method: "DELETE"
      });
      expect(deleteResponse.status).toBe(400);
      expect((await deleteResponse.json()) as unknown).toEqual({
        ok: false,
        error: "invalid_request"
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("DELETE /store-logins/:storeId returns 200 and deactivates the canonical login", async () => {
    const db = createMigratedSqliteD1();
    try {
      const fx = createSigningFixture();
      stubAccessJwks(fx.jwk);
      seedOwnerAndStaff(db);

      insertStaffMember(db, { id: "staff_login_osaka", storeId: "osaka" });
      insertStoreLoginAdminUser(db, {
        id: "au_osaka",
        email: "umeda@example.com",
        accessSubject: "real-osaka",
        role: "owner",
        staffMemberId: "staff_login_osaka"
      });

      const response = await adminRequest(
        db,
        mintToken(fx, OWNER_SUBJECT, OWNER_EMAIL),
        "/api/admin/store-logins/osaka",
        { method: "DELETE" }
      );
      expect(response.status).toBe(200);
      const json = (await response.json()) as { ok: boolean; storeId: string };
      expect(json).toEqual({ ok: true, storeId: "osaka" });

      expect(readAdminUser(db, "au_osaka")?.active).toBe(0);
    } finally {
      db.sqlite.close();
    }
  });

  it("DELETE /store-logins/:storeId returns 403 self-deactivation when the owner IS the store's canonical login", async () => {
    const db = createMigratedSqliteD1();
    try {
      const fx = createSigningFixture();
      stubAccessJwks(fx.jwk);

      // The acting owner's admin_users row is itself the osaka store login:
      // staff_member_id = staff_login_osaka, matched by (email, sub). Revoking
      // it would lock out the very identity making the request.
      insertStaffMember(db, { id: "staff_login_osaka", storeId: "osaka" });
      insertStoreLoginAdminUser(db, {
        id: "au_self_owner",
        email: OWNER_EMAIL,
        accessSubject: OWNER_SUBJECT,
        role: "owner",
        staffMemberId: "staff_login_osaka"
      });

      const response = await adminRequest(
        db,
        mintToken(fx, OWNER_SUBJECT, OWNER_EMAIL),
        "/api/admin/store-logins/osaka",
        { method: "DELETE" }
      );
      expect(response.status).toBe(403);
      const json = (await response.json()) as { ok: boolean; error: string };
      expect(json).toEqual({ ok: false, error: "forbidden_self_deactivation" });

      // still active
      expect(readAdminUser(db, "au_self_owner")?.active).toBe(1);
    } finally {
      db.sqlite.close();
    }
  });

  it("DELETE /store-logins/:storeId returns 404 when there is no active login", async () => {
    const db = createMigratedSqliteD1();
    try {
      const fx = createSigningFixture();
      stubAccessJwks(fx.jwk);
      seedOwnerAndStaff(db);

      const response = await adminRequest(
        db,
        mintToken(fx, OWNER_SUBJECT, OWNER_EMAIL),
        "/api/admin/store-logins/osaka",
        { method: "DELETE" }
      );
      expect(response.status).toBe(404);
      const json = (await response.json()) as { ok: boolean; error: string };
      expect(json).toEqual({ ok: false, error: "not_found" });
    } finally {
      db.sqlite.close();
    }
  });
});
