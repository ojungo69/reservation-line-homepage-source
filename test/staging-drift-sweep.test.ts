import { describe, expect, it, vi } from "vitest";

import { runStagingDriftSweep, __testing__ } from "../src/google/import-sync";

const DRIFT_ALERT_THRESHOLD = __testing__.DRIFT_ALERT_THRESHOLD;
import { createMigratedSqliteD1 } from "./helpers/sqlite-d1";

const STORE_ID = "store_kyoto";
const CALENDAR_ID = "kyoto@calendar.google.com";
const OWNER_LINE_USER_ID_1 = "U" + "a".repeat(32);
const OWNER_LINE_USER_ID_2 = "U" + "b".repeat(32);

const seedStore = (d1: ReturnType<typeof createMigratedSqliteD1>) => {
  d1.sqlite
    .prepare(`INSERT INTO stores (id, name, timezone, google_calendar_id) VALUES (?, ?, ?, ?)`)
    .run(STORE_ID, "ExampleStore A", "Asia/Tokyo", CALENDAR_ID);
};

const driftSweepEnv = (live: "true" | "false" = "true") =>
  ({
    LINE_OPERATIONS_USER_IDS: `${OWNER_LINE_USER_ID_1},${OWNER_LINE_USER_ID_2}`,
    GOOGLE_DRIFT_ALERT_LIVE: live,
    GOOGLE_SERVICE_ACCOUNT_EMAIL: "unused@invalid",
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
  }) as const;

