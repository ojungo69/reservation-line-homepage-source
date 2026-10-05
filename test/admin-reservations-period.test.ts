import type { KeyObject } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import { createAccessJwksFetchMock, createAccessJwtFixture as createAccessJwtFixtureBase, type AccessJwtFixture, insertAdminUser as insertAdminUserHelper, type AdminRole } from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const TEAM_DOMAIN = "https://team.example.cloudflareaccess.com";
const ACCESS_AUD = "admin-access-aud";
const OWNER_EMAIL = "owner@example.com";
const STAFF_EMAIL = "staff@example.com";
const OWNER_SUBJECT = "owner-subject-1";
const STAFF_SUBJECT = "staff-subject-1";

const KEY_ID = "test-access-key-1";

const createAccessJwtFixture = (
  payloadOverrides: Record<string, unknown> = {},
  reusePrivateKey?: KeyObject,
  reuseJwk?: AccessJwtFixture["jwk"]
): AccessJwtFixture =>
  createAccessJwtFixtureBase({
    issuer: TEAM_DOMAIN,
    audience: ACCESS_AUD,
    keyId: KEY_ID,
    claims: { email: OWNER_EMAIL, sub: OWNER_SUBJECT, ...payloadOverrides },
    signingKey: reusePrivateKey && reuseJwk ? { privateKey: reusePrivateKey, jwk: reuseJwk } : undefined
  });

const createFetchMock = (jwk: AccessJwtFixture["jwk"]) => createAccessJwksFetchMock(TEAM_DOMAIN, jwk);

const baseEnv = (db: SqliteD1Database): Record<string, unknown> => ({
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  ACCESS_AUD,
  DB: db
});

const insertAdminUser = (
  db: SqliteD1Database,
  id: string,
  email: string,
  subject: string,
  role: AdminRole
) =>
  insertAdminUserHelper(db, {
    id,
    email,
    accessSubject: subject,
    role,
    updatedAt: "2026-05-09T00:00:00.000Z",
  });

const insertCustomer = (
  db: SqliteD1Database,
  id: string,
  displayName: string,
  kana: string | null,
  phone: string | null
) => {
  db.sqlite
    .prepare(
      `INSERT INTO customers (id, display_name, display_name_kana, phone_normalized, phone_hash, block_status, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', '2026-05-09T00:00:00.000Z')`
    )
    .run(id, displayName, kana, phone, phone ? `phone_hash_${id}` : null);
};

const insertReservation = (
  db: SqliteD1Database,
  args: {
    id: string;
    customerId: string;
    storeId: string;
    serviceId: string;
    resourceId: string;
    status: string;
    startAt: string;
    endAt: string;
    source?: string;
  }
) => {
  db.sqlite
    .prepare(
      `INSERT INTO reservations (
        id, store_id, service_id, customer_id, resource_id, line_identity_id,
        source, status, start_at, end_at, duration_minutes, pending_expires_at,
        created_by, updated_by, idempotency_key, google_sync_state, version, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, NULL,
        ?, ?, ?, ?, 60, '2026-12-31T00:00:00.000Z',
        'test', 'test', ?, 'pending', 1, '2026-05-09T00:00:00.000Z'
      )`
    )
    .run(
      args.id,
      args.storeId,
      args.serviceId,
      args.customerId,
      args.resourceId,
      args.source ?? "phone_admin",
      args.status,
      args.startAt,
      args.endAt,
      `idem_${args.id}`
    );
};

const insertStaffMember = (
  db: SqliteD1Database,
  id: string,
  storeId: string,
  displayName: string,
  role: "owner" | "staff" | "system_admin" = "staff"
) => {
  db.sqlite
    .prepare(
      `INSERT INTO staff_members (id, store_id, display_name, role, active, updated_at)
       VALUES (?, ?, ?, ?, 1, '2026-05-09T00:00:00.000Z')`
    )
    .run(id, storeId, displayName, role);
};

const linkAdminUserToStaffMember = (
  db: SqliteD1Database,
  adminUserId: string,
  staffMemberId: string
) => {
  db.sqlite
    .prepare(`UPDATE admin_users SET staff_member_id = ? WHERE id = ?`)
    .run(staffMemberId, adminUserId);
};

