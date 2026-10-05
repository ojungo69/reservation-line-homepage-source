import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dispatchReservationReminders } from "../src/notifications/reminder-dispatcher";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

// ── Time anchors ──────────────────────────────────────────────────────
// All tests use a fixed "now" so arithmetic is deterministic.
// Reservation at 10:00 UTC, dispatcher runs at 09:35 UTC.
const RESERVATION_START = "2026-06-01T10:00:00.000Z";
const NOW_MS = Date.parse("2026-06-01T09:35:00.000Z"); // 25 min before start

// ── Seed helpers ──────────────────────────────────────────────────────
const STORE_ID = "kyoto";
const STORE_ID_B = "osaka";
const LINE_IDENTITY_ID = "line_identity_reminder_1";
const CUSTOMER_ID = "customer_reminder_1";

const seedCustomer = (d1: SqliteD1Database, id: string) => {
  d1.sqlite.exec(
    `INSERT OR IGNORE INTO customers (id, display_name, display_name_kana, phone_hash, block_status)
     VALUES ('${id}', 'Test Customer', 'テストカスタマー', 'hash_reminder_1', 'active')`
  );
};

const seedLineIdentity = (
  d1: SqliteD1Database,
  id: string,
  customerId: string,
  lineUserId: string
) => {
  d1.sqlite.exec(
    `INSERT OR IGNORE INTO line_identities (id, customer_id, provider, channel_id, line_user_id)
     VALUES ('${id}', '${customerId}', 'line', 'ch_1', '${lineUserId}')`
  );
};

const seedReservation = (
  d1: SqliteD1Database,
  opts: {
    id: string;
    storeId: string;
    status?: string;
    startAt?: string;
    lineIdentityId?: string | null;
    version?: number;
  }
) => {
  const status = opts.status ?? "confirmed";
  const startAt = opts.startAt ?? RESERVATION_START;
  const lineIdentityId = opts.lineIdentityId === undefined ? LINE_IDENTITY_ID : opts.lineIdentityId;
  const version = opts.version ?? 1;
  // end_at must be > start_at
  const endAt = new Date(Date.parse(startAt) + 60 * 60 * 1000).toISOString();
  d1.sqlite.exec(
    `INSERT INTO reservations (
       id, store_id, service_id, customer_id, resource_id, line_identity_id,
       source, status, start_at, end_at, duration_minutes,
       idempotency_key, version
     ) VALUES (
       '${opts.id}', '${opts.storeId}',
       'service_${opts.storeId}_default_60',
       '${CUSTOMER_ID}',
       'resource_${opts.storeId}_calendar',
       ${lineIdentityId === null ? "NULL" : `'${lineIdentityId}'`},
       'web_line', '${status}', '${startAt}', '${endAt}', 60,
       'idem_${opts.id}', ${version}
     )`
  );
};

const setReminderOffset = (d1: SqliteD1Database, storeId: string, offsetMinutes: number | null) => {
  d1.sqlite.exec(
    `UPDATE store_settings
     SET reservation_reminder_offset_minutes = ${offsetMinutes === null ? "NULL" : offsetMinutes}
     WHERE store_id = '${storeId}'`
  );
};

const countNotificationJobs = (d1: SqliteD1Database, templateKey: string): number => {
  const row = d1.sqlite
    .prepare("SELECT count(*) AS cnt FROM notification_jobs WHERE template_key = ?")
    .get(templateKey) as { cnt: number };
  return row.cnt;
};

const getNotificationJobDedupeKeys = (d1: SqliteD1Database, templateKey: string): string[] => {
  const rows = d1.sqlite
    .prepare("SELECT dedupe_key FROM notification_jobs WHERE template_key = ? ORDER BY created_at")
    .all(templateKey) as Array<{ dedupe_key: string }>;
  return rows.map((r) => r.dedupe_key);
};

