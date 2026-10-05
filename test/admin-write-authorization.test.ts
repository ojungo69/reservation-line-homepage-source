import { describe, expect, it } from "vitest";
import type { AdminUser } from "../src/admin/access";
import { setAdminCustomerArchiveStatus, setAdminCustomerBlockStatus } from "../src/admin/customer-actions";
import { executeAdminCustomerDelete } from "../src/admin/customer-delete";
import { executeAdminCustomerMerge } from "../src/admin/customer-merge";
import { runAdminReservationAction, type AdminReservationAction } from "../src/admin/reservations";
import { createAdminService, updateAdminService, softDeleteAdminService } from "../src/admin/settings-services";
import { createAdminResource, updateAdminResource, softDeleteAdminResource } from "../src/admin/settings-resources";
import { createAdminStaff, updateAdminStaff, softDeleteAdminStaff } from "../src/admin/settings-staff";
import { createAdminClosure, updateAdminClosure, deleteAdminClosure } from "../src/admin/settings-closures";
import { updateAdminBookingWindowSettings } from "../src/admin/settings-booking-window";
import { updateAdminReservationCapSettings } from "../src/admin/settings-reservation-cap";
import { updateAdminCustomerNoticeSettings } from "../src/admin/settings-customer-notice";
import { updateAdminReminderSettings } from "../src/admin/settings-reminder";
import { updateAdminGoogleEditMode } from "../src/admin/settings-google-edit";
import { putBusinessHours } from "../src/admin/settings-business-hours";
import { upsertStoreLogin, revokeStoreLogin } from "../src/admin/settings-store-login";
import { insertAdminUser } from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const admin: AdminUser = {
  id: "write_actor", email: "actor@example.com", role: "owner",
  staff_member_id: "staff_owner_kyoto", store_id: "kyoto"
};

// Compare every persisted table after the concurrent revocation committed.
// This includes audit, idempotency, jobs and lock tables, not only the target.
const snapshot = (db: SqliteD1Database) => {
  const tables = db.sqlite.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return Object.fromEntries(tables.map(({ name }) => [
    name, db.sqlite.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()
  ]));
};

const now = () => Date.parse("2026-09-12T00:00:00.000Z");
const service = { storeId: "kyoto", name: "変更", priceLabel: null, durationMinutes: 60, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, active: true, idempotencyKey: "write_service" };
const resource = { storeId: "kyoto", name: "変更", resourceType: "staff_calendar" as const, active: true, idempotencyKey: "write_resource" };
const staff = { storeId: "kyoto", displayName: "変更", role: "staff" as const, active: false, expectedVersion: 1, idempotencyKey: "write_staff" };
const closure = { storeId: "kyoto", startsAt: "2030-01-01T00:00:00.000Z", endsAt: "2030-01-02T00:00:00.000Z", reason: "変更", idempotencyKey: "write_closure" };

type Mutation = {
  name: string;
  setup?: (db: SqliteD1Database) => void;
  run: (db: D1Database, actor: AdminUser) => Promise<{ ok: boolean; reason?: string; error?: string }>;
};

const reservationSetup = (action: AdminReservationAction) => (db: SqliteD1Database) => {
  const status = action === "approve" || action === "reject" ? "pending_approval"
    : action === "correct-no-show" ? "completed" : action === "restore-completed" ? "no_show" : "confirmed";
  db.sqlite.exec(`
    INSERT INTO line_identities (id, customer_id, channel_id, line_user_id, official_friend_status)
    VALUES ('write_line', 'write_customer', 'channel', 'write_line_user', 'friend');
    INSERT INTO reservations (id, store_id, service_id, resource_id, customer_id, line_identity_id, source, status, start_at, end_at, duration_minutes, pending_expires_at, idempotency_key)
    VALUES ('write_reservation', 'kyoto', 'service_kyoto_default_60', 'resource_kyoto_calendar', 'write_customer', 'write_line', 'web_line', '${status}', '2026-09-11T01:00:00.000Z', '2026-09-11T02:00:00.000Z', 60, '2099-01-01T00:00:00.000Z', 'write_reservation_key');
    INSERT INTO slot_locks (id, store_id, resource_id, slot_at, owner_type, owner_id, lock_status)
    VALUES ('write_slot', 'kyoto', 'resource_kyoto_calendar', '2026-09-11T01:00:00.000Z', 'reservation', 'write_reservation', 'confirmed');
    INSERT INTO customer_time_locks (id, customer_id, slot_at, owner_type, owner_id, lock_status)
    VALUES ('write_time', 'write_customer', '2026-09-11T01:00:00.000Z', 'reservation', 'write_reservation', 'confirmed');
  `);
};

