import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import { createAccessJwksFetchMock, createAccessJwtFixture as createAccessJwtFixtureBase, type AccessJwk, insertAdminUser as insertAdminUserHelper, grantCustomerTabGate, type AdminRole } from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const TEAM_DOMAIN = "https://team.example.cloudflareaccess.com";
const ACCESS_AUD = "self-deactivation-test-aud";
const ADMIN_EMAIL = "owner@example.com";
const ADMIN_ACCESS_SUBJECT = "access-subject-self-deactivation";

const createAccessJwtFixture = (email = ADMIN_EMAIL, sub = ADMIN_ACCESS_SUBJECT) =>
  createAccessJwtFixtureBase({
    issuer: TEAM_DOMAIN,
    audience: ACCESS_AUD,
    keyId: "self-deactivation-key-1",
    claims: { email, sub }
  });

const createFetchMock = (jwk: AccessJwk) => createAccessJwksFetchMock(TEAM_DOMAIN, jwk);

const insertAdminUser = (
  db: SqliteD1Database,
  options: {
    id?: string;
    email?: string;
    accessSubject?: string;
    role?: AdminRole;
    staffMemberId?: string | null;
  } = {}
) =>
  insertAdminUserHelper(db, {
    id: options.id ?? "admin_self_deact_1",
    email: options.email ?? ADMIN_EMAIL,
    accessSubject: options.accessSubject ?? ADMIN_ACCESS_SUBJECT,
    role: options.role ?? "owner",
    staffMemberId: options.staffMemberId ?? null,
    updatedAt: "2026-05-19T00:00:00.000Z",
  });

const seedStore = (db: SqliteD1Database, id = "store_test") => {
  db.sqlite
    .prepare(`INSERT INTO stores (id, name, timezone) VALUES (?, ?, 'Asia/Tokyo')`)
    .run(id, `Store ${id}`);
};

const seedStaff = (
  db: SqliteD1Database,
  input: {
    id: string;
    storeId: string;
    displayName?: string;
    role?: "owner" | "staff" | "system_admin";
    active?: 0 | 1;
  }
) => {
  db.sqlite
    .prepare(
      `INSERT INTO staff_members (id, store_id, display_name, role, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '2026-05-19T00:00:00.000Z', '2026-05-19T00:00:00.000Z')`
    )
    .run(
      input.id,
      input.storeId,
      input.displayName ?? "テストスタッフ",
      input.role ?? "staff",
      input.active ?? 1
    );
};

const baseEnv = (db: SqliteD1Database): Record<string, unknown> => ({
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  ACCESS_AUD,
  DB: db
});

const adminRequest = (
  db: SqliteD1Database,
  token: string | null,
  method: "PUT" | "DELETE" | "POST",
  path: string,
  body?: Record<string, unknown>
) => {
  const app = createApp();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Cf-Access-Jwt-Assertion"] = token;
  return app.request(
    path,
    { method, headers, body: body ? JSON.stringify(body) : undefined },
    baseEnv(db)
  );
};

const readJson = async (response: Response) => response.json() as Promise<Record<string, unknown>>;

