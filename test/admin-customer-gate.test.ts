import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import {
  createAccessJwksFetchMock,
  createAccessJwtFixture,
  insertAdminUser,
  type AccessSigningKey,
  type AdminRole
} from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const TEAM_DOMAIN = "https://team.example.cloudflareaccess.com";
const ACCESS_AUD = "customer-gate-aud";
const ADMIN_EMAIL = "staff@example.com";
const ADMIN_SUBJECT = "sub-customer-gate";
const ADMIN_ID = "admin_customer_gate_1";
const OWNER_EMAIL = "owner@example.com";

const createFixture = () =>
  createAccessJwtFixture({
    issuer: TEAM_DOMAIN,
    audience: ACCESS_AUD,
    keyId: "customer-gate-key-1",
    claims: { email: ADMIN_EMAIL, sub: ADMIN_SUBJECT }
  });

/**
 * Move the fake clock and mint a token that is valid at the new time. The Access
 * JWT fixture only lives 10 minutes, so any test that advances time further has to
 * re-sign — with the same key, so the already-stubbed JWKS still validates it.
 */
const tokenAt = (signingKey: AccessSigningKey, at: string): string => {
  vi.setSystemTime(new Date(at));
  return createAccessJwtFixture({
    issuer: TEAM_DOMAIN,
    audience: ACCESS_AUD,
    keyId: "customer-gate-key-1",
    claims: { email: ADMIN_EMAIL, sub: ADMIN_SUBJECT },
    signingKey
  }).token;
};

type SentEmail = { to: string; subject: string; text: string };

/**
 * The Email binding the worker sees. The 6-digit code is read back out of the sent
 * body, which is the only place it exists outside the request that generated it.
 */
const createEmailBinding = (sent: SentEmail[], behavior: "ok" | "fail" | "timeout" = "ok") => ({
  send: async (message: { to: string; subject: string; text: string }) => {
    if (behavior === "fail") throw new Error("email_send_failed: refused");
    if (behavior === "timeout") throw new Error("email_send_timeout:5000ms");
    sent.push({ to: message.to, subject: message.subject, text: message.text });
  }
});

const baseEnv = (db: SqliteD1Database, email?: unknown): Record<string, unknown> => ({
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  ACCESS_AUD,
  DB: db,
  EMAIL: email,
  PENDING_APPROVAL_OWNER_EMAIL: OWNER_EMAIL
});

const request = (
  db: SqliteD1Database,
  token: string,
  path: string,
  init: RequestInit = {},
  env: Record<string, unknown> = baseEnv(db)
) => {
  const headers = new Headers(init.headers);
  headers.set("Cf-Access-Jwt-Assertion", token);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return createApp().request(path, { ...init, headers }, env);
};

const seedAdmin = (db: SqliteD1Database, role: AdminRole = "staff") =>
  insertAdminUser(db, {
    id: ADMIN_ID,
    email: ADMIN_EMAIL,
    accessSubject: ADMIN_SUBJECT,
    role,
    staffMemberId: role === "staff" ? "staff_gate_kyoto" : null,
    updatedAt: "2026-08-30T00:00:00.000Z"
  });

const seedStaffMember = (db: SqliteD1Database) => {
  db.sqlite
    .prepare(
      `INSERT INTO staff_members (id, store_id, display_name, role, active, created_at, updated_at)
       VALUES ('staff_gate_kyoto', 'kyoto', 'ゲート担当', 'staff', 1, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z')`
    )
    .run();
};

const seedCustomer = (db: SqliteD1Database, id = "cust_gate_1") => {
  db.sqlite
    .prepare(
      `INSERT INTO customers (id, display_name, display_name_kana, phone_normalized, block_status, memo, created_store_id, created_at, updated_at)
       VALUES (?, '門番 太郎', 'モンバン タロウ', '08099990001', 'active', '秘密のメモ', 'kyoto', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`
    )
    .run(id);
};

