import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import { createAccessJwksFetchMock, createAccessJwtFixture as createAccessJwtFixtureBase, requestUrl, type AccessJwk, insertAdminUser as insertAdminUserHelper, type AdminRole } from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const TEAM_DOMAIN = "https://team.example.cloudflareaccess.com";
const ACCESS_AUD = "line-friends-aud";
const ADMIN_EMAIL = "owner@example.com";
const ADMIN_ACCESS_SUBJECT = "access-subject-line-friends";


const createAccessJwtFixture = () =>
  createAccessJwtFixtureBase({
    issuer: TEAM_DOMAIN,
    audience: ACCESS_AUD,
    keyId: "line-friends-key-1",
    claims: { email: ADMIN_EMAIL, sub: ADMIN_ACCESS_SUBJECT }
  });

// access certs のみ捌く（LINE API を呼ばない list/link/ignore 用）
const createFetchMock = (jwk: AccessJwk) => createAccessJwksFetchMock(TEAM_DOMAIN, jwk);

const U = (c: string) => "U" + c.repeat(32);

// access certs + LINE followers/ids + profile を1つの fetch mock で捌く（sync 用）
const createLineFetchMock = (
  jwk: AccessJwk,
  line: {
    ids?: Array<{ userIds: string[]; next?: string }>;
    profiles?: Record<string, { status: number; body?: unknown }>;
  }
) => {
  let idsCall = 0;
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = requestUrl(input);
    if (url === `${TEAM_DOMAIN}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    if (url.startsWith("https://api.line.me/v2/bot/followers/ids")) {
      const pages = line.ids ?? [{ userIds: [] }];
      const page = pages[Math.min(idsCall, pages.length - 1)];
      idsCall++;
      return Response.json({ userIds: page.userIds, next: page.next });
    }
    if (url.startsWith("https://api.line.me/v2/bot/profile/")) {
      const id = decodeURIComponent(url.split("/profile/")[1]);
      const p = line.profiles?.[id];
      if (!p) return Response.json({ displayName: `name-${id.slice(0, 5)}` });
      return new Response(p.body ? JSON.stringify(p.body) : "", { status: p.status });
    }
    return Response.json({ message: "unexpected" }, { status: 404 });
  });
};

const baseEnv = (db: SqliteD1Database): Record<string, unknown> => ({
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  ACCESS_AUD,
  DB: db,
  LINE_CHANNEL_ID: "login-channel-1",
  LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "msg-token-1"
});

const insertAdminUser = (db: SqliteD1Database, role: AdminRole = "owner") =>
  insertAdminUserHelper(db, {
    id: "admin_lf_1",
    email: ADMIN_EMAIL,
    accessSubject: ADMIN_ACCESS_SUBJECT,
    role,
    updatedAt: "2026-05-19T00:00:00.000Z",
  });

const seedStore = (db: SqliteD1Database, id = "store_test") => {
  db.sqlite.prepare(`INSERT INTO stores (id, name, timezone) VALUES (?, ?, 'Asia/Tokyo')`).run(id, `Store ${id}`);
};

// ── sync ────────────────────────────────────────────────────────────
const postSync = (db: SqliteD1Database, token: string | null) => {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Cf-Access-Jwt-Assertion"] = token;
  return createApp().request("/api/admin/line-friends/sync", { method: "POST", headers }, baseEnv(db));
};

describe("line-friends sync (POST /api/admin/line-friends/sync)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("upserts follower ids + caches profiles, returns counts (owner)", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      const access = createAccessJwtFixture();
      vi.stubGlobal(
        "fetch",
        createLineFetchMock(access.jwk, {
          ids: [{ userIds: [U("a"), U("b")] }],
          profiles: {
            [U("a")]: { status: 200, body: { displayName: "田中花子", pictureUrl: "https://x/a.jpg" } },
            [U("b")]: { status: 404 }
          }
        })
      );

      const res = await postSync(db, access.token);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        ok: true,
        totalFriends: 2,
        fetched: 1,
        unavailable: 1,
        pending: 0,
        failed: 0
      });

      const row = db.sqlite
        .prepare("SELECT channel_id, display_name, profile_status FROM line_friend_directory WHERE line_user_id = ?")
        .get(U("a")) as { channel_id: string; display_name: string; profile_status: string };
      expect(row.channel_id).toBe("login-channel-1");
      expect(row.display_name).toBe("田中花子");
      expect(row.profile_status).toBe("fetched");

      // 同期操作が監査ログに記録される（PII 本体なし・件数サマリのみ）。
      const audit = db.sqlite
        .prepare("SELECT action, target_id FROM audit_logs WHERE action = 'line_friend.sync'")
        .get() as { action: string; target_id: string };
      expect(audit.target_id).toBe("login-channel-1");
    } finally {
      db.sqlite.close();
    }
  });

  it("403 from profile leaves the row pending (no poisoning)", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      const access = createAccessJwtFixture();
      vi.stubGlobal(
        "fetch",
        createLineFetchMock(access.jwk, { ids: [{ userIds: [U("a")] }], profiles: { [U("a")]: { status: 403 } } })
      );
      const res = await postSync(db, access.token);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, pending: 1, fetched: 0, unavailable: 0, failed: 1 });
      const s = db.sqlite
        .prepare("SELECT profile_status AS s FROM line_friend_directory WHERE line_user_id = ?")
        .get(U("a")) as { s: string };
      expect(s.s).toBe("pending");
    } finally {
      db.sqlite.close();
    }
  });

  it("upserts more than one chunk worth of follower ids (>100, chunked, no crash)", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      const ids = Array.from({ length: 150 }, (_, i) => "U" + i.toString(16).padStart(32, "0"));
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createLineFetchMock(access.jwk, { ids: [{ userIds: ids }] }));
      const res = await postSync(db, access.token);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, totalFriends: 150 });
      const n = db.sqlite.prepare("SELECT COUNT(*) AS n FROM line_friend_directory").get() as { n: number };
      expect(n.n).toBe(150);
    } finally {
      db.sqlite.close();
    }
  });

  it("is idempotent across re-sync (no duplicate rows)", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      const access = createAccessJwtFixture();
      vi.stubGlobal(
        "fetch",
        createLineFetchMock(access.jwk, {
          ids: [{ userIds: [U("a")] }],
          profiles: { [U("a")]: { status: 200, body: { displayName: "x" } } }
        })
      );
      await postSync(db, access.token);
      await postSync(db, access.token);
      const n = db.sqlite.prepare("SELECT COUNT(*) AS n FROM line_friend_directory").get() as { n: number };
      expect(n.n).toBe(1);
    } finally {
      db.sqlite.close();
    }
  });

  it("on followers/ids mid-failure: returns 502 + writes line_friend.sync_failed audit (no PII)", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      const access = createAccessJwtFixture();
      let call = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = requestUrl(input);
          if (url === `${TEAM_DOMAIN}/cdn-cgi/access/certs`) return Response.json({ keys: [access.jwk] });
          if (url.startsWith("https://api.line.me/v2/bot/followers/ids")) {
            call++;
            if (call === 1) return Response.json({ userIds: [U("a")], next: "CURSOR" });
            return new Response("boom", { status: 500 }); // 2ページ目で失敗
          }
          return Response.json({ displayName: "x" });
        })
      );
      const res = await postSync(db, access.token);
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ ok: false, error: "line_api_error" });
      const audit = db.sqlite
        .prepare("SELECT target_id, metadata_json FROM audit_logs WHERE action = 'line_friend.sync_failed'")
        .get() as { target_id: string; metadata_json: string };
      expect(audit.target_id).toBe("login-channel-1");
      // PII 本体（line_user_id / display_name）を含まない。
      expect(audit.metadata_json).not.toContain(U("a"));
      expect(audit.metadata_json).not.toContain("display_name");
    } finally {
      db.sqlite.close();
    }
  });

  it("403 for staff; 200 for system_admin", async () => {
    const dbStaff = createMigratedSqliteD1();
    try {
      insertAdminUser(dbStaff, "staff");
      const a1 = createAccessJwtFixture();
      vi.stubGlobal("fetch", createLineFetchMock(a1.jwk, { ids: [{ userIds: [] }] }));
      expect((await postSync(dbStaff, a1.token)).status).toBe(403);
    } finally {
      dbStaff.sqlite.close();
    }
    const dbSys = createMigratedSqliteD1();
    try {
      insertAdminUser(dbSys, "system_admin");
      const a2 = createAccessJwtFixture();
      vi.stubGlobal("fetch", createLineFetchMock(a2.jwk, { ids: [{ userIds: [] }] }));
      expect((await postSync(dbSys, a2.token)).status).toBe(200);
    } finally {
      dbSys.sqlite.close();
    }
  });
});

// ── list ────────────────────────────────────────────────────────────
describe("line-friends list (GET /api/admin/line-friends)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const seedFriend = (
    db: SqliteD1Database,
    id: string,
    opts: Partial<{ name: string; status: string; review: string }> = {}
  ) => {
    db.sqlite
      .prepare(
        `INSERT INTO line_friend_directory (channel_id, line_user_id, display_name, profile_status, review_state, first_seen_at)
         VALUES ('login-channel-1', ?, ?, ?, ?, '2026-05-31T00:00:00.000Z')`
      )
      .run(id, opts.name ?? null, opts.status ?? "fetched", opts.review ?? "pending");
  };
  const linkIdentity = (db: SqliteD1Database, id: string, customerId: string) => {
    db.sqlite
      .prepare(`INSERT INTO customers (id, display_name, updated_at) VALUES (?, '既存客', '2026-05-31T00:00:00.000Z')`)
      .run(customerId);
    db.sqlite
      .prepare(
        `INSERT INTO line_identities (id, customer_id, provider, channel_id, line_user_id, updated_at)
         VALUES (?, ?, 'line', 'login-channel-1', ?, '2026-05-31T00:00:00.000Z')`
      )
      .run("li_" + customerId, customerId, id);
  };
  const getList = (db: SqliteD1Database, token: string, qs = "") =>
    createApp().request(`/api/admin/line-friends${qs}`, { headers: { "Cf-Access-Jwt-Assertion": token } }, baseEnv(db));

  it("default filter 'unlinked' excludes only linked friends (legacy review_state ignored is no longer filtered)", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedFriend(db, U("a"), { name: "田中" });
      // 旧「新規客として除外」(review_state='ignored') の行も未紐付け一覧に再表示される。
      seedFriend(db, U("b"), { name: "鈴木", review: "ignored" });
      seedFriend(db, U("c"), { name: "佐藤" });
      linkIdentity(db, U("c"), "cust_c");
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));
      const res = await getList(db, access.token);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: Array<{ lineUserId: string; linked: boolean }>; total: number };
      // U(a) と U(b) の両方（未紐付け）。U(c) は紐付け済みなので除外。順序は問わない。
      expect(new Set(body.items.map((i) => i.lineUserId))).toEqual(new Set([U("a"), U("b")]));
      expect(body.total).toBe(2);
    } finally {
      db.sqlite.close();
    }
  });

  it("filter 'linked' returns customerId; 'q' filters by name incl. LIKE metachars", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedFriend(db, U("a"), { name: "田中花子" });
      seedFriend(db, U("d"), { name: "100%太郎" });
      seedFriend(db, U("e"), { name: "100X太郎" }); // ESCAPE が効かないと q=100% で誤マッチする decoy
      seedFriend(db, U("c"), { name: "佐藤" });
      linkIdentity(db, U("c"), "cust_c");
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const linked = (await (await getList(db, access.token, "?filter=linked")).json()) as {
        items: Array<{ linked: boolean; linkedCustomerId: string | null }>;
      };
      expect(linked.items).toHaveLength(1);
      expect(linked.items[0]).toMatchObject({ linked: true, linkedCustomerId: "cust_c" });

      const search = (await (await getList(db, access.token, "?filter=all&q=花子")).json()) as {
        items: Array<{ lineUserId: string }>;
      };
      expect(search.items.map((i) => i.lineUserId)).toEqual([U("a")]);

      const pct = (await (await getList(db, access.token, "?filter=all&q=" + encodeURIComponent("100%"))).json()) as {
        items: Array<{ lineUserId: string }>;
      };
      expect(pct.items.map((i) => i.lineUserId)).toEqual([U("d")]);
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects an over-long search query (D1 LIKE 50-byte limit) with 400; 50-byte boundary passes", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));
      // "あ" = 3 bytes UTF-8. pattern = "%" + 3*n + "%" = 2 + 3n bytes.
      const over = await getList(db, access.token, "?filter=all&q=" + encodeURIComponent("あ".repeat(20))); // 62 bytes
      expect(over.status).toBe(400);
      const boundary = await getList(db, access.token, "?filter=all&q=" + encodeURIComponent("あ".repeat(16))); // 50 bytes
      expect(boundary.status).toBe(200);
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 403 for staff", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "staff");
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));
      expect((await getList(db, access.token)).status).toBe(403);
    } finally {
      db.sqlite.close();
    }
  });
});

// ── link ────────────────────────────────────────────────────────────
describe("line-friends link (POST /api/admin/line-friends/:id/link)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const seedFriend = (db: SqliteD1Database, id: string, name = "田中花子") =>
    db.sqlite
      .prepare(
        `INSERT INTO line_friend_directory (channel_id, line_user_id, display_name, picture_url, profile_status, first_seen_at)
         VALUES ('login-channel-1', ?, ?, 'https://x/p.jpg', 'fetched', '2026-05-31T00:00:00.000Z')`
      )
      .run(id, name);
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

  it("mode=new: creates customer + line_identity(channel=LINE_CHANNEL_ID, linked_by_admin=1) + audit, NO seed visit", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db, "store_test");
      seedFriend(db, U("a"));
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const res = await postLink(db, access.token, U("a"), {
        mode: "new",
        storeId: "store_test",
        newCustomer: { displayName: "田中花子", phone: "090-1111-2222" }
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; customerId: string };
      expect(body.ok).toBe(true);

      const li = db.sqlite
        .prepare(
          "SELECT channel_id, customer_id, display_name, friend_flag, official_friend_status, linked_by_admin FROM line_identities WHERE line_user_id = ?"
        )
        .get(U("a")) as {
        channel_id: string;
        customer_id: string;
        display_name: string;
        friend_flag: number;
        official_friend_status: string;
        linked_by_admin: number;
      };
      expect(li.channel_id).toBe("login-channel-1");
      expect(li.customer_id).toBe(body.customerId);
      expect(li.friend_flag).toBe(1);
      expect(li.official_friend_status).toBe("friend");
      // 既存客扱いは linked_by_admin=1 で表現する（偽の来店記録は作らない）。
      expect(li.linked_by_admin).toBe(1);

      // 紐付けでは来店履歴を seed しない（登録日付の偽 visit を作らない）。
      const visitCount = db.sqlite
        .prepare("SELECT COUNT(*) AS n FROM customer_visits WHERE customer_id = ?")
        .get(body.customerId) as { n: number };
      expect(visitCount.n).toBe(0);

      const cust = db.sqlite
        .prepare("SELECT phone_normalized, phone_hash FROM customers WHERE id = ?")
        .get(body.customerId) as { phone_normalized: string | null; phone_hash: string | null };
      expect(cust.phone_normalized).toBeTruthy();
      expect(cust.phone_hash).toBeTruthy();

      const audit = db.sqlite
        .prepare("SELECT action, target_id FROM audit_logs WHERE action = 'line_friend.link.new'")
        .get() as { action: string; target_id: string };
      expect(audit.target_id).toBe(body.customerId);
    } finally {
      db.sqlite.close();
    }
  });

  it("mode=existing: links identity (linked_by_admin=1) WITHOUT seeding any visit", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db, "store_test");
      db.sqlite
        .prepare(`INSERT INTO customers (id, display_name, updated_at) VALUES ('cust_x', '既存', '2026-05-31T00:00:00.000Z')`)
        .run();
      db.sqlite
        .prepare(
          `INSERT INTO customer_visits (id, customer_id, store_id, visited_at, visit_source, status, recorded_by)
           VALUES ('v1', 'cust_x', 'store_test', '2026-05-01T00:00:00.000Z', 'reservation_completed', 'valid', 'seed_admin')`
        )
        .run();
      seedFriend(db, U("a"));
      db.sqlite
        .prepare(`INSERT INTO customers (id, display_name, updated_at) VALUES ('cust_y', '来店なし', '2026-05-31T00:00:00.000Z')`)
        .run();
      seedFriend(db, U("b"));
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      expect(
        (await postLink(db, access.token, U("a"), { mode: "existing", storeId: "store_test", customerId: "cust_x" }))
          .status
      ).toBe(200);
      // 既に実来店(reservation_completed)が1件。紐付けで増えも減りもしない。
      expect(
        (db.sqlite.prepare("SELECT COUNT(*) AS n FROM customer_visits WHERE customer_id = 'cust_x'").get() as {
          n: number;
        }).n
      ).toBe(1);
      // 実来店がある既存客でも、紐付け時に admin-link フラグは立つ。
      expect(
        (db.sqlite.prepare("SELECT linked_by_admin FROM line_identities WHERE customer_id = 'cust_x'").get() as {
          linked_by_admin: number;
        }).linked_by_admin
      ).toBe(1);

      expect(
        (await postLink(db, access.token, U("b"), { mode: "existing", storeId: "store_test", customerId: "cust_y" }))
          .status
      ).toBe(200);
      // 来店歴のない既存客でも seed visit は作らない（0件のまま）。
      expect(
        (db.sqlite.prepare("SELECT COUNT(*) AS n FROM customer_visits WHERE customer_id = 'cust_y'").get() as {
          n: number;
        }).n
      ).toBe(0);
      // 代わりに紐付けフラグが立つ（次回 LINE 予約で既存客として自動確定）。
      const cy = db.sqlite
        .prepare("SELECT linked_by_admin FROM line_identities WHERE customer_id = 'cust_y'")
        .get() as { linked_by_admin: number };
      expect(cy.linked_by_admin).toBe(1);
    } finally {
      db.sqlite.close();
    }
  });

  it("409 friend_not_fetched when the profile is not yet fetched (visual-verify guard)", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db, "store_test");
      db.sqlite
        .prepare(
          `INSERT INTO line_friend_directory (channel_id, line_user_id, profile_status, first_seen_at)
           VALUES ('login-channel-1', ?, 'pending', '2026-05-31T00:00:00.000Z')`
        )
        .run(U("a"));
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));
      const res = await postLink(db, access.token, U("a"), {
        mode: "new",
        storeId: "store_test",
        newCustomer: { displayName: "x" }
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ ok: false, error: "friend_not_fetched" });
    } finally {
      db.sqlite.close();
    }
  });

  it("409 already_linked on second link; 404 friend_not_found", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db, "store_test");
      seedFriend(db, U("a"));
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));
      await postLink(db, access.token, U("a"), { mode: "new", storeId: "store_test", newCustomer: { displayName: "x" } });
      const dup = await postLink(db, access.token, U("a"), {
        mode: "new",
        storeId: "store_test",
        newCustomer: { displayName: "y" }
      });
      expect(dup.status).toBe(409);
      expect(await dup.json()).toMatchObject({ ok: false, error: "already_linked" });
      // 有効 hex の未登録 id → 名簿に居ないので friend_not_found(404)。
      const missing = await postLink(db, access.token, U("f"), {
        mode: "new",
        storeId: "store_test",
        newCustomer: { displayName: "x" }
      });
      expect(missing.status).toBe(404);
    } finally {
      db.sqlite.close();
    }
  });

  it("400 invalid (no displayName / bad phone); 404 store_not_found; 403 staff; 200 system_admin", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db, "store_test");
      seedFriend(db, U("a"));
      seedFriend(db, U("f"));
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));
      expect(
        (await postLink(db, access.token, U("a"), { mode: "new", storeId: "store_test", newCustomer: {} })).status
      ).toBe(400);
      // 有効 hex の登録済み id で、非空だが正規化不能な電話 → invalid_request(400)。
      expect(
        (await postLink(db, access.token, U("f"), {
          mode: "new",
          storeId: "store_test",
          newCustomer: { displayName: "x", phone: "abc" }
        })).status
      ).toBe(400);
      expect(
        (await postLink(db, access.token, U("a"), { mode: "new", storeId: "nope", newCustomer: { displayName: "x" } }))
          .status
      ).toBe(404);
    } finally {
      db.sqlite.close();
    }

    const dbStaff = createMigratedSqliteD1();
    try {
      insertAdminUser(dbStaff, "staff");
      seedStore(dbStaff, "store_test");
      seedFriend(dbStaff, U("a"));
      const a1 = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(a1.jwk));
      expect(
        (await postLink(dbStaff, a1.token, U("a"), {
          mode: "new",
          storeId: "store_test",
          newCustomer: { displayName: "x" }
        })).status
      ).toBe(403);
    } finally {
      dbStaff.sqlite.close();
    }

    const dbSys = createMigratedSqliteD1();
    try {
      insertAdminUser(dbSys, "system_admin");
      seedStore(dbSys, "store_test");
      seedFriend(dbSys, U("a"));
      const a2 = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(a2.jwk));
      expect(
        (await postLink(dbSys, a2.token, U("a"), {
          mode: "new",
          storeId: "store_test",
          newCustomer: { displayName: "x" }
        })).status
      ).toBe(200);
    } finally {
      dbSys.sqlite.close();
    }
  });

  it("mode=existing: rejects linking to an archived customer (customer_not_found)", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db, "store_test");
      seedFriend(db, U("a"));
      db.sqlite
        .prepare(
          `INSERT INTO customers (id, display_name, block_status, archived_at, updated_at)
           VALUES ('cust_archived_link', 'アーカイブ客', 'active', '2026-05-31T00:00:00.000Z', '2026-05-31T00:00:00.000Z')`
        )
        .run();
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const res = await postLink(db, access.token, U("a"), {
        mode: "existing",
        storeId: "store_test",
        customerId: "cust_archived_link"
      });
      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ ok: false, error: "customer_not_found" });
    } finally {
      db.sqlite.close();
    }
  });
});

// ── CSRF / cross-origin guard (admin unsafe methods) ────────────────
describe("admin CSRF guard (Sec-Fetch-Site / Origin)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects a cross-site state-changing request even with valid auth (403, no effect)", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createLineFetchMock(access.jwk, { ids: [{ userIds: [U("a")] }] }));
      const res = await createApp().request(
        "/api/admin/line-friends/sync",
        { method: "POST", headers: { "Cf-Access-Jwt-Assertion": access.token, "Sec-Fetch-Site": "cross-site" } },
        baseEnv(db)
      );
      expect(res.status).toBe(403);
      // guard runs before the handler → no directory rows created.
      const n = db.sqlite.prepare("SELECT COUNT(*) AS n FROM line_friend_directory").get() as { n: number };
      expect(n.n).toBe(0);
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects a foreign Origin host (403)", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createLineFetchMock(access.jwk, { ids: [{ userIds: [] }] }));
      const res = await createApp().request(
        "/api/admin/line-friends/sync",
        {
          method: "POST",
          headers: {
            "Cf-Access-Jwt-Assertion": access.token,
            Origin: "https://evil.example.com",
            Host: "admin.example.com"
          }
        },
        baseEnv(db)
      );
      expect(res.status).toBe(403);
    } finally {
      db.sqlite.close();
    }
  });

  it("allows same-origin (and header-absent) requests", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      const access = createAccessJwtFixture();
      vi.stubGlobal(
        "fetch",
        createLineFetchMock(access.jwk, {
          ids: [{ userIds: [U("a")] }],
          profiles: { [U("a")]: { status: 200, body: { displayName: "x" } } }
        })
      );
      const res = await createApp().request(
        "/api/admin/line-friends/sync",
        { method: "POST", headers: { "Cf-Access-Jwt-Assertion": access.token, "Sec-Fetch-Site": "same-origin" } },
        baseEnv(db)
      );
      expect(res.status).toBe(200);
    } finally {
      db.sqlite.close();
    }
  });
});
