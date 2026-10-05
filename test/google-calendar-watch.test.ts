import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { captureExceptionSpy } = vi.hoisted(() => ({ captureExceptionSpy: vi.fn() }));
vi.mock("@sentry/cloudflare", () => ({
  captureException: captureExceptionSpy,
  init: vi.fn(),
  withSentry: (_opts: unknown, handler: unknown) => handler,
  withMonitor: vi.fn((_slug: string, callback: () => unknown) => callback())
}));

import { ensureGoogleCalendarWatchChannels } from "../src/google/channel-watch";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const CALENDAR_ID = "calendar-a@example.invalid";
const WEBHOOK_URL = "https://reservation.example.com/api/google/calendar/webhook";

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

const requestUrl = (input: RequestInfo | URL) => {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
};

const requestBodyText = (body: BodyInit | null | undefined) => {
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  return "";
};

describe("Google Calendar watch channel lifecycle", () => {
  let d1: SqliteD1Database;

  beforeEach(() => {
    captureExceptionSpy.mockReset();
    d1 = createMigratedSqliteD1();
    d1.sqlite.prepare("UPDATE stores SET google_calendar_id = NULL WHERE id <> 'kyoto'").run();
  });

  afterEach(() => {
    d1.sqlite.close();
  });

  it("creates a watch channel for each store calendar without storing the plaintext channel token", async () => {
    let requestToken = "";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(requestUrl(input)).toBe("https://www.googleapis.com/calendar/v3/calendars/calendar-a%40example.invalid/events/watch");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({
        Authorization: "Bearer google_access_token",
        "Content-Type": "application/json"
      });
      const body = JSON.parse(requestBodyText(init?.body)) as {
        id: string;
        type: string;
        address: string;
        token: string;
        params: {
          ttl: string;
        };
      };
      requestToken = body.token;
      expect(body.id).toHaveLength(36);
      expect(body.type).toBe("web_hook");
      expect(body.address).toBe(WEBHOOK_URL);
      expect(body.token).toHaveLength(73);
      expect(body.params.ttl).toBe("604800");
      return Response.json({
        kind: "api#channel",
        id: body.id,
        resourceId: "google_resource_watch_1",
        resourceUri: "https://www.googleapis.com/calendar/v3/calendars/calendar-a@example.invalid/events",
        expiration: 1_800_604_800_000
      });
    }) as unknown as typeof fetch;

    const result = await ensureGoogleCalendarWatchChannels({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_CALENDAR_WEBHOOK_URL: WEBHOOK_URL,
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result).toEqual({
      checked: 1,
      created: 1,
      renewed: 0,
      stopped: 0,
      failed: 0,
      skipped: 0
    });
    const channel = d1.sqlite
      .prepare(
        `
          SELECT
            google_calendar_channels.status,
            google_calendar_channels.channel_id,
            google_calendar_channels.resource_id,
            google_calendar_channels.channel_token_hash,
            google_calendar_channels.channel_token_hash_alg,
            google_calendar_channels.expiration_at,
            calendar_auth_connections.status AS auth_status
          FROM google_calendar_channels
          JOIN calendar_auth_connections
            ON calendar_auth_connections.id = google_calendar_channels.calendar_auth_connection_id
          WHERE google_calendar_channels.calendar_id = ?
        `
      )
      .get(CALENDAR_ID) as {
        status: string;
        channel_id: string;
        resource_id: string;
        channel_token_hash: string;
        channel_token_hash_alg: string;
        expiration_at: string;
        auth_status: string;
      };
    expect(channel).toMatchObject({
      status: "active",
      resource_id: "google_resource_watch_1",
      channel_token_hash: sha256Hex(requestToken),
      channel_token_hash_alg: "sha256",
      expiration_at: "2027-01-22T08:00:00.000Z",
      auth_status: "active"
    });
    expect(channel.channel_id).toHaveLength(36);
    expect(channel.channel_token_hash).not.toBe(requestToken);
  });

  it("records a failed watch attempt when Google returns malformed watch JSON", async () => {
    const fetchMock = vi.fn(async () => new Response("not-json", { status: 200 })) as unknown as typeof fetch;

    const result = await ensureGoogleCalendarWatchChannels({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_CALENDAR_WEBHOOK_URL: WEBHOOK_URL,
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result).toEqual({
      checked: 1,
      created: 0,
      renewed: 0,
      stopped: 0,
      failed: 1,
      skipped: 0
    });
    const channels = d1.sqlite.prepare("SELECT COUNT(*) AS count FROM google_calendar_channels").get() as {
      count: number;
    };
    expect(channels.count).toBe(0);
    // A malformed-JSON 200 must produce exactly ONE Sentry event (the centralized
    // !watch.ok capture), not a second one from the response-parse catch.
    expect(captureExceptionSpy).toHaveBeenCalledTimes(1);
    expect(captureExceptionSpy.mock.calls[0][1]).toMatchObject({
      tags: { google_module: "channel-watch", operation: "register_watch_channel" }
    });
  });

  it("counts a per-calendar failure (and does not reject the sweep) when the watch fetch throws (timeout)", async () => {
    // An outbound timeout aborts createWatchChannel's fetch with a TimeoutError.
    // The per-calendar try/catch must absorb it: failed += 1, no channel
    // persisted, and the function still resolves (one calendar's timeout must
    // not reject the whole watch sweep).
    const fetchMock = vi.fn(async () => {
      throw new DOMException("outbound_timeout:30000ms", "TimeoutError");
    }) as unknown as typeof fetch;

    const result = await ensureGoogleCalendarWatchChannels({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_CALENDAR_WEBHOOK_URL: WEBHOOK_URL,
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result).toEqual({
      checked: 1,
      created: 0,
      renewed: 0,
      stopped: 0,
      failed: 1,
      skipped: 0
    });
    const channels = d1.sqlite.prepare("SELECT COUNT(*) AS count FROM google_calendar_channels").get() as {
      count: number;
    };
    expect(channels.count).toBe(0);
    // A transport timeout is self-healing transient (classed google_api_unavailable)
    // — logged, NOT paged, so an outage can't flood Sentry per-calendar-per-sweep.
    expect(captureExceptionSpy).not.toHaveBeenCalled();
  });

  it("renews expiring channels by creating a replacement and stopping the old channel", async () => {
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
            'calendar_auth_kyoto_renew_1',
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
            status,
            expiration_at
          ) VALUES (
            'google_calendar_channel_old_1',
            'kyoto',
            'calendar_auth_kyoto_renew_1',
            ?,
            'old_channel_id_1',
            'old_resource_id_1',
            ?,
            'sha256',
            'active',
            '2027-01-08T18:00:00.000Z'
          )
        `
      )
      .run(CALENDAR_ID, sha256Hex("old-token"));
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.endsWith("/events/watch")) {
        const body = JSON.parse(requestBodyText(init?.body)) as { id: string };
        return Response.json({
          kind: "api#channel",
          id: body.id,
          resourceId: "new_resource_id_1",
          resourceUri: "https://www.googleapis.com/calendar/v3/calendars/calendar-a@example.invalid/events",
          expiration: 1_800_604_800_000
        });
      }
      expect(url).toBe("https://www.googleapis.com/calendar/v3/channels/stop");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({
        Authorization: "Bearer google_access_token",
        "Content-Type": "application/json"
      });
      expect(JSON.parse(requestBodyText(init?.body))).toEqual({
        id: "old_channel_id_1",
        resourceId: "old_resource_id_1"
      });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const result = await ensureGoogleCalendarWatchChannels({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_CALENDAR_WEBHOOK_URL: WEBHOOK_URL,
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result).toEqual({
      checked: 1,
      created: 1,
      renewed: 1,
      stopped: 1,
      failed: 0,
      skipped: 0
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const rows = d1.sqlite
      .prepare("SELECT channel_id, resource_id, status FROM google_calendar_channels ORDER BY channel_id")
      .all() as { channel_id: string; resource_id: string; status: string }[];
    expect(rows).toContainEqual({
      channel_id: "old_channel_id_1",
      resource_id: "old_resource_id_1",
      status: "stopped"
    });
    expect(rows).toContainEqual({
      channel_id: expect.any(String) as string,
      resource_id: "new_resource_id_1",
      status: "active"
    });
  });

  it("carries the retired channel's sync_token over to the replacement channel on renewal", async () => {
    // Regression guard for the cron_task_timeout:import_jobs incident
    // (RESERVATION-LINE-HOMEPAGE-C, 2026-06-18): a renewed channel previously
    // started with sync_token = NULL, so the next cron_incremental against the
    // new channel did a NON-resumable full event walk (no syncToken delta, no
    // cooperative yield). On a large calendar (Kyoto, ~800 events) that walk
    // outran the 270s claim budget, crashing the whole */10 cron tick (taking
    // sibling notification/sync tasks down with it) and dead-lettering the job.
    // The syncToken is calendar state, not channel state, so the replacement
    // MUST inherit it — keeping the post-renewal incremental a cheap delta.
    const OLD_SYNC_TOKEN = "CARRIED_OVER_SYNC_TOKEN_abcdefghijklmnopqrst";
    d1.sqlite
      .prepare(
        `
          INSERT INTO calendar_auth_connections (
            id, store_id, provider, calendar_id, service_account_email, status
          ) VALUES (
            'calendar_auth_kyoto_carryover', 'kyoto', 'google', ?,
            'calendar-sync@example.iam.gserviceaccount.com', 'active'
          )
        `
      )
      .run(CALENDAR_ID);
    d1.sqlite
      .prepare(
        `
          INSERT INTO google_calendar_channels (
            id, store_id, calendar_auth_connection_id, calendar_id,
            channel_id, resource_id, channel_token_hash, channel_token_hash_alg,
            sync_token, status, expiration_at
          ) VALUES (
            'google_calendar_channel_carryover_old', 'kyoto', 'calendar_auth_kyoto_carryover', ?,
            'old_channel_carryover', 'old_resource_carryover', ?, 'sha256',
            ?, 'active', '2027-01-08T18:00:00.000Z'
          )
        `
      )
      .run(CALENDAR_ID, sha256Hex("old-token-carryover"), OLD_SYNC_TOKEN);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.endsWith("/events/watch")) {
        const body = JSON.parse(requestBodyText(init?.body)) as { id: string };
        return Response.json({
          kind: "api#channel",
          id: body.id,
          resourceId: "new_resource_carryover",
          resourceUri: "https://www.googleapis.com/calendar/v3/calendars/calendar-a@example.invalid/events",
          expiration: 1_800_604_800_000
        });
      }
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const result = await ensureGoogleCalendarWatchChannels({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_CALENDAR_WEBHOOK_URL: WEBHOOK_URL,
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result).toMatchObject({ created: 1, renewed: 1, stopped: 1, failed: 0 });
    const newChannel = d1.sqlite
      .prepare(
        "SELECT sync_token FROM google_calendar_channels WHERE resource_id = 'new_resource_carryover'"
      )
      .get() as { sync_token: string | null };
    expect(newChannel.sync_token).toBe(OLD_SYNC_TOKEN);
  });

  it("retires the old channel to 'stopped' even when the stop call times out (throws)", async () => {
    // Regression guard for the renewal flow: a stop-call abort (outbound
    // timeout) must NOT leave the old channel stuck in 'renewing' — the
    // renewal sweep only revisits 'active' rows and the import path prefers
    // a stale 'renewing' row, so a stuck row would permanently block
    // migration onto the new channel.
    d1.sqlite
      .prepare(
        `
          INSERT INTO calendar_auth_connections (
            id, store_id, provider, calendar_id, service_account_email, status
          ) VALUES (
            'calendar_auth_kyoto_renew_2', 'kyoto', 'google', ?,
            'calendar-sync@example.iam.gserviceaccount.com', 'active'
          )
        `
      )
      .run(CALENDAR_ID);
    d1.sqlite
      .prepare(
        `
          INSERT INTO google_calendar_channels (
            id, store_id, calendar_auth_connection_id, calendar_id,
            channel_id, resource_id, channel_token_hash, channel_token_hash_alg,
            status, expiration_at
          ) VALUES (
            'google_calendar_channel_old_2', 'kyoto', 'calendar_auth_kyoto_renew_2', ?,
            'old_channel_id_2', 'old_resource_id_2', ?, 'sha256',
            'active', '2027-01-08T18:00:00.000Z'
          )
        `
      )
      .run(CALENDAR_ID, sha256Hex("old-token-2"));
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.endsWith("/events/watch")) {
        const body = JSON.parse(requestBodyText(init?.body)) as { id: string };
        return Response.json({
          kind: "api#channel",
          id: body.id,
          resourceId: "new_resource_id_2",
          resourceUri: "https://www.googleapis.com/calendar/v3/calendars/calendar-a@example.invalid/events",
          expiration: 1_800_604_800_000
        });
      }
      // The stop call aborts (e.g. outbound timeout fired mid-request).
      throw new DOMException("outbound_timeout:30000ms", "TimeoutError");
    }) as unknown as typeof fetch;

    const result = await ensureGoogleCalendarWatchChannels({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_CALENDAR_WEBHOOK_URL: WEBHOOK_URL,
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    // The stop failed (failed: 1) but the renewal itself completed and the
    // sweep did not reject.
    expect(result).toEqual({
      checked: 1,
      created: 1,
      renewed: 1,
      stopped: 0,
      failed: 1,
      skipped: 0
    });
    const rows = d1.sqlite
      .prepare("SELECT channel_id, status FROM google_calendar_channels ORDER BY channel_id")
      .all() as { channel_id: string; status: string }[];
    // Old channel retired to 'stopped' — NOT stuck in 'renewing'.
    expect(rows).toContainEqual({
      channel_id: "old_channel_id_2",
      status: "stopped"
    });
    expect(rows.some((r) => r.status === "renewing")).toBe(false);
    expect(rows).toContainEqual({
      channel_id: expect.any(String) as string,
      status: "active"
    });
  });

  it("skips registration and logs warning when webhook URL is empty", async () => {
    const fetchMock = vi.fn(async () => Response.json({})) as unknown as typeof fetch;

    const result = await ensureGoogleCalendarWatchChannels({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_CALENDAR_WEBHOOK_URL: "",
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result).toEqual({
      checked: 0,
      created: 0,
      renewed: 0,
      stopped: 0,
      failed: 1,
      skipped: 0
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips registration when webhook URL is not HTTPS", async () => {
    const fetchMock = vi.fn(async () => Response.json({})) as unknown as typeof fetch;

    const result = await ensureGoogleCalendarWatchChannels({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_CALENDAR_WEBHOOK_URL: "http://insecure.example.com/webhook",
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result).toEqual({
      checked: 0,
      created: 0,
      renewed: 0,
      stopped: 0,
      failed: 1,
      skipped: 0
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails all due calendars when access token is unavailable", async () => {
    const fetchMock = vi.fn(async () => Response.json({})) as unknown as typeof fetch;

    const result = await ensureGoogleCalendarWatchChannels({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_CALENDAR_WEBHOOK_URL: WEBHOOK_URL,
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => undefined,
      now: () => 1_800_000_000_000
    });

    expect(result).toEqual({
      checked: 1,
      created: 0,
      renewed: 0,
      stopped: 0,
      failed: 1,
      skipped: 0
    });
    expect(fetchMock).not.toHaveBeenCalled();
    // The whole-sweep auth failure must surface in Sentry, not just the log —
    // otherwise a stopped Google push pipeline is invisible.
    expect(captureExceptionSpy).toHaveBeenCalledTimes(1);
    expect(captureExceptionSpy.mock.calls[0][1]).toMatchObject({
      tags: { google_module: "channel-watch", operation: "acquire_access_token" }
    });
  });

  it("records failure when Google API returns 401 Unauthorized", async () => {
    const fetchMock = vi.fn(async () => new Response("Unauthorized", { status: 401 })) as unknown as typeof fetch;

    const result = await ensureGoogleCalendarWatchChannels({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_CALENDAR_WEBHOOK_URL: WEBHOOK_URL,
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result).toEqual({
      checked: 1,
      created: 0,
      renewed: 0,
      stopped: 0,
      failed: 1,
      skipped: 0
    });
    const channels = d1.sqlite.prepare("SELECT COUNT(*) AS count FROM google_calendar_channels").get() as {
      count: number;
    };
    expect(channels.count).toBe(0);
    // A per-calendar register RESULT failure must reach Sentry (not just the log),
    // tagged by error_class so expected transient 503s can be filtered from a real
    // auth/quota outage.
    expect(captureExceptionSpy).toHaveBeenCalledTimes(1);
    expect(captureExceptionSpy.mock.calls[0][1]).toMatchObject({
      tags: {
        google_module: "channel-watch",
        operation: "register_watch_channel",
        error_class: "google_auth_failure"
      }
    });
  });

  it("records failure when Google API returns 403 Forbidden", async () => {
    const fetchMock = vi.fn(async () => new Response("Forbidden", { status: 403 })) as unknown as typeof fetch;

    const result = await ensureGoogleCalendarWatchChannels({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_CALENDAR_WEBHOOK_URL: WEBHOOK_URL,
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result).toEqual({
      checked: 1,
      created: 0,
      renewed: 0,
      stopped: 0,
      failed: 1,
      skipped: 0
    });
  });

  it("records failure when Google API returns 429 rate limit", async () => {
    const fetchMock = vi.fn(async () => new Response("Rate Limited", { status: 429 })) as unknown as typeof fetch;

    const result = await ensureGoogleCalendarWatchChannels({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_CALENDAR_WEBHOOK_URL: WEBHOOK_URL,
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result).toEqual({
      checked: 1,
      created: 0,
      renewed: 0,
      stopped: 0,
      failed: 1,
      skipped: 0
    });
    // 429 (google_quota_exceeded) is self-healing transient — logged, NOT paged
    // to Sentry (avoids a per-calendar-per-sweep flood during a Google outage).
    expect(captureExceptionSpy).not.toHaveBeenCalled();
  });

  it("records failure when Google API returns 500 server error", async () => {
    const fetchMock = vi.fn(async () => new Response("Internal Server Error", { status: 500 })) as unknown as typeof fetch;

    const result = await ensureGoogleCalendarWatchChannels({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_CALENDAR_WEBHOOK_URL: WEBHOOK_URL,
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result).toEqual({
      checked: 1,
      created: 0,
      renewed: 0,
      stopped: 0,
      failed: 1,
      skipped: 0
    });
    // 500 (google_api_unavailable) is self-healing transient — logged, NOT paged.
    expect(captureExceptionSpy).not.toHaveBeenCalled();
  });

  it("records failure when Google returns watch response with mismatched channel ID", async () => {
    const fetchMock = vi.fn(async () => {
      return Response.json({
        kind: "api#channel",
        id: "totally-different-channel-id",
        resourceId: "google_resource_1",
        expiration: 1_800_604_800_000
      });
    }) as unknown as typeof fetch;

    const result = await ensureGoogleCalendarWatchChannels({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_CALENDAR_WEBHOOK_URL: WEBHOOK_URL,
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result).toEqual({
      checked: 1,
      created: 0,
      renewed: 0,
      stopped: 0,
      failed: 1,
      skipped: 0
    });
  });

  it("records failure when Google returns watch response without resourceId", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(requestBodyText(init?.body)) as { id: string };
      return Response.json({
        kind: "api#channel",
        id: body.id
        // no resourceId
      });
    }) as unknown as typeof fetch;

    const result = await ensureGoogleCalendarWatchChannels({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_CALENDAR_WEBHOOK_URL: WEBHOOK_URL,
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result).toEqual({
      checked: 1,
      created: 0,
      renewed: 0,
      stopped: 0,
      failed: 1,
      skipped: 0
    });
  });

  it("skips calendars with disabled auth connections", async () => {
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
            'calendar_auth_kyoto_disabled',
            'kyoto',
            'google',
            ?,
            'calendar-sync@example.iam.gserviceaccount.com',
            'disabled'
          )
        `
      )
      .run(CALENDAR_ID);
    const fetchMock = vi.fn(async () => Response.json({})) as unknown as typeof fetch;

    const result = await ensureGoogleCalendarWatchChannels({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_CALENDAR_WEBHOOK_URL: WEBHOOK_URL,
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result).toEqual({
      checked: 1,
      created: 0,
      renewed: 0,
      stopped: 0,
      failed: 0,
      skipped: 1
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses fallback expiration when Google response omits expiration field", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(requestBodyText(init?.body)) as { id: string };
      return Response.json({
        kind: "api#channel",
        id: body.id,
        resourceId: "google_resource_no_exp",
        resourceUri: "https://www.googleapis.com/calendar/v3/calendars/calendar-a@example.invalid/events"
        // no expiration field
      });
    }) as unknown as typeof fetch;

    const result = await ensureGoogleCalendarWatchChannels({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_CALENDAR_WEBHOOK_URL: WEBHOOK_URL,
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result).toEqual({
      checked: 1,
      created: 1,
      renewed: 0,
      stopped: 0,
      failed: 0,
      skipped: 0
    });

    // Fallback expiration: nowMs + CHANNEL_TTL_SECONDS * 1000 = 1_800_000_000_000 + 604800 * 1000
    const channel = d1.sqlite
      .prepare("SELECT expiration_at FROM google_calendar_channels WHERE calendar_id = ?")
      .get(CALENDAR_ID) as { expiration_at: string };
    const expectedMs = 1_800_000_000_000 + 7 * 24 * 60 * 60 * 1000;
    expect(channel.expiration_at).toBe(new Date(expectedMs).toISOString());
  });

  it("renewal marks old channel as stopped even when channels.stop returns 404", async () => {
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
            'calendar_auth_kyoto_404',
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
            status,
            expiration_at
          ) VALUES (
            'google_calendar_channel_404_1',
            'kyoto',
            'calendar_auth_kyoto_404',
            ?,
            'old_channel_404',
            'old_resource_404',
            ?,
            'sha256',
            'active',
            '2027-01-08T18:00:00.000Z'
          )
        `
      )
      .run(CALENDAR_ID, sha256Hex("old-token-404"));
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.endsWith("/events/watch")) {
        const body = JSON.parse(requestBodyText(init?.body)) as { id: string };
        return Response.json({
          id: body.id,
          resourceId: "new_resource_404",
          expiration: 1_800_604_800_000
        });
      }
      // channels.stop returns 404 (channel already expired on Google side)
      return new Response("Not Found", { status: 404 });
    }) as unknown as typeof fetch;

    const result = await ensureGoogleCalendarWatchChannels({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_CALENDAR_WEBHOOK_URL: WEBHOOK_URL,
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result).toEqual({
      checked: 1,
      created: 1,
      renewed: 1,
      stopped: 1,
      failed: 0,
      skipped: 0
    });
    const oldChannel = d1.sqlite
      .prepare("SELECT status FROM google_calendar_channels WHERE channel_id = ?")
      .get("old_channel_404") as { status: string };
    expect(oldChannel.status).toBe("stopped");
  });

  it("returns empty result when no stores have a calendar configured", async () => {
    d1.sqlite.prepare("UPDATE stores SET google_calendar_id = NULL").run();
    const fetchMock = vi.fn(async () => Response.json({})) as unknown as typeof fetch;

    const result = await ensureGoogleCalendarWatchChannels({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_CALENDAR_WEBHOOK_URL: WEBHOOK_URL,
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result).toEqual({
      checked: 0,
      created: 0,
      renewed: 0,
      stopped: 0,
      failed: 0,
      skipped: 0
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not call Google when an active channel is not close to expiration", async () => {
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
            'calendar_auth_kyoto_fresh_1',
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
            status,
            expiration_at
          ) VALUES (
            'google_calendar_channel_fresh_1',
            'kyoto',
            'calendar_auth_kyoto_fresh_1',
            ?,
            'fresh_channel_id_1',
            'fresh_resource_id_1',
            ?,
            'sha256',
            'active',
            '2027-01-20T08:00:00.000Z'
          )
        `
      )
      .run(CALENDAR_ID, sha256Hex("fresh-token"));
    const fetchMock = vi.fn(async () => Response.json({})) as unknown as typeof fetch;

    const result = await ensureGoogleCalendarWatchChannels({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_CALENDAR_WEBHOOK_URL: WEBHOOK_URL,
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result).toEqual({
      checked: 1,
      created: 0,
      renewed: 0,
      stopped: 0,
      failed: 0,
      skipped: 1
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Google Calendar watch bounded concurrency", () => {
  let d1: SqliteD1Database;
  const nowMs = 1_800_000_000_000;
  const env = {
    GOOGLE_CALENDAR_WEBHOOK_URL: WEBHOOK_URL,
    GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
  };

  beforeEach(() => {
    d1 = createMigratedSqliteD1();
    d1.sqlite.exec("UPDATE stores SET google_calendar_id = NULL");
    for (let index = 0; index < 6; index += 1) {
      d1.sqlite.prepare("INSERT INTO stores (id, name, google_calendar_id) VALUES (?, ?, ?)")
        .run(`parallel_${index}`, `Parallel ${index}`, `parallel_calendar_${index}`);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    d1.sqlite.close();
  });

  it("bounds calendar preparation, checks auth before channels, and preserves the input order", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Set<string>();
    let inFlight = 0;
    let peak = 0;
    const prepare = d1.prepare.bind(d1);
    vi.spyOn(d1, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (!sql.includes("FROM calendar_auth_connections") && !sql.includes("FROM google_calendar_channels")) return statement;
      return {
        bind: (...values: unknown[]) => {
          const bound = statement.bind(...values);
          return {
            first: async () => {
              if (sql.includes("FROM google_calendar_channels")) {
                expect(d1.sqlite.prepare("SELECT status FROM calendar_auth_connections WHERE calendar_id = ?").get(String(values[1])))
                  .toMatchObject({ status: "active" });
                return bound.first();
              }
              const calendarId = String(values[0]);
              started.add(calendarId);
              peak = Math.max(peak, ++inFlight);
              try {
                await gate;
                if (calendarId === "parallel_calendar_0") await new Promise((resolve) => setTimeout(resolve, 10));
                return await bound.first();
              } finally {
                inFlight -= 1;
              }
            }
          };
        }
      } as unknown as D1PreparedStatement;
    });
    const watchOrder: string[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      watchOrder.push(decodeURIComponent(new URL(requestUrl(input)).pathname.split("/")[4]));
      const body = JSON.parse(requestBodyText(init?.body)) as { id: string };
      return Response.json({ id: body.id, resourceId: body.id, expiration: nowMs + 7 * 24 * 60 * 60 * 1000 });
    }) as typeof fetch;
    let settled = false;
    const pending = ensureGoogleCalendarWatchChannels({ db: d1 as unknown as D1Database, env, fetcher, accessTokenProvider: async () => "token", now: () => nowMs })
      .then((result) => { settled = true; return result; });
    try {
      await vi.waitFor(() => expect(started.size).toBe(4), { timeout: 1000 });
      expect(inFlight).toBe(4);
      expect(settled).toBe(false);
    } finally {
      release();
      await pending;
    }
    expect(await pending).toEqual({ checked: 6, created: 6, renewed: 0, stopped: 0, failed: 0, skipped: 0 });
    expect(peak).toBe(4);
    expect(inFlight).toBe(0);
    expect(watchOrder.slice(0, 4)).toEqual(["parallel_calendar_0", "parallel_calendar_1", "parallel_calendar_2", "parallel_calendar_3"]);
  });

  it("bounds renewals, waits for all channels, and isolates a failed calendar", async () => {
    for (let index = 0; index < 6; index += 1) {
      d1.sqlite.prepare("INSERT INTO calendar_auth_connections (id, store_id, calendar_id, status) VALUES (?, ?, ?, 'active')")
        .run(`auth_parallel_${index}`, `parallel_${index}`, `parallel_calendar_${index}`);
      d1.sqlite.prepare(`INSERT INTO google_calendar_channels (id, store_id, calendar_auth_connection_id, calendar_id, channel_id, resource_id, channel_token_hash, sync_token, status, expiration_at)
        VALUES (?, ?, ?, ?, ?, ?, 'hash', ?, 'active', ?)`)
        .run(`old_${index}`, `parallel_${index}`, `auth_parallel_${index}`, `parallel_calendar_${index}`, `old_channel_${index}`, `old_resource_${index}`, `sync_${index}`, new Date(nowMs - 1000).toISOString());
    }
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started: string[] = [];
    let inFlight = 0;
    let peak = 0;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(requestUrl(input));
      const body = JSON.parse(requestBodyText(init?.body)) as { id: string };
      if (url.pathname.endsWith("/channels/stop")) {
        const index = body.id.replace("old_channel_", "");
        expect(d1.sqlite.prepare("SELECT status FROM google_calendar_channels WHERE id = ?").get(`old_${index}`))
          .toEqual({ status: "renewing" });
        expect(d1.sqlite.prepare("SELECT sync_token FROM google_calendar_channels WHERE store_id = ? AND status = 'active'").get(`parallel_${index}`))
          .toEqual({ sync_token: `sync_${index}` });
        return new Response(null, { status: 200 });
      }
      const calendarId = decodeURIComponent(url.pathname.split("/")[4]);
      started.push(calendarId);
      peak = Math.max(peak, ++inFlight);
      try {
        await gate;
        if (calendarId === "parallel_calendar_1") return new Response(null, { status: 503 });
        return Response.json({ id: body.id, resourceId: body.id, expiration: nowMs + 7 * 24 * 60 * 60 * 1000 });
      } finally {
        inFlight -= 1;
      }
    }) as typeof fetch;
    let settled = false;
    const pending = ensureGoogleCalendarWatchChannels({ db: d1 as unknown as D1Database, env, fetcher, accessTokenProvider: async () => "token", now: () => nowMs })
      .then((result) => { settled = true; return result; });
    try {
      await vi.waitFor(() => expect(started).toHaveLength(4), { timeout: 1000 });
      expect(inFlight).toBe(4);
      expect(settled).toBe(false);
    } finally {
      release();
      await pending;
    }
    expect(await pending).toEqual({ checked: 6, created: 5, renewed: 5, stopped: 5, failed: 1, skipped: 0 });
    expect(peak).toBe(4);
    expect(inFlight).toBe(0);
    expect(started).toHaveLength(6);
    const channels = d1.sqlite.prepare("SELECT id, status FROM google_calendar_channels WHERE id LIKE 'old_%' ORDER BY id").all();
    expect(channels).toEqual([
      { id: "old_0", status: "stopped" }, { id: "old_1", status: "active" },
      { id: "old_2", status: "stopped" }, { id: "old_3", status: "stopped" },
      { id: "old_4", status: "stopped" }, { id: "old_5", status: "stopped" }
    ]);
  });

  it("preserves the first store's shared-calendar auth ownership and rechecks disabled status", async () => {
    d1.sqlite.exec("UPDATE stores SET google_calendar_id = CASE WHEN id IN ('parallel_0', 'parallel_1') THEN 'shared_calendar' ELSE NULL END");
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let authReads = 0;
    const prepare = d1.prepare.bind(d1);
    vi.spyOn(d1, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (!sql.includes("FROM calendar_auth_connections")) return statement;
      return {
        bind: (...values: unknown[]) => {
          const bound = statement.bind(...values);
          return {
            first: async () => {
              authReads += 1;
              if (authReads === 1) await gate;
              const row = await bound.first();
              // Disable after the first store's post-insert auth read.
              if (authReads === 2) d1.sqlite.exec("UPDATE calendar_auth_connections SET status = 'disabled' WHERE calendar_id = 'shared_calendar'");
              return row;
            }
          };
        }
      } as unknown as D1PreparedStatement;
    });
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(requestBodyText(init?.body)) as { id: string };
      return Response.json({ id: body.id, resourceId: body.id });
    }) as typeof fetch;
    const pending = ensureGoogleCalendarWatchChannels({ db: d1 as unknown as D1Database, env, fetcher, accessTokenProvider: async () => "token", now: () => nowMs });
    try {
      await vi.waitFor(() => expect(authReads).toBe(1), { timeout: 1000 });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(authReads).toBe(1);
    } finally {
      release();
      await pending;
    }
    expect(await pending).toEqual({ checked: 2, created: 1, renewed: 0, stopped: 0, failed: 0, skipped: 1 });
    expect(authReads).toBe(3);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(d1.sqlite.prepare("SELECT store_id, status FROM calendar_auth_connections WHERE calendar_id = 'shared_calendar'").get())
      .toEqual({ store_id: "parallel_0", status: "disabled" });
  });

  it("finishes a shared calendar's renewal before starting the next store's renewal", async () => {
    d1.sqlite.exec("UPDATE stores SET google_calendar_id = CASE WHEN id IN ('parallel_0', 'parallel_1') THEN 'shared_calendar' ELSE NULL END");
    d1.sqlite.exec("INSERT INTO calendar_auth_connections (id, store_id, calendar_id, status) VALUES ('shared_auth', 'parallel_0', 'shared_calendar', 'active')");
    for (let index = 0; index < 2; index += 1) {
      d1.sqlite.prepare(`INSERT INTO google_calendar_channels (id, store_id, calendar_auth_connection_id, calendar_id, channel_id, resource_id, channel_token_hash, status, expiration_at)
        VALUES (?, ?, 'shared_auth', 'shared_calendar', ?, ?, 'hash', 'active', ?)`)
        .run(`shared_old_${index}`, `parallel_${index}`, `shared_channel_${index}`, `shared_resource_${index}`, new Date(nowMs - 1000).toISOString());
    }
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let watches = 0;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(requestBodyText(init?.body)) as { id: string };
      if (requestUrl(input).endsWith("/channels/stop")) return new Response(null, { status: 200 });
      watches += 1;
      if (watches === 1) await gate;
      else expect(d1.sqlite.prepare("SELECT status FROM google_calendar_channels WHERE id = 'shared_old_0'").get())
        .toEqual({ status: "stopped" });
      return Response.json({ id: body.id, resourceId: body.id });
    }) as typeof fetch;
    const pending = ensureGoogleCalendarWatchChannels({ db: d1 as unknown as D1Database, env, fetcher, accessTokenProvider: async () => "token", now: () => nowMs });
    try {
      await vi.waitFor(() => expect(watches).toBe(1), { timeout: 1000 });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(watches).toBe(1);
    } finally {
      release();
      await pending;
    }
    expect(await pending).toEqual({ checked: 2, created: 2, renewed: 2, stopped: 2, failed: 0, skipped: 0 });
    expect(watches).toBe(2);
    expect(d1.sqlite.prepare("SELECT status FROM google_calendar_channels WHERE id LIKE 'shared_old_%'").all())
      .toEqual([{ status: "stopped" }, { status: "stopped" }]);
  });
});
