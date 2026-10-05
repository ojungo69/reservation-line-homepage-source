import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  captureSweepStartSeconds,
  computeCalendarDrift,
  enqueueGoogleCalendarMaintenanceJobs,
  processDueGoogleCalendarImportJobs
} from "../src/google/import-sync";
import { processDueCalendarSyncJobs } from "../src/google/calendar-sync";
import { createPublicReservation, type PublicReservationRequest } from "../src/reservations/public-submit";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const CALENDAR_ID = "calendar-a@example.invalid";

const fiveMinuteSlots = (startAt: string, durationMinutes: number) => {
  const startMs = new Date(startAt).getTime();
  return Array.from({ length: durationMinutes / 5 }, (_, index) =>
    new Date(startMs + index * 5 * 60 * 1000).toISOString()
  );
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

describe("Google Calendar import jobs", () => {
  let d1: SqliteD1Database;

  beforeEach(() => {
    d1 = createMigratedSqliteD1();
    d1.sqlite.prepare("UPDATE stores SET google_calendar_id = NULL WHERE id <> 'kyoto'").run();
    d1.sqlite.prepare("UPDATE store_settings SET google_controlled_edit_mode = 1 WHERE store_id = 'kyoto'").run();
  });

  afterEach(() => {
    d1.sqlite.close();
  });

  const insertActiveChannel = (syncToken: string | null = "sync_token_1") => {
    d1.sqlite
      .prepare(
        `
          INSERT INTO calendar_auth_connections (
            id,
            store_id,
            provider,
            calendar_id,
            service_account_email,
            status
          ) VALUES (
            'calendar_auth_import_kyoto_1',
            'kyoto',
            'google',
            ?,
            'calendar-sync@example.iam.gserviceaccount.com',
            'active'
          )
        `
      )
      .run(CALENDAR_ID);
    d1.sqlite
      .prepare(
        `
          INSERT INTO google_calendar_channels (
            id,
            store_id,
            calendar_auth_connection_id,
            calendar_id,
            channel_id,
            resource_id,
            channel_token_hash,
            channel_token_hash_alg,
            sync_token,
            status
          ) VALUES (
            'google_calendar_channel_import_1',
            'kyoto',
            'calendar_auth_import_kyoto_1',
            ?,
            'google_channel_import_1',
            'google_resource_import_1',
            'token_hash',
            'sha256',
            ?,
            'active'
          )
        `
      )
      .run(CALENDAR_ID, syncToken);
  };

  const insertImportJob = (reason: "push" | "cron_incremental" | "full_reconcile" | "manual" = "push") => {
    d1.sqlite
      .prepare(
        `
          INSERT INTO google_calendar_import_jobs (
            id,
            store_id,
            calendar_id,
            reason,
            status,
            next_run_at,
            dedupe_key
          ) VALUES (
            ?,
            'kyoto',
            ?,
            ?,
            'queued',
            '2026-05-09T00:00:00.000Z',
            ?
          )
        `
      )
      .run(`google_import_job_${reason}_1`, CALENDAR_ID, reason, `${CALENDAR_ID}:${reason}:test`);
  };

  const createConfirmedReservationWithGoogleEvent = async () => {
    const request: PublicReservationRequest = {
      idempotencyKey: "google_import_reservation_delete_1",
      storeId: "kyoto",
      serviceId: "service_kyoto_default_60",
      resourceId: "resource_kyoto_calendar",
      startAt: "2026-06-01T01:00:00.000Z",
      customer: {
        displayName: "予約 太郎",
        displayNameKana: "ヨヤク タロウ",
        phone: "075-123-4567"
      },
      consents: {
        noticeVersion: "notice-terms-2026-06",
        cancellationPolicyVersion: "cancel-2026-08-31",
        privacyPolicyVersion: "privacy-2026-06"
      }
    };
    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request,
      line: {
        lineUserId: "line_user_google_import_delete_1",
        channelId: "line_channel_id"
      },
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });
    if (!result.ok) {
      throw new Error(result.reason);
    }
    d1.sqlite
      .prepare(
        `
          UPDATE reservations
          SET status = 'confirmed',
              end_at = '2026-06-01T02:00:00.000Z',
              duration_minutes = 60,
              google_event_id = 'google_reservation_event_deleted_1',
              google_event_etag = 'google_reservation_etag_deleted_1',
              google_sync_state = 'synced'
          WHERE id = ?
        `
      )
      .run(result.reservationId);
    const reservation = d1.sqlite
      .prepare("SELECT customer_id FROM reservations WHERE id = ?")
      .get(result.reservationId) as { customer_id: string };
    d1.sqlite.prepare("DELETE FROM slot_locks WHERE owner_id = ?").run(result.reservationId);
    d1.sqlite.prepare("DELETE FROM customer_time_locks WHERE owner_id = ?").run(result.reservationId);
    for (const [index, slotAt] of fiveMinuteSlots("2026-06-01T01:00:00.000Z", 60).entries()) {
      d1.sqlite
        .prepare(
          `
            INSERT INTO slot_locks (
              id,
              store_id,
              resource_id,
              slot_at,
              owner_type,
              owner_id,
              lock_status
            ) VALUES (?, 'kyoto', 'resource_kyoto_calendar', ?, 'reservation', ?, 'confirmed')
          `
        )
        .run(`slot_lock_google_import_fixture_${index}`, slotAt, result.reservationId);
      d1.sqlite
        .prepare(
          `
            INSERT INTO customer_time_locks (
              id,
              customer_id,
              slot_at,
              owner_type,
              owner_id,
              lock_status
            ) VALUES (?, ?, ?, 'reservation', ?, 'confirmed')
          `
        )
        .run(`customer_lock_google_import_fixture_${index}`, reservation.customer_id, slotAt, result.reservationId);
    }
    d1.sqlite.prepare("DELETE FROM google_calendar_import_jobs").run();
    d1.sqlite.prepare("DELETE FROM calendar_sync_jobs").run();
    return result.reservationId;
  };

  it("enqueues cron incremental and daily full reconciliation jobs idempotently for store calendars", async () => {
    const first = await enqueueGoogleCalendarMaintenanceJobs({
      db: d1 as unknown as D1Database,
      now: () => 1_800_000_000_000
    });
    const replay = await enqueueGoogleCalendarMaintenanceJobs({
      db: d1 as unknown as D1Database,
      now: () => 1_800_000_000_000
    });

    expect(first).toEqual({
      checked: 1,
      cronIncrementalQueued: 1,
      fullReconcileQueued: 1
    });
    expect(replay).toEqual({
      checked: 1,
      cronIncrementalQueued: 0,
      fullReconcileQueued: 0
    });
    const jobs = d1.sqlite
      .prepare("SELECT reason, status, dedupe_key, next_run_at FROM google_calendar_import_jobs ORDER BY reason")
      .all() as { reason: string; status: string; dedupe_key: string; next_run_at: string }[];
    expect(jobs).toHaveLength(2);

    const incremental = jobs.find((j) => j.reason === "cron_incremental");
    expect(incremental).toMatchObject({
      status: "queued",
      dedupe_key: `${CALENDAR_ID}:cron_incremental:2027-01-15T08:00`,
      // Incremental delta sync is light → immediately due (next_run_at = now).
      next_run_at: "2027-01-15T08:00:00.000Z"
    });

    const fullReconcile = jobs.find((j) => j.reason === "full_reconcile");
    expect(fullReconcile).toMatchObject({
      status: "queued",
      dedupe_key: `${CALENDAR_ID}:full_reconcile:2027-01-15`
    });
    // Heavy daily reconcile deferred to the quiet UTC window and staggered per
    // calendar within [16:20, 17:00) UTC (after the daily-cleanup window) so it
    // leaves the 09:00 JST */10 spike and stores don't all land on one tick.
    const fullDue = Date.parse(fullReconcile!.next_run_at);
    expect(fullDue).toBeGreaterThanOrEqual(Date.parse("2027-01-15T16:20:00.000Z"));
    expect(fullDue).toBeLessThan(Date.parse("2027-01-15T17:00:00.000Z"));
  });

  it("counts only jobs inserted by overlapping maintenance invocations", async () => {
    const results = await Promise.all([
      enqueueGoogleCalendarMaintenanceJobs({ db: d1 as unknown as D1Database, now: () => 1_800_000_000_000 }),
      enqueueGoogleCalendarMaintenanceJobs({ db: d1 as unknown as D1Database, now: () => 1_800_000_000_000 })
    ]);
    expect(results.reduce((total, result) => total + result.cronIncrementalQueued, 0)).toBe(1);
    expect(results.reduce((total, result) => total + result.fullReconcileQueued, 0)).toBe(1);
  });

  it("keeps the first store mapping when stores share one calendar", async () => {
    d1.sqlite.prepare("UPDATE stores SET google_calendar_id = ? WHERE id IN ('kyoto', 'osaka')")
      .run(CALENDAR_ID);
    const result = await enqueueGoogleCalendarMaintenanceJobs({
      db: d1 as unknown as D1Database, now: () => 1_800_000_000_000
    });
    expect(result).toEqual({ checked: 2, cronIncrementalQueued: 1, fullReconcileQueued: 1 });
    expect(d1.sqlite.prepare("SELECT store_id FROM google_calendar_import_jobs ORDER BY reason").all())
      .toEqual([{ store_id: "kyoto" }, { store_id: "kyoto" }]);
  });

  it("staggers a calendar's full_reconcile to a DETERMINISTIC quiet-window minute (idempotent across days)", async () => {
    // Same calendar on two different UTC days → two distinct daily dedupe rows,
    // but the per-calendar stagger minute is deterministic (hash-derived), so
    // both land on the SAME minute-of-hour within [16:20, 17:00).
    await enqueueGoogleCalendarMaintenanceJobs({
      db: d1 as unknown as D1Database,
      now: () => Date.parse("2027-01-15T08:00:00.000Z")
    });
    await enqueueGoogleCalendarMaintenanceJobs({
      db: d1 as unknown as D1Database,
      now: () => Date.parse("2027-01-16T08:00:00.000Z")
    });
    const fulls = d1.sqlite
      .prepare("SELECT next_run_at FROM google_calendar_import_jobs WHERE reason = 'full_reconcile' ORDER BY next_run_at")
      .all() as { next_run_at: string }[];
    expect(fulls).toHaveLength(2);
    const minutes = fulls.map((j) => new Date(j.next_run_at).getUTCMinutes());
    expect(minutes[0]).toBe(minutes[1]); // deterministic per calendar
    for (const j of fulls) {
      const d = new Date(j.next_run_at);
      expect(d.getUTCHours()).toBe(16);
      expect(d.getUTCMinutes()).toBeGreaterThanOrEqual(20);
      expect(d.getUTCMinutes()).toBeLessThanOrEqual(59);
    }
  });

  it("does not claim the deferred daily full_reconcile until its quiet window, then claims it after", async () => {
    await enqueueGoogleCalendarMaintenanceJobs({
      db: d1 as unknown as D1Database,
      now: () => 1_800_000_000_000 // 2027-01-15T08:00:00Z
    });
    // Isolate the full_reconcile: drop the immediately-due cron_incremental row.
    d1.sqlite.prepare("DELETE FROM google_calendar_import_jobs WHERE reason = 'cron_incremental'").run();

    // accessTokenProvider returns undefined → a CLAIMED job fails fast without
    // any Google fetch, but result.processed still counts the claim. So
    // processed:0 unambiguously means "not yet due / not claimed".
    const noToken = async () => undefined;

    const beforeWindow = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {} as never,
      accessTokenProvider: noToken,
      now: () => Date.parse("2027-01-15T08:00:00.000Z") // before the quiet window
    });
    expect(beforeWindow.processed).toBe(0);

    const afterWindow = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {} as never,
      accessTokenProvider: noToken,
      now: () => Date.parse("2027-01-15T17:05:00.000Z") // after the whole [16:20,17:00) window
    });
    expect(afterWindow.processed).toBe(1);
  });

  it("keeps maintenance import dedupe keys within the D1 schema limit for long calendar IDs", async () => {
    const longCalendarId = `${"a".repeat(300)}@example.com`;
    d1.sqlite.prepare("UPDATE stores SET google_calendar_id = ? WHERE id = 'kyoto'").run(longCalendarId);

    const result = await enqueueGoogleCalendarMaintenanceJobs({
      db: d1 as unknown as D1Database,
      now: () => 1_800_000_000_000
    });

    expect(result).toEqual({
      checked: 1,
      cronIncrementalQueued: 1,
      fullReconcileQueued: 1
    });
    const jobs = d1.sqlite
      .prepare("SELECT calendar_id, dedupe_key, length(dedupe_key) AS dedupeKeyLength FROM google_calendar_import_jobs ORDER BY reason")
      .all() as { calendar_id: string; dedupe_key: string; dedupeKeyLength: number }[];
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      expect(job.calendar_id).toBe(longCalendarId);
      expect(job.dedupeKeyLength).toBeLessThanOrEqual(256);
      expect(job.dedupe_key).toMatch(/^google-import:(cron|full):[0-9a-f]{16}$/);
    }
  });

  it("uses syncToken without incompatible list parameters and stores the next sync token", async () => {
    insertActiveChannel("sync_token_1");
    insertImportJob("push");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      expect(init?.headers).toEqual({
        Authorization: "Bearer google_access_token"
      });
      const url = new URL(requestUrl(input));
      expect(url.pathname).toBe("/calendar/v3/calendars/calendar-a%40example.invalid/events");
      expect(url.searchParams.get("syncToken")).toBe("sync_token_1");
      for (const forbidden of [
        "timeMin",
        "timeMax",
        "q",
        "orderBy",
        "privateExtendedProperty",
        "sharedExtendedProperty",
        "updatedMin",
        "iCalUID"
      ]) {
        expect(url.searchParams.has(forbidden)).toBe(false);
      }
      return Response.json({
        items: [],
        nextSyncToken: "sync_token_2"
      });
    }) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result).toEqual({
      processed: 1,
      succeeded: 1,
      failed: 0,
      fullSyncQueued: 0,
      yielded: 0
    });
    const channel = d1.sqlite
      .prepare("SELECT sync_token, last_incremental_sync_at FROM google_calendar_channels WHERE id = 'google_calendar_channel_import_1'")
      .get() as { sync_token: string; last_incremental_sync_at: string };
    expect(channel).toEqual({
      sync_token: "sync_token_2",
      last_incremental_sync_at: "2027-01-15T08:00:00.000Z"
    });
  });

  it("does not import Google events when another worker claims the import job first", async () => {
    insertActiveChannel("sync_token_lost_claim_1");
    insertImportJob("push");
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [],
        nextSyncToken: "sync_token_should_not_be_used"
      })
    ) as unknown as typeof fetch;
    const accessTokenProvider = vi.fn(async () => "google_access_token");
    const claimLossDb = {
      prepare(sql: string) {
        const statement = (d1 as unknown as D1Database).prepare(sql);
        if (sql.includes("UPDATE google_calendar_import_jobs") && sql.includes("SET status = 'processing'")) {
          return {
            bind(...values: unknown[]) {
              const bound = statement.bind(...values);
              return {
                async run() {
                  d1.sqlite
                    .prepare(
                      `
                        UPDATE google_calendar_import_jobs
                        SET status = 'processing',
                            attempt_count = attempt_count + 1,
                            locked_until = '2027-01-15T08:05:00.000Z'
                        WHERE id = ?
                      `
                    )
                    .run(String(values[2]));
                  return bound.run();
                }
              } as unknown as D1PreparedStatement;
            }
          } as unknown as D1PreparedStatement;
        }
        return statement;
      },
      batch(statements: D1PreparedStatement[]) {
        return d1.batch(statements);
      }
    } as unknown as D1Database;

    const result = await processDueGoogleCalendarImportJobs({
      db: claimLossDb,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider,
      now: () => 1_800_000_000_000,
      maxJobs: 1
    });

    expect(result).toEqual({
      processed: 0,
      succeeded: 0,
      failed: 0,
      fullSyncQueued: 0,
      yielded: 0
    });
    expect(accessTokenProvider).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    const channel = d1.sqlite
      .prepare("SELECT sync_token, last_incremental_sync_at FROM google_calendar_channels WHERE id = 'google_calendar_channel_import_1'")
      .get() as { sync_token: string; last_incremental_sync_at: string | null };
    expect(channel).toEqual({
      sync_token: "sync_token_lost_claim_1",
      last_incremental_sync_at: null
    });
  });

  it("does not let a stale import worker finish after a later claim exists", async () => {
    insertActiveChannel("sync_token_before_stale_finish_1");
    insertImportJob("push");
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [],
        nextSyncToken: "sync_token_from_stale_worker_1"
      })
    ) as unknown as typeof fetch;
    let injectedLaterClaim = false;
    const staleFinishDb = {
      prepare(sql: string) {
        const statement = (d1 as unknown as D1Database).prepare(sql);
        if (sql.includes("UPDATE google_calendar_channels")) {
          return {
            bind(...values: unknown[]) {
              const bound = statement.bind(...values);
              return {
                async run() {
                  if (!injectedLaterClaim) {
                    injectedLaterClaim = true;
                    d1.sqlite
                      .prepare(
                        `
                          UPDATE google_calendar_import_jobs
                          SET status = 'processing',
                              attempt_count = 2,
                              locked_until = '2027-01-15T08:10:00.000Z'
                          WHERE id = 'google_import_job_push_1'
                        `
                      )
                      .run();
                  }
                  return bound.run();
                }
              } as unknown as D1PreparedStatement;
            }
          } as unknown as D1PreparedStatement;
        }
        return statement;
      },
      batch(statements: D1PreparedStatement[]) {
        return d1.batch(statements);
      }
    } as unknown as D1Database;

    const result = await processDueGoogleCalendarImportJobs({
      db: staleFinishDb,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000,
      maxJobs: 1
    });

    expect(result).toEqual({
      processed: 1,
      succeeded: 0,
      failed: 1,
      fullSyncQueued: 0,
      yielded: 0
    });
    const state = d1.sqlite
      .prepare(
        `
          SELECT
            google_calendar_channels.sync_token AS syncToken,
            google_calendar_channels.last_incremental_sync_at AS lastIncrementalSyncAt,
            google_calendar_import_jobs.status AS jobStatus,
            google_calendar_import_jobs.attempt_count AS attemptCount,
            google_calendar_import_jobs.locked_until AS lockedUntil,
            google_calendar_import_jobs.last_error AS lastError
          FROM google_calendar_channels
          JOIN google_calendar_import_jobs ON google_calendar_import_jobs.id = 'google_import_job_push_1'
          WHERE google_calendar_channels.id = 'google_calendar_channel_import_1'
        `
      )
      .get() as {
      syncToken: string;
      lastIncrementalSyncAt: string | null;
      jobStatus: string;
      attemptCount: number;
      lockedUntil: string;
      lastError: string | null;
    };
    expect(state).toEqual({
      syncToken: "sync_token_before_stale_finish_1",
      lastIncrementalSyncAt: null,
      jobStatus: "processing",
      attemptCount: 2,
      lockedUntil: "2027-01-15T08:10:00.000Z",
      lastError: null
    });
  });

  it("auto-reclaims stale processing Google import jobs whose locked_until has expired (codex #9)", async () => {
    insertActiveChannel("sync_token_recover_processing_1");
    insertImportJob("push");
    d1.sqlite
      .prepare(
        `
          UPDATE google_calendar_import_jobs
          SET status = 'processing',
              attempt_count = 1,
              locked_until = '2027-01-15T07:55:00.000Z'
          WHERE id = 'google_import_job_push_1'
        `
      )
      .run();
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [],
        nextSyncToken: "sync_token_after_recovered_processing_1"
      })
    ) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    // The dequeue + claim now reclaim stale `status=processing AND locked_until<now`
    // rows (codex #9). attempt_count increments to 2, the sync proceeds, and the job
    // finishes as `succeeded` instead of being orphaned for manual recovery.
    expect(result).toEqual({
      processed: 1,
      succeeded: 1,
      failed: 0,
      fullSyncQueued: 0,
      yielded: 0
    });
    expect(fetchMock).toHaveBeenCalled();
    const job = d1.sqlite
      .prepare("SELECT status, attempt_count, locked_until FROM google_calendar_import_jobs WHERE id = 'google_import_job_push_1'")
      .get() as { status: string; attempt_count: number; locked_until: string | null };
    expect(job.status).toBe("succeeded");
    expect(job.attempt_count).toBe(2);
    expect(job.locked_until).toBeNull();
  });

  it("dead-letters stale processing Google import jobs that already hit MAX_ATTEMPTS instead of reclaiming again (codex #9)", async () => {
    insertActiveChannel("sync_token_dead_letter_1");
    insertImportJob("push");
    // attempt_count = 5 = MAX_ATTEMPTS. A worker crashed after markJobProcessing pushed
    // attempt_count to the cap, so we must NOT reclaim and increment further — the
    // row must be transitioned to `dead` with a diagnostic last_error.
    d1.sqlite
      .prepare(
        `
          UPDATE google_calendar_import_jobs
          SET status = 'processing',
              attempt_count = 5,
              locked_until = '2027-01-15T07:55:00.000Z'
          WHERE id = 'google_import_job_push_1'
        `
      )
      .run();
    const fetchMock = vi.fn() as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result).toEqual({
      processed: 0,
      succeeded: 0,
      failed: 0,
      fullSyncQueued: 0,
      yielded: 0
    });
    expect(fetchMock).not.toHaveBeenCalled();
    const job = d1.sqlite
      .prepare("SELECT status, attempt_count, locked_until, last_error FROM google_calendar_import_jobs WHERE id = 'google_import_job_push_1'")
      .get() as { status: string; attempt_count: number; locked_until: string | null; last_error: string | null };
    expect(job.status).toBe("dead");
    expect(job.attempt_count).toBe(5);
    expect(job.locked_until).toBeNull();
    expect(job.last_error).toBe("exhausted_after_repeated_crash");
  });

  it("does not mark a paginated sync successful before the page carrying nextSyncToken is reached", async () => {
    insertActiveChannel("sync_token_many_pages_1");
    insertImportJob("push");
    let pageCalls = 0;
    const fetchMock = vi.fn(async () => {
      pageCalls += 1;
      return Response.json({
        items: [],
        nextPageToken: `page_${pageCalls}`
      });
    }) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result).toEqual({
      processed: 1,
      succeeded: 0,
      failed: 1,
      fullSyncQueued: 0,
      yielded: 0
    });
    expect(fetchMock).toHaveBeenCalledTimes(10);
    const job = d1.sqlite
      .prepare("SELECT status, attempt_count, last_error FROM google_calendar_import_jobs WHERE id = 'google_import_job_push_1'")
      .get() as { status: string; attempt_count: number; last_error: string };
    expect(job).toEqual({
      status: "retryable",
      attempt_count: 1,
      last_error: "google-events-pagination-incomplete"
    });
    const channel = d1.sqlite
      .prepare("SELECT sync_token FROM google_calendar_channels WHERE id = 'google_calendar_channel_import_1'")
      .get() as { sync_token: string };
    expect(channel.sync_token).toBe("sync_token_many_pages_1");
  });

  it("queues full reconciliation and clears stale syncToken when Google returns 410", async () => {
    insertActiveChannel("expired_sync_token_1");
    insertImportJob("cron_incremental");
    const fetchMock = vi.fn(async () => Response.json({ error: { message: "Sync token is no longer valid" } }, { status: 410 })) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result).toEqual({
      processed: 1,
      succeeded: 1,
      failed: 0,
      fullSyncQueued: 1,
      yielded: 0
    });
    const channel = d1.sqlite
      .prepare("SELECT sync_token FROM google_calendar_channels WHERE id = 'google_calendar_channel_import_1'")
      .get() as { sync_token: string | null };
    expect(channel.sync_token).toBeNull();
    const fullSyncJob = d1.sqlite
      .prepare(
        "SELECT reason, status, dedupe_key FROM google_calendar_import_jobs WHERE reason = 'full_reconcile'"
      )
      .get() as { reason: string; status: string; dedupe_key: string };
    expect(fullSyncJob).toEqual({
      reason: "full_reconcile",
      status: "queued",
      dedupe_key: `${CALENDAR_ID}:full_reconcile:sync_token_expired`
    });
  });

  it("reroutes a sync_token-less cron_incremental to a bounded full_reconcile WITHOUT walking events.list (⑦)", async () => {
    insertActiveChannel(null);
    insertImportJob("cron_incremental");
    const fetchMock = vi.fn(async () =>
      Response.json({ items: [], nextSyncToken: "should_not_be_fetched" })
    ) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    // The whole point of ⑦: a NULL sync_token must NOT trigger an inline
    // INITIAL_WALK (up to 25k events, no checkpoint) — events.list is never hit.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      processed: 1,
      succeeded: 1,
      failed: 0,
      fullSyncQueued: 1,
      yielded: 0
    });
    const channel = d1.sqlite
      .prepare("SELECT sync_token FROM google_calendar_channels WHERE id = 'google_calendar_channel_import_1'")
      .get() as { sync_token: string | null };
    expect(channel.sync_token).toBeNull();
    const fullSyncJob = d1.sqlite
      .prepare("SELECT reason, status, dedupe_key FROM google_calendar_import_jobs WHERE reason = 'full_reconcile'")
      .get() as { reason: string; status: string; dedupe_key: string };
    expect(fullSyncJob).toEqual({
      reason: "full_reconcile",
      status: "queued",
      dedupe_key: `${CALENDAR_ID}:full_reconcile:sync_token_expired`
    });
  });

  it("fails explicitly (no inline walk, no recovery churn) when no channel row exists (⑦)", async () => {
    // A store can have google_calendar_id set but no channel row (watch
    // registration pending/failed/stopped). Incremental sync can never converge
    // there — there is nowhere to persist a sync_token — so the job must fail
    // and dead-letter, NOT walk inline or churn recovery full_reconciles.
    insertImportJob("cron_incremental");
    const fetchMock = vi.fn(async () =>
      Response.json({ items: [], nextSyncToken: "should_not_be_fetched" })
    ) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      processed: 1,
      succeeded: 0,
      failed: 1,
      fullSyncQueued: 0,
      yielded: 0
    });
    // No recovery full_reconcile is churned into existence for a channel-less job.
    const fullSyncCount = d1.sqlite
      .prepare("SELECT COUNT(*) AS n FROM google_calendar_import_jobs WHERE reason = 'full_reconcile'")
      .get() as { n: number };
    expect(fullSyncCount.n).toBe(0);
    const job = d1.sqlite
      .prepare("SELECT status, last_error FROM google_calendar_import_jobs WHERE reason = 'cron_incremental'")
      .get() as { status: string; last_error: string };
    expect(job).toEqual({ status: "retryable", last_error: "google-import-channel-missing" });
  });

  it("treats an empty-string sync_token like a missing one and reroutes (no inline walk) (⑦)", async () => {
    // sync_token is TEXT with no non-empty constraint; a corrupted '' row is
    // falsy on the events.list path and would slip a `=== null` guard back into
    // the unbounded INITIAL_WALK. The guard keys on !syncToken to catch it.
    insertActiveChannel("");
    insertImportJob("cron_incremental");
    const fetchMock = vi.fn(async () =>
      Response.json({ items: [], nextSyncToken: "should_not_be_fetched" })
    ) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      processed: 1,
      succeeded: 1,
      failed: 0,
      fullSyncQueued: 1,
      yielded: 0
    });
    const fullSyncJob = d1.sqlite
      .prepare("SELECT reason, status FROM google_calendar_import_jobs WHERE reason = 'full_reconcile'")
      .get() as { reason: string; status: string };
    expect(fullSyncJob).toEqual({ reason: "full_reconcile", status: "queued" });
  });

  it("dead-letters a channel-less cron_incremental at MAX_ATTEMPTS, never walking events nor churning recovery (⑦)", async () => {
    // Convergence invariant for the no-channel branch: re-running the same job
    // across cron ticks must end in 'dead' (the missing channel is isolated),
    // and across the WHOLE retry budget it must never call events.list nor
    // accumulate a recovery full_reconcile.
    insertImportJob("cron_incremental");
    const fetchMock = vi.fn(async () =>
      Response.json({ items: [], nextSyncToken: "should_not_be_fetched" })
    ) as unknown as typeof fetch;
    const env = {
      GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
      GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
      LINE_OPERATIONS_USER_IDS: "",
      GOOGLE_DRIFT_ALERT_LIVE: "false"
    };
    let status = "";
    for (let tick = 0; tick < 6 && status !== "dead"; tick += 1) {
      // Make the retryable row due again (a fresh cron tick) before re-claiming.
      d1.sqlite
        .prepare(
          "UPDATE google_calendar_import_jobs SET next_run_at = '2026-05-09T00:00:00.000Z', locked_until = NULL WHERE reason = 'cron_incremental'"
        )
        .run();
      await processDueGoogleCalendarImportJobs({
        db: d1 as unknown as D1Database,
        env,
        fetcher: fetchMock,
        accessTokenProvider: async () => "google_access_token",
        now: () => 1_800_000_000_000
      });
      status = (
        d1.sqlite
          .prepare("SELECT status FROM google_calendar_import_jobs WHERE reason = 'cron_incremental'")
          .get() as { status: string }
      ).status;
    }
    expect(status).toBe("dead");
    expect(fetchMock).not.toHaveBeenCalled();
    const fullSyncCount = d1.sqlite
      .prepare("SELECT COUNT(*) AS n FROM google_calendar_import_jobs WHERE reason = 'full_reconcile'")
      .get() as { n: number };
    expect(fullSyncCount.n).toBe(0);
  });

  it.each(["succeeded", "failed", "dead"] as const)(
    "requeues a %s sync-token-expired full reconciliation job when Google returns 410 again",
    async (oldStatus) => {
      insertActiveChannel("expired_sync_token_repeat_1");
      insertImportJob("cron_incremental");
      const oldJobId = `google_import_job_old_sync_token_expired_${oldStatus}_1`;
      d1.sqlite
        .prepare(
          `
            INSERT INTO google_calendar_import_jobs (
              id,
              store_id,
              calendar_id,
              reason,
              status,
              next_run_at,
              locked_until,
              attempt_count,
              dedupe_key,
              last_error,
              updated_at
            ) VALUES (
              ?,
              'kyoto',
              ?,
              'full_reconcile',
              ?,
              '2027-01-01T00:00:00.000Z',
              NULL,
              5,
              ?,
              'old-terminal-row',
              '2027-01-01T00:00:00.000Z'
            )
          `
        )
        .run(oldJobId, CALENDAR_ID, oldStatus, `${CALENDAR_ID}:full_reconcile:sync_token_expired`);
      const fetchMock = vi.fn(async () =>
        Response.json({ error: { message: "Sync token is no longer valid" } }, { status: 410 })
      ) as unknown as typeof fetch;

      const result = await processDueGoogleCalendarImportJobs({
        db: d1 as unknown as D1Database,
        env: {
          GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
          GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
        },
        fetcher: fetchMock,
        accessTokenProvider: async () => "google_access_token",
        now: () => 1_800_000_000_000
      });

      expect(result).toEqual({
        processed: 1,
        succeeded: 1,
        failed: 0,
        fullSyncQueued: 1,
      yielded: 0
      });
      const fullSyncJob = d1.sqlite
        .prepare(
          `
            SELECT status, attempt_count, locked_until, last_error, next_run_at
            FROM google_calendar_import_jobs
            WHERE id = ?
          `
        )
        .get(oldJobId) as {
        status: string;
        attempt_count: number;
        locked_until: string | null;
        last_error: string | null;
        next_run_at: string;
      };
      expect(fullSyncJob).toEqual({
        status: "queued",
        attempt_count: 0,
        locked_until: null,
        last_error: null,
        next_run_at: "2027-01-15T08:01:00.000Z"
      });
      const channel = d1.sqlite
        .prepare("SELECT sync_token FROM google_calendar_channels WHERE id = 'google_calendar_channel_import_1'")
        .get() as { sync_token: string | null };
      expect(channel.sync_token).toBeNull();
    }
  );

  it("clears syncToken when the sync-token-expired full reconciliation job is already processing", async () => {
    insertActiveChannel("expired_sync_token_processing_1");
    insertImportJob("cron_incremental");
    d1.sqlite
      .prepare(
        `
          INSERT INTO google_calendar_import_jobs (
            id,
            store_id,
            calendar_id,
            reason,
            status,
            next_run_at,
            locked_until,
            attempt_count,
            dedupe_key,
            last_error,
            updated_at
          ) VALUES (
            'google_import_job_processing_sync_token_expired_1',
            'kyoto',
            ?,
            'full_reconcile',
            'processing',
            '2027-01-01T00:00:00.000Z',
            '2027-01-15T08:10:00.000Z',
            1,
            ?,
            NULL,
            '2027-01-15T08:00:00.000Z'
          )
        `
      )
      .run(CALENDAR_ID, `${CALENDAR_ID}:full_reconcile:sync_token_expired`);
    const fetchMock = vi.fn(async () =>
      Response.json({ error: { message: "Sync token is no longer valid" } }, { status: 410 })
    ) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result).toEqual({
      processed: 1,
      succeeded: 1,
      failed: 0,
      fullSyncQueued: 1,
      yielded: 0
    });
    const state = d1.sqlite
      .prepare(
        `
          SELECT
            google_calendar_channels.sync_token AS syncToken,
            current_job.status AS currentJobStatus,
            full_job.status AS fullJobStatus
          FROM google_calendar_channels
          JOIN google_calendar_import_jobs AS current_job
            ON current_job.id = 'google_import_job_cron_incremental_1'
          JOIN google_calendar_import_jobs AS full_job
            ON full_job.id = 'google_import_job_processing_sync_token_expired_1'
          WHERE google_calendar_channels.id = 'google_calendar_channel_import_1'
        `
      )
    .get() as {
      syncToken: string | null;
      currentJobStatus: string;
      fullJobStatus: string;
    };
    expect(state).toEqual({
      syncToken: null,
      currentJobStatus: "succeeded",
      fullJobStatus: "processing"
    });
  });

  it("does not clear a newer sync token when a stale worker receives Google 410", async () => {
    insertActiveChannel("sync_token_before_stale_410_1");
    insertImportJob("cron_incremental");
    const fetchMock = vi.fn(async () =>
      Response.json({ error: { message: "Sync token is no longer valid" } }, { status: 410 })
    ) as unknown as typeof fetch;
    let injectedLaterClaim = false;
    const stale410Db = {
      prepare(sql: string) {
        const statement = (d1 as unknown as D1Database).prepare(sql);
        if (
          sql.includes("FROM google_calendar_import_jobs") &&
          sql.includes("locked_until = ?") &&
          sql.includes("LIMIT 1")
        ) {
          return {
            bind(...values: unknown[]) {
              const bound = statement.bind(...values);
              return {
                async first() {
                  if (!injectedLaterClaim) {
                    injectedLaterClaim = true;
                    d1.sqlite
                      .prepare(
                        `
                          UPDATE google_calendar_import_jobs
                          SET status = 'processing',
                              attempt_count = 2,
                              locked_until = '2027-01-15T08:10:00.000Z'
                          WHERE id = 'google_import_job_cron_incremental_1'
                        `
                      )
                      .run();
                    d1.sqlite
                      .prepare(
                        `
                          UPDATE google_calendar_channels
                          SET sync_token = 'sync_token_from_later_worker_1',
                              updated_at = '2027-01-15T08:00:30.000Z'
                          WHERE id = 'google_calendar_channel_import_1'
                        `
                      )
                      .run();
                  }
                  return bound.first();
                }
              } as unknown as D1PreparedStatement;
            }
          } as unknown as D1PreparedStatement;
        }
        return statement;
      },
      batch(statements: D1PreparedStatement[]) {
        return d1.batch(statements);
      }
    } as unknown as D1Database;

    const result = await processDueGoogleCalendarImportJobs({
      db: stale410Db,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000,
      maxJobs: 1
    });

    expect(result).toEqual({
      processed: 1,
      succeeded: 0,
      failed: 1,
      fullSyncQueued: 0,
      yielded: 0
    });
    const state = d1.sqlite
      .prepare(
        `
          SELECT
            google_calendar_channels.sync_token AS syncToken,
            google_calendar_import_jobs.status AS jobStatus,
            google_calendar_import_jobs.attempt_count AS attemptCount,
            google_calendar_import_jobs.locked_until AS lockedUntil,
            (SELECT COUNT(*) FROM google_calendar_import_jobs WHERE reason = 'full_reconcile') AS fullSyncJobCount
          FROM google_calendar_channels
          JOIN google_calendar_import_jobs ON google_calendar_import_jobs.id = 'google_import_job_cron_incremental_1'
          WHERE google_calendar_channels.id = 'google_calendar_channel_import_1'
        `
      )
      .get() as {
      syncToken: string;
      jobStatus: string;
      attemptCount: number;
      lockedUntil: string;
      fullSyncJobCount: number;
    };
    expect(state).toEqual({
      syncToken: "sync_token_from_later_worker_1",
      jobStatus: "processing",
      attemptCount: 2,
      lockedUntil: "2027-01-15T08:10:00.000Z",
      fullSyncJobCount: 0
    });
  });

  it.each([403, 429])("backs off Google import HTTP %i failures without storing access tokens", async (status) => {
    insertActiveChannel("sync_token_quota_retry_1");
    insertImportJob("push");
    const fetchMock = vi.fn(async () => Response.json({ error: { message: "quota exceeded" } }, { status })) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "secret_google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result).toEqual({
      processed: 1,
      succeeded: 0,
      failed: 1,
      fullSyncQueued: 0,
      yielded: 0
    });
    const job = d1.sqlite
      .prepare("SELECT status, attempt_count, next_run_at, last_error FROM google_calendar_import_jobs WHERE id = 'google_import_job_push_1'")
      .get() as { status: string; attempt_count: number; next_run_at: string; last_error: string };
    expect(job.status).toBe("retryable");
    expect(job.attempt_count).toBe(1);
    expect(Date.parse(job.next_run_at)).toBeGreaterThanOrEqual(1_800_000_000_000 + 60_000);
    expect(Date.parse(job.next_run_at)).toBeLessThan(1_800_000_000_000 + 2 * 60_000);
    expect(job.last_error).toBe(`google-events-list-http-${status}`);
    expect(job.last_error).not.toContain("secret_google_access_token");

    const retryNow = Date.parse(job.next_run_at);
    const retry = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "secret_google_access_token",
      now: () => retryNow
    });

    expect(retry).toEqual({
      processed: 1,
      succeeded: 0,
      failed: 1,
      fullSyncQueued: 0,
      yielded: 0
    });
    const retriedJob = d1.sqlite
      .prepare("SELECT status, attempt_count, next_run_at, last_error FROM google_calendar_import_jobs WHERE id = 'google_import_job_push_1'")
      .get() as { status: string; attempt_count: number; next_run_at: string; last_error: string };
    expect(retriedJob.status).toBe("retryable");
    expect(retriedJob.attempt_count).toBe(2);
    expect(Date.parse(retriedJob.next_run_at)).toBeGreaterThanOrEqual(retryNow + 2 * 60_000);
    expect(Date.parse(retriedJob.next_run_at)).toBeLessThan(retryNow + 3 * 60_000);
    expect(retriedJob.last_error).toBe(`google-events-list-http-${status}`);
    expect(retriedJob.last_error).not.toContain("secret_google_access_token");
  });

  it("keeps dead Google import jobs and last_error in D1 after final retry failure", async () => {
    insertActiveChannel("sync_token_dead_retry_1");
    insertImportJob("push");
    d1.sqlite
      .prepare(
        `
          UPDATE google_calendar_import_jobs
          SET attempt_count = 4
          WHERE id = 'google_import_job_push_1'
        `
      )
      .run();
    const fetchMock = vi.fn(async () => Response.json({ error: { message: "quota exceeded" } }, { status: 500 })) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "secret_google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result).toEqual({
      processed: 1,
      succeeded: 0,
      failed: 1,
      fullSyncQueued: 0,
      yielded: 0
    });
    const job = d1.sqlite
      .prepare("SELECT status, attempt_count, last_error FROM google_calendar_import_jobs WHERE id = 'google_import_job_push_1'")
      .get() as { status: string; attempt_count: number; last_error: string };
    expect(job).toEqual({
      status: "dead",
      attempt_count: 5,
      last_error: "google-events-list-http-500"
    });
    expect(job.last_error).not.toContain("secret_google_access_token");
  });

  it("imports new opaque timed Google events as external blocks without storing raw personal text", async () => {
    insertActiveChannel(null);
    insertImportJob("full_reconcile");
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "google_busy_event_1",
            etag: "google_busy_etag_1",
            status: "confirmed",
            summary: "山田太郎 075-123-4567",
            description: "internal note with phone 075-123-4567",
            location: "private address",
            attendees: [
              {
                email: "customer@example.com"
              }
            ],
            transparency: "opaque",
            updated: "2026-06-01T00:00:00.000Z",
            start: {
              dateTime: "2026-06-01T03:00:00.000Z",
              timeZone: "Asia/Tokyo"
            },
            end: {
              dateTime: "2026-06-01T04:00:00.000Z",
              timeZone: "Asia/Tokyo"
            }
          }
        ],
        nextSyncToken: "sync_token_after_full_1"
      })
    ) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result).toEqual({
      processed: 1,
      succeeded: 1,
      failed: 0,
      fullSyncQueued: 0,
      yielded: 0
    });
    const block = d1.sqlite
      .prepare(
        `
          SELECT source, title_snapshot, start_at, end_at, status, google_event_id, google_event_etag
          FROM external_blocks
          WHERE google_event_id = 'google_busy_event_1'
        `
      )
      .get() as {
        source: string;
        title_snapshot: string;
        start_at: string;
        end_at: string;
        status: string;
        google_event_id: string;
        google_event_etag: string;
      };
    expect(block).toEqual({
      source: "google_calendar",
      title_snapshot: "山田太郎 075-123-4567",
      start_at: "2026-06-01T03:00:00.000Z",
      end_at: "2026-06-01T04:00:00.000Z",
      status: "active",
      google_event_id: "google_busy_event_1",
      google_event_etag: "google_busy_etag_1"
    });
    const locks = d1.sqlite
      .prepare("SELECT COUNT(*) AS count FROM slot_locks WHERE owner_type = 'external_block'")
      .get() as { count: number };
    expect(locks.count).toBe(12);
    const googleEvent = d1.sqlite
      .prepare("SELECT source_type, status, google_safe_snapshot_json FROM google_calendar_events WHERE google_event_id = 'google_busy_event_1'")
      .get() as { source_type: string; status: string; google_safe_snapshot_json: string };
    expect(googleEvent.source_type).toBe("external_block");
    expect(googleEvent.status).toBe("active");
    expect(googleEvent.google_safe_snapshot_json).not.toContain("山田");
    expect(googleEvent.google_safe_snapshot_json).not.toContain("075");
    expect(googleEvent.google_safe_snapshot_json).not.toContain("customer@example.com");
    expect(JSON.parse(googleEvent.google_safe_snapshot_json)).not.toHaveProperty("summary");
      expect(JSON.parse(googleEvent.google_safe_snapshot_json)).toEqual({
        google_event_id: "google_busy_event_1",
        status: "confirmed",
        start_at: "2026-06-01T03:00:00.000Z",
        end_at: "2026-06-01T04:00:00.000Z",
        transparency: "opaque",
        all_day: false,
        recurring: false
      });
      const channel = d1.sqlite
        .prepare(
          "SELECT sync_token, last_incremental_sync_at, last_full_reconcile_at FROM google_calendar_channels WHERE id = 'google_calendar_channel_import_1'"
        )
        .get() as { sync_token: string; last_incremental_sync_at: string | null; last_full_reconcile_at: string | null };
      expect(channel).toEqual({
        sync_token: "sync_token_after_full_1",
        last_incremental_sync_at: null,
        last_full_reconcile_at: "2027-01-15T08:00:00.000Z"
      });
    });

  it("records a handled conflict (no stall) when an external-block import races a slot_locks UNIQUE", async () => {
    // A concurrent writer grabs one of the block's destination slots between the
    // hasExternalBlockSlotConflict pre-check and the batch commit (TOCTOU). The
    // slot_locks UNIQUE must be translated into a recorded external_block_slot_conflict
    // so the import event is consumed and the sync token advances — not thrown to the
    // 'google-import-unhandled' catch where it would stall the calendar's sync (B3).
    insertActiveChannel(null);
    insertImportJob("full_reconcile");
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "google_busy_event_extblock_race_1",
            etag: "google_busy_etag_extblock_race_1",
            status: "confirmed",
            summary: "blocked",
            transparency: "opaque",
            updated: "2026-06-01T00:00:00.000Z",
            start: { dateTime: "2026-06-01T03:00:00.000Z", timeZone: "Asia/Tokyo" },
            end: { dateTime: "2026-06-01T04:00:00.000Z", timeZone: "Asia/Tokyo" }
          }
        ],
        nextSyncToken: "sync_token_after_extblock_race_1"
      })
    ) as unknown as typeof fetch;
    let injectedRace = false;
    const racingDb = {
      prepare: d1.prepare.bind(d1),
      batch: async (statements: D1PreparedStatement[]) => {
        if (!injectedRace) {
          injectedRace = true;
          // Foreign lock on the block's first slot, inserted after the pre-check passed.
          d1.sqlite
            .prepare(
              `INSERT INTO slot_locks (id, store_id, resource_id, slot_at, owner_type, owner_id, lock_status)
               VALUES ('slot_lock_extblock_race_1', 'kyoto', 'resource_kyoto_calendar', '2026-06-01T03:00:00.000Z', 'reservation', 'owner_extblock_race_1', 'confirmed')`
            )
            .run();
        }
        return d1.batch(statements);
      }
    } as unknown as D1Database;

    const result = await processDueGoogleCalendarImportJobs({
      db: racingDb,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result).toMatchObject({ processed: 1, succeeded: 1, failed: 0 });
    // The block was NOT created (the batch rolled back atomically on the UNIQUE).
    const blockCount = d1.sqlite
      .prepare("SELECT COUNT(*) AS count FROM external_blocks WHERE google_event_id = 'google_busy_event_extblock_race_1'")
      .get() as { count: number };
    expect(blockCount.count).toBe(0);
    // The race was recorded as a handled conflict.
    const conflict = d1.sqlite
      .prepare("SELECT conflict_type, resolution_status FROM google_calendar_conflicts WHERE google_event_id = 'google_busy_event_extblock_race_1'")
      .get() as { conflict_type: string; resolution_status: string } | undefined;
    expect(conflict?.conflict_type).toBe("external_block_slot_conflict");
    // Recurring staff-calendar overlap is auto-dismissed (terminal) even on the
    // TOCTOU path, so it never surfaces in the 要対応 list / summaries / burst alert.
    expect(conflict?.resolution_status).toBe("ignored");
    // Sync token still advanced — the calendar's incremental sync is not stalled.
    const channel = d1.sqlite
      .prepare("SELECT sync_token FROM google_calendar_channels WHERE id = 'google_calendar_channel_import_1'")
      .get() as { sync_token: string };
    expect(channel.sync_token).toBe("sync_token_after_extblock_race_1");
  });

  it("stores the actual Google event title as title_snapshot instead of a hardcoded placeholder", async () => {
    insertActiveChannel(null);
    insertImportJob("full_reconcile");
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "google_title_event_1",
            etag: "google_title_etag_1",
            status: "confirmed",
            summary: "Team standup meeting",
            transparency: "opaque",
            updated: "2026-06-01T00:00:00.000Z",
            start: {
              dateTime: "2026-06-01T05:00:00.000Z",
              timeZone: "Asia/Tokyo"
            },
            end: {
              dateTime: "2026-06-01T06:00:00.000Z",
              timeZone: "Asia/Tokyo"
            }
          }
        ],
        nextSyncToken: "sync_token_after_title_1"
      })
    ) as unknown as typeof fetch;

    await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    const block = d1.sqlite
      .prepare("SELECT title_snapshot FROM external_blocks WHERE google_event_id = 'google_title_event_1'")
      .get() as { title_snapshot: string };
    expect(block.title_snapshot).toBe("Team standup meeting");
  });

  it("uses fallback title when Google event summary is missing or empty", async () => {
    insertActiveChannel(null);
    insertImportJob("full_reconcile");
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "google_no_title_event_1",
            etag: "google_no_title_etag_1",
            status: "confirmed",
            transparency: "opaque",
            updated: "2026-06-01T00:00:00.000Z",
            start: {
              dateTime: "2026-06-01T07:00:00.000Z",
              timeZone: "Asia/Tokyo"
            },
            end: {
              dateTime: "2026-06-01T08:00:00.000Z",
              timeZone: "Asia/Tokyo"
            }
          },
          {
            id: "google_no_title_event_2",
            etag: "google_no_title_etag_2",
            status: "confirmed",
            transparency: "opaque",
            updated: "2026-06-01T00:00:00.000Z",
            summary: "",
            start: {
              dateTime: "2026-06-01T09:00:00.000Z",
              timeZone: "Asia/Tokyo"
            },
            end: {
              dateTime: "2026-06-01T10:00:00.000Z",
              timeZone: "Asia/Tokyo"
            }
          },
          {
            id: "google_no_title_event_3",
            etag: "google_no_title_etag_3",
            status: "confirmed",
            transparency: "opaque",
            updated: "2026-06-01T00:00:00.000Z",
            summary: "   ",
            start: {
              dateTime: "2026-06-01T11:00:00.000Z",
              timeZone: "Asia/Tokyo"
            },
            end: {
              dateTime: "2026-06-01T12:00:00.000Z",
              timeZone: "Asia/Tokyo"
            }
          }
        ],
        nextSyncToken: "sync_token_after_no_title_1"
      })
    ) as unknown as typeof fetch;

    await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    const block = d1.sqlite
      .prepare("SELECT title_snapshot FROM external_blocks WHERE google_event_id = 'google_no_title_event_1'")
      .get() as { title_snapshot: string };
    expect(block.title_snapshot).toBe("（タイトルなし）");

    const block2 = d1.sqlite
      .prepare("SELECT title_snapshot FROM external_blocks WHERE google_event_id = 'google_no_title_event_2'")
      .get() as { title_snapshot: string };
    expect(block2.title_snapshot).toBe("（タイトルなし）");

    const block3 = d1.sqlite
      .prepare("SELECT title_snapshot FROM external_blocks WHERE google_event_id = 'google_no_title_event_3'")
      .get() as { title_snapshot: string };
    expect(block3.title_snapshot).toBe("（タイトルなし）");
  });

  it("updates title_snapshot from the Google event summary on re-import of existing external blocks", async () => {
    insertActiveChannel(null);
    insertImportJob("full_reconcile");
    // Pre-seed an existing external block with the old hardcoded title
    d1.sqlite
      .prepare(
        `
          INSERT INTO external_blocks (
            id,
            store_id,
            resource_id,
            source,
            title_snapshot,
            start_at,
            end_at,
            status,
            google_event_id,
            google_event_etag,
            created_by
          ) VALUES (
            'external_block_update_title_1',
            'kyoto',
            'resource_kyoto_calendar',
            'google_calendar',
            'Google Calendar block',
            '2026-06-01T09:00:00.000Z',
            '2026-06-01T10:00:00.000Z',
            'active',
            'google_update_title_event_1',
            'old_etag',
            'google_calendar'
          )
        `
      )
      .run();
    // Seed slot locks for the existing block
    for (const [index, slotAt] of fiveMinuteSlots("2026-06-01T09:00:00.000Z", 60).entries()) {
      d1.sqlite
        .prepare(
          `
            INSERT INTO slot_locks (
              id, store_id, resource_id, slot_at,
              owner_type, owner_id, lock_status
            ) VALUES (?, 'kyoto', 'resource_kyoto_calendar', ?, 'external_block', 'external_block_update_title_1', 'confirmed')
          `
        )
        .run(`slot_lock_update_title_${index}`, slotAt);
    }
    // Seed google_calendar_events row so the event is "known"
    d1.sqlite
      .prepare(
        `
          INSERT INTO google_calendar_events (
            id, store_id, calendar_id, google_event_id, google_etag,
            source_type, status, external_block_id,
            google_safe_snapshot_json
          ) VALUES (
            'gce_update_title_1', 'kyoto', ?,
            'google_update_title_event_1', 'old_etag',
            'external_block', 'active', 'external_block_update_title_1',
            '{"google_event_id":"google_update_title_event_1","status":"confirmed","start_at":"2026-06-01T09:00:00.000Z","end_at":"2026-06-01T10:00:00.000Z","transparency":"opaque","all_day":false,"recurring":false}'
          )
        `
      )
      .run(CALENDAR_ID);
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "google_update_title_event_1",
            etag: "new_etag",
            status: "confirmed",
            summary: "Updated meeting title",
            transparency: "opaque",
            updated: "2026-06-02T00:00:00.000Z",
            start: {
              dateTime: "2026-06-01T09:00:00.000Z",
              timeZone: "Asia/Tokyo"
            },
            end: {
              dateTime: "2026-06-01T10:00:00.000Z",
              timeZone: "Asia/Tokyo"
            }
          }
        ],
        nextSyncToken: "sync_token_after_update_title_1"
      })
    ) as unknown as typeof fetch;

    await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    const block = d1.sqlite
      .prepare("SELECT title_snapshot FROM external_blocks WHERE id = 'external_block_update_title_1'")
      .get() as { title_snapshot: string };
    expect(block.title_snapshot).toBe("Updated meeting title");
  });

  it("keeps the prior 24 hour cap when importing long Google external blocks", async () => {
    insertActiveChannel(null);
    insertImportJob("full_reconcile");
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "google_busy_event_24h_1",
            etag: "google_busy_event_24h_etag_1",
            status: "confirmed",
            transparency: "opaque",
            updated: "2026-06-01T00:00:00.000Z",
            start: {
              dateTime: "2026-06-01T00:00:00.000Z",
              timeZone: "Asia/Tokyo"
            },
            end: {
              dateTime: "2026-06-02T00:00:00.000Z",
              timeZone: "Asia/Tokyo"
            }
          },
          {
            id: "google_busy_event_24h05_1",
            etag: "google_busy_event_24h05_etag_1",
            status: "confirmed",
            transparency: "opaque",
            updated: "2026-06-01T00:00:00.000Z",
            start: {
              dateTime: "2026-06-03T00:00:00.000Z",
              timeZone: "Asia/Tokyo"
            },
            end: {
              dateTime: "2026-06-04T00:05:00.000Z",
              timeZone: "Asia/Tokyo"
            }
          }
        ],
        nextSyncToken: "sync_token_after_full_long_1"
      })
    ) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result).toEqual({
      processed: 1,
      succeeded: 1,
      failed: 0,
      fullSyncQueued: 0,
      yielded: 0
    });
    const block = d1.sqlite
      .prepare(
        `
          SELECT start_at, end_at, status
          FROM external_blocks
          WHERE google_event_id = 'google_busy_event_24h_1'
        `
      )
      .get() as { start_at: string; end_at: string; status: string };
    expect(block).toEqual({
      start_at: "2026-06-01T00:00:00.000Z",
      end_at: "2026-06-02T00:00:00.000Z",
      status: "active"
    });
    const locks = d1.sqlite
      .prepare("SELECT COUNT(*) AS count FROM slot_locks WHERE owner_type = 'external_block' AND owner_id = (SELECT id FROM external_blocks WHERE google_event_id = 'google_busy_event_24h_1')")
      .get() as { count: number };
    expect(locks.count).toBe(288);
    const tooLongBlock = d1.sqlite
      .prepare("SELECT COUNT(*) AS count FROM external_blocks WHERE google_event_id = 'google_busy_event_24h05_1'")
      .get() as { count: number };
    expect(tooLongBlock.count).toBe(0);
    const conflict = d1.sqlite
      .prepare("SELECT conflict_type, resolution_status FROM google_calendar_conflicts WHERE google_event_id = 'google_busy_event_24h05_1'")
      .get() as { conflict_type: string; resolution_status: string };
    expect(conflict).toEqual({
      conflict_type: "external_block_too_long",
      resolution_status: "open"
    });
  });

  it("ignores transparent Google events without creating external blocks or slot locks", async () => {
    insertActiveChannel(null);
    insertImportJob("full_reconcile");
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "google_transparent_event_1",
            etag: "google_transparent_etag_1",
            status: "confirmed",
            transparency: "transparent",
            start: {
              dateTime: "2026-06-01T05:00:00.000Z"
            },
            end: {
              dateTime: "2026-06-01T06:00:00.000Z"
            }
          }
        ],
        nextSyncToken: "sync_token_after_transparent_1"
      })
    ) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result.succeeded).toBe(1);
    const counts = d1.sqlite
      .prepare(
        `
          SELECT
            (SELECT COUNT(*) FROM external_blocks) AS blockCount,
            (SELECT COUNT(*) FROM slot_locks WHERE owner_type = 'external_block') AS lockCount
        `
      )
      .get() as { blockCount: number; lockCount: number };
    expect(counts).toEqual({
      blockCount: 0,
      lockCount: 0
    });
    const googleEvent = d1.sqlite
      .prepare("SELECT source_type, status FROM google_calendar_events WHERE google_event_id = 'google_transparent_event_1'")
      .get() as { source_type: string; status: string };
    expect(googleEvent).toEqual({
      source_type: "unknown",
      status: "ignored"
    });
  });

  it("creates manual conflicts for Google recurring and all-day events instead of auto-importing them", async () => {
    insertActiveChannel(null);
    insertImportJob("full_reconcile");
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "google_recurring_event_1",
            status: "confirmed",
            recurrence: ["RRULE:FREQ=WEEKLY"],
            start: {
              dateTime: "2026-06-01T05:00:00.000Z"
            },
            end: {
              dateTime: "2026-06-01T06:00:00.000Z"
            }
          },
          {
            id: "google_all_day_event_1",
            status: "confirmed",
            start: {
              date: "2026-06-02"
            },
            end: {
              date: "2026-06-03"
            }
          }
        ],
        nextSyncToken: "sync_token_after_conflict_1"
      })
    ) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result.succeeded).toBe(1);
    const blockCount = d1.sqlite.prepare("SELECT COUNT(*) AS count FROM external_blocks").get() as { count: number };
    expect(blockCount.count).toBe(0);
    const conflicts = d1.sqlite
      .prepare("SELECT google_event_id, conflict_type, resolution_status FROM google_calendar_conflicts ORDER BY google_event_id")
      .all() as { google_event_id: string; conflict_type: string; resolution_status: string }[];
    expect(conflicts).toEqual([
      {
        google_event_id: "google_all_day_event_1",
        conflict_type: "google_all_day_event",
        resolution_status: "open"
      },
      {
        google_event_id: "google_recurring_event_1",
        conflict_type: "google_recurring_event",
        resolution_status: "open"
      }
    ]);
  });

  it("cancels Google-created external blocks and releases slots when the Google event is deleted", async () => {
    insertActiveChannel(null);
    insertImportJob("full_reconcile");
    d1.sqlite
      .prepare(
        `
          INSERT INTO external_blocks (
            id,
            store_id,
            resource_id,
            source,
            title_snapshot,
            start_at,
            end_at,
            status,
            google_event_id,
            google_event_etag,
            created_by
          ) VALUES (
            'external_block_google_delete_1',
            'kyoto',
            'resource_kyoto_calendar',
            'google_calendar',
            'Google Calendar block',
            '2026-06-01T03:00:00.000Z',
            '2026-06-01T04:00:00.000Z',
            'active',
            'google_deleted_event_1',
            'etag_before_delete',
            'google_calendar'
          )
        `
      )
      .run();
    d1.sqlite
      .prepare(
        `
          INSERT INTO slot_locks (
            id,
            store_id,
            resource_id,
            slot_at,
            owner_type,
            owner_id,
            lock_status
          ) VALUES (
            'slot_lock_google_delete_1',
            'kyoto',
            'resource_kyoto_calendar',
            '2026-06-01T03:00:00.000Z',
            'external_block',
            'external_block_google_delete_1',
            'confirmed'
          )
        `
      )
      .run();
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "google_deleted_event_1",
            status: "cancelled"
          }
        ],
        nextSyncToken: "sync_token_after_delete_1"
      })
    ) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result.succeeded).toBe(1);
    const block = d1.sqlite
      .prepare("SELECT status FROM external_blocks WHERE id = 'external_block_google_delete_1'")
      .get() as { status: string };
    const locks = d1.sqlite
      .prepare("SELECT COUNT(*) AS count FROM slot_locks WHERE owner_id = 'external_block_google_delete_1'")
      .get() as { count: number };
    const googleEvent = d1.sqlite
      .prepare("SELECT source_type, status FROM google_calendar_events WHERE google_event_id = 'google_deleted_event_1'")
      .get() as { source_type: string; status: string };
    expect(block.status).toBe("cancelled");
    expect(locks.count).toBe(0);
    expect(googleEvent).toEqual({
      source_type: "external_block",
      status: "deleted"
    });
  });

  it("does not cancel admin-created external blocks when the Google event is deleted and opens a warning", async () => {
    insertActiveChannel(null);
    insertImportJob("full_reconcile");
    d1.sqlite
      .prepare(
        `
          INSERT INTO external_blocks (
            id,
            store_id,
            resource_id,
            source,
            title_snapshot,
            start_at,
            end_at,
            status,
            google_event_id,
            google_event_etag,
            created_by
          ) VALUES (
            'external_block_admin_delete_1',
            'kyoto',
            'resource_kyoto_calendar',
            'admin_block',
            '管理画面ブロック',
            '2026-06-01T03:00:00.000Z',
            '2026-06-01T04:00:00.000Z',
            'active',
            'google_admin_block_deleted_1',
            'etag_admin_before_delete',
            'admin_owner_1'
          )
        `
      )
      .run();
    d1.sqlite
      .prepare(
        `
          INSERT INTO slot_locks (
            id,
            store_id,
            resource_id,
            slot_at,
            owner_type,
            owner_id,
            lock_status
          ) VALUES (
            'slot_lock_admin_block_delete_1',
            'kyoto',
            'resource_kyoto_calendar',
            '2026-06-01T03:00:00.000Z',
            'external_block',
            'external_block_admin_delete_1',
            'confirmed'
          )
        `
      )
      .run();
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "google_admin_block_deleted_1",
            status: "cancelled"
          }
        ],
        nextSyncToken: "sync_token_after_admin_block_delete_1"
      })
    ) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result.succeeded).toBe(1);
    const block = d1.sqlite
      .prepare("SELECT status, google_event_id FROM external_blocks WHERE id = 'external_block_admin_delete_1'")
      .get() as { status: string; google_event_id: string | null };
    const lockCount = d1.sqlite
      .prepare("SELECT COUNT(*) AS count FROM slot_locks WHERE owner_id = 'external_block_admin_delete_1'")
      .get() as { count: number };
    const recreateJob = d1.sqlite
      .prepare("SELECT owner_type, google_action, status FROM calendar_sync_jobs WHERE owner_id = 'external_block_admin_delete_1'")
      .get() as { owner_type: string; google_action: string; status: string };
    const conflict = d1.sqlite
      .prepare("SELECT conflict_type, resolution_status FROM google_calendar_conflicts WHERE external_block_id = 'external_block_admin_delete_1'")
      .get() as { conflict_type: string; resolution_status: string };

    expect(block.status).toBe("active");
    expect(block.google_event_id).toBeNull();
    expect(lockCount.count).toBe(1);
    expect(recreateJob).toEqual({
      owner_type: "external_block",
      google_action: "upsert",
      status: "queued"
    });
    expect(conflict).toEqual({
      conflict_type: "external_block_event_deleted",
      resolution_status: "open"
    });
  });

  it("does not accept Google time edits for admin-created external blocks and queues a canonical revert", async () => {
    insertActiveChannel(null);
    insertImportJob("full_reconcile");
    d1.sqlite
      .prepare(
        `
          INSERT INTO external_blocks (
            id,
            store_id,
            resource_id,
            source,
            title_snapshot,
            start_at,
            end_at,
            status,
            google_event_id,
            google_event_etag,
            created_by
          ) VALUES (
            'external_block_admin_move_1',
            'kyoto',
            'resource_kyoto_calendar',
            'admin_block',
            '管理画面ブロック',
            '2026-06-01T03:00:00.000Z',
            '2026-06-01T04:00:00.000Z',
            'active',
            'google_admin_block_moved_1',
            'etag_admin_before_move',
            'admin_owner_1'
          )
        `
      )
      .run();
    d1.sqlite
      .prepare(
        `
          INSERT INTO slot_locks (
            id,
            store_id,
            resource_id,
            slot_at,
            owner_type,
            owner_id,
            lock_status
          ) VALUES (
            'slot_lock_admin_block_move_1',
            'kyoto',
            'resource_kyoto_calendar',
            '2026-06-01T03:00:00.000Z',
            'external_block',
            'external_block_admin_move_1',
            'confirmed'
          )
        `
      )
      .run();
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "google_admin_block_moved_1",
            etag: "etag_admin_after_google_move",
            status: "confirmed",
            updated: "2026-06-01T00:00:00.000Z",
            transparency: "opaque",
            start: {
              dateTime: "2026-06-01T05:00:00.000Z"
            },
            end: {
              dateTime: "2026-06-01T06:00:00.000Z"
            }
          }
        ],
        nextSyncToken: "sync_token_after_admin_block_move_1"
      })
    ) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result.succeeded).toBe(1);
    const block = d1.sqlite
      .prepare(
        `
          SELECT source, start_at, end_at, status, google_event_id, google_event_etag
          FROM external_blocks
          WHERE id = 'external_block_admin_move_1'
        `
      )
      .get() as {
        source: string;
        start_at: string;
        end_at: string;
        status: string;
        google_event_id: string;
        google_event_etag: string;
      };
    expect(block).toEqual({
      source: "admin_block",
      start_at: "2026-06-01T03:00:00.000Z",
      end_at: "2026-06-01T04:00:00.000Z",
      status: "active",
      google_event_id: "google_admin_block_moved_1",
      google_event_etag: "etag_admin_before_move"
    });
    const slots = d1.sqlite
      .prepare("SELECT slot_at FROM slot_locks WHERE owner_id = 'external_block_admin_move_1' ORDER BY slot_at")
      .all() as { slot_at: string }[];
    expect(slots.map((slot) => slot.slot_at)).toEqual(["2026-06-01T03:00:00.000Z"]);
    const revertJob = d1.sqlite
      .prepare("SELECT owner_type, owner_id, google_action, status FROM calendar_sync_jobs WHERE owner_id = 'external_block_admin_move_1'")
      .get() as { owner_type: string; owner_id: string; google_action: string; status: string };
    expect(revertJob).toEqual({
      owner_type: "external_block",
      owner_id: "external_block_admin_move_1",
      google_action: "upsert",
      status: "queued"
    });
    const googleEvent = d1.sqlite
      .prepare(
        `
          SELECT source_type, status, external_block_id
          FROM google_calendar_events
          WHERE google_event_id = 'google_admin_block_moved_1'
        `
      )
      .get() as { source_type: string; status: string; external_block_id: string };
    expect(googleEvent).toEqual({
      source_type: "external_block",
      status: "conflict",
      external_block_id: "external_block_admin_move_1"
    });
    const conflict = d1.sqlite
      .prepare(
        `
          SELECT conflict_type, resolution_status
          FROM google_calendar_conflicts
          WHERE external_block_id = 'external_block_admin_move_1'
        `
      )
      .get() as { conflict_type: string; resolution_status: string };
    expect(conflict).toEqual({
      conflict_type: "external_block_non_google_edit",
      resolution_status: "open"
    });
  });

  it("does not cancel D1 reservations when Google deletes reservation events and queues canonical recreation", async () => {
    const reservationId = await createConfirmedReservationWithGoogleEvent();
    insertActiveChannel(null);
    insertImportJob("full_reconcile");
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "google_reservation_event_deleted_1",
            status: "cancelled",
            extendedProperties: {
              private: {
                owner_type: "reservation",
                reservation_id: reservationId,
                store_id: "kyoto"
              }
            }
          }
        ],
        nextSyncToken: "sync_token_after_reservation_delete_1"
      })
    ) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result.succeeded).toBe(1);
    const reservation = d1.sqlite
      .prepare("SELECT status, google_event_id FROM reservations WHERE id = ?")
      .get(reservationId) as { status: string; google_event_id: string | null };
    expect(reservation).toEqual({
      status: "confirmed",
      google_event_id: null
    });
    const recreateJob = d1.sqlite
      .prepare("SELECT google_action, status FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'upsert'")
      .get(reservationId) as { google_action: string; status: string };
    expect(recreateJob).toEqual({
      google_action: "upsert",
      status: "queued"
    });
    const conflict = d1.sqlite
      .prepare("SELECT conflict_type, resolution_status FROM google_calendar_conflicts WHERE reservation_id = ?")
      .get(reservationId) as { conflict_type: string; resolution_status: string };
    expect(conflict).toEqual({
      conflict_type: "reservation_event_deleted",
      resolution_status: "open"
    });
    const googleEvent = d1.sqlite
      .prepare("SELECT source_type, status FROM google_calendar_events WHERE google_event_id = 'google_reservation_event_deleted_1'")
      .get() as { source_type: string; status: string };
    expect(googleEvent).toEqual({
      source_type: "reservation",
      status: "deleted"
    });
  });

  it("handles id-only Google deletion payloads for known reservation events without losing ownership", async () => {
    const reservationId = await createConfirmedReservationWithGoogleEvent();
    insertActiveChannel(null);
    insertImportJob("full_reconcile");
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "google_reservation_event_deleted_1",
            status: "cancelled"
          }
        ],
        nextSyncToken: "sync_token_after_id_only_reservation_delete_1"
      })
    ) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result.succeeded).toBe(1);
    const reservation = d1.sqlite
      .prepare("SELECT status, google_event_id FROM reservations WHERE id = ?")
      .get(reservationId) as { status: string; google_event_id: string | null };
    expect(reservation).toEqual({
      status: "confirmed",
      google_event_id: null
    });
    const recreateJob = d1.sqlite
      .prepare("SELECT google_action, status FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'upsert'")
      .get(reservationId) as { google_action: string; status: string };
    expect(recreateJob).toEqual({
      google_action: "upsert",
      status: "queued"
    });
    const googleEvent = d1.sqlite
      .prepare("SELECT source_type, status, reservation_id FROM google_calendar_events WHERE google_event_id = 'google_reservation_event_deleted_1'")
      .get() as { source_type: string; status: string; reservation_id: string };
    expect(googleEvent).toEqual({
      source_type: "reservation",
      status: "deleted",
      reservation_id: reservationId
    });
  });

  it("does not accept restored old Google events when a deleted event row still has the reservation link", async () => {
    const reservationId = await createConfirmedReservationWithGoogleEvent();
    d1.sqlite
      .prepare(
        `
          INSERT INTO google_calendar_events (
            id,
            store_id,
            calendar_id,
            google_event_id,
            reservation_id,
            source_type,
            status,
            google_safe_snapshot_json
          ) VALUES (
            'google_calendar_event_deleted_old_1',
            'kyoto',
            ?,
            'google_reservation_event_deleted_1',
            ?,
            'reservation',
            'deleted',
            '{"google_event_id":"google_reservation_event_deleted_1","status":"cancelled"}'
          )
        `
      )
      .run(CALENDAR_ID, reservationId);
    insertActiveChannel(null);
    insertImportJob("full_reconcile");
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "google_reservation_event_deleted_1",
            etag: "google_reservation_etag_restored_old_1",
            status: "confirmed",
            start: {
              dateTime: "2026-06-01T03:00:00.000Z"
            },
            end: {
              dateTime: "2026-06-01T04:00:00.000Z"
            },
            extendedProperties: {
              private: {
                owner_type: "reservation",
                reservation_id: reservationId,
                store_id: "kyoto"
              }
            }
          }
        ],
        nextSyncToken: "sync_token_after_restored_old_reservation_event_1"
      })
    ) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result.succeeded).toBe(1);
    const reservation = d1.sqlite
      .prepare("SELECT start_at, end_at, google_event_id FROM reservations WHERE id = ?")
      .get(reservationId) as { start_at: string; end_at: string; google_event_id: string | null };
    expect(reservation).toEqual({
      start_at: "2026-06-01T01:00:00.000Z",
      end_at: "2026-06-01T02:00:00.000Z",
      google_event_id: "google_reservation_event_deleted_1"
    });
    const conflict = d1.sqlite
      .prepare("SELECT conflict_type, resolution_status FROM google_calendar_conflicts WHERE google_event_id = 'google_reservation_event_deleted_1'")
      .get() as { conflict_type: string; resolution_status: string };
    expect(conflict).toEqual({
      conflict_type: "reservation_marker_mismatch",
      resolution_status: "open"
    });
    const activeEventCount = d1.sqlite
      .prepare("SELECT COUNT(*) AS count FROM google_calendar_events WHERE google_event_id = 'google_reservation_event_deleted_1' AND status = 'active'")
      .get() as { count: number };
    expect(activeEventCount.count).toBe(0);
  });

  it("rejects copied Google events that spoof a reservation marker but do not match the canonical event", async () => {
    const reservationId = await createConfirmedReservationWithGoogleEvent();
    insertActiveChannel(null);
    insertImportJob("full_reconcile");
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "spoofed_reservation_marker_event_1",
            etag: "spoofed_reservation_marker_etag_1",
            status: "confirmed",
            start: {
              dateTime: "2026-06-01T03:00:00.000Z"
            },
            end: {
              dateTime: "2026-06-01T04:00:00.000Z"
            },
            extendedProperties: {
              private: {
                owner_type: "reservation",
                reservation_id: reservationId,
                store_id: "kyoto"
              }
            }
          }
        ],
        nextSyncToken: "sync_token_after_spoofed_reservation_marker_1"
      })
    ) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result.succeeded).toBe(1);
    const reservation = d1.sqlite
      .prepare("SELECT start_at, end_at, google_event_id FROM reservations WHERE id = ?")
      .get(reservationId) as { start_at: string; end_at: string; google_event_id: string };
    expect(reservation).toEqual({
      start_at: "2026-06-01T01:00:00.000Z",
      end_at: "2026-06-01T02:00:00.000Z",
      google_event_id: "google_reservation_event_deleted_1"
    });
    const conflict = d1.sqlite
      .prepare("SELECT reservation_id, conflict_type, resolution_status FROM google_calendar_conflicts WHERE google_event_id = 'spoofed_reservation_marker_event_1'")
      .get() as { reservation_id: string; conflict_type: string; resolution_status: string };
    expect(conflict).toEqual({
      reservation_id: reservationId,
      conflict_type: "reservation_marker_mismatch",
      resolution_status: "open"
    });
    const googleEvent = d1.sqlite
      .prepare("SELECT source_type, status FROM google_calendar_events WHERE google_event_id = 'spoofed_reservation_marker_event_1'")
      .get() as { source_type: string; status: string };
    expect(googleEvent).toEqual({
      source_type: "unknown",
      status: "conflict"
    });
  });

  it("suppresses expired reservation events that are already queued for delete instead of opening marker conflicts", async () => {
    const reservationId = await createConfirmedReservationWithGoogleEvent();
    d1.sqlite
      .prepare(
        `
          UPDATE reservations
          SET status = 'expired',
              google_event_id = 'google_expired_race_event_1',
              google_event_etag = 'google_expired_race_etag_1',
              google_sync_state = 'pending'
          WHERE id = ?
        `
      )
      .run(reservationId);
    insertActiveChannel(null);
    insertImportJob("full_reconcile");
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "google_expired_race_event_1",
            etag: "google_expired_race_etag_2",
            status: "confirmed",
            start: {
              dateTime: "2026-06-01T01:00:00.000Z"
            },
            end: {
              dateTime: "2026-06-01T02:00:00.000Z"
            },
            extendedProperties: {
              private: {
                owner_type: "reservation",
                reservation_id: reservationId,
                store_id: "kyoto"
              }
            }
          }
        ],
        nextSyncToken: "sync_token_after_expired_race_event_1"
      })
    ) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result.succeeded).toBe(1);
    const conflictCount = d1.sqlite
      .prepare("SELECT COUNT(*) AS count FROM google_calendar_conflicts WHERE google_event_id = 'google_expired_race_event_1'")
      .get() as { count: number };
    expect(conflictCount.count).toBe(0);
    const googleEvent = d1.sqlite
      .prepare("SELECT source_type, status, reservation_id FROM google_calendar_events WHERE google_event_id = 'google_expired_race_event_1'")
      .get() as { source_type: string; status: string; reservation_id: string };
    expect(googleEvent).toEqual({
      source_type: "reservation",
      status: "active",
      reservation_id: reservationId
    });
    const reservation = d1.sqlite
      .prepare("SELECT status, google_event_id, google_sync_state FROM reservations WHERE id = ?")
      .get(reservationId) as { status: string; google_event_id: string; google_sync_state: string };
    expect(reservation).toEqual({
      status: "expired",
      google_event_id: "google_expired_race_event_1",
      google_sync_state: "pending"
    });
  });

  it("does not open a marker conflict when the full walk returns the tombstone of a delete we issued", async () => {
    // #600: the delete job clears reservations.google_event_id and flips the
    // ledger row to 'deleted', so fetchReservationForGoogleMove matches neither
    // of its two arms when our own tombstone comes back. Before the ledger
    // check every ordinary deletion opened a reservation_marker_mismatch that
    // staff had to clear by hand.
    const reservationId = await createConfirmedReservationWithGoogleEvent();
    d1.sqlite
      .prepare(
        `
          UPDATE reservations
          SET status = 'cancelled_by_admin',
              google_sync_state = 'pending',
              version = version + 1
          WHERE id = ?
        `
      )
      .run(reservationId);
    d1.sqlite
      .prepare(
        `
          INSERT INTO google_calendar_events (
            id,
            store_id,
            calendar_id,
            google_event_id,
            reservation_id,
            google_etag,
            google_updated_at,
            source_type,
            status,
            google_safe_snapshot_json
          ) VALUES (
            'google_calendar_event_self_delete_1',
            'kyoto',
            ?,
            'google_reservation_event_deleted_1',
            ?,
            'google_reservation_etag_deleted_1',
            '2026-06-01T00:00:00.000Z',
            'reservation',
            'active',
            '{}'
          )
        `
      )
      .run(CALENDAR_ID, reservationId);
    d1.sqlite
      .prepare(
        `
          INSERT INTO calendar_sync_jobs (
            id,
            dedupe_key,
            owner_type,
            owner_id,
            google_action,
            status,
            available_at
          ) VALUES (
            'calendar_delete_job_self_tombstone_1',
            'reservation:delete:self_tombstone_1',
            'reservation',
            ?,
            'delete',
            'queued',
            '2026-05-09T00:00:00.000Z'
          )
        `
      )
      .run(reservationId);

    const deleteFetchMock = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const deleteResult = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: deleteFetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => Date.parse("2026-05-09T23:10:00.000Z")
    });
    expect(deleteResult.failed).toBe(0);
    const afterDelete = d1.sqlite
      .prepare(
        "SELECT status, last_seen_at FROM google_calendar_events WHERE google_event_id = 'google_reservation_event_deleted_1'"
      )
      .get() as { status: string; last_seen_at: string };
    expect(afterDelete.status).toBe("deleted");

    // The full walk asks for showDeleted=true, so Google hands the same event
    // straight back as a cancelled tombstone.
    insertActiveChannel(null);
    insertImportJob("full_reconcile");
    const importFetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "google_reservation_event_deleted_1",
            etag: "google_reservation_etag_deleted_2",
            status: "cancelled",
            extendedProperties: {
              private: {
                owner_type: "reservation",
                reservation_id: reservationId,
                store_id: "kyoto"
              }
            }
          }
        ],
        nextSyncToken: "sync_token_after_self_delete_tombstone_1"
      })
    ) as unknown as typeof fetch;

    const importResult = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: importFetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(importResult.succeeded).toBe(1);
    const conflicts = d1.sqlite
      .prepare(
        "SELECT conflict_type FROM google_calendar_conflicts WHERE google_event_id = 'google_reservation_event_deleted_1'"
      )
      .all() as { conflict_type: string }[];
    expect(conflicts).toEqual([]);
    const restoreJobCount = d1.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'upsert'"
      )
      .get(reservationId) as { count: number };
    expect(restoreJobCount.count).toBe(0);
    // The ledger row stays deleted but its last_seen_at moves forward so the
    // orphan sweep keeps counting it as seen.
    const ledger = d1.sqlite
      .prepare(
        "SELECT status, last_seen_at FROM google_calendar_events WHERE google_event_id = 'google_reservation_event_deleted_1'"
      )
      .get() as { status: string; last_seen_at: string };
    expect(ledger.status).toBe("deleted");
    expect(Date.parse(ledger.last_seen_at)).toBeGreaterThan(Date.parse(afterDelete.last_seen_at));
  });

  it("still opens a marker conflict when the ledger row was flipped to deleted by the orphan sweep", async () => {
    // The orphan sweep writes status='deleted' to any row it has not seen for
    // ORPHAN_GRACE_SECONDS, keeping reservation_id and source_type. So a
    // ledger-only check would let someone push a confirmed reservation's event
    // out of the events.list window, wait for the daily full reconcile, then
    // bring it back and delete it — and the deletion would be swallowed. The
    // reservation still points at the event id here, which is what a swept row
    // looks like and what a delete we issued never looks like.
    const reservationId = await createConfirmedReservationWithGoogleEvent();
    d1.sqlite
      .prepare(
        `
          INSERT INTO google_calendar_events (
            id,
            store_id,
            calendar_id,
            google_event_id,
            reservation_id,
            source_type,
            status,
            google_safe_snapshot_json
          ) VALUES (
            'google_calendar_event_orphan_swept_1',
            'kyoto',
            ?,
            'google_reservation_event_deleted_1',
            ?,
            'reservation',
            'deleted',
            '{"google_event_id":"google_reservation_event_deleted_1","status":"cancelled"}'
          )
        `
      )
      .run(CALENDAR_ID, reservationId);
    insertActiveChannel(null);
    insertImportJob("full_reconcile");
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "google_reservation_event_deleted_1",
            etag: "google_reservation_etag_orphan_swept_1",
            status: "cancelled",
            extendedProperties: {
              private: {
                owner_type: "reservation",
                reservation_id: reservationId,
                store_id: "kyoto"
              }
            }
          }
        ],
        nextSyncToken: "sync_token_after_orphan_swept_tombstone_1"
      })
    ) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result.succeeded).toBe(1);
    const conflict = d1.sqlite
      .prepare(
        "SELECT conflict_type, resolution_status FROM google_calendar_conflicts WHERE google_event_id = 'google_reservation_event_deleted_1'"
      )
      .get() as { conflict_type: string; resolution_status: string };
    expect(conflict).toEqual({
      conflict_type: "reservation_marker_mismatch",
      resolution_status: "open"
    });
  });

  it("still opens a marker conflict for a cancelled event we have no deletion record for", async () => {
    // The suppression must stay narrow: with no matching status='deleted'
    // ledger row the cancelled event is not one of ours, and the fail-closed
    // conflict is still the right answer.
    const reservationId = await createConfirmedReservationWithGoogleEvent();
    insertActiveChannel(null);
    insertImportJob("full_reconcile");
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "unknown_cancelled_marker_event_1",
            etag: "unknown_cancelled_marker_etag_1",
            status: "cancelled",
            extendedProperties: {
              private: {
                owner_type: "reservation",
                reservation_id: reservationId,
                store_id: "kyoto"
              }
            }
          }
        ],
        nextSyncToken: "sync_token_after_unknown_cancelled_marker_1"
      })
    ) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result.succeeded).toBe(1);
    const conflict = d1.sqlite
      .prepare(
        "SELECT conflict_type, resolution_status FROM google_calendar_conflicts WHERE google_event_id = 'unknown_cancelled_marker_event_1'"
      )
      .get() as { conflict_type: string; resolution_status: string };
    expect(conflict).toEqual({
      conflict_type: "reservation_marker_mismatch",
      resolution_status: "open"
    });
  });

  it("records Google busy events that overlap existing slots as conflicts without throwing", async () => {
    insertActiveChannel(null);
    insertImportJob("full_reconcile");
    d1.sqlite
      .prepare(
        `
          INSERT INTO slot_locks (
            id,
            store_id,
            resource_id,
            slot_at,
            owner_type,
            owner_id,
            lock_status
          ) VALUES (
            'slot_lock_existing_google_busy_conflict_1',
            'kyoto',
            'resource_kyoto_calendar',
            '2026-06-01T03:00:00.000Z',
            'reservation',
            'reservation_existing_google_busy_conflict_1',
            'confirmed'
          )
        `
      )
      .run();
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "google_busy_overlap_event_1",
            status: "confirmed",
            summary: "店内ミーティング 山田様",
            start: {
              dateTime: "2026-06-01T03:00:00.000Z"
            },
            end: {
              dateTime: "2026-06-01T04:00:00.000Z"
            }
          }
        ],
        nextSyncToken: "sync_token_after_busy_overlap_1"
      })
    ) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result).toEqual({
      processed: 1,
      succeeded: 1,
      failed: 0,
      fullSyncQueued: 0,
      yielded: 0
    });
    const blockCount = d1.sqlite.prepare("SELECT COUNT(*) AS count FROM external_blocks").get() as { count: number };
    expect(blockCount.count).toBe(0);
    const conflict = d1.sqlite
      .prepare("SELECT conflict_type, resolution_status, resolved_by FROM google_calendar_conflicts WHERE google_event_id = 'google_busy_overlap_event_1'")
      .get() as { conflict_type: string; resolution_status: string; resolved_by: string | null };
    // Staff-calendar housekeeping overlapping a reservation slot is recurring noise,
    // not an actionable conflict — recorded pre-resolved ("ignored") so it stays out
    // of every open-conflict reader (要対応 list / owner summary / daily summary / burst).
    expect(conflict).toEqual({
      conflict_type: "external_block_slot_conflict",
      resolution_status: "ignored",
      resolved_by: "system:auto_external_block_overlap"
    });
    const googleEvent = d1.sqlite
      .prepare("SELECT source_type, status, google_safe_snapshot_json FROM google_calendar_events WHERE google_event_id = 'google_busy_overlap_event_1'")
      .get() as { source_type: string; status: string; google_safe_snapshot_json: string };
    expect(googleEvent.source_type).toBe("unknown");
    expect(googleEvent.status).toBe("conflict");
    // PII boundary: events table snapshot must NOT carry summary
    expect(JSON.parse(googleEvent.google_safe_snapshot_json)).not.toHaveProperty("summary");
    expect(googleEvent.google_safe_snapshot_json).not.toContain("山田");
    // Conflicts table snapshot DOES carry summary (system_admin triage)
    const conflictSnapshot = d1.sqlite
      .prepare("SELECT google_safe_snapshot_json FROM google_calendar_conflicts WHERE google_event_id = 'google_busy_overlap_event_1'")
      .get() as { google_safe_snapshot_json: string };
    expect(JSON.parse(conflictSnapshot.google_safe_snapshot_json).summary).toBe("店内ミーティング 山田様");
  });

  it("does not pile up ignored conflict rows when the same staff-calendar overlap re-imports", async () => {
    // The auto-dismiss path dedups on the SAME status it inserts ('ignored'), so a
    // recurring overlap that re-imports on every sync records exactly one row instead
    // of appending a fresh ignored row each time. Seed a prior auto-dismissed row,
    // then run an import that re-detects the same overlap, and assert the count stays 1.
    insertActiveChannel(null);
    insertImportJob("full_reconcile");
    d1.sqlite
      .prepare(
        `INSERT INTO slot_locks (id, store_id, resource_id, slot_at, owner_type, owner_id, lock_status)
         VALUES ('slot_lock_overlap_dedupe_1', 'kyoto', 'resource_kyoto_calendar', '2026-06-01T03:00:00.000Z', 'reservation', 'reservation_overlap_dedupe_1', 'confirmed')`
      )
      .run();
    d1.sqlite
      .prepare(
        `INSERT INTO google_calendar_conflicts (
           id, store_id, calendar_id, google_event_id, conflict_type,
           google_safe_snapshot_json, resolution_status, resolved_by
         ) VALUES (
           'conflict_overlap_dedupe_pre', 'kyoto', 'calendar-a@example.invalid',
           'google_busy_overlap_dedupe_1', 'external_block_slot_conflict',
           '{}', 'ignored', 'system:auto_external_block_overlap'
         )`
      )
      .run();
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "google_busy_overlap_dedupe_1",
            status: "confirmed",
            summary: "休憩",
            start: { dateTime: "2026-06-01T03:00:00.000Z" },
            end: { dateTime: "2026-06-01T04:00:00.000Z" }
          }
        ],
        nextSyncToken: "sync_token_overlap_dedupe_1"
      })
    ) as unknown as typeof fetch;
    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });
    expect(result).toMatchObject({ processed: 1, succeeded: 1, failed: 0 });
    const count = d1.sqlite
      .prepare(
        "SELECT COUNT(*) AS n FROM google_calendar_conflicts WHERE google_event_id = 'google_busy_overlap_dedupe_1' AND conflict_type = 'external_block_slot_conflict'"
      )
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("keeps an already-imported block moved into a conflicting time 'open' (real divergence, not auto-dismissed)", async () => {
    // An ALREADY-IMPORTED google_calendar external block is moved (in Google) onto a
    // time now held by a reservation. D1 keeps the block at its old time while Google
    // has it at the conflicting time — a real divergence the operator must reconcile.
    // Unlike a NEW unknown overlap (external_block_id IS NULL = recurring noise), this
    // is recorded 'open' (actionable), NOT auto-dismissed to 'ignored'.
    insertActiveChannel(null);
    insertImportJob("full_reconcile");
    d1.sqlite
      .prepare(
        `INSERT INTO external_blocks (
           id, store_id, resource_id, source, title_snapshot, start_at, end_at,
           status, google_event_id, google_event_etag, created_by
         ) VALUES (
           'external_block_move_conflict_1', 'kyoto', 'resource_kyoto_calendar', 'google_calendar',
           '休憩', '2026-06-01T09:00:00.000Z', '2026-06-01T10:00:00.000Z',
           'active', 'google_move_conflict_event_1', 'old_etag', 'google_calendar'
         )`
      )
      .run();
    // A reservation already holds the block's NEW (moved) time.
    d1.sqlite
      .prepare(
        `INSERT INTO slot_locks (id, store_id, resource_id, slot_at, owner_type, owner_id, lock_status)
         VALUES ('slot_lock_move_conflict_resv_1', 'kyoto', 'resource_kyoto_calendar', '2026-06-01T11:00:00.000Z', 'reservation', 'reservation_move_conflict_1', 'confirmed')`
      )
      .run();
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "google_move_conflict_event_1",
            etag: "new_etag",
            status: "confirmed",
            summary: "休憩",
            transparency: "opaque",
            updated: "2026-06-02T00:00:00.000Z",
            start: { dateTime: "2026-06-01T11:00:00.000Z", timeZone: "Asia/Tokyo" },
            end: { dateTime: "2026-06-01T12:00:00.000Z", timeZone: "Asia/Tokyo" }
          }
        ],
        nextSyncToken: "sync_token_move_conflict_1"
      })
    ) as unknown as typeof fetch;
    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });
    expect(result).toMatchObject({ processed: 1, succeeded: 1, failed: 0 });
    // Existing-block move-into-conflict is recorded actionable (open), with the block id.
    const conflict = d1.sqlite
      .prepare(
        "SELECT resolution_status, external_block_id FROM google_calendar_conflicts WHERE google_event_id = 'google_move_conflict_event_1' AND conflict_type = 'external_block_slot_conflict'"
      )
      .get() as { resolution_status: string; external_block_id: string | null } | undefined;
    expect(conflict?.resolution_status).toBe("open");
    expect(conflict?.external_block_id).toBe("external_block_move_conflict_1");
    // The block was NOT moved — D1 keeps the old time (the divergence the operator reconciles).
    const block = d1.sqlite
      .prepare("SELECT start_at FROM external_blocks WHERE id = 'external_block_move_conflict_1'")
      .get() as { start_at: string };
    expect(block.start_at).toBe("2026-06-01T09:00:00.000Z");
  });

  it("records misaligned Google busy events as conflicts without creating external blocks", async () => {
    insertActiveChannel(null);
    insertImportJob("full_reconcile");
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "google_busy_misaligned_event_1",
            status: "confirmed",
            start: {
              dateTime: "2026-06-01T03:07:00.000Z"
            },
            end: {
              dateTime: "2026-06-01T04:07:00.000Z"
            }
          }
        ],
        nextSyncToken: "sync_token_after_busy_misaligned_1"
      })
    ) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result.succeeded).toBe(1);
    expect(d1.sqlite.prepare("SELECT COUNT(*) AS count FROM external_blocks").get()).toEqual({ count: 0 });
    const conflict = d1.sqlite
      .prepare("SELECT conflict_type, resolution_status FROM google_calendar_conflicts WHERE google_event_id = 'google_busy_misaligned_event_1'")
      .get() as { conflict_type: string; resolution_status: string };
    expect(conflict).toEqual({
      conflict_type: "external_block_invalid_time",
      resolution_status: "open"
    });
  });

  it("accepts same-duration Google moves for reservation events when the target slots are available", async () => {
    const reservationId = await createConfirmedReservationWithGoogleEvent();
    insertActiveChannel(null);
    insertImportJob("full_reconcile");
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "google_reservation_event_deleted_1",
            etag: "google_reservation_etag_moved_1",
            status: "confirmed",
            updated: "2026-06-01T00:00:00.000Z",
            start: {
              dateTime: "2026-06-01T03:00:00.000Z"
            },
            end: {
              dateTime: "2026-06-01T04:00:00.000Z"
            },
            extendedProperties: {
              private: {
                owner_type: "reservation",
                reservation_id: reservationId,
                store_id: "kyoto"
              }
            }
          }
        ],
        nextSyncToken: "sync_token_after_reservation_move_1"
      })
    ) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result.succeeded).toBe(1);
    const reservation = d1.sqlite
      .prepare("SELECT start_at, end_at, google_event_etag FROM reservations WHERE id = ?")
      .get(reservationId) as { start_at: string; end_at: string; google_event_etag: string };
    expect(reservation).toEqual({
      start_at: "2026-06-01T03:00:00.000Z",
      end_at: "2026-06-01T04:00:00.000Z",
      google_event_etag: "google_reservation_etag_moved_1"
    });
    const locks = d1.sqlite
      .prepare("SELECT slot_at FROM slot_locks WHERE owner_id = ? ORDER BY slot_at")
      .all(reservationId) as { slot_at: string }[];
    expect(locks.map((lock) => lock.slot_at)).toEqual(fiveMinuteSlots("2026-06-01T03:00:00.000Z", 60));
    const audit = d1.sqlite
      .prepare("SELECT actor_type, action FROM audit_logs WHERE target_id = ? AND action = 'google_reservation_time_changed'")
      .get(reservationId) as { actor_type: string; action: string };
    expect(audit).toEqual({
      actor_type: "google_calendar",
      action: "google_reservation_time_changed"
    });
    const notification = d1.sqlite
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM notification_jobs
          WHERE reservation_id = ?
            AND template_key = 'reservation_time_changed'
        `
      )
      .get(reservationId) as { count: number };
    expect(notification.count).toBe(1);

    d1.sqlite
      .prepare(
        `
          INSERT INTO google_calendar_import_jobs (
            id,
            store_id,
            calendar_id,
            reason,
            status,
            next_run_at,
            dedupe_key
          ) VALUES (
            'google_import_job_duplicate_move_1',
            'kyoto',
            ?,
            'full_reconcile',
            'queued',
            '2026-05-09T00:00:00.000Z',
            'google_import_job_duplicate_move_1'
          )
        `
      )
      .run(CALENDAR_ID);
    await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_100_000
    });

    d1.sqlite
      .prepare(
        `
          INSERT INTO google_calendar_import_jobs (
            id,
            store_id,
            calendar_id,
            reason,
            status,
            next_run_at,
            dedupe_key
          ) VALUES (
            'google_import_job_second_move_1',
            'kyoto',
            ?,
            'full_reconcile',
            'queued',
            '2026-05-09T00:01:00.000Z',
            'google_import_job_second_move_1'
          )
        `
      )
      .run(CALENDAR_ID);
    const secondMoveFetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "google_reservation_event_deleted_1",
            etag: "google_reservation_etag_moved_2",
            status: "confirmed",
            updated: "2026-06-01T00:01:00.000Z",
            start: {
              dateTime: "2026-06-01T04:00:00.000Z"
            },
            end: {
              dateTime: "2026-06-01T05:00:00.000Z"
            },
            extendedProperties: {
              private: {
                owner_type: "reservation",
                reservation_id: reservationId,
                store_id: "kyoto"
              }
            }
          }
        ],
        nextSyncToken: "sync_token_after_reservation_move_2"
      })
    ) as unknown as typeof fetch;
    await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: secondMoveFetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_120_000
    });
    const debouncedNotification = d1.sqlite
      .prepare(
        `
          SELECT COUNT(*) AS count, MAX(available_at) AS latest_available_at
          FROM notification_jobs
          WHERE reservation_id = ?
            AND template_key = 'reservation_time_changed'
        `
      )
      .get(reservationId) as { count: number; latest_available_at: string };
    expect(debouncedNotification.count).toBe(1);
    expect(debouncedNotification.latest_available_at).toBe("2027-01-15T08:05:00.000Z");

    d1.sqlite
      .prepare(
        `
          UPDATE notification_jobs
          SET status = 'succeeded'
          WHERE reservation_id = ?
            AND template_key = 'reservation_time_changed'
        `
      )
      .run(reservationId);

    d1.sqlite
      .prepare(
        `
          INSERT INTO google_calendar_import_jobs (
            id,
            store_id,
            calendar_id,
            reason,
            status,
            next_run_at,
            dedupe_key
          ) VALUES (
            'google_import_job_third_move_after_sent_1',
            'kyoto',
            ?,
            'full_reconcile',
            'queued',
            '2026-05-09T00:02:00.000Z',
            'google_import_job_third_move_after_sent_1'
          )
        `
      )
      .run(CALENDAR_ID);
    const thirdMoveFetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "google_reservation_event_deleted_1",
            etag: "google_reservation_etag_moved_3",
            status: "confirmed",
            updated: "2026-06-01T00:02:00.000Z",
            start: {
              dateTime: "2026-06-01T05:00:00.000Z"
            },
            end: {
              dateTime: "2026-06-01T06:00:00.000Z"
            },
            extendedProperties: {
              private: {
                owner_type: "reservation",
                reservation_id: reservationId,
                store_id: "kyoto"
              }
            }
          }
        ],
        nextSyncToken: "sync_token_after_reservation_move_3"
      })
    ) as unknown as typeof fetch;
    await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: thirdMoveFetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_150_000
    });
    const notificationAfterSent = d1.sqlite
      .prepare(
        `
          SELECT COUNT(*) AS count, MAX(available_at) AS latest_available_at
          FROM notification_jobs
          WHERE reservation_id = ?
            AND template_key = 'reservation_time_changed'
        `
      )
      .get(reservationId) as { count: number; latest_available_at: string };
    expect(notificationAfterSent.count).toBe(2);
    expect(notificationAfterSent.latest_available_at).toBe("2027-01-15T08:05:30.000Z");
  });

  it("creates conflict instead of auto-accepting move when google_controlled_edit_mode is OFF", async () => {
    d1.sqlite.prepare("UPDATE store_settings SET google_controlled_edit_mode = 0 WHERE store_id = 'kyoto'").run();
    const reservationId = await createConfirmedReservationWithGoogleEvent();
    const originalReservation = d1.sqlite
      .prepare("SELECT start_at, end_at FROM reservations WHERE id = ?")
      .get(reservationId) as { start_at: string; end_at: string };
    insertActiveChannel(null);
    insertImportJob("full_reconcile");
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "google_reservation_event_deleted_1",
            etag: "google_reservation_etag_moved_off_1",
            status: "confirmed",
            updated: "2026-06-01T00:00:00.000Z",
            start: { dateTime: "2026-06-01T03:00:00.000Z" },
            end: { dateTime: "2026-06-01T04:00:00.000Z" },
            extendedProperties: {
              private: {
                owner_type: "reservation",
                reservation_id: reservationId,
                store_id: "kyoto"
              }
            }
          }
        ],
        nextSyncToken: "sync_token_after_edit_mode_off_1"
      })
    ) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result.succeeded).toBe(1);
    const reservation = d1.sqlite
      .prepare("SELECT start_at, end_at FROM reservations WHERE id = ?")
      .get(reservationId) as { start_at: string; end_at: string };
    expect(reservation.start_at).toBe(originalReservation.start_at);
    expect(reservation.end_at).toBe(originalReservation.end_at);
    const conflict = d1.sqlite
      .prepare("SELECT conflict_type, resolution_status FROM google_calendar_conflicts WHERE reservation_id = ?")
      .get(reservationId) as { conflict_type: string; resolution_status: string } | undefined;
    expect(conflict).toBeTruthy();
    expect(conflict?.conflict_type).toBe("reservation_edit_mode_disabled");
    expect(conflict?.resolution_status).toBe("open");
  });

  it("preserves pending approval lock expiry when accepting a Google reservation move", async () => {
    const reservationId = await createConfirmedReservationWithGoogleEvent();
    const pendingExpiresAt = "2026-06-01T00:30:00.000Z";
    d1.sqlite
      .prepare(
        `
          UPDATE reservations
          SET status = 'pending_approval',
              pending_expires_at = ?
          WHERE id = ?
        `
      )
      .run(pendingExpiresAt, reservationId);
    d1.sqlite
      .prepare(
        `
          UPDATE slot_locks
          SET lock_status = 'pending',
              expires_at = ?
          WHERE owner_id = ?
        `
      )
      .run(pendingExpiresAt, reservationId);
    d1.sqlite
      .prepare(
        `
          UPDATE customer_time_locks
          SET lock_status = 'pending',
              expires_at = ?
          WHERE owner_id = ?
        `
      )
      .run(pendingExpiresAt, reservationId);
    insertActiveChannel(null);
    insertImportJob("full_reconcile");
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "google_reservation_event_deleted_1",
            etag: "google_reservation_etag_pending_moved_1",
            status: "confirmed",
            updated: "2026-06-01T00:00:00.000Z",
            start: {
              dateTime: "2026-06-01T03:00:00.000Z"
            },
            end: {
              dateTime: "2026-06-01T04:00:00.000Z"
            },
            extendedProperties: {
              private: {
                owner_type: "reservation",
                reservation_id: reservationId,
                store_id: "kyoto"
              }
            }
          }
        ],
        nextSyncToken: "sync_token_after_pending_reservation_move_1"
      })
    ) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result.succeeded).toBe(1);
    const reservation = d1.sqlite
      .prepare("SELECT status, start_at, end_at, pending_expires_at FROM reservations WHERE id = ?")
      .get(reservationId) as { status: string; start_at: string; end_at: string; pending_expires_at: string };
    expect(reservation).toEqual({
      status: "pending_approval",
      start_at: "2026-06-01T03:00:00.000Z",
      end_at: "2026-06-01T04:00:00.000Z",
      pending_expires_at: pendingExpiresAt
    });
    const slotLocks = d1.sqlite
      .prepare(
        `
          SELECT slot_at, lock_status, expires_at
          FROM slot_locks
          WHERE owner_id = ?
          ORDER BY slot_at
        `
      )
      .all(reservationId) as { slot_at: string; lock_status: string; expires_at: string }[];
    expect(slotLocks).toEqual(
      fiveMinuteSlots("2026-06-01T03:00:00.000Z", 60).map((slotAt) => ({
        slot_at: slotAt,
        lock_status: "pending",
        expires_at: pendingExpiresAt
      }))
    );
    const customerLocks = d1.sqlite
      .prepare(
        `
          SELECT slot_at, lock_status, expires_at
          FROM customer_time_locks
          WHERE owner_id = ?
          ORDER BY slot_at
        `
      )
      .all(reservationId) as { slot_at: string; lock_status: string; expires_at: string }[];
    expect(customerLocks).toEqual(slotLocks);
    const notificationCount = d1.sqlite
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM notification_jobs
          WHERE reservation_id = ?
            AND template_key = 'reservation_time_changed'
        `
      )
      .get(reservationId) as { count: number };
    expect(notificationCount.count).toBe(0);
  });

  it.each([
    { source: "phone_admin", expectedPhoneHash: "phone_hash_google_after" },
    { source: "system_import", expectedPhoneHash: null }
  ])("uses the current customer phone_hash policy after the Google move precheck ($source)", async ({
    source,
    expectedPhoneHash
  }) => {
    const reservationId = await createConfirmedReservationWithGoogleEvent();
    const customer = d1.sqlite
      .prepare("SELECT customer_id FROM reservations WHERE id = ?")
      .get(reservationId) as { customer_id: string };
    d1.sqlite.prepare("UPDATE reservations SET source = ? WHERE id = ?").run(source, reservationId);
    d1.sqlite
      .prepare("UPDATE customers SET phone_normalized = '0900000031', phone_hash = 'phone_hash_google_before' WHERE id = ?")
      .run(customer.customer_id);
    insertActiveChannel(null);
    insertImportJob("full_reconcile");
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "google_reservation_event_deleted_1",
            etag: "google_reservation_etag_phone_race_1",
            status: "confirmed",
            updated: "2026-06-01T00:00:00.000Z",
            start: { dateTime: "2026-06-01T03:00:00.000Z" },
            end: { dateTime: "2026-06-01T04:00:00.000Z" },
            extendedProperties: {
              private: {
                owner_type: "reservation",
                reservation_id: reservationId,
                store_id: "kyoto"
              }
            }
          }
        ],
        nextSyncToken: "sync_token_after_phone_hash_race_1"
      })
    ) as unknown as typeof fetch;
    const currentPhoneHash = "phone_hash_google_after";
    let injectedRace = false;
    const racingDb = {
      prepare: d1.prepare.bind(d1),
      batch: async (statements: D1PreparedStatement[]) => {
        if (!injectedRace) {
          injectedRace = true;
          d1.sqlite
            .prepare("UPDATE customers SET phone_normalized = '0900000032', phone_hash = ? WHERE id = ?")
            .run(currentPhoneHash, customer.customer_id);
        }
        return d1.batch(statements);
      }
    } as unknown as D1Database;

    const result = await processDueGoogleCalendarImportJobs({
      db: racingDb,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result).toMatchObject({ processed: 1, succeeded: 1, failed: 0 });
    const lockHashes = d1.sqlite
      .prepare("SELECT DISTINCT phone_hash FROM customer_time_locks WHERE owner_id = ?")
      .all(reservationId) as Array<{ phone_hash: string | null }>;
    expect(lockHashes).toEqual([{ phone_hash: expectedPhoneHash }]);
  });

  it("does not persist a Google reservation move when slot replacement loses a race", async () => {
    const reservationId = await createConfirmedReservationWithGoogleEvent();
    insertActiveChannel(null);
    insertImportJob("full_reconcile");
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "google_reservation_event_deleted_1",
            etag: "google_reservation_etag_raced_1",
            status: "confirmed",
            updated: "2026-06-01T00:00:00.000Z",
            start: {
              dateTime: "2026-06-01T03:00:00.000Z"
            },
            end: {
              dateTime: "2026-06-01T04:00:00.000Z"
            },
            extendedProperties: {
              private: {
                owner_type: "reservation",
                reservation_id: reservationId,
                store_id: "kyoto"
              }
            }
          }
        ],
        nextSyncToken: "sync_token_after_reservation_move_race_1"
      })
    ) as unknown as typeof fetch;
    let injectedRace = false;
    const racingDb = {
      prepare: d1.prepare.bind(d1),
      batch: async (statements: D1PreparedStatement[]) => {
        if (!injectedRace) {
          injectedRace = true;
          d1.sqlite
            .prepare(
              `
                INSERT INTO slot_locks (
                  id,
                  store_id,
                  resource_id,
                  slot_at,
                  owner_type,
                  owner_id,
                  lock_status
                ) VALUES (
                  'slot_lock_google_move_race_1',
                  'kyoto',
                  'resource_kyoto_calendar',
                  '2026-06-01T03:00:00.000Z',
                  'external_block',
                  'external_block_google_move_race_1',
                  'confirmed'
                )
              `
            )
            .run();
        }
        return d1.batch(statements);
      }
    } as unknown as D1Database;

    const result = await processDueGoogleCalendarImportJobs({
      db: racingDb,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    // A foreign slot_locks UNIQUE race on the destination is now a HANDLED conflict
    // (audit + canonical revert), not an unhandled throw: the move still does not
    // persist, but the import event is consumed so the sync token advances and the
    // calendar's incremental sync is not stalled (B4).
    expect(result).toMatchObject({
      processed: 1,
      succeeded: 1,
      failed: 0
    });
    const reservation = d1.sqlite
      .prepare("SELECT start_at, end_at, google_event_etag FROM reservations WHERE id = ?")
      .get(reservationId) as { start_at: string; end_at: string; google_event_etag: string };
    expect(reservation).toEqual({
      start_at: "2026-06-01T01:00:00.000Z",
      end_at: "2026-06-01T02:00:00.000Z",
      google_event_etag: "google_reservation_etag_deleted_1"
    });
    const slotConflict = d1.sqlite
      .prepare("SELECT conflict_type FROM google_calendar_conflicts WHERE reservation_id = ?")
      .get(reservationId) as { conflict_type: string } | undefined;
    expect(slotConflict?.conflict_type).toBe("reservation_slot_conflict");
    const reservationLocks = d1.sqlite
      .prepare("SELECT slot_at FROM slot_locks WHERE owner_id = ? ORDER BY slot_at")
      .all(reservationId) as { slot_at: string }[];
    expect(reservationLocks.map((lock) => lock.slot_at)).toEqual(fiveMinuteSlots("2026-06-01T01:00:00.000Z", 60));
    const sideEffects = d1.sqlite
      .prepare(
        `
          SELECT
            (SELECT COUNT(*) FROM audit_logs WHERE target_id = ? AND action = 'google_reservation_time_changed') AS auditCount,
            (SELECT COUNT(*) FROM notification_jobs WHERE reservation_id = ? AND template_key = 'reservation_time_changed') AS notificationCount,
            (SELECT COUNT(*) FROM google_calendar_events WHERE google_event_id = 'google_reservation_event_deleted_1' AND status = 'active') AS googleEventCount
        `
      )
      .get(reservationId, reservationId) as {
      auditCount: number;
      notificationCount: number;
      googleEventCount: number;
    };
    expect(sideEffects).toEqual({
      auditCount: 0,
      notificationCount: 0,
      googleEventCount: 0
    });
    const job = d1.sqlite
      .prepare("SELECT status, last_error FROM google_calendar_import_jobs WHERE id = 'google_import_job_full_reconcile_1'")
      .get() as { status: string; last_error: string | null };
    expect(job).toEqual({
      status: "succeeded",
      last_error: null
    });
  });

  it("records a handled business-time conflict when a closure wins the Google move race", async () => {
    const reservationId = await createConfirmedReservationWithGoogleEvent();
    insertActiveChannel(null);
    insertImportJob("full_reconcile");
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "google_reservation_event_deleted_1",
            etag: "google_reservation_etag_closure_race_1",
            status: "confirmed",
            updated: "2026-06-01T00:00:00.000Z",
            start: { dateTime: "2026-06-01T03:00:00.000Z" },
            end: { dateTime: "2026-06-01T04:00:00.000Z" },
            extendedProperties: {
              private: {
                owner_type: "reservation",
                reservation_id: reservationId,
                store_id: "kyoto"
              }
            }
          }
        ],
        nextSyncToken: "sync_token_after_reservation_closure_race_1"
      })
    ) as unknown as typeof fetch;
    let injectedRace = false;
    const racingDb = {
      prepare: d1.prepare.bind(d1),
      batch: async (statements: D1PreparedStatement[]) => {
        if (!injectedRace) {
          injectedRace = true;
          d1.sqlite
            .prepare(
              `INSERT INTO store_closures (id, store_id, starts_at, ends_at, source)
               VALUES ('closure_google_move_race_1', 'kyoto',
                       '2026-06-01T03:00:00.000Z', '2026-06-01T04:00:00.000Z', 'admin')`
            )
            .run();
        }
        return d1.batch(statements);
      }
    } as unknown as D1Database;

    const result = await processDueGoogleCalendarImportJobs({
      db: racingDb,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result).toMatchObject({ processed: 1, succeeded: 1, failed: 0 });
    const reservation = d1.sqlite
      .prepare("SELECT start_at, end_at FROM reservations WHERE id = ?")
      .get(reservationId) as { start_at: string; end_at: string };
    expect(reservation).toEqual({
      start_at: "2026-06-01T01:00:00.000Z",
      end_at: "2026-06-01T02:00:00.000Z"
    });
    const conflict = d1.sqlite
      .prepare("SELECT conflict_type, resolution_status FROM google_calendar_conflicts WHERE reservation_id = ?")
      .get(reservationId) as { conflict_type: string; resolution_status: string };
    expect(conflict).toEqual({
      conflict_type: "reservation_business_time_conflict",
      resolution_status: "open"
    });
    const job = d1.sqlite
      .prepare("SELECT status, last_error FROM google_calendar_import_jobs WHERE id = 'google_import_job_full_reconcile_1'")
      .get() as { status: string; last_error: string | null };
    expect(job).toEqual({ status: "succeeded", last_error: null });
  });

  it("does not advance the sync token when a Google reservation move loses its status guard", async () => {
    const reservationId = await createConfirmedReservationWithGoogleEvent();
    insertActiveChannel(null);
    insertImportJob("full_reconcile");
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "google_reservation_event_deleted_1",
            etag: "google_reservation_etag_status_race_1",
            status: "confirmed",
            updated: "2026-06-01T00:00:00.000Z",
            start: {
              dateTime: "2026-06-01T03:00:00.000Z"
            },
            end: {
              dateTime: "2026-06-01T04:00:00.000Z"
            },
            extendedProperties: {
              private: {
                owner_type: "reservation",
                reservation_id: reservationId,
                store_id: "kyoto"
              }
            }
          }
        ],
        nextSyncToken: "sync_token_after_reservation_move_status_race_1"
      })
    ) as unknown as typeof fetch;
    let injectedRace = false;
    const racingDb = {
      prepare: d1.prepare.bind(d1),
      batch: async (statements: D1PreparedStatement[]) => {
        if (!injectedRace) {
          injectedRace = true;
          d1.sqlite
            .prepare(
              `
                UPDATE reservations
                SET status = 'cancelled_by_admin',
                    version = version + 1,
                    updated_at = '2027-01-15T07:59:59.999Z'
                WHERE id = ?
              `
            )
            .run(reservationId);
        }
        return d1.batch(statements);
      }
    } as unknown as D1Database;

    const result = await processDueGoogleCalendarImportJobs({
      db: racingDb,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result).toMatchObject({
      processed: 1,
      succeeded: 0,
      failed: 1
    });
    const state = d1.sqlite
      .prepare(
        `
          SELECT
            reservations.status,
            reservations.start_at AS startAt,
            reservations.google_event_etag AS googleEventEtag,
            google_calendar_channels.sync_token AS syncToken,
            google_calendar_import_jobs.status AS jobStatus,
            google_calendar_import_jobs.last_error AS lastError
          FROM reservations
          JOIN google_calendar_channels ON google_calendar_channels.id = 'google_calendar_channel_import_1'
          JOIN google_calendar_import_jobs ON google_calendar_import_jobs.id = 'google_import_job_full_reconcile_1'
          WHERE reservations.id = ?
        `
      )
      .get(reservationId) as {
      status: string;
      startAt: string;
      googleEventEtag: string;
      syncToken: string | null;
      jobStatus: string;
      lastError: string;
    };
    expect(state).toEqual({
      status: "cancelled_by_admin",
      startAt: "2026-06-01T01:00:00.000Z",
      googleEventEtag: "google_reservation_etag_deleted_1",
      syncToken: null,
      jobStatus: "retryable",
      lastError: "reservation-move-lost-race"
    });
    const sideEffects = d1.sqlite
      .prepare(
        `
          SELECT
            (SELECT COUNT(*) FROM audit_logs WHERE target_id = ? AND action = 'google_reservation_time_changed') AS auditCount,
            (SELECT COUNT(*) FROM notification_jobs WHERE reservation_id = ? AND template_key = 'reservation_time_changed') AS notificationCount,
            (SELECT COUNT(*) FROM google_calendar_events WHERE google_event_id = 'google_reservation_event_deleted_1' AND status = 'active') AS googleEventCount
        `
      )
      .get(reservationId, reservationId) as {
      auditCount: number;
      notificationCount: number;
      googleEventCount: number;
    };
    expect(sideEffects).toEqual({
      auditCount: 0,
      notificationCount: 0,
      googleEventCount: 0
    });
  });

  it("does not duplicate Google move side effects when the same move already committed", async () => {
    const reservationId = await createConfirmedReservationWithGoogleEvent();
    insertActiveChannel(null);
    insertImportJob("full_reconcile");
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "google_reservation_event_deleted_1",
            etag: "google_reservation_etag_duplicate_same_move_1",
            status: "confirmed",
            updated: "2026-06-01T00:00:00.000Z",
            start: {
              dateTime: "2026-06-01T03:00:00.000Z"
            },
            end: {
              dateTime: "2026-06-01T04:00:00.000Z"
            },
            extendedProperties: {
              private: {
                owner_type: "reservation",
                reservation_id: reservationId,
                store_id: "kyoto"
              }
            }
          }
        ],
        nextSyncToken: "sync_token_after_duplicate_same_move_1"
      })
    ) as unknown as typeof fetch;
    const auditMetadataJson = JSON.stringify({
      old_start_at: "2026-06-01T01:00:00.000Z",
      old_end_at: "2026-06-01T02:00:00.000Z",
      new_start_at: "2026-06-01T03:00:00.000Z",
      new_end_at: "2026-06-01T04:00:00.000Z"
    });
    let injectedRace = false;
    const racingDb = {
      prepare: d1.prepare.bind(d1),
      batch: async (statements: D1PreparedStatement[]) => {
        if (!injectedRace) {
          injectedRace = true;
          d1.sqlite
            .prepare(
              `
                UPDATE reservations
                SET start_at = '2026-06-01T03:00:00.000Z',
                    end_at = '2026-06-01T04:00:00.000Z',
                    google_event_etag = 'google_reservation_etag_duplicate_same_move_1',
                    google_sync_state = 'synced',
                    version = version + 1,
                    updated_by = 'google_calendar',
                    updated_at = '2027-01-15T08:00:00.000Z'
                WHERE id = ?
              `
            )
            .run(reservationId);
          d1.sqlite.prepare("DELETE FROM slot_locks WHERE owner_id = ?").run(reservationId);
          d1.sqlite.prepare("DELETE FROM customer_time_locks WHERE owner_id = ?").run(reservationId);
          const customer = d1.sqlite
            .prepare("SELECT customer_id FROM reservations WHERE id = ?")
            .get(reservationId) as { customer_id: string };
          for (const [index, slotAt] of fiveMinuteSlots("2026-06-01T03:00:00.000Z", 60).entries()) {
            d1.sqlite
              .prepare(
                `
                  INSERT INTO slot_locks (
                    id,
                    store_id,
                    resource_id,
                    slot_at,
                    owner_type,
                    owner_id,
                    lock_status
                  ) VALUES (?, 'kyoto', 'resource_kyoto_calendar', ?, 'reservation', ?, 'confirmed')
                `
              )
              .run(`slot_lock_duplicate_same_move_${index}`, slotAt, reservationId);
            d1.sqlite
              .prepare(
                `
                  INSERT INTO customer_time_locks (
                    id,
                    customer_id,
                    slot_at,
                    owner_type,
                    owner_id,
                    lock_status
                  ) VALUES (?, ?, ?, 'reservation', ?, 'confirmed')
                `
              )
              .run(`customer_lock_duplicate_same_move_${index}`, customer.customer_id, slotAt, reservationId);
          }
          d1.sqlite
            .prepare(
              `
                INSERT INTO audit_logs (
                  id,
                  actor_type,
                  actor_id,
                  action,
                  target_type,
                  target_id,
                  metadata_json
                ) VALUES (
                  'audit_duplicate_same_move_1',
                  'google_calendar',
                  'google_reservation_event_deleted_1',
                  'google_reservation_time_changed',
                  'reservation',
                  ?,
                  ?
                )
              `
            )
            .run(reservationId, auditMetadataJson);
        }
        return d1.batch(statements);
      }
    } as unknown as D1Database;

    const result = await processDueGoogleCalendarImportJobs({
      db: racingDb,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result).toMatchObject({
      processed: 1,
      succeeded: 0,
      failed: 1
    });
    const counts = d1.sqlite
      .prepare(
        `
          SELECT
            (SELECT COUNT(*) FROM audit_logs WHERE target_id = ? AND action = 'google_reservation_time_changed') AS auditCount,
            (SELECT COUNT(*) FROM notification_jobs WHERE reservation_id = ? AND template_key = 'reservation_time_changed') AS notificationCount,
            (SELECT COUNT(*) FROM slot_locks WHERE owner_id = ?) AS slotLockCount,
            (SELECT COUNT(*) FROM customer_time_locks WHERE owner_id = ?) AS customerLockCount
        `
      )
      .get(reservationId, reservationId, reservationId, reservationId) as {
      auditCount: number;
      notificationCount: number;
      slotLockCount: number;
      customerLockCount: number;
    };
    expect(counts).toEqual({
      auditCount: 1,
      notificationCount: 0,
      slotLockCount: 12,
      customerLockCount: 12
    });
  });

  it("rejects Google reservation moves into occupied slots and queues a canonical revert", async () => {
    const reservationId = await createConfirmedReservationWithGoogleEvent();
    insertActiveChannel(null);
    insertImportJob("full_reconcile");
    d1.sqlite
      .prepare(
        `
          INSERT INTO slot_locks (
            id,
            store_id,
            resource_id,
            slot_at,
            owner_type,
            owner_id,
            lock_status
          ) VALUES (
            'slot_lock_google_move_conflict_1',
            'kyoto',
            'resource_kyoto_calendar',
            '2026-06-01T03:00:00.000Z',
            'external_block',
            'external_block_conflict_1',
            'confirmed'
          )
        `
      )
      .run();
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "google_reservation_event_deleted_1",
            etag: "google_reservation_etag_conflict_1",
            status: "confirmed",
            start: {
              dateTime: "2026-06-01T03:00:00.000Z"
            },
            end: {
              dateTime: "2026-06-01T04:00:00.000Z"
            },
            extendedProperties: {
              private: {
                owner_type: "reservation",
                reservation_id: reservationId,
                store_id: "kyoto"
              }
            }
          }
        ],
        nextSyncToken: "sync_token_after_reservation_conflict_1"
      })
    ) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result.succeeded).toBe(1);
    const reservation = d1.sqlite
      .prepare("SELECT start_at, end_at FROM reservations WHERE id = ?")
      .get(reservationId) as { start_at: string; end_at: string };
    expect(reservation).toEqual({
      start_at: "2026-06-01T01:00:00.000Z",
      end_at: "2026-06-01T02:00:00.000Z"
    });
    const revertJob = d1.sqlite
      .prepare("SELECT google_action, status FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'upsert'")
      .get(reservationId) as { google_action: string; status: string };
    expect(revertJob).toEqual({
      google_action: "upsert",
      status: "queued"
    });
    const conflict = d1.sqlite
      .prepare("SELECT conflict_type, resolution_status FROM google_calendar_conflicts WHERE reservation_id = ?")
      .get(reservationId) as { conflict_type: string; resolution_status: string };
    expect(conflict).toEqual({
      conflict_type: "reservation_slot_conflict",
      resolution_status: "open"
    });
  });

  it("rejects Google reservation moves on checked_in reservations and records audit log + canonical revert", async () => {
    const reservationId = await createConfirmedReservationWithGoogleEvent();
    d1.sqlite
      .prepare(`UPDATE reservations SET checked_in_at = ? WHERE id = ?`)
      .run("2026-06-01T00:30:00.000Z", reservationId);
    insertActiveChannel(null);
    insertImportJob("full_reconcile");

    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "google_reservation_event_deleted_1",
            etag: "google_reservation_etag_checked_in_1",
            status: "confirmed",
            start: { dateTime: "2026-06-01T03:00:00.000Z" },
            end: { dateTime: "2026-06-01T04:00:00.000Z" },
            extendedProperties: {
              private: {
                owner_type: "reservation",
                reservation_id: reservationId,
                store_id: "kyoto"
              }
            }
          }
        ],
        nextSyncToken: "sync_token_after_reservation_checked_in_block_1"
      })
    ) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result.succeeded).toBe(1);

    // Reservation start_at/end_at unchanged
    const reservation = d1.sqlite
      .prepare("SELECT start_at, end_at FROM reservations WHERE id = ?")
      .get(reservationId) as { start_at: string; end_at: string };
    expect(reservation).toEqual({
      start_at: "2026-06-01T01:00:00.000Z",
      end_at: "2026-06-01T02:00:00.000Z"
    });

    // Canonical revert queued
    const revertJob = d1.sqlite
      .prepare("SELECT google_action, status FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'upsert'")
      .get(reservationId) as { google_action: string; status: string };
    expect(revertJob).toEqual({
      google_action: "upsert",
      status: "queued"
    });

    // Conflict type
    const conflict = d1.sqlite
      .prepare("SELECT conflict_type, resolution_status FROM google_calendar_conflicts WHERE reservation_id = ?")
      .get(reservationId) as { conflict_type: string; resolution_status: string };
    expect(conflict).toEqual({
      conflict_type: "reservation_checked_in_move_blocked",
      resolution_status: "open"
    });

    // Audit log emitted only for checked_in branch
    const audit = d1.sqlite
      .prepare(
        `SELECT action, actor_type, target_type, target_id
         FROM audit_logs
         WHERE action = 'google_reservation_time_changed_blocked_checked_in'`
      )
      .get() as { action: string; actor_type: string; target_type: string; target_id: string };
    expect(audit).toEqual({
      action: "google_reservation_time_changed_blocked_checked_in",
      actor_type: "google_calendar",
      target_type: "reservation",
      target_id: reservationId
    });
  });

  it.each([
    {
      name: "outside business hours",
      startAt: "2026-06-01T13:00:00.000Z",
      endAt: "2026-06-01T14:00:00.000Z",
      conflictType: "reservation_outside_business_hours"
    },
    {
      name: "Friday closure",
      startAt: "2026-06-05T03:00:00.000Z",
      endAt: "2026-06-05T04:00:00.000Z",
      conflictType: "reservation_outside_business_hours"
    },
    {
      name: "duration changes",
      startAt: "2026-06-01T03:00:00.000Z",
      endAt: "2026-06-01T04:30:00.000Z",
      conflictType: "reservation_duration_changed"
    },
    {
      name: "misaligned slot boundaries",
      startAt: "2026-06-01T03:07:00.000Z",
      endAt: "2026-06-01T04:07:00.000Z",
      conflictType: "reservation_invalid_time"
    }
  ])("rejects Google reservation moves for $name and queues canonical revert", async ({ startAt, endAt, conflictType }) => {
    const reservationId = await createConfirmedReservationWithGoogleEvent();
    insertActiveChannel(null);
    insertImportJob("full_reconcile");
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "google_reservation_event_deleted_1",
            status: "confirmed",
            start: {
              dateTime: startAt
            },
            end: {
              dateTime: endAt
            },
            extendedProperties: {
              private: {
                owner_type: "reservation",
                reservation_id: reservationId,
                store_id: "kyoto"
              }
            }
          }
        ],
        nextSyncToken: `sync_token_after_${conflictType}`
      })
    ) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result.succeeded).toBe(1);
    const reservation = d1.sqlite
      .prepare("SELECT start_at, end_at FROM reservations WHERE id = ?")
      .get(reservationId) as { start_at: string; end_at: string };
    expect(reservation).toEqual({
      start_at: "2026-06-01T01:00:00.000Z",
      end_at: "2026-06-01T02:00:00.000Z"
    });
    const revertJob = d1.sqlite
      .prepare("SELECT COUNT(*) AS count FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'upsert'")
      .get(reservationId) as { count: number };
    const conflict = d1.sqlite
      .prepare("SELECT conflict_type FROM google_calendar_conflicts WHERE reservation_id = ?")
      .get(reservationId) as { conflict_type: string };
    expect(revertJob.count).toBe(1);
    expect(conflict.conflict_type).toBe(conflictType);
  });

  it("queues a canonical revert for completed reservations when a staff edit changes the etag (codex #14 follow-up)", async () => {
    const reservationId = await createConfirmedReservationWithGoogleEvent();
    // Promote to terminal status so the L2352 branch handles this event.
    d1.sqlite
      .prepare("UPDATE reservations SET status = 'completed' WHERE id = ?")
      .run(reservationId);
    insertActiveChannel(null);
    insertImportJob("full_reconcile");
    // System upsert recorded etag X; staff then edited title/description, which
    // bumps Google's etag to Y. Before this follow-up the terminal-status branch
    // suppressed unconditionally so the PII-bearing event remained on Google
    // Calendar indefinitely (no delete is queued for completed reservations).
    d1.sqlite
      .prepare(
        `
          INSERT INTO google_calendar_outbound_writes (
            id,
            dedupe_key,
            calendar_id,
            google_event_id,
            owner_type,
            owner_id,
            action,
            expected_fingerprint,
            google_etag_after,
            expires_at
          ) VALUES (
            'outbound_terminal_pre_edit_1',
            'outbound_terminal_pre_edit_1',
            ?,
            'google_reservation_event_deleted_1',
            'reservation',
            ?,
            'upsert',
            'fingerprint',
            'google_reservation_etag_x_terminal_1',
            '2027-01-16T08:00:00.000Z'
          )
        `
      )
      .run(CALENDAR_ID, reservationId);
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "google_reservation_event_deleted_1",
            etag: "google_reservation_etag_y_after_staff_edit_terminal_1",
            status: "confirmed",
            start: {
              dateTime: "2026-06-01T01:00:00.000Z"
            },
            end: {
              dateTime: "2026-06-01T02:00:00.000Z"
            },
            extendedProperties: {
              private: {
                owner_type: "reservation",
                reservation_id: reservationId,
                store_id: "kyoto"
              }
            }
          }
        ],
        nextSyncToken: "sync_token_after_terminal_etag_mismatch_1"
      })
    ) as unknown as typeof fetch;

    await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    const revertJobs = d1.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'upsert' AND status = 'queued'"
      )
      .get(reservationId) as { count: number };
    expect(revertJobs.count).toBe(1);
  });

  it("queues a canonical revert when an unchanged-time event etag differs from the active outbound write (codex #14)", async () => {
    const reservationId = await createConfirmedReservationWithGoogleEvent();
    insertActiveChannel(null);
    insertImportJob("full_reconcile");
    // System wrote etag X; an active outbound write records it. A staff edit of
    // title/description leaves start/end unchanged but bumps Google's etag to
    // 'Y'. Before this fix the importer treated this as an echo because the
    // outbound write was still in window; now the etag mismatch must force a
    // canonical revert so PII does not linger in Google Calendar.
    d1.sqlite
      .prepare(
        `
          INSERT INTO google_calendar_outbound_writes (
            id,
            dedupe_key,
            calendar_id,
            google_event_id,
            owner_type,
            owner_id,
            action,
            expected_fingerprint,
            google_etag_after,
            expires_at
          ) VALUES (
            'outbound_pre_edit_1',
            'outbound_pre_edit_1',
            ?,
            'google_reservation_event_deleted_1',
            'reservation',
            ?,
            'upsert',
            'fingerprint',
            'google_reservation_etag_x_1',
            '2027-01-16T08:00:00.000Z'
          )
        `
      )
      .run(CALENDAR_ID, reservationId);
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "google_reservation_event_deleted_1",
            etag: "google_reservation_etag_y_after_staff_edit_1",
            status: "confirmed",
            start: {
              dateTime: "2026-06-01T01:00:00.000Z"
            },
            end: {
              dateTime: "2026-06-01T02:00:00.000Z"
            },
            extendedProperties: {
              private: {
                owner_type: "reservation",
                reservation_id: reservationId,
                store_id: "kyoto"
              }
            }
          }
        ],
        nextSyncToken: "sync_token_after_etag_mismatch_1"
      })
    ) as unknown as typeof fetch;

    await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    const revertJobs = d1.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'upsert' AND status = 'queued'"
      )
      .get(reservationId) as { count: number };
    expect(revertJobs.count).toBe(1);
  });

  it("ignores system patch echoes for unchanged reservation events", async () => {
    const reservationId = await createConfirmedReservationWithGoogleEvent();
    insertActiveChannel(null);
    insertImportJob("full_reconcile");
    d1.sqlite
      .prepare(
        `
          INSERT INTO google_calendar_outbound_writes (
            id,
            dedupe_key,
            calendar_id,
            google_event_id,
            owner_type,
            owner_id,
            action,
            expected_fingerprint,
            google_etag_after,
            expires_at
          ) VALUES (
            'outbound_echo_reservation_1',
            'outbound_echo_reservation_1',
            ?,
            'google_reservation_event_deleted_1',
            'reservation',
            ?,
            'upsert',
            'fingerprint',
            'google_reservation_etag_echo_1',
            '2027-01-16T08:00:00.000Z'
          )
        `
      )
      .run(CALENDAR_ID, reservationId);
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "google_reservation_event_deleted_1",
            etag: "google_reservation_etag_echo_1",
            status: "confirmed",
            start: {
              dateTime: "2026-06-01T01:00:00.000Z"
            },
            end: {
              dateTime: "2026-06-01T02:00:00.000Z"
            },
            extendedProperties: {
              private: {
                owner_type: "reservation",
                reservation_id: reservationId,
                store_id: "kyoto"
              }
            }
          }
        ],
        nextSyncToken: "sync_token_after_echo_1"
      })
    ) as unknown as typeof fetch;

    await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    const jobs = d1.sqlite.prepare("SELECT COUNT(*) AS count FROM calendar_sync_jobs").get() as { count: number };
    const conflicts = d1.sqlite.prepare("SELECT COUNT(*) AS count FROM google_calendar_conflicts").get() as { count: number };
    expect(jobs.count).toBe(0);
    expect(conflicts.count).toBe(0);
  });

  it("does not reopen conflicts for invalid edit pushes while a canonical revert write is active", async () => {
    const reservationId = await createConfirmedReservationWithGoogleEvent();
    insertActiveChannel(null);
    insertImportJob("full_reconcile");
    d1.sqlite
      .prepare(
        `
          INSERT INTO google_calendar_conflicts (
            id,
            store_id,
            calendar_id,
            google_event_id,
            reservation_id,
            conflict_type,
            google_safe_snapshot_json,
            resolution_status,
            resolved_at,
            resolved_by
          ) VALUES (
            'google_conflict_auto_reverted_1',
            'kyoto',
            ?,
            'google_reservation_event_deleted_1',
            ?,
            'reservation_duration_changed',
            '{"kind":"previous_invalid_edit"}',
            'auto_reverted',
            '2026-05-09T00:00:00.000Z',
            'system'
          )
        `
      )
      .run(CALENDAR_ID, reservationId);
    d1.sqlite
      .prepare(
        `
          INSERT INTO google_calendar_outbound_writes (
            id,
            dedupe_key,
            calendar_id,
            google_event_id,
            owner_type,
            owner_id,
            action,
            expected_fingerprint,
            google_etag_after,
            expires_at
          ) VALUES (
            'outbound_revert_active_1',
            'outbound_revert_active_1',
            ?,
            'google_reservation_event_deleted_1',
            'reservation',
            ?,
            'upsert',
            'fingerprint',
            'google_reservation_etag_revert_active_1',
            '2027-01-16T08:00:00.000Z'
          )
        `
      )
      .run(CALENDAR_ID, reservationId);
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "google_reservation_event_deleted_1",
            etag: "google_reservation_etag_revert_active_1",
            status: "confirmed",
            start: {
              dateTime: "2026-06-01T01:00:00.000Z"
            },
            end: {
              dateTime: "2026-06-01T02:00:00.000Z"
            },
            extendedProperties: {
              private: {
                owner_type: "reservation",
                reservation_id: reservationId,
                store_id: "kyoto"
              }
            }
          }
        ],
        nextSyncToken: "sync_token_after_revert_echo_1"
      })
    ) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result.succeeded).toBe(1);
    const openConflicts = d1.sqlite
      .prepare("SELECT COUNT(*) AS count FROM google_calendar_conflicts WHERE reservation_id = ? AND resolution_status = 'open'")
      .get(reservationId) as { count: number };
    const revertJobs = d1.sqlite
      .prepare("SELECT COUNT(*) AS count FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'upsert'")
      .get(reservationId) as { count: number };
    expect(openConflicts.count).toBe(0);
    expect(revertJobs.count).toBe(0);
  });

  it("does not suppress a new invalid Google edit just because an old revert write is active", async () => {
    const reservationId = await createConfirmedReservationWithGoogleEvent();
    insertActiveChannel(null);
    insertImportJob("full_reconcile");
    d1.sqlite
      .prepare(
        `
          INSERT INTO google_calendar_conflicts (
            id,
            store_id,
            calendar_id,
            google_event_id,
            reservation_id,
            conflict_type,
            google_safe_snapshot_json,
            resolution_status,
            resolved_at,
            resolved_by
          ) VALUES (
            'google_conflict_auto_reverted_old_1',
            'kyoto',
            ?,
            'google_reservation_event_deleted_1',
            ?,
            'reservation_duration_changed',
            '{"kind":"previous_invalid_edit"}',
            'auto_reverted',
            '2026-05-09T00:00:00.000Z',
            'system'
          )
        `
      )
      .run(CALENDAR_ID, reservationId);
    d1.sqlite
      .prepare(
        `
          INSERT INTO google_calendar_outbound_writes (
            id,
            dedupe_key,
            calendar_id,
            google_event_id,
            owner_type,
            owner_id,
            action,
            expected_fingerprint,
            expires_at
          ) VALUES (
            'outbound_revert_active_old_1',
            'outbound_revert_active_old_1',
            ?,
            'google_reservation_event_deleted_1',
            'reservation',
            ?,
            'upsert',
            'fingerprint',
            '2027-01-16T08:00:00.000Z'
          )
        `
      )
      .run(CALENDAR_ID, reservationId);
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "google_reservation_event_deleted_1",
            status: "confirmed",
            start: {
              dateTime: "2026-06-01T03:00:00.000Z"
            },
            end: {
              dateTime: "2026-06-01T04:30:00.000Z"
            },
            extendedProperties: {
              private: {
                owner_type: "reservation",
                reservation_id: reservationId,
                store_id: "kyoto"
              }
            }
          }
        ],
        nextSyncToken: "sync_token_after_new_invalid_edit_1"
      })
    ) as unknown as typeof fetch;

    const result = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result.succeeded).toBe(1);
    const openConflict = d1.sqlite
      .prepare("SELECT conflict_type FROM google_calendar_conflicts WHERE reservation_id = ? AND resolution_status = 'open'")
      .get(reservationId) as { conflict_type: string };
    const revertJobs = d1.sqlite
      .prepare("SELECT COUNT(*) AS count FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'upsert'")
      .get(reservationId) as { count: number };
    expect(openConflict.conflict_type).toBe("reservation_duration_changed");
    expect(revertJobs.count).toBe(1);
  });

  it("queues canonical rewrite for unchanged reservation events when Google text may have been edited manually", async () => {
    const reservationId = await createConfirmedReservationWithGoogleEvent();
    insertActiveChannel(null);
    insertImportJob("full_reconcile");
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "google_reservation_event_deleted_1",
            etag: "google_reservation_etag_text_edit_1",
            status: "confirmed",
            summary: "予約 太郎 075-123-4567",
            description: "phone 075-123-4567",
            start: {
              dateTime: "2026-06-01T01:00:00.000Z"
            },
            end: {
              dateTime: "2026-06-01T02:00:00.000Z"
            },
            extendedProperties: {
              private: {
                owner_type: "reservation",
                reservation_id: reservationId,
                store_id: "kyoto"
              }
            }
          }
        ],
        nextSyncToken: "sync_token_after_text_edit_1"
      })
    ) as unknown as typeof fetch;

    await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    const rewriteJob = d1.sqlite
      .prepare("SELECT google_action, status FROM calendar_sync_jobs WHERE owner_id = ?")
      .get(reservationId) as { google_action: string; status: string };
    const googleEvent = d1.sqlite
      .prepare("SELECT google_safe_snapshot_json FROM google_calendar_events WHERE google_event_id = 'google_reservation_event_deleted_1'")
      .get() as { google_safe_snapshot_json: string };
    expect(rewriteJob).toEqual({
      google_action: "upsert",
      status: "queued"
    });
    expect(googleEvent.google_safe_snapshot_json).not.toContain("075");
    expect(googleEvent.google_safe_snapshot_json).not.toContain("予約 太郎");
    expect(JSON.parse(googleEvent.google_safe_snapshot_json)).not.toHaveProperty("summary");
  });
});

