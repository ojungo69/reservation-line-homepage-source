import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { expect, it } from "vitest";
import { claimStoreLease, fencedBatch } from "../src/minimo/state";
import { applyInboundDay } from "../src/minimo/inbound";

it("atomically preserves paired closures, references and both cancellation directions on native D1", async () => {
  const { DB: db, MINIMO_TEST_MIGRATIONS: migrations } = env as unknown as { DB: D1Database; MINIMO_TEST_MIGRATIONS: D1Migration[] };
  await applyD1Migrations(db, migrations.filter(migration => migration.name < "0061"));
  await db.batch([
    db.prepare("INSERT INTO stores (id,name) VALUES ('kyoto','Synthetic Kyoto'),('osaka','Synthetic Osaka')"),
    db.prepare("INSERT INTO store_resources (id,store_id,name) VALUES ('linked_resource','kyoto','Synthetic resource')"),
    db.prepare(`INSERT INTO external_blocks (id,store_id,resource_id,source,start_at,end_at,status)
      VALUES ('linked_delete','kyoto','linked_resource','admin_block','2031-01-01T00:00:00Z','2031-01-01T01:00:00Z','active'),
             ('linked_cancel','kyoto','linked_resource','admin_block','2031-01-02T00:00:00Z','2031-01-02T01:00:00Z','active')`),
    db.prepare(`INSERT INTO store_closures (id,store_id,starts_at,ends_at,source,external_block_id)
      VALUES ('closure_delete','kyoto','2031-01-01T00:00:00Z','2031-01-01T01:00:00Z','admin','linked_delete'),
             ('closure_cancel','kyoto','2031-01-02T00:00:00Z','2031-01-02T01:00:00Z','admin','linked_cancel'),
             ('legacy_unlinked','kyoto','2031-01-03T00:00:00Z','2031-01-03T01:00:00Z','admin',NULL)`),
    db.prepare(`INSERT INTO slot_locks (id,store_id,resource_id,slot_at,owner_type,owner_id,lock_status)
      VALUES ('delete_lock','kyoto','linked_resource','2031-01-01T00:00:00Z','external_block','linked_delete','confirmed'),
             ('cancel_lock','kyoto','linked_resource','2031-01-02T00:00:00Z','external_block','linked_cancel','confirmed')`),
    db.prepare(`INSERT INTO calendar_sync_jobs (id,dedupe_key,owner_type,owner_id,google_action,status)
      VALUES ('delete_job','delete_job','external_block','linked_delete','upsert','queued'),
             ('cancel_job','cancel_job','external_block','linked_cancel','upsert','retryable')`),
    db.prepare(`INSERT INTO google_calendar_events (id,store_id,calendar_id,google_event_id,external_block_id,source_type,status,google_safe_snapshot_json)
      VALUES ('worker-ledger','kyoto','calendar','worker-event','linked_delete','external_block','active','{}')`),
    db.prepare(`INSERT INTO google_calendar_conflicts (id,store_id,calendar_id,google_event_id,external_block_id,conflict_type,google_safe_snapshot_json,resolution_status)
      VALUES ('worker-conflict','kyoto','calendar','worker-event','linked_delete','external_block_event_deleted','{}','open')`),
    db.prepare(`CREATE TRIGGER unrelated_closure_fixture BEFORE UPDATE OF reason ON store_closures
      WHEN NEW.reason = 'reject_fixture' BEGIN SELECT RAISE(ABORT,'unrelated_fixture'); END`)
  ]);
  await db.batch([
    db.prepare(`INSERT INTO external_blocks (id,store_id,resource_id,source,start_at,end_at,status)
      SELECT id || '_recursive',store_id,resource_id,source,'2032-01-01T00:00:00Z','2032-01-01T01:00:00Z',status
      FROM external_blocks WHERE id IN ('linked_delete','linked_cancel')`),
    db.prepare(`INSERT INTO store_closures (id,store_id,starts_at,ends_at,source,external_block_id)
      SELECT id || '_recursive',store_id,starts_at,ends_at,source,external_block_id || '_recursive'
      FROM store_closures WHERE external_block_id IS NOT NULL`),
    db.prepare(`INSERT INTO slot_locks (id,store_id,resource_id,slot_at,owner_type,owner_id,lock_status)
      SELECT id || '_recursive',store_id,resource_id,replace(slot_at,'2031','2032'),owner_type,owner_id || '_recursive',lock_status
      FROM slot_locks`),
    db.prepare(`INSERT INTO calendar_sync_jobs (id,dedupe_key,owner_type,owner_id,google_action,status)
      SELECT id || '_recursive',dedupe_key || '_recursive',owner_type,owner_id || '_recursive',google_action,status
      FROM calendar_sync_jobs`)
  ]);
  const tables = ["store_closures", "external_blocks", "slot_locks", "slot_lock_history", "calendar_sync_jobs", "audit_logs",
    "google_calendar_events", "google_calendar_conflicts", "d1_migrations"];
  const before = new Map<string, Record<string, unknown>[]>();
  for (const table of tables) before.set(table, (await db.prepare(`SELECT * FROM ${table} ORDER BY id`).all<Record<string, unknown>>()).results);
  const schemaSql = "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name";
  const schema = (await db.prepare(schemaSql).all()).results;
  const closureSchema = (await db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE tbl_name='store_closures' ORDER BY name").all()).results;
  const foreignKeys = (await db.prepare("PRAGMA foreign_key_list(store_closures)").all()).results;
  const migration = migrations.find(item => item.name === "0061_minimo_four_store_sync.sql")!;
  const dropIndex = migration.queries.findIndex(query => /^DROP TABLE external_blocks;?$/.test(query.trim()));
  expect(dropIndex).toBeGreaterThan(0);
  const failing = { ...migration, queries: [...migration.queries] };
  failing.queries.splice(dropIndex + 1, 0, "INSERT INTO _0061_closure_links SELECT * FROM _0061_closure_links");
  for (const recursive of [0, 1]) {
    await db.prepare(`PRAGMA recursive_triggers = ${recursive}`).run();
    expect(await db.prepare("PRAGMA recursive_triggers").first()).toEqual({ recursive_triggers: recursive });
    await expect(applyD1Migrations(db, [failing])).rejects.toThrow("UNIQUE constraint failed: _0061_closure_links.id");
    expect((await db.prepare(schemaSql).all()).results).toEqual(schema);
    for (const table of tables) expect((await db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results).toEqual(before.get(table));
  }

  await applyD1Migrations(db, migrations.filter(item => item.name < "0062"));
  await db.prepare(`INSERT INTO minimo_sync_state (store_id,config_hash,next_attempt_at,next_date,last_error)
    VALUES ('kyoto','hash','2030-01-01','2026-10-20','challenge')`).run();
  await applyD1Migrations(db, migrations);
  expect(await db.prepare("SELECT next_attempt_at,next_date,sweep_mode,paused_reason FROM minimo_sync_state").first())
    .toEqual({ next_attempt_at: "2030-01-01", next_date: null, sweep_mode: null, paused_reason: "challenge" });
  expect(await db.prepare("SELECT next_outbound_at,next_inbound_at,next_inbound_id,rate_limited_until FROM minimo_sync_state").first())
    .toEqual({ next_outbound_at: "2030-01-01", next_inbound_at: "1970-01-01T00:00:00.000Z", next_inbound_id: null, rate_limited_until: null });
  for (const table of tables.filter(table => table !== "d1_migrations")) {
    expect((await db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results).toEqual(table === "external_blocks"
      ? before.get(table)!.map(row => ({ ...row, minimo_reservation_id: null, minimo_staff_id: null })) : before.get(table));
  }
  expect((await db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE tbl_name='store_closures' ORDER BY name").all()).results).toEqual(closureSchema);
  expect((await db.prepare("PRAGMA foreign_key_list(store_closures)").all()).results).toEqual(foreignKeys);
  await expect(db.prepare("UPDATE store_closures SET reason='reject_fixture' WHERE id='legacy_unlinked'").run()).rejects.toThrow("unrelated_fixture");
  await expect(db.prepare("DELETE FROM external_blocks WHERE id='linked_delete'").run()).rejects.toThrow();
  await expect(db.prepare("UPDATE store_closures SET store_id='osaka' WHERE id='closure_delete'").run()).rejects.toThrow("linked_closure_block_mismatch");
  await expect(db.prepare("UPDATE external_blocks SET source='system_revert' WHERE id='linked_delete'").run()).rejects.toThrow("linked_closure_block_mismatch");
  await expect(db.prepare("UPDATE store_closures SET external_block_id='linked_delete' WHERE id='legacy_unlinked'").run()).rejects.toThrow();
  for (const recursive of [0, 1]) {
    await db.prepare(`PRAGMA recursive_triggers = ${recursive}`).run();
    const suffix = recursive ? "_recursive" : "";
    await db.prepare("DELETE FROM store_closures WHERE id=?").bind(`closure_delete${suffix}`).run();
    await db.prepare("UPDATE external_blocks SET status='cancelled' WHERE id=?").bind(`linked_cancel${suffix}`).run();
    for (const id of [`linked_delete${suffix}`, `linked_cancel${suffix}`]) {
      expect(await db.prepare("SELECT status FROM external_blocks WHERE id=?").bind(id).first()).toEqual({ status: "cancelled" });
      expect((await db.prepare("SELECT id FROM store_closures WHERE external_block_id=?").bind(id).all()).results).toEqual([]);
      expect((await db.prepare("SELECT id FROM slot_locks WHERE owner_id=?").bind(id).all()).results).toEqual([]);
      expect((await db.prepare("SELECT google_action,status FROM calendar_sync_jobs WHERE owner_id=? ORDER BY google_action").bind(id).all()).results)
        .toEqual([{ google_action: "delete", status: "queued" }, { google_action: "upsert", status: "succeeded" }]);
      expect(await db.prepare("SELECT COUNT(*) AS n FROM slot_lock_history WHERE old_owner_id=? AND action='released'").bind(id).first()).toEqual({ n: 1 });
      expect(await db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE target_id=? AND action='all_day_linked_block_cancelled'").bind(id).first()).toEqual({ n: 1 });
    }
  }
  expect(await db.prepare("SELECT external_block_id FROM store_closures WHERE id='legacy_unlinked'").first()).toEqual({ external_block_id: null });
  const now = Date.parse("2026-09-29T00:00:00Z");
  const account = { storeId: "kyoto", salonId: "worker-salon", password: "synthetic", intervalMinutes: 30,
    staff: [{ rimaUserId: "artist", resourceId: "linked_resource", maxDurationMinutes: 90 }] };
  const lease = (await claimStoreLease(db, "kyoto", ["linked_resource"], now))!;
  const result = await applyInboundDay(db, account, { date: "2026-09-29", entries: [{ staffId: "artist", openSlots: [],
    reservations: [{ id: "worker-booking", staffId: "artist", status: "confirmed",
      startAt: "2026-09-29T01:00:00.000Z", endAt: "2026-09-29T02:30:00.000Z" }] }] }, lease, "apply", () => now);
  expect(result.imported).toBe(1);
  expect(await db.prepare("SELECT COUNT(*) AS n FROM slot_locks").first()).toEqual({ n: 18 });
  await claimStoreLease(db, "kyoto", ["linked_resource"], now + 91_000);
  await expect(fencedBatch(db, lease, [db.prepare("DELETE FROM slot_locks")], now + 91_000)).rejects.toThrow();
  expect(await db.prepare("SELECT COUNT(*) AS n FROM slot_locks").first()).toEqual({ n: 18 });
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  // D1 rejects integrity_check; the populated SQLite migration suite checks it.
  expect((await db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE '_0061_%'").all()).results).toEqual([]);
});
