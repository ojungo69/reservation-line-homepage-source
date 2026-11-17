import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminUser } from "../src/admin/access";
import { expiredSettingsIdempotencyStatement } from "../src/admin/settings-common";
import { createAdminService } from "../src/admin/settings-services";
import { createAdminResource } from "../src/admin/settings-resources";
import { createAdminStaff } from "../src/admin/settings-staff";
import { createAdminClosure } from "../src/admin/settings-closures";
import { upsertStoreLogin } from "../src/admin/settings-store-login";
import { createMigratedSqliteD1, SqliteD1Database } from "./helpers/sqlite-d1";

const NOW = "2099-01-01T00:00:00.000Z";
const key = "settings-expired-key";
const admin: AdminUser = {
  id: "settings_expiry_owner", email: "expiry@example.test", role: "owner",
  staff_member_id: null, store_id: null
};

const fixture = () => {
  const db = createMigratedSqliteD1();
  db.sqlite.exec(`
    INSERT INTO stores (id, name, timezone) VALUES ('settings_expiry_store', 'Test store', 'Asia/Tokyo');
    INSERT INTO admin_users (id, email, access_subject, role, active, is_service_token)
      VALUES ('settings_expiry_owner', 'expiry@example.test', 'settings-expiry-sub', 'owner', 1, 0);
    INSERT INTO idempotency_keys (id, scope, idempotency_key, status, request_hash, expires_at)
      VALUES ('unrelated_key', 'public_submit', 'settings-expired-key', 'started', 'unrelated', '2000-01-01T00:00:00.000Z'),
        ('other_admin_key', 'admin_action', 'other-settings-key', 'succeeded', 'unrelated', '2000-01-01T00:00:00.000Z');
  `);
  return db;
};

const context = (db: SqliteD1Database) => ({ db: db as unknown as D1Database, admin, now: () => Date.parse(NOW) });
const cases = [
  { name: "service", run: (db: SqliteD1Database, changed = false) => createAdminService({
    ...context(db), request: {
      storeId: "settings_expiry_store", name: changed ? "Changed service" : "Test service", priceLabel: null,
      durationMinutes: 60, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, active: true, idempotencyKey: key
    }
  }) },
  { name: "resource", run: (db: SqliteD1Database, changed = false) => createAdminResource({
    ...context(db), request: {
      storeId: "settings_expiry_store", name: changed ? "Changed resource" : "Test resource", resourceType: "staff_calendar", active: true, idempotencyKey: key
    }
  }) },
  { name: "staff", run: (db: SqliteD1Database, changed = false) => createAdminStaff({
    ...context(db), request: {
      storeId: "settings_expiry_store", displayName: changed ? "Changed staff" : "Test staff", role: "staff", active: true, idempotencyKey: key
    }
  }) },
  { name: "closure", run: (db: SqliteD1Database, changed = false) => createAdminClosure({
    ...context(db), request: {
      storeId: "settings_expiry_store", startsAt: "2099-01-02T00:00:00.000Z", endsAt: "2099-01-02T01:00:00.000Z",
      reason: changed ? "Changed reason" : null, idempotencyKey: key
    }
  }) },
  { name: "store login", run: (db: SqliteD1Database, changed = false) => upsertStoreLogin({
    ...context(db), request: {
      storeId: "settings_expiry_store", email: changed ? "changed@example.test" : "store@example.test", role: "staff", idempotencyKey: key
    }
  }) }
] as const;

const readKey = (db: SqliteD1Database) => db.sqlite.prepare(
  "SELECT * FROM idempotency_keys WHERE scope = 'admin_action' AND idempotency_key = ?"
).get(key);

const expireKey = (db: SqliteD1Database, unfinished: boolean) => {
  db.sqlite.prepare("UPDATE idempotency_keys SET expires_at = ? WHERE scope = 'admin_action' AND idempotency_key = ?")
    .run(NOW, key);
  if (unfinished) db.sqlite.prepare(
    "UPDATE idempotency_keys SET status = 'started', target_id = NULL, target_type = NULL WHERE scope = 'admin_action' AND idempotency_key = ?"
  ).run(key);
};

afterEach(() => vi.restoreAllMocks());

