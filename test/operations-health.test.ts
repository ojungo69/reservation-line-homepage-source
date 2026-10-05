import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readOperationsHealth } from "../src/operations-health-query";
import { OperationsHealth } from "../src/operations-health";
import type { WorkerBindings } from "../src/bindings";

const now = Date.parse("2026-09-30T00:00:00Z");
const old = "2026-09-29T23:30:00Z";
const recent = "2026-09-29T23:50:00Z";
const due = "2026-09-29T23:35:00Z";
const future = "2026-09-30T00:30:00Z";
const databases: DatabaseSync[] = [];

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  databases.push(sqlite);
  sqlite.exec([
    "CREATE TABLE stores (id TEXT PRIMARY KEY, google_calendar_id TEXT)",
    "CREATE TABLE reservations (id TEXT PRIMARY KEY, store_id TEXT, status TEXT, pending_expires_at TEXT, start_at TEXT)",
    "CREATE TABLE external_blocks (id TEXT PRIMARY KEY, store_id TEXT, status TEXT)",
    "CREATE TABLE calendar_sync_jobs (id TEXT PRIMARY KEY, owner_type TEXT, owner_id TEXT, google_action TEXT, status TEXT, attempts INTEGER, available_at TEXT, locked_until TEXT, updated_at TEXT)",
    "CREATE INDEX idx_calendar_sync_jobs_status_available ON calendar_sync_jobs(status, available_at)",
    "CREATE TABLE google_calendar_import_jobs (id TEXT PRIMARY KEY, status TEXT, attempt_count INTEGER, next_run_at TEXT, locked_until TEXT, updated_at TEXT)",
    "CREATE INDEX idx_google_import_jobs_status_next_run ON google_calendar_import_jobs(status, next_run_at)",
    "CREATE TABLE notification_jobs (id TEXT PRIMARY KEY, reservation_id TEXT, recipient_type TEXT, template_key TEXT, status TEXT, attempts INTEGER, available_at TEXT, locked_until TEXT, updated_at TEXT)",
    "CREATE INDEX idx_notification_jobs_status_available ON notification_jobs(status, available_at)",
    "CREATE TABLE audit_logs (target_type TEXT, target_id TEXT, action TEXT)",
    "INSERT INTO stores VALUES ('store', 'calendar')",
    "INSERT INTO reservations VALUES ('reservation', 'store', 'confirmed', NULL, '2026-10-01T00:00:00Z')",
    "INSERT INTO external_blocks VALUES ('block', 'store', 'active')"
  ].join(";") + ";");
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return { first: async () => sqlite.prepare(sql).get(...args as []) };
        }
      };
    }
  } as unknown as D1Database;
  const check = (flags: Record<string, string> = {}) =>
    readOperationsHealth(db, flags, now);
  return { sqlite, db, check };
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
});

