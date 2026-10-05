import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import { normalizePhone } from "../src/admin/shared";
import { sha256Hex } from "../src/admin/settings-common";
import { createAccessJwtFixture, createAccessJwksFetchMock, grantCustomerTabGate } from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

// Task 6: staff may manage ONLY their own store's customers. These are the
// route-level authorization tests (the domain store-scope SQL is covered in
// admin-customers-search.test.ts). Owner / system_admin keep the full all-store view.

const TEAM_DOMAIN = "https://team.example.cloudflareaccess.com";
const ACCESS_AUD = "staff-customer-scope-aud";
const ADMIN_EMAIL = "scope-admin@example.com";
const ADMIN_SUBJECT = "access-subject-staff-customer-scope";

const makeAccessJwt = () =>
  createAccessJwtFixture({
    issuer: TEAM_DOMAIN,
    audience: ACCESS_AUD,
    keyId: "scope-test-key-1",
    claims: { email: ADMIN_EMAIL, sub: ADMIN_SUBJECT }
  });

// staffMemberId: 'staff_owner_kyoto' (seeded, store_id=kyoto) → staff store_id=kyoto.
// null → staff with no store binding (must fail closed).
const insertAdmin = (db: SqliteD1Database, role: "owner" | "staff", staffMemberId: string | null) => {
  db.sqlite
    .prepare(
      `INSERT INTO admin_users (id, email, access_subject, role, staff_member_id, active, updated_at)
       VALUES ('admin_scope_http', ?, ?, ?, ?, 1, '2026-05-22T00:00:00.000Z')`
    )
    .run(ADMIN_EMAIL, ADMIN_SUBJECT, role, staffMemberId);
  // spec 008 の顧客タブゲートは staff にだけ効く。このファイルが見ているのは店舗スコープ
  // なので、承認済みの状態から始める (ゲート自体は test/admin-customer-gate.test.ts)。
  if (role === "staff") grantCustomerTabGate(db, "admin_scope_http");
};

const endPlusHour = (startAt: string) => new Date(new Date(startAt).getTime() + 3_600_000).toISOString();

const seedData = (db: SqliteD1Database) => {
  db.sqlite.exec(`DELETE FROM reservations; DELETE FROM customer_visits; DELETE FROM customers;`);
  db.sqlite.exec(`
    INSERT INTO customers (id, display_name, display_name_kana, phone_normalized, block_status, archived_at, created_at, updated_at) VALUES
      ('c_kyoto',    '京都 太郎', 'キョウト タロウ', '08011110001', 'active', NULL, '2026-05-01T00:00:00Z', '2026-05-05T00:00:00Z'),
      ('c_osaka',    '大阪 花子', 'オオサカ ハナコ', '08011110002', 'active', NULL, '2026-05-02T00:00:00Z', '2026-05-04T00:00:00Z'),
      ('c_cross',    '横断 次郎', 'オウダン ジロウ', '08011110003', 'active', NULL, '2026-05-03T00:00:00Z', '2026-05-06T00:00:00Z'),
      ('c_archived', '済 四郎',   'スミ シロウ',     '08011110005', 'active', '2026-05-07T00:00:00Z', '2026-05-01T00:00:00Z', '2026-05-07T00:00:00Z');
  `);
  const resv = (id: string, customerId: string, storeId: string, status: string, startAt: string) =>
    db.sqlite
      .prepare(
        `INSERT INTO reservations (id, store_id, service_id, customer_id, resource_id, source, status, duration_minutes, idempotency_key, start_at, end_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'admin', ?, 60, ?, ?, ?, '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z')`
      )
      .run(id, storeId, `service_${storeId}_default_60`, customerId, `resource_${storeId}_calendar`, status, `ik_${id}`, startAt, endPlusHour(startAt));
  const visit = (id: string, customerId: string, storeId: string, visitedAt: string) =>
    db.sqlite
      .prepare(
        `INSERT INTO customer_visits (id, customer_id, reservation_id, store_id, visited_at, visit_source, status, recorded_by)
         VALUES (?, ?, NULL, ?, ?, 'manual_import', 'valid', 'admin_test')`
      )
      .run(id, customerId, storeId, visitedAt);

  resv("r_kyoto", "c_kyoto", "kyoto", "completed", "2026-04-01T10:00:00Z");
  visit("v_kyoto", "c_kyoto", "kyoto", "2026-04-01");
  resv("r_osaka", "c_osaka", "osaka", "completed", "2026-04-02T10:00:00Z");
  visit("v_osaka", "c_osaka", "osaka", "2026-04-02");
  // c_archived: archived but has a kyoto reservation + valid kyoto visit — still
  // owner-only (the archived gate must hold even for visit-notes editing).
  resv("r_arch", "c_archived", "kyoto", "completed", "2026-04-03T10:00:00Z");
  visit("v_arch", "c_archived", "kyoto", "2026-04-03");
  // c_cross: kyoto + osaka reservations and visits.
  resv("r_cross_k", "c_cross", "kyoto", "completed", "2026-04-04T10:00:00Z");
  resv("r_cross_o", "c_cross", "osaka", "completed", "2026-04-05T10:00:00Z");
  visit("v_cross_k", "c_cross", "kyoto", "2026-04-04");
  visit("v_cross_o", "c_cross", "osaka", "2026-04-05");
};

const env = (db: SqliteD1Database): Record<string, unknown> => ({
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  ACCESS_AUD,
  DB: db
});

const req = (
  db: SqliteD1Database,
  token: string,
  path: string,
  method: "GET" | "PUT" | "PATCH" | "POST" = "GET",
  body?: unknown
) => {
  const app = createApp();
  const headers: Record<string, string> = { "Cf-Access-Jwt-Assertion": token };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return app.request(
    path,
    { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined },
    env(db)
  );
};

/** JSON として壊れた body。ゲートが body より前なら中身は読まれない。 */
const rawPost = (db: SqliteD1Database, token: string, path: string, rawBody: string) =>
  createApp().request(
    path,
    {
      method: "POST",
      headers: { "Cf-Access-Jwt-Assertion": token, "Content-Type": "application/json" },
      body: rawBody
    },
    env(db)
  );

const ids = async (response: Response): Promise<string[]> => {
  const body = (await response.json()) as { customers?: Array<{ id: string }> };
  return (body.customers ?? []).map((c) => c.id).sort();
};

