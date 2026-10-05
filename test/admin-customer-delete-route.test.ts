import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import { createAccessJwtFixture, createAccessJwksFetchMock } from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

// Task 4: POST /api/admin/customers/:id/delete — HTTP authorization + CSRF +
// status mapping. The delete mechanics (FK-ordered cascade) are covered in
// admin-customer-delete.test.ts; here we assert owner/system_admin succeed,
// staff is forbidden, CSRF is blocked, and guard hits map to 409 / 404.

const TEAM_DOMAIN = "https://team.example.cloudflareaccess.com";
const ACCESS_AUD = "customer-delete-aud";
const ADMIN_EMAIL = "delete-admin@example.com";
const ADMIN_SUBJECT = "access-subject-customer-delete";
const KEY_ID = "delete-test-key-1";

const makeAccessJwt = () =>
  createAccessJwtFixture({
    issuer: TEAM_DOMAIN,
    audience: ACCESS_AUD,
    keyId: KEY_ID,
    claims: { email: ADMIN_EMAIL, sub: ADMIN_SUBJECT }
  });

const insertAdmin = (
  db: SqliteD1Database,
  role: "owner" | "staff" | "system_admin",
  staffMemberId: string | null
) => {
  db.sqlite
    .prepare(
      `INSERT INTO admin_users (id, email, access_subject, role, staff_member_id, active, updated_at)
       VALUES ('admin_del_http', ?, ?, ?, ?, 1, '2026-05-22T00:00:00.000Z')`
    )
    .run(ADMIN_EMAIL, ADMIN_SUBJECT, role, staffMemberId);
};

const endPlusHour = (startAt: string) => new Date(new Date(startAt).getTime() + 3_600_000).toISOString();

// Seeds a deletable historical customer (one cancelled reservation + visit).
// `status` overrides the reservation status to exercise the active-guard 409.
const seedCustomer = (db: SqliteD1Database, status = "cancelled_by_admin") => {
  db.sqlite.exec(`
    INSERT INTO customers (id, display_name, block_status) VALUES ('c_del', '削除 対象', 'active');
  `);
  const start = "2026-04-01T10:00:00Z";
  db.sqlite
    .prepare(
      `INSERT INTO reservations (id, store_id, service_id, customer_id, resource_id, source, status, duration_minutes, idempotency_key, start_at, end_at)
       VALUES ('r_del', 'kyoto', 'service_kyoto_default_60', 'c_del', 'resource_kyoto_calendar', 'web_line', ?, 60, 'ik_r_del', ?, ?)`
    )
    .run(status, start, endPlusHour(start));
  db.sqlite.exec(`
    INSERT INTO customer_visits (id, customer_id, reservation_id, store_id, visited_at, visit_source, status, recorded_by)
    VALUES ('v_del', 'c_del', 'r_del', 'kyoto', '2026-04-01', 'reservation_completed', 'valid', 'admin_test');
  `);
};

const env = (db: SqliteD1Database): Record<string, unknown> => ({
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  ACCESS_AUD,
  DB: db
});

const del = (
  db: SqliteD1Database,
  token: string,
  customerId = "c_del",
  extraHeaders: Record<string, string> = {}
) => {
  const app = createApp();
  return app.request(
    `/api/admin/customers/${customerId}/delete`,
    {
      method: "POST",
      headers: { "Cf-Access-Jwt-Assertion": token, "Content-Type": "application/json", ...extraHeaders },
      body: "{}"
    },
    env(db)
  );
};

describe("POST /customers/:id/delete — routes", () => {
  afterEach(() => vi.unstubAllGlobals());

  const setup = (role: "owner" | "staff" | "system_admin", staffMemberId: string | null, status?: string) => {
    const db = createMigratedSqliteD1();
    insertAdmin(db, role, staffMemberId);
    seedCustomer(db, status);
    const access = makeAccessJwt();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));
    return { db, token: access.token };
  };

  it("owner: 200 + removed counts; customer is gone", async () => {
    const { db, token } = setup("owner", null);
    try {
      const r = await del(db, token);
      expect(r.status).toBe(200);
      const body = (await r.json()) as { ok: boolean; removed?: { reservations: number } };
      expect(body.ok).toBe(true);
      expect(body.removed?.reservations).toBe(1);
      expect((db.sqlite.prepare("SELECT COUNT(*) AS n FROM customers WHERE id='c_del'").get() as { n: number }).n).toBe(0);
    } finally {
      db.sqlite.close();
    }
  });

  it("system_admin: 200", async () => {
    const { db, token } = setup("system_admin", null);
    try {
      expect((await del(db, token)).status).toBe(200);
    } finally {
      db.sqlite.close();
    }
  });

  it("staff: 403 forbidden; customer untouched", async () => {
    const { db, token } = setup("staff", "staff_owner_kyoto");
    try {
      const r = await del(db, token);
      expect(r.status).toBe(403);
      expect((db.sqlite.prepare("SELECT COUNT(*) AS n FROM customers WHERE id='c_del'").get() as { n: number }).n).toBe(1);
    } finally {
      db.sqlite.close();
    }
  });

  it("CSRF: Sec-Fetch-Site cross-site is blocked (403) before any delete", async () => {
    const { db, token } = setup("owner", null);
    try {
      const r = await del(db, token, "c_del", { "Sec-Fetch-Site": "cross-site" });
      expect(r.status).toBe(403);
      expect((db.sqlite.prepare("SELECT COUNT(*) AS n FROM customers WHERE id='c_del'").get() as { n: number }).n).toBe(1);
    } finally {
      db.sqlite.close();
    }
  });

  it("active reservation → 409 has_active_reservations", async () => {
    const { db, token } = setup("owner", null, "confirmed");
    try {
      const r = await del(db, token);
      expect(r.status).toBe(409);
      const body = (await r.json()) as { ok: boolean; reason?: string };
      expect(body.reason).toBe("has_active_reservations");
    } finally {
      db.sqlite.close();
    }
  });

  it("unknown customer → 404 not_found", async () => {
    const { db, token } = setup("owner", null);
    try {
      const r = await del(db, token, "does_not_exist");
      expect(r.status).toBe(404);
    } finally {
      db.sqlite.close();
    }
  });
});
