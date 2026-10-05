import { describe, expect, it } from "vitest";

import { resolveHumanAdmin } from "../src/admin/access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";
import { insertAdminUser as insertAdminUserHelper, type AdminRole, type InsertAdminUserOptions } from "./helpers/admin-access";

// Covers the store-login self-service "pending bind" flow added to resolveHumanAdmin.
// An owner pre-registers a store login by email; the row is created with a sentinel
// access_subject = 'pending:<uuid>' (access_subject is NOT NULL UNIQUE). On the staff's
// FIRST verified login the real JWT subject is bound to that pending row. Subsequent
// logins match exactly. A different subject must never hijack an already-bound identity.

const NOW_ISO = "2026-06-03T12:00:00.000Z";

const insertStaffMember = (
  db: SqliteD1Database,
  options: { id: string; storeId: string; displayName?: string; role?: string }
) => {
  db.sqlite
    .prepare(
      `
        INSERT INTO staff_members (id, store_id, display_name, role, active)
        VALUES (?, ?, ?, ?, 1)
      `
    )
    .run(options.id, options.storeId, options.displayName ?? "テストスタッフ", options.role ?? "staff");
};

const insertAdminUser = (
  db: SqliteD1Database,
  options: InsertAdminUserOptions & { role?: string }
) =>
  insertAdminUserHelper(db, {
    ...options,
    role: (options.role as AdminRole | undefined) ?? "staff",
    updatedAt: options.updatedAt ?? "2026-05-16T00:00:00.000Z",
  });

const readAdminUser = (db: SqliteD1Database, id: string) =>
  db.sqlite
    .prepare(`SELECT id, email, access_subject, last_seen_at, role FROM admin_users WHERE id = ?`)
    .get(id) as
    | { id: string; email: string; access_subject: string; last_seen_at: string | null; role: string }
    | undefined;

