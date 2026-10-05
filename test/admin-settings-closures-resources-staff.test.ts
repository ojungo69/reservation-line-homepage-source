import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import { createAccessJwksFetchMock, createAccessJwtFixture as createAccessJwtFixtureBase, type AccessJwk, insertAdminUser as insertAdminUserHelper, type AdminRole } from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const TEAM_DOMAIN = "https://team.example.cloudflareaccess.com";
const ACCESS_AUD = "admin-settings-4c-aud";
const ADMIN_EMAIL = "owner@example.com";
const ADMIN_ACCESS_SUBJECT = "access-subject-admin-settings-4c";
const ACCESS_KEY_ID = "admin-settings-4c-key-1";


const createAccessJwtFixture = () =>
  createAccessJwtFixtureBase({
    issuer: TEAM_DOMAIN,
    audience: ACCESS_AUD,
    keyId: ACCESS_KEY_ID,
    claims: { email: ADMIN_EMAIL, sub: ADMIN_ACCESS_SUBJECT }
  });

const createFetchMock = (jwk: AccessJwk) => createAccessJwksFetchMock(TEAM_DOMAIN, jwk);

const insertAdminUser = (db: SqliteD1Database, role: AdminRole = "owner") =>
  insertAdminUserHelper(db, {
    id: "admin_settings_4c_1",
    email: ADMIN_EMAIL,
    accessSubject: ADMIN_ACCESS_SUBJECT,
    role,
    updatedAt: "2026-05-19T00:00:00.000Z",
  });

const seedStore = (db: SqliteD1Database, id = "store_test") => {
  db.sqlite
    .prepare(`INSERT INTO stores (id, name, timezone) VALUES (?, ?, 'Asia/Tokyo')`)
    .run(id, `Store ${id}`);
};

const seedResource = (
  db: SqliteD1Database,
  input: { id: string; storeId: string; name?: string; active?: 0 | 1 }
) => {
  db.sqlite
    .prepare(
      `INSERT INTO store_resources (id, store_id, name, resource_type, active, created_at, updated_at)
       VALUES (?, ?, ?, 'staff_calendar', ?, '2026-05-19T00:00:00.000Z', '2026-05-19T00:00:00.000Z')`
    )
    .run(input.id, input.storeId, input.name ?? "既存リソース", input.active ?? 1);
};

const seedStaff = (
  db: SqliteD1Database,
  input: { id: string; storeId: string; displayName?: string; role?: "owner" | "staff" | "system_admin"; active?: 0 | 1 }
) => {
  db.sqlite
    .prepare(
      `INSERT INTO staff_members (id, store_id, display_name, role, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '2026-05-19T00:00:00.000Z', '2026-05-19T00:00:00.000Z')`
    )
    .run(input.id, input.storeId, input.displayName ?? "山田太郎", input.role ?? "staff", input.active ?? 1);
};

const seedClosure = (
  db: SqliteD1Database,
  input: { id: string; storeId: string; startsAt?: string; endsAt?: string; reason?: string | null; source?: "admin" | "google_external_block" }
) => {
  db.sqlite
    .prepare(
      `INSERT INTO store_closures (id, store_id, starts_at, ends_at, reason, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '2026-05-19T00:00:00.000Z')`
    )
    .run(
      input.id,
      input.storeId,
      input.startsAt ?? "2026-12-01T00:00:00.000Z",
      input.endsAt ?? "2026-12-01T12:00:00.000Z",
      input.reason ?? null,
      input.source ?? "admin"
    );
};