describe("F-3.2: staff self-deactivation lockout guard (PUT)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("allows updating someone else's active = 0", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedStore(db);
      seedStaff(db, { id: "staff_other", storeId: "store_test" });
      seedStaff(db, { id: "staff_caller", storeId: "store_test", role: "owner" });
      insertAdminUser(db, { staffMemberId: "staff_caller" });
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "PUT", "/api/admin/settings/staff/staff_other", {
        storeId: "store_test",
        displayName: "テストスタッフ",
        role: "staff",
        active: false,
        expectedVersion: 1
      });
      expect(response.status).toBe(200);
      const body = await readJson(response);
      expect(body).toMatchObject({ ok: true, staffId: "staff_other" });
      const row = db.sqlite
        .prepare("SELECT active FROM staff_members WHERE id = 'staff_other'")
        .get() as { active: number };
      expect(row.active).toBe(0);
    } finally {
      db.sqlite.close();
    }
  });

  it("refuses self-deactivation with 403 forbidden_self_deactivation", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedStore(db);
      seedStaff(db, { id: "staff_self", storeId: "store_test", role: "owner" });
      insertAdminUser(db, { staffMemberId: "staff_self" });
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "PUT", "/api/admin/settings/staff/staff_self", {
        storeId: "store_test",
        displayName: "テストスタッフ",
        role: "owner",
        active: false,
        expectedVersion: 1
      });
      expect(response.status).toBe(403);
      const body = await readJson(response);
      expect(body).toMatchObject({ ok: false, error: "forbidden_self_deactivation" });
      const row = db.sqlite
        .prepare("SELECT active FROM staff_members WHERE id = 'staff_self'")
        .get() as { active: number };
      expect(row.active).toBe(1);
    } finally {
      db.sqlite.close();
    }
  });

  it("allows self-update when active stays 1 (no-op transition)", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedStore(db);
      seedStaff(db, { id: "staff_noop", storeId: "store_test", role: "owner" });
      insertAdminUser(db, { staffMemberId: "staff_noop" });
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "PUT", "/api/admin/settings/staff/staff_noop", {
        storeId: "store_test",
        displayName: "テストスタッフ",
        role: "owner",
        active: true,
        expectedVersion: 1
      });
      expect(response.status).toBe(200);
      const body = await readJson(response);
      expect(body).toMatchObject({ ok: true, staffId: "staff_noop" });
    } finally {
      db.sqlite.close();
    }
  });

  it("allows self-update of non-active fields (name, role)", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedStore(db);
      seedStaff(db, { id: "staff_name", storeId: "store_test", role: "staff", displayName: "旧名前" });
      insertAdminUser(db, { staffMemberId: "staff_name" });
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "PUT", "/api/admin/settings/staff/staff_name", {
        storeId: "store_test",
        displayName: "新名前",
        role: "owner",
        active: true,
        expectedVersion: 1
      });
      expect(response.status).toBe(200);
      const row = db.sqlite
        .prepare("SELECT display_name, role FROM staff_members WHERE id = 'staff_name'")
        .get() as { display_name: string; role: string };
      expect(row).toMatchObject({ display_name: "新名前", role: "owner" });
    } finally {
      db.sqlite.close();
    }
  });

  it("drops the customer tab grant when the role changes, and keeps it when it does not", async () => {
    // 顧客タブの承認 (spec 008) は admin_user_id だけで引くので、staff → owner → staff と
    // 12 時間以内に往復すると古い承認が生き残る。役割の変更でだけ落とす。
    const db = createMigratedSqliteD1();
    try {
      seedStore(db);
      seedStaff(db, { id: "staff_gate", storeId: "store_test", role: "staff", displayName: "承認済み" });
      // 操作するのは owner、承認を持っているのは対象の staff 本人。
      insertAdminUser(db);
      insertAdminUser(db, {
        id: "admin_gate_1",
        staffMemberId: "staff_gate",
        role: "staff",
        email: "gate-staff@example.com",
        accessSubject: "access-subject-gate-staff"
      });
      grantCustomerTabGate(db, "admin_gate_1");
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const grants = () =>
        (
          db.sqlite
            .prepare("SELECT id FROM admin_customer_gate_challenges WHERE admin_user_id = 'admin_gate_1'")
            .all() as Array<{ id: string }>
        ).length;

      // 名前だけの変更 (role は staff のまま) — 承認は残る。
      const renamed = await adminRequest(db, access.token, "PUT", "/api/admin/settings/staff/staff_gate", {
        storeId: "store_test",
        displayName: "改名後",
        role: "staff",
        active: true,
        expectedVersion: 1
      });
      expect(renamed.status).toBe(200);
      expect(grants()).toBe(1);

      // 役割の変更 — 承認は消える。
      const promoted = await adminRequest(db, access.token, "PUT", "/api/admin/settings/staff/staff_gate", {
        storeId: "store_test",
        displayName: "改名後",
        role: "owner",
        active: true,
        expectedVersion: 2
      });
      expect(promoted.status).toBe(200);
      expect(grants()).toBe(0);

      // 無効化 → 再有効化。無効化のあいだ承認は authenticateAdmin に弾かれて死んでいるが、
      // 12 時間以内に戻すと生き返ってコード無しで顧客タブが開いていた。判定は変更前の値を
      // 見るので、落ちるのは「無効から有効に戻す」側。
      grantCustomerTabGate(db, "admin_gate_1");
      const deactivated = await adminRequest(db, access.token, "PUT", "/api/admin/settings/staff/staff_gate", {
        storeId: "store_test",
        displayName: "改名後",
        role: "owner",
        active: false,
        expectedVersion: 3
      });
      expect(deactivated.status).toBe(200);
      expect(grants()).toBe(1);

      const reactivated = await adminRequest(db, access.token, "PUT", "/api/admin/settings/staff/staff_gate", {
        storeId: "store_test",
        displayName: "改名後",
        role: "owner",
        active: true,
        expectedVersion: 4
      });
      expect(reactivated.status).toBe(200);
      expect(grants()).toBe(0);
    } finally {
      db.sqlite.close();
    }
  });

  it("skips guard for system_admin with null staff_member_id (no false positive)", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedStore(db);
      seedStaff(db, { id: "staff_target", storeId: "store_test" });
      insertAdminUser(db, { staffMemberId: null, role: "system_admin" });
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "PUT", "/api/admin/settings/staff/staff_target", {
        storeId: "store_test",
        displayName: "テストスタッフ",
        role: "staff",
        active: false,
        expectedVersion: 1
      });
      expect(response.status).toBe(200);
      const body = await readJson(response);
      expect(body).toMatchObject({ ok: true, staffId: "staff_target" });
    } finally {
      db.sqlite.close();
    }
  });

  it("allows admin with null staff_member_id to edit any staff member", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedStore(db);
      seedStaff(db, { id: "staff_any", storeId: "store_test", role: "owner" });
      insertAdminUser(db, { staffMemberId: null });
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "PUT", "/api/admin/settings/staff/staff_any", {
        storeId: "store_test",
        displayName: "更新済み",
        role: "staff",
        active: false,
        expectedVersion: 1
      });
      expect(response.status).toBe(200);
      const row = db.sqlite
        .prepare("SELECT display_name, active FROM staff_members WHERE id = 'staff_any'")
        .get() as { display_name: string; active: number };
      expect(row).toMatchObject({ display_name: "更新済み", active: 0 });
    } finally {
      db.sqlite.close();
    }
  });
});