const seedCheckedInFixture = (db: SqliteD1Database) => {
  insertAdminUser(db, "admin_owner_1", OWNER_EMAIL, OWNER_SUBJECT, "owner");
  insertCustomer(db, "cust_a", "山田 太郎", "ヤマダ タロウ", "08012345678");

  insertReservation(db, {
    id: "rsv_confirmed_only",
    customerId: "cust_a",
    storeId: "kyoto",
    serviceId: "service_kyoto_default_60",
    resourceId: "resource_kyoto_calendar",
    status: "confirmed",
    startAt: "2026-06-10T01:00:00.000Z",
    endAt: "2026-06-10T02:00:00.000Z"
  });
  insertReservation(db, {
    id: "rsv_checked_in",
    customerId: "cust_a",
    storeId: "kyoto",
    serviceId: "service_kyoto_default_60",
    resourceId: "resource_kyoto_calendar",
    status: "confirmed",
    startAt: "2026-06-20T01:00:00.000Z",
    endAt: "2026-06-20T02:00:00.000Z"
  });
  db.sqlite
    .prepare(`UPDATE reservations SET checked_in_at = ? WHERE id = ?`)
    .run("2026-06-20T01:05:00.000Z", "rsv_checked_in");
};

const seedStaffStoreScopeFixture = (db: SqliteD1Database) => {
  insertAdminUser(db, "admin_owner_1", OWNER_EMAIL, OWNER_SUBJECT, "owner");
  insertAdminUser(db, "admin_staff_kyoto", STAFF_EMAIL, STAFF_SUBJECT, "staff");
  insertStaffMember(db, "staff_member_kyoto_1", "kyoto", "京都店 スタッフ");
  linkAdminUserToStaffMember(db, "admin_staff_kyoto", "staff_member_kyoto_1");

  insertCustomer(db, "cust_k", "京都 太郎", "キョウト タロウ", "08011110000");
  insertCustomer(db, "cust_o", "大阪 花子", "オオサカ ハナコ", "09022220000");

  insertReservation(db, {
    id: "rsv_kyoto_1",
    customerId: "cust_k",
    storeId: "kyoto",
    serviceId: "service_kyoto_default_60",
    resourceId: "resource_kyoto_calendar",
    status: "confirmed",
    startAt: "2026-06-05T01:00:00.000Z",
    endAt: "2026-06-05T02:00:00.000Z"
  });
  insertReservation(db, {
    id: "rsv_osaka_1",
    customerId: "cust_o",
    storeId: "osaka",
    serviceId: "service_osaka_default_60",
    resourceId: "resource_osaka_calendar",
    status: "confirmed",
    startAt: "2026-06-06T01:00:00.000Z",
    endAt: "2026-06-06T02:00:00.000Z"
  });
};

const seedFixtures = (db: SqliteD1Database) => {
  insertAdminUser(db, "admin_owner_1", OWNER_EMAIL, OWNER_SUBJECT, "owner");
  insertAdminUser(db, "admin_staff_1", STAFF_EMAIL, STAFF_SUBJECT, "staff");

  insertCustomer(db, "cust_a", "山田 太郎", "ヤマダ タロウ", "08012345678");
  insertCustomer(db, "cust_b", "佐藤 花子", "サトウ ハナコ", "09098765432");

  insertReservation(db, {
    id: "rsv_a_confirmed",
    customerId: "cust_a",
    storeId: "kyoto",
    serviceId: "service_kyoto_default_60",
    resourceId: "resource_kyoto_calendar",
    status: "confirmed",
    startAt: "2026-06-01T01:00:00.000Z",
    endAt: "2026-06-01T02:00:00.000Z"
  });
  insertReservation(db, {
    id: "rsv_b_pending",
    customerId: "cust_b",
    storeId: "kyoto",
    serviceId: "service_kyoto_default_60",
    resourceId: "resource_kyoto_calendar",
    status: "pending_approval",
    startAt: "2026-06-15T03:00:00.000Z",
    endAt: "2026-06-15T04:00:00.000Z"
  });
};

