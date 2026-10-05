import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dispatchReservationReminders } from "../src/notifications/reminder-dispatcher";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

// ── Time anchors ──────────────────────────────────────────────────────
// Reservation at 10:00 UTC, dispatcher runs at 09:35 UTC (25 min before).
const RESERVATION_START = "2026-06-01T10:00:00.000Z";
const NOW_MS = Date.parse("2026-06-01T09:35:00.000Z");

// ── Seed helpers ──────────────────────────────────────────────────────
const STORE_ID = "kyoto";
const LINE_IDENTITY_ID = "line_identity_vsupersede_1";
const CUSTOMER_ID = "customer_vsupersede_1";

const seedCustomer = (d1: SqliteD1Database) => {
  d1.sqlite.exec(
    `INSERT OR IGNORE INTO customers (id, display_name, display_name_kana, phone_hash, block_status)
     VALUES ('${CUSTOMER_ID}', 'Test Supersede', 'テストスーパーシード', 'hash_vsupersede_1', 'active')`
  );
};

const seedLineIdentity = (d1: SqliteD1Database) => {
  d1.sqlite.exec(
    `INSERT OR IGNORE INTO line_identities (id, customer_id, provider, channel_id, line_user_id)
     VALUES ('${LINE_IDENTITY_ID}', '${CUSTOMER_ID}', 'line', 'ch_vsupersede', 'U0000000000000000000000000000099')`
  );
};

const seedReservation = (
  d1: SqliteD1Database,
  opts: { id: string; version?: number }
) => {
  const version = opts.version ?? 1;
  const endAt = new Date(Date.parse(RESERVATION_START) + 60 * 60 * 1000).toISOString();
  d1.sqlite.exec(
    `INSERT INTO reservations (
       id, store_id, service_id, customer_id, resource_id, line_identity_id,
       source, status, start_at, end_at, duration_minutes,
       idempotency_key, version
     ) VALUES (
       '${opts.id}', '${STORE_ID}',
       'service_${STORE_ID}_default_60',
       '${CUSTOMER_ID}',
       'resource_${STORE_ID}_calendar',
       '${LINE_IDENTITY_ID}',
       'web_line', 'confirmed', '${RESERVATION_START}', '${endAt}', 60,
       'idem_vsupersede_${opts.id}', ${version}
     )`
  );
};

const setReminderOffset = (d1: SqliteD1Database, offsetMinutes: number) => {
  d1.sqlite.exec(
    `UPDATE store_settings
     SET reservation_reminder_offset_minutes = ${offsetMinutes}
     WHERE store_id = '${STORE_ID}'`
  );
};

const getNotificationJobsByTemplate = (d1: SqliteD1Database, templateKey: string) => {
  return d1.sqlite
    .prepare("SELECT dedupe_key, status FROM notification_jobs WHERE template_key = ? ORDER BY created_at")
    .all(templateKey) as Array<{ dedupe_key: string; status: string }>;
};

// ── Tests ─────────────────────────────────────────────────────────────
describe("reminder dispatcher version-supersede regression", () => {
  let d1: SqliteD1Database;

  beforeEach(() => {
    d1 = createMigratedSqliteD1();
    seedCustomer(d1);
    seedLineIdentity(d1);
    setReminderOffset(d1, 30);
  });

  afterEach(() => {
    d1.sqlite.close();
  });

  it("enqueues a fresh reminder after version bump (version=1 row + version=2 row coexist)", async () => {
    seedReservation(d1, { id: "res_v1", version: 1 });

    // First dispatch at version=1
    const first = await dispatchReservationReminders(d1 as unknown as D1Database, NOW_MS);
    expect(first).toEqual({ scanned: 1, enqueued: 1 });

    // Simulate reservation edit: bump version to 2
    d1.sqlite.exec("UPDATE reservations SET version = 2 WHERE id = 'res_v1'");

    // Second dispatch at version=2
    const second = await dispatchReservationReminders(d1 as unknown as D1Database, NOW_MS);
    expect(second).toEqual({ scanned: 1, enqueued: 1 });

    // Both rows exist with distinct dedupe_keys
    const jobs = getNotificationJobsByTemplate(d1, "reservation_reminder");
    expect(jobs).toHaveLength(2);
    expect(jobs[0].dedupe_key).toBe(
      "reservation:res_v1:template:reservation_reminder:revision:1"
    );
    expect(jobs[1].dedupe_key).toBe(
      "reservation:res_v1:template:reservation_reminder:revision:2"
    );
    // Prior version=1 row is still queued (not deleted or superseded)
    expect(jobs[0].status).toBe("queued");
    expect(jobs[1].status).toBe("queued");
  });

  it("does not duplicate on same-version double dispatch (INSERT OR IGNORE)", async () => {
    seedReservation(d1, { id: "res_same_v", version: 3 });

    const first = await dispatchReservationReminders(d1 as unknown as D1Database, NOW_MS);
    expect(first).toEqual({ scanned: 1, enqueued: 1 });

    // Second invocation: NOT EXISTS pre-filter blocks the candidate
    const second = await dispatchReservationReminders(d1 as unknown as D1Database, NOW_MS);
    expect(second).toEqual({ scanned: 0, enqueued: 0 });

    const jobs = getNotificationJobsByTemplate(d1, "reservation_reminder");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].dedupe_key).toBe(
      "reservation:res_same_v:template:reservation_reminder:revision:3"
    );
  });

  it("dedupe_key format includes reservation id and version", async () => {
    seedReservation(d1, { id: "res_fmt", version: 7 });

    await dispatchReservationReminders(d1 as unknown as D1Database, NOW_MS);

    const jobs = getNotificationJobsByTemplate(d1, "reservation_reminder");
    expect(jobs).toHaveLength(1);
    // Verify the exact dedupe_key pattern:
    // reservation:{id}:template:reservation_reminder:revision:{version}
    expect(jobs[0].dedupe_key).toMatch(
      /^reservation:res_fmt:template:reservation_reminder:revision:7$/
    );
  });
});