// ── Tests ─────────────────────────────────────────────────────────────
describe("reservation reminder dispatch", () => {
  let d1: SqliteD1Database;

  beforeEach(() => {
    d1 = createMigratedSqliteD1();
    seedCustomer(d1, CUSTOMER_ID);
    seedLineIdentity(d1, LINE_IDENTITY_ID, CUSTOMER_ID, "U0000000000000000000000000000001");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    d1.sqlite.close();
  });

  it("enqueues 1 job for a confirmed reservation within the reminder window", async () => {
    setReminderOffset(d1, STORE_ID, 30);
    seedReservation(d1, { id: "res_1", storeId: STORE_ID });

    const result = await dispatchReservationReminders(d1 as unknown as D1Database, NOW_MS);

    expect(result).toEqual({ scanned: 1, enqueued: 1 });
    expect(countNotificationJobs(d1, "reservation_reminder")).toBe(1);
    // Verify dedupe_key shape
    const keys = getNotificationJobDedupeKeys(d1, "reservation_reminder");
    expect(keys[0]).toBe("reservation:res_1:template:reservation_reminder:revision:1");
  });

  it("bounds independent reminder inserts and drains successes after one reservation fails", async () => {
    setReminderOffset(d1, STORE_ID, 30);
    for (let index = 0; index < 6; index += 1) {
      seedReservation(d1, { id: `res_parallel_${index}`, storeId: STORE_ID, version: 2 });
    }
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started: string[] = [];
    let inFlight = 0;
    let peak = 0;
    const prepare = d1.prepare.bind(d1);
    const batch = vi.spyOn(d1, "batch");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(d1, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (!sql.includes("INSERT OR IGNORE INTO notification_jobs")) return statement;
      return {
        bind: (...values: unknown[]) => {
          const bound = statement.bind(...values);
          return {
            run: async () => {
              const reservationId = String(values[3]);
              started.push(reservationId);
              peak = Math.max(peak, ++inFlight);
              try {
                await gate;
                if (reservationId === "res_parallel_1") throw new Error("one_reminder_write_failed");
                return await bound.run();
              } finally {
                inFlight -= 1;
              }
            }
          };
        }
      } as unknown as D1PreparedStatement;
    });

    let settled = false;
    const pending = dispatchReservationReminders(d1 as unknown as D1Database, NOW_MS).then((result) => {
      settled = true;
      return result;
    });
    try {
      await vi.waitFor(() => expect(started).toHaveLength(4), { timeout: 1000 });
      expect(settled).toBe(false);
      expect(inFlight).toBe(4);
    } finally {
      release();
      await pending;
    }
    expect(await pending).toEqual({ scanned: 6, enqueued: 5 });
    expect(peak).toBe(4);
    expect(inFlight).toBe(0);
    expect(started).toHaveLength(6);
    expect(batch).not.toHaveBeenCalled();
    const keys = getNotificationJobDedupeKeys(d1, "reservation_reminder");
    expect(keys).toHaveLength(5);
    expect(keys).toContain("reservation:res_parallel_5:template:reservation_reminder:revision:2");
    expect(keys).not.toContain("reservation:res_parallel_1:template:reservation_reminder:revision:2");
  });

  it("does not enqueue for cancelled reservations", async () => {
    setReminderOffset(d1, STORE_ID, 30);
    seedReservation(d1, { id: "res_cancelled", storeId: STORE_ID, status: "cancelled_by_admin" });

    const result = await dispatchReservationReminders(d1 as unknown as D1Database, NOW_MS);

    expect(result).toEqual({ scanned: 0, enqueued: 0 });
    expect(countNotificationJobs(d1, "reservation_reminder")).toBe(0);
  });

  it("does not enqueue when store offset is null", async () => {
    setReminderOffset(d1, STORE_ID, null);
    seedReservation(d1, { id: "res_null_offset", storeId: STORE_ID });

    const result = await dispatchReservationReminders(d1 as unknown as D1Database, NOW_MS);

    expect(result).toEqual({ scanned: 0, enqueued: 0 });
    expect(countNotificationJobs(d1, "reservation_reminder")).toBe(0);
  });

  it("does not enqueue when store offset is 0", async () => {
    setReminderOffset(d1, STORE_ID, 0);
    seedReservation(d1, { id: "res_zero_offset", storeId: STORE_ID });

    const result = await dispatchReservationReminders(d1 as unknown as D1Database, NOW_MS);

    expect(result).toEqual({ scanned: 0, enqueued: 0 });
    expect(countNotificationJobs(d1, "reservation_reminder")).toBe(0);
  });

  it("does not enqueue for past reservations", async () => {
    setReminderOffset(d1, STORE_ID, 30);
    // start_at is in the past relative to NOW_MS
    seedReservation(d1, {
      id: "res_past",
      storeId: STORE_ID,
      startAt: "2026-06-01T09:00:00.000Z"
    });

    const result = await dispatchReservationReminders(d1 as unknown as D1Database, NOW_MS);

    expect(result).toEqual({ scanned: 0, enqueued: 0 });
    expect(countNotificationJobs(d1, "reservation_reminder")).toBe(0);
  });

  it("does not enqueue when reservation is too far in the future for the offset", async () => {
    setReminderOffset(d1, STORE_ID, 10); // 10-min offset, but reservation is 25 min away
    seedReservation(d1, { id: "res_too_early", storeId: STORE_ID });

    const result = await dispatchReservationReminders(d1 as unknown as D1Database, NOW_MS);

    // The trigger time would be 10 min before start = 09:50 UTC, but now = 09:35 UTC
    // so datetime(start_at, '-10 minutes') = 09:50 > 09:35 = now => not eligible
    expect(result).toEqual({ scanned: 0, enqueued: 0 });
    expect(countNotificationJobs(d1, "reservation_reminder")).toBe(0);
  });

  it("is idempotent: invoking twice enqueues only 1 job (NOT EXISTS pre-filter)", async () => {
    setReminderOffset(d1, STORE_ID, 30);
    seedReservation(d1, { id: "res_dedup", storeId: STORE_ID });

    const first = await dispatchReservationReminders(d1 as unknown as D1Database, NOW_MS);
    const second = await dispatchReservationReminders(d1 as unknown as D1Database, NOW_MS);

    expect(first.scanned).toBe(1);
    expect(first.enqueued).toBe(1);
    // Second invocation: NOT EXISTS pre-filter excludes the already-enqueued
    // reservation, so it never reaches the scanned candidate list. INSERT OR
    // IGNORE remains as a defense-in-depth backstop against race conditions.
    expect(second.scanned).toBe(0);
    expect(second.enqueued).toBe(0);
    expect(countNotificationJobs(d1, "reservation_reminder")).toBe(1);
  });

  it("re-enqueues after version bump (reservation edited)", async () => {
    setReminderOffset(d1, STORE_ID, 30);
    seedReservation(d1, { id: "res_version", storeId: STORE_ID, version: 1 });

    const first = await dispatchReservationReminders(d1 as unknown as D1Database, NOW_MS);
    expect(first.enqueued).toBe(1);

    // Simulate reservation edit: bump version
    d1.sqlite.exec("UPDATE reservations SET version = 2 WHERE id = 'res_version'");

    const second = await dispatchReservationReminders(d1 as unknown as D1Database, NOW_MS);
    expect(second.enqueued).toBe(1);
    expect(countNotificationJobs(d1, "reservation_reminder")).toBe(2);

    const keys = getNotificationJobDedupeKeys(d1, "reservation_reminder");
    expect(keys).toContain("reservation:res_version:template:reservation_reminder:revision:1");
    expect(keys).toContain("reservation:res_version:template:reservation_reminder:revision:2");
  });

  it("handles multi-store with different offsets correctly", async () => {
    // Store A: 30-min offset (reservation 25min away => eligible)
    setReminderOffset(d1, STORE_ID, 30);
    seedReservation(d1, { id: "res_store_a", storeId: STORE_ID });

    // Store B: 60-min offset (reservation 25min away => eligible, trigger was 35min ago)
    setReminderOffset(d1, STORE_ID_B, 60);
    seedLineIdentity(d1, "line_identity_b", CUSTOMER_ID, "U0000000000000000000000000000002");
    seedReservation(d1, {
      id: "res_store_b",
      storeId: STORE_ID_B,
      lineIdentityId: "line_identity_b"
    });

    const result = await dispatchReservationReminders(d1 as unknown as D1Database, NOW_MS);

    expect(result.scanned).toBe(2);
    expect(result.enqueued).toBe(2);
    expect(countNotificationJobs(d1, "reservation_reminder")).toBe(2);
  });

  it("does not enqueue for reservations without line_identity_id", async () => {
    setReminderOffset(d1, STORE_ID, 30);
    seedReservation(d1, {
      id: "res_no_line",
      storeId: STORE_ID,
      lineIdentityId: null
    });

    const result = await dispatchReservationReminders(d1 as unknown as D1Database, NOW_MS);

    expect(result).toEqual({ scanned: 0, enqueued: 0 });
    expect(countNotificationJobs(d1, "reservation_reminder")).toBe(0);
  });

  it("sets correct notification_jobs fields", async () => {
    setReminderOffset(d1, STORE_ID, 30);
    seedReservation(d1, { id: "res_fields", storeId: STORE_ID });

    await dispatchReservationReminders(d1 as unknown as D1Database, NOW_MS);

    const row = d1.sqlite
      .prepare(
        `SELECT template_key, recipient_type, recipient_id, reservation_id, status
         FROM notification_jobs WHERE template_key = 'reservation_reminder' LIMIT 1`
      )
      .get() as {
      template_key: string;
      recipient_type: string;
      recipient_id: string;
      reservation_id: string;
      status: string;
    };

    expect(row.template_key).toBe("reservation_reminder");
    expect(row.recipient_type).toBe("customer");
    expect(row.recipient_id).toBe(LINE_IDENTITY_ID);
    expect(row.reservation_id).toBe("res_fields");
    expect(row.status).toBe("queued");
  });
});
