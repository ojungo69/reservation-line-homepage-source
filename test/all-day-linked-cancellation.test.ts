import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approveAllDayAsClosure } from "../src/admin/conflict-resolutions";
import { cancelAdminExternalBlock } from "../src/admin/external-blocks";
import { deleteAdminClosure, updateAdminClosure } from "../src/admin/settings-closures";
import { createMigratedSqliteD1, SqliteD1Database } from "./helpers/sqlite-d1";

const admin = { id: "linked-owner", email: "linked@example.test", role: "owner" as const,
  staff_member_id: null, store_id: null };
const start = "2027-01-01T15:00:00.000Z";
const end = "2027-01-02T15:00:00.000Z";
const nowMs = Date.parse("2026-11-17T00:00:00.000Z");
const migration = "0060_all_day_closure_block_link.sql";

describe("linked all-day closure cancellation", () => {
  let db: SqliteD1Database;
  beforeEach(() => {
    db = createMigratedSqliteD1();
    db.sqlite.prepare("UPDATE stores SET google_calendar_id=? WHERE id='kyoto'").run("calendar-a@example.invalid");
    db.sqlite.exec("INSERT INTO admin_users(id,email,access_subject,role) VALUES ('linked-owner','linked@example.test','linked-sub','owner')");
  });
  afterEach(() => { db.sqlite.close(); vi.restoreAllMocks(); });

  const row = (sql: string, ...values: string[]) => db.sqlite.prepare(sql).get(...values) as Record<string, unknown> | undefined;
  const count = (table: string) => Number(row(`SELECT COUNT(*) AS n FROM ${table}`)?.n);
  const snapshot = () => ["store_closures", "external_blocks", "slot_locks", "slot_lock_history", "calendar_sync_jobs", "audit_logs"]
    .map((table) => db.sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
  const approve = async () => {
    db.sqlite.prepare(`INSERT INTO google_calendar_conflicts
      (id,store_id,calendar_id,google_event_id,conflict_type,google_safe_snapshot_json,resolution_status)
      VALUES ('linked-conflict','kyoto','calendar-a@example.invalid','linked-event','google_all_day_event',?,'open')`)
      .run(JSON.stringify({ start_at: start, end_at: end, summary: "Fixture closure" }));
    const result = await approveAllDayAsClosure({ db: db as unknown as D1Database, admin,
      conflictId: "linked-conflict", request: { idempotencyKey: "linked-approval" }, now: () => nowMs });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("fixture approval failed");
    const blockId = String(row("SELECT id FROM external_blocks")?.id);
    db.sqlite.prepare(`INSERT INTO slot_locks (id,store_id,resource_id,slot_at,owner_type,owner_id,lock_status)
      VALUES ('linked-lock','kyoto','resource_kyoto_calendar',?,'external_block',?,'confirmed')`).run(start, blockId);
    return { closureId: result.closureId, blockId };
  };
  const expectCancelled = (blockId: string) => {
    expect(count("store_closures")).toBe(0);
    expect(row("SELECT status,google_event_id FROM external_blocks WHERE id=?", blockId))
      .toMatchObject({ status: "cancelled", google_event_id: "linked-event" });
    expect(row("SELECT COUNT(*) AS n FROM slot_locks WHERE owner_type='external_block' AND owner_id=?", blockId)?.n).toBe(0);
    expect(row("SELECT COUNT(*) AS n FROM slot_lock_history WHERE old_owner_id=? AND action='released'", blockId)?.n).toBe(1);
    expect(row("SELECT COUNT(*) AS n FROM calendar_sync_jobs WHERE dedupe_key=?", `external_block:${blockId}:google:delete:cancelled`)?.n).toBe(1);
    expect(db.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  };

  it.each([
    { startsAt: "2027-01-02T15:00:00.000Z", endsAt: "2027-01-03T15:00:00.000Z" },
    { startsAt: "2027-01-01T16:00:00.000Z", endsAt: end },
    { startsAt: start, endsAt: "2027-01-03T15:00:00.000Z" },
    { startsAt: "2027-01-01T15:00:00.001Z", endsAt: end },
    { startsAt: start, endsAt: "2027-01-02T15:00:00.001Z" }
  ])("rejects a linked closure date edit without changing either record or side effects (%j)", async (dates) => {
    const { closureId } = await approve();
    const before = snapshot();
    expect(await updateAdminClosure({ db: db as unknown as D1Database, admin, closureId,
      request: { storeId: "kyoto", ...dates, reason: "移動" } }))
      .toEqual({ ok: false, error: "linked_closure_dates_immutable" });
    expect(snapshot()).toEqual(before);
  });

  it.each([false, true])("allows a linked reason-only edit for the same interval (alternate timestamp format=%s)", async (alternateFormat) => {
    const { closureId } = await approve();
    if (alternateFormat) {
      db.sqlite.prepare("UPDATE store_closures SET starts_at=?,ends_at=? WHERE id=?")
        .run("2027-01-02T00:00:00+09:00", "2027-01-03T00:00:00+09:00", closureId);
    }
    const before = snapshot();
    expect(await updateAdminClosure({ db: db as unknown as D1Database, admin, closureId,
      request: { storeId: "kyoto", startsAt: start, endsAt: end, reason: "理由のみ変更" } }))
      .toEqual({ ok: true, closureId });
    expect(row("SELECT starts_at,ends_at,reason FROM store_closures WHERE id=?", closureId))
      .toEqual({ starts_at: start, ends_at: end, reason: "理由のみ変更" });
    expect(snapshot().slice(1, 5)).toEqual(before.slice(1, 5));
    expect(row("SELECT COUNT(*) AS n FROM audit_logs WHERE action='settings.closures.update'")?.n).toBe(1);
  });

  it.each([false, true])("prioritizes linked-date rejection over reservation advice (overlapping=%s)", async (overlapping) => {
    const { closureId } = await approve();
    if (overlapping) {
      db.sqlite.exec(`INSERT INTO customers(id,display_name) VALUES ('linked-overlap-customer','Fixture');
        INSERT INTO reservations(id,store_id,service_id,resource_id,customer_id,source,status,start_at,end_at,duration_minutes,idempotency_key)
        VALUES ('linked-overlap-reservation','kyoto','service_kyoto_default_60','resource_kyoto_calendar','linked-overlap-customer',
          'admin','confirmed','2027-01-03T01:00:00.000Z','2027-01-03T02:00:00.000Z',60,'linked-overlap-key');`);
    }
    const before = snapshot();
    const reservationsBefore = db.sqlite.prepare("SELECT * FROM reservations ORDER BY id").all();
    expect(await updateAdminClosure({ db: db as unknown as D1Database, admin, closureId,
      request: { storeId: "kyoto", startsAt: "2027-01-02T15:00:00.000Z", endsAt: "2027-01-03T15:00:00.000Z", reason: "移動" } }))
      .toEqual({ ok: false, error: "linked_closure_dates_immutable" });
    expect(snapshot()).toEqual(before);
    expect(db.sqlite.prepare("SELECT * FROM reservations ORDER BY id").all()).toEqual(reservationsBefore);
  });

  it("keeps legacy NULL-linked closure date edits independent of a matching mirror", async () => {
    const { closureId } = await approve();
    db.sqlite.prepare("UPDATE store_closures SET external_block_id=NULL WHERE id=?").run(closureId);
    const before = snapshot();
    const startsAt = "2027-01-02T15:00:00.000Z";
    const endsAt = "2027-01-03T15:00:00.000Z";
    expect(await updateAdminClosure({ db: db as unknown as D1Database, admin, closureId,
      request: { storeId: "kyoto", startsAt, endsAt, reason: "旧データ" } })).toEqual({ ok: true, closureId });
    expect(row("SELECT starts_at,ends_at,external_block_id FROM store_closures WHERE id=?", closureId))
      .toEqual({ starts_at: startsAt, ends_at: endsAt, external_block_id: null });
    expect(snapshot().slice(1, 5)).toEqual(before.slice(1, 5));
  });

  it.each([
    ["link", "linked_closure_dates_immutable"],
    ["dates", "linked_closure_dates_immutable"],
    ["cancel", "not_found"],
    ["revoke", "forbidden"],
    ["store", "immutable_store"]
  ] as const)("rechecks concurrent %s changes before the atomic update", async (change, error) => {
    const { closureId, blockId } = await approve();
    const request = { storeId: "kyoto", startsAt: start, endsAt: end, reason: "古い画面からの変更" };
    if (change === "link" || change === "store") {
      db.sqlite.prepare("UPDATE store_closures SET external_block_id=NULL WHERE id=?").run(closureId);
    }
    if (change === "link") request.endsAt = "2027-01-03T15:00:00.000Z";
    const originalBatch = db.batch.bind(db);
    let before = snapshot();
    vi.spyOn(db, "batch").mockImplementationOnce(async (statements) => {
      if (change === "link") db.sqlite.prepare("UPDATE store_closures SET external_block_id=? WHERE id=?").run(blockId, closureId);
      if (change === "dates") {
        db.sqlite.prepare("UPDATE store_closures SET ends_at=? WHERE id=?").run("2027-01-03T15:00:00.000Z", closureId);
        db.sqlite.prepare("UPDATE external_blocks SET end_at=? WHERE id=?").run("2027-01-03T15:00:00.000Z", blockId);
      }
      if (change === "cancel") db.sqlite.prepare("UPDATE external_blocks SET status='cancelled' WHERE id=?").run(blockId);
      if (change === "revoke") db.sqlite.prepare("UPDATE admin_users SET active=0 WHERE id=?").run(admin.id);
      if (change === "store") {
        db.sqlite.exec("INSERT INTO stores(id,name) VALUES ('concurrent-other','Other')");
        db.sqlite.prepare("UPDATE store_closures SET store_id='concurrent-other' WHERE id=?").run(closureId);
      }
      before = snapshot();
      return originalBatch(statements);
    });
    expect(await updateAdminClosure({ db: db as unknown as D1Database, admin, closureId, request }))
      .toEqual({ ok: false, error });
    expect(snapshot()).toEqual(before);
  });

  it("refuses another store's staff without exposing the linked-date constraint or changing state", async () => {
    const { closureId } = await approve();
    const before = snapshot();
    expect(await updateAdminClosure({ db: db as unknown as D1Database,
      admin: { ...admin, role: "staff", store_id: "other-store" }, closureId,
      request: { storeId: "kyoto", startsAt: start, endsAt: "2027-01-03T15:00:00.000Z", reason: "変更" } }))
      .toEqual({ ok: false, error: "forbidden" });
    expect(snapshot()).toEqual(before);
  });

  it.each([0, 1])("deletes the closure and cancels its linked block atomically (recursive_triggers=%s)", async (recursive) => {
    db.sqlite.exec(`PRAGMA recursive_triggers=${recursive}`);
    const { closureId, blockId } = await approve();
    expect(await deleteAdminClosure({ db: db as unknown as D1Database, admin, closureId })).toEqual({ ok: true, closureId });
    expectCancelled(blockId);
    expect(row("SELECT actor_id FROM audit_logs WHERE action='settings.closures.delete'")?.actor_id).toBe(admin.id);
  });

  it.each([0, 1])("cancels the block and removes its linked closure with replay preserved (recursive_triggers=%s)", async (recursive) => {
    db.sqlite.exec(`PRAGMA recursive_triggers=${recursive}`);
    const { blockId } = await approve();
    const input = { db: db as unknown as D1Database, admin, externalBlockId: blockId,
      request: { idempotencyKey: "linked-cancel" }, now: () => nowMs };
    expect(await cancelAdminExternalBlock(input)).toMatchObject({ ok: true, status: "cancelled", replayed: false });
    expect(await cancelAdminExternalBlock(input)).toMatchObject({ ok: true, status: "cancelled", replayed: true });
    expectCancelled(blockId);
    expect(row("SELECT actor_id FROM audit_logs WHERE action='admin_external_block_cancelled'")?.actor_id).toBe(admin.id);
  });

  it("persists one same-store admin mirror link and rejects foreign/source mismatches", async () => {
    const { closureId, blockId } = await approve();
    expect(row("SELECT external_block_id FROM store_closures WHERE id=?", closureId)?.external_block_id).toBe(blockId);
    expect(() => db.sqlite.prepare(`INSERT INTO store_closures(id,store_id,starts_at,ends_at,source,external_block_id)
      VALUES ('duplicate','kyoto',?,?,'admin',?)`).run(start, end, blockId)).toThrow();
    expect(() => db.sqlite.prepare("DELETE FROM external_blocks WHERE id=?").run(blockId)).toThrow();
    db.sqlite.exec(`INSERT INTO stores(id,name) VALUES ('linked-other','Other');
      INSERT INTO store_resources(id,store_id,name) VALUES ('linked-other-resource','linked-other','Other');
      INSERT INTO external_blocks(id,store_id,resource_id,source,start_at,end_at,status)
      VALUES ('foreign-block','linked-other','linked-other-resource','admin_block','2027-01-01T15:00:00.000Z','2027-01-02T15:00:00.000Z','active');
      INSERT INTO external_blocks(id,store_id,resource_id,source,start_at,end_at,status,google_event_id)
      VALUES ('google-block','kyoto','resource_kyoto_calendar','google_calendar','2027-01-01T15:00:00.000Z','2027-01-02T15:00:00.000Z','active','other-event');`);
    for (const invalid of ["foreign-block", "google-block", "missing-block"]) {
      expect(() => db.sqlite.prepare("UPDATE store_closures SET external_block_id=? WHERE id=?").run(invalid, closureId)).toThrow();
    }
    expect(row("SELECT external_block_id FROM store_closures WHERE id=?", closureId)?.external_block_id).toBe(blockId);
  });

  it("supersedes queued upserts while preserving in-flight writes and unrelated locks", async () => {
    const { closureId, blockId } = await approve();
    db.sqlite.prepare(`INSERT INTO calendar_sync_jobs(id,dedupe_key,owner_type,owner_id,google_action,status,attempts,locked_until)
      VALUES ('inflight','inflight','external_block',?,'upsert','processing',1,'2027-01-01T00:00:00.000Z')`).run(blockId);
    db.sqlite.exec(`INSERT INTO customers(id,display_name) VALUES ('keep-customer','Fixture');
      INSERT INTO customer_time_locks(id,customer_id,slot_at,owner_type,owner_id,lock_status)
      VALUES ('keep-customer-lock','keep-customer','2027-01-10T00:00:00.000Z','reservation','keep-reservation','confirmed');
      INSERT INTO slot_locks(id,store_id,resource_id,slot_at,owner_type,owner_id,lock_status)
      VALUES ('keep-slot','kyoto','resource_kyoto_calendar','2027-01-10T00:00:00.000Z','reservation','keep-reservation','confirmed');`);
    expect((await deleteAdminClosure({ db: db as unknown as D1Database, admin, closureId })).ok).toBe(true);
    expectCancelled(blockId);
    expect(row("SELECT status,attempts,locked_until FROM calendar_sync_jobs WHERE id='inflight'"))
      .toEqual({ status: "processing", attempts: 1, locked_until: "2027-01-01T00:00:00.000Z" });
    expect(row("SELECT status,last_error FROM calendar_sync_jobs WHERE google_action='upsert' AND id!='inflight'"))
      .toMatchObject({ status: "succeeded", last_error: "superseded_by_external_block_cancellation" });
    expect(row("SELECT id FROM slot_locks WHERE id='keep-slot'")?.id).toBe("keep-slot");
    expect(count("customer_time_locks")).toBe(1);
  });

  it.each(["closure", "block"])("rolls back both records and all side effects when the %s actor audit fails", async (action) => {
    const { closureId, blockId } = await approve();
    const audit = action === "closure" ? "settings.closures.delete" : "admin_external_block_cancelled";
    db.sqlite.exec(`CREATE TRIGGER fixture_audit_failure BEFORE INSERT ON audit_logs WHEN NEW.action='${audit}'
      BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END;`);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = action === "closure"
      ? await deleteAdminClosure({ db: db as unknown as D1Database, admin, closureId })
      : await cancelAdminExternalBlock({ db: db as unknown as D1Database, admin, externalBlockId: blockId, request: { idempotencyKey: "failed-cancel" } });
    expect(result.ok).toBe(false);
    expect(count("store_closures")).toBe(1);
    expect(row("SELECT status FROM external_blocks WHERE id=?", blockId)?.status).toBe("active");
    expect(row("SELECT id FROM slot_locks WHERE id='linked-lock'")?.id).toBe("linked-lock");
    expect(row("SELECT COUNT(*) AS n FROM calendar_sync_jobs WHERE google_action='delete'")?.n).toBe(0);
    expect(row("SELECT status FROM calendar_sync_jobs WHERE google_action='upsert'")?.status).toBe("queued");
  });

  it("converges competing cancellations to one canonical Google deletion", async () => {
    const { closureId, blockId } = await approve();
    const results = await Promise.all([
      deleteAdminClosure({ db: db as unknown as D1Database, admin, closureId }),
      cancelAdminExternalBlock({ db: db as unknown as D1Database, admin, externalBlockId: blockId, request: { idempotencyKey: "racing-cancel" } })
    ]);
    expect(results.some((result) => result.ok)).toBe(true);
    expectCancelled(blockId);
  });

  it("retains actor authorization at the atomic write boundary", async () => {
    const { closureId, blockId } = await approve();
    db.sqlite.exec("UPDATE admin_users SET active=0 WHERE id='linked-owner'");
    expect(await deleteAdminClosure({ db: db as unknown as D1Database, admin, closureId })).toEqual({ ok: false, error: "forbidden" });
    expect(await cancelAdminExternalBlock({ db: db as unknown as D1Database, admin, externalBlockId: blockId, request: { idempotencyKey: "revoked-cancel" } }))
      .toEqual({ ok: false, reason: "forbidden" });
    expect(count("store_closures")).toBe(1);
    expect(row("SELECT status FROM external_blocks WHERE id=?", blockId)?.status).toBe("active");
  });
});

it("upgrades populated historical tables without guessing an audit-history link", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    for (const name of readdirSync("migrations").filter((name) => name.endsWith(".sql") && name < migration).sort()) {
      sqlite.exec(readFileSync(join("migrations", name), "utf8"));
    }
    sqlite.exec(readFileSync("seeds/dev.sql", "utf8"));
    sqlite.exec(`INSERT INTO admin_users(id,email,access_subject,role) VALUES ('linked-owner','linked@example.test','linked-sub','owner');
      INSERT INTO external_blocks(id,store_id,resource_id,source,start_at,end_at,status)
      VALUES ('legacy-block','kyoto','resource_kyoto_calendar','admin_block','2027-01-01T15:00:00.000Z','2027-01-02T15:00:00.000Z','active');
      INSERT INTO store_closures(id,store_id,starts_at,ends_at,source) VALUES ('legacy-closure','kyoto','2027-01-01T15:00:00.000Z','2027-01-02T15:00:00.000Z','admin');
      INSERT INTO audit_logs(id,actor_type,action,target_type,target_id,metadata_json)
      VALUES ('legacy-audit','system','all_day_conflict_approved_as_closure','google_calendar_conflict','legacy-conflict','{"closureId":"legacy-closure","externalBlockId":"legacy-block"}');`);
    sqlite.exec(readFileSync(join("migrations", migration), "utf8"));
    expect(sqlite.prepare("SELECT external_block_id FROM store_closures").get()).toEqual({ external_block_id: null });
    const db = new SqliteD1Database(sqlite) as unknown as D1Database;
    expect((await cancelAdminExternalBlock({ db, admin, externalBlockId: "legacy-block", request: { idempotencyKey: "legacy-cancel" } })).ok).toBe(true);
    expect(sqlite.prepare("SELECT id FROM store_closures").get()).toEqual({ id: "legacy-closure" });
    sqlite.exec("UPDATE external_blocks SET status='active' WHERE id='legacy-block'");
    expect((await deleteAdminClosure({ db, admin, closureId: "legacy-closure" })).ok).toBe(true);
    expect(sqlite.prepare("SELECT status FROM external_blocks").get()).toEqual({ status: "active" });
    expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(sqlite.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  } finally { sqlite.close(); }
});