const mutations: Mutation[] = [
  ...(["block", "unblock"] as const).map(action => ({
    name: `customer ${action}`,
    setup: (db: SqliteD1Database) => { if (action === "unblock") db.sqlite.exec("UPDATE customers SET block_status = 'blocked' WHERE id = 'write_customer'"); },
    run: (db: D1Database, actor: AdminUser) => setAdminCustomerBlockStatus({ db, admin: actor, customerId: "write_customer", action, request: { idempotencyKey: "write_block" }, now })
  })),
  ...(["archive", "unarchive"] as const).map(action => ({
    name: `customer ${action}`,
    setup: (db: SqliteD1Database) => { if (action === "unarchive") db.sqlite.exec("UPDATE customers SET archived_at = '2026-09-11T00:00:00Z' WHERE id = 'write_customer'"); },
    run: (db: D1Database, actor: AdminUser) => setAdminCustomerArchiveStatus({ db, admin: actor, customerId: "write_customer", action, request: { idempotencyKey: "write_archive" }, now })
  })),
  { name: "customer merge", setup: reservationSetup("cancel"), run: (db, admin) => executeAdminCustomerMerge({ db, admin, sourceId: "write_customer", targetId: "write_target", now }) },
  { name: "customer delete", setup: db => {
    reservationSetup("cancel")(db);
    db.sqlite.exec("UPDATE reservations SET status = 'cancelled_by_admin' WHERE id = 'write_reservation'");
  }, run: (db, admin) => executeAdminCustomerDelete({ db, admin, customerId: "write_customer" }) },
  ...(["approve", "reject", "cancel", "complete", "no-show", "correct-no-show", "restore-completed"] as const).map(action => ({
    name: `reservation ${action}`, setup: reservationSetup(action),
    run: (db: D1Database, admin: AdminUser) => runAdminReservationAction({ db, admin, action, env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "test" }, reservationId: "write_reservation", request: { idempotencyKey: "write_action", expectedVersion: 1 }, now, fetcher: async () => Response.json({ userId: "write_line_user" }) })
  })),
  { name: "service create", run: (db, admin) => createAdminService({ db, admin, request: service, now }) },
  { name: "service update", run: (db, admin) => updateAdminService({ db, admin, serviceId: "service_kyoto_default_60", request: service, now }) },
  { name: "service delete", run: (db, admin) => softDeleteAdminService({ db, admin, serviceId: "service_kyoto_default_60", now }) },
  { name: "resource create", run: (db, admin) => createAdminResource({ db, admin, request: resource, now }) },
  { name: "resource update", run: (db, admin) => updateAdminResource({ db, admin, resourceId: "resource_kyoto_calendar", request: resource, now }) },
  { name: "resource delete", run: (db, admin) => softDeleteAdminResource({ db, admin, resourceId: "resource_kyoto_calendar", now }) },
  { name: "staff create", run: (db, admin) => createAdminStaff({ db, admin, request: staff, now }) },
  { name: "staff update", run: (db, admin) => updateAdminStaff({ db, admin, staffId: "write_staff", request: staff, now }) },
  { name: "staff delete", run: (db, admin) => softDeleteAdminStaff({ db, admin, staffId: "write_staff", now }) },
  { name: "closure create", run: (db, admin) => createAdminClosure({ db, admin, request: closure, now }) },
  { name: "closure update", run: (db, admin) => updateAdminClosure({ db, admin, closureId: "write_closure", request: closure, now }) },
  { name: "closure delete", run: (db, admin) => deleteAdminClosure({ db, admin, closureId: "write_closure" }) },
  { name: "booking window", run: (db, admin) => updateAdminBookingWindowSettings({ db, admin, request: { storeId: "kyoto", bookingWindowDays: 40 }, now }) },
  { name: "reservation cap", run: (db, admin) => updateAdminReservationCapSettings({ db, admin, request: { storeId: "kyoto", maxActiveReservationsPerCustomer: 2 }, now }) },
  { name: "customer notice", run: (db, admin) => updateAdminCustomerNoticeSettings({ db, admin, request: { storeId: "kyoto", customerNotice: "お知らせ" }, now }) },
  { name: "reminder", run: (db, admin) => updateAdminReminderSettings({ db, admin, request: { storeId: "kyoto", offsetMinutes: 60 }, now }) },
  { name: "google edit", run: (db, admin) => updateAdminGoogleEditMode({ db, admin, request: { storeId: "kyoto", enabled: true }, now }) },
  { name: "business hours", run: (db, actor) => putBusinessHours({ db, actor, storeId: "kyoto", hours: Array.from({ length: 7 }, (_, weekday) => ({ weekday, opensAt: "09:00", closesAt: "20:00", closed: false })) }) },
  { name: "store login upsert", run: (db, admin) => upsertStoreLogin({ db, admin, request: { storeId: "osaka", email: "new@example.com", role: "staff", idempotencyKey: "write_login" }, now }) },
  { name: "store login revoke", run: (db, admin) => revokeStoreLogin({ db, admin, storeId: "osaka", now }) }
];

