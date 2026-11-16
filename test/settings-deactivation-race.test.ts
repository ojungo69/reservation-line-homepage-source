import { describe, expect, it } from "vitest";
import type { AdminUser } from "../src/admin/access";
import { updateAdminService } from "../src/admin/settings-services";
import { updateAdminResource } from "../src/admin/settings-resources";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const NOW = "2099-01-01T00:00:00.000Z";
const admin: AdminUser = {
  id: "settings_race_owner", email: "owner@example.test", role: "owner",
  staff_member_id: null, store_id: null
};

const fixture = () => {
  const db = createMigratedSqliteD1();
  db.sqlite.exec(`
    INSERT INTO stores (id, name, timezone) VALUES ('settings_race_store', 'Test store', 'Asia/Tokyo');
    INSERT INTO admin_users (id, email, access_subject, role, active, is_service_token)
      VALUES ('settings_race_owner', 'owner@example.test', 'settings-race-sub', 'owner', 1, 0);
    INSERT INTO services (id, store_id, name, duration_minutes, active)
      VALUES ('settings_race_service', 'settings_race_store', 'Original service', 60, 1);
    INSERT INTO store_resources (id, store_id, name, resource_type, active)
      VALUES ('settings_race_resource', 'settings_race_store', 'Original resource', 'staff_calendar', 1);
    INSERT INTO customers (id, display_name, phone_normalized, phone_hash)
      VALUES ('settings_race_customer', 'Synthetic customer', '09000000000', 'synthetic');
  `);
  return db;
};

const addFutureReservation = (db: SqliteD1Database) => {
  db.sqlite.exec(`
    INSERT INTO reservations (
      id, store_id, service_id, resource_id, customer_id, source, status,
      start_at, end_at, duration_minutes, idempotency_key
    ) VALUES (
      'settings_race_booking', 'settings_race_store', 'settings_race_service',
      'settings_race_resource', 'settings_race_customer', 'admin', 'confirmed',
      '2099-01-02T01:00:00.000Z', '2099-01-02T02:00:00.000Z', 60, 'settings-race-booking'
    );
  `);
};

const cases = [
  {
    name: "service", table: "services", id: "settings_race_service",
    update: (db: SqliteD1Database) => updateAdminService({
      db: db as unknown as D1Database, admin, serviceId: "settings_race_service",
      now: () => Date.parse(NOW),
      request: {
        storeId: "settings_race_store", name: "Edited", durationMinutes: 60,
        bufferBeforeMinutes: 0, bufferAfterMinutes: 0, active: false
      }
    })
  },
  {
    name: "resource", table: "store_resources", id: "settings_race_resource",
    update: (db: SqliteD1Database) => updateAdminResource({
      db: db as unknown as D1Database, admin, resourceId: "settings_race_resource",
      now: () => Date.parse(NOW),
      request: {
        storeId: "settings_race_store", name: "Edited", resourceType: "staff_calendar", active: false
      }
    })
  }
] as const;

describe.each(cases)("$name deactivation", ({ table, id, update }) => {
  it("rejects a stale inactive edit after reactivation and a future booking", async () => {
    const db = fixture();
    try {
      db.sqlite.prepare(`UPDATE ${table} SET active = 0 WHERE id = ?`).run(id);
      const originalBatch = db.batch.bind(db);
      db.batch = async (statements) => {
        db.sqlite.prepare(`UPDATE ${table} SET active = 1 WHERE id = ?`).run(id);
        addFutureReservation(db);
        return originalBatch(statements);
      };

      expect(await update(db)).toEqual({ ok: false, error: "has_future_reservations" });
      expect(db.sqlite.prepare(`SELECT active, name FROM ${table} WHERE id = ?`).get(id))
        .toMatchObject({ active: 1, name: table === "services" ? "Original service" : "Original resource" });
      expect(db.sqlite.prepare("SELECT status FROM reservations WHERE id = 'settings_race_booking'").get())
        .toMatchObject({ status: "confirmed" });
      expect(db.sqlite.prepare("SELECT count(*) AS n FROM audit_logs WHERE actor_id = ?").get(admin.id))
        .toMatchObject({ n: 0 });
    } finally {
      db.sqlite.close();
    }
  });

  it("still allows edits while an already inactive row has legacy future bookings", async () => {
    const db = fixture();
    try {
      db.sqlite.prepare(`UPDATE ${table} SET active = 0 WHERE id = ?`).run(id);
      addFutureReservation(db);
      expect(await update(db)).toMatchObject({ ok: true });
      expect(db.sqlite.prepare(`SELECT active, name FROM ${table} WHERE id = ?`).get(id))
        .toMatchObject({ active: 0, name: "Edited" });
    } finally {
      db.sqlite.close();
    }
  });
});
