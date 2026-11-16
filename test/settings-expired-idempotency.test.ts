import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminUser } from "../src/admin/access";
import { createAdminService } from "../src/admin/settings-services";
import { createAdminResource } from "../src/admin/settings-resources";
import { createAdminStaff } from "../src/admin/settings-staff";
import { createAdminClosure } from "../src/admin/settings-closures";
import { upsertStoreLogin } from "../src/admin/settings-store-login";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

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
      VALUES ('unrelated_key', 'public_submit', 'settings-expired-key', 'started', 'unrelated', '2000-01-01T00:00:00.000Z');
  `);
  return db;
};

const context = (db: SqliteD1Database) => ({ db: db as unknown as D1Database, admin, now: () => Date.parse(NOW) });
const cases = [
  { name: "service", run: (db: SqliteD1Database) => createAdminService({
    ...context(db), request: {
      storeId: "settings_expiry_store", name: "Test service", priceLabel: null,
      durationMinutes: 60, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, active: true, idempotencyKey: key
    }
  }) },
  { name: "resource", run: (db: SqliteD1Database) => createAdminResource({
    ...context(db), request: {
      storeId: "settings_expiry_store", name: "Test resource", resourceType: "staff_calendar", active: true, idempotencyKey: key
    }
  }) },
  { name: "staff", run: (db: SqliteD1Database) => createAdminStaff({
    ...context(db), request: {
      storeId: "settings_expiry_store", displayName: "Test staff", role: "staff", active: true, idempotencyKey: key
    }
  }) },
  { name: "closure", run: (db: SqliteD1Database) => createAdminClosure({
    ...context(db), request: {
      storeId: "settings_expiry_store", startsAt: "2099-01-02T00:00:00.000Z", endsAt: "2099-01-02T01:00:00.000Z",
      reason: null, idempotencyKey: key
    }
  }) },
  { name: "store login", run: (db: SqliteD1Database) => upsertStoreLogin({
    ...context(db), request: {
      storeId: "settings_expiry_store", email: "store@example.test", role: "staff", idempotencyKey: key
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
  it.each([true, false])("retries the same expired key (unfinished=%s) without deleting other history", async (unfinished) => {
    const db = fixture();
    try {
      expect(await run(db)).toMatchObject({ ok: true, replayed: false });
      const firstId = readKey(db)?.id;
      expireKey(db, unfinished);
      const unrelated = db.sqlite.prepare("SELECT * FROM idempotency_keys WHERE id = 'unrelated_key'").get();

      expect(await run(db)).toMatchObject({ ok: true, replayed: false });
      expect(readKey(db)).toMatchObject({ status: "succeeded" });
      expect(readKey(db)?.id).not.toBe(firstId);
      expect(db.sqlite.prepare("SELECT * FROM idempotency_keys WHERE id = 'unrelated_key'").get()).toEqual(unrelated);
    } finally { db.sqlite.close(); }
  });
});

describe("expired settings key transaction boundaries", () => {
  const run = cases[1].run;

  it.each(["request_hash", "target_type"] as const)("preserves an expired key with different %s", async (column) => {
    const db = fixture();
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await run(db)).toMatchObject({ ok: true });
      expireKey(db, false);
      db.sqlite.prepare(`UPDATE idempotency_keys SET ${column} = 'unrelated' WHERE scope = 'admin_action' AND idempotency_key = ?`).run(key);
      const before = readKey(db);
      expect(await run(db)).toMatchObject({ ok: false });
      expect(readKey(db)).toEqual(before);
    } finally { db.sqlite.close(); }
  });

  it("does not reclaim a key renewed after the initial lookup", async () => {
    const db = fixture();
    try {
      expect(await run(db)).toMatchObject({ ok: true });
      expireKey(db, true);
      const originalBatch = db.batch.bind(db);
      db.batch = async (statements) => {
        db.sqlite.prepare("UPDATE idempotency_keys SET expires_at = '2099-01-03T00:00:00.000Z' WHERE scope = 'admin_action' AND idempotency_key = ?").run(key);
        return originalBatch(statements);
      };
      expect(await run(db)).toEqual({ ok: false, error: "idempotency_in_progress" });
      expect(readKey(db)).toMatchObject({ status: "started", expires_at: "2099-01-03T00:00:00.000Z" });
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
      expect(await run(db)).toEqual({ ok: false, error: "forbidden" });
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
      expect(await run(db)).toEqual({ ok: false, error: "write_failed" });
      expect(readKey(db)).toEqual(before);
    } finally { db.sqlite.close(); }
  });
});
