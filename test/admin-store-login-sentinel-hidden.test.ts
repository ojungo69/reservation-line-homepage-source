import { describe, expect, it } from "vitest";

import type { AdminUser } from "../src/admin/access";
import { getAdminSettingsSnapshot } from "../src/admin/operations";
import { softDeleteAdminStaff, updateAdminStaff } from "../src/admin/settings-staff";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";
import { insertAdminUser as insertAdminUserHelper, type AdminRole } from "./helpers/admin-access";

// PR #308 review Fix C: the store-login feature creates `staff_login_<store>`
// rows in staff_members to anchor the shared login. Those sentinel rows must NOT
// surface in the normal Staff management surface (snapshot list) and must NOT be
// mutable via the generic staff endpoints — otherwise editing/deleting the
// pseudo-employee would propagate to the linked store-login admin_users row and
// silently revoke the shared login. Store logins are managed only via the
// /store-logins endpoints.

const asD1 = (db: SqliteD1Database) => db as unknown as D1Database;

const OWNER: AdminUser = {
  id: "admin_owner_1",
  email: "owner@example.com",
  role: "owner",
  staff_member_id: null,
  store_id: null
};

const insertStaffMember = (
  db: SqliteD1Database,
  options: { id: string; storeId: string; displayName?: string; role?: string; active?: 0 | 1 }
) => {
  db.sqlite
    .prepare(
      `INSERT INTO staff_members (id, store_id, display_name, role, active)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      options.id,
      options.storeId,
      options.displayName ?? "従業員",
      options.role ?? "staff",
      options.active ?? 1
    );
};

const insertAdminUser = (
  db: SqliteD1Database,
  options: { id: string; email: string; accessSubject: string; role?: string; staffMemberId: string }
) =>
  insertAdminUserHelper(db, {
    id: options.id,
    email: options.email,
    accessSubject: options.accessSubject,
    role: (options.role as AdminRole | undefined) ?? "staff",
    staffMemberId: options.staffMemberId,
    isServiceToken: 0,
    updatedAt: "2026-05-16T00:00:00.000Z",
  });

describe("store-login sentinel staff rows are hidden from Staff management (Fix C)", () => {
  it("getAdminSettingsSnapshot excludes staff_login_<store> rows from the staff list", async () => {
    const db = createMigratedSqliteD1();
    insertStaffMember(db, { id: "staff_login_osaka", storeId: "osaka", displayName: "ExampleStore B ログイン" });
    insertStaffMember(db, { id: "staff_real_osaka", storeId: "osaka", displayName: "本物の従業員" });

    const snapshot = await getAdminSettingsSnapshot({ db: asD1(db) });
    const ids = snapshot.settings.staff.map((s) => s.id);
    expect(ids).toContain("staff_real_osaka");
    expect(ids).not.toContain("staff_login_osaka");
    expect(snapshot.settings.staff.find((s) => s.id === "staff_real_osaka")?.version).toBe(1);
    // also the seeded ordinary owner staff rows remain visible (sanity: not over-filtering)
    expect(snapshot.settings.staff.some((s) => s.id === "staff_owner_osaka")).toBe(true);
  });

  it("updateAdminStaff refuses to operate on a staff_login_<store> id (not_found)", async () => {
    const db = createMigratedSqliteD1();
    insertStaffMember(db, { id: "staff_login_osaka", storeId: "osaka", displayName: "ExampleStore B ログイン", role: "owner" });
    insertAdminUser(db, {
      id: "au_store_login",
      email: "umeda@example.com",
      accessSubject: "real-osaka",
      role: "owner",
      staffMemberId: "staff_login_osaka"
    });

    const result = await updateAdminStaff({
      db: asD1(db),
      admin: OWNER,
      staffId: "staff_login_osaka",
      request: {
        storeId: "osaka",
        displayName: "改名",
        role: "staff",
        active: false,
        expectedVersion: 1
      }
    });
    expect(result).toEqual({ ok: false, error: "not_found" });

    // the staff row and the linked store-login admin_users row are untouched
    const staff = db.sqlite
      .prepare(`SELECT display_name, role, active FROM staff_members WHERE id = 'staff_login_osaka'`)
      .get() as { display_name: string; role: string; active: number } | undefined;
    expect(staff).toMatchObject({ display_name: "ExampleStore B ログイン", role: "owner", active: 1 });
    const au = db.sqlite
      .prepare(`SELECT active FROM admin_users WHERE id = 'au_store_login'`)
      .get() as { active: number } | undefined;
    expect(au?.active).toBe(1);
  });

  it("softDeleteAdminStaff refuses to operate on a staff_login_<store> id (not_found)", async () => {
    const db = createMigratedSqliteD1();
    insertStaffMember(db, { id: "staff_login_osaka", storeId: "osaka", displayName: "ExampleStore B ログイン", role: "owner" });
    insertAdminUser(db, {
      id: "au_store_login",
      email: "umeda@example.com",
      accessSubject: "real-osaka",
      role: "owner",
      staffMemberId: "staff_login_osaka"
    });

    const result = await softDeleteAdminStaff({
      db: asD1(db),
      admin: OWNER,
      staffId: "staff_login_osaka"
    });
    expect(result).toEqual({ ok: false, error: "not_found" });

    const au = db.sqlite
      .prepare(`SELECT active FROM admin_users WHERE id = 'au_store_login'`)
      .get() as { active: number } | undefined;
    expect(au?.active).toBe(1); // shared login NOT revoked
  });

  it("ordinary staff rows are still updatable/deletable (guard is sentinel-scoped)", async () => {
    const db = createMigratedSqliteD1();
    insertAdminUserHelper(db, { id: OWNER.id, email: OWNER.email, accessSubject: OWNER.id, role: OWNER.role });
    insertStaffMember(db, { id: "staff_real_osaka", storeId: "osaka", displayName: "本物の従業員" });

    const update = await updateAdminStaff({
      db: asD1(db),
      admin: OWNER,
      staffId: "staff_real_osaka",
      request: {
        storeId: "osaka",
        displayName: "改名済",
        role: "staff",
        active: true,
        expectedVersion: 1
      }
    });
    expect(update).toEqual({ ok: true, staffId: "staff_real_osaka" });

    const del = await softDeleteAdminStaff({ db: asD1(db), admin: OWNER, staffId: "staff_real_osaka" });
    expect(del).toEqual({ ok: true, staffId: "staff_real_osaka" });
  });
});