// Bulk-seed helper used by boundary tests. Reuses a single customer + a
// prepared INSERT inside an explicit transaction so 25K rows take ~1s on
// the in-memory sqlite, instead of ~30s with one prepare per row.
const seedReservationsBulk = (
  db: SqliteD1Database,
  count: number,
  startAtBase: Date = new Date("2026-06-01T00:00:00.000Z")
) => {
  insertAdminUser(db, "admin_owner_bulk", OWNER_EMAIL, OWNER_SUBJECT, "owner");
  insertCustomer(db, "cust_bulk", "ベンチ 太郎", "ベンチ タロウ", "0800000000");
  const stmt = db.sqlite.prepare(
    `INSERT INTO reservations (
      id, store_id, service_id, customer_id, resource_id, line_identity_id,
      source, status, start_at, end_at, duration_minutes, pending_expires_at,
      created_by, updated_by, idempotency_key, google_sync_state, version, updated_at
    ) VALUES (
      ?, 'kyoto', 'service_kyoto_default_60', 'cust_bulk', 'resource_kyoto_calendar', NULL,
      'phone_admin', 'confirmed', ?, ?, 60, '2026-12-31T00:00:00.000Z',
      'test', 'test', ?, 'pending', 1, '2026-05-09T00:00:00.000Z'
    )`
  );
  db.sqlite.prepare("BEGIN").run();
  try {
    for (let i = 0; i < count; i += 1) {
      const startMs = startAtBase.getTime() + i * 60_000;
      const startAt = new Date(startMs).toISOString();
      const endAt = new Date(startMs + 60_000).toISOString();
      stmt.run(`rsv_bulk_${i}`, startAt, endAt, `idem_bulk_${i}`);
    }
    db.sqlite.prepare("COMMIT").run();
  } catch (err) {
    db.sqlite.prepare("ROLLBACK").run();
    throw err;
  }
};

const ownerRequest = async (
  db: SqliteD1Database,
  url: string,
  jwt: string,
  acceptHeader = "application/json"
) => {
  const app = createApp();
  return app.request(
    url,
    { headers: { "Cf-Access-Jwt-Assertion": jwt, Accept: acceptHeader } },
    baseEnv(db)
  );
};

const staffJwt = (baseFixture: AccessJwtFixture) =>
  createAccessJwtFixture(
    { email: STAFF_EMAIL, sub: STAFF_SUBJECT },
    baseFixture.privateKey,
    baseFixture.jwk
  );