const seedFutureReservationOnResource = (
  db: SqliteD1Database,
  input: { id: string; storeId: string; resourceId: string; startAt: string }
) => {
  db.sqlite
    .prepare(
      `INSERT INTO customers (id, display_name, phone_normalized, phone_hash, updated_at)
       VALUES (?, '予約顧客', '09012345678', 'hash', '2026-05-19T00:00:00.000Z')`
    )
    .run(`customer_${input.id}`);
  db.sqlite
    .prepare(
      `INSERT INTO services (id, store_id, name, duration_minutes, created_at, updated_at)
       VALUES (?, ?, 'svc', 60, '2026-05-19T00:00:00.000Z', '2026-05-19T00:00:00.000Z')
       ON CONFLICT (id) DO NOTHING`
    )
    .run(`service_${input.storeId}`, input.storeId);
  db.sqlite
    .prepare(
      `INSERT INTO reservations (
        id, store_id, service_id, customer_id, resource_id, source,
        status, start_at, end_at, duration_minutes, idempotency_key,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'admin', 'confirmed', ?, ?, 60, ?, '2026-05-19T00:00:00.000Z', '2026-05-19T00:00:00.000Z')`
    )
    .run(
      input.id,
      input.storeId,
      `service_${input.storeId}`,
      `customer_${input.id}`,
      input.resourceId,
      input.startAt,
      input.startAt.replace("T01", "T02"),
      `key_${input.id}`
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
  method: "POST" | "PUT" | "DELETE",
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

const futureSlot = "2026-12-01T01:00:00.000Z";

describe("admin settings — store_resources endpoints", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates a resource with audit + idempotency row (201)", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "POST", "/api/admin/settings/resources", {
        storeId: "store_test",
        name: "新リソース",
        resourceType: "staff_calendar",
        active: true,
        idempotencyKey: "res-create-1"
      });
      expect(response.status).toBe(201);
      const body = await readJson(response);
      expect(body).toMatchObject({ ok: true, replayed: false });
      const id = body.resourceId as string;
      const row = db.sqlite
        .prepare("SELECT name, resource_type, active FROM store_resources WHERE id = ?")
        .get(id) as { name: string; resource_type: string; active: number };
      expect(row).toMatchObject({ name: "新リソース", resource_type: "staff_calendar", active: 1 });
      const audit = db.sqlite
        .prepare("SELECT action FROM audit_logs WHERE action = 'settings.resources.create'")
        .get() as { action: string };
      expect(audit?.action).toBe("settings.resources.create");
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 403 when caller has staff role", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "staff");
      seedStore(db);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "POST", "/api/admin/settings/resources", {
        storeId: "store_test",
        name: "拒否される",
        resourceType: "staff_calendar",
        active: true,
        idempotencyKey: "res-staff-1"
      });
      expect(response.status).toBe(403);
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 400 invalid_request for unknown resource_type", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "POST", "/api/admin/settings/resources", {
        storeId: "store_test",
        name: "未知タイプ",
        resourceType: "spaceship",
        active: true,
        idempotencyKey: "res-bad-type-1"
      });
      expect(response.status).toBe(400);
      await expect(readJson(response)).resolves.toMatchObject({ ok: false, error: "invalid_request" });
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 409 has_future_reservations when DELETE targets a resource with a future booking", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db);
      seedResource(db, { id: "res_busy", storeId: "store_test" });
      seedFutureReservationOnResource(db, {
        id: "rsv_res_future",
        storeId: "store_test",
        resourceId: "res_busy",
        startAt: futureSlot
      });
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "DELETE", "/api/admin/settings/resources/res_busy");
      expect(response.status).toBe(409);
      const row = db.sqlite
        .prepare("SELECT active FROM store_resources WHERE id = 'res_busy'")
        .get() as { active: number };
      expect(row.active).toBe(1);
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 409 has_future_reservations on PUT active:false when resource has future bookings", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db);
      seedResource(db, { id: "res_put_busy", storeId: "store_test" });
      seedFutureReservationOnResource(db, {
        id: "rsv_put_res",
        storeId: "store_test",
        resourceId: "res_put_busy",
        startAt: futureSlot
      });
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "PUT", "/api/admin/settings/resources/res_put_busy", {
        storeId: "store_test",
        name: "停止しようとする",
        resourceType: "staff_calendar",
        active: false
      });
      expect(response.status).toBe(409);
      const row = db.sqlite
        .prepare("SELECT active FROM store_resources WHERE id = 'res_put_busy'")
        .get() as { active: number };
      expect(row.active).toBe(1);
    } finally {
      db.sqlite.close();
    }
  });

  it("replays same idempotencyKey + same payload as 200 + replayed:true (no duplicate row)", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const payload = {
        storeId: "store_test",
        name: "リプレイ確認リソース",
        resourceType: "staff_calendar",
        active: true,
        idempotencyKey: "res-replay-1"
      };
      const first = await adminRequest(db, access.token, "POST", "/api/admin/settings/resources", payload);
      expect(first.status).toBe(201);
      const firstId = (await readJson(first)).resourceId as string;

      const second = await adminRequest(db, access.token, "POST", "/api/admin/settings/resources", payload);
      expect(second.status).toBe(200);
      await expect(readJson(second)).resolves.toMatchObject({ ok: true, replayed: true, resourceId: firstId });
      const count = (
        db.sqlite.prepare("SELECT COUNT(*) AS count FROM store_resources WHERE name = 'リプレイ確認リソース'").get() as { count: number }
      ).count;
      expect(count).toBe(1);
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 409 idempotency_conflict when same key is reused with a different payload", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const base = {
        storeId: "store_test",
        name: "オリジナルリソース",
        resourceType: "staff_calendar" as const,
        active: true,
        idempotencyKey: "res-conflict-1"
      };
      await adminRequest(db, access.token, "POST", "/api/admin/settings/resources", base);
      const second = await adminRequest(db, access.token, "POST", "/api/admin/settings/resources", { ...base, name: "別の名前" });
      expect(second.status).toBe(409);
      await expect(readJson(second)).resolves.toMatchObject({ ok: false, error: "idempotency_conflict" });
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 404 store_not_found when POST references a missing store", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "POST", "/api/admin/settings/resources", {
        storeId: "missing_store",
        name: "孤立",
        resourceType: "staff_calendar",
        active: true,
        idempotencyKey: "res-snf-1"
      });
      expect(response.status).toBe(404);
      await expect(readJson(response)).resolves.toMatchObject({ ok: false, error: "store_not_found" });
    } finally {
      db.sqlite.close();
    }
  });

  it("system_admin role succeeds on resource create (privileged role parity)", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "system_admin");
      seedStore(db);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "POST", "/api/admin/settings/resources", {
        storeId: "store_test",
        name: "system_admin作成",
        resourceType: "staff_calendar",
        active: true,
        idempotencyKey: "res-sysadmin-1"
      });
      expect(response.status).toBe(201);
      await expect(readJson(response)).resolves.toMatchObject({ ok: true });
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 409 immutable_store when PUT tries to move a resource to a different store", async () => {
    // Regression for codex P2: cross-store moves would desync reservations
    // and external_blocks which still key on the old store_id. Operator
    // must soft-delete + recreate to genuinely change a resource's store.
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db, "store_a");
      seedStore(db, "store_b");
      seedResource(db, { id: "res_move", storeId: "store_a" });
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "PUT", "/api/admin/settings/resources/res_move", {
        storeId: "store_b",
        name: "別店舗に移動",
        resourceType: "staff_calendar",
        active: true
      });
      expect(response.status).toBe(409);
      await expect(readJson(response)).resolves.toMatchObject({ ok: false, error: "immutable_store" });
      const row = db.sqlite
        .prepare("SELECT store_id, name FROM store_resources WHERE id = 'res_move'")
        .get() as { store_id: string; name: string };
      expect(row).toMatchObject({ store_id: "store_a", name: "既存リソース" });
    } finally {
      db.sqlite.close();
    }
  });

  it("soft-deletes a resource and writes audit when no future bookings exist", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db);
      seedResource(db, { id: "res_idle", storeId: "store_test" });
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "DELETE", "/api/admin/settings/resources/res_idle");
      expect(response.status).toBe(200);
      const row = db.sqlite
        .prepare("SELECT active FROM store_resources WHERE id = 'res_idle'")
        .get() as { active: number };
      expect(row.active).toBe(0);
    } finally {
      db.sqlite.close();
    }
  });
});