describe.each(cases)("$name expired settings request", ({ run }) => {
  it.each([
    { unfinished: true, changed: false }, { unfinished: true, changed: true },
    { unfinished: false, changed: false }, { unfinished: false, changed: true }
  ])("reuses a key at exact expiry (unfinished=$unfinished, changed=$changed) without deleting other history", async ({ unfinished, changed }) => {
    const db = fixture();
    try {
      expect(await run(db)).toMatchObject({ ok: true, replayed: false });
      const firstId = readKey(db)?.id;
      expireKey(db, unfinished);
      const unrelated = db.sqlite.prepare("SELECT * FROM idempotency_keys WHERE id IN ('unrelated_key', 'other_admin_key') ORDER BY id").all();

      expect(await run(db, changed)).toMatchObject({ ok: true, replayed: false });
      expect(readKey(db)).toMatchObject({ status: "succeeded" });
      expect(readKey(db)?.id).not.toBe(firstId);
      expect(db.sqlite.prepare("SELECT * FROM idempotency_keys WHERE id IN ('unrelated_key', 'other_admin_key') ORDER BY id").all()).toEqual(unrelated);
    } finally { db.sqlite.close(); }
  });

  it.each([false, true])("preserves a live key (changed=%s)", async (changed) => {
    const db = fixture();
    try {
      expect(await run(db)).toMatchObject({ ok: true, replayed: false });
      const before = readKey(db);
      expect(await run(db, changed)).toMatchObject(changed
        ? { ok: false, error: "idempotency_conflict" }
        : { ok: true, replayed: true });
      expect(readKey(db)).toEqual(before);
    } finally { db.sqlite.close(); }
  });
});