describe("GET /api/admin/reservations/search", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns owner-visible matches inside the requested range", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedFixtures(db);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));
      const response = await ownerRequest(
        db,
        "/api/admin/reservations/search?from=2026-06-01&to=2026-06-30",
        access.token
      );
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        ok: boolean;
        reservations: Array<{ id: string; status: string }>;
        truncated: boolean;
        totalCount: number | null;
      };
      expect(payload.ok).toBe(true);
      expect(payload.truncated).toBe(false);
      expect(payload.totalCount).toBe(2);
      expect(payload.reservations.map((r) => r.id).sort()).toEqual([
        "rsv_a_confirmed",
        "rsv_b_pending"
      ]);
    } finally {
      db.sqlite.close();
    }
  });

  it("includes cancellationFeeUnpaidAt on each search result", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedFixtures(db);
      // Flag one reservation as cancellation-fee-unpaid.
      db.sqlite
        .prepare("UPDATE reservations SET cancellation_fee_unpaid_at = ? WHERE id = ?")
        .run("2026-06-01T03:00:00.000Z", "rsv_a_confirmed");
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));
      const response = await ownerRequest(
        db,
        "/api/admin/reservations/search?from=2026-06-01&to=2026-06-30",
        access.token
      );
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        reservations: Array<{ id: string; cancellationFeeUnpaidAt: string | null }>;
      };
      const byId = new Map(payload.reservations.map((r) => [r.id, r.cancellationFeeUnpaidAt]));
      // Field is present on every row (contract), set on the flagged one, null otherwise.
      expect(byId.has("rsv_a_confirmed")).toBe(true);
      expect(byId.get("rsv_a_confirmed")).toBe("2026-06-01T03:00:00.000Z");
      expect(byId.get("rsv_b_pending")).toBeNull();
    } finally {
      db.sqlite.close();
    }
  });

  it("includes customerId on each search result (admin UI links rows to the customer panel)", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedFixtures(db);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));
      const response = await ownerRequest(
        db,
        "/api/admin/reservations/search?from=2026-06-01&to=2026-06-30",
        access.token
      );
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        reservations: Array<{ id: string; customerId: string }>;
      };
      const byId = new Map(payload.reservations.map((r) => [r.id, r.customerId]));
      expect(byId.get("rsv_a_confirmed")).toBe("cust_a");
      expect(byId.get("rsv_b_pending")).toBe("cust_b");
    } finally {
      db.sqlite.close();
    }
  });

  it("filters by status array", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedFixtures(db);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));
      const response = await ownerRequest(
        db,
        "/api/admin/reservations/search?from=2026-06-01&to=2026-06-30&status=confirmed",
        access.token
      );
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        reservations: Array<{ id: string }>;
      };
      expect(payload.reservations.map((r) => r.id)).toEqual(["rsv_a_confirmed"]);
    } finally {
      db.sqlite.close();
    }
  });

  it("filters by keyword (kana hit)", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedFixtures(db);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));
      const response = await ownerRequest(
        db,
        "/api/admin/reservations/search?from=2026-06-01&to=2026-06-30&keyword=サトウ",
        access.token
      );
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        reservations: Array<{ id: string }>;
      };
      expect(payload.reservations.map((r) => r.id)).toEqual(["rsv_b_pending"]);
    } finally {
      db.sqlite.close();
    }
  });

  // Codex P2 review thread on operations.ts:512 — phone_normalized stores
  // digits only, so a formatted phone keyword like "080-1234-5678" must
  // still match a customer whose phone is stored as "08012345678".
  it("filters by phone keyword regardless of separators", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedFixtures(db);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));
      const response = await ownerRequest(
        db,
        `/api/admin/reservations/search?from=2026-06-01&to=2026-06-30&keyword=${encodeURIComponent("080-1234-5678")}`,
        access.token
      );
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        reservations: Array<{ id: string; customerDisplayName: string }>;
      };
      expect(payload.reservations.map((r) => r.id)).toEqual(["rsv_a_confirmed"]);
    } finally {
      db.sqlite.close();
    }
  });

  // Audit 2026-07-04 — buildKeywordFilterClause built an un-scoped
  // `phone_normalized LIKE '%digits%'` for every caller, including staff.
  // Staff only ever see the last-4 masked phone (mapReservationCsvRow nulls
  // googleEventId / masks elsewhere), so a substring LIKE let a store-scoped
  // staff member binary-search the masked middle digits via partial probes —
  // the same oracle shape PR#400 closed for searchAdminCustomers. Staff now
  // get an EXACT match: a full-number lookup still works, a partial probe
  // matches nothing; owner keeps the convenience substring LIKE.
  it("staff phone keyword search is exact-match (full number works, partial probe finds nothing) — closes the mask oracle", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedStaffStoreScopeFixture(db);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));
      const staffToken = staffJwt(access).token;

      // Staff: a FULL-number lookup still works.
      const staffFull = await ownerRequest(
        db,
        `/api/admin/reservations/search?from=2026-06-01&to=2026-06-30&keyword=${encodeURIComponent("08011110000")}`,
        staffToken
      );
      expect(staffFull.status).toBe(200);
      const staffFullPayload = (await staffFull.json()) as { reservations: Array<{ id: string }> };
      expect(staffFullPayload.reservations.map((r) => r.id)).toEqual(["rsv_kyoto_1"]);

      // Staff: 国際表記で打っても同じ番号に当たる。保存側は国内表記に正規化されている
      // ので、ここは「入力の表記ゆれを検索が吸収するか」を見ている
      // (chatgpt-codex-connector P2 on PR#418 / issue #639)。
      const staffIntl = await ownerRequest(
        db,
        `/api/admin/reservations/search?from=2026-06-01&to=2026-06-30&keyword=${encodeURIComponent("+818011110000")}`,
        staffToken
      );
      expect(staffIntl.status).toBe(200);
      const staffIntlPayload = (await staffIntl.json()) as { reservations: Array<{ id: string }> };
      expect(staffIntlPayload.reservations.map((r) => r.id)).toEqual(["rsv_kyoto_1"]);

      // Staff: a PARTIAL digit probe (what a recovery oracle needs) matches nothing.
      const staffPartial = await ownerRequest(
        db,
        `/api/admin/reservations/search?from=2026-06-01&to=2026-06-30&keyword=${encodeURIComponent("8011")}`,
        staffToken
      );
      expect(staffPartial.status).toBe(200);
      const staffPartialPayload = (await staffPartial.json()) as { reservations: Array<{ id: string }> };
      expect(staffPartialPayload.reservations).toEqual([]);

      // Owner: substring LIKE is preserved for convenience (partial probe matches).
      const ownerPartial = await ownerRequest(
        db,
        `/api/admin/reservations/search?from=2026-06-01&to=2026-06-30&keyword=${encodeURIComponent("8011")}`,
        access.token
      );
      expect(ownerPartial.status).toBe(200);
      const ownerPartialPayload = (await ownerPartial.json()) as { reservations: Array<{ id: string }> };
      expect(ownerPartialPayload.reservations.map((r) => r.id)).toEqual(["rsv_kyoto_1"]);
    } finally {
      db.sqlite.close();
    }
  });

  // Codex P1 review thread on operations.ts:500 — legacy reservations carry
  // only the single `reservations.service_id` column with no junction rows.
  // The serviceId filter must still surface them so historical CSV export
  // is complete.
  it("filters by serviceId for legacy reservations without reservation_services rows", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedFixtures(db);
      // rsv_a_confirmed and rsv_b_pending are seeded WITHOUT reservation_services
      // rows (insertReservation only writes the legacy single-service column).
      // The filter must still match them via reservations.service_id.
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));
      const response = await ownerRequest(
        db,
        "/api/admin/reservations/search?from=2026-06-01&to=2026-06-30&serviceId=service_kyoto_default_60",
        access.token
      );
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        reservations: Array<{ id: string }>;
      };
      expect(payload.reservations.map((r) => r.id).sort()).toEqual([
        "rsv_a_confirmed",
        "rsv_b_pending"
      ]);
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects ranges longer than 92 days", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedFixtures(db);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));
      const response = await ownerRequest(
        db,
        "/api/admin/reservations/search?from=2026-01-01&to=2026-04-15",
        access.token
      );
      expect(response.status).toBe(400);
      const payload = (await response.json()) as { ok: boolean; reason: string };
      expect(payload).toEqual({ ok: false, reason: "range_too_large" });
    } finally {
      db.sqlite.close();
    }
  });

  it("accepts a 92-day range exactly", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedFixtures(db);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));
      const response = await ownerRequest(
        db,
        "/api/admin/reservations/search?from=2026-04-01&to=2026-07-01",
        access.token
      );
      expect(response.status).toBe(200);
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects an unknown status value", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedFixtures(db);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));
      const response = await ownerRequest(
        db,
        "/api/admin/reservations/search?from=2026-06-01&to=2026-06-02&status=bogus",
        access.token
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "invalid_status"
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects an invalid storeId pattern as invalid_filter", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedFixtures(db);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));
      const response = await ownerRequest(
        db,
        "/api/admin/reservations/search?from=2026-06-01&to=2026-06-02&storeId=" +
          encodeURIComponent("../../etc/passwd"),
        access.token
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "invalid_filter"
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects an over-long keyword as invalid_keyword", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedFixtures(db);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));
      const longKeyword = "あ".repeat(20); // 60 bytes after %escape% wrap > 50B budget
      const response = await ownerRequest(
        db,
        `/api/admin/reservations/search?from=2026-06-01&to=2026-06-02&keyword=${encodeURIComponent(longKeyword)}`,
        access.token
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "invalid_keyword"
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("denies staff without an assigned store with 403", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedFixtures(db);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));
      const staffToken = staffJwt(access).token;
      const response = await ownerRequest(
        db,
        "/api/admin/reservations/search?from=2026-06-01&to=2026-06-02",
        staffToken
      );
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "forbidden"
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("status=checked_in returns only confirmed rows with checked_in_at set (virtual status branch)", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedCheckedInFixture(db);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));
      const response = await ownerRequest(
        db,
        "/api/admin/reservations/search?from=2026-06-01&to=2026-06-30&status=checked_in",
        access.token
      );
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        reservations: Array<{ id: string; status: string }>;
      };
      expect(payload.reservations.map((r) => r.id)).toEqual(["rsv_checked_in"]);
      expect(payload.reservations[0].status).toBe("checked_in");
    } finally {
      db.sqlite.close();
    }
  });

  it("status=confirmed excludes virtual checked_in rows (confirmed-only guard)", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedCheckedInFixture(db);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));
      const response = await ownerRequest(
        db,
        "/api/admin/reservations/search?from=2026-06-01&to=2026-06-30&status=confirmed",
        access.token
      );
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        reservations: Array<{ id: string; status: string }>;
      };
      expect(payload.reservations.map((r) => r.id)).toEqual(["rsv_confirmed_only"]);
      expect(payload.reservations[0].status).toBe("confirmed");
    } finally {
      db.sqlite.close();
    }
  });

  it("status=confirmed&status=checked_in returns both branches (OR clause)", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedCheckedInFixture(db);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));
      const response = await ownerRequest(
        db,
        "/api/admin/reservations/search?from=2026-06-01&to=2026-06-30&status=confirmed&status=checked_in",
        access.token
      );
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        reservations: Array<{ id: string; status: string }>;
      };
      const byId = new Map(payload.reservations.map((r) => [r.id, r.status]));
      expect(byId.get("rsv_confirmed_only")).toBe("confirmed");
      expect(byId.get("rsv_checked_in")).toBe("checked_in");
      expect(payload.reservations).toHaveLength(2);
    } finally {
      db.sqlite.close();
    }
  });

  it("staff with store_id sees only their own store's reservations", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedStaffStoreScopeFixture(db);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));
      const staffToken = staffJwt(access).token;
      const response = await ownerRequest(
        db,
        "/api/admin/reservations/search?from=2026-06-01&to=2026-06-30",
        staffToken
      );
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        reservations: Array<{ id: string; storeId?: string }>;
      };
      expect(payload.reservations.map((r) => r.id)).toEqual(["rsv_kyoto_1"]);
    } finally {
      db.sqlite.close();
    }
  });

  it("staff cannot widen scope by supplying a different storeId query param", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedStaffStoreScopeFixture(db);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));
      const staffToken = staffJwt(access).token;
      const response = await ownerRequest(
        db,
        "/api/admin/reservations/search?from=2026-06-01&to=2026-06-30&storeId=osaka",
        staffToken
      );
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        reservations: Array<{ id: string }>;
      };
      // staff's own store_id (kyoto) overrides the requested storeId=osaka
      expect(payload.reservations.map((r) => r.id)).toEqual(["rsv_kyoto_1"]);
      expect(payload.reservations.map((r) => r.id)).not.toContain("rsv_osaka_1");
    } finally {
      db.sqlite.close();
    }
  });
});