describe("admin settings — staff_members endpoints", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates a staff member with audit + idempotency row (201)", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "POST", "/api/admin/settings/staff", {
        storeId: "store_test",
        displayName: "新人スタッフ",
        role: "staff",
        active: true,
        idempotencyKey: "staff-create-1"
      });
      expect(response.status).toBe(201);
      const body = await readJson(response);
      expect(body).toMatchObject({ ok: true, replayed: false });
      const id = body.staffId as string;
      const row = db.sqlite
        .prepare("SELECT display_name, role, active FROM staff_members WHERE id = ?")
        .get(id) as { display_name: string; role: string; active: number };
      expect(row).toMatchObject({ display_name: "新人スタッフ", role: "staff", active: 1 });
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 400 invalid_request for unknown role", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "POST", "/api/admin/settings/staff", {
        storeId: "store_test",
        displayName: "未知役割",
        role: "ceo",
        active: true,
        idempotencyKey: "staff-bad-role"
      });
      expect(response.status).toBe(400);
    } finally {
      db.sqlite.close();
    }
  });

  it("PUT updates display_name and writes before/after audit", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db);
      seedStaff(db, { id: "staff_a", storeId: "store_test", displayName: "旧名前" });
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "PUT", "/api/admin/settings/staff/staff_a", {
        storeId: "store_test",
        displayName: "新名前",
        role: "owner",
        active: true,
        expectedVersion: 1
      });
      expect(response.status).toBe(200);
      const row = db.sqlite
        .prepare("SELECT display_name, role FROM staff_members WHERE id = 'staff_a'")
        .get() as { display_name: string; role: string };
      expect(row).toMatchObject({ display_name: "新名前", role: "owner" });
      const audit = db.sqlite
        .prepare("SELECT metadata_json FROM audit_logs WHERE action = 'settings.staff.update'")
        .get() as { metadata_json: string };
      const meta = JSON.parse(audit.metadata_json);
      expect(meta.before).toMatchObject({ displayName: "旧名前", role: "staff" });
      expect(meta.after).toMatchObject({ displayName: "新名前", role: "owner" });
    } finally {
      db.sqlite.close();
    }
  });

  it("replays same key + same payload as 200 + replayed:true, conflicts on different payload", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const payload = {
        storeId: "store_test",
        displayName: "リプレイ確認",
        role: "staff" as const,
        active: true,
        idempotencyKey: "staff-replay-1"
      };
      const first = await adminRequest(db, access.token, "POST", "/api/admin/settings/staff", payload);
      expect(first.status).toBe(201);
      const firstId = (await readJson(first)).staffId as string;
      const second = await adminRequest(db, access.token, "POST", "/api/admin/settings/staff", payload);
      expect(second.status).toBe(200);
      await expect(readJson(second)).resolves.toMatchObject({ ok: true, replayed: true, staffId: firstId });
      const conflict = await adminRequest(db, access.token, "POST", "/api/admin/settings/staff", { ...payload, displayName: "他人" });
      expect(conflict.status).toBe(409);
    } finally {
      db.sqlite.close();
    }
  });

  it("soft-deletes a staff member (active=0) and writes audit", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db);
      seedStaff(db, { id: "staff_b", storeId: "store_test" });
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "DELETE", "/api/admin/settings/staff/staff_b");
      expect(response.status).toBe(200);
      const row = db.sqlite.prepare("SELECT active FROM staff_members WHERE id = 'staff_b'").get() as { active: number };
      expect(row.active).toBe(0);
    } finally {
      db.sqlite.close();
    }
  });

  it("PUT propagates role + active flips to the linked admin_users row in the same batch", async () => {
    // Regression for codex P2: authenticateAdmin reads role + active from
    // admin_users, not from the linked staff_members row. Promote / demote /
    // deactivate via PUT must mirror to admin_users or the privilege change
    // never takes effect on the next admin API call.
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db);
      seedStaff(db, { id: "staff_link_put", storeId: "store_test", role: "staff" });
      db.sqlite
        .prepare(
          `INSERT INTO admin_users (id, email, access_subject, role, active, staff_member_id, updated_at)
           VALUES ('admin_link_put', 'link-put@example.com', 'access-link-put', 'staff', 1, 'staff_link_put', '2026-05-19T00:00:00.000Z')`
        )
        .run();
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "PUT", "/api/admin/settings/staff/staff_link_put", {
        storeId: "store_test",
        displayName: "昇格された",
        role: "owner",
        active: false,
        expectedVersion: 1
      });
      expect(response.status).toBe(200);
      const staff = db.sqlite
        .prepare("SELECT role, active FROM staff_members WHERE id = 'staff_link_put'")
        .get() as { role: string; active: number };
      expect(staff).toMatchObject({ role: "owner", active: 0 });
      const admin = db.sqlite
        .prepare("SELECT role, active FROM admin_users WHERE id = 'admin_link_put'")
        .get() as { role: string; active: number };
      expect(admin).toMatchObject({ role: "owner", active: 0 });
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects a stale PUT instead of reactivating a staff member disabled by another admin", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db);
      seedStaff(db, { id: "staff_stale_put", storeId: "store_test", role: "staff" });
      db.sqlite
        .prepare(
          `INSERT INTO admin_users (id, email, access_subject, role, active, staff_member_id, updated_at)
           VALUES ('admin_stale_put', 'stale-put@example.com', 'access-stale-put', 'staff', 1,
                   'staff_stale_put', '2026-05-19T00:00:00.000Z')`
        )
        .run();
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const disabled = await adminRequest(
        db,
        access.token,
        "DELETE",
        "/api/admin/settings/staff/staff_stale_put"
      );
      expect(disabled.status).toBe(200);

      const stale = await adminRequest(db, access.token, "PUT", "/api/admin/settings/staff/staff_stale_put", {
        storeId: "store_test",
        displayName: "古い画面から保存",
        role: "staff",
        active: true,
        expectedVersion: 1
      });

      expect(stale.status).toBe(409);
      await expect(readJson(stale)).resolves.toMatchObject({ ok: false, error: "stale_snapshot" });
      const staff = db.sqlite
        .prepare("SELECT display_name, active, version FROM staff_members WHERE id = 'staff_stale_put'")
        .get() as { display_name: string; active: number; version: number };
      expect(staff).toEqual({ display_name: "山田太郎", active: 0, version: 2 });
      const linkedAdmin = db.sqlite
        .prepare("SELECT active FROM admin_users WHERE id = 'admin_stale_put'")
        .get() as { active: number };
      expect(linkedAdmin.active).toBe(0);
    } finally {
      db.sqlite.close();
    }
  });

  it("rolls back a PUT when the staff version changes after its precheck", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db);
      seedStaff(db, { id: "staff_mid_batch_stale", storeId: "store_test", role: "staff" });
      db.sqlite
        .prepare(
          `INSERT INTO admin_users (id, email, access_subject, role, active, staff_member_id, updated_at)
           VALUES ('admin_mid_batch_stale', 'mid-batch-stale@example.com', 'access-mid-batch-stale',
                   'staff', 1, 'staff_mid_batch_stale', '2026-05-19T00:00:00.000Z')`
        )
        .run();
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const originalBatch = db.batch.bind(db);
      let injected = false;
      db.batch = async (statements) => {
        if (!injected) {
          injected = true;
          db.sqlite
            .prepare(
              `UPDATE staff_members
               SET active = 0, version = version + 1
               WHERE id = 'staff_mid_batch_stale'`
            )
            .run();
          db.sqlite
            .prepare(
              `UPDATE admin_users
               SET active = 0
               WHERE id = 'admin_mid_batch_stale'`
            )
            .run();
        }
        return originalBatch(statements);
      };

      const stale = await adminRequest(
        db,
        access.token,
        "PUT",
        "/api/admin/settings/staff/staff_mid_batch_stale",
        {
          storeId: "store_test",
          displayName: "競合で保存されない名前",
          role: "staff",
          active: true,
          expectedVersion: 1
        }
      );

      expect(stale.status).toBe(409);
      await expect(readJson(stale)).resolves.toMatchObject({ ok: false, error: "stale_snapshot" });
      const staff = db.sqlite
        .prepare("SELECT display_name, active, version FROM staff_members WHERE id = 'staff_mid_batch_stale'")
        .get() as { display_name: string; active: number; version: number };
      expect(staff).toEqual({ display_name: "山田太郎", active: 0, version: 2 });
      const linkedAdmin = db.sqlite
        .prepare("SELECT active FROM admin_users WHERE id = 'admin_mid_batch_stale'")
        .get() as { active: number };
      expect(linkedAdmin.active).toBe(0);
      expect(
        (
          db.sqlite
            .prepare(
              `SELECT COUNT(*) AS count
               FROM audit_logs
               WHERE action = 'settings.staff.update'
                 AND target_id = 'staff_mid_batch_stale'`
            )
            .get() as { count: number }
        ).count
      ).toBe(0);
    } finally {
      db.sqlite.close();
    }
  });

  it("revokes linked admin_users (active=0) when soft-deleting a staff member", async () => {
    // Regression for codex P2: authenticateAdmin gates on admin_users.active=1.
    // Without also flipping admin_users.active=0, a deactivated staff member
    // could continue using staff-permitted admin APIs until the operator
    // manually disabled the row. Both flips live in the same D1 batch.
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db);
      seedStaff(db, { id: "staff_c", storeId: "store_test" });
      db.sqlite
        .prepare(
          `INSERT INTO admin_users (id, email, access_subject, role, active, staff_member_id, updated_at)
           VALUES ('admin_for_staff_c', 'staff-c@example.com', 'access-staff-c', 'staff', 1, 'staff_c', '2026-05-19T00:00:00.000Z')`
        )
        .run();
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "DELETE", "/api/admin/settings/staff/staff_c");
      expect(response.status).toBe(200);
      const staff = db.sqlite.prepare("SELECT active FROM staff_members WHERE id = 'staff_c'").get() as { active: number };
      expect(staff.active).toBe(0);
      const admin = db.sqlite
        .prepare("SELECT active FROM admin_users WHERE id = 'admin_for_staff_c'")
        .get() as { active: number };
      expect(admin.active).toBe(0);
      const audit = db.sqlite
        .prepare("SELECT metadata_json FROM audit_logs WHERE action = 'settings.staff.delete'")
        .get() as { metadata_json: string };
      expect(JSON.parse(audit.metadata_json)).toMatchObject({ linkedAdminUsersRevoked: true });
    } finally {
      db.sqlite.close();
    }
  });
});