describe("staff customer store-scope — routes", () => {
  afterEach(() => vi.unstubAllGlobals());

  const setup = (role: "owner" | "staff", staffMemberId: string | null) => {
    const db = createMigratedSqliteD1();
    insertAdmin(db, role, staffMemberId);
    seedData(db);
    const access = makeAccessJwt();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));
    return { db, token: access.token };
  };

  it("staff list shows only own-store customers (kyoto), never other stores", async () => {
    const { db, token } = setup("staff", "staff_owner_kyoto");
    try {
      const r = await req(db, token, "/api/admin/customers?mode=list");
      expect(r.status).toBe(200);
      const got = await ids(r);
      expect(got).toContain("c_kyoto");
      expect(got).toContain("c_cross");
      expect(got).not.toContain("c_osaka");
      expect(got).not.toContain("c_archived");
    } finally {
      db.sqlite.close();
    }
  });

  // 2026-08-26: staff may archive/restore their own-store customers, so the archived
  // list is open to them too — still scoped to their own store.
  it("staff archived view shows own-store archived customers only", async () => {
    const { db, token } = setup("staff", "staff_owner_kyoto");
    try {
      // 登録店舗だけで自店舗に属するアーカイブ済み顧客 (予約も来店も無い) を混ぜる。
      // 件数クエリは本文クエリと別 SQL で bind も手書きなので、3 本目の arm が
      // 件数側にも効いていることをここで固定する。
      db.sqlite
        .prepare(
          `INSERT INTO customers (id, display_name, block_status, archived_at, created_store_id, created_at, updated_at)
           VALUES ('c_arch_registered', '登録 済子', 'active', '2026-05-10T00:00:00Z', 'kyoto', '2026-05-09T00:00:00Z', '2026-05-10T00:00:00Z')`
        )
        .run();
      db.sqlite
        .prepare(
          `INSERT INTO customers (id, display_name, block_status, archived_at, created_store_id, created_at, updated_at)
           VALUES ('c_arch_registered_osaka', '登録 他子', 'active', '2026-05-10T00:00:00Z', 'osaka', '2026-05-09T00:00:00Z', '2026-05-10T00:00:00Z')`
        )
        .run();

      const r = await req(db, token, "/api/admin/customers?mode=list&view=archived");
      expect(r.status).toBe(200);
      const body = (await r.clone().json()) as { total: number };
      const got = await ids(r);
      expect(got).toEqual(["c_arch_registered", "c_archived"]);
      // The count query runs its own SQL; without the same membership clause it
      // would report other stores' archived customers as a bare number.
      expect(body.total).toBe(2);
    } finally {
      db.sqlite.close();
    }
  });

  it("staff archived view hides another store's archived customer", async () => {
    const { db, token } = setup("staff", "staff_owner_kyoto");
    try {
      db.sqlite
        .prepare("UPDATE customers SET archived_at = '2026-05-08T00:00:00Z' WHERE id = 'c_osaka'")
        .run();
      const got = await ids(await req(db, token, "/api/admin/customers?mode=list&view=archived"));
      expect(got).not.toContain("c_osaka");
    } finally {
      db.sqlite.close();
    }
  });

  it("staff detail: own-store 200, other-store 403, own-store archived 200 (restore route)", async () => {
    const { db, token } = setup("staff", "staff_owner_kyoto");
    try {
      expect((await req(db, token, "/api/admin/customers/c_kyoto")).status).toBe(200);
      expect((await req(db, token, "/api/admin/customers/c_osaka")).status).toBe(403);
      expect((await req(db, token, "/api/admin/customers/c_archived")).status).toBe(200);
      expect((await req(db, token, "/api/admin/customers/does_not_exist")).status).toBe(403);
    } finally {
      db.sqlite.close();
    }
  });

  it("staff detail: another store's ARCHIVED customer stays 403", async () => {
    const { db, token } = setup("staff", "staff_owner_kyoto");
    try {
      db.sqlite
        .prepare("UPDATE customers SET archived_at = '2026-05-08T00:00:00Z' WHERE id = 'c_osaka'")
        .run();
      expect((await req(db, token, "/api/admin/customers/c_osaka")).status).toBe(403);
    } finally {
      db.sqlite.close();
    }
  });

  it("staff detail: a merge tombstone stays 403 even with includeArchived", async () => {
    const { db, token } = setup("staff", "staff_owner_kyoto");
    try {
      db.sqlite
        .prepare("UPDATE customers SET merged_into_id = 'c_cross' WHERE id = 'c_kyoto'")
        .run();
      expect((await req(db, token, "/api/admin/customers/c_kyoto")).status).toBe(403);
    } finally {
      db.sqlite.close();
    }
  });

  // created_store_id is the third arm of the membership predicate: a manually
  // registered customer has neither a reservation nor a visit yet.
  it("a customer registered by the store is in scope with no reservation and no visit", async () => {
    const { db, token } = setup("staff", "staff_owner_kyoto");
    try {
      db.sqlite
        .prepare(
          `INSERT INTO customers (id, display_name, block_status, created_store_id, created_at, updated_at)
           VALUES ('c_registered', '登録 五郎', 'active', 'kyoto', '2026-05-09T00:00:00Z', '2026-05-09T00:00:00Z')`
        )
        .run();
      db.sqlite
        .prepare(
          `INSERT INTO customers (id, display_name, block_status, created_store_id, created_at, updated_at)
           VALUES ('c_registered_osaka', '登録 六郎', 'active', 'osaka', '2026-05-09T00:00:00Z', '2026-05-09T00:00:00Z')`
        )
        .run();

      const listed = await ids(await req(db, token, "/api/admin/customers?mode=list"));
      expect(listed).toContain("c_registered");
      expect(listed).not.toContain("c_registered_osaka");

      const searched = await ids(await req(db, token, "/api/admin/customers?q=" + encodeURIComponent("登録")));
      expect(searched).toEqual(["c_registered"]);

      expect((await req(db, token, "/api/admin/customers/c_registered")).status).toBe(200);
      expect((await req(db, token, "/api/admin/customers/c_registered_osaka")).status).toBe(403);
      expect(
        (await req(db, token, "/api/admin/customers/c_registered/memo", "PUT", { memo: "紙カルテ" })).status
      ).toBe(200);
    } finally {
      db.sqlite.close();
    }
  });

  // End-to-end for the manual registration flow: create, then reach the new
  // customer through every surface the panel and the booking form use.
  it("staff can register a customer and immediately reach it (list / search / detail)", async () => {
    const { db, token } = setup("staff", "staff_owner_kyoto");
    try {
      const created = await req(db, token, "/api/admin/customers", "POST", {
        idempotencyKey: crypto.randomUUID(),
        displayName: "紙カルテ 花子",
        displayNameKana: "カミカルテ ハナコ",
      });
      expect(created.status).toBe(201);
      const body = (await created.json()) as { ok: boolean; customerId: string };
      expect(body.ok).toBe(true);

      expect((await req(db, token, `/api/admin/customers/${body.customerId}`)).status).toBe(200);
      expect(await ids(await req(db, token, "/api/admin/customers?mode=list"))).toContain(body.customerId);
      expect(
        await ids(await req(db, token, "/api/admin/customers?q=" + encodeURIComponent("紙カルテ")))
      ).toEqual([body.customerId]);

      const storeRow = db.sqlite
        .prepare("SELECT created_store_id FROM customers WHERE id = ?")
        .get(body.customerId) as { created_store_id: string | null };
      expect(storeRow.created_store_id).toBe("kyoto");
    } finally {
      db.sqlite.close();
    }
  });

  it("a staff member with no store binding cannot register a customer", async () => {
    const { db, token } = setup("staff", null);
    try {
      const created = await req(db, token, "/api/admin/customers", "POST", {
        idempotencyKey: crypto.randomUUID(),
        displayName: "紙カルテ 花子",
      });
      expect(created.status).toBe(403);
      const count = db.sqlite
        .prepare("SELECT COUNT(*) AS n FROM customers WHERE display_name = '紙カルテ 花子'")
        .get() as { n: number };
      expect(count.n).toBe(0);
    } finally {
      db.sqlite.close();
    }
  });

  // 詳細と同じ店舗条件がページングにも要る。片方だけ直すと staff が 2 ページ目から
  // 他店舗の来店を読めてしまう (詳細のほうが目に付くので、抜けるのは常にこちら)。
  it("staff paging of a cross-store customer returns ONLY own-store visits", async () => {
    const { db, token } = setup("staff", "staff_owner_kyoto");
    try {
      const r = await req(db, token, "/api/admin/customers/c_cross/visits");
      expect(r.status).toBe(200);
      const body = (await r.json()) as { visits: Array<{ storeId: string }> };
      expect(body.visits.length).toBeGreaterThan(0);
      expect(body.visits.every((v) => v.storeId === "kyoto")).toBe(true);
    } finally {
      db.sqlite.close();
    }
  });

  it("staff paging of an out-of-scope customer is forbidden", async () => {
    const { db, token } = setup("staff", "staff_owner_kyoto");
    try {
      const r = await req(db, token, "/api/admin/customers/c_osaka/visits");
      expect(r.status).toBe(403);
    } finally {
      db.sqlite.close();
    }
  });

  it("staff detail of a cross-store customer returns ONLY own-store visits/reservations", async () => {
    const { db, token } = setup("staff", "staff_owner_kyoto");
    try {
      const r = await req(db, token, "/api/admin/customers/c_cross");
      expect(r.status).toBe(200);
      const body = (await r.json()) as {
        customer: {
          validVisitCount: number;
          visits: Array<{ storeId: string }>;
          reservations: Array<{ storeId: string }>;
        };
      };
      expect(body.customer.visits.length).toBeGreaterThan(0);
      expect(body.customer.visits.every((v) => v.storeId === "kyoto")).toBe(true);
      // c_cross has one visit per store. The heading count runs its own query,
      // so it needs the same store condition or it leaks the osaka visit.
      expect(body.customer.validVisitCount).toBe(1);
      expect(body.customer.reservations.length).toBeGreaterThan(0);
      expect(body.customer.reservations.every((r2) => r2.storeId === "kyoto")).toBe(true);
    } finally {
      db.sqlite.close();
    }
  });

  it("staff memo/profile edit: own-store 200, cross-store 403", async () => {
    const { db, token } = setup("staff", "staff_owner_kyoto");
    try {
      expect((await req(db, token, "/api/admin/customers/c_kyoto/memo", "PUT", { memo: "自店舗メモ" })).status).toBe(200);
      expect((await req(db, token, "/api/admin/customers/c_osaka/memo", "PUT", { memo: "侵入" })).status).toBe(403);
      expect(
        (await req(db, token, "/api/admin/customers/c_kyoto/profile", "PATCH", { gender: "female" })).status
      ).toBe(200);
      expect(
        (await req(db, token, "/api/admin/customers/c_osaka/profile", "PATCH", { gender: "female" })).status
      ).toBe(403);
      // The cross-store memo write must not have landed.
      const osaka = db.sqlite.prepare("SELECT memo FROM customers WHERE id = 'c_osaka'").get() as { memo: string | null };
      expect(osaka.memo).toBeNull();
    } finally {
      db.sqlite.close();
    }
  });

  it.each([
    {
      label: "memo",
      path: "/api/admin/customers/c_kyoto/memo",
      method: "PUT" as const,
      body: { memo: "競合後メモ" },
      column: "memo"
    },
    {
      label: "profile",
      path: "/api/admin/customers/c_kyoto/profile",
      method: "PATCH" as const,
      body: { displayName: "競合後の名前" },
      column: "display_name"
    }
  ])("owner $label edit returns 404 when the customer is archived after the precheck", async ({ path, method, body, column }) => {
    const { db, token } = setup("owner", null);
    try {
      const originalBatch = db.batch.bind(db);
      let injected = false;
      db.batch = async (statements) => {
        if (!injected) {
          injected = true;
          db.sqlite
            .prepare("UPDATE customers SET archived_at = '2026-07-20T00:00:00.000Z' WHERE id = 'c_kyoto'")
            .run();
        }
        return originalBatch(statements);
      };

      const response = await req(db, token, path, method, body);

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ ok: false, reason: "not_found" });
      const row = db.sqlite
        .prepare(`SELECT ${column} AS value FROM customers WHERE id = 'c_kyoto'`)
        .get() as { value: string | null };
      expect(row.value).not.toBe(column === "memo" ? "競合後メモ" : "競合後の名前");
      expect(
        (db.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE target_id = 'c_kyoto'").get() as { count: number }).count
      ).toBe(0);
    } finally {
      db.sqlite.close();
    }
  });

  it.each([
    { path: "/api/admin/customers/c_kyoto/memo", body: { memo: "失効後メモ" } },
    { path: "/api/admin/customers/c_kyoto/visits/v_kyoto/notes", body: { treatmentNotes: "失効後施術メモ" } }
  ].flatMap((route) => [
    "UPDATE admin_users SET active = 0 WHERE id = 'admin_scope_http'",
    "UPDATE admin_users SET role = 'owner' WHERE id = 'admin_scope_http'",
    "UPDATE admin_users SET staff_member_id = NULL WHERE id = 'admin_scope_http'",
    "UPDATE staff_members SET store_id = 'osaka' WHERE id = 'staff_owner_kyoto'"
  ].map((revocation) => ({ ...route, revocation }))))(
    "revocation before the batch prevents $path and its audit: $revocation", async ({ path, body, revocation }) => {
      const { db, token } = setup("staff", "staff_owner_kyoto");
      try {
        const originalBatch = db.batch.bind(db);
        db.batch = async (statements) => {
          db.sqlite.exec(revocation);
          return originalBatch(statements);
        };
        const response = await req(db, token, path, "PUT", body);
        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toEqual({ ok: false, reason: "forbidden" });
        expect(db.sqlite.prepare("SELECT memo FROM customers WHERE id = 'c_kyoto'").get()).toEqual({ memo: null });
        expect(db.sqlite.prepare("SELECT treatment_notes FROM customer_visits WHERE id = 'v_kyoto'").get())
          .toEqual({ treatment_notes: null });
        expect(db.sqlite.prepare("SELECT * FROM audit_logs").all()).toEqual([]);
      } finally { db.sqlite.close(); }
  });

  it.each([
    { path: "/api/admin/customers/c_kyoto/memo", body: { memo: "失敗メモ" } },
    { path: "/api/admin/customers/c_kyoto/visits/v_kyoto/notes", body: { treatmentNotes: "失敗施術メモ" } }
  ])("an unrelated write failure stays a server error for $path even after revocation", async ({ path, body }) => {
    const { db, token } = setup("staff", "staff_owner_kyoto");
    try {
      db.batch = async () => {
        db.sqlite.exec("UPDATE admin_users SET active = 0 WHERE id = 'admin_scope_http'");
        throw new Error("D1_ERROR: CHECK constraint failed: unrelated_check");
      };
      expect((await req(db, token, path, "PUT", body)).status).toBe(500);
      expect(db.sqlite.prepare("SELECT memo FROM customers WHERE id = 'c_kyoto'").get()).toEqual({ memo: null });
      expect(db.sqlite.prepare("SELECT treatment_notes FROM customer_visits WHERE id = 'v_kyoto'").get())
        .toEqual({ treatment_notes: null });
      expect(db.sqlite.prepare("SELECT * FROM audit_logs").all()).toEqual([]);
    } finally { db.sqlite.close(); }
  });

  it.each(["reservation", "visit", "registration"])(
    "memo refuses loss of the last %s store membership before the batch", async (membership) => {
      const { db, token } = setup("staff", "staff_owner_kyoto");
      try {
        if (membership !== "reservation") db.sqlite.exec("DELETE FROM reservations WHERE customer_id = 'c_kyoto'");
        if (membership !== "visit") db.sqlite.exec("DELETE FROM customer_visits WHERE customer_id = 'c_kyoto'");
        if (membership === "registration") {
          db.sqlite.exec("UPDATE customers SET created_store_id = 'kyoto' WHERE id = 'c_kyoto'");
        }
        const originalBatch = db.batch.bind(db);
        db.batch = async (statements) => {
          db.sqlite.exec(`
            DELETE FROM reservations WHERE customer_id = 'c_kyoto';
            DELETE FROM customer_visits WHERE customer_id = 'c_kyoto';
            UPDATE customers SET created_store_id = NULL WHERE id = 'c_kyoto';
          `);
          return originalBatch(statements);
        };
        const response = await req(db, token, "/api/admin/customers/c_kyoto/memo", "PUT", { memo: "他店舗の変更" });
        expect(response.status).toBe(403);
        expect(db.sqlite.prepare("SELECT memo FROM customers WHERE id = 'c_kyoto'").get()).toEqual({ memo: null });
        expect(db.sqlite.prepare("SELECT * FROM audit_logs").all()).toEqual([]);
      } finally { db.sqlite.close(); }
    }
  );

  it("visit notes do not follow a visit moved to another store after the precheck", async () => {
    const { db, token } = setup("staff", "staff_owner_kyoto");
    try {
      const originalBatch = db.batch.bind(db);
      db.batch = async (statements) => {
        db.sqlite.exec("UPDATE customer_visits SET store_id = 'osaka' WHERE id = 'v_kyoto'");
        return originalBatch(statements);
      };
      const response = await req(db, token, "/api/admin/customers/c_kyoto/visits/v_kyoto/notes", "PUT", {
        treatmentNotes: "店舗変更後の書き込み"
      });
      expect(response.status).toBe(404);
      expect(db.sqlite.prepare("SELECT treatment_notes FROM customer_visits WHERE id = 'v_kyoto'").get())
        .toEqual({ treatment_notes: null });
      expect(db.sqlite.prepare("SELECT * FROM audit_logs").all()).toEqual([]);
    } finally { db.sqlite.close(); }
  });

  it("staff visit-notes edit: active own-store 200, archived own-store 403, other-store 403", async () => {
    const { db, token } = setup("staff", "staff_owner_kyoto");
    try {
      const ok = await req(db, token, "/api/admin/customers/c_kyoto/visits/v_kyoto/notes", "PUT", {
        treatmentNotes: "施術メモ"
      });
      expect(ok.status).toBe(200);
      // Archived own-store customer: the canonical gate must block notes editing too.
      const arch = await req(db, token, "/api/admin/customers/c_archived/visits/v_arch/notes", "PUT", {
        treatmentNotes: "侵入"
      });
      expect(arch.status).toBe(403);
      // Other-store customer's visit.
      const other = await req(db, token, "/api/admin/customers/c_osaka/visits/v_osaka/notes", "PUT", {
        treatmentNotes: "侵入"
      });
      expect(other.status).toBe(403);
      // Neither forbidden write landed.
      const archNote = db.sqlite.prepare("SELECT treatment_notes FROM customer_visits WHERE id = 'v_arch'").get() as {
        treatment_notes: string | null;
      };
      expect(archNote.treatment_notes).toBeNull();
    } finally {
      db.sqlite.close();
    }
  });

  it("owner visit-note edit returns 404 when the customer is archived after the precheck", async () => {
    const { db, token } = setup("owner", null);
    try {
      const originalBatch = db.batch.bind(db);
      let injected = false;
      db.batch = async (statements) => {
        if (!injected) {
          injected = true;
          db.sqlite
            .prepare("UPDATE customers SET archived_at = '2026-07-20T00:00:00.000Z' WHERE id = 'c_kyoto'")
            .run();
        }
        return originalBatch(statements);
      };

      const response = await req(
        db,
        token,
        "/api/admin/customers/c_kyoto/visits/v_kyoto/notes",
        "PUT",
        { treatmentNotes: "競合後の施術メモ" }
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ ok: false, reason: "not_found" });
      const visit = db.sqlite
        .prepare("SELECT treatment_notes FROM customer_visits WHERE id = 'v_kyoto'")
        .get() as { treatment_notes: string | null };
      expect(visit.treatment_notes).toBeNull();
      expect(
        (db.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE target_id = 'v_kyoto'").get() as { count: number }).count
      ).toBe(0);
    } finally {
      db.sqlite.close();
    }
  });

  it("staff with no store binding fails closed (403) on list and detail", async () => {
    const { db, token } = setup("staff", null);
    try {
      expect((await req(db, token, "/api/admin/customers?mode=list")).status).toBe(403);
      expect((await req(db, token, "/api/admin/customers/c_kyoto")).status).toBe(403);
      expect((await req(db, token, "/api/admin/customers/c_kyoto/memo", "PUT", { memo: "x" })).status).toBe(403);
    } finally {
      db.sqlite.close();
    }
  });

  it("owner sees all stores and may use the archived view", async () => {
    const { db, token } = setup("owner", null);
    try {
      const list = await req(db, token, "/api/admin/customers?mode=list");
      const got = await ids(list);
      expect(got).toContain("c_kyoto");
      expect(got).toContain("c_osaka");
      expect(got).toContain("c_cross");

      const archived = await req(db, token, "/api/admin/customers?mode=list&view=archived");
      expect(archived.status).toBe(200);
      expect(await ids(archived)).toEqual(["c_archived"]);

      // Owner detail of a cross-store customer shows BOTH stores' history.
      const detail = await req(db, token, "/api/admin/customers/c_cross");
      const body = (await detail.json()) as { customer: { visits: Array<{ storeId: string }> } };
      const stores = new Set(body.customer.visits.map((v) => v.storeId));
      expect(stores.has("kyoto")).toBe(true);
      expect(stores.has("osaka")).toBe(true);
    } finally {
      db.sqlite.close();
    }
  });
});