const seed = (db: SqliteD1Database) => {
  insertAdminUser(db, { id: admin.id, email: admin.email, accessSubject: "write_actor_sub", role: admin.role, staffMemberId: admin.staff_member_id });
  db.sqlite.exec(`
    INSERT INTO customers (id, display_name, phone_hash, created_store_id) VALUES ('write_customer', '顧客', 'write_hash', 'kyoto'), ('write_target', '統合先', 'write_hash', 'kyoto');
    INSERT INTO staff_members (id, store_id, display_name, role) VALUES ('write_staff', 'kyoto', '対象', 'staff'), ('staff_login_osaka', 'osaka', '店舗', 'staff');
    INSERT INTO store_closures (id, store_id, starts_at, ends_at, source) VALUES ('write_closure', 'kyoto', '2029-01-01T00:00:00Z', '2029-01-02T00:00:00Z', 'admin');
  `);
  insertAdminUser(db, { id: "write_other", email: "other@example.com", accessSubject: "write_other_sub", role: "staff", staffMemberId: "write_staff" });
  insertAdminUser(db, { id: "write_login", email: "login@example.com", accessSubject: "write_login_sub", role: "staff", staffMemberId: "staff_login_osaka" });
};

const revocations = [
  ["disabled", "UPDATE admin_users SET active = 0 WHERE id = 'write_actor'"],
  ["deleted", "DELETE FROM admin_users WHERE id = 'write_actor'"],
  ["demoted", "UPDATE admin_users SET role = 'staff' WHERE id = 'write_actor'"],
  ["staff reassigned", "UPDATE admin_users SET staff_member_id = 'staff_owner_osaka' WHERE id = 'write_actor'"],
  ["store changed", "UPDATE staff_members SET store_id = 'osaka' WHERE id = 'staff_owner_kyoto'"]
] as const;