describe("F-3.2: staff self-deactivation lockout guard (DELETE)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refuses self-deletion with 403 forbidden_self_deactivation", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedStore(db);
      seedStaff(db, { id: "staff_del_self", storeId: "store_test", role: "owner" });
      insertAdminUser(db, { staffMemberId: "staff_del_self" });
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "DELETE", "/api/admin/settings/staff/staff_del_self");
      expect(response.status).toBe(403);
      const body = await readJson(response);
      expect(body).toMatchObject({ ok: false, error: "forbidden_self_deactivation" });
      const row = db.sqlite
        .prepare("SELECT active FROM staff_members WHERE id = 'staff_del_self'")
        .get() as { active: number };
      expect(row.active).toBe(1);
    } finally {
      db.sqlite.close();
    }
  });

  it("allows deleting someone else's staff row", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedStore(db);
      seedStaff(db, { id: "staff_del_other", storeId: "store_test" });
      seedStaff(db, { id: "staff_del_caller", storeId: "store_test", role: "owner" });
      insertAdminUser(db, { staffMemberId: "staff_del_caller" });
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "DELETE", "/api/admin/settings/staff/staff_del_other");
      expect(response.status).toBe(200);
      const row = db.sqlite
        .prepare("SELECT active FROM staff_members WHERE id = 'staff_del_other'")
        .get() as { active: number };
      expect(row.active).toBe(0);
    } finally {
      db.sqlite.close();
    }
  });

  it("skips guard for admin with null staff_member_id on DELETE", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedStore(db);
      seedStaff(db, { id: "staff_del_target", storeId: "store_test" });
      insertAdminUser(db, { staffMemberId: null, role: "system_admin" });
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "DELETE", "/api/admin/settings/staff/staff_del_target");
      expect(response.status).toBe(200);
      const row = db.sqlite
        .prepare("SELECT active FROM staff_members WHERE id = 'staff_del_target'")
        .get() as { active: number };
      expect(row.active).toBe(0);
    } finally {
      db.sqlite.close();
    }
  });
});

