import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import { createAccessJwtFixture, createAccessJwksFetchMock, insertAdminUser as insertAdminUserHelper, type AdminRole } from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

// カルテ起点「LINEと紐付け」導線が依存するバックエンド契約の特性化テスト。
// (a) GET /line-friends?filter=unlinked&q=NAME が未紐付け友だちを名前で返す
// (b) POST /line-friends/:id/link mode=existing が既存顧客へ紐付け(channel=LINE_CHANNEL_ID)
// (c) ブロック客は customer_blocked で弾かれる
// 既存実装(src/admin/line-friends.ts)で PASS するはず。FAIL = backend 退行。

const TEAM_DOMAIN = "https://team.example.cloudflareaccess.com";
const ACCESS_AUD = "card-flow-aud";
const ADMIN_EMAIL = "owner@example.com";
const ADMIN_ACCESS_SUBJECT = "access-subject-card-flow";
const ACCESS_KEY_ID = "card-flow-key-1";


const createCardFlowAccessFixture = () =>
  createAccessJwtFixture({
    issuer: TEAM_DOMAIN,
    audience: ACCESS_AUD,
    keyId: ACCESS_KEY_ID,
    claims: { email: ADMIN_EMAIL, sub: ADMIN_ACCESS_SUBJECT }
  });

// access certs のみ捌く(LINE API は呼ばない list/link 用)
const U = (c: string) => "U" + c.repeat(32);

const baseEnv = (db: SqliteD1Database): Record<string, unknown> => ({
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  ACCESS_AUD,
  DB: db,
  LINE_CHANNEL_ID: "login-channel-1",
  LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "msg-token-1"
});

const insertAdminUser = (db: SqliteD1Database, role: AdminRole = "owner") =>
  insertAdminUserHelper(db, {
    id: "admin_cf_1",
    email: ADMIN_EMAIL,
    accessSubject: ADMIN_ACCESS_SUBJECT,
    role,
    updatedAt: "2026-05-19T00:00:00.000Z",
  });

const seedStore = (db: SqliteD1Database, id = "store_test") => {
  db.sqlite.prepare(`INSERT INTO stores (id, name, timezone) VALUES (?, ?, 'Asia/Tokyo')`).run(id, `Store ${id}`);
};

const seedFriend = (db: SqliteD1Database, id: string, name: string) =>
  db.sqlite
    .prepare(
      `INSERT INTO line_friend_directory (channel_id, line_user_id, display_name, picture_url, profile_status, review_state, first_seen_at)
       VALUES ('login-channel-1', ?, ?, 'https://x/p.jpg', 'fetched', 'pending', '2026-05-31T00:00:00.000Z')`
    )
    .run(id, name);

const seedCustomer = (db: SqliteD1Database, id: string, name: string, blockStatus = "active") =>
  db.sqlite
    .prepare(
      `INSERT INTO customers (id, display_name, block_status, updated_at)
       VALUES (?, ?, ?, '2026-05-31T00:00:00.000Z')`
    )
    .run(id, name, blockStatus);

const getList = (db: SqliteD1Database, token: string, qs = "") =>
  createApp().request(
    `/api/admin/line-friends${qs}`,
    { headers: { "Cf-Access-Jwt-Assertion": token } },
    baseEnv(db)
  );

