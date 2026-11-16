import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GoogleImportClaimLostError, withGoogleImportBatchGuard } from "../src/google/import-claim";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const CLAIM = { jobId: "guard-job", lockedUntil: "2026-06-01T00:05:00.000Z", attemptCount: 1 };

describe("Google import claim batch guard", () => {
  let d1: SqliteD1Database;
  beforeEach(() => {
    d1 = createMigratedSqliteD1();
    d1.sqlite.prepare(`
      INSERT INTO google_calendar_import_jobs (
        id, store_id, calendar_id, reason, status, next_run_at, locked_until, attempt_count, dedupe_key
      ) VALUES (?, 'kyoto', 'calendar-a@example.invalid', 'push', 'processing', '2026-06-01T00:00:00.000Z', ?, 1, 'guard-job')
    `).run(CLAIM.jobId, CLAIM.lockedUntil);
  });
  afterEach(() => { d1.sqlite.close(); });

  it("preserves native session/read APIs and all prepared-statement methods", async () => {
    class Prepared {
      #value = 42;
      bind() { return this; }
      async first() { return this.#value; }
      async all() { return { results: [this.#value] }; }
      async raw() { return [[this.#value]]; }
      async run() { return { meta: { changes: this.#value } }; }
    }
    class Native {
      #value = 42;
      statement = new Prepared();
      get readDb() { return this.#value; }
      withSession() { return this.#value; }
      prepare() { return this.#value === 42 ? this.statement : undefined; }
    }
    const native = new Native();
    const guarded = withGoogleImportBatchGuard(native as unknown as D1Database, CLAIM);
    expect((guarded as D1Database & { readDb: number }).readDb).toBe(42);
    expect(guarded.withSession()).toBe(42);
    const statement = guarded.prepare("SELECT 42").bind();
    expect(statement).toBe(native.statement);
    expect(await statement.first()).toBe(42);
    expect(await statement.all()).toEqual({ results: [42] });
    expect(await statement.raw()).toEqual([[42]]);
    expect(await statement.run()).toEqual({ meta: { changes: 42 } });
  });

  it("preserves batch result indexes and changes() dependencies", async () => {
    const db = withGoogleImportBatchGuard(d1 as unknown as D1Database, CLAIM);
    const results = await db.batch([
      db.prepare("UPDATE stores SET name = 'guarded-name' WHERE id = 'kyoto'"),
      db.prepare(`
        INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id)
        SELECT 'fixture-audit', 'google_calendar', 'fixture', 'fixture.update', 'store', 'kyoto'
        WHERE changes() > 0
      `),
      db.prepare("SELECT name FROM stores WHERE id = 'kyoto'")
    ]);
    expect(results).toHaveLength(3);
    expect(results[0]?.meta.changes).toBe(1);
    expect(results[1]?.meta.changes).toBe(1);
    expect(results[2]?.results).toEqual([{ name: "guarded-name" }]);
    expect(d1.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_logs").get()).toEqual({ count: 1 });
  });

  it("rolls back the complete batch when the claim generation has changed", async () => {
    const before = d1.sqlite.prepare("SELECT name FROM stores WHERE id = 'kyoto'").get();
    d1.sqlite.prepare("UPDATE google_calendar_import_jobs SET attempt_count = 2 WHERE id = ?").run(CLAIM.jobId);
    const db = withGoogleImportBatchGuard(d1 as unknown as D1Database, CLAIM);

    await expect(db.batch([db.prepare("UPDATE stores SET name = 'stale-name' WHERE id = 'kyoto'")]))
      .rejects.toBeInstanceOf(GoogleImportClaimLostError);
    expect(d1.sqlite.prepare("SELECT name FROM stores WHERE id = 'kyoto'").get()).toEqual(before);
    expect(d1.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_logs").get()).toEqual({ count: 0 });
  });

  it("preserves an unrelated actor_type failure while the claim is current", async () => {
    const before = d1.sqlite.prepare("SELECT name FROM stores WHERE id = 'kyoto'").get();
    const db = withGoogleImportBatchGuard(d1 as unknown as D1Database, CLAIM);
    let caught: unknown;
    try {
      await db.batch([
        db.prepare("UPDATE stores SET name = 'uncommitted' WHERE id = 'kyoto'"),
        db.prepare(`
          INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id)
          VALUES ('invalid-actor', 'unrelated_invalid_actor', 'fixture', 'fixture.update', 'store', 'kyoto')
        `)
      ]);
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(GoogleImportClaimLostError);
    expect(String(caught)).toContain("actor_type");
    expect(d1.sqlite.prepare("SELECT name FROM stores WHERE id = 'kyoto'").get()).toEqual(before);
  });
});