// staff の store スコープは admin_users.staff_member_id → staff_members.store_id
// の JOIN で決まる (src/admin/access.ts)。店舗に紐付いた staff アカウントを作る。
const insertStaffAdminLinkedToStore = (db: SqliteD1Database, storeId: string) => {
  seedStaff(db, { id: "sm_scope_1", storeId });
  db.sqlite
    .prepare(
      `INSERT INTO admin_users (id, email, access_subject, role, active, staff_member_id, updated_at)
       VALUES ('admin_settings_4c_1', ?, ?, 'staff', 1, 'sm_scope_1', '2026-05-19T00:00:00.000Z')`
    )
    .run(ADMIN_EMAIL, ADMIN_ACCESS_SUBJECT);
};

describe("admin settings — store_closures staff store scope", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("staff can create a closure for their own store (201)", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedStore(db);
      insertStaffAdminLinkedToStore(db, "store_test");
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "POST", "/api/admin/settings/closures", {
        storeId: "store_test",
        startsAt: "2026-12-31T00:00:00.000Z",
        endsAt: "2027-01-03T15:00:00.000Z",
        reason: "スタッフ登録の休業",
        idempotencyKey: "cls-staff-own-1"
      });
      expect(response.status).toBe(201);
    } finally {
      db.sqlite.close();
    }
  });

  it("staff cannot create a closure for another store (403)", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedStore(db);
      seedStore(db, "store_other");
      insertStaffAdminLinkedToStore(db, "store_other");
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "POST", "/api/admin/settings/closures", {
        storeId: "store_test",
        startsAt: "2026-12-31T00:00:00.000Z",
        endsAt: "2027-01-03T15:00:00.000Z",
        reason: "越権",
        idempotencyKey: "cls-staff-cross-1"
      });
      expect(response.status).toBe(403);
      const body = await readJson(response);
      expect(body).toMatchObject({ ok: false, error: "forbidden" });
    } finally {
      db.sqlite.close();
    }
  });

  it("staff cannot update or delete another store's closure (403), and the row survives", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedStore(db);
      seedStore(db, "store_other");
      insertStaffAdminLinkedToStore(db, "store_other");
      seedClosure(db, { id: "cls_cross", storeId: "store_test", reason: "他店舗の休業" });
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const putResponse = await adminRequest(db, access.token, "PUT", "/api/admin/settings/closures/cls_cross", {
        storeId: "store_test",
        startsAt: "2026-12-01T00:00:00.000Z",
        endsAt: "2026-12-01T18:00:00.000Z",
        reason: "書き換え"
      });
      expect(putResponse.status).toBe(403);

      const deleteResponse = await adminRequest(db, access.token, "DELETE", "/api/admin/settings/closures/cls_cross");
      expect(deleteResponse.status).toBe(403);

      const row = db.sqlite
        .prepare("SELECT reason FROM store_closures WHERE id = 'cls_cross'")
        .get() as { reason: string };
      expect(row.reason).toBe("他店舗の休業");
    } finally {
      db.sqlite.close();
    }
  });

  it("staff cannot relocate their own store's closure to another store (409 immutable_store)", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedStore(db);
      seedStore(db, "store_other");
      insertStaffAdminLinkedToStore(db, "store_test");
      seedClosure(db, { id: "cls_move", storeId: "store_test", reason: "自店舗の休業" });
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      // 認可は current.store_id (自店舗) を通るが、guardImmutableStore が
      // store 移動そのものを拒否する — staff が他店舗へ休業日を送り込む経路はない。
      const response = await adminRequest(db, access.token, "PUT", "/api/admin/settings/closures/cls_move", {
        storeId: "store_other",
        startsAt: "2026-12-01T00:00:00.000Z",
        endsAt: "2026-12-01T18:00:00.000Z",
        reason: "移動を試みる"
      });
      expect(response.status).toBe(409);
      const body = await readJson(response);
      expect(body).toMatchObject({ ok: false, error: "immutable_store" });
      const row = db.sqlite
        .prepare("SELECT store_id, reason FROM store_closures WHERE id = 'cls_move'")
        .get() as { store_id: string; reason: string };
      expect(row).toMatchObject({ store_id: "store_test", reason: "自店舗の休業" });
    } finally {
      db.sqlite.close();
    }
  });

  it("staff can delete their own store's closure (200)", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedStore(db);
      insertStaffAdminLinkedToStore(db, "store_test");
      seedClosure(db, { id: "cls_own", storeId: "store_test" });
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "DELETE", "/api/admin/settings/closures/cls_own");
      expect(response.status).toBe(200);
      const row = db.sqlite.prepare("SELECT id FROM store_closures WHERE id = 'cls_own'").get();
      expect(row).toBeUndefined();
    } finally {
      db.sqlite.close();
    }
  });
});