describe("customer name/phone edit + owner store filter — routes", () => {
  afterEach(() => vi.unstubAllGlobals());

  const setup = (role: "owner" | "staff", staffMemberId: string | null) => {
    const db = createMigratedSqliteD1();
    insertAdmin(db, role, staffMemberId);
    seedData(db);
    const access = makeAccessJwt();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));
    return { db, token: access.token };
  };

  // ── Task 2: name / phone edit via PATCH /customers/:id/profile ──────────────

  const seedPhoneLock = (db: SqliteD1Database, input: {
    id: string; source: string; phoneHash: string | null;
    customerId?: string; storeId?: string; startAt?: string;
  }) => {
    const customerId = input.customerId ?? "c_kyoto";
    const storeId = input.storeId ?? "kyoto";
    const startAt = input.startAt ?? "2026-10-01T01:00:00.000Z";
    db.sqlite.prepare(`
      INSERT INTO reservations
        (id, store_id, service_id, customer_id, resource_id, source, status,
         duration_minutes, idempotency_key, start_at, end_at)
      VALUES (?, ?, ?, ?, ?, ?, 'confirmed', 60, ?, ?, ?)
    `).run(input.id, storeId, `service_${storeId}_default_60`, customerId,
      `resource_${storeId}_calendar`, input.source, input.id, startAt, endPlusHour(startAt));
    db.sqlite.prepare(`
      INSERT INTO customer_time_locks
        (id, customer_id, slot_at, owner_type, owner_id, lock_status, phone_hash)
      VALUES (?, ?, ?, 'reservation', ?, 'confirmed', ?)
    `).run(`lock_${input.id}`, customerId, startAt, input.id, input.phoneHash);
  };

  const profileState = (db: SqliteD1Database) => ({
    customers: db.sqlite.prepare("SELECT * FROM customers ORDER BY id").all(),
    locks: db.sqlite.prepare("SELECT * FROM customer_time_locks ORDER BY id").all(),
    reservations: db.sqlite.prepare("SELECT * FROM reservations ORDER BY id").all(),
    audits: db.sqlite.prepare("SELECT * FROM audit_logs ORDER BY id").all(),
    jobs: db.sqlite.prepare("SELECT * FROM calendar_sync_jobs ORDER BY id").all()
  });

  it("setting and clearing a phone updates manual locks across stores while web locks stay NULL", async () => {
    const { db, token } = setup("staff", "staff_owner_kyoto");
    try {
      db.sqlite.exec("UPDATE customers SET phone_normalized = NULL, phone_hash = NULL WHERE id = 'c_cross'");
      for (const [id, source, storeId, startAt] of [
        ["phone_c", "web_line", "kyoto", "2026-10-03T01:00:00.000Z"],
        ["phone_d", "system_import", "osaka", "2026-10-04T01:00:00.000Z"],
        ["phone_a", "phone_admin", "kyoto", "2026-10-01T01:00:00.000Z"],
        ["phone_b", "admin", "osaka", "2026-10-02T01:00:00.000Z"]
      ]) seedPhoneLock(db, { id, source, storeId, startAt, customerId: "c_cross", phoneHash: null });

      const changed = await req(db, token, "/api/admin/customers/c_cross/profile", "PATCH", { phone: "090-9999-8888" });
      expect(changed.status).toBe(200);
      const newHash = await sha256Hex("09099998888");
      expect(db.sqlite.prepare("SELECT phone_hash FROM customer_time_locks ORDER BY id").all()).toEqual([
        { phone_hash: newHash }, { phone_hash: newHash }, { phone_hash: null }, { phone_hash: null }
      ]);

      const cleared = await req(db, token, "/api/admin/customers/c_cross/profile", "PATCH", { phone: null });
      expect(cleared.status).toBe(200);
      expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM customer_time_locks WHERE phone_hash IS NOT NULL").get())
        .toEqual({ count: 0 });
      expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM customer_time_locks").get()).toEqual({ count: 4 });
    } finally { db.sqlite.close(); }
  });

  it.each([{}, { phone: "***-****-0001" }, { phone: "080-1111-0001" }])(
    "preserves legacy NULL phone locks for an unchanged phone: %j", async (phoneBody) => {
      const { db, token } = setup("owner", null);
      try {
        db.sqlite.prepare("UPDATE customers SET phone_hash = ? WHERE id = 'c_kyoto'")
          .run(await sha256Hex("08011110001"));
        seedPhoneLock(db, { id: "legacy_phone", source: "admin", phoneHash: null });
        const response = await req(db, token, "/api/admin/customers/c_kyoto/profile", "PATCH", {
          displayName: "名前のみ更新", ...phoneBody
        });
        expect(response.status).toBe(200);
        expect(db.sqlite.prepare("SELECT phone_hash FROM customer_time_locks").get()).toEqual({ phone_hash: null });
      } finally { db.sqlite.close(); }
    }
  );

  it("rejects a conflicting phone edit without changing the profile, locks, audit, or jobs", async () => {
    const { db, token } = setup("owner", null);
    try {
      const oldHash = await sha256Hex("08011110001");
      const newHash = await sha256Hex("09099998888");
      db.sqlite.prepare("UPDATE customers SET phone_hash = ? WHERE id = 'c_kyoto'").run(oldHash);
      seedPhoneLock(db, { id: "collision_a", source: "admin", phoneHash: oldHash });
      seedPhoneLock(db, { id: "collision_b", source: "phone_admin", phoneHash: newHash, customerId: "c_osaka", storeId: "osaka" });
      const before = profileState(db);

      const response = await req(db, token, "/api/admin/customers/c_kyoto/profile", "PATCH", {
        phone: "09099998888", displayName: "失敗する変更"
      });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ ok: false, reason: "customer_time_conflict" });
      expect(profileState(db)).toEqual(before);
    } finally { db.sqlite.close(); }
  });

  it.each(["active = 0", "role = 'staff'", "staff_member_id = 'staff_owner_osaka'"])(
    "revocation before a phone edit batch leaves profile state unchanged: %s", async (revocation) => {
      const { db, token } = setup("owner", null);
      try {
        seedPhoneLock(db, { id: "revoked_phone", source: "admin", phoneHash: "old_hash" });
        const originalBatch = db.batch.bind(db);
        db.batch = async (statements) => {
          db.sqlite.exec(`UPDATE admin_users SET ${revocation} WHERE id = 'admin_scope_http'`);
          return originalBatch(statements);
        };
        const before = profileState(db);
        const response = await req(db, token, "/api/admin/customers/c_kyoto/profile", "PATCH", {
          phone: "09099998888", displayName: "失効後の変更"
        });
        expect(response.status).toBe(403);
        expect(profileState(db)).toEqual(before);
      } finally { db.sqlite.close(); }
    }
  );

  it("phone edits keep same-phone customers from taking an already locked time", async () => {
    const { db, token } = setup("owner", null);
    try {
      const oldHash = await sha256Hex("08011110001");
      const newHash = await sha256Hex("09099998888");
      db.sqlite.prepare("UPDATE customers SET phone_hash = ? WHERE id = 'c_kyoto'").run(oldHash);
      const insertLock = db.sqlite.prepare(`
        INSERT INTO customer_time_locks
          (id, customer_id, slot_at, owner_type, owner_id, lock_status, phone_hash)
        VALUES (?, ?, '2026-10-01T01:00:00.000Z', 'reservation', ?, 'confirmed', ?)
      `);
      insertLock.run("phone_lock", "c_kyoto", "r_kyoto", oldHash);

      const response = await req(db, token, "/api/admin/customers/c_kyoto/profile", "PATCH", {
        phone: "090-9999-8888"
      });
      expect(response.status).toBe(200);
      expect(() => insertLock.run("duplicate_phone_lock", "c_osaka", "r_osaka", newHash))
        .toThrow(/customer_time_locks\.phone_hash/);
    } finally {
      db.sqlite.close();
    }
  });

  it.each(["archived_at = '2026-09-14T00:00:00.000Z'", "merged_into_id = 'c_osaka'"])(
    "a customer lifecycle change before the batch prevents every profile side effect: %s", async (change) => {
      const { db, token } = setup("owner", null);
      try {
        seedPhoneLock(db, { id: "retired_phone", source: "admin", phoneHash: "old_hash" });
        const originalBatch = db.batch.bind(db);
        let before: ReturnType<typeof profileState> | undefined;
        db.batch = async (statements) => {
          db.sqlite.exec(`UPDATE customers SET ${change} WHERE id = 'c_kyoto'`);
          before = profileState(db);
          return originalBatch(statements);
        };
        const response = await req(db, token, "/api/admin/customers/c_kyoto/profile", "PATCH", {
          phone: "09099998888", displayName: "変更不可"
        });
        expect(response.status).toBe(404);
        expect(before).toBeDefined();
        expect(profileState(db)).toEqual(before);
      } finally { db.sqlite.close(); }
    }
  );

  it("rolls back the phone, locks, and audit when a later batch statement fails", async () => {
    const { db, token } = setup("owner", null);
    try {
      seedPhoneLock(db, { id: "failed_phone", source: "admin", phoneHash: "old_hash" });
      const originalBatch = db.batch.bind(db);
      db.batch = (statements) => originalBatch([
        ...statements,
        db.prepare("INSERT INTO audit_logs (id, actor_type, action) VALUES ('late_failure', 'invalid', 'test')")
      ]);
      const before = profileState(db);
      const response = await req(db, token, "/api/admin/customers/c_kyoto/profile", "PATCH", {
        phone: "09099998888", displayName: "rollback対象"
      });
      expect(response.status).toBe(500);
      expect(profileState(db)).toEqual(before);
    } finally { db.sqlite.close(); }
  });

  it("does not report a lock database failure as an overlapping customer reservation", async () => {
    const { db, token } = setup("owner", null);
    try {
      const before = profileState(db);
      db.batch = async () => { throw new Error("D1_ERROR: no such table: customer_time_locks"); };
      const response = await req(db, token, "/api/admin/customers/c_kyoto/profile", "PATCH", { phone: "09099998888" });
      expect(response.status).toBe(500);
      expect(profileState(db)).toEqual(before);
    } finally { db.sqlite.close(); }
  });

  it("losing the last own-store membership before the batch prevents cross-store phone lock writes", async () => {
    const { db, token } = setup("staff", "staff_owner_kyoto");
    try {
      seedPhoneLock(db, { id: "membership_phone", source: "admin", phoneHash: "old_hash", storeId: "osaka" });
      const originalBatch = db.batch.bind(db);
      let before: ReturnType<typeof profileState> | undefined;
      db.batch = async (statements) => {
        db.sqlite.exec(`
          DELETE FROM reservations WHERE customer_id = 'c_kyoto' AND store_id = 'kyoto';
          DELETE FROM customer_visits WHERE customer_id = 'c_kyoto' AND store_id = 'kyoto';
        `);
        before = profileState(db);
        return originalBatch(statements);
      };

      const response = await req(db, token, "/api/admin/customers/c_kyoto/profile", "PATCH", {
        phone: "09099998888", displayName: "担当範囲外の変更"
      });
      expect(response.status).toBe(403);
      expect(before).toBeDefined();
      expect(profileState(db)).toEqual(before);
    } finally { db.sqlite.close(); }
  });

  it("owner edits display name, kana, and phone — phone_hash recomputed", async () => {
    const { db, token } = setup("owner", null);
    try {
      const r = await req(db, token, "/api/admin/customers/c_kyoto/profile", "PATCH", {
        displayName: "京都 太郎(改)",
        displayNameKana: "キョウト タロウカイ",
        phone: "090-9999-8888"
      });
      expect(r.status).toBe(200);
      const row = db.sqlite
        .prepare("SELECT display_name, display_name_kana, phone_normalized, phone_hash FROM customers WHERE id = 'c_kyoto'")
        .get() as {
        display_name: string;
        display_name_kana: string | null;
        phone_normalized: string | null;
        phone_hash: string | null;
      };
      expect(row.display_name).toBe("京都 太郎(改)");
      expect(row.display_name_kana).toBe("キョウト タロウカイ");
      const expectedNorm = normalizePhone("090-9999-8888");
      expect(expectedNorm).toBeTruthy();
      expect(row.phone_normalized).toBe(expectedNorm);
      // phone_hash must be recomputed from the new normalized phone (merge-dedup key).
      expect(row.phone_hash).toBe(await sha256Hex(expectedNorm as string));
    } finally {
      db.sqlite.close();
    }
  });

  it("ignores a re-submitted MASKED phone (staff name-only edit) — no invalid_phone, real number preserved", async () => {
    // ⑥ now masks phone for staff, and the edit form prefills phoneNormalized into
    // the phone input. A staff name-only edit therefore re-submits the masked value
    // (`***-****-NNNN`); buildPhoneUpdate must treat any '*'-containing value as "no
    // phone change" so it neither 400s (invalid_phone) nor wipes the real number.
    const { db, token } = setup("owner", null);
    try {
      const before = db.sqlite
        .prepare("SELECT phone_normalized FROM customers WHERE id = 'c_kyoto'")
        .get() as { phone_normalized: string | null };
      expect(before.phone_normalized).toBeTruthy();

      const r = await req(db, token, "/api/admin/customers/c_kyoto/profile", "PATCH", {
        displayName: "京都 太郎(名前のみ)",
        phone: "***-****-1234"
      });
      expect(r.status).toBe(200);

      const row = db.sqlite
        .prepare("SELECT display_name, phone_normalized FROM customers WHERE id = 'c_kyoto'")
        .get() as { display_name: string; phone_normalized: string | null };
      expect(row.display_name).toBe("京都 太郎(名前のみ)");
      expect(row.phone_normalized).toBe(before.phone_normalized);
    } finally {
      db.sqlite.close();
    }
  });

  it("records only *_updated flags in audit_logs — never the PII values", async () => {
    const { db, token } = setup("owner", null);
    try {
      const r = await req(db, token, "/api/admin/customers/c_kyoto/profile", "PATCH", {
        birthDate: "1990-04-01",
        gender: "female",
        allergyNotes: "ラテックスアレルギー"
      });
      expect(r.status).toBe(200);
      // The columns themselves still store the actual values.
      const row = db.sqlite
        .prepare("SELECT birth_date, gender, allergy_notes FROM customers WHERE id = 'c_kyoto'")
        .get() as { birth_date: string | null; gender: string | null; allergy_notes: string | null };
      expect(row.birth_date).toBe("1990-04-01");
      expect(row.gender).toBe("female");
      expect(row.allergy_notes).toBe("ラテックスアレルギー");
      // …but the audit metadata must record only flags, never the sensitive values
      // (audit_logs is retained indefinitely / out of scope for the retention sweep).
      const audit = db.sqlite
        .prepare(
          "SELECT metadata_json FROM audit_logs WHERE action = 'customer.profile_update' AND target_id = 'c_kyoto' ORDER BY rowid DESC LIMIT 1"
        )
        .get() as { metadata_json: string } | undefined;
      expect(audit).toBeDefined();
      const meta = JSON.parse(audit!.metadata_json) as Record<string, unknown>;
      // Exhaustive (toEqual, not toMatchObject): the metadata is EXACTLY the
      // three *_updated flags. toMatchObject only checks the listed keys exist,
      // so a regression adding a PII-bearing key would still pass — defeating
      // the whole point of this test. Assert the complete object instead.
      expect(meta).toEqual({
        birth_date_updated: true,
        gender_updated: true,
        allergy_notes_updated: true
      });
      // Defense in depth: none of the raw PII values appear anywhere.
      const serialized = JSON.stringify(meta);
      expect(serialized).not.toContain("1990-04-01");
      expect(serialized).not.toContain("female");
      expect(serialized).not.toContain("ラテックスアレルギー");
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects blank display name and invalid phone without mutating the row", async () => {
    const { db, token } = setup("owner", null);
    try {
      expect(
        (await req(db, token, "/api/admin/customers/c_kyoto/profile", "PATCH", { displayName: "   " })).status
      ).toBe(400);
      expect(
        (await req(db, token, "/api/admin/customers/c_kyoto/profile", "PATCH", { phone: "abc" })).status
      ).toBe(400);
      // Empty body (no editable field at all) is still no_fields.
      expect((await req(db, token, "/api/admin/customers/c_kyoto/profile", "PATCH", {})).status).toBe(400);
      const row = db.sqlite
        .prepare("SELECT display_name, phone_normalized FROM customers WHERE id = 'c_kyoto'")
        .get() as { display_name: string; phone_normalized: string | null };
      expect(row.display_name).toBe("京都 太郎");
      expect(row.phone_normalized).toBe("08011110001");
    } finally {
      db.sqlite.close();
    }
  });

  it("phone-only update succeeds; clearing the phone nulls phone_normalized + phone_hash", async () => {
    const { db, token } = setup("owner", null);
    try {
      const set = await req(db, token, "/api/admin/customers/c_osaka/profile", "PATCH", { phone: "075-111-2222" });
      expect(set.status).toBe(200);
      const afterSet = db.sqlite
        .prepare("SELECT phone_normalized, phone_hash FROM customers WHERE id = 'c_osaka'")
        .get() as { phone_normalized: string | null; phone_hash: string | null };
      expect(afterSet.phone_normalized).toBe(normalizePhone("075-111-2222"));
      expect(afterSet.phone_hash).toBeTruthy();

      const clear = await req(db, token, "/api/admin/customers/c_osaka/profile", "PATCH", { phone: null });
      expect(clear.status).toBe(200);
      const afterClear = db.sqlite
        .prepare("SELECT phone_normalized, phone_hash FROM customers WHERE id = 'c_osaka'")
        .get() as { phone_normalized: string | null; phone_hash: string | null };
      expect(afterClear.phone_normalized).toBeNull();
      expect(afterClear.phone_hash).toBeNull();
    } finally {
      db.sqlite.close();
    }
  });

  it("staff edits own-store name/phone (200) but not a cross-store customer (403)", async () => {
    const { db, token } = setup("staff", "staff_owner_kyoto");
    try {
      expect(
        (await req(db, token, "/api/admin/customers/c_kyoto/profile", "PATCH", { displayName: "改名", phone: "090-0000-1111" })).status
      ).toBe(200);
      expect(
        (await req(db, token, "/api/admin/customers/c_osaka/profile", "PATCH", { displayName: "侵入" })).status
      ).toBe(403);
      const osaka = db.sqlite.prepare("SELECT display_name FROM customers WHERE id = 'c_osaka'").get() as {
        display_name: string;
      };
      expect(osaka.display_name).toBe("大阪 花子");
    } finally {
      db.sqlite.close();
    }
  });

  it("renaming a customer enqueues calendar_sync_jobs upserts to refresh event titles; phone-only edit does not", async () => {
    const { db, token } = setup("owner", null);
    try {
      // Name change → one 'upsert' job per reservation (event titles embed the name).
      const rename = await req(db, token, "/api/admin/customers/c_kyoto/profile", "PATCH", {
        displayName: "京都 太郎(改名)"
      });
      expect(rename.status).toBe(200);
      const jobs = db.sqlite
        .prepare(
          "SELECT owner_id FROM calendar_sync_jobs WHERE owner_type = 'reservation' AND google_action = 'upsert'"
        )
        .all() as Array<{ owner_id: string }>;
      expect(jobs.map((j) => j.owner_id).sort()).toEqual(["r_kyoto"]);

      // Phone-only edit changes no title → no calendar jobs enqueued.
      const phone = await req(db, token, "/api/admin/customers/c_osaka/profile", "PATCH", {
        phone: "075-111-2222"
      });
      expect(phone.status).toBe(200);
      const osakaJobs = db.sqlite.prepare("SELECT 1 FROM calendar_sync_jobs WHERE owner_id = 'r_osaka'").all();
      expect(osakaJobs).toHaveLength(0);
    } finally {
      db.sqlite.close();
    }
  });

  it("staff renaming a cross-store customer enqueues calendar upserts ONLY for their own store", async () => {
    const { db, token } = setup("staff", "staff_owner_kyoto");
    try {
      // c_cross has r_cross_k (kyoto) + r_cross_o (osaka). A kyoto staff CAN edit c_cross
      // (own-store access via the kyoto reservation), but must NOT trigger a Google
      // Calendar write on the osaka reservation they cannot otherwise reach.
      const rename = await req(db, token, "/api/admin/customers/c_cross/profile", "PATCH", {
        displayName: "横断 次郎(改)"
      });
      expect(rename.status).toBe(200);
      const jobs = db.sqlite
        .prepare(
          "SELECT owner_id FROM calendar_sync_jobs WHERE owner_type = 'reservation' AND google_action = 'upsert'"
        )
        .all() as Array<{ owner_id: string }>;
      expect(jobs.map((j) => j.owner_id).sort()).toEqual(["r_cross_k"]);
    } finally {
      db.sqlite.close();
    }
  });

  it("owner renaming a cross-store customer enqueues calendar upserts for ALL stores", async () => {
    const { db, token } = setup("owner", null);
    try {
      const rename = await req(db, token, "/api/admin/customers/c_cross/profile", "PATCH", {
        displayName: "横断 次郎(改)"
      });
      expect(rename.status).toBe(200);
      const jobs = db.sqlite
        .prepare(
          "SELECT owner_id FROM calendar_sync_jobs WHERE owner_type = 'reservation' AND google_action = 'upsert'"
        )
        .all() as Array<{ owner_id: string }>;
      expect(jobs.map((j) => j.owner_id).sort()).toEqual(["r_cross_k", "r_cross_o"]);
    } finally {
      db.sqlite.close();
    }
  });

  // ── Task 3: owner store filter via ?store= ──────────────────────────────────

  it("owner ?store= narrows the list; absent / 'all' shows every store", async () => {
    const { db, token } = setup("owner", null);
    try {
      expect(await ids(await req(db, token, "/api/admin/customers?mode=list&store=osaka"))).toEqual([
        "c_cross",
        "c_osaka"
      ]);
      expect(await ids(await req(db, token, "/api/admin/customers?mode=list&store=kyoto"))).toEqual([
        "c_cross",
        "c_kyoto"
      ]);
      const all = await ids(await req(db, token, "/api/admin/customers?mode=list&store=all"));
      expect(all).toContain("c_kyoto");
      expect(all).toContain("c_osaka");
      expect(all).toContain("c_cross");
    } finally {
      db.sqlite.close();
    }
  });

  it("owner search respects ?store=", async () => {
    const { db, token } = setup("owner", null);
    try {
      // c_cross (横断/オウダン) belongs to kyoto → returned when scoped to kyoto.
      expect(
        await ids(await req(db, token, `/api/admin/customers?q=${encodeURIComponent("オウダン")}&store=kyoto`))
      ).toEqual(["c_cross"]);
      // c_osaka (大阪/オオサカ) is osaka-only → excluded under store=kyoto.
      expect(
        await ids(await req(db, token, `/api/admin/customers?q=${encodeURIComponent("オオサカ")}&store=kyoto`))
      ).toEqual([]);
    } finally {
      db.sqlite.close();
    }
  });

  it("staff cannot widen scope via ?store= (param ignored — own store only)", async () => {
    const { db, token } = setup("staff", "staff_owner_kyoto");
    try {
      const got = await ids(await req(db, token, "/api/admin/customers?mode=list&store=osaka"));
      expect(got).toContain("c_kyoto");
      expect(got).not.toContain("c_osaka");
    } finally {
      db.sqlite.close();
    }
  });
});