describe("F-3.3: system_admin role escalation guard", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refuses owner creating system_admin with 403 forbidden_role_escalation", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedStore(db);
      seedStaff(db, { id: "staff_caller", storeId: "store_test", role: "owner" });
      insertAdminUser(db, { staffMemberId: "staff_caller", role: "owner" });
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "POST", "/api/admin/settings/staff", {
        storeId: "store_test",
        displayName: "新規システム管理者",
        role: "system_admin",
        active: true,
        idempotencyKey: "f33-create-1"
      });
      expect(response.status).toBe(403);
      const body = await readJson(response);
      expect(body).toMatchObject({ ok: false, error: "forbidden_role_escalation" });
      // Verify nothing was inserted
      const count = db.sqlite
        .prepare("SELECT COUNT(*) AS n FROM staff_members WHERE display_name = '新規システム管理者'")
        .get() as { n: number };
      expect(count.n).toBe(0);
      const audit = db.sqlite
        .prepare(
          "SELECT action, target_type, target_id, metadata_json FROM audit_logs WHERE action = 'settings.staff.forbidden_role_escalation'"
        )
        .get() as { action: string; target_type: string; target_id: string; metadata_json: string };
      expect(audit.target_type).toBe("staff_member");
      expect(audit.target_id).toBe("pending_staff_member");
      expect(JSON.parse(audit.metadata_json)).toMatchObject({
        path: "create",
        adminRole: "owner",
        requestedRole: "system_admin",
        requestedActive: true
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("refuses owner promoting another row to system_admin via PUT with 403", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedStore(db);
      seedStaff(db, { id: "staff_caller", storeId: "store_test", role: "owner" });
      seedStaff(db, { id: "staff_target", storeId: "store_test", role: "staff" });
      insertAdminUser(db, { staffMemberId: "staff_caller", role: "owner" });
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "PUT", "/api/admin/settings/staff/staff_target", {
        storeId: "store_test",
        displayName: "テストスタッフ",
        role: "system_admin",
        active: true,
        expectedVersion: 1
      });
      expect(response.status).toBe(403);
      const body = await readJson(response);
      expect(body).toMatchObject({ ok: false, error: "forbidden_role_escalation" });
      // Verify role unchanged
      const row = db.sqlite
        .prepare("SELECT role FROM staff_members WHERE id = 'staff_target'")
        .get() as { role: string };
      expect(row.role).toBe("staff");
      const audit = db.sqlite
        .prepare(
          "SELECT target_id, metadata_json FROM audit_logs WHERE action = 'settings.staff.forbidden_role_escalation'"
        )
        .get() as { target_id: string; metadata_json: string };
      expect(audit.target_id).toBe("staff_target");
      expect(JSON.parse(audit.metadata_json)).toMatchObject({
        path: "update",
        adminRole: "owner",
        requestedRole: "system_admin",
        requestedActive: true
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("allows system_admin caller to create system_admin staff row", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedStore(db);
      insertAdminUser(db, { staffMemberId: null, role: "system_admin" });
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "POST", "/api/admin/settings/staff", {
        storeId: "store_test",
        displayName: "新規システム管理者",
        role: "system_admin",
        active: true,
        idempotencyKey: "f33-create-sysadmin"
      });
      expect(response.status).toBe(201);
      const body = await readJson(response);
      expect(body).toMatchObject({ ok: true });
      const row = db.sqlite
        .prepare("SELECT role FROM staff_members WHERE display_name = '新規システム管理者'")
        .get() as { role: string };
      expect(row.role).toBe("system_admin");
    } finally {
      db.sqlite.close();
    }
  });

  it("allows owner caller to create owner role (not system_admin)", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedStore(db);
      seedStaff(db, { id: "staff_caller", storeId: "store_test", role: "owner" });
      insertAdminUser(db, { staffMemberId: "staff_caller", role: "owner" });
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "POST", "/api/admin/settings/staff", {
        storeId: "store_test",
        displayName: "新オーナー",
        role: "owner",
        active: true,
        idempotencyKey: "f33-create-owner"
      });
      expect(response.status).toBe(201);
      const body = await readJson(response);
      expect(body).toMatchObject({ ok: true });
    } finally {
      db.sqlite.close();
    }
  });

  it("refuses owner caller updating ANY field on a system_admin row (escalate guard, name retained)", async () => {
    // F-3.3 escalate guard catches role=system_admin from non-system_admin
    // caller BEFORE the target-row fetch.
    const db = createMigratedSqliteD1();
    try {
      seedStore(db);
      seedStaff(db, { id: "staff_caller", storeId: "store_test", role: "owner" });
      seedStaff(db, { id: "staff_sysadmin", storeId: "store_test", role: "system_admin", displayName: "Old" });
      insertAdminUser(db, { staffMemberId: "staff_caller", role: "owner" });
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "PUT", "/api/admin/settings/staff/staff_sysadmin", {
        storeId: "store_test",
        displayName: "New Name",
        role: "system_admin",
        active: true,
        expectedVersion: 1
      });
      expect(response.status).toBe(403);
      const body = await readJson(response);
      expect(body).toMatchObject({ ok: false, error: "forbidden_role_escalation" });
    } finally {
      db.sqlite.close();
    }
  });

  // F-3.3 demote guard (codex review iter1 adopted): owner-tier caller may
  // not modify a row whose current role is system_admin, even if they're
  // requesting role=owner/staff. Prevents privilege removal of higher-tier
  // accounts via the staff settings API.
  it("refuses owner caller demoting a system_admin row (role=owner) with 403", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedStore(db);
      seedStaff(db, { id: "staff_caller", storeId: "store_test", role: "owner" });
      seedStaff(db, { id: "staff_sysadmin", storeId: "store_test", role: "system_admin" });
      insertAdminUser(db, { staffMemberId: "staff_caller", role: "owner" });
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "PUT", "/api/admin/settings/staff/staff_sysadmin", {
        storeId: "store_test",
        displayName: "Demoted Name",
        role: "owner",
        active: true,
        expectedVersion: 1
      });
      expect(response.status).toBe(403);
      const body = await readJson(response);
      expect(body).toMatchObject({ ok: false, error: "forbidden_role_escalation" });
      const row = db.sqlite
        .prepare("SELECT role FROM staff_members WHERE id = 'staff_sysadmin'")
        .get() as { role: string };
      expect(row.role).toBe("system_admin");
      const audit = db.sqlite
        .prepare(
          "SELECT target_id, metadata_json FROM audit_logs WHERE action = 'settings.staff.forbidden_role_escalation'"
        )
        .get() as { target_id: string; metadata_json: string };
      expect(audit.target_id).toBe("staff_sysadmin");
      expect(JSON.parse(audit.metadata_json)).toMatchObject({
        path: "update",
        adminRole: "owner",
        targetRole: "system_admin",
        requestedRole: "owner",
        requestedActive: true
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("refuses owner caller soft-deleting a system_admin row with 403", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedStore(db);
      seedStaff(db, { id: "staff_caller", storeId: "store_test", role: "owner" });
      seedStaff(db, { id: "staff_sysadmin", storeId: "store_test", role: "system_admin" });
      insertAdminUser(db, { staffMemberId: "staff_caller", role: "owner" });
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "DELETE", "/api/admin/settings/staff/staff_sysadmin");
      expect(response.status).toBe(403);
      const body = await readJson(response);
      expect(body).toMatchObject({ ok: false, error: "forbidden_role_escalation" });
      const row = db.sqlite
        .prepare("SELECT active FROM staff_members WHERE id = 'staff_sysadmin'")
        .get() as { active: number };
      expect(row.active).toBe(1);
      const audit = db.sqlite
        .prepare(
          "SELECT target_id, metadata_json FROM audit_logs WHERE action = 'settings.staff.forbidden_role_escalation'"
        )
        .get() as { target_id: string; metadata_json: string };
      expect(audit.target_id).toBe("staff_sysadmin");
      expect(JSON.parse(audit.metadata_json)).toMatchObject({
        path: "delete",
        adminRole: "owner",
        targetRole: "system_admin"
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("allows system_admin caller to demote a system_admin row to owner", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedStore(db);
      seedStaff(db, { id: "staff_target", storeId: "store_test", role: "system_admin" });
      insertAdminUser(db, { staffMemberId: null, role: "system_admin" });
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "PUT", "/api/admin/settings/staff/staff_target", {
        storeId: "store_test",
        displayName: "Demoted by sysadmin",
        role: "owner",
        active: true,
        expectedVersion: 1
      });
      expect(response.status).toBe(200);
      const body = await readJson(response);
      expect(body).toMatchObject({ ok: true });
      const row = db.sqlite
        .prepare("SELECT role FROM staff_members WHERE id = 'staff_target'")
        .get() as { role: string };
      expect(row.role).toBe("owner");
    } finally {
      db.sqlite.close();
    }
  });
});