describe("admin write-time authorization", () => {
  for (const mutation of mutations) {
    it(`${mutation.name}: a current actor succeeds without an extra guard audit`, async () => {
      const db = createMigratedSqliteD1();
      try {
        seed(db);
        mutation.setup?.(db);
        const result = await mutation.run(db as unknown as D1Database, admin);
        expect(result.ok).toBe(true);
        expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'admin.write.guard'").get()).toEqual({ n: 0 });
      } finally { db.sqlite.close(); }
    });
    it(`${mutation.name}: restoring an actor after rejection keeps the old conflict and no writes`, async () => {
      const db = createMigratedSqliteD1();
      try {
        seed(db);
        mutation.setup?.(db);
        const before = snapshot(db);
        let rejected = false;
        const racing = {
          prepare: db.prepare.bind(db),
          batch: async (statements: D1PreparedStatement[]) => {
            db.sqlite.exec("UPDATE admin_users SET active = 0 WHERE id = 'write_actor'");
            try { return await db.batch(statements); }
            finally {
              rejected = true;
              db.sqlite.exec("UPDATE admin_users SET active = 1 WHERE id = 'write_actor'");
            }
          }
        } as unknown as D1Database;
        const result = await mutation.run(racing, admin);
        expect(rejected).toBe(true);
        expect(result.ok).toBe(false);
        expect(result.error ?? result.reason).not.toBe("forbidden");
        expect(snapshot(db)).toEqual(before);
      } finally { db.sqlite.close(); }
    });
    it.each(revocations)(`${mutation.name}: %s before the batch leaves every table unchanged`, async (_name, revoke) => {
      const db = createMigratedSqliteD1();
      try {
        seed(db);
        mutation.setup?.(db);
        let before: ReturnType<typeof snapshot> | undefined;
        const racing = {
          prepare: db.prepare.bind(db),
          batch: (statements: D1PreparedStatement[]) => {
            db.sqlite.exec(revoke);
            before = snapshot(db);
            return db.batch(statements);
          }
        } as unknown as D1Database;
        const result = await mutation.run(racing, admin);
        expect(before, "must reach the real mutation batch").toBeDefined();
        expect(result.ok).toBe(false);
        expect(result.error ?? result.reason).toBe("forbidden");
        expect(snapshot(db)).toEqual(before);
      } finally { db.sqlite.close(); }
    });
  }
  for (const action of ["create", "update-escalation", "update-protected", "update-self", "delete"] as const) {
    it.each([false, true])(`staff ${action}: denied escalation audit respects current actor (revoked=%s)`, async revoked => {
      const db = createMigratedSqliteD1();
      try {
        seed(db);
        const actor = action === "update-self" ? { ...admin, role: "system_admin" as const } : admin;
        db.sqlite.prepare("UPDATE admin_users SET role = ? WHERE id = ?").run(actor.role, actor.id);
        db.sqlite.exec("UPDATE staff_members SET role = 'system_admin' WHERE id = 'write_staff'");
        if (revoked) db.sqlite.exec("UPDATE admin_users SET active = 0 WHERE id = 'write_actor'");
        const before = snapshot(db);
        const common = { db: db as unknown as D1Database, admin: actor, now };
        const result = action === "create" ? await createAdminStaff({ ...common, request: { ...staff, role: "system_admin" } })
          : action === "delete" ? await softDeleteAdminStaff({ ...common, staffId: "write_staff" })
            : await updateAdminStaff({ ...common,
              staffId: action === "update-self" ? "staff_owner_kyoto" : "write_staff",
              request: action === "update-protected" ? staff : { ...staff, role: "system_admin", active: true }
            });
        expect(result).toEqual({ ok: false, error: "forbidden_role_escalation" });
        expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'settings.staff.forbidden_role_escalation'").get()).toEqual({ n: revoked ? 0 : 1 });
        if (revoked) expect(snapshot(db)).toEqual(before);
      } finally { db.sqlite.close(); }
    });
  }
  it("allows the acting store owner to retain their own current role", async () => {
    const db = createMigratedSqliteD1();
    try {
      seed(db);
      db.sqlite.exec("UPDATE admin_users SET role = 'owner' WHERE id = 'write_login'");
      const actor: AdminUser = { id: "write_login", email: "login@example.com", role: "owner", staff_member_id: "staff_login_osaka", store_id: "osaka" };
      const result = await upsertStoreLogin({ db: db as unknown as D1Database, admin: actor,
        request: { storeId: "osaka", email: actor.email, role: "owner", idempotencyKey: "self-role-keep" }, now });
      expect(result).toEqual({ ok: true, storeId: "osaka", replayed: false });
      expect(db.sqlite.prepare("SELECT role, active FROM admin_users WHERE id = ?").get(actor.id)).toEqual({ role: "owner", active: 1 });
    } finally { db.sqlite.close(); }
  });
  it("rejects a missing actor without a test-only authorization bypass", async () => {
    const db = createMigratedSqliteD1();
    try {
      seed(db);
      db.sqlite.prepare("DELETE FROM admin_users WHERE id = ?").run(admin.id);
      const before = snapshot(db);
      const result = await mutations[0].run(db as unknown as D1Database, admin);
      expect(result).toEqual({ ok: false, reason: "forbidden" });
      expect(snapshot(db)).toEqual(before);
    } finally { db.sqlite.close(); }
  });
});