describe("expired settings key transaction boundaries", () => {
  const run = cases[1].run;

  it("reuses an expired key from another action regardless of its hash or target", async () => {
    const db = fixture();
    try {
      expect(await cases[0].run(db)).toMatchObject({ ok: true });
      db.sqlite.prepare("UPDATE idempotency_keys SET expires_at = '2098-12-31T23:59:59.000Z' WHERE scope = 'admin_action' AND idempotency_key = ?").run(key);
      const firstId = readKey(db)?.id;
      expect(await run(db)).toMatchObject({ ok: true, replayed: false });
      expect(readKey(db)).toMatchObject({ status: "succeeded", target_type: "store_resource" });
      expect(readKey(db)?.id).not.toBe(firstId);
    } finally { db.sqlite.close(); }
  });

  it.each([false, true])("does not reclaim a key renewed after the initial lookup (changed=%s)", async (changed) => {
    const db = fixture();
    try {
      expect(await run(db)).toMatchObject({ ok: true });
      expireKey(db, true);
      const originalBatch = db.batch.bind(db);
      db.batch = async (statements) => {
        db.sqlite.prepare("UPDATE idempotency_keys SET expires_at = '2099-01-03T00:00:00.000Z' WHERE scope = 'admin_action' AND idempotency_key = ?").run(key);
        if (changed) db.sqlite.prepare("UPDATE idempotency_keys SET request_hash = 'renewed-hash' WHERE scope = 'admin_action' AND idempotency_key = ?").run(key);
        return originalBatch(statements);
      };
      expect(await run(db)).toEqual({ ok: false, error: changed ? "idempotency_conflict" : "idempotency_in_progress" });
      expect(readKey(db)).toMatchObject({ status: "started", expires_at: "2099-01-03T00:00:00.000Z" });
      if (changed) expect(readKey(db)?.request_hash).toBe("renewed-hash");
    } finally { db.sqlite.close(); }
  });

  it.each([
    { changed: false, firstArrivesFirst: true }, { changed: false, firstArrivesFirst: false },
    { changed: true, firstArrivesFirst: true }, { changed: true, firstArrivesFirst: false }
  ])("allows one concurrent reclaim and resolves the other request (changed=$changed, firstArrivesFirst=$firstArrivesFirst)", async ({ changed, firstArrivesFirst }) => {
    const db = fixture();
    try {
      expect(await run(db)).toMatchObject({ ok: true });
      expireKey(db, true);
      const expiredId = readKey(db)?.id;
      const unrelated = db.sqlite.prepare("SELECT * FROM idempotency_keys WHERE id IN ('unrelated_key', 'other_admin_key') ORDER BY id").all();
      const originalBatch = db.batch.bind(db);
      const waiting: (() => void)[] = [];
      let markFirstArrival!: () => void;
      const firstBatchArrived = new Promise<void>((resolve) => { markFirstArrival = resolve; });
      db.batch = async (statements) => {
        await new Promise<void>((resolve) => {
          waiting.push(resolve);
          if (waiting.length === 1) markFirstArrival();
          if (waiting.length === 2) waiting.forEach((release) => release());
        });
        return originalBatch(statements);
      };
      // Both requests must reach the batch before either commits; hash completion need not follow call order.
      const leadingRun = firstArrivesFirst ? run(db) : run(db, changed);
      await firstBatchArrived;
      const trailingRun = firstArrivesFirst ? run(db, changed) : run(db);
      const [first, second] = await Promise.all(firstArrivesFirst ? [leadingRun, trailingRun] : [trailingRun, leadingRun]);
      const creators = [first, second].filter((result) => result.ok && !result.replayed);
      expect(creators).toHaveLength(1);
      const [creator] = creators;
      const other = creator === first ? second : first;
      expect(other).toMatchObject(changed
        ? { ok: false, error: "idempotency_conflict" }
        : { ok: true, replayed: true });
      if (creator.ok) {
        if (other.ok) expect(other.resourceId).toBe(creator.resourceId);
        expect(readKey(db)).toMatchObject({ status: "succeeded", target_type: "store_resource", target_id: creator.resourceId });
        expect(db.sqlite.prepare("SELECT name FROM store_resources WHERE id = ?").get(creator.resourceId)).toMatchObject({
          name: creator === second && changed ? "Changed resource" : "Test resource"
        });
      }
      expect(readKey(db)?.id).not.toBe(expiredId);
      expect(db.sqlite.prepare("SELECT * FROM idempotency_keys WHERE id IN ('unrelated_key', 'other_admin_key') ORDER BY id").all()).toEqual(unrelated);
      expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM store_resources WHERE store_id = 'settings_expiry_store'").get()).toMatchObject({ n: 2 });
      expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'settings.resources.create' AND actor_id = ?").get(admin.id)).toMatchObject({ n: 2 });
    } finally { db.sqlite.close(); }
  });

  it("keeps the expired key when the actor is revoked before the transaction", async () => {
    const db = fixture();
    try {
      expect(await run(db)).toMatchObject({ ok: true });
      expireKey(db, true);
      const before = readKey(db);
      const originalBatch = db.batch.bind(db);
      db.batch = async (statements) => {
        db.sqlite.prepare("UPDATE admin_users SET active = 0 WHERE id = ?").run(admin.id);
        return originalBatch(statements);
      };
      expect(await run(db, true)).toEqual({ ok: false, error: "forbidden" });
      expect(readKey(db)).toEqual(before);
    } finally { db.sqlite.close(); }
  });

  it("restores the expired key if the following domain write fails", async () => {
    const db = fixture();
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await run(db)).toMatchObject({ ok: true });
      expireKey(db, true);
      const before = readKey(db);
      db.sqlite.exec("CREATE TRIGGER reject_retry BEFORE INSERT ON store_resources BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END");
      expect(await run(db, true)).toEqual({ ok: false, error: "write_failed" });
      expect(readKey(db)).toEqual(before);
    } finally { db.sqlite.close(); }
  });

  it("preserves a legacy key without an expiry", async () => {
    const db = new SqliteD1Database(new DatabaseSync(":memory:"));
    try {
      // Current migrations require an expiry; the shared read also supports legacy NULL rows.
      db.sqlite.exec(`
        CREATE TABLE idempotency_keys (scope TEXT, idempotency_key TEXT, request_hash TEXT, status TEXT, target_type TEXT, expires_at TEXT);
        INSERT INTO idempotency_keys VALUES ('admin_action', 'settings-expired-key', 'old-hash', 'succeeded', 'service', NULL);
      `);
      const before = readKey(db);
      await expiredSettingsIdempotencyStatement({
        ...context(db), key, requestHash: "new-hash", targetType: "store_resource", nowIso: NOW
      }).run();
      expect(readKey(db)).toEqual(before);
    } finally { db.sqlite.close(); }
  });
});
