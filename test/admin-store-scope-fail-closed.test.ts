import { describe, expect, it, vi } from "vitest";

import { listAllCustomers, searchAdminCustomers } from "../src/admin/customers";
import { createApp } from "../src/app";
import { staffHasStore } from "../src/routes/shared";
import { createAccessJwksFetchMock, createAccessJwtFixture } from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const TEAM_DOMAIN = "https://blank-store.cloudflareaccess.com";
const ACCESS_AUD = "blank-store-aud";
const ADMIN_EMAIL = "blank-store-staff@example.com";
const ADMIN_ACCESS_SUBJECT = "access-subject-blank-store";

// 空文字の店舗 ID は「店舗あり」でも「全店舗」でもない。両方の読み方がコードに同居して
// いたのが issue #640 B-1 で、staffHasStore は通し、スコープ生成側は「スコープなし =
// 全店舗」と読んでいた。ここは 3 つの層 (判定・クエリ・DB) が同じ側に倒れることを固定する。
describe("blank store_id is never a full-store scope", () => {
  it("treats a blank staff store binding as no store at all", () => {
    expect(staffHasStore({ role: "staff", store_id: "kyoto" })).toBe(true);
    expect(staffHasStore({ role: "staff", store_id: null })).toBe(false);
    expect(staffHasStore({ role: "staff", store_id: "" })).toBe(false);
    expect(staffHasStore({ role: "staff", store_id: "   " })).toBe(false);
    // owner / system_admin は店舗を持たないので常に通る。
    expect(staffHasStore({ role: "owner", store_id: null })).toBe(true);
  });

  const seedTwoStoreCustomers = (db: SqliteD1Database) => {
    db.sqlite.exec(`
      INSERT INTO customers (id, display_name, display_name_kana, phone_normalized, block_status, created_store_id, updated_at)
      VALUES ('cust_scope_kyoto', '京都 太郎', 'キョウト タロウ', '09011112222', 'active', 'kyoto', '2026-05-01T00:00:00.000Z');
      INSERT INTO customers (id, display_name, display_name_kana, phone_normalized, block_status, created_store_id, updated_at)
      VALUES ('cust_scope_osaka', '大阪 花子', 'オオサカ ハナコ', '09033334444', 'active', 'osaka', '2026-05-02T00:00:00.000Z');
    `);
  };

  it("returns nothing from the customer list for a blank scope instead of every store", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedTwoStoreCustomers(db);
      const d1 = db as unknown as D1Database;

      const unscoped = await listAllCustomers(d1, 200, 0, { storeScope: null });
      expect(unscoped.customers.map((row) => row.id).sort()).toEqual(["cust_scope_kyoto", "cust_scope_osaka"]);
      expect(unscoped.total).toBe(2);

      const blank = await listAllCustomers(d1, 200, 0, { storeScope: "" });
      expect(blank.customers).toEqual([]);
      expect(blank.total).toBe(0);
    } finally {
      db.sqlite.close();
    }
  });

  it("returns nothing from customer search for a blank scope instead of every store", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedTwoStoreCustomers(db);
      const d1 = db as unknown as D1Database;

      const unscoped = await searchAdminCustomers({ db: d1, query: "090", storeScope: null });
      expect(unscoped.ok).toBe(true);
      expect(unscoped.ok && unscoped.customers).toHaveLength(2);

      const blank = await searchAdminCustomers({ db: d1, query: "090", storeScope: "" });
      expect(blank.ok).toBe(true);
      expect(blank.ok && blank.customers).toEqual([]);
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 403 on a store-scoped route for a staff member bound to a blank store", async () => {
    const db = createMigratedSqliteD1();
    try {
      // migration 0054 のトリガが空文字の店舗を止めるので、トリガが入る前に作られた
      // (あるいは直接 DB を触って作られた) 壊れた行を再現するには外すしかない。
      // この状態がもう作れないこと自体は下の migration テストで固定している。
      db.sqlite.exec("DROP TRIGGER IF EXISTS trg_stores_id_not_blank_insert");
      db.sqlite.exec(`
        INSERT INTO stores (id, name) VALUES ('', '壊れた店舗');
        INSERT INTO staff_members (id, store_id, display_name, role)
        VALUES ('sm_blank_store', '', '空 店舗', 'staff');
      `);
      db.sqlite
        .prepare(
          `INSERT INTO admin_users (id, email, access_subject, role, staff_member_id, active, updated_at)
           VALUES ('admin_blank_store', ?, ?, 'staff', 'sm_blank_store', 1, '2026-05-22T00:00:00.000Z')`
        )
        .run(ADMIN_EMAIL, ADMIN_ACCESS_SUBJECT);

      const access = createAccessJwtFixture({
        issuer: TEAM_DOMAIN,
        audience: ACCESS_AUD,
        keyId: "blank-store-key-1",
        claims: { email: ADMIN_EMAIL, sub: ADMIN_ACCESS_SUBJECT }
      });
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const res = await createApp().request(
        "/api/admin/reservations?range=today",
        { headers: { "Cf-Access-Jwt-Assertion": access.token } },
        { ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD, DB: db }
      );
      expect(res.status).toBe(403);
    } finally {
      vi.unstubAllGlobals();
      db.sqlite.close();
    }
  });

  it("0054 refuses to store a blank store id", () => {
    const db = createMigratedSqliteD1();
    try {
      expect(() => db.sqlite.exec(`INSERT INTO stores (id, name) VALUES ('', '空 ID')`)).toThrow(/store_id_blank/);
      // 空白だけの ID も同じ (全角スペースを含む)。
      expect(() => db.sqlite.exec(`INSERT INTO stores (id, name) VALUES ('　 ', '空白 ID')`)).toThrow(
        /store_id_blank/
      );
      db.sqlite.exec(`INSERT INTO stores (id, name) VALUES ('kyoto2', '京都 2')`);
      expect(() => db.sqlite.exec(`UPDATE stores SET id = '' WHERE id = 'kyoto2'`)).toThrow(/store_id_blank/);
      // 店舗 ID 以外の更新は素通りする。
      db.sqlite.exec(`UPDATE stores SET name = '京都 二号店' WHERE id = 'kyoto2'`);
      expect(db.sqlite.prepare(`SELECT name FROM stores WHERE id = 'kyoto2'`).get()).toEqual({ name: "京都 二号店" });
    } finally {
      db.sqlite.close();
    }
  });
});
