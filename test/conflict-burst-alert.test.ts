import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { detectConflictBursts } from "../src/google/conflict-burst-detector";
import { createMigratedSqliteD1 } from "./helpers/sqlite-d1";

const STORE_ID = "kyoto";
const CALENDAR_ID = "calendar-a@example.invalid";
const OPS_RECIPIENT_1 = "U" + "1".repeat(32);
const OPS_RECIPIENT_2 = "U" + "2".repeat(32);
const OWNER_EMAIL_RECIPIENT_ID = "email:owner";

const insertCalendarAuth = (d1: ReturnType<typeof createMigratedSqliteD1>) => {
  // calendar_auth_connections row is not strictly required by the detector
  // SQL (it joins only google_calendar_conflicts + stores), but keeping the
  // fixture realistic catches any future writer that adds a JOIN.
  d1.sqlite
    .prepare(
      `INSERT INTO calendar_auth_connections (id, store_id, provider, calendar_id, service_account_email, status)
       VALUES ('auth_1', ?, 'google', ?, 'svc@example.iam.gserviceaccount.com', 'active')`
    )
    .run(STORE_ID, CALENDAR_ID);
};

const seedConflict = (
  d1: ReturnType<typeof createMigratedSqliteD1>,
  options: { id: string; createdAt: string; resolutionStatus?: string; storeId?: string; calendarId?: string }
) => {
  d1.sqlite
    .prepare(
      `INSERT INTO google_calendar_conflicts (
         id, store_id, calendar_id, google_event_id, conflict_type,
         google_safe_snapshot_json, resolution_status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      options.id,
      options.storeId ?? STORE_ID,
      options.calendarId ?? CALENDAR_ID,
      `gevent_${options.id}`,
      "duplicate_event",
      "{}",
      options.resolutionStatus ?? "open",
      options.createdAt
    );
};

const sweepNowMs = 1_800_000_000_000; // 2027-01-15 08:00:00 UTC
const insideWindow = new Date(sweepNowMs - 60 * 1000).toISOString(); // 1 min ago
const outsideWindow = new Date(sweepNowMs - 6 * 60 * 1000).toISOString(); // 6 min ago

const baseEnv = {
  LINE_OPERATIONS_USER_IDS: `${OPS_RECIPIENT_1},${OPS_RECIPIENT_2}`,
  GOOGLE_CONFLICT_BURST_ALERT_LIVE: "false"
};

describe("detectConflictBursts (Tier D.3)", () => {
  let d1: ReturnType<typeof createMigratedSqliteD1>;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    d1 = createMigratedSqliteD1();
    insertCalendarAuth(d1);
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    d1.sqlite.close();
  });

  const burstLogLines = (eventTypeFilter?: string) =>
    (consoleSpy.mock.calls as unknown[][])
      .map((call) => {
        try {
          return JSON.parse(call[0] as string);
        } catch {
          return null;
        }
      })
      .filter((parsed): parsed is Record<string, unknown> => {
        if (parsed === null || typeof parsed !== "object") return false;
        const type = (parsed as Record<string, unknown>).event_type;
        return typeof type === "string" && type.startsWith("google_conflict_burst");
      })
      .filter((parsed) =>
        eventTypeFilter ? (parsed as Record<string, unknown>).event_type === eventTypeFilter : true
      );

  it("emits no burst log when conflicts below threshold (9 in window)", async () => {
    for (let index = 0; index < 9; index += 1) {
      seedConflict(d1, { id: `c_${index}`, createdAt: insideWindow });
    }
    await detectConflictBursts({
      db: d1 as unknown as D1Database,
      env: baseEnv,
      nowMs: sweepNowMs
    });
    expect(burstLogLines("google_conflict_burst_alert")).toHaveLength(0);
  });

  it("bounds independent alert inserts and drains later clusters after one write fails", async () => {
    for (let calendar = 0; calendar < 6; calendar += 1) {
      for (let index = 0; index < 10; index += 1) {
        seedConflict(d1, { id: `parallel_${calendar}_${index}`, calendarId: `parallel_calendar_${calendar}`, createdAt: insideWindow });
      }
    }
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started: string[] = [];
    let inFlight = 0;
    let peak = 0;
    const prepare = d1.prepare.bind(d1);
    vi.spyOn(d1, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (!sql.includes("INSERT OR IGNORE INTO notification_jobs")) return statement;
      return {
        bind: (...values: unknown[]) => {
          const bound = statement.bind(...values);
          return {
            run: async () => {
              const { calendar_id: calendarId } = JSON.parse(String(values[3])) as { calendar_id: string };
              started.push(calendarId);
              peak = Math.max(peak, ++inFlight);
              try {
                await gate;
                if (calendarId === "parallel_calendar_1") throw new Error("one_alert_write_failed");
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
    const pending = detectConflictBursts({
      db: d1 as unknown as D1Database,
      env: { GOOGLE_CONFLICT_BURST_ALERT_LIVE: "true" },
      nowMs: sweepNowMs
    }).then(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(started).toHaveLength(4), { timeout: 1000 });
      expect(settled).toBe(false);
      expect(inFlight).toBe(4);
    } finally {
      release();
      await pending;
    }
    expect(peak).toBe(4);
    expect(inFlight).toBe(0);
    expect(started).toHaveLength(6);
    expect(burstLogLines("google_conflict_burst_alert_enqueue_failed")).toHaveLength(1);
    const jobs = d1.sqlite.prepare("SELECT payload_json FROM notification_jobs WHERE template_key = 'google_conflict_burst_alert'").all() as { payload_json: string }[];
    expect(jobs).toHaveLength(5);
    expect(jobs.map((job) => JSON.parse(job.payload_json).calendar_id)).toContain("parallel_calendar_5");
    expect(jobs.map((job) => JSON.parse(job.payload_json).calendar_id)).not.toContain("parallel_calendar_1");
  });

  it("emits google_conflict_burst_alert log when conflicts reach threshold (10 in 5-min window)", async () => {
    for (let index = 0; index < 10; index += 1) {
      seedConflict(d1, { id: `c_${index}`, createdAt: insideWindow });
    }
    await detectConflictBursts({
      db: d1 as unknown as D1Database,
      env: baseEnv,
      nowMs: sweepNowMs
    });
    const logs = burstLogLines("google_conflict_burst_alert");
    expect(logs).toHaveLength(1);
    expect(logs[0].calendar_id).toBe(CALENDAR_ID);
    expect(logs[0].store_id).toBe(STORE_ID);
    expect(logs[0].conflict_count).toBe(10);
    expect(logs[0].threshold).toBe(10);
    expect(logs[0].window_minutes).toBe(5);
  });

  it("does NOT enqueue notification_jobs when GOOGLE_CONFLICT_BURST_ALERT_LIVE=false", async () => {
    for (let index = 0; index < 12; index += 1) {
      seedConflict(d1, { id: `c_${index}`, createdAt: insideWindow });
    }
    await detectConflictBursts({
      db: d1 as unknown as D1Database,
      env: { ...baseEnv, GOOGLE_CONFLICT_BURST_ALERT_LIVE: "false" },
      nowMs: sweepNowMs
    });
    const count = d1.sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM notification_jobs WHERE template_key = 'google_conflict_burst_alert'`
      )
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("enqueues one owner email job when flag=true and threshold hit", async () => {
    for (let index = 0; index < 12; index += 1) {
      seedConflict(d1, { id: `c_${index}`, createdAt: insideWindow });
    }
    await detectConflictBursts({
      db: d1 as unknown as D1Database,
      env: { ...baseEnv, GOOGLE_CONFLICT_BURST_ALERT_LIVE: "true" },
      nowMs: sweepNowMs
    });

    const jobs = d1.sqlite
      .prepare(
        `SELECT id, recipient_id, dedupe_key, payload_json, status, recipient_type, template_key
         FROM notification_jobs
         WHERE template_key = 'google_conflict_burst_alert'
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
      // dedupe_key shape includes window bucket (floor(now/5min)) so a
      // sustained burst spanning multiple 5-min windows produces one
      // alert per window per recipient.
      expect(job.dedupe_key).toMatch(
        /^google_conflict_burst_alert:v1:\d+:store:kyoto:cal:[0-9a-f]{32}:recipient:[0-9a-f]{32}$/
      );
      expect(job.dedupe_key).not.toContain(OPS_RECIPIENT_1);
      expect(job.dedupe_key).not.toContain(OPS_RECIPIENT_2);

      const payload = JSON.parse(job.payload_json) as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual([
        "calendar_id",
        "conflict_count",
        "store_id",
        "threshold",
        "window_minutes"
      ]);
      expect(payload.store_id).toBe(STORE_ID);
      expect(payload.calendar_id).toBe(CALENDAR_ID);
      expect(payload.conflict_count).toBe(12);
      expect(payload.window_minutes).toBe(5);
      expect(payload.threshold).toBe(10);
    }
  });

  it("enqueues the owner email job when LINE_OPERATIONS_USER_IDS is empty", async () => {
    for (let index = 0; index < 10; index += 1) {
      seedConflict(d1, { id: `c_empty_${index}`, createdAt: insideWindow });
    }
    const envWithoutLineRecipients = {
      LINE_OPERATIONS_USER_IDS: "",
      GOOGLE_CONFLICT_BURST_ALERT_LIVE: "true"
    } as const;
    await detectConflictBursts({
      db: d1 as unknown as D1Database,
      env: envWithoutLineRecipients,
      nowMs: sweepNowMs
    });

    const row = d1.sqlite
      .prepare(
        `SELECT recipient_id FROM notification_jobs WHERE template_key = 'google_conflict_burst_alert'`
      )
      .get() as { recipient_id: string } | undefined;
    expect(row).toEqual({ recipient_id: OWNER_EMAIL_RECIPIENT_ID });
  });

  it("ignores conflicts outside the 5-minute window", async () => {
    // 5 inside-window + 8 outside-window = 5 in scope, below threshold.
    for (let index = 0; index < 5; index += 1) {
      seedConflict(d1, { id: `c_in_${index}`, createdAt: insideWindow });
    }
    for (let index = 0; index < 8; index += 1) {
      seedConflict(d1, { id: `c_out_${index}`, createdAt: outsideWindow });
    }
    await detectConflictBursts({
      db: d1 as unknown as D1Database,
      env: baseEnv,
      nowMs: sweepNowMs
    });
    expect(burstLogLines("google_conflict_burst_alert")).toHaveLength(0);
  });

  it("ignores conflicts already resolved (resolution_status != 'open')", async () => {
    // 10 conflicts inside window but all already resolved → no burst.
    for (let index = 0; index < 10; index += 1) {
      seedConflict(d1, {
        id: `c_${index}`,
        createdAt: insideWindow,
        resolutionStatus: "manual_resolved"
      });
    }
    await detectConflictBursts({
      db: d1 as unknown as D1Database,
      env: baseEnv,
      nowMs: sweepNowMs
    });
    expect(burstLogLines("google_conflict_burst_alert")).toHaveLength(0);
  });

  it("INSERT OR IGNORE deduplicates same-window re-runs to one email per 5-min bucket", async () => {
    for (let index = 0; index < 11; index += 1) {
      seedConflict(d1, { id: `c_${index}`, createdAt: insideWindow });
    }
    const args = {
      db: d1 as unknown as D1Database,
      env: { ...baseEnv, GOOGLE_CONFLICT_BURST_ALERT_LIVE: "true" },
      nowMs: sweepNowMs
    };
    await detectConflictBursts(args);
    await detectConflictBursts(args); // same window bucket → dedupe

    const count = d1.sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM notification_jobs WHERE template_key = 'google_conflict_burst_alert'`
      )
      .get() as { n: number };
    expect(count.n).toBe(1);
  });
});
