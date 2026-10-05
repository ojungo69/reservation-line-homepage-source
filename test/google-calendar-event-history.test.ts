import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { pruneGoogleEventHistory } from "../src/google/import-sync";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const TASK_KEY = "prune_google_calendar_event_history";

describe("google_calendar_event_history migration shape", () => {
  let d1: SqliteD1Database;

  beforeEach(() => {
    d1 = createMigratedSqliteD1();
  });

  afterEach(() => {
    d1.sqlite.close();
  });

  it("creates the history table with the documented column set", () => {
    const columns = d1.sqlite
      .prepare("PRAGMA table_info('google_calendar_event_history')")
      .all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>;
    const byName = new Map(columns.map((column) => [column.name, column]));
    for (const expected of [
      "id",
      "store_id",
      "calendar_id",
      "google_event_id",
      "google_etag",
      "google_updated_at",
      "source_type",
      "status",
      "reason",
      "snapshot_json",
      "captured_at"
    ]) {
      expect(byName.has(expected), `column ${expected} missing`).toBe(true);
    }
    const captured = byName.get("captured_at");
    expect(captured?.notnull).toBe(1);
    // captured_at must not default to CURRENT_TIMESTAMP (codex iter 1 blocker B5).
    expect(captured?.dflt_value).toBeNull();
  });

  it("creates the maintenance marker table with composite PK", () => {
    const columns = d1.sqlite
      .prepare("PRAGMA table_info('google_calendar_history_maintenance_runs')")
      .all() as Array<{ name: string; pk: number }>;
    const pkCols = columns.filter((column) => column.pk > 0).map((column) => column.name).sort();
    expect(pkCols).toEqual(["day_bucket", "task_key"]);
  });

  it("creates the two indexes used by lookups and retention", () => {
    const indexes = d1.sqlite
      .prepare("PRAGMA index_list('google_calendar_event_history')")
      .all() as Array<{ name: string }>;
    const names = indexes.map((index) => index.name);
    expect(names).toContain("idx_event_history_event");
    expect(names).toContain("idx_event_history_captured");
  });
});

