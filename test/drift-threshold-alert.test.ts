import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  evaluateDriftThreshold,
  DRIFT_ALERT_THRESHOLD,
  __testing__
} from "../src/google/drift-threshold-alert";
import { createMigratedSqliteD1 } from "./helpers/sqlite-d1";

const { enqueueDriftAlertNotifications, sha256Hex16 } = __testing__;

const STORE_ID = "store_kyoto";
const CALENDAR_ID = "calendar-a@example.invalid";
const OPS_RECIPIENT_1 = "U" + "a".repeat(32);
const OPS_RECIPIENT_2 = "U" + "b".repeat(32);
const OWNER_EMAIL_RECIPIENT_ID = "email:owner";
const NOW_MS = 1_800_000_000_000; // 2027-01-15 08:00:00 UTC

const makeEnv = (overrides: Partial<{
  LINE_OPERATIONS_USER_IDS: string;
  GOOGLE_DRIFT_ALERT_LIVE: string;
}> = {}) => ({
  LINE_OPERATIONS_USER_IDS: `${OPS_RECIPIENT_1},${OPS_RECIPIENT_2}`,
  GOOGLE_DRIFT_ALERT_LIVE: "true",
  ...overrides
});

describe("enqueueDriftAlertNotifications", () => {
  let d1: ReturnType<typeof createMigratedSqliteD1>;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    d1 = createMigratedSqliteD1();
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    d1.sqlite.close();
  });

  it("enqueues one owner email job independent of LINE recipients", async () => {
    const result = await enqueueDriftAlertNotifications({
      db: d1 as unknown as D1Database,
      env: makeEnv(),
      storeId: STORE_ID,
      calendarId: CALENDAR_ID,
      googleCount: 30,
      d1Count: 45,
      drift: 15,
      nowMs: NOW_MS
    });

    expect(result.insertedCount).toBe(1);
    expect(result.existingCount).toBe(0);
    expect(result.jobIds).toHaveLength(1);

    const jobs = d1.sqlite
      .prepare(
        `SELECT id, recipient_id, dedupe_key, payload_json, status, recipient_type, template_key
         FROM notification_jobs
         WHERE template_key = 'google_drift_alert'
         ORDER BY recipient_id`
      )
      .all() as Array<{
      id: string;
      recipient_id: string;
      dedupe_key: string;
      payload_json: string;
      status: string;
      recipient_type: string;
      template_key: string;
    }>;

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.recipient_id).toBe(OWNER_EMAIL_RECIPIENT_ID);

    for (const job of jobs) {
      expect(job.recipient_type).toBe("owner");
      expect(job.status).toBe("queued");
      expect(job.template_key).toBe("google_drift_alert");
    }
  });

  it("dedupe_key contains date, store, cal hash, and recipient hash — no raw PII", async () => {
    await enqueueDriftAlertNotifications({
      db: d1 as unknown as D1Database,
      env: makeEnv(),
      storeId: STORE_ID,
      calendarId: CALENDAR_ID,
      googleCount: 10,
      d1Count: 25,
      drift: 15,
      nowMs: NOW_MS
    });

    const jobs = d1.sqlite
      .prepare(
        `SELECT dedupe_key FROM notification_jobs WHERE template_key = 'google_drift_alert'`
      )
      .all() as Array<{ dedupe_key: string }>;

    const utcDate = new Date(NOW_MS).toISOString().slice(0, 10);

    for (const job of jobs) {
      expect(job.dedupe_key).toMatch(
        new RegExp(
          `^google_drift_alert:v1:${utcDate}:store:${STORE_ID}:cal:[0-9a-f]{32}:recipient:[0-9a-f]{32}$`
        )
      );
      // Raw LINE user IDs must NOT appear in the dedupe key
      expect(job.dedupe_key).not.toContain(OPS_RECIPIENT_1);
      expect(job.dedupe_key).not.toContain(OPS_RECIPIENT_2);
    }
  });

  it("payload_json contains safe numeric counts and threshold", async () => {
    await enqueueDriftAlertNotifications({
      db: d1 as unknown as D1Database,
      env: makeEnv(),
      storeId: STORE_ID,
      calendarId: CALENDAR_ID,
      googleCount: 30,
      d1Count: 45,
      drift: 15,
      nowMs: NOW_MS
    });

    const jobs = d1.sqlite
      .prepare(
        `SELECT payload_json FROM notification_jobs WHERE template_key = 'google_drift_alert'`
      )
      .all() as Array<{ payload_json: string }>;

    for (const job of jobs) {
      const payload = JSON.parse(job.payload_json) as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual([
        "d1_count",
        "drift",
        "google_count",
        "store_id",
        "threshold"
      ]);
      expect(payload.store_id).toBe(STORE_ID);
      expect(payload.google_count).toBe(30);
      expect(payload.d1_count).toBe(45);
      expect(payload.drift).toBe(15);
      expect(payload.threshold).toBe(DRIFT_ALERT_THRESHOLD);
    }
  });

  it("clamps negative and fractional counts to safe integers", async () => {
    await enqueueDriftAlertNotifications({
      db: d1 as unknown as D1Database,
      env: makeEnv(),
      storeId: STORE_ID,
      calendarId: CALENDAR_ID,
      googleCount: -5.7,
      d1Count: 3.14,
      drift: -2.1,
      nowMs: NOW_MS
    });

    const job = d1.sqlite
      .prepare(
        `SELECT payload_json FROM notification_jobs WHERE template_key = 'google_drift_alert' LIMIT 1`
      )
      .get() as { payload_json: string };

    const payload = JSON.parse(job.payload_json) as Record<string, unknown>;
    expect(payload.google_count).toBe(0);
    expect(payload.d1_count).toBe(3);
    expect(payload.drift).toBe(0);
  });

  it("enqueues one email job when LINE_OPERATIONS_USER_IDS is empty", async () => {
    const result = await enqueueDriftAlertNotifications({
      db: d1 as unknown as D1Database,
      env: makeEnv({ LINE_OPERATIONS_USER_IDS: "" }),
      storeId: STORE_ID,
      calendarId: CALENDAR_ID,
      googleCount: 30,
      d1Count: 45,
      drift: 15,
      nowMs: NOW_MS
    });

    expect(result.insertedCount).toBe(1);
    expect(result.existingCount).toBe(0);
    expect(result.jobIds).toHaveLength(1);

    const count = d1.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM notification_jobs`)
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("INSERT OR IGNORE deduplicates same-date re-runs to one email per day", async () => {
    const args = {
      db: d1 as unknown as D1Database,
      env: makeEnv(),
      storeId: STORE_ID,
      calendarId: CALENDAR_ID,
      googleCount: 30,
      d1Count: 45,
      drift: 15,
      nowMs: NOW_MS
    };

    const first = await enqueueDriftAlertNotifications(args);
    const second = await enqueueDriftAlertNotifications(args);

    expect(first.insertedCount).toBe(1);
    expect(second.insertedCount).toBe(0);
    expect(second.existingCount).toBe(1);

    const count = d1.sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM notification_jobs WHERE template_key = 'google_drift_alert'`
      )
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("different dates produce separate alerts (no cross-day dedup)", async () => {
    const dayOneMs = NOW_MS;
    const dayTwoMs = NOW_MS + 24 * 60 * 60 * 1000;

    await enqueueDriftAlertNotifications({
      db: d1 as unknown as D1Database,
      env: makeEnv(),
      storeId: STORE_ID,
      calendarId: CALENDAR_ID,
      googleCount: 30,
      d1Count: 45,
      drift: 15,
      nowMs: dayOneMs
    });

    await enqueueDriftAlertNotifications({
      db: d1 as unknown as D1Database,
      env: makeEnv(),
      storeId: STORE_ID,
      calendarId: CALENDAR_ID,
      googleCount: 30,
      d1Count: 45,
      drift: 15,
      nowMs: dayTwoMs
    });

    const count = d1.sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM notification_jobs WHERE template_key = 'google_drift_alert'`
      )
      .get() as { n: number };
    expect(count.n).toBe(2);
  });

  it("does not report missing LINE recipients for an email-only alert", async () => {
    await enqueueDriftAlertNotifications({
      db: d1 as unknown as D1Database,
      env: makeEnv({ LINE_OPERATIONS_USER_IDS: "" }),
      storeId: STORE_ID,
      calendarId: CALENDAR_ID,
      googleCount: 30,
      d1Count: 45,
      drift: 15,
      nowMs: NOW_MS
    });

    const logLines = (consoleSpy.mock.calls as unknown[][])
      .map((call) => {
        try {
          return JSON.parse(call[0] as string);
        } catch {
          return null;
        }
      })
      .filter(
        (parsed): parsed is Record<string, unknown> =>
          parsed !== null &&
          typeof parsed === "object" &&
          (parsed as Record<string, unknown>).event_type === "google_drift_alert_no_recipients"
      );

    expect(logLines).toHaveLength(0);
    const count = d1.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM notification_jobs WHERE template_key = 'google_drift_alert'`)
      .get() as { n: number };
    expect(count.n).toBe(1);
  });
});

