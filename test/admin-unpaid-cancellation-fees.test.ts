import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import type { AdminUser } from "../src/admin/access";
import { listUnpaidCancellationFees } from "../src/admin/reservations";
import { createAccessJwtFixture as createAccessJwtFixtureBase, createAccessJwksFetchMock, insertAdminUser as insertAdminUserHelper, type AdminRole } from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const TEAM_DOMAIN = "https://team.example.cloudflareaccess.com";
const ACCESS_AUD = "admin-unpaid-cancellation-fees-aud";
const ADMIN_EMAIL = "unpaid-fees@example.com";
const ADMIN_ACCESS_SUBJECT = "access-subject-unpaid-fees";

const OWNER_USER: AdminUser = {
  id: "admin_unpaid_fees",
  email: ADMIN_EMAIL,
  role: "owner",
  staff_member_id: null,
  store_id: null
};

const createAccessJwtFixture = () =>
  createAccessJwtFixtureBase({
    issuer: TEAM_DOMAIN,
    audience: ACCESS_AUD,
    keyId: "unpaid-fees-key-1",
    claims: { email: ADMIN_EMAIL, sub: ADMIN_ACCESS_SUBJECT }
  });

const insertAdminUser = (
  db: SqliteD1Database,
  role: "staff" | "owner",
  storeId?: string
) => {
  const staffMemberId = role === "staff" && storeId ? "staff_unpaid_fees" : null;
  if (staffMemberId && storeId) {
    db.sqlite
      .prepare(
        `INSERT INTO staff_members (id, store_id, display_name, role, active, updated_at)
         VALUES (?, ?, '未納確認スタッフ', 'staff', 1, '2026-07-27T00:00:00.000Z')`
      )
      .run(staffMemberId, storeId);
  }
  insertAdminUserHelper(db, {
    id: "admin_unpaid_fees",
    email: ADMIN_EMAIL,
    accessSubject: ADMIN_ACCESS_SUBJECT,
    role,
    staffMemberId,
    updatedAt: "2026-07-27T00:00:00.000Z",
  });
};

const insertReservation = (
  db: SqliteD1Database,
  input: {
    id: string;
    storeId: "kyoto" | "osaka";
    customerName: string;
    status: string;
    startAt: string;
    endAt: string;
    unpaidAt: string | null;
  }
) => {
  const customerId = `customer_${input.id}`;
  db.sqlite
    .prepare(
      `INSERT INTO customers (id, display_name, block_status, updated_at)
       VALUES (?, ?, 'active', '2026-07-27T00:00:00.000Z')`
    )
    .run(customerId, input.customerName);
  db.sqlite
    .prepare(
      `INSERT INTO reservations (
         id, store_id, service_id, customer_id, resource_id, source, status,
         start_at, end_at, duration_minutes, cancellation_fee_unpaid_at,
         idempotency_key, google_sync_state, version, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'admin', ?, ?, ?, 60, ?, ?, 'pending', 1, '2026-07-27T00:00:00.000Z')`
    )
    .run(
      input.id,
      input.storeId,
      `service_${input.storeId}_default_60`,
      customerId,
      `resource_${input.storeId}_calendar`,
      input.status,
      input.startAt,
      input.endAt,
      input.unpaidAt,
      `idem_${input.id}`
    );
};

const seedReservations = (db: SqliteD1Database) => {
  insertReservation(db, {
    id: "res_unpaid_old_kyoto",
    storeId: "kyoto",
    customerName: "京都 未納",
    status: "no_show",
    startAt: "2026-06-10T01:00:00.000Z",
    endAt: "2026-06-10T02:00:00.000Z",
    unpaidAt: "2026-01-01T00:00:00.000Z"
  });
  insertReservation(db, {
    id: "res_unpaid_new_osaka",
    storeId: "osaka",
    customerName: "大阪 未納",
    status: "cancelled_by_admin",
    startAt: "2026-02-10T01:00:00.000Z",
    endAt: "2026-02-10T02:00:00.000Z",
    unpaidAt: "2026-03-01T00:00:00.000Z"
  });
  insertReservation(db, {
    id: "res_paid_kyoto",
    storeId: "kyoto",
    customerName: "京都 支払済",
    status: "confirmed",
    startAt: "2026-01-10T01:00:00.000Z",
    endAt: "2026-01-10T02:00:00.000Z",
    unpaidAt: null
  });

  db.sqlite
    .prepare(
      `INSERT INTO reservation_services (
         reservation_id, service_id, display_order, name_snapshot, duration_minutes
       ) VALUES
         ('res_unpaid_old_kyoto', 'service_kyoto_hair_removal_beard_30', 1, '追加メニュー', 30),
         ('res_unpaid_old_kyoto', 'service_kyoto_default_60', 0, '基本メニュー', 60)`
    )
    .run();
};

