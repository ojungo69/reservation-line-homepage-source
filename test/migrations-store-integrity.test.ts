import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteD1Database } from "./helpers/sqlite-d1";

const migrationPath = join(process.cwd(), "migrations/0056_store_reference_integrity.sql");
let sqlite: DatabaseSync;
const reservation = (id: string, store = "kyoto", service = "service_kyoto_default_60", resource = "resource_kyoto_calendar") =>
  `INSERT INTO reservations (id,store_id,service_id,resource_id,customer_id,source,status,start_at,end_at,duration_minutes,idempotency_key)
   VALUES ('${id}','${store}','${service}','${resource}','integrity_customer','admin','confirmed','2030-01-01T00:00:00Z','2030-01-01T01:00:00Z',60,'${id}')`;
const junction = (id: string, service = "service_kyoto_default_60") =>
  `INSERT INTO reservation_services (reservation_id,service_id,display_order,name_snapshot,duration_minutes) VALUES ('${id}','${service}',0,'Menu',60)`;
const lock = (id: string, store = "kyoto", resource = "resource_kyoto_calendar") =>
  `INSERT INTO slot_locks (id,store_id,resource_id,slot_at,owner_type,owner_id,lock_status) VALUES ('${id}','${store}','${resource}','2030-01-01T00:00:00Z','reservation','with_menu','confirmed')`;
const block = (id: string, store = "kyoto", resource = "resource_kyoto_calendar") =>
  `INSERT INTO external_blocks (id,store_id,resource_id,source,start_at,end_at,status) VALUES ('${id}','${store}','${resource}','admin_block','2030-01-01T02:00:00Z','2030-01-01T03:00:00Z','active')`;

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  for (const name of readdirSync(join(process.cwd(), "migrations")).filter((name) => /^00[0-5]\d_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 55).sort()) {
    sqlite.exec(readFileSync(join(process.cwd(), "migrations", name), "utf8"));
  }
  sqlite.exec(readFileSync(join(process.cwd(), "seeds/dev.sql"), "utf8"));
  sqlite.exec("INSERT INTO customers (id,display_name) VALUES ('integrity_customer','Customer')");
  sqlite.exec(reservation("with_menu"));
  sqlite.exec(junction("with_menu"));
  sqlite.exec(reservation("legacy"));
  sqlite.exec(reservation("other_store", "osaka", "service_osaka_default_60", "resource_osaka_calendar"));
  sqlite.exec(lock("existing_lock"));
  sqlite.exec(block("existing_block"));
});
afterEach(() => sqlite.close());