describe("resolveHumanAdmin: pending store-login bind", () => {
  it("binds a pending row to the verified subject on first login", async () => {
    const db = createMigratedSqliteD1();
    insertStaffMember(db, { id: "staff_pending_osaka", storeId: "osaka" });
    insertAdminUser(db, {
      id: "admin_pending_1",
      email: "umeda@example.com",
      accessSubject: "pending:abc",
      role: "staff",
      staffMemberId: "staff_pending_osaka"
    });

    const result = await resolveHumanAdmin(
      db as unknown as D1Database,
      { email: "umeda@example.com", sub: "real-1" },
      NOW_ISO
    );

    expect(result).toEqual({
      ok: true,
      admin: {
        id: "admin_pending_1",
        email: "umeda@example.com",
        role: "staff",
        staff_member_id: "staff_pending_osaka",
        store_id: "osaka"
      }
    });

    const row = readAdminUser(db, "admin_pending_1");
    expect(row?.access_subject).toBe("real-1");
    expect(row?.last_seen_at).toBe(NOW_ISO);
  });

  it("rejects a different subject after the row is already bound (no hijack)", async () => {
    const db = createMigratedSqliteD1();
    insertStaffMember(db, { id: "staff_pending_osaka", storeId: "osaka" });
    insertAdminUser(db, {
      id: "admin_pending_1",
      email: "umeda@example.com",
      accessSubject: "pending:abc",
      role: "staff",
      staffMemberId: "staff_pending_osaka"
    });

    const first = await resolveHumanAdmin(
      db as unknown as D1Database,
      { email: "umeda@example.com", sub: "real-1" },
      NOW_ISO
    );
    expect(first.ok).toBe(true);

    const intruder = await resolveHumanAdmin(
      db as unknown as D1Database,
      { email: "umeda@example.com", sub: "intruder" },
      "2026-06-03T13:00:00.000Z"
    );

    expect(intruder).toEqual({ ok: false, reason: "admin_not_registered" });

    const row = readAdminUser(db, "admin_pending_1");
    expect(row?.access_subject).toBe("real-1");
  });

  it("authenticates a second login of the same bound identity", async () => {
    const db = createMigratedSqliteD1();
    insertStaffMember(db, { id: "staff_pending_osaka", storeId: "osaka" });
    insertAdminUser(db, {
      id: "admin_pending_1",
      email: "umeda@example.com",
      accessSubject: "pending:abc",
      role: "staff",
      staffMemberId: "staff_pending_osaka"
    });

    await resolveHumanAdmin(
      db as unknown as D1Database,
      { email: "umeda@example.com", sub: "real-1" },
      NOW_ISO
    );

    const second = await resolveHumanAdmin(
      db as unknown as D1Database,
      { email: "umeda@example.com", sub: "real-1" },
      "2026-06-03T14:00:00.000Z"
    );

    expect(second).toEqual({
      ok: true,
      admin: {
        id: "admin_pending_1",
        email: "umeda@example.com",
        role: "staff",
        staff_member_id: "staff_pending_osaka",
        store_id: "osaka"
      }
    });

    const row = readAdminUser(db, "admin_pending_1");
    expect(row?.access_subject).toBe("real-1");
    expect(row?.last_seen_at).toBe("2026-06-03T14:00:00.000Z");
  });

  it("returns admin_not_registered for an unknown email", async () => {
    const db = createMigratedSqliteD1();

    const result = await resolveHumanAdmin(
      db as unknown as D1Database,
      { email: "nobody@example.com", sub: "real-x" },
      NOW_ISO
    );

    expect(result).toEqual({ ok: false, reason: "admin_not_registered" });
  });

  it("does not touch a non-pending row when binding an unrelated email, and exact-match still works", async () => {
    const db = createMigratedSqliteD1();
    insertAdminUser(db, {
      id: "admin_normal_1",
      email: "owner@example.com",
      accessSubject: "real-x",
      role: "owner"
    });

    // Bind attempt for a DIFFERENT, unknown email must not affect the normal row.
    const bindAttempt = await resolveHumanAdmin(
      db as unknown as D1Database,
      { email: "stranger@example.com", sub: "real-y" },
      NOW_ISO
    );
    expect(bindAttempt).toEqual({ ok: false, reason: "admin_not_registered" });

    const untouched = readAdminUser(db, "admin_normal_1");
    expect(untouched?.access_subject).toBe("real-x");

    // Exact-match login for the normal row still authenticates.
    const exact = await resolveHumanAdmin(
      db as unknown as D1Database,
      { email: "owner@example.com", sub: "real-x" },
      NOW_ISO
    );

    expect(exact).toEqual({
      ok: true,
      admin: {
        id: "admin_normal_1",
        email: "owner@example.com",
        role: "owner",
        staff_member_id: null,
        store_id: null
      }
    });

    const seen = readAdminUser(db, "admin_normal_1");
    expect(seen?.last_seen_at).toBe(NOW_ISO);
  });

  it("Fix D: fails closed (no throw) when the verified sub is already on a DIFFERENT row", async () => {
    const db = createMigratedSqliteD1();
    // A pending store login for email B.
    insertStaffMember(db, { id: "staff_pending_osaka", storeId: "osaka" });
    insertAdminUser(db, {
      id: "admin_pending_B",
      email: "b@example.com",
      accessSubject: "pending:b",
      role: "staff",
      staffMemberId: "staff_pending_osaka"
    });
    // An UNRELATED active row already owns access_subject 'sub-X'.
    insertAdminUser(db, {
      id: "admin_other",
      email: "other@example.com",
      accessSubject: "sub-X",
      role: "owner"
    });

    // Logging in as email B with sub-X would, on the bind UPDATE, collide with the
    // UNIQUE(access_subject) constraint. Must fail closed, not throw a 500.
    const result = await resolveHumanAdmin(
      db as unknown as D1Database,
      { email: "b@example.com", sub: "sub-X" },
      NOW_ISO
    );
    expect(result).toEqual({ ok: false, reason: "admin_not_registered" });

    // pending row NOT mutated (still pending), other row untouched
    expect(readAdminUser(db, "admin_pending_B")?.access_subject).toBe("pending:b");
    expect(readAdminUser(db, "admin_other")?.access_subject).toBe("sub-X");
  });

  it("Fix E: writes one admin.login.pending_bind audit row on first bind, none on exact-match login", async () => {
    const db = createMigratedSqliteD1();
    insertStaffMember(db, { id: "staff_pending_osaka", storeId: "osaka" });
    insertAdminUser(db, {
      id: "admin_pending_1",
      email: "umeda@example.com",
      accessSubject: "pending:abc",
      role: "staff",
      staffMemberId: "staff_pending_osaka"
    });

    const auditCount = () =>
      (
        db.sqlite
          .prepare(`SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'admin.login.pending_bind'`)
          .get() as { c: number }
      ).c;

    // First login binds the pending row -> exactly one audit row.
    await resolveHumanAdmin(
      db as unknown as D1Database,
      { email: "umeda@example.com", sub: "real-1" },
      NOW_ISO
    );
    expect(auditCount()).toBe(1);

    const auditRow = db.sqlite
      .prepare(
        `SELECT actor_type, actor_id, target_type, target_id, metadata_json
         FROM audit_logs WHERE action = 'admin.login.pending_bind'`
      )
      .get() as
      | { actor_type: string; actor_id: string; target_type: string; target_id: string; metadata_json: string }
      | undefined;
    expect(auditRow?.actor_type).toBe("staff");
    expect(auditRow?.actor_id).toBe("admin_pending_1");
    expect(auditRow?.target_type).toBe("admin_user");
    expect(auditRow?.target_id).toBe("admin_pending_1");
    expect(JSON.parse(auditRow?.metadata_json ?? "{}")).toMatchObject({ email: "umeda@example.com" });

    // A subsequent exact-match login does NOT add another bind audit row.
    await resolveHumanAdmin(
      db as unknown as D1Database,
      { email: "umeda@example.com", sub: "real-1" },
      "2026-06-03T13:00:00.000Z"
    );
    expect(auditCount()).toBe(1);
  });
});
