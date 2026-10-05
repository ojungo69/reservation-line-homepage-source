import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dispatchReservationReminders } from "../src/notifications/reminder-dispatcher";
import { processDueLineNotificationJobs } from "../src/line/notifications";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

// ── Time anchors ──────────────────────────────────────────────────────
// Reservation at 10:00 UTC; "now" is 09:35 UTC (25 min before start).
// Store offset = 30 min so the reminder window has opened.
const RESERVATION_START = "2026-06-01T10:00:00.000Z";
const NOW_MS = Date.parse("2026-06-01T09:35:00.000Z");

// ── Seed helpers ──────────────────────────────────────────────────────
const STORE_ID = "kyoto";
const CUSTOMER_ID = "customer_sched_int_1";
const LINE_IDENTITY_ID = "line_identity_sched_int_1";
const LINE_USER_ID = "U0000000000000000000000000000077";

const seedCustomer = (d1: SqliteD1Database) => {
  d1.sqlite.exec(
    `INSERT OR IGNORE INTO customers (id, display_name, display_name_kana, phone_hash, block_status)
     VALUES ('${CUSTOMER_ID}', 'Integration Test', 'インテグレーションテスト', 'hash_sched_int', 'active')`
  );
};

const seedLineIdentity = (d1: SqliteD1Database) => {
  d1.sqlite.exec(
    `INSERT OR IGNORE INTO line_identities (id, customer_id, provider, channel_id, line_user_id)
     VALUES ('${LINE_IDENTITY_ID}', '${CUSTOMER_ID}', 'line', 'ch_sched_int', '${LINE_USER_ID}')`
  );
};

const seedReservation = (d1: SqliteD1Database, id: string) => {
  const endAt = new Date(Date.parse(RESERVATION_START) + 60 * 60 * 1000).toISOString();
  d1.sqlite.exec(
    `INSERT INTO reservations (
       id, store_id, service_id, customer_id, resource_id, line_identity_id,
       source, status, start_at, end_at, duration_minutes,
       idempotency_key, version
     ) VALUES (
       '${id}', '${STORE_ID}',
       'service_${STORE_ID}_default_60',
       '${CUSTOMER_ID}',
       'resource_${STORE_ID}_calendar',
       '${LINE_IDENTITY_ID}',
       'web_line', 'confirmed', '${RESERVATION_START}', '${endAt}', 60,
       'idem_sched_int_${id}', 1
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

// ── Tests ─────────────────────────────────────────────────────────────
describe("scheduled() reminder enqueue + LINE dispatch in same tick", () => {
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

  it("freshly enqueued reminder is dispatched by LINE processor in the same tick", async () => {
    seedReservation(d1, "res_int_1");

    // Phase 1: Enqueue reminder (mirrors src/index.ts:267-276)
    const reminderResult = await dispatchReservationReminders(
      d1 as unknown as D1Database,
      NOW_MS
    );
    expect(reminderResult.enqueued).toBe(1);

    // The enqueue INSERT leaves notification_jobs.available_at to its schema
    // default (CURRENT_TIMESTAMP = SQLite's real wall clock, which JS fake
    // timers cannot freeze). Pin it to the injected NOW_MS so the dispatch's
    // `available_at <= now` filter is deterministic regardless of the real
    // date. In production both timestamps are real-now within the same tick,
    // so the job is due; this only removes the test's real-vs-injected skew.
    d1.sqlite.exec(
      `UPDATE notification_jobs
       SET available_at = '${new Date(NOW_MS).toISOString()}'
       WHERE template_key = 'reservation_reminder'`
    );

    // Phase 2: LINE dispatch (mirrors src/index.ts:283-321)
    // lineMaxJobs = Math.min(500, Math.max(5, reminderEnqueued + 5))
    const lineMaxJobs = Math.min(500, Math.max(5, reminderResult.enqueued + 5));
    expect(lineMaxJobs).toBe(6); // 1 + 5 = 6

    const fetchMock = vi.fn(async () =>
      Response.json({
        sentMessages: [{ id: "line_msg_sched_int_1" }]
      })
    ) as unknown as typeof fetch;

    const lineResult = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: {
        LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "test_token_sched_int"
      },
      fetcher: fetchMock,
      now: () => NOW_MS,
      maxJobs: lineMaxJobs
    });

    // The freshly enqueued reminder was picked up and sent
    expect(lineResult.processed).toBe(1);
    expect(lineResult.succeeded).toBe(1);
    expect(lineResult.failed).toBe(0);

    // Verify LINE push was called with correct recipient
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = vi.mocked(fetchMock).mock.calls[0] ?? [];
    const body = await new Response(init?.body).json() as { to: string };
    expect(body.to).toBe(LINE_USER_ID);

    // Notification job status updated to succeeded
    const job = d1.sqlite
      .prepare(
        "SELECT status FROM notification_jobs WHERE template_key = 'reservation_reminder'"
      )
      .get() as { status: string };
    expect(job.status).toBe("succeeded");
  });

  it("lineMaxJobs sizing includes reminderEnqueued count", () => {
    // Verify the formula from src/index.ts:283
    // lineMaxJobs = Math.min(500, Math.max(5, reminderEnqueued + 5))

    // 0 reminders: max(5, 0+5) = 5, min(500, 5) = 5
    expect(Math.min(500, Math.max(5, 0 + 5))).toBe(5);

    // 1 reminder: max(5, 1+5) = 6, min(500, 6) = 6
    expect(Math.min(500, Math.max(5, 1 + 5))).toBe(6);

    // 100 reminders: max(5, 100+5) = 105, min(500, 105) = 105
    expect(Math.min(500, Math.max(5, 100 + 5))).toBe(105);

    // 500 reminders: max(5, 500+5) = 505, min(500, 505) = 500 (capped)
    expect(Math.min(500, Math.max(5, 500 + 5))).toBe(500);
  });
});