describe("runStagingDriftSweep", () => {
  it("attempts every compensating delete and waits before returning the original injection error", async () => {
    const d1 = createMigratedSqliteD1();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const injectionError = new Error("injection response lost after commit");
    const attempted: unknown[] = [];
    let settled = false;
    seedStore(d1);
    d1.sqlite.prepare(
      `INSERT INTO google_calendar_events (id, store_id, calendar_id, google_event_id, source_type, status)
       VALUES ('unrelated_event', ?, ?, 'unrelated_provider_event', 'unknown', 'active')`
    ).run(STORE_ID, CALENDAR_ID);
    const db = {
      batch: async (statements: D1PreparedStatement[]) => {
        await d1.batch(statements as never);
        throw injectionError;
      },
      prepare: (sql: string) => {
        const statement = d1.prepare(sql);
        if (!sql.includes("DELETE FROM google_calendar_events WHERE id = ?")) return statement;
        return {
          bind: (...params: unknown[]) => {
            const bound = statement.bind(...params);
            return {
              run: async () => {
                attempted.push(params[0]);
                if (attempted.length === 1) throw new Error("one cleanup failed");
                await gate;
                return bound.run();
              }
            };
          }
        };
      }
    } as unknown as D1Database;
    const outcome = runStagingDriftSweep({
      db, env: driftSweepEnv(), storeId: STORE_ID, calendarId: CALENDAR_ID,
      injectCount: 5, cleanupExisting: false
    }).catch((error: unknown) => {
      settled = true;
      return error;
    });
    try {
      await vi.waitFor(() => expect(attempted).toHaveLength(5));
      expect(settled).toBe(false);
      release();
      expect(await outcome).toBe(injectionError);
      expect(new Set(attempted).size).toBe(5);
      expect(d1.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM google_calendar_events WHERE google_event_id LIKE 'drift_inject_%'"
      ).get()).toEqual({ count: 1 });
      expect(d1.sqlite.prepare("SELECT id FROM google_calendar_events WHERE id = 'unrelated_event'").get())
        .toEqual({ id: "unrelated_event" });
    } finally {
      release();
      await outcome;
      d1.sqlite.close();
    }
  });

  it("injects N rows, computes drift = N, and enqueues one owner email alert", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      seedStore(d1);
      const result = await runStagingDriftSweep({
        db: d1 as unknown as D1Database,
        env: driftSweepEnv(),
        storeId: STORE_ID,
        calendarId: CALENDAR_ID,
        injectCount: 11,
        cleanupExisting: true
      });
      expect(result.drift).toBe(11);
      expect(result.d1Count).toBe(11);
      expect(result.alertEnqueued).toBe(true);
      expect(result.insertedCount).toBe(1);
      expect(result.existingCount).toBe(0);
      expect(result.jobIds).toHaveLength(1);

      const injectRows = d1.sqlite
        .prepare(
          `SELECT COUNT(*) AS c FROM google_calendar_events WHERE google_event_id LIKE 'drift_inject_%'`
        )
        .get() as { c: number };
      expect(injectRows.c).toBe(11);

      const jobs = d1.sqlite
        .prepare(
          `SELECT COUNT(*) AS c FROM notification_jobs WHERE template_key = 'google_drift_alert'`
        )
        .get() as { c: number };
      expect(jobs.c).toBe(1);
    } finally {
      d1.sqlite.close();
    }
  });

  it("does not enqueue drift_alert when injectCount < threshold", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      seedStore(d1);
      const belowThreshold = DRIFT_ALERT_THRESHOLD - 1;
      const result = await runStagingDriftSweep({
        db: d1 as unknown as D1Database,
        env: driftSweepEnv(),
        storeId: STORE_ID,
        calendarId: CALENDAR_ID,
        injectCount: belowThreshold,
        cleanupExisting: true
      });
      expect(result.drift).toBe(belowThreshold);
      expect(result.alertEnqueued).toBe(false);
      expect(result.insertedCount).toBe(0);
      expect(result.jobIds).toHaveLength(0);

      const jobs = d1.sqlite
        .prepare(`SELECT COUNT(*) AS c FROM notification_jobs`)
        .get() as { c: number };
      expect(jobs.c).toBe(0);
    } finally {
      d1.sqlite.close();
    }
  });

  it("cleanupExisting deletes prior drift_inject rows and stale drift_alert notification_jobs (all statuses)", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      seedStore(d1);
      await runStagingDriftSweep({
        db: d1 as unknown as D1Database,
        env: driftSweepEnv(),
        storeId: STORE_ID,
        calendarId: CALENDAR_ID,
        injectCount: 11,
        cleanupExisting: true
      });

      d1.sqlite
        .prepare(
          `UPDATE notification_jobs SET status = 'succeeded' WHERE template_key = 'google_drift_alert'`
        )
        .run();

      const second = await runStagingDriftSweep({
        db: d1 as unknown as D1Database,
        env: driftSweepEnv(),
        storeId: STORE_ID,
        calendarId: CALENDAR_ID,
        injectCount: 11,
        cleanupExisting: true
      });

      expect(second.drift).toBe(11);
      expect(second.insertedCount).toBe(1);
      expect(second.existingCount).toBe(0);

      const injectRows = d1.sqlite
        .prepare(
          `SELECT COUNT(*) AS c FROM google_calendar_events WHERE google_event_id LIKE 'drift_inject_%'`
        )
        .get() as { c: number };
      expect(injectRows.c).toBe(11);

      const jobs = d1.sqlite
        .prepare(
          `SELECT COUNT(*) AS c FROM notification_jobs WHERE template_key = 'google_drift_alert'`
        )
        .get() as { c: number };
      expect(jobs.c).toBe(1);
    } finally {
      d1.sqlite.close();
    }
  });

  it("re-run with cleanupExisting=false reports the existing owner email job", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      seedStore(d1);
      await runStagingDriftSweep({
        db: d1 as unknown as D1Database,
        env: driftSweepEnv(),
        storeId: STORE_ID,
        calendarId: CALENDAR_ID,
        injectCount: 11,
        cleanupExisting: true
      });

      const second = await runStagingDriftSweep({
        db: d1 as unknown as D1Database,
        env: driftSweepEnv(),
        storeId: STORE_ID,
        calendarId: CALENDAR_ID,
        injectCount: 11,
        cleanupExisting: false
      });

      expect(second.alertEnqueued).toBe(true);
      expect(second.insertedCount).toBe(0);
      expect(second.existingCount).toBe(1);
    } finally {
      d1.sqlite.close();
    }
  });

  it("does not enqueue drift_alert when GOOGLE_DRIFT_ALERT_LIVE !== 'true' even if drift >= threshold", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      seedStore(d1);
      const result = await runStagingDriftSweep({
        db: d1 as unknown as D1Database,
        env: driftSweepEnv("false"),
        storeId: STORE_ID,
        calendarId: CALENDAR_ID,
        injectCount: 11,
        cleanupExisting: true
      });
      expect(result.drift).toBe(11);
      expect(result.alertEnqueued).toBe(false);
      expect(result.insertedCount).toBe(0);
      expect(result.jobIds).toHaveLength(0);
    } finally {
      d1.sqlite.close();
    }
  });

  it("enqueues the owner email alert when LINE_OPERATIONS_USER_IDS is empty", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      seedStore(d1);
      const result = await runStagingDriftSweep({
        db: d1 as unknown as D1Database,
        env: {
          LINE_OPERATIONS_USER_IDS: "",
          GOOGLE_DRIFT_ALERT_LIVE: "true",
          GOOGLE_SERVICE_ACCOUNT_EMAIL: "unused@invalid",
          GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
        },
        storeId: STORE_ID,
        calendarId: CALENDAR_ID,
        injectCount: 11,
        cleanupExisting: true
      });
      expect(result.alertEnqueued).toBe(true);
      expect(result.insertedCount).toBe(1);
      expect(result.jobIds).toHaveLength(1);

      const jobs = d1.sqlite
        .prepare(`SELECT COUNT(*) AS c FROM notification_jobs`)
        .get() as { c: number };
      expect(jobs.c).toBe(1);
    } finally {
      d1.sqlite.close();
    }
  });
});
