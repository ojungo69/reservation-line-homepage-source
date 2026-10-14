import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import { safeCaptureException } from "../src/sentry-helpers";
import {
  createAccessJwksFetchMock,
  createAccessJwtFixture,
  insertAdminUser,
  type AccessSigningKey
} from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

vi.mock("../src/sentry-helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/sentry-helpers")>()),
  safeCaptureException: vi.fn()
}));

const TEAM_DOMAIN = "https://team.example.cloudflareaccess.com";
const ACCESS_AUD = "customer-staff-access-aud";
const ADMIN_ORIGIN = "https://admin.example.com";
const ADMIN_EMAIL = "staff@example.com";
const ADMIN_SUBJECT = "sub-customer-staff-access";
const ADMIN_ID = "admin_staff_access";
const CUSTOMER_A = "customer_access_a";
const CUSTOMER_B = "customer_access_b";
const MEMO = "Example treatment memo";

type CustomerRoute = {
  method: "GET" | "POST" | "PUT" | "PATCH";
  suffix: string;
  body?: unknown;
};

// Every per-customer route in the staff contract uses the same two-store fixture.
const customerRoutes: CustomerRoute[] = [
  { method: "GET", suffix: "" },
  { method: "GET", suffix: "/visits?offset=0" },
  { method: "GET", suffix: "/reservations?offset=0" },
  { method: "GET", suffix: "/consents?offset=0" },
  { method: "POST", suffix: "/block", body: { idempotencyKey: "block-1", reason: "Example reason" } },
  { method: "POST", suffix: "/unblock", body: { idempotencyKey: "unblock-1", reason: "Example reason" } },
  { method: "POST", suffix: "/archive", body: { idempotencyKey: "archive-1", reason: "Example reason" } },
  { method: "POST", suffix: "/unarchive", body: { idempotencyKey: "unarchive-1", reason: "Example reason" } },
  { method: "PUT", suffix: "/memo", body: { memo: "Updated example memo", expectedMemo: MEMO } },
  { method: "PUT", suffix: "/referrer", body: { referrerName: "Example Referrer", expectedReferrerName: null } },
  { method: "PATCH", suffix: "/profile", body: { displayName: "Example Updated Customer" } },
  { method: "PUT", suffix: "/visits/:visitId/notes", body: { treatmentNotes: "Example notes", expectedTreatmentNotes: null } }
];

const collectionQueries = ["?mode=list", "?mode=list&view=archived", "?q=Example"];
const createCustomerBody = {
  idempotencyKey: "create-1",
  displayName: "Example New Customer",
  // A supplied store must never widen the authenticated staff member's scope.
  storeId: "osaka",
  created_store_id: "osaka"
};

const customerPath = (route: CustomerRoute, customerId: string) =>
  `/api/admin/customers/${customerId}${route.suffix.replace(":visitId", `visit_${customerId}`)}`;