describe("terminal-state corrections — staff scope and owner restoration", () => {
  afterEach(() => vi.unstubAllGlobals());

  const setup = (role: "owner" | "staff", staffMemberId: string | null) => {
    const db = createMigratedSqliteD1();
    insertAdmin(db, role, staffMemberId);
    seedData(db);
    const access = makeAccessJwt();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));
    return { db, token: access.token };
  };

  const counts = (db: SqliteD1Database) => ({
    reservation: db.sqlite.prepare(`SELECT status, version FROM reservations WHERE id = 'r_kyoto'`).get(),
    visits: db.sqlite.prepare(`SELECT COUNT(*) AS n FROM customer_visits WHERE status = 'voided'`).get(),
    audits: db.sqlite.prepare(`SELECT COUNT(*) AS n FROM audit_logs`).get()
  });

  it("staff gets 403 on restore-completed before the body is read", async () => {
    const { db, token } = setup("staff", "staff_owner_kyoto");
    try {
      const before = counts(db);
      // 自店舗 (kyoto) の予約なので store-scope では弾かれない。owner ゲートだけが理由。
      const r = await rawPost(db, token, "/api/admin/reservations/r_kyoto/restore-completed", "{ not json");
      // body を先に読んでいれば invalid_json の 400 になる。
      expect(r.status).toBe(403);
      expect(counts(db)).toEqual(before);
    } finally {
      db.sqlite.close();
    }
  });

  it.each([
    ["staff_owner_kyoto", "r_kyoto", 200],
    ["staff_owner_kyoto", "r_osaka", 403],
    [null, "r_kyoto", 403],
    [null, "missing-reservation", 403]
  ] as const)("staff %s correcting %s returns %s", async (staffMemberId, reservationId, status) => {
    const { db, token } = setup("staff", staffMemberId);
    try {
      db.sqlite.prepare("UPDATE customer_visits SET reservation_id = 'r_kyoto', visit_source = 'reservation_completed', recorded_by = 'system' WHERE id = 'v_kyoto'").run();
      const before = counts(db);
      const response = await req(db, token, `/api/admin/reservations/${reservationId}/correct-no-show`, "POST", {
        idempotencyKey: "staff-correct-route", expectedVersion: 1
      });
      expect(response.status).toBe(status);
      if (status === 200) {
        expect(await response.json()).toMatchObject({ ok: true, status: "no_show" });
        expect(counts(db)).toMatchObject({ reservation: { status: "no_show", version: 2 }, visits: { n: 1 } });
        expect(db.sqlite.prepare("SELECT status, voided_by, recorded_by FROM customer_visits WHERE id = 'v_kyoto'").get())
          .toMatchObject({ status: "voided", voided_by: "admin_scope_http", recorded_by: "system" });
        expect(db.sqlite.prepare("SELECT actor_id FROM audit_logs WHERE action = 'admin_reservation_correct_no_show'").get())
          .toMatchObject({ actor_id: "admin_scope_http" });
      } else {
        expect(counts(db)).toEqual(before);
      }
    } finally {
      db.sqlite.close();
    }
  });

  it("owner reaches the handler (403 ではなく body 検証まで進む)", async () => {
    const { db, token } = setup("owner", null);
    try {
      const r = await rawPost(db, token, "/api/admin/reservations/r_kyoto/correct-no-show", "{ not json");
      expect(r.status).toBe(400);
    } finally {
      db.sqlite.close();
    }
  });
});

