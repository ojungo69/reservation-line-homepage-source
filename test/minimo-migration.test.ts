import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteD1Database } from "./helpers/sqlite-d1";

const migrationPath = join(process.cwd(), "migrations/0061_minimo_four_store_sync.sql");
let sqlite: DatabaseSync;

const migrate = () => {
  sqlite.exec("BEGIN");
  try {
    sqlite.exec(readFileSync(migrationPath, "utf8"));
    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  }
};

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const name of readdirSync(join(process.cwd(), "migrations")).filter((name) => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 60).sort()) {
    sqlite.exec(readFileSync(join(process.cwd(), "migrations", name), "utf8"));
  }
  sqlite.exec(readFileSync(join(process.cwd(), "seeds/dev.sql"), "utf8"));
  sqlite.exec(`
    INSERT INTO external_blocks (id,store_id,resource_id,source,title_snapshot,start_at,end_at,status,google_event_id,google_event_etag,created_by,created_at,updated_at)
    VALUES ('legacy_google','kyoto','resource_kyoto_calendar','google_calendar','Legacy Google','2030-01-01T00:00:00Z','2030-01-01T01:00:00Z','active','event_google','etag','actor','2026-01-01','2026-01-02'),
           ('legacy_admin','kyoto','resource_kyoto_calendar','admin_block','Legacy admin','2030-01-01T01:00:00Z','2030-01-01T02:00:00Z','cancelled','event_admin',NULL,NULL,'2026-01-01','2026-01-02'),
           ('legacy_revert','kyoto','resource_kyoto_calendar','system_revert',NULL,'2030-01-01T02:00:00Z','2030-01-01T03:00:00Z','active',NULL,NULL,NULL,'2026-01-01','2026-01-02');
    INSERT INTO google_calendar_events (id,store_id,calendar_id,google_event_id,external_block_id,source_type,status,google_etag,google_safe_snapshot_json)
    VALUES ('ledger_google','kyoto','calendar','event_google','legacy_google','external_block','active','etag','{}'),
           ('ledger_admin','kyoto','calendar','event_admin','legacy_admin','external_block','deleted',NULL,'{}'),
           ('ledger_unknown','kyoto','calendar','event_unknown',NULL,'unknown','ignored',NULL,'{}');
    INSERT INTO google_calendar_conflicts (id,store_id,calendar_id,google_event_id,external_block_id,conflict_type,google_safe_snapshot_json,resolution_status)
    VALUES ('conflict_google','kyoto','calendar','event_google','legacy_google','external_block_event_deleted','{}','open'),
           ('conflict_admin','kyoto','calendar','event_admin','legacy_admin','external_block_event_deleted','{}','manual_resolved'),
           ('conflict_unknown','kyoto','calendar','event_unknown',NULL,'unknown','{}','ignored');
    INSERT INTO slot_locks (id,store_id,resource_id,slot_at,owner_type,owner_id,lock_status)
    VALUES ('legacy_lock','kyoto','resource_kyoto_calendar','2030-01-01T00:00:00Z','external_block','legacy_google','confirmed');
  `);
});
afterEach(() => sqlite.close());

const insertMinimo = (id: string, store = "kyoto", bookingId: string | null = "booking", staffId: string | null = "staff") =>
  sqlite.prepare(`INSERT INTO external_blocks (id,store_id,resource_id,source,start_at,end_at,status,minimo_reservation_id,minimo_staff_id)
    VALUES (?,?,?,'minimo','2030-01-01T00:00:00Z','2030-01-01T01:00:00Z','active',?,?)`)
    .run(id, store, `resource_${store}_calendar`, bookingId, staffId);

