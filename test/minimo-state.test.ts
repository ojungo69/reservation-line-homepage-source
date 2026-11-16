import { describe, expect, it } from "vitest";
import { createMigratedSqliteD1 } from "./helpers/sqlite-d1";
import { claimStoreLease, fencedBatch, releaseStoreLease, renewStoreLease } from "../src/minimo/state";

const now = Date.parse("2026-09-29T00:00:00Z");

describe("Minimo store lease", () => {
  it("excludes a concurrent writer and rejects every side effect from an expired owner", async () => {
    const db = createMigratedSqliteD1();
    const first = await claimStoreLease(db as unknown as D1Database, "osaka", [], now);
    expect(first).not.toBeNull();
    expect(await claimStoreLease(db as unknown as D1Database, "osaka", [], now)).toBeNull();
    const second = await claimStoreLease(db as unknown as D1Database, "osaka", [], now + 91_000);
    expect(second).not.toBeNull();
    const audit = db.prepare(`INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id)
      VALUES ('stale-minimo', 'system', 'minimo', 'test', 'store', 'osaka')`);
    await expect(fencedBatch(db as unknown as D1Database, first!, [audit], now + 91_000)).rejects.toThrow();
    expect(db.sqlite.prepare("SELECT id FROM audit_logs WHERE id = 'stale-minimo'").get()).toBeUndefined();
    expect(await renewStoreLease(db as unknown as D1Database, first!, now + 91_000)).toBe(false);
    await releaseStoreLease(db as unknown as D1Database, first!, now + 91_000);
    await fencedBatch(db as unknown as D1Database, second!, [audit], now + 91_000);
    expect(db.sqlite.prepare("SELECT id FROM audit_logs WHERE id = 'stale-minimo'").get()).toBeDefined();
    db.sqlite.close();
  });

  it("rechecks active resource membership in the same transaction as the business write", async () => {
    const db = createMigratedSqliteD1();
    const resource = db.sqlite.prepare("SELECT id FROM store_resources WHERE store_id = 'osaka' AND active = 1 LIMIT 1").get() as { id: string };
    const lease = await claimStoreLease(db as unknown as D1Database, "osaka", [resource.id], now);
    expect(lease).not.toBeNull();
    db.sqlite.prepare("UPDATE store_resources SET active = 0 WHERE id = ?").run(resource.id);
    const audit = db.prepare(`INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id)
      VALUES ('inactive-minimo', 'system', 'minimo', 'test', 'store', 'osaka')`);
    await expect(fencedBatch(db as unknown as D1Database, lease!, [audit], now)).rejects.toThrow();
    expect(db.sqlite.prepare("SELECT id FROM audit_logs WHERE id = 'inactive-minimo'").get()).toBeUndefined();
    db.sqlite.close();
  });
});