/** The 6-digit code out of the one email the request sent. */
const codeFromEmail = (sent: SentEmail[]): string => {
  const match = /確認コード: (\d{6})/.exec(sent.map((m) => m.text).join("\n"));
  if (!match) throw new Error(`no code in email: ${sent.map((m) => m.text).join("\n")}`);
  return match[1];
};

const issueAndVerify = async (db: SqliteD1Database, token: string, sent: SentEmail[]) => {
  const env = baseEnv(db, createEmailBinding(sent));
  const issued = await request(db, token, "/api/admin/customer-gate/request", { method: "POST" }, env);
  const { challengeId } = (await issued.json()) as { challengeId: string };
  return request(
    db,
    token,
    "/api/admin/customer-gate/verify",
    { method: "POST", body: JSON.stringify({ challengeId, code: codeFromEmail(sent) }) },
    env
  );
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("customer tab owner-approval gate", () => {
  // 顧客タブが使うルート全部。承認が無い staff はここを 1 本も通れない (FR-001 / SC-001)。
  const gatedRoutes: Array<{ method: string; path: string; body?: unknown }> = [
    { method: "GET", path: "/api/admin/customers?mode=list" },
    { method: "GET", path: "/api/admin/customers?mode=list&view=archived" },
    { method: "GET", path: "/api/admin/customers/cust_gate_1" },
    { method: "GET", path: "/api/admin/customers/cust_gate_1/visits?offset=0" },
    { method: "GET", path: "/api/admin/customers/cust_gate_1/consents?offset=0" },
    { method: "POST", path: "/api/admin/customers/cust_gate_1/block", body: { idempotencyKey: "k1", reason: "r" } },
    { method: "POST", path: "/api/admin/customers/cust_gate_1/unblock", body: { idempotencyKey: "k2", reason: "r" } },
    { method: "POST", path: "/api/admin/customers/cust_gate_1/archive", body: { idempotencyKey: "k3", reason: "r" } },
    { method: "POST", path: "/api/admin/customers/cust_gate_1/unarchive", body: { idempotencyKey: "k4", reason: "r" } },
    { method: "PUT", path: "/api/admin/customers/cust_gate_1/memo", body: { memo: "上書き" } },
    { method: "PATCH", path: "/api/admin/customers/cust_gate_1/profile", body: { displayName: "改名" } },
    { method: "PUT", path: "/api/admin/customers/cust_gate_1/visits/visit_1/notes", body: { treatmentNotes: null } },
    { method: "POST", path: "/api/admin/customers", body: { idempotencyKey: "k5", displayName: "新規" } }
  ];

  it.each(gatedRoutes)("refuses an unapproved staff member on $method $path", async (route) => {
    const db = createMigratedSqliteD1();
    const access = createFixture();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));
    try {
      seedStaffMember(db);
      seedAdmin(db);
      seedCustomer(db);

      const res = await request(db, access.token, route.path, {
        method: route.method,
        body: route.body === undefined ? undefined : JSON.stringify(route.body)
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ ok: false, reason: "customer_gate_required" });
    } finally {
      db.sqlite.close();
    }
  });

  it("leaks no customer field through a refused response", async () => {
    const db = createMigratedSqliteD1();
    const access = createFixture();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));
    try {
      seedStaffMember(db);
      seedAdmin(db);
      seedCustomer(db);

      for (const route of gatedRoutes) {
        const res = await request(db, access.token, route.path, {
          method: route.method,
          body: route.body === undefined ? undefined : JSON.stringify(route.body)
        });
        const text = await res.text();
        expect(text).not.toContain("門番 太郎");
        expect(text).not.toContain("08099990001");
        expect(text).not.toContain("秘密のメモ");
      }
    } finally {
      db.sqlite.close();
    }
  });

  it("opens the tab for 12 hours once the emailed code is verified", async () => {
    // 先に時計を止めてから JWT を作る。あとから過去に巻き戻すと iat が未来になり、
    // 認証が 403 で落ちてゲートのテストにならない。
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-30T01:00:00.000Z"));
    const db = createMigratedSqliteD1();
    const access = createFixture();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));
    try {
      seedStaffMember(db);
      seedAdmin(db);
      seedCustomer(db);
      const sent: SentEmail[] = [];

      const verified = await issueAndVerify(db, access.token, sent);
      expect(verified.status).toBe(200);
      expect(await verified.json()).toEqual({
        ok: true,
        grantedUntil: "2026-08-30T13:00:00.000Z"
      });
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe(OWNER_EMAIL);

      expect((await request(db, access.token, "/api/admin/customers?mode=list")).status).toBe(200);

      // 承認の境界。
      const stillOpen = await request(db, tokenAt(access, "2026-08-30T12:59:00.000Z"), "/api/admin/customers?mode=list");
      expect(stillOpen.status).toBe(200);
      const expired = await request(db, tokenAt(access, "2026-08-30T13:01:00.000Z"), "/api/admin/customers?mode=list");
      expect(expired.status).toBe(403);
      expect(await expired.json()).toEqual({ ok: false, reason: "customer_gate_required" });
    } finally {
      db.sqlite.close();
    }
  });

  it("burns the challenge after five wrong codes and refuses the right one afterwards", async () => {
    const db = createMigratedSqliteD1();
    const access = createFixture();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));
    try {
      seedStaffMember(db);
      seedAdmin(db);
      const sent: SentEmail[] = [];
      const env = baseEnv(db, createEmailBinding(sent));
      const issued = await request(db, access.token, "/api/admin/customer-gate/request", { method: "POST" }, env);
      const { challengeId } = (await issued.json()) as { challengeId: string };
      const realCode = codeFromEmail(sent);
      const wrongCode = realCode === "000000" ? "111111" : "000000";

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const res = await request(
          db,
          access.token,
          "/api/admin/customer-gate/verify",
          { method: "POST", body: JSON.stringify({ challengeId, code: wrongCode }) },
          env
        );
        expect(res.status).toBe(400);
      }

      const withRealCode = await request(
        db,
        access.token,
        "/api/admin/customer-gate/verify",
        { method: "POST", body: JSON.stringify({ challengeId, code: realCode }) },
        env
      );
      expect(withRealCode.status).toBe(400);
      expect((await request(db, access.token, "/api/admin/customers?mode=list", {}, env)).status).toBe(403);
    } finally {
      db.sqlite.close();
    }
  });

  it("refuses a code that has passed its 10-minute expiry", async () => {
    // 先に時計を止めてから JWT を作る。あとから過去に巻き戻すと iat が未来になり、
    // 認証が 403 で落ちてゲートのテストにならない。
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-30T01:00:00.000Z"));
    const db = createMigratedSqliteD1();
    const access = createFixture();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));
    try {
      seedStaffMember(db);
      seedAdmin(db);
      const sent: SentEmail[] = [];
      const env = baseEnv(db, createEmailBinding(sent));
      const issued = await request(db, access.token, "/api/admin/customer-gate/request", { method: "POST" }, env);
      const { challengeId, expiresAt } = (await issued.json()) as { challengeId: string; expiresAt: string };
      expect(expiresAt).toBe("2026-08-30T01:10:00.000Z");

      vi.setSystemTime(new Date("2026-08-30T01:10:01.000Z"));
      const res = await request(
        db,
        access.token,
        "/api/admin/customer-gate/verify",
        { method: "POST", body: JSON.stringify({ challengeId, code: codeFromEmail(sent) }) },
        env
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, reason: "invalid_code" });
    } finally {
      db.sqlite.close();
    }
  });

  it("holds issuance to one per minute and ten per hour", async () => {
    // 先に時計を止めてから JWT を作る。あとから過去に巻き戻すと iat が未来になり、
    // 認証が 403 で落ちてゲートのテストにならない。
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-30T01:00:00.000Z"));
    const db = createMigratedSqliteD1();
    const access = createFixture();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));
    try {
      seedStaffMember(db);
      seedAdmin(db);
      const sent: SentEmail[] = [];
      const env = baseEnv(db, createEmailBinding(sent));
      const issueAt = (at: string) =>
        request(db, tokenAt(access, at), "/api/admin/customer-gate/request", { method: "POST" }, env);

      expect((await issueAt("2026-08-30T01:00:00.000Z")).status).toBe(200);
      // 同じ分のうちに続けて要求すると断られる (FR-006 の 60 秒クールダウン)。
      expect((await issueAt("2026-08-30T01:00:30.000Z")).status).toBe(429);

      // 2 分おきに進めれば通るが、1 時間で 10 通が上限。
      for (let minute = 1; minute < 10; minute += 1) {
        const at = `2026-08-30T01:${String(minute * 2).padStart(2, "0")}:00.000Z`;
        expect((await issueAt(at)).status).toBe(200);
      }
      expect((await issueAt("2026-08-30T01:22:00.000Z")).status).toBe(429);
      expect(sent).toHaveLength(10);
    } finally {
      db.sqlite.close();
    }
  });

  it("never leaves the code in the database, the response or the audit log", async () => {
    const db = createMigratedSqliteD1();
    const access = createFixture();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));
    try {
      seedStaffMember(db);
      seedAdmin(db);
      const sent: SentEmail[] = [];
      const env = baseEnv(db, createEmailBinding(sent));
      const issued = await request(db, access.token, "/api/admin/customer-gate/request", { method: "POST" }, env);
      const bodyText = await issued.text();
      const code = codeFromEmail(sent);

      expect(bodyText).not.toContain(code);
      const rows = db.sqlite.prepare(`SELECT * FROM admin_customer_gate_challenges`).all() as Array<
        Record<string, unknown>
      >;
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain(code);

      const audit = db.sqlite
        .prepare(`SELECT action, actor_id, target_id, metadata_json FROM audit_logs`)
        .all() as Array<Record<string, unknown>>;
      expect(audit.map((row) => row.action)).toEqual(["customer_gate_code_requested"]);
      expect(JSON.stringify(audit)).not.toContain(code);
      expect(JSON.stringify(audit)).not.toContain(String(rows[0].code_hash));
    } finally {
      db.sqlite.close();
    }
  });

  it("writes exactly one verify audit row, matching the outcome", async () => {
    // 承認の確定と監査行は同じ batch に入れてある (FR-010)。監査行は「直前の UPDATE が
    // 今回の試行で verified_at を書けたか」で 2 本の条件付き INSERT のどちらか一方だけが
    // 成立する形なので、条件を間違えると 0 行または 2 行になる。そこを固定する。
    const db = createMigratedSqliteD1();
    const access = createFixture();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));
    try {
      seedStaffMember(db);
      seedAdmin(db);
      const env = baseEnv(db, createEmailBinding([]));
      const verifyActions = () =>
        (
          db.sqlite
            .prepare(
              // id は UUID なので挿入順にならない。書き込み順は rowid で取る。
              `SELECT action FROM audit_logs WHERE action LIKE 'customer_gate_verif%' ORDER BY rowid`
            )
            .all() as Array<{ action: string }>
        ).map((row) => row.action);

      // 発行は 60 秒に 1 回までなので、同じ challenge に対して誤りと正解を続けて出す
      // (試行の上限は 5 回)。
      const sent: SentEmail[] = [];
      const sendingEnv = baseEnv(db, createEmailBinding(sent));
      const issued = await request(
        db,
        access.token,
        "/api/admin/customer-gate/request",
        { method: "POST" },
        sendingEnv
      );
      const { challengeId } = (await issued.json()) as { challengeId: string };
      const code = codeFromEmail(sent);
      const verify = (value: string) =>
        request(
          db,
          access.token,
          "/api/admin/customer-gate/verify",
          { method: "POST", body: JSON.stringify({ challengeId, code: value }) },
          env
        );

      expect((await verify(code === "000000" ? "111111" : "000000")).status).toBe(400);
      expect(verifyActions()).toEqual(["customer_gate_verify_failed"]);

      expect((await verify(code)).status).toBe(200);
      expect(verifyActions()).toEqual(["customer_gate_verify_failed", "customer_gate_verified"]);
    } finally {
      db.sqlite.close();
    }
  });

  it("drops the challenge when the owner email cannot be sent, and keeps it on a timeout", async () => {
    const db = createMigratedSqliteD1();
    const access = createFixture();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));
    try {
      seedStaffMember(db);
      seedAdmin(db);

      const failed = await request(
        db,
        access.token,
        "/api/admin/customer-gate/request",
        { method: "POST" },
        baseEnv(db, createEmailBinding([], "fail"))
      );
      expect(failed.status).toBe(502);
      expect(
        db.sqlite.prepare(`SELECT COUNT(*) AS n FROM admin_customer_gate_challenges`).get()
      ).toEqual({ n: 0 });
      // 監査行は残す。action は「申請した」であって「送信できた」ではないので、送信に失敗
      // しても嘘にならない。ここを消しに行くと監査ログが追記専用でなくなる。
      expect(
        db.sqlite
          .prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'customer_gate_code_requested'`)
          .get()
      ).toEqual({ n: 1 });

      // タイムアウトは「届いたかもしれない」なので行を残す (再送はしない)。
      db.sqlite.prepare(`DELETE FROM rate_limit_events`).run();
      const timedOut = await request(
        db,
        access.token,
        "/api/admin/customer-gate/request",
        { method: "POST" },
        baseEnv(db, createEmailBinding([], "timeout"))
      );
      expect(timedOut.status).toBe(200);
      expect(
        db.sqlite.prepare(`SELECT COUNT(*) AS n FROM admin_customer_gate_challenges`).get()
      ).toEqual({ n: 1 });
      expect(
        db.sqlite
          .prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'customer_gate_code_requested'`)
          .get()
      ).toEqual({ n: 2 });
    } finally {
      db.sqlite.close();
    }
  });

  it("keeps the previous code usable when the resend fails to send", async () => {
    const db = createMigratedSqliteD1();
    const access = createFixture();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));
    try {
      seedStaffMember(db);
      seedAdmin(db);

      const sent: SentEmail[] = [];
      const issued = await request(
        db,
        access.token,
        "/api/admin/customer-gate/request",
        { method: "POST" },
        baseEnv(db, createEmailBinding(sent))
      );
      const { challengeId } = (await issued.json()) as { challengeId: string };
      const code = codeFromEmail(sent);

      // 再送。送信そのものが失敗した回は、オーナーの手元にある 1 通目のコードがまだ生きて
      // いなければならない。画面も再送失敗時に前の challengeId を保持する作りなので、ここで
      // 古い行まで消すと「届いているコードを入れても弾かれる」状態になる。
      db.sqlite.prepare(`DELETE FROM rate_limit_events`).run();
      const resent = await request(
        db,
        access.token,
        "/api/admin/customer-gate/request",
        { method: "POST" },
        baseEnv(db, createEmailBinding([], "fail"))
      );
      expect(resent.status).toBe(502);
      expect(
        db.sqlite.prepare(`SELECT id FROM admin_customer_gate_challenges`).all()
      ).toEqual([{ id: challengeId }]);

      const verified = await request(
        db,
        access.token,
        "/api/admin/customer-gate/verify",
        { method: "POST", body: JSON.stringify({ challengeId, code }) },
        baseEnv(db, createEmailBinding([]))
      );
      expect(verified.status).toBe(200);
      expect((await request(db, access.token, "/api/admin/customers?mode=list")).status).toBe(200);
    } finally {
      db.sqlite.close();
    }
  });

  it("leaves only the newest code usable once the resend goes out", async () => {
    const db = createMigratedSqliteD1();
    const access = createFixture();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));
    try {
      seedStaffMember(db);
      seedAdmin(db);

      const first: SentEmail[] = [];
      const issued = await request(
        db,
        access.token,
        "/api/admin/customer-gate/request",
        { method: "POST" },
        baseEnv(db, createEmailBinding(first))
      );
      const stale = (await issued.json()) as { challengeId: string };
      const staleCode = codeFromEmail(first);

      db.sqlite.prepare(`DELETE FROM rate_limit_events`).run();
      const second: SentEmail[] = [];
      const resent = await request(
        db,
        access.token,
        "/api/admin/customer-gate/request",
        { method: "POST" },
        baseEnv(db, createEmailBinding(second))
      );
      expect(resent.status).toBe(200);

      // 送信できた回は 1 通目を失効させる。掃除を送信のあとへ動かしても、ここは変わらない。
      expect(
        db.sqlite.prepare(`SELECT COUNT(*) AS n FROM admin_customer_gate_challenges`).get()
      ).toEqual({ n: 1 });
      const refused = await request(
        db,
        access.token,
        "/api/admin/customer-gate/verify",
        { method: "POST", body: JSON.stringify({ challengeId: stale.challengeId, code: staleCode }) },
        baseEnv(db, createEmailBinding([]))
      );
      expect(refused.status).toBe(400);
      expect((await request(db, access.token, "/api/admin/customers?mode=list")).status).toBe(403);
    } finally {
      db.sqlite.close();
    }
  });

  it("stops reporting success once the 12-hour grant has run out", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-30T01:00:00.000Z"));
    const db = createMigratedSqliteD1();
    const access = createFixture();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));
    try {
      seedStaffMember(db);
      seedAdmin(db);

      const sent: SentEmail[] = [];
      const env = baseEnv(db, createEmailBinding(sent));
      const issued = await request(db, access.token, "/api/admin/customer-gate/request", { method: "POST" }, env);
      const { challengeId } = (await issued.json()) as { challengeId: string };
      const code = codeFromEmail(sent);
      expect(
        (
          await request(
            db,
            access.token,
            "/api/admin/customer-gate/verify",
            { method: "POST", body: JSON.stringify({ challengeId, code }) },
            env
          )
        ).status
      ).toBe(200);

      // 承認が切れたあとに同じコードを送り直しても、過ぎた grantedUntil を成功として
      // 返さない。アクセス自体は hasActiveCustomerGateGrant が別途止めるが、応答が
      // 「開いた」と言いながら画面はゲートに戻る、という食い違いを残さない。
      vi.setSystemTime(new Date("2026-08-30T13:01:00.000Z"));
      const stale = await request(
        db,
        tokenAt(access, "2026-08-30T13:01:00.000Z"),
        "/api/admin/customer-gate/verify",
        { method: "POST", body: JSON.stringify({ challengeId, code }) },
        env
      );
      expect(stale.status).toBe(400);
      expect(await stale.json()).toEqual({ ok: false, reason: "invalid_code" });
    } finally {
      db.sqlite.close();
    }
  });

  it("refuses to email the owner for a staff member with no store", async () => {
    const db = createMigratedSqliteD1();
    const access = createFixture();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));
    try {
      // staff_member_id を持たない staff = store_id が null。FR-016 のガードの対象
      // (理由は admin-api.ts の /customer-gate/request のコメント)。
      insertAdminUser(db, {
        id: ADMIN_ID,
        email: ADMIN_EMAIL,
        accessSubject: ADMIN_SUBJECT,
        role: "staff",
        staffMemberId: null,
        updatedAt: "2026-08-30T00:00:00.000Z"
      });

      const sent: SentEmail[] = [];
      const requested = await request(
        db,
        access.token,
        "/api/admin/customer-gate/request",
        { method: "POST" },
        baseEnv(db, createEmailBinding(sent))
      );
      expect(requested.status).toBe(403);
      expect(sent).toHaveLength(0);
      expect(
        db.sqlite.prepare(`SELECT COUNT(*) AS n FROM admin_customer_gate_challenges`).get()
      ).toEqual({ n: 0 });

      const verified = await request(
        db,
        access.token,
        "/api/admin/customer-gate/verify",
        { method: "POST", body: JSON.stringify({ challengeId: "chal_x", code: "123456" }) },
        baseEnv(db, createEmailBinding([]))
      );
      expect(verified.status).toBe(403);
    } finally {
      db.sqlite.close();
    }
  });

  it("identifies the winning attempt by the submitted code, not by the clock", async () => {
    const db = createMigratedSqliteD1();
    const access = createFixture();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));
    try {
      seedStaffMember(db);
      seedAdmin(db);

      const sent: SentEmail[] = [];
      const env = baseEnv(db, createEmailBinding(sent));
      const issued = await request(db, access.token, "/api/admin/customer-gate/request", { method: "POST" }, env);
      const { challengeId } = (await issued.json()) as { challengeId: string };
      const code = codeFromEmail(sent);

      const first = await request(
        db,
        access.token,
        "/api/admin/customer-gate/verify",
        { method: "POST", body: JSON.stringify({ challengeId, code }) },
        env
      );
      expect(first.status).toBe(200);
      const granted = (await first.json()) as { grantedUntil: string };

      // FR-017 の判定基準を、時刻に依らないことが分かる形で押さえる: 同じ正しいコードの
      // 再送は同じ承認を返し、誤コードは verify_failed として残る (時刻一致で見ていると
      // 前者が invalid_code になり、同じミリ秒の後者が verified になる)。
      const again = await request(
        db,
        access.token,
        "/api/admin/customer-gate/verify",
        { method: "POST", body: JSON.stringify({ challengeId, code }) },
        env
      );
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ ok: true, grantedUntil: granted.grantedUntil });

      const wrong = await request(
        db,
        access.token,
        "/api/admin/customer-gate/verify",
        { method: "POST", body: JSON.stringify({ challengeId, code: code === "000000" ? "111111" : "000000" }) },
        env
      );
      expect(wrong.status).toBe(400);
      expect(
        db.sqlite
          .prepare(`SELECT action, COUNT(*) AS n FROM audit_logs WHERE action LIKE 'customer_gate_verif%' GROUP BY action ORDER BY action`)
          .all()
      ).toEqual([
        { action: "customer_gate_verified", n: 2 },
        { action: "customer_gate_verify_failed", n: 1 }
      ]);
    } finally {
      db.sqlite.close();
    }
  });

  it("issues nothing when no owner address is configured", async () => {
    const db = createMigratedSqliteD1();
    const access = createFixture();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));
    try {
      seedStaffMember(db);
      seedAdmin(db);
      const res = await request(db, access.token, "/api/admin/customer-gate/request", { method: "POST" }, {
        ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
        ACCESS_AUD,
        DB: db,
        EMAIL: createEmailBinding([]),
        PENDING_APPROVAL_OWNER_EMAIL: "   "
      });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ ok: false, reason: "owner_email_unset" });
      expect(
        db.sqlite.prepare(`SELECT COUNT(*) AS n FROM admin_customer_gate_challenges`).get()
      ).toEqual({ n: 0 });
    } finally {
      db.sqlite.close();
    }
  });

  it.each(["owner", "system_admin"] as const)(
    "lets %s through without a code and refuses to issue one",
    async (role) => {
      const db = createMigratedSqliteD1();
      const access = createFixture();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));
      try {
        seedAdmin(db, role);
        seedCustomer(db);

        expect((await request(db, access.token, "/api/admin/customers?mode=list")).status).toBe(200);
        expect((await request(db, access.token, "/api/admin/customers/cust_gate_1")).status).toBe(200);

        const issued = await request(db, access.token, "/api/admin/customer-gate/request", {
          method: "POST"
        });
        expect(issued.status).toBe(400);
        expect(await issued.json()).toEqual({ ok: false, reason: "not_applicable" });
      } finally {
        db.sqlite.close();
      }
    }
  );

  it("keeps name search working without a code but hides the memo", async () => {
    const db = createMigratedSqliteD1();
    const access = createFixture();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));
    try {
      seedStaffMember(db);
      seedAdmin(db);
      seedCustomer(db);
      db.sqlite
        .prepare(
          `INSERT INTO customer_visits (id, customer_id, store_id, visited_at, visit_source, status, recorded_by, created_at)
           VALUES ('visit_gate_1', 'cust_gate_1', 'kyoto', '2026-08-01', 'manual_import', 'valid', 'admin_seed', '2026-08-01T00:00:00.000Z')`
        )
        .run();

      const before = await request(db, access.token, "/api/admin/customers?q=門番");
      expect(before.status).toBe(200);
      const beforeBody = (await before.json()) as { customers: Array<{ displayName: string; memo: string | null }> };
      expect(beforeBody.customers.map((c) => c.displayName)).toEqual(["門番 太郎"]);
      expect(beforeBody.customers[0].memo).toBeNull();

      const sent: SentEmail[] = [];
      const env = baseEnv(db, createEmailBinding(sent));
      expect((await issueAndVerify(db, access.token, sent)).status).toBe(200);

      const after = await request(db, access.token, "/api/admin/customers?q=門番", {}, env);
      const afterBody = (await after.json()) as { customers: Array<{ memo: string | null }> };
      expect(afterBody.customers[0].memo).toBe("秘密のメモ");
    } finally {
      db.sqlite.close();
    }
  });

  it("keeps one staff member's approval off another staff member", async () => {
    const db = createMigratedSqliteD1();
    const access = createFixture();
    const otherAccess = createAccessJwtFixture({
      issuer: TEAM_DOMAIN,
      audience: ACCESS_AUD,
      keyId: "customer-gate-key-1",
      claims: { email: "other@example.com", sub: "sub-customer-gate-other" },
      signingKey: access
    });
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));
    try {
      seedStaffMember(db);
      seedAdmin(db);
      insertAdminUser(db, {
        id: "admin_customer_gate_2",
        email: "other@example.com",
        accessSubject: "sub-customer-gate-other",
        role: "staff",
        staffMemberId: "staff_gate_kyoto",
        updatedAt: "2026-08-30T00:00:00.000Z"
      });

      const sent: SentEmail[] = [];
      expect((await issueAndVerify(db, access.token, sent)).status).toBe(200);

      expect((await request(db, access.token, "/api/admin/customers?mode=list")).status).toBe(200);
      expect((await request(db, otherAccess.token, "/api/admin/customers?mode=list")).status).toBe(403);
    } finally {
      db.sqlite.close();
    }
  });
});

// 画面側は「入力の回数を使い切った」を自分で数えて案内を出す (使い切ったあとは正しい
// コードでも同じ invalid_code しか返らないため)。数える上限がサーバーとずれると、
// 案内が早すぎる (まだ試せるのに送信を止める) か遅すぎる (使えないコードを入れ続ける)。
// 定数は 2 箇所にあるので、ここで突き合わせて固定する。
describe("顧客タブゲートの試行回数", () => {
  const readConstant = (path: string) => {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    const match = /const MAX_ATTEMPTS = (\d+);/.exec(source);
    expect(match).not.toBeNull();
    return Number(match?.[1]);
  };

  it("サーバーと管理画面で同じ上限を持つ", () => {
    expect(readConstant("../admin-app/src/components/customers/customer-gate-card.tsx")).toBe(
      readConstant("../src/admin/customer-gate.ts")
    );
  });
});