describe("admin settings — store_closures endpoints", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates an admin-source closure with audit + idempotency row (201)", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "POST", "/api/admin/settings/closures", {
        storeId: "store_test",
        startsAt: "2026-12-31T00:00:00.000Z",
        endsAt: "2027-01-03T15:00:00.000Z",
        reason: "年末年始休業",
        idempotencyKey: "cls-create-1"
      });
      expect(response.status).toBe(201);
      const body = await readJson(response);
      const id = body.closureId as string;
      const row = db.sqlite
        .prepare("SELECT reason, source FROM store_closures WHERE id = ?")
        .get(id) as { reason: string; source: string };
      expect(row).toMatchObject({ reason: "年末年始休業", source: "admin" });
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 400 invalid_request when starts_at is not before ends_at", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "POST", "/api/admin/settings/closures", {
        storeId: "store_test",
        startsAt: "2027-01-03T15:00:00.000Z",
        endsAt: "2026-12-31T00:00:00.000Z",
        reason: "逆順",
        idempotencyKey: "cls-bad-range"
      });
      expect(response.status).toBe(400);
    } finally {
      db.sqlite.close();
    }
  });

  it("PUT updates an admin-source closure", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db);
      seedClosure(db, { id: "cls_a", storeId: "store_test", reason: "旧理由" });
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "PUT", "/api/admin/settings/closures/cls_a", {
        storeId: "store_test",
        startsAt: "2026-12-01T00:00:00.000Z",
        endsAt: "2026-12-01T18:00:00.000Z",
        reason: "新理由"
      });
      expect(response.status).toBe(200);
      const row = db.sqlite.prepare("SELECT reason FROM store_closures WHERE id = 'cls_a'").get() as { reason: string };
      expect(row.reason).toBe("新理由");
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 409 immutable_source on PUT against google_external_block-sourced closure", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db);
      seedClosure(db, { id: "cls_google", storeId: "store_test", source: "google_external_block", reason: "google originated" });
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "PUT", "/api/admin/settings/closures/cls_google", {
        storeId: "store_test",
        startsAt: "2026-12-01T00:00:00.000Z",
        endsAt: "2026-12-01T18:00:00.000Z",
        reason: "上書きしようとする"
      });
      expect(response.status).toBe(409);
      await expect(readJson(response)).resolves.toMatchObject({ ok: false, error: "immutable_source" });
      const row = db.sqlite.prepare("SELECT reason FROM store_closures WHERE id = 'cls_google'").get() as { reason: string };
      expect(row.reason).toBe("google originated");
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 409 immutable_store on PUT that moves a closure to a different store", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db, "store_a");
      seedStore(db, "store_b");
      seedClosure(db, { id: "cls_move", storeId: "store_a", reason: "元店舗" });
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "PUT", "/api/admin/settings/closures/cls_move", {
        storeId: "store_b",
        startsAt: "2026-12-01T00:00:00.000Z",
        endsAt: "2026-12-01T18:00:00.000Z",
        reason: "別店舗へ移動しようとする"
      });
      expect(response.status).toBe(409);
      await expect(readJson(response)).resolves.toMatchObject({ ok: false, error: "immutable_store" });
      const row = db.sqlite
        .prepare("SELECT store_id, reason FROM store_closures WHERE id = 'cls_move'")
        .get() as { store_id: string; reason: string };
      expect(row).toMatchObject({ store_id: "store_a", reason: "元店舗" });
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 409 immutable_source on DELETE against google_external_block-sourced closure", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db);
      seedClosure(db, { id: "cls_g_del", storeId: "store_test", source: "google_external_block" });
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "DELETE", "/api/admin/settings/closures/cls_g_del");
      expect(response.status).toBe(409);
      const count = (
        db.sqlite.prepare("SELECT COUNT(*) AS count FROM store_closures WHERE id = 'cls_g_del'").get() as { count: number }
      ).count;
      expect(count).toBe(1);
    } finally {
      db.sqlite.close();
    }
  });

  it("replays same idempotencyKey + same payload as 200 + replayed:true (no duplicate closure)", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const payload = {
        storeId: "store_test",
        startsAt: "2027-03-01T00:00:00.000Z",
        endsAt: "2027-03-01T12:00:00.000Z",
        reason: "重複防止確認",
        idempotencyKey: "cls-replay-1"
      };
      const first = await adminRequest(db, access.token, "POST", "/api/admin/settings/closures", payload);
      expect(first.status).toBe(201);
      const firstId = (await readJson(first)).closureId as string;
      const second = await adminRequest(db, access.token, "POST", "/api/admin/settings/closures", payload);
      expect(second.status).toBe(200);
      await expect(readJson(second)).resolves.toMatchObject({ ok: true, replayed: true, closureId: firstId });
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 400 invalid_request for impossible calendar date (Feb 30)", async () => {
    // Regression: parseIsoInstant must reject impossible dates that Date.parse
    // would otherwise normalize (Feb 30 → Mar 2). Otherwise the input string
    // is stored verbatim and lexicographic comparisons over starts_at/ends_at
    // diverge from what the operator believed they configured.
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "POST", "/api/admin/settings/closures", {
        storeId: "store_test",
        startsAt: "2026-02-30T00:00:00.000Z",
        endsAt: "2026-03-15T00:00:00.000Z",
        reason: "不可能な日付",
        idempotencyKey: "cls-feb-30"
      });
      expect(response.status).toBe(400);
      await expect(readJson(response)).resolves.toMatchObject({ ok: false, error: "invalid_request" });
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 400 invalid_request for impossible hour (24:00:00)", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "POST", "/api/admin/settings/closures", {
        storeId: "store_test",
        startsAt: "2026-12-31T24:00:00.000Z",
        endsAt: "2027-01-01T18:00:00.000Z",
        reason: "不可能な時間",
        idempotencyKey: "cls-hour-24"
      });
      expect(response.status).toBe(400);
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 409 overlapping_reservations when POST closure window overlaps existing future bookings", async () => {
    // Regression for codex P2: creating a closure across a window that
    // already contains pending_approval / confirmed reservations would leave
    // customers stranded inside a newly-closed period. Refuse the write and
    // force the operator to cancel/move the reservations first.
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db);
      // Seed a future reservation in the closure window so the overlap fires.
      db.sqlite
        .prepare(
          `INSERT INTO customers (id, display_name, phone_normalized, phone_hash, updated_at)
           VALUES ('cust_overlap', '予約客', '09012345678', 'hash', '2026-05-19T00:00:00.000Z')`
        )
        .run();
      db.sqlite
        .prepare(
          `INSERT INTO services (id, store_id, name, duration_minutes, created_at, updated_at)
           VALUES ('svc_overlap', 'store_test', 'svc', 60, '2026-05-19T00:00:00.000Z', '2026-05-19T00:00:00.000Z')`
        )
        .run();
      db.sqlite
        .prepare(
          `INSERT INTO store_resources (id, store_id, name)
           VALUES ('res_overlap', 'store_test', 'cal')`
        )
        .run();
      db.sqlite
        .prepare(
          `INSERT INTO reservations (
             id, store_id, service_id, customer_id, resource_id, source,
             status, start_at, end_at, duration_minutes, idempotency_key,
             created_at, updated_at
           ) VALUES ('rsv_overlap', 'store_test', 'svc_overlap', 'cust_overlap', 'res_overlap',
             'admin', 'confirmed', '2027-03-01T03:00:00.000Z', '2027-03-01T04:00:00.000Z', 60,
             'rsv-overlap-key', '2026-05-19T00:00:00.000Z', '2026-05-19T00:00:00.000Z')`
        )
        .run();

      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "POST", "/api/admin/settings/closures", {
        storeId: "store_test",
        startsAt: "2027-03-01T00:00:00.000Z",
        endsAt: "2027-03-01T12:00:00.000Z",
        reason: "重複ありの休業",
        idempotencyKey: "cls-overlap-1"
      });
      expect(response.status).toBe(409);
      await expect(readJson(response)).resolves.toMatchObject({ ok: false, error: "overlapping_reservations" });
      const count = (
        db.sqlite.prepare("SELECT COUNT(*) AS count FROM store_closures").get() as { count: number }
      ).count;
      expect(count).toBe(0);
    } finally {
      db.sqlite.close();
    }
  });

  it("returns overlapping_reservations when a reservation is committed after the closure precheck", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db);
      seedResource(db, { id: "res_closure_race", storeId: "store_test" });
      db.sqlite
        .prepare("INSERT INTO customers (id, display_name) VALUES ('cust_closure_race', '競合予約客')")
        .run();
      db.sqlite
        .prepare(
          `INSERT INTO services (id, store_id, name, duration_minutes)
           VALUES ('svc_closure_race', 'store_test', '競合用サービス', 60)`
        )
        .run();

      const originalBatch = db.batch.bind(db);
      let injected = false;
      db.batch = async (statements) => {
        if (!injected) {
          injected = true;
          db.sqlite
            .prepare(
              `INSERT INTO reservations (
                 id, store_id, service_id, customer_id, resource_id, source, status,
                 start_at, end_at, duration_minutes, idempotency_key
               ) VALUES (
                 'rsv_closure_race', 'store_test', 'svc_closure_race', 'cust_closure_race',
                 'res_closure_race', 'admin', 'confirmed',
                 '2027-03-01T03:00:00.000Z', '2027-03-01T04:00:00.000Z', 60, 'rsv-closure-race-key'
               )`
            )
            .run();
        }
        return originalBatch(statements);
      };

      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));
      const response = await adminRequest(db, access.token, "POST", "/api/admin/settings/closures", {
        storeId: "store_test",
        startsAt: "2027-03-01T00:00:00.000Z",
        endsAt: "2027-03-01T12:00:00.000Z",
        reason: "競合直後の休業",
        idempotencyKey: "cls-overlap-race-1"
      });

      expect(response.status).toBe(409);
      await expect(readJson(response)).resolves.toMatchObject({
        ok: false,
        error: "overlapping_reservations"
      });
      expect(
        (db.sqlite.prepare("SELECT COUNT(*) AS count FROM store_closures").get() as { count: number }).count
      ).toBe(0);
      expect(
        (db.sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency_keys WHERE idempotency_key = 'cls-overlap-race-1'").get() as { count: number }).count
      ).toBe(0);
    } finally {
      db.sqlite.close();
    }
  });

  it("normalizes non-canonical fractional seconds to .sssZ form before persisting", async () => {
    // Regression: `.1Z` and `.150Z` are equal-second times (100ms vs 150ms)
    // but lexicographic TEXT comparison in SQLite sorts `.1Z` > `.150Z`
    // because 'Z' > '5'. Storing the normalized toISOString() form keeps
    // every stored value lexicographically sortable.
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db);
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "POST", "/api/admin/settings/closures", {
        storeId: "store_test",
        startsAt: "2027-04-01T00:00:00.1Z",
        endsAt: "2027-04-01T12:00:00.150Z",
        reason: "正規化確認",
        idempotencyKey: "cls-norm-1"
      });
      expect(response.status).toBe(201);
      const id = (await readJson(response)).closureId as string;
      const row = db.sqlite
        .prepare("SELECT starts_at, ends_at FROM store_closures WHERE id = ?")
        .get(id) as { starts_at: string; ends_at: string };
      // 100ms normalizes to .100Z, 150ms stays .150Z — both 3-digit fractional.
      expect(row.starts_at).toBe("2027-04-01T00:00:00.100Z");
      expect(row.ends_at).toBe("2027-04-01T12:00:00.150Z");
    } finally {
      db.sqlite.close();
    }
  });

  it("hard-deletes an admin-source closure and writes audit", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedStore(db);
      seedClosure(db, { id: "cls_del", storeId: "store_test" });
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await adminRequest(db, access.token, "DELETE", "/api/admin/settings/closures/cls_del");
      expect(response.status).toBe(200);
      const count = (
        db.sqlite.prepare("SELECT COUNT(*) AS count FROM store_closures WHERE id = 'cls_del'").get() as { count: number }
      ).count;
      expect(count).toBe(0);
      const audit = db.sqlite
        .prepare("SELECT action, metadata_json FROM audit_logs WHERE action = 'settings.closures.delete'")
        .get() as { action: string; metadata_json: string };
      expect(audit.action).toBe("settings.closures.delete");
      expect(JSON.parse(audit.metadata_json)).toMatchObject({ hardDelete: true });
    } finally {
      db.sqlite.close();
    }
  });
});