describe("visit notes — voided rows are read-only", () => {
  afterEach(() => vi.unstubAllGlobals());

  const setup = (role: "owner" | "staff", staffMemberId: string | null) => {
    const db = createMigratedSqliteD1();
    insertAdmin(db, role, staffMemberId);
    seedData(db);
    const access = makeAccessJwt();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));
    return { db, token: access.token };
  };

  const voidVisit = (db: SqliteD1Database, id: string) =>
    db.sqlite
      .prepare(
        `UPDATE customer_visits
         SET status = 'voided', voided_by = 'admin_scope_http', voided_at = '2026-07-20T00:00:00.000Z',
             void_reason = 'reservation_corrected_to_no_show'
         WHERE id = ?`
      )
      .run(id);

  const notes = (db: SqliteD1Database, id: string) =>
    (db.sqlite.prepare("SELECT treatment_notes FROM customer_visits WHERE id = ?").get(id) as {
      treatment_notes: string | null;
    }).treatment_notes;

  it("returns 404 for an already voided visit", async () => {
    const { db, token } = setup("owner", null);
    try {
      voidVisit(db, "v_kyoto");
      const r = await req(db, token, "/api/admin/customers/c_kyoto/visits/v_kyoto/notes", "PUT", {
        treatmentNotes: "無効な行へのメモ"
      });
      expect(r.status).toBe(404);
      expect(notes(db, "v_kyoto")).toBeNull();
    } finally {
      db.sqlite.close();
    }
  });

  it("does not write when the visit is voided between the precheck and the batch", async () => {
    const { db, token } = setup("owner", null);
    try {
      const originalBatch = db.batch.bind(db);
      let injected = false;
      db.batch = async (statements) => {
        if (!injected) {
          injected = true;
          voidVisit(db, "v_kyoto");
        }
        return originalBatch(statements);
      };

      const r = await req(db, token, "/api/admin/customers/c_kyoto/visits/v_kyoto/notes", "PUT", {
        treatmentNotes: "競合後のメモ"
      });

      // 事前 SELECT は valid を見て通るので、UPDATE 側の status ガードだけが防壁になる。
      expect(r.status).toBe(404);
      expect(notes(db, "v_kyoto")).toBeNull();
      expect(
        (
          db.sqlite
            .prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE target_id = 'v_kyoto'")
            .get() as { count: number }
        ).count
      ).toBe(0);
    } finally {
      db.sqlite.close();
    }
  });
});
