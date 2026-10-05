/**
 * Regression tests for the full_reconcile timeout root fix (Sentry
 * RESERVATION-LINE-HOMEPAGE-C / -2: kyoto's daily full_reconcile burned all
 * MAX_ATTEMPTS every day from 2026-06-03).
 *
 * Covers the four changes:
 *  A. slot-conflict probes batched into IN (...) chunks (one query per slot
 *     was the per-event cost explosion: an all-day block = 288 round trips)
 *  B. fetchNextImportJob claims full_reconcile AFTER fresher job kinds so a
 *     poison reconcile cannot starve cron_incremental for ~an hour
 *  C. full_reconcile resume checkpoint: pageToken / processed count / sweep
 *     anchor / timeMin pinned across attempts (Google pagination requires the
 *     exact first-page query on every pageToken request)
 *  D. cooperative soft-deadline yield: an attempt parks itself attempt-free
 *     instead of running into the CLAIM_TASK_TIMEOUT_MS axe, with three
 *     guards (progress / same-token / yield budget) so yields can never
 *     bypass the MAX_ATTEMPTS dead-letter guarantee
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  IMPORT_SOFT_DEADLINE_MS,
  __testing__,
  processDueGoogleCalendarImportJobs
} from "../src/google/import-sync";
import { CLAIM_TASK_TIMEOUT_MS } from "../src/cron-watchdog";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const {
  chunkBindValues,
  buildEventsListUrl,
  fullWalkTimeMinIso,
  compactDedupeKey,
  SLOT_QUERY_CHUNK_SIZE,
  FULL_WALK_PAGE_SIZE,
  INITIAL_WALK_PAGE_SIZE,
  MAX_RECONCILE_YIELDS,
  MAX_EVENTS_LIST_PAGES
} = __testing__;

const CALENDAR_ID = "calendar-a@example.invalid";
const T0 = 1_800_000_000_000; // 2027-01-15T08:00:00.000Z

const ENV = {
  GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
  LINE_OPERATIONS_USER_IDS: "",
  GOOGLE_DRIFT_ALERT_LIVE: "false"
};

const requestUrl = (input: RequestInfo | URL) => {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
};

const timedOpaqueEvent = (id: string, startIso: string, endIso: string) => ({
  id,
  etag: `${id}_etag`,
  status: "confirmed",
  summary: `block ${id}`,
  transparency: "opaque",
  updated: "2026-06-01T00:00:00.000Z",
  start: { dateTime: startIso, timeZone: "Asia/Tokyo" },
  end: { dateTime: endIso, timeZone: "Asia/Tokyo" }
});

describe("full_reconcile resume checkpoint and yield", () => {
  let d1: SqliteD1Database;

  beforeEach(() => {
    d1 = createMigratedSqliteD1();
    d1.sqlite.prepare("UPDATE stores SET google_calendar_id = NULL WHERE id <> 'kyoto'").run();
    d1.sqlite.prepare("UPDATE store_settings SET google_controlled_edit_mode = 1 WHERE store_id = 'kyoto'").run();
  });

  afterEach(() => {
    d1.sqlite.close();
  });

  const insertActiveChannel = (syncToken: string | null = null) => {
    d1.sqlite
      .prepare(
        `
          INSERT INTO calendar_auth_connections (
            id, store_id, provider, calendar_id, service_account_email, status
          ) VALUES (
            'calendar_auth_resume_kyoto_1', 'kyoto', 'google', ?,
            'calendar-sync@example.iam.gserviceaccount.com', 'active'
          )
        `
      )
      .run(CALENDAR_ID);
    d1.sqlite
      .prepare(
        `
          INSERT INTO google_calendar_channels (
            id, store_id, calendar_auth_connection_id, calendar_id, channel_id,
            resource_id, channel_token_hash, channel_token_hash_alg, sync_token, status
          ) VALUES (
            'google_calendar_channel_resume_1', 'kyoto', 'calendar_auth_resume_kyoto_1', ?,
            'google_channel_resume_1', 'google_resource_resume_1', 'token_hash', 'sha256', ?, 'active'
          )
        `
      )
      .run(CALENDAR_ID, syncToken);
  };

  const insertImportJob = (input: {
    id: string;
    reason: "push" | "cron_incremental" | "full_reconcile" | "manual";
    nextRunAt?: string;
  }) => {
    d1.sqlite
      .prepare(
        `
          INSERT INTO google_calendar_import_jobs (
            id, store_id, calendar_id, reason, status, next_run_at, dedupe_key
          ) VALUES (?, 'kyoto', ?, ?, 'queued', ?, ?)
        `
      )
      .run(
        input.id,
        CALENDAR_ID,
        input.reason,
        input.nextRunAt ?? "2026-05-09T00:00:00.000Z",
        `${CALENDAR_ID}:${input.reason}:${input.id}`
      );
  };

  const readJob = (id: string) =>
    d1.sqlite
      .prepare(
        `
          SELECT status, attempt_count, last_error, next_run_at,
                 resume_page_token, resume_processed_count,
                 resume_sweep_start_seconds, resume_time_min, resume_yield_count
          FROM google_calendar_import_jobs
          WHERE id = ?
        `
      )
      .get(id) as {
        status: string;
        attempt_count: number;
        last_error: string | null;
        next_run_at: string;
        resume_page_token: string | null;
        resume_processed_count: number;
        resume_sweep_start_seconds: number | null;
        resume_time_min: string | null;
        resume_yield_count: number;
      };

  // Wrap a D1 so the markJobFailure UPDATE (the only write carrying `last_error = ?`)
  // rejects exactly as production D1 does while a long-running export is in flight.
  // Every other statement (claim, reads) passes through to the real DB. Helpers are
  // hoisted out of the proxy traps to keep nesting shallow.
  const EXPORT_LOCK_MESSAGE = "D1_ERROR: Currently processing a long-running export.";
  const throwExportLock = async (): Promise<never> => {
    throw new Error(EXPORT_LOCK_MESSAGE);
  };
  // run() rejects with the export-lock; bind() re-wraps so chained `.bind(...).run()` still throws.
  const wrapExportLockedStatement = (stmt: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(stmt, {
      get(inner, prop) {
        if (prop === "run") return throwExportLock;
        if (prop === "bind") {
          return (...args: unknown[]) =>
            wrapExportLockedStatement(
              (inner as unknown as { bind: (...a: unknown[]) => D1PreparedStatement }).bind(...args)
            );
        }
        return Reflect.get(inner, prop);
      }
    });
  const withExportLockedFailureWrite = (base: SqliteD1Database): D1Database =>
    new Proxy(base as unknown as D1Database, {
      get(target, prop, receiver) {
        if (prop !== "prepare") return Reflect.get(target, prop, receiver);
        return (sql: string) => {
          const stmt = target.prepare(sql);
          return /last_error = \?/.test(sql) ? wrapExportLockedStatement(stmt) : stmt;
        };
      }
    });

  it("treats a D1 export-lock during markJobFailure as a soft-fail (no dead-letter, sweep stops)", async () => {
    insertActiveChannel("sync_token_incremental");
    insertImportJob({ id: "job_export_lock", reason: "cron_incremental" });

    // HTTP 500 → the import soft-fails → markJobFailure runs → its write hits the
    // export lock. The job must NOT be dead-lettered or even marked retryable; it
    // stays claimed and lapses for a clean retry next tick (Sentry RESERVATION-LINE-HOMEPAGE-D).
    const fetchMock = vi.fn(async () => Response.json({}, { status: 500 })) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: withExportLockedFailureWrite(d1),
      env: ENV,
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => T0
    });

    // Export-lock is a soft-fail: not counted as a failure, and the sweep stops.
    expect(result).toEqual({ processed: 1, succeeded: 0, failed: 0, fullSyncQueued: 0, yielded: 0 });
    const job = readJob("job_export_lock");
    expect(job.status).toBe("processing");
    expect(job.last_error).toBeNull();
  });

  it("keeps the soft deadline + slack under the claim budget and the chunk size under D1's 100-bind cap", () => {
    // 70s slack covers the in-flight page + checkpoint write after the
    // deadline fires; without it the cooperative yield could still lose the
    // race against the 270s withTaskTimeout axe.
    expect(IMPORT_SOFT_DEADLINE_MS + 70_000).toBeLessThanOrEqual(CLAIM_TASK_TIMEOUT_MS);
    // D1 allows at most 100 bound parameters per statement; every chunked
    // probe adds up to 4 fixed binds on top of the chunk.
    expect(SLOT_QUERY_CHUNK_SIZE + 4).toBeLessThanOrEqual(100);
  });

  it("chunks bind values at the chunk size without dropping or duplicating items", () => {
    expect(chunkBindValues([])).toEqual([]);
    const eighty = Array.from({ length: 80 }, (_, i) => `s${i}`);
    expect(chunkBindValues(eighty)).toEqual([eighty]);
    const eightyOne = Array.from({ length: 81 }, (_, i) => `s${i}`);
    expect(chunkBindValues(eightyOne).map((c) => c.length)).toEqual([80, 1]);
    const fullDay = Array.from({ length: 288 }, (_, i) => `s${i}`);
    const chunks = chunkBindValues(fullDay);
    expect(chunks.map((c) => c.length)).toEqual([80, 80, 80, 48]);
    expect(chunks.flat()).toEqual(fullDay);
  });

  it("builds the full-walk URL with the small page size and the PASSED timeMin (never recomputed)", () => {
    const url = new URL(
      buildEventsListUrl({
        calendarId: CALENDAR_ID,
        syncToken: null,
        pageToken: "pt_x",
        timeMinIso: "2026-12-16T08:00:00.000Z",
        pageSize: FULL_WALK_PAGE_SIZE
      })
    );
    expect(url.searchParams.get("maxResults")).toBe(String(FULL_WALK_PAGE_SIZE));
    expect(url.searchParams.get("timeMin")).toBe("2026-12-16T08:00:00.000Z");
    expect(url.searchParams.get("pageToken")).toBe("pt_x");
    // syncToken requests carry neither maxResults nor timeMin (Google rejects
    // syncToken combined with list filters).
    const syncUrl = new URL(
      buildEventsListUrl({
        calendarId: CALENDAR_ID,
        syncToken: "tok",
        pageToken: null,
        timeMinIso: null,
        pageSize: null
      })
    );
    expect(syncUrl.searchParams.get("maxResults")).toBeNull();
    expect(syncUrl.searchParams.get("timeMin")).toBeNull();
    // Non-resumable initial walk (no syncToken, not full_reconcile) keeps
    // Google's 2500-event max page so large calendars are not truncated by
    // the MAX_EVENTS_LIST_PAGES cap.
    const initialWalkUrl = new URL(
      buildEventsListUrl({
        calendarId: CALENDAR_ID,
        syncToken: null,
        pageToken: null,
        timeMinIso: "2026-12-16T08:00:00.000Z",
        pageSize: INITIAL_WALK_PAGE_SIZE
      })
    );
    expect(initialWalkUrl.searchParams.get("maxResults")).toBe("2500");
  });

  it("detects a slot conflict sitting in the LAST chunk of a 24h block (288 slots = 4 chunks)", async () => {
    insertActiveChannel(null);
    insertImportJob({ id: "job_last_chunk_conflict", reason: "full_reconcile" });
    // Foreign lock on slot #287 (23:55), which only the 4th IN-chunk can see.
    d1.sqlite
      .prepare(
        `INSERT INTO slot_locks (id, store_id, resource_id, slot_at, owner_type, owner_id, lock_status)
         VALUES ('slot_lock_last_chunk_1', 'kyoto', 'resource_kyoto_calendar', '2026-06-01T23:55:00.000Z', 'reservation', 'owner_last_chunk_1', 'confirmed')`
      )
      .run();
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [timedOpaqueEvent("google_event_full_day_1", "2026-06-01T00:00:00.000Z", "2026-06-02T00:00:00.000Z")],
        nextSyncToken: "sync_token_last_chunk_1"
      })
    ) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: ENV,
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => T0
    });

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0, fullSyncQueued: 0, yielded: 0 });
    const blockCount = d1.sqlite
      .prepare("SELECT COUNT(*) AS count FROM external_blocks WHERE google_event_id = 'google_event_full_day_1'")
      .get() as { count: number };
    expect(blockCount.count).toBe(0);
    const conflict = d1.sqlite
      .prepare("SELECT conflict_type FROM google_calendar_conflicts WHERE google_event_id = 'google_event_full_day_1'")
      .get() as { conflict_type: string } | undefined;
    expect(conflict?.conflict_type).toBe("external_block_slot_conflict");
  });

  it("imports a conflict-free 24h block writing all 288 slot locks through the chunked pre-check", async () => {
    insertActiveChannel(null);
    insertImportJob({ id: "job_full_day_clean", reason: "full_reconcile" });
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [timedOpaqueEvent("google_event_full_day_2", "2026-06-01T00:00:00.000Z", "2026-06-02T00:00:00.000Z")],
        nextSyncToken: "sync_token_full_day_2"
      })
    ) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: ENV,
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => T0
    });

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0, fullSyncQueued: 0, yielded: 0 });
    const locks = d1.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM slot_locks WHERE owner_type = 'external_block' AND owner_id = (SELECT id FROM external_blocks WHERE google_event_id = 'google_event_full_day_2')"
      )
      .get() as { count: number };
    expect(locks.count).toBe(288);
  });

  it("claims a due cron_incremental BEFORE an earlier-due full_reconcile (reason priority)", async () => {
    insertActiveChannel("sync_token_priority_1");
    insertImportJob({
      id: "job_priority_full",
      reason: "full_reconcile",
      nextRunAt: "2026-05-09T00:00:00.000Z"
    });
    insertImportJob({
      id: "job_priority_incremental",
      reason: "cron_incremental",
      nextRunAt: "2026-05-09T00:01:00.000Z"
    });
    const fetchMock = vi.fn(async () =>
      Response.json({ items: [], nextSyncToken: "sync_token_priority_2" })
    ) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: ENV,
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => T0,
      maxJobs: 1
    });

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0, fullSyncQueued: 0, yielded: 0 });
    expect(readJob("job_priority_incremental").status).toBe("succeeded");
    expect(readJob("job_priority_full").status).toBe("queued");
  });

  it("resumes a failed full_reconcile from the checkpoint with the ORIGINAL timeMin and sweep anchor", async () => {
    insertActiveChannel(null);
    insertImportJob({ id: "job_resume_1", reason: "full_reconcile" });
    let t = T0;
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(requestUrl(input));
      if (urls.length === 1) {
        return Response.json({
          items: [timedOpaqueEvent("google_event_resume_a", "2026-06-01T03:00:00.000Z", "2026-06-01T04:00:00.000Z")],
          nextPageToken: "pt_2"
        });
      }
      if (urls.length === 2) {
        return Response.json({}, { status: 500 });
      }
      return Response.json({
        items: [timedOpaqueEvent("google_event_resume_b", "2026-06-01T05:00:00.000Z", "2026-06-01T06:00:00.000Z")],
        nextSyncToken: "sync_token_resume_done"
      });
    }) as unknown as typeof fetch;
    const captureSweepStart = vi.fn(async () => 1_700_000_000);
    const driftCounts: number[] = [];
    const computeDrift = vi.fn(async (input: { googleSweepCount: number }) => {
      driftCounts.push(input.googleSweepCount);
      return { googleSweepCount: input.googleSweepCount, d1SweepCount: input.googleSweepCount, drift: 0 };
    });

    const first = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: ENV,
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => t,
      captureSweepStart,
      computeDrift: computeDrift as never
    });
    expect(first).toEqual({ processed: 1, succeeded: 0, failed: 1, fullSyncQueued: 0, yielded: 0 });

    const afterFailure = readJob("job_resume_1");
    expect(afterFailure.status).toBe("retryable");
    expect(afterFailure.attempt_count).toBe(1);
    expect(afterFailure.resume_page_token).toBe("pt_2");
    expect(afterFailure.resume_processed_count).toBe(1);
    expect(afterFailure.resume_sweep_start_seconds).toBe(1_700_000_000);
    expect(afterFailure.resume_time_min).toBe(fullWalkTimeMinIso(T0));

    // Retry an hour later: the wall clock moved, so a recomputed timeMin
    // would differ — the resumed request must reuse the persisted one.
    t = T0 + 60 * 60 * 1000;
    const second = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: ENV,
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => t,
      captureSweepStart,
      computeDrift: computeDrift as never
    });
    expect(second).toEqual({ processed: 1, succeeded: 1, failed: 0, fullSyncQueued: 0, yielded: 0 });

    const resumedUrl = new URL(urls[2]);
    expect(resumedUrl.searchParams.get("pageToken")).toBe("pt_2");
    expect(resumedUrl.searchParams.get("timeMin")).toBe(new URL(urls[0]).searchParams.get("timeMin"));
    // Sweep anchor captured exactly once, on the original attempt.
    expect(captureSweepStart).toHaveBeenCalledTimes(1);
    // Drift counted the CUMULATIVE walk (1 event from each attempt).
    expect(driftCounts).toEqual([2]);

    const afterSuccess = readJob("job_resume_1");
    expect(afterSuccess.status).toBe("succeeded");
    expect(afterSuccess.resume_page_token).toBeNull();
    expect(afterSuccess.resume_processed_count).toBe(0);
    expect(afterSuccess.resume_sweep_start_seconds).toBeNull();
    expect(afterSuccess.resume_time_min).toBeNull();
    expect(afterSuccess.resume_yield_count).toBe(0);
  });

  it("never captures a FRESH sweep anchor on a mid-walk resume (NULL-anchor checkpoint disables drift/orphan sweep)", async () => {
    insertActiveChannel(null);
    insertImportJob({ id: "job_null_anchor", reason: "full_reconcile" });
    let t = T0;
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(requestUrl(input));
      if (urls.length === 1) {
        return Response.json({
          items: [timedOpaqueEvent("google_event_anchor_a", "2026-06-01T03:00:00.000Z", "2026-06-01T04:00:00.000Z")],
          nextPageToken: "pt_anchor_2"
        });
      }
      if (urls.length === 2) {
        return Response.json({}, { status: 500 });
      }
      return Response.json({
        items: [timedOpaqueEvent("google_event_anchor_b", "2026-06-01T05:00:00.000Z", "2026-06-01T06:00:00.000Z")],
        nextSyncToken: "sync_token_anchor_done"
      });
    }) as unknown as typeof fetch;
    // First attempt: anchor capture fails (transient D1 error). If the
    // resumed attempt wrongly re-captured, it would get this FAR-FUTURE
    // anchor, whose orphan cutoff sits after every row's last_seen_at —
    // deleting the event the walk itself imported one attempt earlier.
    const captureSweepStart = vi
      .fn(async () => 4_102_444_800) // 2100-01-01, poison if ever used
      .mockRejectedValueOnce(new Error("d1 transient"));
    const computeDrift = vi.fn(async (input: { googleSweepCount: number }) => ({
      googleSweepCount: input.googleSweepCount,
      d1SweepCount: input.googleSweepCount,
      drift: 0
    }));

    const first = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: ENV,
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => t,
      captureSweepStart,
      computeDrift: computeDrift as never
    });
    expect(first).toEqual({ processed: 1, succeeded: 0, failed: 1, fullSyncQueued: 0, yielded: 0 });
    const afterFailure = readJob("job_null_anchor");
    expect(afterFailure.resume_page_token).toBe("pt_anchor_2");
    expect(afterFailure.resume_sweep_start_seconds).toBeNull();

    // Backoff parks the retry in the future; jump past it.
    t = T0 + 60 * 60 * 1000;
    const second = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: ENV,
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => t,
      captureSweepStart,
      computeDrift: computeDrift as never
    });
    expect(second).toEqual({ processed: 1, succeeded: 1, failed: 0, fullSyncQueued: 0, yielded: 0 });

    // Anchor capture attempted only on the ORIGINAL attempt; the resume must
    // not mix a fresh anchor with prior-attempt progress.
    expect(captureSweepStart).toHaveBeenCalledTimes(1);
    // Drift and the orphan sweep stay disabled for the whole walk.
    expect(computeDrift).not.toHaveBeenCalled();
    const eventRow = d1.sqlite
      .prepare("SELECT status FROM google_calendar_events WHERE google_event_id = 'google_event_anchor_a'")
      .get() as { status: string };
    expect(eventRow.status).not.toBe("deleted");

    const afterSuccess = readJob("job_null_anchor");
    expect(afterSuccess.status).toBe("succeeded");
    expect(afterSuccess.resume_page_token).toBeNull();
    expect(afterSuccess.resume_sweep_start_seconds).toBeNull();
  });

  it("yields attempt-free at the soft deadline and does NOT re-claim the job in the same batch", async () => {
    insertActiveChannel(null);
    insertImportJob({ id: "job_yield_1", reason: "full_reconcile" });
    let t = T0;
    const fetchMock = vi.fn(async () => {
      // Crossing the soft deadline while the first page is in flight.
      t += IMPORT_SOFT_DEADLINE_MS + 1_000;
      return Response.json({
        items: [timedOpaqueEvent("google_event_yield_a", "2026-06-01T03:00:00.000Z", "2026-06-01T04:00:00.000Z")],
        nextPageToken: "pt_yield_2"
      });
    }) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: ENV,
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => t
    });

    // Yielded jobs count as processed but neither succeeded nor failed, and
    // the batch ends immediately (the job is due again RIGHT NOW — claiming
    // it again would spend the post-deadline slack).
    expect(result).toEqual({ processed: 1, succeeded: 0, failed: 0, fullSyncQueued: 0, yielded: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const parked = readJob("job_yield_1");
    expect(parked.status).toBe("retryable");
    expect(parked.attempt_count).toBe(0);
    expect(parked.resume_yield_count).toBe(1);
    expect(parked.resume_page_token).toBe("pt_yield_2");
    expect(parked.last_error).toBeNull();

    // The next batch resumes from the checkpoint and finishes.
    const fetchMock2 = vi.fn(async (input: RequestInfo | URL) => {
      expect(new URL(requestUrl(input)).searchParams.get("pageToken")).toBe("pt_yield_2");
      return Response.json({
        items: [timedOpaqueEvent("google_event_yield_b", "2026-06-01T05:00:00.000Z", "2026-06-01T06:00:00.000Z")],
        nextSyncToken: "sync_token_yield_done"
      });
    }) as unknown as typeof fetch;
    const second = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: ENV,
      fetcher: fetchMock2,
      accessTokenProvider: async () => "google_access_token",
      now: () => t
    });
    expect(second).toEqual({ processed: 1, succeeded: 1, failed: 0, fullSyncQueued: 0, yielded: 0 });
    expect(readJob("job_yield_1").status).toBe("succeeded");
  });

  it("treats a repeated nextPageToken as no progress and consumes the attempt (no free-yield loop)", async () => {
    insertActiveChannel(null);
    insertImportJob({ id: "job_loop_token", reason: "full_reconcile" });
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      return Response.json({
        items: [
          timedOpaqueEvent(
            `google_event_loop_${calls}`,
            `2026-06-0${calls}T03:00:00.000Z`,
            `2026-06-0${calls}T04:00:00.000Z`
          )
        ],
        nextPageToken: "pt_loop"
      });
    }) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: ENV,
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => T0
    });

    expect(result).toEqual({ processed: 1, succeeded: 0, failed: 1, fullSyncQueued: 0, yielded: 0 });
    const job = readJob("job_loop_token");
    expect(job.status).toBe("retryable");
    expect(job.attempt_count).toBe(1);
    expect(job.last_error).toBe("google-reconcile-no-progress");
  });

  it("stops free yields at MAX_RECONCILE_YIELDS and consumes the attempt instead", async () => {
    insertActiveChannel(null);
    insertImportJob({ id: "job_yield_budget", reason: "full_reconcile" });
    d1.sqlite
      .prepare("UPDATE google_calendar_import_jobs SET resume_yield_count = ? WHERE id = 'job_yield_budget'")
      .run(MAX_RECONCILE_YIELDS);
    let t = T0;
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      t += IMPORT_SOFT_DEADLINE_MS + 1_000;
      return Response.json({
        items: [timedOpaqueEvent("google_event_budget_1", "2026-06-01T03:00:00.000Z", "2026-06-01T04:00:00.000Z")],
        nextPageToken: `pt_budget_${calls + 1}`
      });
    }) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: ENV,
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => t,
      // One claim only: with the clock jumping past the retry backoff every
      // page, an unbounded batch would legitimately re-claim and burn more
      // attempts — this test pins down the FIRST claim's outcome.
      maxJobs: 1
    });

    expect(result).toEqual({ processed: 1, succeeded: 0, failed: 1, fullSyncQueued: 0, yielded: 0 });
    const job = readJob("job_yield_budget");
    expect(job.status).toBe("retryable");
    expect(job.attempt_count).toBe(1);
    expect(job.last_error).toBe("google-reconcile-yield-budget-exhausted");
    // Attempts now burn on every claim, so MAX_ATTEMPTS dead-letter stays reachable.
  });

  it("clears the checkpoint and fails normally when Google rejects the resume pageToken (no sync-token fallout)", async () => {
    insertActiveChannel("sync_token_keep_1");
    insertImportJob({ id: "job_dead_token", reason: "full_reconcile" });
    d1.sqlite
      .prepare(
        `UPDATE google_calendar_import_jobs
         SET resume_page_token = 'pt_dead',
             resume_processed_count = 7,
             resume_sweep_start_seconds = 1700000000,
             resume_time_min = '2026-12-16T08:00:00.000Z',
             resume_yield_count = 7
         WHERE id = 'job_dead_token'`
      )
      .run();
    const fetchMock = vi.fn(async () => Response.json({ error: "invalid pageToken" }, { status: 400 })) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: ENV,
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => T0
    });

    expect(result).toEqual({ processed: 1, succeeded: 0, failed: 1, fullSyncQueued: 0, yielded: 0 });
    const job = readJob("job_dead_token");
    expect(job.status).toBe("retryable");
    expect(job.attempt_count).toBe(1);
    expect(job.last_error).toBe("google-page-token-invalid");
    expect(job.resume_page_token).toBeNull();
    expect(job.resume_time_min).toBeNull();
    // The abandoned walk's yield budget must not leak into the fresh walk.
    expect(job.resume_yield_count).toBe(0);
    // The pageToken failure must NOT be routed through the syncToken-expiry
    // path: the channel keeps its sync token and no recovery full_reconcile
    // is enqueued.
    const channel = d1.sqlite
      .prepare("SELECT sync_token FROM google_calendar_channels WHERE id = 'google_calendar_channel_resume_1'")
      .get() as { sync_token: string | null };
    expect(channel.sync_token).toBe("sync_token_keep_1");
    const fullJobs = d1.sqlite
      .prepare("SELECT COUNT(*) AS count FROM google_calendar_import_jobs WHERE reason = 'full_reconcile'")
      .get() as { count: number };
    expect(fullJobs.count).toBe(1);
  });

  it("wipes the checkpoint when the final attempt dead-letters the job", async () => {
    insertActiveChannel(null);
    insertImportJob({ id: "job_dead_clears", reason: "full_reconcile" });
    d1.sqlite
      .prepare(
        `UPDATE google_calendar_import_jobs
         SET attempt_count = 4,
             resume_page_token = 'pt_stale_dead',
             resume_processed_count = 11,
             resume_sweep_start_seconds = 1700000000,
             resume_time_min = '2026-12-16T08:00:00.000Z',
             resume_yield_count = 3
         WHERE id = 'job_dead_clears'`
      )
      .run();
    const fetchMock = vi.fn(async () => Response.json({}, { status: 500 })) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: ENV,
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => T0,
      maxJobs: 1
    });

    expect(result).toEqual({ processed: 1, succeeded: 0, failed: 1, fullSyncQueued: 0, yielded: 0 });
    const job = readJob("job_dead_clears");
    expect(job.status).toBe("dead");
    expect(job.attempt_count).toBe(5);
    // The walk is over; a later resurrection (queueFullReconcile / admin
    // retry) must start fresh, not from a dead walk's token or yield budget.
    expect(job.resume_page_token).toBeNull();
    expect(job.resume_processed_count).toBe(0);
    expect(job.resume_sweep_start_seconds).toBeNull();
    expect(job.resume_time_min).toBeNull();
    expect(job.resume_yield_count).toBe(0);
  });

  it("resets stale checkpoint state when a sync-token-expiry resurrects a terminal full_reconcile row", async () => {
    insertActiveChannel("sync_token_expired_soon");
    insertImportJob({ id: "job_410_trigger", reason: "cron_incremental" });
    const recoveryDedupeKey = compactDedupeKey(
      `${CALENDAR_ID}:full_reconcile:sync_token_expired`,
      "google-import:sync-token-expired"
    );
    d1.sqlite
      .prepare(
        `INSERT INTO google_calendar_import_jobs (
           id, store_id, calendar_id, reason, status, next_run_at, attempt_count,
           dedupe_key, last_error,
           resume_page_token, resume_processed_count, resume_sweep_start_seconds,
           resume_time_min, resume_yield_count
         ) VALUES (
           'job_dead_full_walk', 'kyoto', ?, 'full_reconcile', 'dead', '2026-05-09T00:00:00.000Z', 5,
           ?, 'exhausted_after_repeated_crash',
           'pt_from_dead_walk', 99, 1690000000, '2026-03-01T00:00:00.000Z', 30
         )`
      )
      .run(CALENDAR_ID, recoveryDedupeKey);
    const fetchMock = vi.fn(async () => Response.json({}, { status: 410 })) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: ENV,
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => T0,
      maxJobs: 1
    });

    // The 410 path counts as a handled success (full reconcile queued).
    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0, fullSyncQueued: 1, yielded: 0 });
    const resurrected = readJob("job_dead_full_walk");
    expect(resurrected.status).toBe("queued");
    expect(resurrected.attempt_count).toBe(0);
    // The resurrected row starts a brand-new walk: no token, no counters, no
    // inherited (already exhausted) yield budget from the dead walk.
    expect(resurrected.resume_page_token).toBeNull();
    expect(resurrected.resume_processed_count).toBe(0);
    expect(resurrected.resume_sweep_start_seconds).toBeNull();
    expect(resurrected.resume_time_min).toBeNull();
    expect(resurrected.resume_yield_count).toBe(0);
  });

  it("yields (not pagination-incomplete) when the per-attempt page cap is hit mid-walk", async () => {
    insertActiveChannel(null);
    insertImportJob({ id: "job_page_cap", reason: "full_reconcile" });
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      return Response.json({
        items: [],
        nextPageToken: `pt_cap_${calls + 1}`
      });
    }) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: ENV,
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => T0
    });

    expect(result).toEqual({ processed: 1, succeeded: 0, failed: 0, fullSyncQueued: 0, yielded: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(MAX_EVENTS_LIST_PAGES);
    const job = readJob("job_page_cap");
    expect(job.status).toBe("retryable");
    expect(job.attempt_count).toBe(0);
    expect(job.resume_yield_count).toBe(1);
    expect(job.resume_page_token).toBe(`pt_cap_${MAX_EVENTS_LIST_PAGES + 1}`);
  });
});
