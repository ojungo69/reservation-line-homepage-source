import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processDueGoogleCalendarImportJobs } from "../src/google/import-sync";
import * as sentryHelpers from "../src/sentry-helpers";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const CALENDAR_ID = "calendar-a@example.invalid";
const NOW_MS = Date.parse("2026-06-01T00:00:00.000Z");
const ENV = {
  GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused",
  LINE_OPERATIONS_USER_IDS: "",
  GOOGLE_DRIFT_ALERT_LIVE: "false"
};

describe("Google import calendar serialization", () => {
  let d1: SqliteD1Database;

  beforeEach(() => {
    vi.spyOn(sentryHelpers, "safeCaptureException");
    d1 = createMigratedSqliteD1();
    d1.sqlite.prepare("UPDATE stores SET google_calendar_id = NULL WHERE id <> 'kyoto'").run();
    d1.sqlite.prepare("UPDATE stores SET google_calendar_id = ? WHERE id = 'kyoto'").run(CALENDAR_ID);
    d1.sqlite.prepare(`
      INSERT INTO calendar_auth_connections (
        id, store_id, provider, calendar_id, service_account_email, status
      ) VALUES ('auth', 'kyoto', 'google', ?, 'calendar-sync@example.iam.gserviceaccount.com', 'active')
    `).run(CALENDAR_ID);
    d1.sqlite.prepare(`
      INSERT INTO google_calendar_channels (
        id, store_id, calendar_auth_connection_id, calendar_id, channel_id,
        resource_id, channel_token_hash, sync_token, sync_query_version, status
      ) VALUES ('channel', 'kyoto', 'auth', ?, 'channel-test', 'resource-test', 'unused', 'sync-0', 1, 'active')
    `).run(CALENDAR_ID);
  });

  afterEach(() => {
    d1.sqlite.close();
    vi.restoreAllMocks();
  });

  const snapshotImportedState = () => Object.fromEntries([
    "external_blocks", "slot_locks", "customer_time_locks", "reservations",
    "google_calendar_channels", "google_calendar_import_jobs", "google_calendar_events",
    "google_calendar_event_history", "google_calendar_conflicts", "calendar_sync_jobs",
    "notification_jobs", "audit_logs"
  ].map((table) => [table, d1.sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));

  const enqueue = (id: string) => {
    d1.sqlite.prepare(`
      INSERT INTO google_calendar_import_jobs (
        id, store_id, calendar_id, reason, status, next_run_at, dedupe_key
      ) VALUES (?, 'kyoto', ?, 'push', 'queued', '2026-05-01T00:00:00.000Z', ?)
    `).run(id, CALENDAR_ID, id);
  };

  const run = (fetcher: typeof fetch, nowMs = NOW_MS, db = d1 as unknown as D1Database) => processDueGoogleCalendarImportJobs({
    db,
    env: ENV,
    now: () => nowMs,
    maxJobs: 1,
    accessTokenProvider: async () => "test-access-token",
    fetcher
  });

  const eventPage = (version: number, hour: number, transparency = "opaque") => Response.json({
    kind: "calendar#events",
    items: [{
      id: "serialization-event",
      etag: `etag-${version}`,
      updated: `2026-05-31T00:0${version}:00.000Z`,
      status: "confirmed",
      transparency,
      start: { dateTime: `2026-06-02T0${hour}:00:00.000Z` },
      end: { dateTime: `2026-06-02T0${hour + 1}:00:00.000Z` }
    }],
    nextSyncToken: `sync-${version}`
  });

  it("keeps a later job queued until the same calendar's earlier import finishes", async () => {
    enqueue("job-a");
    enqueue("job-b");
    let release: (response: Response) => void = () => {};
    let entered: () => void = () => {};
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const delayedResponse = new Promise<Response>((resolve) => { release = resolve; });
    const earlier = run(async () => {
      entered();
      return delayedResponse;
    });
    await enteredPromise;
    const laterFetch = vi.fn(async () => eventPage(2, 3));
    const whileEarlierRunning = await run(laterFetch);
    const pendingBeforeRelease = d1.sqlite.prepare(
      "SELECT status, attempt_count FROM google_calendar_import_jobs WHERE id = 'job-b'"
    ).get();
    release(eventPage(1, 1));
    const earlierResult = await earlier;

    expect(whileEarlierRunning.processed).toBe(0);
    expect(laterFetch).not.toHaveBeenCalled();
    expect(pendingBeforeRelease).toEqual({ status: "queued", attempt_count: 0 });
    expect(earlierResult.succeeded).toBe(1);

    expect((await run(laterFetch)).succeeded).toBe(1);
    expect(d1.sqlite.prepare(
      "SELECT start_at, google_event_etag FROM external_blocks WHERE google_event_id = 'serialization-event'"
    ).get()).toEqual({ start_at: "2026-06-02T03:00:00.000Z", google_event_etag: "etag-2" });
    expect(d1.sqlite.prepare("SELECT sync_token FROM google_calendar_channels WHERE id = 'channel'").get())
      .toEqual({ sync_token: "sync-2" });
    expect(d1.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM slot_locks
      WHERE slot_at >= '2026-06-02T03:00:00.000Z' AND slot_at < '2026-06-02T04:00:00.000Z'
    `).get()).toEqual({ count: 12 });
  });

  it("keeps incremental jobs queued while a checkpointed full walk waits for its retry", async () => {
    enqueue("paused-full");
    d1.sqlite.prepare(`
      UPDATE google_calendar_import_jobs
      SET reason = 'full_reconcile', status = 'retryable', next_run_at = ?,
          resume_page_token = 'second-page', resume_processed_count = 1,
          resume_sweep_start_seconds = ?, resume_time_min = '2026-05-01T00:00:00.000Z'
      WHERE id = 'paused-full'
    `).run(new Date(NOW_MS + 60_000).toISOString(), Math.floor(NOW_MS / 1000));
    enqueue("later-push");
    const fetcher = vi.fn(async (_url: RequestInfo | URL) => Response.json({ items: [], nextSyncToken: "sync-full" }));
    const whilePaused = await run(fetcher);

    expect(whilePaused.processed).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
    expect(d1.sqlite.prepare(
      "SELECT status, attempt_count FROM google_calendar_import_jobs WHERE id = 'later-push'"
    ).get()).toEqual({ status: "queued", attempt_count: 0 });

    expect((await run(fetcher, NOW_MS + 60_000)).succeeded).toBe(1);
    const resumedUrl = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(resumedUrl.searchParams.get("pageToken")).toBe("second-page");
    expect(d1.sqlite.prepare(
      "SELECT status FROM google_calendar_import_jobs WHERE id = 'later-push'"
    ).get()).toEqual({ status: "queued" });

    const nextFetch = vi.fn(async (url: RequestInfo | URL) => {
      expect(new URL(String(url)).searchParams.get("syncToken")).toBe("sync-full");
      return Response.json({ items: [], nextSyncToken: "sync-after-push" });
    });
    expect((await run(nextFetch, NOW_MS + 60_000)).succeeded).toBe(1);
  });

  it("rejects a claim when another job acquires the calendar after candidate selection", async () => {
    enqueue("candidate-a");
    enqueue("competitor-b");
    enqueue("expired-other");
    d1.sqlite.prepare(`
      UPDATE google_calendar_import_jobs SET status = 'processing', attempt_count = 1,
        locked_until = '2026-05-31T23:59:59.000Z', next_run_at = '2026-07-01T00:00:00.000Z'
      WHERE id = 'expired-other'
    `).run();
    let claimPrepared = false;
    const racingDb = {
      prepare(sql: string) {
        if (sql.includes("SET status = 'processing'")) claimPrepared = true;
        return d1.prepare(sql);
      },
      batch(statements: D1PreparedStatement[]) {
        if (claimPrepared) {
          claimPrepared = false;
          d1.sqlite.prepare(`
            UPDATE google_calendar_import_jobs
            SET status = 'processing', attempt_count = 1, locked_until = ?
            WHERE id = 'competitor-b'
          `).run(new Date(NOW_MS + 300_000).toISOString());
        }
        return d1.batch(statements);
      }
    } as unknown as D1Database;
    const fetcher = vi.fn(async () => eventPage(1, 1));

    expect((await run(fetcher, NOW_MS, racingDb)).processed).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
    expect(d1.sqlite.prepare(
      "SELECT status, attempt_count FROM google_calendar_import_jobs WHERE id = 'candidate-a'"
    ).get()).toEqual({ status: "queued", attempt_count: 0 });
    expect(d1.sqlite.prepare("SELECT status, locked_until FROM google_calendar_import_jobs WHERE id = 'expired-other'").get())
      .toEqual({ status: "processing", locked_until: "2026-05-31T23:59:59.000Z" });
  });

  it("processes a different calendar while the first calendar is owned by another job", async () => {
    enqueue("active-first-calendar");
    enqueue("waiting-first-calendar");
    d1.sqlite.prepare(`
      UPDATE google_calendar_import_jobs SET status = 'processing', attempt_count = 1, locked_until = ?
      WHERE id = 'active-first-calendar'
    `).run(new Date(NOW_MS + 300_000).toISOString());
    d1.sqlite.prepare("UPDATE stores SET google_calendar_id = 'calendar-b@example.invalid' WHERE id = 'osaka'").run();
    d1.sqlite.prepare(`
      INSERT INTO calendar_auth_connections (
        id, store_id, provider, calendar_id, service_account_email, status
      ) VALUES ('auth-b', 'osaka', 'google', 'calendar-b@example.invalid', 'calendar-sync@example.iam.gserviceaccount.com', 'active')
    `).run();
    d1.sqlite.prepare(`
      INSERT INTO google_calendar_channels (
        id, store_id, calendar_auth_connection_id, calendar_id, channel_id,
        resource_id, channel_token_hash, sync_token, sync_query_version, status
      ) VALUES ('channel-b', 'osaka', 'auth-b', 'calendar-b@example.invalid', 'channel-test-b', 'resource-test-b', 'unused', 'sync-b', 1, 'active')
    `).run();
    d1.sqlite.prepare(`
      INSERT INTO google_calendar_import_jobs (id, store_id, calendar_id, reason, status, next_run_at, dedupe_key)
      VALUES ('other-calendar', 'osaka', 'calendar-b@example.invalid', 'push', 'queued', '2026-05-01T00:00:00.000Z', 'other-calendar')
    `).run();
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      expect(new URL(String(url)).pathname).toContain("calendar-b%40example.invalid");
      return Response.json({ items: [], nextSyncToken: "sync-next-b" });
    });

    expect((await run(fetcher)).succeeded).toBe(1);
    expect(d1.sqlite.prepare(
      "SELECT status, attempt_count FROM google_calendar_import_jobs WHERE id = 'waiting-first-calendar'"
    ).get()).toEqual({ status: "queued", attempt_count: 0 });
    expect(d1.sqlite.prepare("SELECT sync_token FROM google_calendar_channels WHERE id = 'channel-b'").get())
      .toEqual({ sync_token: "sync-next-b" });
  });

  it("resumes the earliest of pre-existing checkpointed walks without deadlocking both", async () => {
    for (const id of ["paused-a", "paused-b"]) {
      enqueue(id);
      d1.sqlite.prepare(`
        UPDATE google_calendar_import_jobs
        SET reason = 'full_reconcile', status = 'retryable', resume_page_token = ?,
            resume_time_min = '2026-05-01T00:00:00.000Z', resume_sweep_start_seconds = ?,
            created_at = '2026-05-31T00:00:00.000Z'
        WHERE id = ?
      `).run(id, Math.floor(NOW_MS / 1000), id);
    }
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      expect(new URL(String(url)).searchParams.get("pageToken")).toBe("paused-a");
      return Response.json({ items: [], nextSyncToken: "sync-full-a" });
    });

    expect((await run(fetcher)).succeeded).toBe(1);
    expect(d1.sqlite.prepare("SELECT status FROM google_calendar_import_jobs WHERE id = 'paused-a'").get())
      .toEqual({ status: "succeeded" });
    expect(d1.sqlite.prepare("SELECT status, attempt_count FROM google_calendar_import_jobs WHERE id = 'paused-b'").get())
      .toEqual({ status: "retryable", attempt_count: 0 });
  });

  it("releases an imported Google block when its event becomes transparent", async () => {
    enqueue("opaque-event");
    expect((await run(async () => eventPage(1, 1))).succeeded).toBe(1);
    enqueue("transparent-event");
    expect((await run(async () => eventPage(2, 1, "transparent"))).succeeded).toBe(1);

    expect(d1.sqlite.prepare(
      "SELECT status FROM external_blocks WHERE google_event_id = 'serialization-event'"
    ).get()).toEqual({ status: "cancelled" });
    expect(d1.sqlite.prepare("SELECT COUNT(*) AS count FROM slot_locks WHERE owner_type = 'external_block'").get())
      .toEqual({ count: 0 });
    expect(d1.sqlite.prepare(
      "SELECT status FROM google_calendar_events WHERE google_event_id = 'serialization-event'"
    ).get()).toEqual({ status: "ignored" });
  });

  it.each(["admin_block", "system_revert"])("restores a %s block made transparent without releasing its locks", async (source) => {
    enqueue("original-block");
    expect((await run(async () => eventPage(1, 1))).succeeded).toBe(1);
    d1.sqlite.prepare("UPDATE external_blocks SET source = ? WHERE google_event_id = 'serialization-event'").run(source);
    enqueue("transparent-block");
    expect((await run(async () => eventPage(2, 1, "transparent"))).succeeded).toBe(1);

    expect(d1.sqlite.prepare("SELECT COUNT(*) AS count FROM calendar_sync_jobs WHERE owner_type = 'external_block' AND status = 'queued'").get())
      .toEqual({ count: 1 });
    expect(d1.sqlite.prepare("SELECT conflict_type FROM google_calendar_conflicts WHERE resolution_status = 'open'").get())
      .toEqual({ conflict_type: "external_block_non_google_edit" });
    expect(d1.sqlite.prepare("SELECT COUNT(*) AS count FROM slot_locks WHERE owner_type = 'external_block'").get())
      .toEqual({ count: 12 });
    expect(d1.sqlite.prepare("SELECT status, start_at FROM external_blocks WHERE google_event_id = 'serialization-event'").get())
      .toEqual({ status: "active", start_at: "2026-06-02T01:00:00.000Z" });
  });

  it("keeps existing Google locks when a transparent update has no valid time range", async () => {
    enqueue("original-block");
    await run(async () => eventPage(1, 1));
    enqueue("malformed-transparent");
    const result = await run(async () => Response.json({
      items: [{ id: "serialization-event", etag: "etag-2", status: "confirmed", transparency: "transparent" }],
      nextSyncToken: "sync-2"
    }));

    expect(result.succeeded).toBe(1);
    expect(d1.sqlite.prepare("SELECT status FROM external_blocks WHERE google_event_id = 'serialization-event'").get())
      .toEqual({ status: "active" });
    expect(d1.sqlite.prepare("SELECT COUNT(*) AS count FROM slot_locks WHERE owner_type = 'external_block'").get())
      .toEqual({ count: 12 });
    expect(d1.sqlite.prepare("SELECT conflict_type FROM google_calendar_conflicts WHERE resolution_status = 'open'").get())
      .toEqual({ conflict_type: "external_block_invalid_time" });
  });

  it.each([
    { name: "null collection", body: null },
    { name: "array collection", body: [] },
    { name: "empty collection without a terminal token", body: {} },
    { name: "non-array items", body: { items: "bad", nextSyncToken: "new-sync" } },
    { name: "null item", body: { items: [null], nextSyncToken: "new-sync" } },
    { name: "item without an ID", body: { items: [{}], nextSyncToken: "new-sync" } },
    { name: "array item", body: { items: [[]], nextSyncToken: "new-sync" } },
    { name: "wrong collection kind", body: { kind: "calendar#error", items: [], nextSyncToken: "new-sync" } },
    { name: "numeric page token", body: { items: [], nextPageToken: 1 } },
    { name: "empty page token", body: { items: [], nextPageToken: "", nextSyncToken: "new-sync" } },
    { name: "numeric sync token", body: { items: [], nextSyncToken: 1 } },
    { name: "blank sync token", body: { items: [], nextSyncToken: " " } },
    { name: "both pagination tokens", body: { items: [], nextPageToken: "next-page", nextSyncToken: "new-sync" } }
  ])("preserves existing events and the sync token after a malformed successful response: $name", async ({ body }) => {
    enqueue("original-event");
    expect((await run(async () => eventPage(1, 1))).succeeded).toBe(1);
    d1.sqlite.prepare("UPDATE google_calendar_events SET last_seen_at = '2020-01-01 00:00:00'").run();
    enqueue("invalid-full-walk");
    d1.sqlite.prepare("UPDATE google_calendar_import_jobs SET reason = 'full_reconcile' WHERE id = 'invalid-full-walk'").run();

    const result = await run(async () => Response.json(body));

    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(d1.sqlite.prepare("SELECT status FROM google_calendar_events WHERE google_event_id = 'serialization-event'").get())
      .toEqual({ status: "active" });
    expect(d1.sqlite.prepare("SELECT sync_token, last_full_reconcile_at FROM google_calendar_channels WHERE id = 'channel'").get())
      .toEqual({ sync_token: "sync-1", last_full_reconcile_at: null });
    expect(d1.sqlite.prepare("SELECT status, last_error FROM google_calendar_import_jobs WHERE id = 'invalid-full-walk'").get())
      .toEqual({ status: "retryable", last_error: "google-events-list-invalid-response" });
  });

  it.each([
    { items: [], nextSyncToken: "sync-empty" },
    { kind: "calendar#events", nextSyncToken: "sync-empty" },
    { nextSyncToken: "sync-empty" }
  ])("accepts a valid empty terminal collection %#", async (body) => {
    enqueue("empty-full-walk");
    d1.sqlite.prepare("UPDATE google_calendar_import_jobs SET reason = 'full_reconcile' WHERE id = 'empty-full-walk'").run();

    expect((await run(async () => Response.json(body))).succeeded).toBe(1);
    expect(d1.sqlite.prepare("SELECT sync_token FROM google_calendar_channels WHERE id = 'channel'").get())
      .toEqual({ sync_token: "sync-empty" });
  });

  it("reroutes an unknown legacy token without erasing it before a validated full walk", async () => {
    d1.sqlite.prepare("UPDATE google_calendar_channels SET sync_query_version = NULL WHERE id = 'channel'").run();
    enqueue("legacy-token");
    const fetcher = vi.fn(async () => Response.json({ items: [], nextSyncToken: "unexpected-incremental" }));

    const rerouted = await run(fetcher);

    expect(rerouted.fullSyncQueued).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(d1.sqlite.prepare("SELECT sync_token, sync_query_version FROM google_calendar_channels WHERE id = 'channel'").get())
      .toEqual({ sync_token: "sync-0", sync_query_version: null });

    expect((await run(async () => Response.json({}), NOW_MS + 60_000)).failed).toBe(1);
    expect(d1.sqlite.prepare("SELECT sync_token, sync_query_version FROM google_calendar_channels WHERE id = 'channel'").get())
      .toEqual({ sync_token: "sync-0", sync_query_version: null });

    const fullFetch = vi.fn(async (url: RequestInfo | URL) => {
      const params = new URL(String(url)).searchParams;
      expect(params.has("syncToken")).toBe(false);
      expect(params.get("singleEvents")).toBe("true");
      expect(params.get("showDeleted")).toBe("true");
      expect(params.get("maxResults")).toBe("150");
      return Response.json({ items: [], nextSyncToken: "validated-full-token" });
    });
    expect((await run(fullFetch, NOW_MS + 600_000)).succeeded).toBe(1);
    expect(d1.sqlite.prepare("SELECT sync_token, sync_query_version FROM google_calendar_channels WHERE id = 'channel'").get())
      .toEqual({ sync_token: "validated-full-token", sync_query_version: 1 });

    enqueue("after-normalization");
    const nextFetch = vi.fn(async (url: RequestInfo | URL) => {
      const params = new URL(String(url)).searchParams;
      expect(params.get("syncToken")).toBe("validated-full-token");
      expect(params.has("timeMin")).toBe(false);
      expect(params.get("singleEvents")).toBe("true");
      expect(params.get("showDeleted")).toBe("true");
      expect(params.get("maxResults")).toBe("150");
      return Response.json({ items: [], nextSyncToken: "next-incremental-token" });
    });
    expect((await run(nextFetch, NOW_MS + 600_000)).succeeded).toBe(1);
  });

  it("applies the query-version migration to populated channels without changing their token or booking locks", async () => {
    enqueue("populated-before-migration");
    expect((await run(async () => eventPage(1, 1))).succeeded).toBe(1);
    d1.sqlite.exec("ALTER TABLE google_calendar_channels DROP COLUMN sync_query_version");

    d1.sqlite.exec(readFileSync(new URL("../migrations/0059_google_calendar_sync_query_version.sql", import.meta.url), "utf8"));

    expect(d1.sqlite.prepare("SELECT sync_token, sync_query_version FROM google_calendar_channels WHERE id = 'channel'").get())
      .toEqual({ sync_token: "sync-1", sync_query_version: null });
    expect(d1.sqlite.prepare("SELECT status, start_at FROM external_blocks WHERE google_event_id = 'serialization-event'").get())
      .toEqual({ status: "active", start_at: "2026-06-02T01:00:00.000Z" });
    expect(d1.sqlite.prepare("SELECT COUNT(*) AS count FROM slot_locks WHERE owner_type = 'external_block'").get())
      .toEqual({ count: 12 });
    expect(d1.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    d1.sqlite.prepare("UPDATE google_calendar_channels SET sync_token = 'old-code-write' WHERE id = 'channel'").run();
    expect(d1.sqlite.prepare("SELECT sync_token FROM google_calendar_channels WHERE id = 'channel'").get())
      .toEqual({ sync_token: "old-code-write" });
  });

  it("does not commit the full token or its version after the import claim is lost", async () => {
    enqueue("original-event");
    await run(async () => eventPage(1, 1));
    d1.sqlite.prepare("UPDATE google_calendar_events SET last_seen_at = '2020-01-01 00:00:00'").run();
    d1.sqlite.prepare("UPDATE google_calendar_channels SET sync_query_version = NULL WHERE id = 'channel'").run();
    enqueue("full-claim-lost");
    d1.sqlite.prepare("UPDATE google_calendar_import_jobs SET reason = 'full_reconcile' WHERE id = 'full-claim-lost'").run();
    const racingDb = {
      prepare(sql: string) {
        const statement = d1.prepare(sql);
        if (!sql.includes("UPDATE google_calendar_channels")) return statement;
        return {
          bind(...values: unknown[]) {
            const bound = statement.bind(...values);
            return {
              async run() {
                d1.sqlite.prepare(`
                  UPDATE google_calendar_import_jobs
                  SET status = 'processing', attempt_count = 2, locked_until = ?
                  WHERE id = 'full-claim-lost'
                `).run(new Date(NOW_MS + 300_000).toISOString());
                return bound.run();
              }
            };
          }
        };
      },
      batch: (statements: D1PreparedStatement[]) => d1.batch(statements)
    } as unknown as D1Database;

    const result = await run(async () => Response.json({ items: [], nextSyncToken: "stale-full-token" }), NOW_MS, racingDb);

    expect(result.failed).toBe(1);
    expect(d1.sqlite.prepare("SELECT sync_token, sync_query_version FROM google_calendar_channels WHERE id = 'channel'").get())
      .toEqual({ sync_token: "sync-1", sync_query_version: null });
    expect(d1.sqlite.prepare("SELECT status FROM google_calendar_events WHERE google_event_id = 'serialization-event'").get())
      .toEqual({ status: "active" });
  });

  it("recovers more than ten incremental pages through a resumable full walk while retaining the old token", async () => {
    const overflowEvent = (index: number) => {
      const start = Date.parse("2026-06-03T01:00:00.000Z") + index * 300_000;
      return {
        id: `overflow-event-${index}`, status: "confirmed", etag: `overflow-etag-${index}`,
        start: { dateTime: new Date(start).toISOString() },
        end: { dateTime: new Date(start + 300_000).toISOString() }
      };
    };
    enqueue("original-event");
    await run(async () => eventPage(1, 1));
    d1.sqlite.prepare("UPDATE google_calendar_events SET last_seen_at = '2020-01-01 00:00:00'").run();
    enqueue("overflow-incremental");
    const incrementalFetch = vi.fn(async (url: RequestInfo | URL) => {
      const params = new URL(String(url)).searchParams;
      expect(params.get("syncToken")).toBe("sync-1");
      const page = Number(params.get("pageToken")?.replace("incremental-", "") ?? "0");
      return Response.json({ items: [overflowEvent(page)], nextPageToken: `incremental-${page + 1}` });
    });

    const overflow = await run(incrementalFetch);

    expect(overflow.succeeded).toBe(1);
    expect(overflow.failed).toBe(0);
    expect(overflow.fullSyncQueued).toBe(1);
    expect(incrementalFetch).toHaveBeenCalledTimes(10);
    expect(d1.sqlite.prepare("SELECT sync_token, sync_query_version FROM google_calendar_channels WHERE id = 'channel'").get())
      .toEqual({ sync_token: "sync-1", sync_query_version: 1 });
    expect(d1.sqlite.prepare("SELECT status FROM google_calendar_events WHERE google_event_id = 'serialization-event'").get())
      .toEqual({ status: "active" });

    let clock = NOW_MS + 60_000;
    const firstFull = await processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database, env: ENV, now: () => clock, maxJobs: 1,
      accessTokenProvider: async () => "test-access-token",
      fetcher: async (url) => {
        expect(new URL(String(url)).searchParams.has("syncToken")).toBe(false);
        clock += 200_001;
        return Response.json({ items: [overflowEvent(0)], nextPageToken: "full-second-page" });
      }
    });
    expect(firstFull.yielded).toBe(1);
    expect(d1.sqlite.prepare("SELECT sync_token FROM google_calendar_channels WHERE id = 'channel'").get())
      .toEqual({ sync_token: "sync-1" });
    expect(d1.sqlite.prepare("SELECT resume_page_token FROM google_calendar_import_jobs WHERE reason = 'full_reconcile'").get())
      .toEqual({ resume_page_token: "full-second-page" });
    enqueue("after-overflow");
    const lastFull = await run(async (url) => {
      const params = new URL(String(url)).searchParams;
      expect(params.get("pageToken")).toBe("full-second-page");
      expect(params.has("syncToken")).toBe(false);
      return Response.json({ items: Array.from({ length: 10 }, (_, index) => overflowEvent(index + 1)), nextSyncToken: "full-after-overflow" });
    }, clock);
    expect(lastFull.succeeded).toBe(1);
    expect(d1.sqlite.prepare("SELECT status, attempt_count FROM google_calendar_import_jobs WHERE id = 'after-overflow'").get())
      .toEqual({ status: "queued", attempt_count: 0 });
    expect(d1.sqlite.prepare("SELECT sync_token, sync_query_version FROM google_calendar_channels WHERE id = 'channel'").get())
      .toEqual({ sync_token: "full-after-overflow", sync_query_version: 1 });

    expect((await run(async (url) => {
      expect(new URL(String(url)).searchParams.get("syncToken")).toBe("full-after-overflow");
      return Response.json({ items: [], nextSyncToken: "after-recovery" });
    }, clock)).succeeded).toBe(1);
  });

  it("rejects an old response after the same import job is reclaimed", async () => {
    enqueue("same-job");
    let release: (response: Response) => void = () => {};
    let entered: () => void = () => {};
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const response = new Promise<Response>((resolve) => { release = resolve; });
    const old = run(async () => { entered(); return response; });
    await enteredPromise;
    expect((await run(async () => eventPage(2, 3), NOW_MS + 300_001)).succeeded).toBe(1);
    const afterNew = snapshotImportedState();
    release(eventPage(1, 1));

    expect((await old).failed).toBe(1);
    expect(snapshotImportedState()).toEqual(afterNew);
    expect(sentryHelpers.safeCaptureException).not.toHaveBeenCalled();
  });

  it("rejects a constructed event batch after a different job takes over the expired calendar claim", async () => {
    enqueue("seed-event");
    await run(async () => eventPage(0, 0));
    enqueue("old-job");
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    let preparedEventUpdate = false;
    let paused = false;
    const delayedDb = {
      prepare(sql: string) {
        if (sql.includes("UPDATE external_blocks")) preparedEventUpdate = true;
        return d1.prepare(sql);
      },
      async batch(statements: D1PreparedStatement[]) {
        if (preparedEventUpdate && !paused) {
          paused = true;
          entered();
          await resume;
        }
        return d1.batch(statements);
      }
    } as unknown as D1Database;
    const old = run(async () => eventPage(1, 1), NOW_MS, delayedDb);
    await enteredPromise;
    enqueue("new-job");
    d1.sqlite.prepare("UPDATE google_calendar_import_jobs SET next_run_at = '2026-04-01T00:00:00.000Z' WHERE id = 'new-job'").run();
    expect((await run(async () => eventPage(2, 3), NOW_MS + 300_001)).succeeded).toBe(1);
    const afterNew = snapshotImportedState();
    release();

    expect((await old).failed).toBe(1);
    expect(snapshotImportedState()).toEqual(afterNew);
    expect(sentryHelpers.safeCaptureException).not.toHaveBeenCalled();
  });

  it.each([false, true])("rejects stale post-walk writes after another job takes over (drift alert=%s)", async (alertEnabled) => {
    d1.sqlite.prepare(`
      INSERT INTO google_calendar_events (id, store_id, calendar_id, google_event_id,
        last_seen_at, source_type, status)
      VALUES ('stale-orphan', 'kyoto', ?, 'orphan-event', '2020-01-01 00:00:00', 'unknown', 'active')
    `).run(CALENDAR_ID);
    enqueue("old-full");
    d1.sqlite.prepare("UPDATE google_calendar_import_jobs SET reason = 'full_reconcile' WHERE id = 'old-full'").run();
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    const old = processDueGoogleCalendarImportJobs({
      db: d1 as unknown as D1Database, env: { ...ENV, GOOGLE_DRIFT_ALERT_LIVE: String(alertEnabled) },
      now: () => NOW_MS, maxJobs: 1, accessTokenProvider: async () => "test-access-token",
      fetcher: async () => Response.json({ items: [], nextSyncToken: "old-full-token" }),
      computeDrift: async () => {
        entered();
        await resume;
        return { googleSweepCount: 0, d1SweepCount: 10, drift: 10 };
      }
    });
    await enteredPromise;
    enqueue("new-job");
    expect((await run(async () => eventPage(2, 3), NOW_MS + 300_001)).succeeded).toBe(1);
    const afterNew = snapshotImportedState();
    release();

    expect((await old).failed).toBe(1);
    expect(snapshotImportedState()).toEqual(afterNew);
    expect(sentryHelpers.safeCaptureException).not.toHaveBeenCalled();
  });
});