describe("0061 Minimo migration from populated pre-Minimo data", () => {
  it.each([0, 1])("preserves linked all-day closures without cancellation and retains both cancellation directions (recursive=%i)", (recursive) => {
    sqlite.exec(`PRAGMA recursive_triggers = ${recursive}`);
    sqlite.exec(`
      INSERT INTO external_blocks (id,store_id,resource_id,source,start_at,end_at,status)
      VALUES ('linked_delete','kyoto','resource_kyoto_calendar','admin_block','2031-01-01T00:00:00Z','2031-01-01T01:00:00Z','active'),
             ('linked_cancel','kyoto','resource_kyoto_calendar','admin_block','2031-01-02T00:00:00Z','2031-01-02T01:00:00Z','active');
      INSERT INTO store_closures (id,store_id,starts_at,ends_at,source,external_block_id)
      VALUES ('closure_delete','kyoto','2031-01-01T00:00:00Z','2031-01-01T01:00:00Z','admin','linked_delete'),
             ('closure_cancel','kyoto','2031-01-02T00:00:00Z','2031-01-02T01:00:00Z','admin','linked_cancel'),
             ('legacy_unlinked','kyoto','2031-01-03T00:00:00Z','2031-01-03T01:00:00Z','admin',NULL);
      INSERT INTO slot_locks (id,store_id,resource_id,slot_at,owner_type,owner_id,lock_status)
      VALUES ('linked_delete_lock','kyoto','resource_kyoto_calendar','2031-01-01T00:00:00Z','external_block','linked_delete','confirmed'),
             ('linked_cancel_lock','kyoto','resource_kyoto_calendar','2031-01-02T00:00:00Z','external_block','linked_cancel','confirmed');
      INSERT INTO calendar_sync_jobs (id,dedupe_key,owner_type,owner_id,google_action,status)
      VALUES ('linked_delete_job','linked_delete_job','external_block','linked_delete','upsert','queued'),
             ('linked_cancel_job','linked_cancel_job','external_block','linked_cancel','upsert','queued');
    `);
    const tables = ["store_closures", "external_blocks", "slot_locks", "slot_lock_history", "calendar_sync_jobs", "audit_logs",
      "google_calendar_events", "google_calendar_conflicts"];
    const before = Object.fromEntries(tables.map(table => [table, sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
    const schema = sqlite.prepare(`SELECT type,name,sql FROM sqlite_schema
      WHERE tbl_name IN ('external_blocks','store_closures') AND type IN ('index','trigger') ORDER BY name`).all();
    const foreignKeys = sqlite.prepare("PRAGMA foreign_key_list(store_closures)").all();
    migrate();
    sqlite.exec(readFileSync(join(process.cwd(), "migrations/0062_minimo_recovery_state.sql"), "utf8"));
    sqlite.exec(readFileSync(join(process.cwd(), "migrations/0063_minimo_phase_state.sql"), "utf8"));
    for (const table of tables) {
      expect(sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).toEqual(table === "external_blocks"
        ? before[table].map(row => ({ ...row, minimo_reservation_id: null, minimo_staff_id: null })) : before[table]);
    }
    expect(sqlite.prepare(`SELECT type,name,sql FROM sqlite_schema
      WHERE tbl_name IN ('external_blocks','store_closures') AND type IN ('index','trigger') ORDER BY name`).all())
      .toEqual(expect.arrayContaining(schema));
    expect(sqlite.prepare("PRAGMA foreign_key_list(store_closures)").all()).toEqual(foreignKeys);
    expect(() => sqlite.exec("DELETE FROM external_blocks WHERE id='linked_delete'")).toThrow(/FOREIGN KEY constraint/);
    expect(() => sqlite.exec("UPDATE store_closures SET store_id='osaka' WHERE id='closure_delete'"))
      .toThrow("linked_closure_block_mismatch");
    expect(() => sqlite.exec("UPDATE external_blocks SET source='system_revert' WHERE id='linked_delete'"))
      .toThrow("linked_closure_block_mismatch");
    expect(() => sqlite.exec("UPDATE store_closures SET external_block_id='linked_delete' WHERE id='legacy_unlinked'"))
      .toThrow(/UNIQUE constraint/);
    sqlite.exec("DELETE FROM store_closures WHERE id='closure_delete'");
    sqlite.exec("UPDATE external_blocks SET status='cancelled' WHERE id='linked_cancel'");
    for (const id of ["linked_delete", "linked_cancel"]) {
      expect(sqlite.prepare("SELECT status FROM external_blocks WHERE id=?").get(id)).toEqual({ status: "cancelled" });
      expect(sqlite.prepare("SELECT id FROM store_closures WHERE external_block_id=?").all(id)).toEqual([]);
      expect(sqlite.prepare("SELECT id FROM slot_locks WHERE owner_id=?").all(id)).toEqual([]);
      expect(sqlite.prepare("SELECT google_action,status FROM calendar_sync_jobs WHERE owner_id=? ORDER BY google_action").all(id))
        .toEqual([{ google_action: "delete", status: "queued" }, { google_action: "upsert", status: "succeeded" }]);
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM slot_lock_history WHERE old_owner_id=? AND action='released'").get(id)).toEqual({ n: 1 });
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE target_id=? AND action='all_day_linked_block_cancelled'").get(id)).toEqual({ n: 1 });
    }
    expect(sqlite.prepare("SELECT external_block_id FROM store_closures WHERE id='legacy_unlinked'").get()).toEqual({ external_block_id: null });
    expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(sqlite.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(sqlite.prepare("SELECT name FROM sqlite_schema WHERE name LIKE '_0061_%'").all()).toEqual([]);
  });

  it("upgrades existing sync state without shortening cooldown or changing owned slots and imports", () => {
    migrate();
    insertMinimo("existing-minimo");
    sqlite.exec(`INSERT INTO minimo_sync_state (store_id,config_hash,next_attempt_at,next_date,last_success_at,last_error)
      VALUES ('kyoto','hash','2030-01-01','2026-10-20','2026-09-29','forbidden');
      INSERT INTO minimo_schedule_state (store_id,date,snapshot_json,owned_json,status,updated_at)
      VALUES ('kyoto','2026-10-20','{}','{}','pending','2026-09-29')`);
    const imports = sqlite.prepare("SELECT * FROM external_blocks ORDER BY id").all();
    const owned = sqlite.prepare("SELECT * FROM minimo_schedule_state").all();
    sqlite.exec(readFileSync(join(process.cwd(), "migrations/0062_minimo_recovery_state.sql"), "utf8"));
    expect(sqlite.prepare("SELECT next_attempt_at,next_date,last_success_at,sweep_mode,sweep_error,last_preview_at,paused_reason FROM minimo_sync_state").get())
      .toEqual({ next_attempt_at: "2030-01-01", next_date: null, last_success_at: null,
        sweep_mode: null, sweep_error: null, last_preview_at: null, paused_reason: "forbidden" });
    expect(sqlite.prepare("SELECT * FROM external_blocks ORDER BY id").all()).toEqual(imports);
    expect(sqlite.prepare("SELECT * FROM minimo_schedule_state").all()).toEqual(owned);
    expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("separates phase cadence while preserving failures, rate limits and established health in 0063", () => {
    migrate();
    sqlite.exec(readFileSync(join(process.cwd(), "migrations/0062_minimo_recovery_state.sql"), "utf8"));
    sqlite.exec(`INSERT INTO minimo_sync_state
      (store_id,config_hash,next_attempt_at,last_success_at,last_error,consecutive_failures,sweep_mode,next_date)
      VALUES ('kyoto','hash','2030-01-01','2026-09-29',NULL,0,'apply','2026-10-01'),
      ('osaka','hash','2030-01-02','2026-09-29','rate_limited',1,'apply','2026-10-01'),
      ('nagoya','hash','2030-01-03','2026-09-29','forbidden',1,'apply','2026-10-01')`);
    sqlite.exec(readFileSync(join(process.cwd(), "migrations/0063_minimo_phase_state.sql"), "utf8"));
    expect(sqlite.prepare(`SELECT store_id,next_attempt_at,next_outbound_at,rate_limited_until,
      next_inbound_at,next_inbound_id,last_success_at,next_date FROM minimo_sync_state ORDER BY store_id`).all())
      .toEqual([
        { store_id: "kyoto", next_attempt_at: "1970-01-01T00:00:00.000Z", next_outbound_at: "2030-01-01", rate_limited_until: null,
          next_inbound_at: "1970-01-01T00:00:00.000Z", next_inbound_id: null, last_success_at: "2026-09-29", next_date: "2026-10-01" },
        { store_id: "nagoya", next_attempt_at: "2030-01-03", next_outbound_at: "2030-01-03", rate_limited_until: null,
          next_inbound_at: "1970-01-01T00:00:00.000Z", next_inbound_id: null, last_success_at: "2026-09-29", next_date: "2026-10-01" },
        { store_id: "osaka", next_attempt_at: "2030-01-02", next_outbound_at: "2030-01-02", rate_limited_until: "2030-01-02",
          next_inbound_at: "1970-01-01T00:00:00.000Z", next_inbound_id: null, last_success_at: "2026-09-29", next_date: "2026-10-01" }
      ]);
    expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("preserves legacy blocks, both Google references, locks, indexes and store guards", () => {
    const blocks = sqlite.prepare("SELECT * FROM external_blocks ORDER BY id").all();
    const events = sqlite.prepare("SELECT * FROM google_calendar_events ORDER BY id").all();
    const conflicts = sqlite.prepare("SELECT * FROM google_calendar_conflicts ORDER BY id").all();
    const locks = sqlite.prepare("SELECT * FROM slot_locks ORDER BY id").all();
    const indexesAndTriggers = sqlite.prepare("SELECT type,name,sql FROM sqlite_schema WHERE tbl_name='external_blocks' AND type IN ('index','trigger') ORDER BY name").all();
    const eventForeignKeys = sqlite.prepare("PRAGMA foreign_key_list(google_calendar_events)").all();
    const conflictForeignKeys = sqlite.prepare("PRAGMA foreign_key_list(google_calendar_conflicts)").all();
    migrate();
    expect(sqlite.prepare("SELECT * FROM external_blocks ORDER BY id").all()).toEqual(
      blocks.map((block) => ({ ...block, minimo_reservation_id: null, minimo_staff_id: null }))
    );
    expect(sqlite.prepare("SELECT * FROM google_calendar_events ORDER BY id").all()).toEqual(events);
    expect(sqlite.prepare("SELECT * FROM google_calendar_conflicts ORDER BY id").all()).toEqual(conflicts);
    expect(sqlite.prepare("SELECT * FROM slot_locks ORDER BY id").all()).toEqual(locks);
    expect(sqlite.prepare("SELECT type,name,sql FROM sqlite_schema WHERE tbl_name='external_blocks' AND type IN ('index','trigger') ORDER BY name").all()).toEqual(expect.arrayContaining(indexesAndTriggers));
    expect(sqlite.prepare("PRAGMA foreign_key_list(google_calendar_events)").all()).toEqual(eventForeignKeys);
    expect(sqlite.prepare("PRAGMA foreign_key_list(google_calendar_conflicts)").all()).toEqual(conflictForeignKeys);
    expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(sqlite.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(sqlite.prepare("SELECT name FROM sqlite_schema WHERE name LIKE '_0061_%'").all()).toEqual([]);
  });

  it("persists store-scoped sync and schedule state and cascades an isolated store deletion", () => {
    migrate();
    sqlite.exec(`
      INSERT INTO stores (id,name) VALUES ('state_only','State only');
      INSERT INTO minimo_sync_state (store_id,config_hash,session_ciphertext,session_expires_at,next_attempt_at,next_date,last_attempt_at,last_success_at,last_error)
      VALUES ('state_only','connection_hash','encrypted_session','2030-01-01','2029-12-31','2030-01-02','2029-12-30','2029-12-29','safe_reason');
      INSERT INTO minimo_schedule_state (store_id,date,snapshot_json,owned_json,status,updated_at)
      VALUES ('state_only','2030-01-02','[]','[]','verified','2029-12-30');
    `);
    expect(sqlite.prepare("SELECT * FROM minimo_sync_state").get()).toEqual({
      store_id: "state_only", config_hash: "connection_hash", session_ciphertext: "encrypted_session",
      session_expires_at: "2030-01-01", next_attempt_at: "2029-12-31", next_date: "2030-01-02",
      last_attempt_at: "2029-12-30", last_success_at: "2029-12-29", last_error: "safe_reason", consecutive_failures: 0
    });
    expect(sqlite.prepare("SELECT * FROM minimo_schedule_state").get()).toEqual({
      store_id: "state_only", date: "2030-01-02", snapshot_json: "[]", owned_json: "[]", status: "verified", updated_at: "2029-12-30"
    });
    sqlite.exec("DELETE FROM stores WHERE id='state_only'");
    expect(sqlite.prepare("SELECT * FROM minimo_sync_state").all()).toEqual([]);
    expect(sqlite.prepare("SELECT * FROM minimo_schedule_state").all()).toEqual([]);
  });

  it("accepts identical Minimo IDs across all four stores and rejects a same-store duplicate", () => {
    migrate();
    for (const store of ["kyoto", "osaka", "nagoya", "wakayama"]) insertMinimo(`minimo_${store}`, store);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM external_blocks WHERE source='minimo'").get()).toEqual({ count: 4 });
    expect(() => insertMinimo("duplicate")).toThrow(/UNIQUE constraint/);
    expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it.each([
    [null, "staff"], ["booking", null], ["", "staff"], [" ", "staff"],
    ["booking", ""], ["r".repeat(129), "staff"], ["booking", "s".repeat(129)]
  ])("rejects missing, blank or oversized Minimo IDs %j / %j", (bookingId, staffId) => {
    migrate();
    expect(() => insertMinimo("invalid", "kyoto", bookingId, staffId)).toThrow(/CHECK constraint/);
  });

  it.each(["legacy_google", "legacy_admin", "legacy_revert"])("rejects Minimo IDs on non-Minimo block %s", (id) => {
    migrate();
    expect(() => sqlite.prepare("UPDATE external_blocks SET minimo_reservation_id='booking',minimo_staff_id='staff' WHERE id=?").run(id)).toThrow(/CHECK constraint/);
  });

  it.each([
    "UPDATE external_blocks SET source='unknown' WHERE id='legacy_admin'",
    "UPDATE external_blocks SET status='unknown' WHERE id='legacy_admin'",
    "UPDATE external_blocks SET start_at=end_at WHERE id='legacy_admin'",
    "UPDATE external_blocks SET google_event_id=NULL WHERE id='legacy_google'",
    `UPDATE external_blocks SET google_event_id='${"e".repeat(1025)}' WHERE id='legacy_admin'`,
    `UPDATE external_blocks SET google_event_etag='${"e".repeat(513)}' WHERE id='legacy_admin'`
  ])("retains original source, status, time and Google field checks (%#)", (sql) => {
    migrate();
    expect(() => sqlite.exec(sql)).toThrow(/CHECK constraint/);
  });

  it.each([
    "UPDATE external_blocks SET resource_id='resource_osaka_calendar' WHERE id='legacy_admin'",
    "UPDATE external_blocks SET store_id='osaka' WHERE id='legacy_admin'",
    `INSERT INTO external_blocks (id,store_id,resource_id,source,start_at,end_at,status,minimo_reservation_id,minimo_staff_id)
     VALUES ('cross_store','kyoto','resource_osaka_calendar','minimo','2030-01-01','2030-01-02','active','booking','staff')`
  ])("retains cross-store block insert and update guards (%#)", (sql) => {
    migrate();
    expect(() => sqlite.exec(sql)).toThrow("store_reference_mismatch");
  });

  it("retains RESTRICT and SET NULL behavior for the restored references", () => {
    migrate();
    expect(() => sqlite.exec("DELETE FROM external_blocks WHERE id='legacy_google'")).toThrow(/FOREIGN KEY constraint/);
    sqlite.exec("DELETE FROM google_calendar_events WHERE id='ledger_google'; DELETE FROM external_blocks WHERE id='legacy_google'");
    expect(sqlite.prepare("SELECT external_block_id FROM google_calendar_conflicts WHERE id='conflict_google'").get()).toEqual({ external_block_id: null });
    expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("rejects invalid ownership state atomically and negative failure counters", async () => {
    migrate();
    const db = new SqliteD1Database(sqlite);
    await expect(db.batch([
      db.prepare("UPDATE external_blocks SET status='cancelled' WHERE id='legacy_google'"),
      db.prepare("INSERT INTO minimo_schedule_state VALUES ('kyoto','2030-01-01','[]','[]','unknown','2026-01-01')")
    ])).rejects.toThrow(/CHECK constraint/);
    expect(sqlite.prepare("SELECT status FROM external_blocks WHERE id='legacy_google'").get()).toEqual({ status: "active" });
    expect(sqlite.prepare("SELECT * FROM minimo_schedule_state").all()).toEqual([]);
    expect(() => sqlite.exec("INSERT INTO minimo_sync_state (store_id,config_hash,next_attempt_at,consecutive_failures) VALUES ('kyoto','hash','2030-01-01',-1)")).toThrow(/CHECK constraint/);
    expect(() => sqlite.exec("INSERT INTO minimo_sync_state (store_id,config_hash,next_attempt_at) VALUES ('missing','hash','2030-01-01')")).toThrow(/FOREIGN KEY constraint/);
  });
});