describe("staff customer access within their store", () => {
  let db: SqliteD1Database;
  let token: string;
  let signingKey: AccessSigningKey;

  beforeEach(() => {
    db = createMigratedSqliteD1();
    const access = createAccessJwtFixture({
      issuer: TEAM_DOMAIN,
      audience: ACCESS_AUD,
      keyId: "staff-access-key-1",
      claims: { email: ADMIN_EMAIL, sub: ADMIN_SUBJECT }
    });
    token = access.token;
    signingKey = access;
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));
    db.sqlite.exec(`
      INSERT INTO staff_members (id, store_id, display_name, role, active, created_at, updated_at)
      VALUES ('staff_access_a', 'kyoto', 'Example Staff A', 'staff', 1, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    `);
    insertAdminUser(db, {
      id: ADMIN_ID,
      email: ADMIN_EMAIL,
      accessSubject: ADMIN_SUBJECT,
      role: "staff",
      staffMemberId: "staff_access_a"
    });
    for (const [id, storeId, archivedAt] of [
      [CUSTOMER_A, "kyoto", null],
      [CUSTOMER_B, "osaka", null],
      ["customer_access_archived_a", "kyoto", "2026-10-02T00:00:00.000Z"],
      ["customer_access_archived_b", "osaka", "2026-10-02T00:00:00.000Z"]
    ]) {
      db.sqlite.prepare(`
        INSERT INTO customers (id, display_name, block_status, memo, created_store_id, archived_at)
        VALUES (?, 'Example Customer', 'active', ?, ?, ?)
      `).run(id, MEMO, storeId, archivedAt);
    }
    for (const [customerId, storeId] of [[CUSTOMER_A, "kyoto"], [CUSTOMER_B, "osaka"]]) {
      db.sqlite.prepare(`
        INSERT INTO customer_visits (id, customer_id, store_id, visited_at, visit_source, status, recorded_by)
        VALUES (?, ?, ?, '2026-10-01', 'manual_import', 'valid', ?)
      `).run(`visit_${customerId}`, customerId, storeId, ADMIN_ID);
    }
  });

  afterEach(() => {
    db.sqlite.close();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    extraEnv: Record<string, unknown> = {}
  ) => createApp().request(`${ADMIN_ORIGIN}${path}`, {
    method,
    headers: {
      "Cf-Access-Jwt-Assertion": token,
      "Content-Type": "application/json",
      Origin: ADMIN_ORIGIN,
      "Sec-Fetch-Site": "same-origin"
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  }, { DB: db, ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD, ...extraEnv });

  const prepareTransition = (route: CustomerRoute, customerId: string) => {
    if (route.suffix === "/unblock") {
      db.sqlite.prepare("UPDATE customers SET block_status = 'blocked' WHERE id = ?").run(customerId);
    }
    if (route.suffix === "/unarchive") {
      db.sqlite.prepare("UPDATE customers SET archived_at = '2026-10-02T00:00:00.000Z' WHERE id = ?").run(customerId);
    }
  };

  it.each(customerRoutes)("allows own-store staff without approval: $method /customers/:id$suffix", async (route) => {
    prepareTransition(route, CUSTOMER_A);
    const response = await request(customerPath(route, CUSTOMER_A), route.method, route.body);
    expect({ status: response.status, body: await response.json() }).toMatchObject({
      status: 200, body: { ok: true }
    });
  });

  it.each(customerRoutes)("refuses another store's customer: $method /customers/:id$suffix", async (route) => {
    prepareTransition(route, CUSTOMER_B);
    const response = await request(customerPath(route, CUSTOMER_B), route.method, route.body);
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 403, body: { ok: false, reason: "forbidden" }
    });
  });

  it.each(customerRoutes)("refuses staff without a store: $method /customers/:id$suffix", async (route) => {
    db.sqlite.prepare("UPDATE admin_users SET staff_member_id = NULL WHERE id = ?").run(ADMIN_ID);
    prepareTransition(route, CUSTOMER_A);
    const response = await request(customerPath(route, CUSTOMER_A), route.method, route.body);
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 403, body: { ok: false, reason: "forbidden" }
    });
  });

  it.each(collectionQueries)("lists only own-store customers without approval: GET /customers%s", async (query) => {
    const response = await request(`/api/admin/customers${query}&store=osaka`);
    const body = await response.json() as { customers: Array<{ id: string; memo: string | null }> };
    expect(response.status, JSON.stringify(body)).toBe(200);
    const ids = body.customers?.map((customer) => customer.id);
    expect(ids).toContain(query.includes("archived") ? "customer_access_archived_a" : CUSTOMER_A);
    expect(ids).not.toContain(CUSTOMER_B);
    expect(ids).not.toContain("customer_access_archived_b");
    if (query.startsWith("?q=")) {
      expect(body.customers?.find((customer) => customer.id === CUSTOMER_A)?.memo).toBe(MEMO);
    }
  });

  it.each(collectionQueries)("refuses a list/search without a staff store: GET /customers%s", async (query) => {
    db.sqlite.prepare("UPDATE admin_users SET staff_member_id = NULL WHERE id = ?").run(ADMIN_ID);
    const response = await request(`/api/admin/customers${query}`);
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 403, body: { ok: false, reason: "forbidden" }
    });
  });

  it("creates a customer in the staff member's store without approval, ignoring a supplied store", async () => {
    const response = await request("/api/admin/customers", "POST", createCustomerBody);
    const body = await response.json() as { ok: boolean; customerId?: string };
    expect({ status: response.status, body }).toMatchObject({ status: 201, body: { ok: true } });
    expect(body.customerId).toEqual(expect.any(String));
    const list = await request("/api/admin/customers?mode=list&store=osaka");
    const listed = await list.json() as { customers: Array<{ id: string }> };
    expect(listed.customers.map((customer) => customer.id)).toContain(body.customerId);
    db.sqlite.prepare("UPDATE staff_members SET store_id = 'osaka' WHERE id = 'staff_access_a'").run();
    const otherStore = await request(`/api/admin/customers/${body.customerId}`);
    expect({ status: otherStore.status, body: await otherStore.json() }).toEqual({
      status: 403, body: { ok: false, reason: "forbidden" }
    });
  });

  it("refuses customer creation without a staff store", async () => {
    db.sqlite.prepare("UPDATE admin_users SET staff_member_id = NULL WHERE id = ?").run(ADMIN_ID);
    const response = await request("/api/admin/customers", "POST", createCustomerBody);
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 403, body: { ok: false, reason: "forbidden" }
    });
  });

  it.each(["request", "verify"])("returns the generic not-found body for the removed customer-gate/%s endpoint and sends no email", async (endpoint) => {
    const send = vi.fn(async () => {});
    const response = await request(`/api/admin/customer-gate/${endpoint}`, "POST", {
      challengeId: "example-retired-challenge", code: "123456"
    }, { EMAIL: { send }, PENDING_APPROVAL_OWNER_EMAIL: "owner@example.com" });
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 404, body: { error: "not_found" }
    });
    expect(send).not.toHaveBeenCalled();
  });
  const listViewRows = () => db.sqlite.prepare(`
    SELECT id, actor_type, actor_id, target_type, target_id, metadata_json
    FROM audit_logs WHERE action = 'customer.list_view' ORDER BY id
  `).all();

  it("records the first staff customer-list view of the JST day once, without customer data", async () => {
    for (const query of ["?mode=list", "?mode=list&offset=200", "?mode=list&view=archived"]) {
      expect((await request(`/api/admin/customers${query}`)).status).toBe(200);
    }
    // Search is the reservation picker, not the list: it is not recorded.
    expect((await request("/api/admin/customers?q=Example")).status).toBe(200);
    const rows = listViewRows() as Array<{ id: string; metadata_json: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_type: "staff", actor_id: ADMIN_ID, target_type: "admin_user", target_id: ADMIN_ID
    });
    expect(JSON.parse(rows[0].metadata_json)).toEqual({ adminStoreId: "kyoto" });
  });

  it("starts a new customer-list view record when the JST day changes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const listAt = async (iso: string) => {
      vi.setSystemTime(new Date(iso));
      token = createAccessJwtFixture({
        issuer: TEAM_DOMAIN,
        audience: ACCESS_AUD,
        keyId: "staff-access-key-1",
        claims: { email: ADMIN_EMAIL, sub: ADMIN_SUBJECT },
        signingKey
      }).token;
      expect((await request("/api/admin/customers?mode=list")).status).toBe(200);
    };
    await listAt("2026-10-14T14:59:00.000Z"); // 23:59 JST on 10/14
    await listAt("2026-10-14T15:01:00.000Z"); // 00:01 JST on 10/15
    await listAt("2026-10-14T15:30:00.000Z");
    expect((listViewRows() as Array<{ id: string }>).map((row) => row.id)).toEqual([
      `customer_list_view:${ADMIN_ID}:2026-10-14`,
      `customer_list_view:${ADMIN_ID}:2026-10-15`
    ]);
  });

  it.each(["cross-site", "same-site"])("does not let a %s request claim the day's view record", async (site) => {
    const forged = await createApp().request(`${ADMIN_ORIGIN}/api/admin/customers?mode=list`, {
      headers: { "Cf-Access-Jwt-Assertion": token, "Sec-Fetch-Site": site }
    }, { DB: db, ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD });
    expect(forged.status).toBe(200);
    expect(listViewRows()).toEqual([]);
    expect((await request("/api/admin/customers?mode=list")).status).toBe(200);
    expect(listViewRows()).toHaveLength(1);
  });

  it.each([undefined, "none"])("records a list view with Sec-Fetch-Site %s", async (site) => {
    const response = await createApp().request(`${ADMIN_ORIGIN}/api/admin/customers?mode=list`, {
      headers: { "Cf-Access-Jwt-Assertion": token, ...(site ? { "Sec-Fetch-Site": site } : {}) }
    }, { DB: db, ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD });
    expect(response.status).toBe(200);
    expect(listViewRows()).toHaveLength(1);
  });

  it("shows the staff member's name for the view record in the activity log", async () => {
    expect((await request("/api/admin/customers?mode=list")).status).toBe(200);
    db.sqlite.prepare("UPDATE admin_users SET role = 'owner' WHERE id = ?").run(ADMIN_ID);
    const response = await request("/api/admin/audit-logs");
    const body = await response.json() as { auditLogs: Array<{ action: string; actorName: string | null }> };
    expect(response.status).toBe(200);
    expect(body.auditLogs.find((log) => log.action === "customer.list_view")?.actorName).toBe("Example Staff A");
  });

  it.each(["owner", "system_admin"])("does not record %s customer-list views", async (role) => {
    db.sqlite.prepare("UPDATE admin_users SET role = ?, staff_member_id = NULL WHERE id = ?").run(role, ADMIN_ID);
    expect((await request("/api/admin/customers?mode=list")).status).toBe(200);
    expect(listViewRows()).toEqual([]);
  });

  it("still lists customers when the view record cannot be written, and reports the failure", async () => {
    vi.mocked(safeCaptureException).mockClear();
    db.sqlite.exec("DROP TABLE audit_logs");
    const response = await request("/api/admin/customers?mode=list");
    const body = await response.json() as { customers: Array<{ id: string }> };
    expect(response.status).toBe(200);
    expect(body.customers.map((customer) => customer.id)).toContain(CUSTOMER_A);
    expect(safeCaptureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { component: "admin-customer-list", outcome: "list_view_audit_failed" }
    });
  });
});