describe("drift alert (Step 6)", () => {
  let d1: SqliteD1Database;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    d1 = createMigratedSqliteD1();
    d1.sqlite.prepare("UPDATE stores SET google_calendar_id = NULL WHERE id <> 'kyoto'").run();
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    d1.sqlite.close();
  });

  const DRIFT_CALENDAR_ID = "calendar-a@example.invalid";

  const seedEvent = (params: {
    rowId: string;
    storeId?: string;
    calendarId?: string;
    googleEventId: string;
    lastSeenAt: string;
    status: "active" | "cancelled" | "deleted" | "conflict" | "ignored";
    sourceType?: "reservation" | "external_block" | "unknown";
  }) => {
    const storeId = params.storeId ?? "kyoto";
    const calendarId = params.calendarId ?? DRIFT_CALENDAR_ID;
    const sourceType = params.sourceType ?? "unknown";
    d1.sqlite
      .prepare(
        `
          INSERT INTO google_calendar_events (
            id,
            store_id,
            calendar_id,
            google_event_id,
            reservation_id,
            external_block_id,
            google_etag,
            google_updated_at,
            last_seen_at,
            last_imported_at,
            source_type,
            status,
            google_safe_snapshot_json
          ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, NULL)
        `
      )
      .run(
        params.rowId,
        storeId,
        calendarId,
        params.googleEventId,
        params.lastSeenAt,
        params.lastSeenAt,
        sourceType,
        params.status
      );
  };

  const driftLogLines = (): Record<string, unknown>[] =>
    (consoleSpy.mock.calls as unknown[][])
      .map((call): unknown => {
        try {
          return JSON.parse(call[0] as string);
        } catch {
          return null;
        }
      })
      .filter((parsed: unknown): parsed is Record<string, unknown> => {
        if (parsed === null || typeof parsed !== "object") return false;
        const eventType = (parsed as Record<string, unknown>).event_type;
        return eventType === "google_drift_alert" || eventType === "google_drift_check_failed";
      });

  const insertChannel = (syncToken: string | null) => {
    d1.sqlite
      .prepare(
        `
          INSERT INTO calendar_auth_connections (
            id, store_id, provider, calendar_id, service_account_email, status
          ) VALUES (
            'calendar_auth_drift_kyoto_1',
            'kyoto',
            'google',
            ?,
            'calendar-sync@example.iam.gserviceaccount.com',
            'active'
          )
        `
      )
      .run(DRIFT_CALENDAR_ID);
    d1.sqlite
      .prepare(
        `
          INSERT INTO google_calendar_channels (
            id, store_id, calendar_auth_connection_id, calendar_id, channel_id,
            resource_id, channel_token_hash, channel_token_hash_alg, sync_token, status
          ) VALUES (
            'google_calendar_channel_drift_1',
            'kyoto',
            'calendar_auth_drift_kyoto_1',
            ?,
            'google_channel_drift_1',
            'google_resource_drift_1',
            'token_hash',
            'sha256',
            ?,
            'active'
          )
        `
      )
      .run(DRIFT_CALENDAR_ID, syncToken);
  };

  const insertFullReconcileJob = () => {
    d1.sqlite
      .prepare(
        `
          INSERT INTO google_calendar_import_jobs (
            id, store_id, calendar_id, reason, status, next_run_at, dedupe_key
          ) VALUES (
            'google_import_job_drift_1',
            'kyoto',
            ?,
            'full_reconcile',
            'queued',
            '2026-05-09T00:00:00.000Z',
            ?
          )
        `
      )
      .run(DRIFT_CALENDAR_ID, `${DRIFT_CALENDAR_ID}:full_reconcile:test`);
  };

  const insertIncrementalJob = () => {
    d1.sqlite
      .prepare(
        `
          INSERT INTO google_calendar_import_jobs (
            id, store_id, calendar_id, reason, status, next_run_at, dedupe_key
          ) VALUES (
            'google_import_job_drift_incremental_1',
            'kyoto',
            ?,
            'cron_incremental',
            'queued',
            '2026-05-09T00:00:00.000Z',
            ?
          )
        `
      )
      .run(DRIFT_CALENDAR_ID, `${DRIFT_CALENDAR_ID}:cron_incremental:test`);
  };

  const noopFetch = () =>
    vi.fn(async () =>
      Response.json({
        items: [],
        nextSyncToken: "drift_sync_token_after"
      })
    ) as unknown as typeof fetch;

  it("counts only sweep-window rows for the targeted store+calendar (unit)", async () => {
    seedEvent({ rowId: "row_fresh_1", googleEventId: "g_fresh_1", lastSeenAt: "2026-05-18 06:10:00", status: "active" });
    seedEvent({ rowId: "row_fresh_2", googleEventId: "g_fresh_2", lastSeenAt: "2026-05-18 06:10:00", status: "active" });
    seedEvent({ rowId: "row_fresh_3", googleEventId: "g_fresh_3", lastSeenAt: "2026-05-18 06:10:00", status: "active" });
    seedEvent({ rowId: "row_fresh_4", googleEventId: "g_fresh_4", lastSeenAt: "2026-05-18 06:10:00", status: "active" });
    seedEvent({ rowId: "row_fresh_5", googleEventId: "g_fresh_5", lastSeenAt: "2026-05-18 06:10:00", status: "active" });
    seedEvent({ rowId: "row_stale_1", googleEventId: "g_stale_1", lastSeenAt: "2026-05-18 04:00:00", status: "active" });
    seedEvent({ rowId: "row_stale_2", googleEventId: "g_stale_2", lastSeenAt: "2026-05-18 04:00:00", status: "active" });
    seedEvent({ rowId: "row_stale_3", googleEventId: "g_stale_3", lastSeenAt: "2026-05-18 04:00:00", status: "active" });

    const sweepStartSeconds = Math.floor(Date.parse("2026-05-18T06:09:00Z") / 1000);
    const counts = await computeCalendarDrift({
      db: d1 as unknown as D1Database,
      storeId: "kyoto",
      calendarId: DRIFT_CALENDAR_ID,
      googleSweepCount: 5,
      sweepStartSeconds
    });

    expect(counts).toEqual({ googleSweepCount: 5, d1SweepCount: 5, drift: 0 });
  });

  it("reports a positive drift when Google count exceeds D1 sweep count (unit)", async () => {
    seedEvent({ rowId: "row_fresh_1", googleEventId: "g_fresh_1", lastSeenAt: "2026-05-18 06:10:00", status: "active" });
    seedEvent({ rowId: "row_fresh_2", googleEventId: "g_fresh_2", lastSeenAt: "2026-05-18 06:10:00", status: "active" });
    seedEvent({ rowId: "row_fresh_3", googleEventId: "g_fresh_3", lastSeenAt: "2026-05-18 06:10:00", status: "active" });
    seedEvent({ rowId: "row_fresh_4", googleEventId: "g_fresh_4", lastSeenAt: "2026-05-18 06:10:00", status: "active" });
    seedEvent({ rowId: "row_fresh_5", googleEventId: "g_fresh_5", lastSeenAt: "2026-05-18 06:10:00", status: "active" });

    const sweepStartSeconds = Math.floor(Date.parse("2026-05-18T06:09:00Z") / 1000);
    const counts = await computeCalendarDrift({
      db: d1 as unknown as D1Database,
      storeId: "kyoto",
      calendarId: DRIFT_CALENDAR_ID,
      googleSweepCount: 12,
      sweepStartSeconds
    });

    expect(counts).toEqual({ googleSweepCount: 12, d1SweepCount: 5, drift: 7 });
  });

  it("does not count rows from a different store on the same calendar id (unit)", async () => {
    d1.sqlite.prepare("UPDATE stores SET google_calendar_id = ? WHERE id = 'osaka'").run(DRIFT_CALENDAR_ID);
    for (let i = 0; i < 5; i += 1) {
      seedEvent({ rowId: `row_kyoto_${i}`, storeId: "kyoto", googleEventId: `g_kyoto_${i}`, lastSeenAt: "2026-05-18 06:10:00", status: "active" });
    }
    for (let i = 0; i < 5; i += 1) {
      seedEvent({ rowId: `row_osaka_${i}`, storeId: "osaka", googleEventId: `g_osaka_${i}`, lastSeenAt: "2026-05-18 06:10:00", status: "active" });
    }

    const sweepStartSeconds = Math.floor(Date.parse("2026-05-18T06:09:00Z") / 1000);
    const counts = await computeCalendarDrift({
      db: d1 as unknown as D1Database,
      storeId: "kyoto",
      calendarId: DRIFT_CALENDAR_ID,
      googleSweepCount: 5,
      sweepStartSeconds
    });

    expect(counts).toEqual({ googleSweepCount: 5, d1SweepCount: 5, drift: 0 });
  });

  it("includes all D1 statuses inside the sweep window (no status filter — unit)", async () => {
    seedEvent({ rowId: "row_active_1", googleEventId: "g_active_1", lastSeenAt: "2026-05-18 06:10:00", status: "active" });
    seedEvent({ rowId: "row_active_2", googleEventId: "g_active_2", lastSeenAt: "2026-05-18 06:10:00", status: "active" });
    seedEvent({ rowId: "row_active_3", googleEventId: "g_active_3", lastSeenAt: "2026-05-18 06:10:00", status: "active" });
    seedEvent({ rowId: "row_conflict_1", googleEventId: "g_conflict_1", lastSeenAt: "2026-05-18 06:10:00", status: "conflict" });
    seedEvent({ rowId: "row_conflict_2", googleEventId: "g_conflict_2", lastSeenAt: "2026-05-18 06:10:00", status: "conflict" });
    seedEvent({ rowId: "row_ignored_1", googleEventId: "g_ignored_1", lastSeenAt: "2026-05-18 06:10:00", status: "ignored" });
    seedEvent({ rowId: "row_ignored_2", googleEventId: "g_ignored_2", lastSeenAt: "2026-05-18 06:10:00", status: "ignored" });
    seedEvent({ rowId: "row_cancel_1", googleEventId: "g_cancel_1", lastSeenAt: "2026-05-18 06:10:00", status: "cancelled" });
    seedEvent({ rowId: "row_cancel_2", googleEventId: "g_cancel_2", lastSeenAt: "2026-05-18 06:10:00", status: "cancelled" });
    seedEvent({ rowId: "row_cancel_3", googleEventId: "g_cancel_3", lastSeenAt: "2026-05-18 06:10:00", status: "cancelled" });
    seedEvent({ rowId: "row_cancel_4", googleEventId: "g_cancel_4", lastSeenAt: "2026-05-18 06:10:00", status: "cancelled" });
    seedEvent({ rowId: "row_deleted_1", googleEventId: "g_deleted_1", lastSeenAt: "2026-05-18 06:10:00", status: "deleted" });

    const sweepStartSeconds = Math.floor(Date.parse("2026-05-18T06:09:00Z") / 1000);
    const counts = await computeCalendarDrift({
      db: d1 as unknown as D1Database,
      storeId: "kyoto",
      calendarId: DRIFT_CALENDAR_ID,
      googleSweepCount: 12,
      sweepStartSeconds
    });

    expect(counts).toEqual({ googleSweepCount: 12, d1SweepCount: 12, drift: 0 });
  });

  it("counts rows whose last_seen_at is several seconds after sweep_start (slack direction — unit)", async () => {
    const sweepStartSeconds = Math.floor(Date.parse("2026-05-18T06:09:00Z") / 1000);
    const sixSecondsAfter = new Date((sweepStartSeconds + 6) * 1000)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    seedEvent({ rowId: "row_after_1", googleEventId: "g_after_1", lastSeenAt: sixSecondsAfter, status: "active" });
    seedEvent({ rowId: "row_after_2", googleEventId: "g_after_2", lastSeenAt: sixSecondsAfter, status: "active" });
    seedEvent({ rowId: "row_after_3", googleEventId: "g_after_3", lastSeenAt: sixSecondsAfter, status: "active" });
    seedEvent({ rowId: "row_after_4", googleEventId: "g_after_4", lastSeenAt: sixSecondsAfter, status: "active" });
    seedEvent({ rowId: "row_after_5", googleEventId: "g_after_5", lastSeenAt: sixSecondsAfter, status: "active" });

    const counts = await computeCalendarDrift({
      db: d1 as unknown as D1Database,
      storeId: "kyoto",
      calendarId: DRIFT_CALENDAR_ID,
      googleSweepCount: 5,
      sweepStartSeconds
    });

    expect(counts).toEqual({ googleSweepCount: 5, d1SweepCount: 5, drift: 0 });
  });

  it("captureSweepStartSeconds returns the SQLite epoch within a wall-clock sandwich", async () => {
    const before = Math.floor(Date.now() / 1000);
    const result = await captureSweepStartSeconds(d1 as unknown as D1Database);
    const after = Math.floor(Date.now() / 1000);
    expect(result).toBeGreaterThanOrEqual(before - 1);
    expect(result).toBeLessThanOrEqual(after + 1);
  });

  it("emits google_drift_alert when injected drift hits the threshold", async () => {
    insertChannel("drift_sync_token_pre");
    insertFullReconcileJob();
    const computeDrift = vi.fn(async () => ({ googleSweepCount: 25, d1SweepCount: 15, drift: 10 }));
    const captureSweepStart = vi.fn(async () => 1_800_000_000);

    await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: noopFetch(),
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000,
      computeDrift,
      captureSweepStart
    });

    const lines = driftLogLines();
    expect(lines).toHaveLength(1);
    const alert = lines[0];
    expect(alert.event_type).toBe("google_drift_alert");
    expect(alert.outcome).toBe("noop");
    expect(alert.calendar_id).toBe(DRIFT_CALENDAR_ID);
    expect(alert.store_id).toBe("kyoto");
    expect(alert.google_tracked_count).toBe(25);
    expect(alert.d1_tracked_count).toBe(15);
    expect(alert.drift).toBe(10);
    expect(typeof alert.ts).toBe("string");
    for (const forbidden of ["event_id", "summary", "attendees", "payload", "snapshot", "ran_at", "reservation_id", "customer_id"]) {
      expect(alert).not.toHaveProperty(forbidden);
    }
  });

  it("does not emit google_drift_alert below the threshold", async () => {
    insertChannel("drift_sync_token_pre");
    insertFullReconcileJob();
    const computeDrift = vi.fn(async () => ({ googleSweepCount: 24, d1SweepCount: 15, drift: 9 }));

    await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: noopFetch(),
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000,
      computeDrift,
      captureSweepStart: async () => 1_800_000_000
    });

    expect(driftLogLines()).toHaveLength(0);
  });

  it("enqueues one owner email job when flag=true and drift hits threshold", async () => {
    insertChannel("drift_sync_token_pre");
    insertFullReconcileJob();
    const computeDrift = vi.fn(async () => ({ googleSweepCount: 25, d1SweepCount: 15, drift: 10 }));
    const captureSweepStart = vi.fn(async () => 1_800_000_000);
    const recipient1 = "U" + "1".repeat(32);
    const recipient2 = "U" + "2".repeat(32);
    const ownerEmailRecipientId = "email:owner";

    await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: `${recipient1},${recipient2}`,
        GOOGLE_DRIFT_ALERT_LIVE: "true"
      },
      fetcher: noopFetch(),
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000,
      computeDrift,
      captureSweepStart
    });

    const jobs = d1.sqlite
      .prepare(
        `SELECT id, dedupe_key, recipient_id, payload_json, status, recipient_type, template_key
         FROM notification_jobs
         WHERE template_key = 'google_drift_alert'
         ORDER BY recipient_id`
      )
      .all() as Array<{
      id: string;
      dedupe_key: string;
      recipient_id: string;
      payload_json: string;
      status: string;
      recipient_type: string;
      template_key: string;
    }>;

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.recipient_id).toBe(ownerEmailRecipientId);

    // Pre-compute the expected calendar hash so the assertion below catches a
    // regression where the dedupe_key falls back to the raw calendar id or
    // uses a different hash window. SHA-256 truncated to 16 bytes (32 hex
    // chars), matching enqueueGoogleDriftAlertJobs in src/google/import-sync.ts.
    const calBytes = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(DRIFT_CALENDAR_ID))
    );
    const expectedCalHash = Array.from(calBytes.slice(0, 16))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    for (const job of jobs) {
      expect(job.template_key).toBe("google_drift_alert");
      expect(job.recipient_type).toBe("owner");
      expect(job.status).toBe("queued");
      // dedupe_key shape: v1:<utcDate>:store:<storeId>:cal:<sha256-16B>:recipient:<sha256-16B>
      // (the recipient hash keeps the sentinel out of the dedupe key.)
      expect(job.dedupe_key).toMatch(
        /^google_drift_alert:v1:\d{4}-\d{2}-\d{2}:store:kyoto:cal:[0-9a-f]{32}:recipient:[0-9a-f]{32}$/
      );
      expect(job.dedupe_key).toContain(`:cal:${expectedCalHash}:`);
      expect(job.dedupe_key).not.toContain(DRIFT_CALENDAR_ID);
      expect(job.dedupe_key).not.toContain(recipient1);
      expect(job.dedupe_key).not.toContain(recipient2);
      expect(job.dedupe_key).not.toContain(ownerEmailRecipientId);

      const payload = JSON.parse(job.payload_json) as Record<string, unknown>;
      // payload_json must contain ONLY store_id + numeric drift facts. No
      // event summary, customer data, or reservation references.
      expect(Object.keys(payload).sort()).toEqual([
        "d1_count",
        "drift",
        "google_count",
        "store_id",
        "threshold"
      ]);
      expect(payload.store_id).toBe("kyoto");
      expect(payload.google_count).toBe(25);
      expect(payload.d1_count).toBe(15);
      expect(payload.drift).toBe(10);
      expect(payload.threshold).toBe(10);
      const payloadText = JSON.stringify(payload);
      for (const forbidden of [
        "event_id",
        "summary",
        "attendees",
        "customer",
        "reservation",
        "phone",
        "email"
      ]) {
        expect(payloadText.toLowerCase()).not.toContain(forbidden);
      }
    }

    expect(jobs[0]?.dedupe_key).toContain(":recipient:");
  });

  it("does NOT enqueue notification_jobs when GOOGLE_DRIFT_ALERT_LIVE=false (flag-gated)", async () => {
    insertChannel("drift_sync_token_pre");
    insertFullReconcileJob();
    const computeDrift = vi.fn(async () => ({ googleSweepCount: 25, d1SweepCount: 15, drift: 10 }));

    await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "U" + "9".repeat(32),
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: noopFetch(),
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000,
      computeDrift,
      captureSweepStart: async () => 1_800_000_000
    });

    // Drift alert log still fires (covered by existing test) but no
    // notification_jobs row is enqueued.
    const count = d1.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM notification_jobs WHERE template_key = 'google_drift_alert'`)
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("INSERT OR IGNORE deduplicates same-day re-runs (idempotent enqueue)", async () => {
    const recipient = "U" + "3".repeat(32);
    const env = {
      GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
      GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
      LINE_OPERATIONS_USER_IDS: recipient,
      GOOGLE_DRIFT_ALERT_LIVE: "true"
    };
    const computeDrift = vi.fn(async () => ({ googleSweepCount: 25, d1SweepCount: 15, drift: 10 }));
    const sharedArgs = {
      db: d1 as unknown as D1Database,
      env,
      fetcher: noopFetch(),
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000,
      computeDrift,
      captureSweepStart: async () => 1_800_000_000
    };

    insertChannel("drift_sync_token_pre");
    insertFullReconcileJob();
    await processDueGoogleCalendarImportJobs(sharedArgs);

    // Reset the import job so we can run a second full_reconcile pass with
    // the same fixed `now`. The dedupe_key utcDate is derived from `now`, so
    // identical inputs must collapse via INSERT OR IGNORE on notification_jobs.
    // The channel + calendar_auth_connections rows are reused as-is.
    d1.sqlite.prepare(`DELETE FROM google_calendar_import_jobs`).run();
    insertFullReconcileJob();
    await processDueGoogleCalendarImportJobs(sharedArgs);

    const count = d1.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM notification_jobs WHERE template_key = 'google_drift_alert'`)
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("skips capture and compute entirely for non-full_reconcile jobs", async () => {
    insertChannel("drift_sync_token_pre");
    insertIncrementalJob();
    const computeDrift = vi.fn(async () => {
      throw new Error("compute should not be invoked");
    });
    const captureSweepStart = vi.fn(async () => {
      throw new Error("capture should not be invoked");
    });

    await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: noopFetch(),
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000,
      computeDrift,
      captureSweepStart
    });

    expect(computeDrift).not.toHaveBeenCalled();
    expect(captureSweepStart).not.toHaveBeenCalled();
    expect(driftLogLines()).toHaveLength(0);
  });

  it("emits google_drift_check_failed when computeDrift throws and still completes the import", async () => {
    insertChannel("drift_sync_token_pre");
    insertFullReconcileJob();
    const computeDrift = vi.fn(async () => {
      throw new Error("compute boom");
    });

    await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: noopFetch(),
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000,
      computeDrift,
      captureSweepStart: async () => 1_800_000_000
    });

    const lines = driftLogLines();
    expect(lines).toHaveLength(1);
    const failure = lines[0];
    expect(failure.event_type).toBe("google_drift_check_failed");
    expect(failure.outcome).toBe("failure");
    expect(failure.calendar_id).toBe(DRIFT_CALENDAR_ID);
    expect(failure.store_id).toBe("kyoto");
    expect(failure.error_class).toBe("unexpected");
    expect(failure).not.toHaveProperty("drift");
    expect(failure).not.toHaveProperty("google_tracked_count");
    expect(failure).not.toHaveProperty("d1_tracked_count");

    const jobAfter = d1.sqlite
      .prepare("SELECT status FROM google_calendar_import_jobs WHERE id = 'google_import_job_drift_1'")
      .get() as { status: string };
    expect(jobAfter.status).toBe("succeeded");
  });

  it("emits google_drift_check_failed when captureSweepStart throws and still completes the import", async () => {
    insertChannel("drift_sync_token_pre");
    insertFullReconcileJob();
    const computeDrift = vi.fn(async () => ({ googleSweepCount: 25, d1SweepCount: 15, drift: 10 }));
    const captureSweepStart = vi.fn(async () => {
      throw new Error("capture boom");
    });

    await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: noopFetch(),
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000,
      computeDrift,
      captureSweepStart
    });

    expect(computeDrift).not.toHaveBeenCalled();
    const lines = driftLogLines();
    expect(lines).toHaveLength(1);
    const failure = lines[0];
    expect(failure.event_type).toBe("google_drift_check_failed");
    expect(failure.outcome).toBe("failure");
    expect(failure.error_class).toBe("unexpected");

    const jobAfter = d1.sqlite
      .prepare("SELECT status FROM google_calendar_import_jobs WHERE id = 'google_import_job_drift_1'")
      .get() as { status: string };
    expect(jobAfter.status).toBe("succeeded");
  });

  it("emits no drift logs when the import itself fails after a capture failure", async () => {
    insertChannel("drift_sync_token_pre");
    insertFullReconcileJob();
    const captureSweepStart = vi.fn(async () => {
      throw new Error("capture boom");
    });
    const failingFetch = vi.fn(async () =>
      new Response("server error", { status: 500 })
    ) as unknown as typeof fetch;

    await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: failingFetch,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000,
      captureSweepStart
    });

    expect(driftLogLines()).toHaveLength(0);
    const jobAfter = d1.sqlite
      .prepare("SELECT status FROM google_calendar_import_jobs WHERE id = 'google_import_job_drift_1'")
      .get() as { status: string };
    expect(jobAfter.status).not.toBe("succeeded");
  });

  it("end-to-end happy path emits no drift log (real computeCalendarDrift, drift = 0)", async () => {
    insertChannel("drift_sync_token_pre");
    insertFullReconcileJob();
    const happyFetch = vi.fn(async () =>
      Response.json({
        items: [
          { id: "happy_event_1", status: "confirmed", start: { dateTime: "2026-06-01T01:00:00.000Z" }, end: { dateTime: "2026-06-01T02:00:00.000Z" } },
          { id: "happy_event_2", status: "confirmed", start: { dateTime: "2026-06-01T03:00:00.000Z" }, end: { dateTime: "2026-06-01T04:00:00.000Z" } },
          { id: "happy_event_3", status: "confirmed", start: { dateTime: "2026-06-01T05:00:00.000Z" }, end: { dateTime: "2026-06-01T06:00:00.000Z" } }
        ],
        nextSyncToken: "drift_sync_token_after"
      })
    ) as unknown as typeof fetch;

    await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: happyFetch,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(driftLogLines()).toHaveLength(0);
  });

  // Step 7 — orphan sweep (docs/plans/orphan-detection.md Option B).
  // Rows whose last_seen_at is older than (sweepStart - ORPHAN_GRACE_SECONDS)
  // transition to status='deleted' after the full_reconcile page walk
  // completes. Grace = 60 minutes so in-flight push imports don't race.
  it("orphan sweep: transitions stale active rows to status='deleted' on full_reconcile", async () => {
    insertChannel("drift_sync_token_pre");
    insertFullReconcileJob();

    // Stale row: last_seen 2 hours before sweepStart → must be swept.
    const sweepStartSeconds = 1_800_000_000;
    const staleSeenAt = new Date((sweepStartSeconds - 2 * 60 * 60) * 1000).toISOString();
    const recentSeenAt = new Date((sweepStartSeconds - 5 * 60) * 1000).toISOString(); // 5 min ago

    seedEvent({
      rowId: "ev_stale",
      googleEventId: "g_stale",
      lastSeenAt: staleSeenAt,
      status: "active"
    });
    seedEvent({
      rowId: "ev_recent",
      googleEventId: "g_recent",
      lastSeenAt: recentSeenAt,
      status: "active"
    });

    const computeDrift = vi.fn(async () => ({ googleSweepCount: 5, d1SweepCount: 2, drift: 3 }));
    const captureSweepStart = vi.fn(async () => sweepStartSeconds);

    await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: noopFetch(),
      accessTokenProvider: async () => "google_access_token",
      now: () => sweepStartSeconds * 1000,
      computeDrift,
      captureSweepStart
    });

    const stale = d1.sqlite
      .prepare(`SELECT status FROM google_calendar_events WHERE id = 'ev_stale'`)
      .get() as { status: string };
    const recent = d1.sqlite
      .prepare(`SELECT status FROM google_calendar_events WHERE id = 'ev_recent'`)
      .get() as { status: string };

    expect(stale.status).toBe("deleted");
    expect(recent.status).toBe("active");
  });

  it("orphan sweep: skips rows already in status='deleted' (no churn)", async () => {
    insertChannel("drift_sync_token_pre");
    insertFullReconcileJob();

    const sweepStartSeconds = 1_800_000_000;
    const ancientSeenAt = new Date((sweepStartSeconds - 7 * 24 * 60 * 60) * 1000).toISOString();

    seedEvent({
      rowId: "ev_already_deleted",
      googleEventId: "g_old_deleted",
      lastSeenAt: ancientSeenAt,
      status: "deleted"
    });

    await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: noopFetch(),
      accessTokenProvider: async () => "google_access_token",
      now: () => sweepStartSeconds * 1000,
      computeDrift: vi.fn(async () => ({ googleSweepCount: 0, d1SweepCount: 0, drift: 0 })),
      captureSweepStart: vi.fn(async () => sweepStartSeconds)
    });

    const row = d1.sqlite
      .prepare(`SELECT status, last_seen_at FROM google_calendar_events WHERE id = 'ev_already_deleted'`)
      .get() as { status: string; last_seen_at: string };

    expect(row.status).toBe("deleted");
    // last_seen_at must not be re-touched (UPDATE filter excludes status='deleted')
    expect(row.last_seen_at).toBe(ancientSeenAt);
  });

  it("orphan sweep: emits google_orphan_swept log event with swept_count", async () => {
    insertChannel("drift_sync_token_pre");
    insertFullReconcileJob();

    const sweepStartSeconds = 1_800_000_000;
    const staleSeenAt = new Date((sweepStartSeconds - 2 * 60 * 60) * 1000).toISOString();

    seedEvent({
      rowId: "ev_stale_1",
      googleEventId: "g_stale_1",
      lastSeenAt: staleSeenAt,
      status: "active"
    });
    seedEvent({
      rowId: "ev_stale_2",
      googleEventId: "g_stale_2",
      lastSeenAt: staleSeenAt,
      status: "active"
    });

    await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: noopFetch(),
      accessTokenProvider: async () => "google_access_token",
      now: () => sweepStartSeconds * 1000,
      computeDrift: vi.fn(async () => ({ googleSweepCount: 0, d1SweepCount: 0, drift: 0 })),
      captureSweepStart: vi.fn(async () => sweepStartSeconds)
    });

    const orphanLogs = (consoleSpy.mock.calls as unknown[][])
      .map((call): unknown => {
        try {
          return JSON.parse(call[0] as string);
        } catch {
          return null;
        }
      })
      .filter((parsed: unknown): parsed is Record<string, unknown> => {
        if (parsed === null || typeof parsed !== "object") return false;
        return (parsed as Record<string, unknown>).event_type === "google_orphan_swept";
      });

    expect(orphanLogs).toHaveLength(1);
    expect(orphanLogs[0].swept_count).toBe(2);
    expect(orphanLogs[0].grace_seconds).toBe(60 * 60);
    expect(orphanLogs[0].calendar_id).toBe(DRIFT_CALENDAR_ID);
    expect(orphanLogs[0].store_id).toBe("kyoto");
  });

  it("orphan sweep: cutoff boundary — row at exactly sweepStart - ORPHAN_GRACE_SECONDS stays active", async () => {
    insertChannel("drift_sync_token_pre");
    insertFullReconcileJob();

    const sweepStartSeconds = 1_800_000_000;
    // Row at exactly sweepStart - 3600s: the SQL filter is strict <, so the
    // row must NOT be swept (last_seen_at must be STRICTLY older than the
    // cutoff). A one-second-older row gets swept; the boundary row stays.
    const exactBoundaryIso = new Date((sweepStartSeconds - 60 * 60) * 1000).toISOString();
    const oneSecondOlderIso = new Date((sweepStartSeconds - 60 * 60 - 1) * 1000).toISOString();

    seedEvent({
      rowId: "ev_at_boundary",
      googleEventId: "g_at_boundary",
      lastSeenAt: exactBoundaryIso,
      status: "active"
    });
    seedEvent({
      rowId: "ev_one_sec_older",
      googleEventId: "g_one_sec_older",
      lastSeenAt: oneSecondOlderIso,
      status: "active"
    });

    await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: noopFetch(),
      accessTokenProvider: async () => "google_access_token",
      now: () => sweepStartSeconds * 1000,
      computeDrift: vi.fn(async () => ({ googleSweepCount: 0, d1SweepCount: 0, drift: 0 })),
      captureSweepStart: vi.fn(async () => sweepStartSeconds)
    });

    const atBoundary = d1.sqlite
      .prepare(`SELECT status FROM google_calendar_events WHERE id = 'ev_at_boundary'`)
      .get() as { status: string };
    const oneSecOlder = d1.sqlite
      .prepare(`SELECT status FROM google_calendar_events WHERE id = 'ev_one_sec_older'`)
      .get() as { status: string };

    expect(atBoundary.status).toBe("active");
    expect(oneSecOlder.status).toBe("deleted");
  });

  it("orphan sweep: handles mixed last_seen_at formats (ISO + SQLite CURRENT_TIMESTAMP) on the same calendar", async () => {
    insertChannel("drift_sync_token_pre");
    insertFullReconcileJob();

    const sweepStartSeconds = 1_800_000_000;
    // 2h-old ISO format (toISOString from JS writers / tests).
    const staleIso = new Date((sweepStartSeconds - 2 * 60 * 60) * 1000).toISOString();
    // 2h-old SQLite CURRENT_TIMESTAMP format (space separator, no Z, no ms).
    // This is what production upsertGoogleEvent writes via CURRENT_TIMESTAMP.
    // 1_800_000_000 = 2027-01-15T08:00:00 UTC; sweepStart - 2h = 06:00:00.
    const staleSqlite = "2027-01-15 06:00:00";

    seedEvent({
      rowId: "ev_stale_iso",
      googleEventId: "g_stale_iso",
      lastSeenAt: staleIso,
      status: "active"
    });
    seedEvent({
      rowId: "ev_stale_sqlite",
      googleEventId: "g_stale_sqlite",
      lastSeenAt: staleSqlite,
      status: "active"
    });

    await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: noopFetch(),
      accessTokenProvider: async () => "google_access_token",
      now: () => sweepStartSeconds * 1000,
      computeDrift: vi.fn(async () => ({ googleSweepCount: 0, d1SweepCount: 0, drift: 0 })),
      captureSweepStart: vi.fn(async () => sweepStartSeconds)
    });

    // Both must be swept regardless of format — that's the whole point of
    // datetime() normalization on the WHERE clause.
    const iso = d1.sqlite
      .prepare(`SELECT status FROM google_calendar_events WHERE id = 'ev_stale_iso'`)
      .get() as { status: string };
    const sqlite = d1.sqlite
      .prepare(`SELECT status FROM google_calendar_events WHERE id = 'ev_stale_sqlite'`)
      .get() as { status: string };

    expect(iso.status).toBe("deleted");
    expect(sqlite.status).toBe("deleted");
  });

  it("orphan sweep: skipped when capture failure prevents drift check", async () => {
    insertChannel("drift_sync_token_pre");
    insertFullReconcileJob();

    const staleSeenAt = new Date(0).toISOString(); // very old, would otherwise be swept

    seedEvent({
      rowId: "ev_stale_no_sweep",
      googleEventId: "g_stale_no_sweep",
      lastSeenAt: staleSeenAt,
      status: "active"
    });

    // captureSweepStart throws → driftCaptureFailed=true → orphan sweep skipped.
    await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
        LINE_OPERATIONS_USER_IDS: "",
        GOOGLE_DRIFT_ALERT_LIVE: "false"
      },
      fetcher: noopFetch(),
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000,
      computeDrift: vi.fn(async () => ({ googleSweepCount: 0, d1SweepCount: 0, drift: 0 })),
      captureSweepStart: vi.fn(async () => {
        throw new Error("capture boom");
      })
    });

    const row = d1.sqlite
      .prepare(`SELECT status FROM google_calendar_events WHERE id = 'ev_stale_no_sweep'`)
      .get() as { status: string };
    // Without trustworthy sweep timestamp the orphan sweep cannot run, so
    // the stale row stays active. Operator can re-trigger on the next cron.
    expect(row.status).toBe("active");
  });
});