describe("GET /api/admin/reservations/export.csv", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns text/csv with BOM, header, and one data row per match", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedFixtures(db);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));
      const response = await ownerRequest(
        db,
        "/api/admin/reservations/export.csv?from=2026-06-01&to=2026-06-30",
        access.token,
        "text/csv"
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/csv");
      expect(response.headers.get("Content-Disposition")).toMatch(
        /attachment; filename="reservations_2026-06-01_2026-06-30_\d+\.csv"/
      );
      const buffer = new Uint8Array(await response.arrayBuffer());
      expect(buffer[0]).toBe(0xef);
      expect(buffer[1]).toBe(0xbb);
      expect(buffer[2]).toBe(0xbf);
      const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(buffer);
      const lines = text.replace(/^\uFEFF/, "").split("\n").filter((l) => l.length > 0);
      // header + 2 reservation rows
      expect(lines).toHaveLength(3);
      // 列契約の固定: 検索 JSON に customerId を足しても CSV の列は増やさない
      // (reservationCsvLine は明示的な固定列リストを書く)。
      expect(lines[0]).toBe("予約ID,開始,終了,店舗,メニュー,顧客名,カナ,電話末尾,状態,LINE,予約経路,Googleイベント連携ID");
      expect(lines[1]?.split(",")).toHaveLength(12);
      expect(text).not.toContain("cust_a");
      // masked phone visible — raw 08012345678 must NOT appear
      expect(text).toContain("***-****-5678");
      expect(text).not.toContain("08012345678");
    } finally {
      db.sqlite.close();
    }
  });

  it("denies staff without an assigned store with 403", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedFixtures(db);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));
      const staffToken = staffJwt(access).token;
      const response = await ownerRequest(
        db,
        "/api/admin/reservations/export.csv?from=2026-06-01&to=2026-06-02",
        staffToken,
        "text/csv"
      );
      expect(response.status).toBe(403);
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 200 + BOM + header only when result is empty (NOT 204, Excel breaks)", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedFixtures(db);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));
      const response = await ownerRequest(
        db,
        "/api/admin/reservations/export.csv?from=2030-01-01&to=2030-01-02",
        access.token,
        "text/csv"
      );
      expect(response.status).toBe(200);
      const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
        new Uint8Array(await response.arrayBuffer())
      );
      const lines = text.replace(/^\uFEFF/, "").split("\n").filter((l) => l.length > 0);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("予約ID");
    } finally {
      db.sqlite.close();
    }
  });

  it("staff with store_id exports only their own store's CSV rows", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedStaffStoreScopeFixture(db);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));
      const staffToken = staffJwt(access).token;
      const response = await ownerRequest(
        db,
        "/api/admin/reservations/export.csv?from=2026-06-01&to=2026-06-30",
        staffToken,
        "text/csv"
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/csv");
      const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
        new Uint8Array(await response.arrayBuffer())
      );
      // kyoto reservation row is present, osaka row must not leak
      expect(text).toContain("rsv_kyoto_1");
      expect(text).not.toContain("rsv_osaka_1");
      const lines = text.replace(/^\uFEFF/, "").split("\n").filter((l) => l.length > 0);
      // header + 1 kyoto row
      expect(lines).toHaveLength(2);
    } finally {
      db.sqlite.close();
    }
  });
});