const requestUnpaidCancellationFees = (
  db: SqliteD1Database,
  access: ReturnType<typeof createAccessJwtFixture>
) => {
  vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));
  return createApp().request(
    "/api/admin/reservations/unpaid-cancellation-fees",
    { headers: { "Cf-Access-Jwt-Assertion": access.token } },
    {
      ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
      ACCESS_AUD,
      DB: db
    }
  );
};

describe("GET /api/admin/reservations/unpaid-cancellation-fees", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns every unpaid reservation to an owner, oldest unpaid first", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedReservations(db);

      const response = await requestUnpaidCancellationFees(db, createAccessJwtFixture());

      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toEqual({
        ok: true,
        truncated: false,
        reservations: [
          {
            id: "res_unpaid_old_kyoto",
            status: "no_show",
            storeId: "kyoto",
            storeName: "ExampleStore A",
            serviceNames: "基本メニュー / 追加メニュー",
            startAt: "2026-06-10T01:00:00.000Z",
            endAt: "2026-06-10T02:00:00.000Z",
            customerDisplayName: "京都 未納",
            cancellationFeeUnpaidAt: "2026-01-01T00:00:00.000Z"
          },
          {
            id: "res_unpaid_new_osaka",
            status: "cancelled_by_admin",
            storeId: "osaka",
            storeName: "ExampleStore B",
            serviceNames: "マッサージ｜サンプル 04",
            startAt: "2026-02-10T01:00:00.000Z",
            endAt: "2026-02-10T02:00:00.000Z",
            customerDisplayName: "大阪 未納",
            cancellationFeeUnpaidAt: "2026-03-01T00:00:00.000Z"
          }
        ]
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("returns only the staff member's store", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "staff", "kyoto");
      seedReservations(db);

      const response = await requestUnpaidCancellationFees(db, createAccessJwtFixture());
      const body = await response.json() as {
        ok: boolean;
        reservations: Array<{ id: string; storeId: string }>;
      };

      expect(response.status).toBe(200);
      expect(body.reservations.map(({ id, storeId }) => ({ id, storeId }))).toEqual([
        { id: "res_unpaid_old_kyoto", storeId: "kyoto" }
      ]);
    } finally {
      db.sqlite.close();
    }
  });

  it("flags truncation instead of silently dropping unpaid rows", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedReservations(db);
      // 未納フラグには承認待ちのような TTL が無く積み上がる。上限に当たったことが
      // 呼び出し側に伝わらないと、見えている分が全件だと誤解して回収漏れになる。
      const capped = await listUnpaidCancellationFees({
        db: db as unknown as D1Database,
        admin: OWNER_USER,
        limit: 1
      });
      expect(capped.reservations.map((r) => r.id)).toEqual(["res_unpaid_old_kyoto"]);
      expect(capped.truncated).toBe(true);

      const full = await listUnpaidCancellationFees({
        db: db as unknown as D1Database,
        admin: OWNER_USER,
        limit: 2
      });
      expect(full.reservations).toHaveLength(2);
      expect(full.truncated).toBe(false);
    } finally {
      db.sqlite.close();
    }
  });

  it("returns an empty list for staff without a store binding", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "staff");
      seedReservations(db);

      const response = await requestUnpaidCancellationFees(db, createAccessJwtFixture());

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, reservations: [], truncated: false });
    } finally {
      db.sqlite.close();
    }
  });
});