describe("private operations health", () => {
  it("returns the fixed GET contract for healthy, stalled and unreadable evidence", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const { sqlite, db } = fixture();
    const entrypoint = new OperationsHealth({} as ExecutionContext, { DB: db } as WorkerBindings);
    const get = () => entrypoint.fetch(new Request("https://ops.internal/job-health"));
    const healthy = await get();
    expect(healthy.status).toBe(200);
    expect(healthy.headers.get("Cache-Control")).toBe("no-store");
    expect(await healthy.json()).toEqual({ status: "ok", sources: [] });

    sqlite.prepare("INSERT INTO calendar_sync_jobs VALUES (?, 'reservation', 'reservation', 'upsert', 'queued', 0, ?, NULL, ?)")
      .run("private-job-id", due, old);
    sqlite.prepare("INSERT INTO google_calendar_import_jobs VALUES (?, 'queued', 0, ?, NULL, ?)")
      .run("private-import-id", due, old);
    sqlite.prepare("INSERT INTO notification_jobs VALUES (?, 'reservation', 'customer', 'reservation_confirmed', 'queued', 0, ?, NULL, ?)")
      .run("private-notification-id", due, old);
    const stalled = await get();
    expect(stalled.status).toBe(503);
    expect(await stalled.json()).toEqual({ status: "stalled", sources: ["calendar", "google_import", "notification"] });

    sqlite.exec("DROP TABLE notification_jobs");
    const unavailable = await get();
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ status: "unknown", sources: [] });
  });

  it.each([
    ["POST", "/job-health"], ["GET", "/job-health?sql=select"], ["GET", "/"]
  ])("refuses %s %s before querying D1", async (method, path) => {
    const prepare = vi.fn(() => { throw new Error("must not query D1"); });
    const entrypoint = new OperationsHealth({} as ExecutionContext, { DB: { prepare } } as unknown as WorkerBindings);
    const response = await entrypoint.fetch(new Request(`https://ops.internal${path}`, { method }));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("detects only stale due and expired-lease work across the three dispatchers", async () => {
    const { sqlite, check } = fixture();
    expect(await check()).toEqual({ calendar: false, import: false, notification: false });
    sqlite.prepare("INSERT INTO calendar_sync_jobs VALUES (?, 'reservation', 'reservation', 'upsert', ?, 0, ?, NULL, ?)")
      .run("calendar-future", "retryable", future, old);
    sqlite.prepare("INSERT INTO google_calendar_import_jobs VALUES (?, ?, 0, ?, NULL, ?)")
      .run("import-recent", "queued", recent, recent);
    sqlite.prepare("INSERT INTO notification_jobs VALUES (?, 'reservation', 'customer', 'reservation_confirmed', ?, 0, ?, NULL, ?)")
      .run("notification-terminal", "dead", due, old);
    expect(await check()).toEqual({ calendar: false, import: false, notification: false });

    sqlite.prepare("INSERT INTO calendar_sync_jobs VALUES (?, 'reservation', 'reservation', 'upsert', ?, 0, ?, NULL, ?)")
      .run("calendar-due", "queued", due, old);
    sqlite.prepare("INSERT INTO google_calendar_import_jobs VALUES (?, ?, 1, ?, NULL, ?)")
      .run("import-due", "retryable", due, old);
    sqlite.prepare("INSERT INTO notification_jobs VALUES (?, 'reservation', 'customer', 'reservation_confirmed', ?, 0, ?, NULL, ?)")
      .run("notification-due", "queued", due, old);
    expect(await check()).toEqual({ calendar: true, import: true, notification: true });

    sqlite.exec("DELETE FROM calendar_sync_jobs WHERE id = 'calendar-due'; DELETE FROM google_calendar_import_jobs WHERE id = 'import-due'; DELETE FROM notification_jobs WHERE id = 'notification-due'");
    sqlite.prepare("INSERT INTO calendar_sync_jobs VALUES (?, 'reservation', 'reservation', 'upsert', 'processing', 1, ?, ?, ?)")
      .run("calendar-lease", due, due, old);
    sqlite.prepare("INSERT INTO google_calendar_import_jobs VALUES (?, 'processing', 1, ?, ?, ?)")
      .run("import-lease", due, due, old);
    sqlite.prepare("INSERT INTO notification_jobs VALUES (?, 'reservation', 'customer', 'reservation_confirmed', 'processing', 1, ?, ?, ?)")
      .run("notification-lease", due, due, old);
    expect(await check()).toEqual({ calendar: true, import: true, notification: true });

    // Exhausted claims still need the next dispatcher to dead-letter them.
    // If that dispatcher stops, the remaining processing rows must not look healthy.
    sqlite.exec("UPDATE calendar_sync_jobs SET attempts = 5 WHERE id = 'calendar-lease'; UPDATE google_calendar_import_jobs SET attempt_count = 5 WHERE id = 'import-lease'; UPDATE notification_jobs SET attempts = 5 WHERE id = 'notification-lease'");
    expect(await check()).toEqual({ calendar: true, import: true, notification: true });

    sqlite.prepare("UPDATE calendar_sync_jobs SET locked_until = ? WHERE id = 'calendar-lease'").run(future);
    sqlite.prepare("UPDATE google_calendar_import_jobs SET locked_until = ? WHERE id = 'import-lease'").run(future);
    sqlite.prepare("UPDATE notification_jobs SET locked_until = ? WHERE id = 'notification-lease'").run(future);
    expect(await check()).toEqual({ calendar: false, import: false, notification: false });
  });

  it("ignores acknowledged, retired, ineligible and disabled work without replaying it", async () => {
    const { sqlite, check } = fixture();
    sqlite.prepare("INSERT INTO calendar_sync_jobs VALUES (?, 'reservation', 'reservation', 'insert', 'queued', 0, ?, NULL, ?)")
      .run("old-action", due, old);
    sqlite.prepare("INSERT INTO google_calendar_import_jobs VALUES (?, 'queued', 0, ?, NULL, ?)")
      .run("disabled-import", due, old);
    sqlite.prepare("INSERT INTO notification_jobs VALUES (?, 'reservation', 'customer', 'change_request_approved', 'queued', 0, ?, NULL, ?)")
      .run("retired", due, old);
    sqlite.prepare("INSERT INTO notification_jobs VALUES (?, 'reservation', 'customer', 'reservation_confirmed', 'queued', 0, ?, NULL, ?)")
      .run("acknowledged", due, old);
    sqlite.exec("INSERT INTO audit_logs VALUES ('notification_jobs', 'acknowledged', 'admin_sync_job_acknowledged')");
    expect(await check({ GOOGLE_IMPORT_ENABLED: "false" }))
      .toEqual({ calendar: false, import: false, notification: false });

    sqlite.prepare("INSERT INTO notification_jobs VALUES (?, NULL, 'owner', 'daily_ops_summary', 'queued', 0, ?, NULL, ?)")
      .run("disabled-system", due, old);
    expect(await check({ DAILY_OPS_SUMMARY_DISPATCH_ENABLED: "false" }))
      .toEqual({ calendar: false, import: true, notification: false });
    expect(await check({ DAILY_OPS_SUMMARY_DISPATCH_ENABLED: "true" }))
      .toEqual({ calendar: false, import: true, notification: true });
  });

  it("rejects malformed D1 evidence instead of reporting a healthy state", async () => {
    const broken = { prepare: () => ({ bind: () => ({ first: async () => ({ calendar: 0 }) }) }) };
    await expect(readOperationsHealth(broken as unknown as D1Database, {}, now))
      .rejects.toThrow("operations_health_invalid_result");
  });
});