describe("pruneGoogleEventHistory", () => {
  let d1: SqliteD1Database;

  beforeEach(() => {
    d1 = createMigratedSqliteD1();
    // Storefixture aligns with createMigratedSqliteD1's default seed.
    d1.sqlite
      .prepare(
        `
          INSERT INTO google_calendar_event_history
            (id, store_id, calendar_id, google_event_id, google_etag, google_updated_at,
             source_type, status, reason, snapshot_json, captured_at)
          VALUES (?, 'kyoto', 'kyoto.cal', ?, 'etag-1', '2026-01-01T00:00:00.000Z',
                  'reservation', 'active', 'upsert', '{"x":1}', ?)
        `
      )
      .run("row-old-1", "evt-old-1", "2026-01-01T00:00:00.000Z");
    d1.sqlite
      .prepare(
        `
          INSERT INTO google_calendar_event_history
            (id, store_id, calendar_id, google_event_id, google_etag, google_updated_at,
             source_type, status, reason, snapshot_json, captured_at)
          VALUES (?, 'kyoto', 'kyoto.cal', ?, 'etag-2', '2026-04-01T00:00:00.000Z',
                  'reservation', 'active', 'upsert', '{"x":2}', ?)
        `
      )
      .run("row-recent-1", "evt-recent-1", "2026-04-01T00:00:00.000Z");
  });

  afterEach(() => {
    d1.sqlite.close();
  });

  it("deletes rows older than the retention cutoff and keeps newer rows", async () => {
    // nowMs = 2026-04-15. retention 30 → cutoff = 2026-03-16. Old (2026-01-01) deleted; recent (2026-04-01) kept.
    const nowMs = Date.parse("2026-04-15T00:00:00.000Z");
    const result = await pruneGoogleEventHistory({ db: d1 as unknown as D1Database, nowMs, retentionDays: 30 });
    expect(result).toEqual({ skipped: false, deleted: 1 });
    const remaining = d1.sqlite
      .prepare("SELECT id FROM google_calendar_event_history ORDER BY id")
      .all() as Array<{ id: string }>;
    expect(remaining.map((row) => row.id)).toEqual(["row-recent-1"]);
  });

  it("treats a same-day re-invocation as a dedupe no-op", async () => {
    const nowMs = Date.parse("2026-04-15T00:00:00.000Z");
    await pruneGoogleEventHistory({ db: d1 as unknown as D1Database, nowMs, retentionDays: 30 });
    const second = await pruneGoogleEventHistory({ db: d1 as unknown as D1Database, nowMs, retentionDays: 30 });
    expect(second).toEqual({ skipped: true, reason: "already_ran_today" });
    const markerRows = d1.sqlite
      .prepare(
        `SELECT day_bucket FROM google_calendar_history_maintenance_runs WHERE task_key = ?`
      )
      .all(TASK_KEY) as Array<{ day_bucket: string }>;
    expect(markerRows.map((row) => row.day_bucket)).toEqual(["2026-04-15"]);
  });

  it("releases the daily marker when the DELETE fails and lets the next tick retry", async () => {
    const nowMs = Date.parse("2026-04-15T00:00:00.000Z");
    let attempts = 0;
    const wrappedDb = new Proxy(d1 as unknown as D1Database, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (key !== "prepare") {
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (sql.includes("DELETE FROM google_calendar_event_history")) {
            return {
              bind: (...args: unknown[]) => ({
                run: async () => {
                  attempts += 1;
                  if (attempts === 1) {
                    throw new Error("simulated_d1_unavailable");
                  }
                  return (stmt as unknown as { bind: (...a: unknown[]) => { run: () => Promise<unknown> } })
                    .bind(...args)
                    .run();
                }
              })
            } as unknown as D1PreparedStatement;
          }
          return stmt;
        };
      }
    });
    // First call: simulated DELETE failure → marker released, error rethrown.
    await expect(
      pruneGoogleEventHistory({ db: wrappedDb, nowMs, retentionDays: 30 })
    ).rejects.toThrow("simulated_d1_unavailable");
    const markerCount = (d1.sqlite
      .prepare(
        `SELECT COUNT(*) AS c FROM google_calendar_history_maintenance_runs WHERE task_key = ?`
      )
      .get(TASK_KEY) as { c: number }).c;
    expect(markerCount).toBe(0);

    // Second call (same UTC day, same wrapped db): proxy lets DELETE through;
    // the prior marker rollback means we are NOT skipped — the old row is
    // actually deleted and the marker is now persisted.
    const retry = await pruneGoogleEventHistory({ db: wrappedDb, nowMs, retentionDays: 30 });
    expect(retry).toEqual({ skipped: false, deleted: 1 });
    const remaining = d1.sqlite
      .prepare("SELECT id FROM google_calendar_event_history ORDER BY id")
      .all() as Array<{ id: string }>;
    expect(remaining.map((row) => row.id)).toEqual(["row-recent-1"]);
  });

  it("respects ISO boundary precision instead of date-only string compare", async () => {
    // 1ms apart across the cutoff. With ISO compare, the earlier one must be
    // deleted and the later one must survive (codex iter 1 blocker B5).
    const cutoffMs = Date.parse("2026-04-15T00:00:00.000Z") - 30 * 24 * 60 * 60 * 1000;
    d1.sqlite
      .prepare(
        `
          INSERT INTO google_calendar_event_history
            (id, store_id, calendar_id, google_event_id, google_etag, google_updated_at,
             source_type, status, reason, snapshot_json, captured_at)
          VALUES (?, 'kyoto', 'kyoto.cal', ?, NULL, NULL,
                  'reservation', 'active', 'upsert', '{}', ?)
        `
      )
      .run("row-edge-before", "evt-edge-before", new Date(cutoffMs - 1).toISOString());
    d1.sqlite
      .prepare(
        `
          INSERT INTO google_calendar_event_history
            (id, store_id, calendar_id, google_event_id, google_etag, google_updated_at,
             source_type, status, reason, snapshot_json, captured_at)
          VALUES (?, 'kyoto', 'kyoto.cal', ?, NULL, NULL,
                  'reservation', 'active', 'upsert', '{}', ?)
        `
      )
      .run("row-edge-after", "evt-edge-after", new Date(cutoffMs + 1).toISOString());

    const nowMs = Date.parse("2026-04-15T00:00:00.000Z");
    await pruneGoogleEventHistory({ db: d1 as unknown as D1Database, nowMs, retentionDays: 30 });
    const remaining = d1.sqlite
      .prepare("SELECT id FROM google_calendar_event_history ORDER BY id")
      .all() as Array<{ id: string }>;
    const ids = remaining.map((row) => row.id);
    expect(ids).toContain("row-edge-after");
    expect(ids).not.toContain("row-edge-before");
  });
});