// Codex blocking #3 regression: the static /search and /export.csv routes
// must be registered BEFORE /:id, otherwise Hono swallows them as id="search"
// / id="export.csv" lookups returning 404. These two assertions pin that
// ordering — if a future refactor moves the routes around, the tests fail.
describe("admin reservations route order regression", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("/search is owned by the period-search handler (not the :id detail handler)", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedFixtures(db);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));
      const response = await ownerRequest(
        db,
        "/api/admin/reservations/search?from=2026-06-01&to=2026-06-30",
        access.token
      );
      // Detail handler returns 404 with `reason: not_found` for unknown ids;
      // the search handler returns 200 with `truncated: false`.
      expect(response.status).toBe(200);
      const payload = (await response.json()) as { truncated?: boolean };
      expect(payload.truncated).toBe(false);
    } finally {
      db.sqlite.close();
    }
  });

  it("/export.csv is owned by the CSV handler (not the :id detail handler)", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedFixtures(db);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));
      const response = await ownerRequest(
        db,
        "/api/admin/reservations/export.csv?from=2026-06-01&to=2026-06-02",
        access.token,
        "text/csv"
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/csv");
    } finally {
      db.sqlite.close();
    }
  });

  it("/:id handler still matches concrete ids", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedFixtures(db);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));
      const response = await ownerRequest(
        db,
        "/api/admin/reservations/rsv_a_confirmed",
        access.token
      );
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        reservation?: { id: string };
      };
      expect(payload.reservation?.id).toBe("rsv_a_confirmed");
    } finally {
      db.sqlite.close();
    }
  });
});