describe("evaluateDriftThreshold", () => {
  let d1: ReturnType<typeof createMigratedSqliteD1>;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    d1 = createMigratedSqliteD1();
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    d1.sqlite.close();
  });

  const driftLogLines = () =>
    (consoleSpy.mock.calls as unknown[][])
      .map((call) => {
        try {
          return JSON.parse(call[0] as string);
        } catch {
          return null;
        }
      })
      .filter(
        (parsed): parsed is Record<string, unknown> =>
          parsed !== null &&
          typeof parsed === "object" &&
          (parsed as Record<string, unknown>).event_type === "google_drift_alert"
      );

  it("returns alerted=false and null enqueueResult when drift < threshold", async () => {
    const result = await evaluateDriftThreshold({
      db: d1 as unknown as D1Database,
      env: makeEnv(),
      storeId: STORE_ID,
      calendarId: CALENDAR_ID,
      googleCount: 100,
      d1Count: 105,
      drift: DRIFT_ALERT_THRESHOLD - 1,
      nowMs: NOW_MS
    });

    expect(result.alerted).toBe(false);
    expect(result.enqueueResult).toBeNull();
    expect(driftLogLines()).toHaveLength(0);

    const count = d1.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM notification_jobs`)
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("returns alerted=false when drift = threshold - 1 (boundary)", async () => {
    const result = await evaluateDriftThreshold({
      db: d1 as unknown as D1Database,
      env: makeEnv(),
      storeId: STORE_ID,
      calendarId: CALENDAR_ID,
      googleCount: 50,
      d1Count: 50 + DRIFT_ALERT_THRESHOLD - 1,
      drift: DRIFT_ALERT_THRESHOLD - 1,
      nowMs: NOW_MS
    });

    expect(result.alerted).toBe(false);
    expect(result.enqueueResult).toBeNull();
  });

  it("logs google_drift_alert and enqueues when drift = threshold (exact boundary)", async () => {
    const result = await evaluateDriftThreshold({
      db: d1 as unknown as D1Database,
      env: makeEnv(),
      storeId: STORE_ID,
      calendarId: CALENDAR_ID,
      googleCount: 50,
      d1Count: 50 + DRIFT_ALERT_THRESHOLD,
      drift: DRIFT_ALERT_THRESHOLD,
      nowMs: NOW_MS
    });

    expect(result.alerted).toBe(true);
    expect(result.enqueueResult).not.toBeNull();
    expect(result.enqueueResult!.insertedCount).toBe(1);

    const logs = driftLogLines();
    expect(logs).toHaveLength(1);
    expect(logs[0].drift).toBe(DRIFT_ALERT_THRESHOLD);
  });

  it("logs google_drift_alert and enqueues when drift > threshold", async () => {
    const result = await evaluateDriftThreshold({
      db: d1 as unknown as D1Database,
      env: makeEnv(),
      storeId: STORE_ID,
      calendarId: CALENDAR_ID,
      googleCount: 30,
      d1Count: 50,
      drift: 20,
      nowMs: NOW_MS
    });

    expect(result.alerted).toBe(true);
    expect(result.enqueueResult).not.toBeNull();
    expect(result.enqueueResult!.insertedCount).toBe(1);
    expect(result.enqueueResult!.jobIds).toHaveLength(1);
  });

  it("logs google_drift_alert but does NOT enqueue when GOOGLE_DRIFT_ALERT_LIVE=false (log-only mode)", async () => {
    const result = await evaluateDriftThreshold({
      db: d1 as unknown as D1Database,
      env: makeEnv({ GOOGLE_DRIFT_ALERT_LIVE: "false" }),
      storeId: STORE_ID,
      calendarId: CALENDAR_ID,
      googleCount: 30,
      d1Count: 50,
      drift: 20,
      nowMs: NOW_MS
    });

    expect(result.alerted).toBe(false);
    expect(result.enqueueResult).toBeNull();

    // Log event still emitted for offline analysis
    const logs = driftLogLines();
    expect(logs).toHaveLength(1);
    expect(logs[0].google_tracked_count).toBe(30);
    expect(logs[0].d1_tracked_count).toBe(50);
    expect(logs[0].drift).toBe(20);

    // No notification_jobs rows created
    const count = d1.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM notification_jobs`)
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("drift log event includes store_id, calendar_id, and counts", async () => {
    await evaluateDriftThreshold({
      db: d1 as unknown as D1Database,
      env: makeEnv({ GOOGLE_DRIFT_ALERT_LIVE: "false" }),
      storeId: STORE_ID,
      calendarId: CALENDAR_ID,
      googleCount: 25,
      d1Count: 40,
      drift: 15,
      nowMs: NOW_MS
    });

    const logs = driftLogLines();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      event_type: "google_drift_alert",
      outcome: "noop",
      calendar_id: CALENDAR_ID,
      store_id: STORE_ID,
      google_tracked_count: 25,
      d1_tracked_count: 40,
      drift: 15
    });
  });

  it("returns alerted=false when drift = 0 (no discrepancy)", async () => {
    const result = await evaluateDriftThreshold({
      db: d1 as unknown as D1Database,
      env: makeEnv(),
      storeId: STORE_ID,
      calendarId: CALENDAR_ID,
      googleCount: 100,
      d1Count: 100,
      drift: 0,
      nowMs: NOW_MS
    });

    expect(result.alerted).toBe(false);
    expect(result.enqueueResult).toBeNull();
    expect(driftLogLines()).toHaveLength(0);
  });
});

describe("sha256Hex16 (shared hash function)", () => {
  it("returns exactly 32 hex characters (128 bits)", async () => {
    const hashed = await sha256Hex16("test-input");
    expect(hashed).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is deterministic", async () => {
    const a = await sha256Hex16("same-input");
    const b = await sha256Hex16("same-input");
    expect(a).toBe(b);
  });

  it("produces different outputs for different inputs", async () => {
    const a = await sha256Hex16("input-a");
    const b = await sha256Hex16("input-b");
    expect(a).not.toBe(b);
  });
});

describe("DRIFT_ALERT_THRESHOLD constant", () => {
  it("is 10", () => {
    expect(DRIFT_ALERT_THRESHOLD).toBe(10);
  });
});