const postLink = (db: SqliteD1Database, token: string, id: string, body: unknown) =>
  createApp().request(
    `/api/admin/line-friends/${id}/link`,
    {
      method: "POST",
      headers: { "Cf-Access-Jwt-Assertion": token, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    },
    baseEnv(db)
  );

describe("card-flow: 顧客カルテからのLINE紐付け導線が依存するバックエンド契約", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    { state: "deleted", status: 404, error: "friend_not_found" },
    { state: "pending", status: 409, error: "friend_not_fetched" },
    { state: "unavailable", status: 409, error: "friend_not_fetched" },
  ])("reports the current directory state after a $state race", async ({ state, status, error }) => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db);
      seedStore(db);
      seedCustomer(db, "race_customer", "既存顧客");
      seedFriend(db, U("a"), "友だち");
      const access = createCardFlowAccessFixture();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));
      const batch = db.batch.bind(db);
      db.batch = async statements => {
        if (state === "deleted") {
          db.sqlite.prepare("DELETE FROM line_friend_directory WHERE line_user_id = ?").run(U("a"));
        } else {
          db.sqlite.prepare("UPDATE line_friend_directory SET profile_status = ? WHERE line_user_id = ?").run(state, U("a"));
        }
        return batch(statements);
      };

      const response = await postLink(db, access.token, U("a"), {
        mode: "existing", storeId: "store_test", customerId: "race_customer"
      });

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ ok: false, error });
      expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM line_identities").get()).toEqual({ n: 0 });
      expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'line_friend.link.existing'").get()).toEqual({ n: 0 });
    } finally {
      db.sqlite.close();
    }
  });

  it("(a) GET /line-friends?filter=unlinked&q=NAME で未紐付け友だちを名前検索できる", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedFriend(db, U("a"), "田中花子");
      seedFriend(db, U("b"), "鈴木一郎");
      const access = createCardFlowAccessFixture();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const res = await getList(db, access.token, "?filter=unlinked&q=" + encodeURIComponent("田中"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: Array<{ lineUserId: string; displayName: string | null; profileStatus: string; linked: boolean }>;
      };
      expect(body.items.map((i) => i.lineUserId)).toEqual([U("a")]);
      expect(body.items[0]).toMatchObject({ displayName: "田中花子", profileStatus: "fetched", linked: false });
    } finally {
      db.sqlite.close();
    }
  });

  it("(b) POST /line-friends/:id/link mode=existing で既存顧客へ紐付け(channel=LINE_CHANNEL_ID)", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db, "store_test");
      seedCustomer(db, "cust_paper", "紙カルテ太郎");
      seedFriend(db, U("a"), "紙カルテ太郎");
      const access = createCardFlowAccessFixture();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const res = await postLink(db, access.token, U("a"), {
        mode: "existing",
        storeId: "store_test",
        customerId: "cust_paper"
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; customerId: string };
      expect(body).toMatchObject({ ok: true, customerId: "cust_paper" });

      const li = db.sqlite
        .prepare("SELECT channel_id, customer_id, friend_flag FROM line_identities WHERE line_user_id = ?")
        .get(U("a")) as { channel_id: string; customer_id: string; friend_flag: number };
      expect(li.channel_id).toBe("login-channel-1"); // = env.LINE_CHANNEL_ID 不変条件
      expect(li.customer_id).toBe("cust_paper");
      expect(li.friend_flag).toBe(1);

      // 紐付け後は filter=unlinked から消える(カルテ側もボタン非表示になる根拠)。
      const after = await getList(db, access.token, "?filter=unlinked&q=" + encodeURIComponent("紙カルテ"));
      const afterBody = (await after.json()) as { items: Array<{ lineUserId: string }> };
      expect(afterBody.items.map((i) => i.lineUserId)).toEqual([]);
    } finally {
      db.sqlite.close();
    }
  });

  it("(c) ブロック中の顧客への紐付けは customer_blocked(409) で弾かれる", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db, "store_test");
      seedCustomer(db, "cust_blocked", "ブロック客", "blocked");
      seedFriend(db, U("a"), "ブロック客");
      const access = createCardFlowAccessFixture();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const res = await postLink(db, access.token, U("a"), {
        mode: "existing",
        storeId: "store_test",
        customerId: "cust_blocked"
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ ok: false, error: "customer_blocked" });
    } finally {
      db.sqlite.close();
    }
  });

  it("(d) staff は forbidden(403)・privileged は存在しない顧客で customer_not_found(404)", async () => {
    // 紐付けは isAdminPrivileged (owner / system_admin) 限定。staff は backend が 403 で弾く。
    // カルテのボタンも useAuth().isPrivileged (owner / system_admin) で同様にゲートされ整合する。
    const dbStaff = createMigratedSqliteD1();
    try {
      insertAdminUser(dbStaff, "staff");
      seedStore(dbStaff, "store_test");
      seedCustomer(dbStaff, "cust_ok", "店員紐付け客");
      seedFriend(dbStaff, U("a"), "店員紐付け客");
      const access = createCardFlowAccessFixture();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const forbidden = await postLink(dbStaff, access.token, U("a"), {
        mode: "existing",
        storeId: "store_test",
        customerId: "cust_ok"
      });
      expect(forbidden.status).toBe(403);
      expect(await forbidden.json()).toMatchObject({ ok: false, error: "forbidden" });
    } finally {
      dbStaff.sqlite.close();
    }

    vi.unstubAllGlobals();

    const dbOwner = createMigratedSqliteD1();
    try {
      insertAdminUser(dbOwner, "owner");
      seedStore(dbOwner, "store_test");
      seedFriend(dbOwner, U("b"), "幽霊客");
      const access = createCardFlowAccessFixture();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const missing = await postLink(dbOwner, access.token, U("b"), {
        mode: "existing",
        storeId: "store_test",
        customerId: "no_such_customer"
      });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ ok: false, error: "customer_not_found" });
    } finally {
      dbOwner.sqlite.close();
    }
  });
});