describe("0055 data upgraded with 0056 store reference integrity", () => {
  it("reports all six historical mismatches without changing the database", () => {
    sqlite.exec("UPDATE reservations SET service_id='service_osaka_default_60',resource_id='resource_osaka_calendar' WHERE id='with_menu'");
    sqlite.exec("UPDATE slot_locks SET resource_id='resource_osaka_calendar'");
    sqlite.exec("UPDATE external_blocks SET resource_id='resource_osaka_calendar'");
    sqlite.exec("UPDATE reservation_services SET service_id='service_osaka_default_60'");
    sqlite.exec("UPDATE service_stores SET store_id='osaka' WHERE service_id='service_kyoto_default_60'");
    const preflight = readFileSync(join(process.cwd(), "scripts/check-store-integrity.sql"), "utf8");
    const before = sqlite.prepare("SELECT total_changes() AS count").get();
    const result = sqlite.prepare(preflight).get() as Record<string, number>;
    expect(Object.values(result)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(sqlite.prepare("SELECT total_changes() AS count").get()).toEqual(before);
    expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("preserves data, existing indexes and constraints on upgrade", () => {
    const before = sqlite.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const rows = sqlite.prepare("SELECT * FROM reservations ORDER BY id").all();
    sqlite.exec(readFileSync(migrationPath, "utf8"));
    expect(sqlite.prepare("SELECT * FROM reservations ORDER BY id").all()).toEqual(rows);
    const after = sqlite.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
    expect(after).toEqual(expect.arrayContaining(before));
    expect(after.length - before.length).toBe(12);
    expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(sqlite.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  it.each([
    ["reservation service insert", reservation("bad", "kyoto", "service_osaka_default_60")],
    ["reservation resource insert", reservation("bad", "kyoto", "service_kyoto_default_60", "resource_osaka_calendar")],
    ["reservation service update", "UPDATE reservations SET service_id='service_osaka_default_60' WHERE id='legacy'"],
    ["reservation resource update", "UPDATE reservations SET resource_id='resource_osaka_calendar' WHERE id='legacy'"],
    ["reservation store update", "UPDATE reservations SET store_id='osaka' WHERE id='legacy'"],
    ["reservation parent of junction update", "UPDATE reservations SET store_id='osaka',service_id='service_osaka_default_60',resource_id='resource_osaka_calendar' WHERE id='with_menu'"],
    ["slot insert", lock("bad", "kyoto", "resource_osaka_calendar")],
    ["slot resource update", "UPDATE slot_locks SET resource_id='resource_osaka_calendar' WHERE id='existing_lock'"],
    ["slot store update", "UPDATE slot_locks SET store_id='osaka' WHERE id='existing_lock'"],
    ["block insert", block("bad", "kyoto", "resource_osaka_calendar")],
    ["block resource update", "UPDATE external_blocks SET resource_id='resource_osaka_calendar' WHERE id='existing_block'"],
    ["block store update", "UPDATE external_blocks SET store_id='osaka' WHERE id='existing_block'"],
    ["junction insert", junction("legacy", "service_osaka_default_60")],
    ["junction service update", "UPDATE reservation_services SET service_id='service_osaka_default_60' WHERE reservation_id='with_menu'"],
    ["junction reservation update", "UPDATE reservation_services SET reservation_id='other_store' WHERE reservation_id='with_menu'"],
    ["service mapping insert", "INSERT INTO service_stores (service_id,store_id) VALUES ('service_kyoto_default_60','osaka')"],
    ["service mapping store update", "UPDATE service_stores SET store_id='osaka' WHERE service_id='service_kyoto_default_60'"],
    ["service mapping service update", "UPDATE service_stores SET service_id='service_osaka_default_60' WHERE service_id='service_kyoto_default_60'"],
    ["parent service update", "UPDATE services SET store_id='osaka' WHERE id='service_kyoto_default_60'"],
    ["parent resource update", "UPDATE store_resources SET store_id='osaka' WHERE id='resource_kyoto_calendar'"]
  ])("rejects cross-store %s", (_name, sql) => {
    sqlite.exec(readFileSync(migrationPath, "utf8"));
    expect(() => sqlite.exec(sql)).toThrow(/store_reference_mismatch|immutable_store/);
    expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("allows same-store writes, legacy missing junctions/mappings, and unrelated updates", () => {
    sqlite.exec(readFileSync(migrationPath, "utf8"));
    sqlite.exec("INSERT INTO services (id,store_id,name,duration_minutes) VALUES ('unmapped','kyoto','New',30)");
    sqlite.exec(reservation("new", "kyoto", "unmapped"));
    sqlite.exec(junction("new", "unmapped"));
    sqlite.exec("UPDATE services SET store_id='kyoto',name='Edited' WHERE id='unmapped'");
    sqlite.exec("UPDATE store_resources SET store_id='kyoto',name='Edited' WHERE id='resource_kyoto_calendar'");
    sqlite.exec("UPDATE reservations SET status='completed',google_event_etag='etag' WHERE id='legacy'");
    sqlite.exec("UPDATE external_blocks SET status='cancelled',google_event_etag='etag' WHERE id='existing_block'");
    sqlite.exec("UPDATE slot_locks SET lock_status='pending',expires_at=NULL WHERE id='existing_lock'");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM service_stores WHERE service_id='unmapped'").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM reservation_services WHERE reservation_id='legacy'").get()).toEqual({ count: 0 });
  });

  it("rolls back every statement in a failed D1-shaped batch", async () => {
    sqlite.exec(readFileSync(migrationPath, "utf8"));
    const db = new SqliteD1Database(sqlite);
    await expect(db.batch([
      db.prepare("UPDATE customers SET display_name='must rollback' WHERE id='integrity_customer'"),
      db.prepare(reservation("rollback")),
      db.prepare(junction("rollback", "service_osaka_default_60"))
    ])).rejects.toThrow("store_reference_mismatch");
    expect(sqlite.prepare("SELECT display_name FROM customers WHERE id='integrity_customer'").get()).toEqual({ display_name: "Customer" });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM reservations WHERE id='rollback'").get()).toEqual({ count: 0 });
  });
});