// Codex iter1 blocking: pin the truncation boundary at the exact LIMIT
// values published in the API contract (search=500/501, export=25K/25001).
// Without these the contract drifts silently if a future refactor changes
// LIMIT off by one.
describe("admin reservations boundary tests", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("search returns truncated:false + totalCount=500 at exactly 500 matches", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedReservationsBulk(db, 500);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));
      const response = await ownerRequest(
        db,
        "/api/admin/reservations/search?from=2026-06-01&to=2026-06-02",
        access.token
      );
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        reservations: unknown[];
        truncated: boolean;
        totalCount: number | null;
      };
      expect(payload.reservations).toHaveLength(500);
      expect(payload.truncated).toBe(false);
      expect(payload.totalCount).toBe(500);
    } finally {
      db.sqlite.close();
    }
  });

  it("search returns truncated:true + totalCount=null + 500 rows when 501 match", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedReservationsBulk(db, 501);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));
      const response = await ownerRequest(
        db,
        "/api/admin/reservations/search?from=2026-06-01&to=2026-06-02",
        access.token
      );
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        reservations: unknown[];
        truncated: boolean;
        totalCount: number | null;
      };
      expect(payload.reservations).toHaveLength(500);
      expect(payload.truncated).toBe(true);
      expect(payload.totalCount).toBeNull();
    } finally {
      db.sqlite.close();
    }
  });

  it("export returns 200 CSV at exactly 25,000 matches", async () => {
    const db = createMigratedSqliteD1();
    try {
      // 25,000 minutes ≒ 17.4 days, within the 92-day cap.
      seedReservationsBulk(db, 25_000);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));
      const response = await ownerRequest(
        db,
        "/api/admin/reservations/export.csv?from=2026-06-01&to=2026-06-30",
        access.token,
        "text/csv"
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/csv");
    } finally {
      db.sqlite.close();
    }
  }, 30_000);

  it("export returns 413 result_too_large at 30,001 rows (above PAGED_MAX_PAGES cap)", async () => {
    // codex iter 1 MAJOR fix: at 30,001 rows the paged streamer would
    // silently truncate at the 30K boundary if we didn't pre-flight check
    // the overflow before opening the stream. The pre-flight probes
    // OFFSET 30000 LIMIT 1; finding a row there means the result set
    // exceeds the cap → 413 with limit = 30000.
    const db = createMigratedSqliteD1();
    try {
      seedReservationsBulk(db, 30_001);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));
      const response = await ownerRequest(
        db,
        "/api/admin/reservations/export.csv?from=2026-06-01&to=2026-06-30",
        access.token,
        "text/csv"
      );
      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "result_too_large",
        limit: 30_000
      });
    } finally {
      db.sqlite.close();
    }
  }, 90_000);

  it("export streams 25,001 rows via paged CSV instead of returning 413 (Tier D.2)", async () => {
    // Pre-D.2 this returned HTTP 413 result_too_large because the single
    // D1 query hit `result_too_large` at 25K rows. The paged streamer in
    // reservationsCsvStreamPaged splits the fetch into 10K-row chunks
    // (PAGED_ROWS_PER_PAGE=10000, PAGED_MAX_PAGES=3 → 30K cap) so the
    // operator gets the full export without bumping into the per-query
    // response cap.
    const db = createMigratedSqliteD1();
    try {
      seedReservationsBulk(db, 25_001);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));
      const response = await ownerRequest(
        db,
        "/api/admin/reservations/export.csv?from=2026-06-01&to=2026-06-30",
        access.token,
        "text/csv"
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type") ?? "").toMatch(/^text\/csv/);
      const body = await response.text();
      // Header + BOM + N body rows. Count the CRLF-stripped line count.
      const lines = body.split("\n").filter((line) => line.length > 0);
      // 1 header line + 25001 data lines = 25002 lines.
      expect(lines).toHaveLength(25_002);
    } finally {
      db.sqlite.close();
    }
  }, 60_000);
});
