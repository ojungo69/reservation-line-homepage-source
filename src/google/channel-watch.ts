import { defaultGoogleCalendarAccessTokenProvider } from "./service-account";
import { fetchStoreCalendars, type StoreCalendarRow } from "./store-calendars";
import { logGoogleEvent } from "../logging";
import { withOutboundTimeout } from "../outbound-timeout";
import { safeCaptureException } from "../sentry-helpers";
import { sha256Hex } from "../crypto-utils";
import { mapConcurrent } from "../concurrency";

import type { WorkerBindings } from "../bindings";
import type { GoogleErrorClass } from "../logging";

export type GoogleCalendarWatchResult = {
  checked: number;
  created: number;
  renewed: number;
  stopped: number;
  failed: number;
  skipped: number;
};

type GoogleCalendarWatchEnv = Pick<
  WorkerBindings,
  "GOOGLE_CALENDAR_WEBHOOK_URL" | "GOOGLE_SERVICE_ACCOUNT_EMAIL" | "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY"
>;

type CalendarAuthConnectionRow = {
  id: string;
  status: "active" | "disabled" | "needs_reauth";
};

type GoogleCalendarChannelRow = {
  id: string;
  channel_id: string;
  resource_id: string;
  expiration_at: string | null;
  sync_token: string | null;
};

type DueWatchCalendar = {
  store: StoreCalendarRow;
  connection: CalendarAuthConnectionRow;
  currentChannel: GoogleCalendarChannelRow | null;
};

type WatchCalendarOutcome = {
  created: number;
  renewed: number;
  stopped: number;
  failed: number;
};

type WatchResponse = {
  id?: unknown;
  resourceId?: unknown;
  resourceUri?: unknown;
  expiration?: unknown;
};

const GOOGLE_CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";
const CHANNEL_TTL_SECONDS = 7 * 24 * 60 * 60;
export const CHANNEL_RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000;
// Per-store deterministic jitter on the renewal threshold so all calendars
// don't try to renew on the exact same cron tick when their underlying
// channels happen to be born within the same minute. At 4 calendars the
// synchronized burst is fine; at 16+ calendars the channels.watch RPC quota
// would spike toward the per-minute ceiling. Bound to [0, 2h) so a store
// never lags past expiration even in the worst-case offset.
const CHANNEL_RENEWAL_JITTER_MAX_MS = 2 * 60 * 60 * 1000;
const CHANNEL_RENEWAL_JITTER_SEED_HEX_LEN = 4; // 4 hex digits → [0, 0xFFFF]
const CHANNEL_RENEWAL_JITTER_SEED_SPACE = 0x10000; // 0xFFFF + 1

// Self-healing transient failure classes (Google 5xx / 429). A register/renew
// failure in one of these recurs on EVERY sweep across the ~24h renewal window
// of an outage, once per due calendar — capturing each to Sentry would flood
// ingestion for a condition no operator can act on. These stay in logGoogleEvent
// (observable in logs); only persistent, actionable classes (auth misconfig,
// unexpected/contract anomalies) page Sentry. Mirrors the transient-D1-export
// suppression in sentry-helpers.ts.
const TRANSIENT_WATCH_ERROR_CLASSES: ReadonlySet<GoogleErrorClass> = new Set([
  "google_api_unavailable",
  "google_quota_exceeded"
]);

const toIso = (ms: number) => new Date(ms).toISOString();

const parseHttpsUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
};

const createEmptyResult = (): GoogleCalendarWatchResult => ({
  checked: 0,
  created: 0,
  renewed: 0,
  stopped: 0,
  failed: 0,
  skipped: 0
});

const fetchCalendarAuthConnection = async (db: D1Database, calendarId: string) => {
  return db
    .prepare(
      `
        SELECT id, status
        FROM calendar_auth_connections
        WHERE provider = 'google'
          AND calendar_id = ?
        LIMIT 1
      `
    )
    .bind(calendarId)
    .first<CalendarAuthConnectionRow>();
};

const ensureCalendarAuthConnection = async (input: {
  db: D1Database;
  storeId: string;
  calendarId: string;
  serviceAccountEmail: string;
  nowIso: string;
}) => {
  const existing = await fetchCalendarAuthConnection(input.db, input.calendarId);
  if (existing) {
    return existing.status === "active" ? existing : undefined;
  }

  const id = crypto.randomUUID();
  await input.db
    .prepare(
      `
        INSERT OR IGNORE INTO calendar_auth_connections (
          id,
          store_id,
          provider,
          calendar_id,
          service_account_email,
          status,
          updated_at
        ) VALUES (?, ?, 'google', ?, ?, 'active', ?)
      `
    )
    .bind(id, input.storeId, input.calendarId, input.serviceAccountEmail, input.nowIso)
    .run();

  return fetchCalendarAuthConnection(input.db, input.calendarId);
};

const fetchActiveChannel = async (db: D1Database, storeId: string, calendarId: string) => {
  return db
    .prepare(
      `
        SELECT id, channel_id, resource_id, expiration_at, sync_token
        FROM google_calendar_channels
        WHERE store_id = ?
          AND calendar_id = ?
          AND status = 'active'
        ORDER BY
          CASE WHEN expiration_at IS NULL THEN 1 ELSE 0 END ASC,
          expiration_at DESC,
          created_at DESC
        LIMIT 1
      `
    )
    .bind(storeId, calendarId)
    .first<GoogleCalendarChannelRow>();
};

// Resolve a per-store deterministic offset on the renewal threshold. The
// same store always picks the same offset across cron ticks so the renewal
// schedule is easy to reason about during incident triage. SHA-256 of
// store_id gives a uniform distribution across the [0, JITTER_MAX) window.
const computeChannelRenewalJitterMs = async (storeId: string): Promise<number> => {
  const hashHex = await sha256Hex(storeId);
  const seed = Number.parseInt(hashHex.slice(0, CHANNEL_RENEWAL_JITTER_SEED_HEX_LEN), 16);
  return Math.floor((seed / CHANNEL_RENEWAL_JITTER_SEED_SPACE) * CHANNEL_RENEWAL_JITTER_MAX_MS);
};

const isChannelFresh = async (
  channel: GoogleCalendarChannelRow,
  nowMs: number,
  storeId: string
) => {
  if (!channel.expiration_at) {
    return true;
  }
  const expirationMs = new Date(channel.expiration_at).getTime();
  if (!Number.isFinite(expirationMs)) {
    return false;
  }
  // Effective threshold: BASE - jitter. A store with jitter=2h renews when
  // ~22h remain instead of the canonical 24h, so the renewal cron tick is
  // staggered across calendars. jitter never lengthens the window — it only
  // narrows the safety margin — so no store can fall past expiration via
  // the jitter alone.
  const jitter = await computeChannelRenewalJitterMs(storeId);
  const threshold = CHANNEL_RENEWAL_WINDOW_MS - jitter;
  return expirationMs - nowMs > threshold;
};

const createWatchChannel = async (input: {
  calendarId: string;
  webhookUrl: string;
  accessToken: string;
  fetcher: typeof fetch;
  nowMs: number;
}) => {
  const channelId = crypto.randomUUID();
  const channelToken = `${crypto.randomUUID()}:${crypto.randomUUID()}`;
  let response: Response;
  try {
    response = await input.fetcher(
      `${GOOGLE_CALENDAR_API_BASE}/calendars/${encodeURIComponent(input.calendarId)}/events/watch`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          id: channelId,
          type: "web_hook",
          address: input.webhookUrl,
          token: channelToken,
          params: {
            ttl: String(CHANNEL_TTL_SECONDS)
          }
        })
      }
    );
  } catch {
    // Outbound timeout / transport error: result-ify so the caller takes the
    // ordinary failure path (counted + logged) instead of throwing into the
    // per-calendar catch (mirrors calendar-sync §2b).
    return {
      ok: false as const,
      reason: "google-watch-fetch-failed"
    };
  }

  if (!response.ok) {
    return {
      ok: false as const,
      reason: `google-watch-http-${response.status}`
    };
  }

  let body: WatchResponse;
  try {
    const payload: unknown = await response.json();
    if (typeof payload !== "object" || payload === null) {
      return {
        ok: false as const,
        reason: "invalid-google-watch-response"
      };
    }
    body = payload as WatchResponse;
  } catch {
    // A malformed / non-JSON 200 body is surfaced ONCE by the centralized
    // !watch.ok capture in processDueWatchCalendar (which carries store_id /
    // calendar_id / reason / error_class). Capturing here too would double-report
    // the same failure, so this catch only result-ifies it.
    return {
      ok: false as const,
      reason: "invalid-google-watch-response"
    };
  }

  if (body.id !== channelId || typeof body.resourceId !== "string") {
    return {
      ok: false as const,
      reason: "invalid-google-watch-response"
    };
  }

  const expirationMs = Number(body.expiration);
  return {
    ok: true as const,
    channelId,
    resourceId: body.resourceId,
    tokenHash: await sha256Hex(channelToken),
    expirationAt: Number.isFinite(expirationMs)
      ? toIso(expirationMs)
      : toIso(input.nowMs + CHANNEL_TTL_SECONDS * 1000)
  };
};

const stopWatchChannel = async (input: {
  channel: GoogleCalendarChannelRow;
  accessToken: string;
  fetcher: typeof fetch;
}) => {
  let response: Response;
  try {
    response = await input.fetcher(`${GOOGLE_CALENDAR_API_BASE}/channels/stop`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        id: input.channel.channel_id,
        resourceId: input.channel.resource_id
      })
    });
  } catch {
    // Outbound timeout / transport error MUST NOT throw past the caller:
    // processDueWatchCalendar relies on getting a boolean back so it can
    // still retire the old channel to 'stopped' — a throw here would skip
    // that markChannelStatus and leave the row stuck in 'renewing' forever
    // (renewal sweep only revisits 'active'; import prefers a stale
    // 'renewing' row). Google expires the un-stopped channel on its TTL.
    return false;
  }
  return response.ok || response.status === 404;
};

const persistNewChannel = async (input: {
  db: D1Database;
  storeId: string;
  calendarAuthConnectionId: string;
  calendarId: string;
  channelId: string;
  resourceId: string;
  tokenHash: string;
  // The incremental sync_token carried over from the channel being retired (NULL
  // for a brand-new calendar's first channel). The syncToken is calendar state,
  // not watch-channel state — a token obtained via events.list stays valid for
  // subsequent events.list on the same calendar regardless of the push channel.
  // Inheriting it keeps the post-renewal cron_incremental a cheap delta instead
  // of an unbounded full event walk that can outrun the 270s claim budget on a
  // large calendar (the cron_task_timeout:import_jobs incident, 2026-06-18). A
  // carried token that has since expired degrades safely: events.list returns
  // 410 → the existing recovery path NULLs it and enqueues a checkpointed
  // full_reconcile. The carried value may be up to one cron_incremental delta
  // stale — a concurrent import can advance the retiring channel's token
  // between the sweep-time read (fetchActiveChannel) and this INSERT — but
  // replaying that delta is idempotent (event upserts + DELETE-then-reinsert of
  // external-block locks), so the staleness is harmless.
  syncToken: string | null;
  expirationAt: string;
  nowIso: string;
}) => {
  await input.db
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
          status,
          expiration_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'sha256', ?, 'active', ?, ?)
      `
    )
    .bind(
      crypto.randomUUID(),
      input.storeId,
      input.calendarAuthConnectionId,
      input.calendarId,
      input.channelId,
      input.resourceId,
      input.tokenHash,
      input.syncToken,
      input.expirationAt,
      input.nowIso
    )
    .run();
};

const markChannelStatus = async (
  db: D1Database,
  channel: GoogleCalendarChannelRow,
  status: "renewing" | "stopped",
  nowIso: string
) => {
  await db
    .prepare(
      `
        UPDATE google_calendar_channels
        SET status = ?,
            updated_at = ?
        WHERE id = ?
      `
    )
    .bind(status, nowIso, channel.id)
    .run();
};

const collectDueWatchCalendars = async (input: {
  db: D1Database;
  calendars: StoreCalendarRow[];
  serviceAccountEmail: string;
  nowIso: string;
  nowMs: number;
}) => {
  // Shared calendar IDs retain store order for auth ownership and fresh status checks.
  const preceding = new Map<string, Promise<DueWatchCalendar | undefined>>();
  const checked = await mapConcurrent(input.calendars, (store) => {
    const check = (preceding.get(store.calendar_id) ?? Promise.resolve()).then(async () => {
      const connection = await ensureCalendarAuthConnection({
        db: input.db,
        storeId: store.store_id,
        calendarId: store.calendar_id,
        serviceAccountEmail: input.serviceAccountEmail,
        nowIso: input.nowIso
      });
      if (!connection) return undefined;

      const currentChannel = await fetchActiveChannel(input.db, store.store_id, store.calendar_id);
      if (currentChannel && (await isChannelFresh(currentChannel, input.nowMs, store.store_id))) return undefined;
      return { store, connection, currentChannel };
    });
    preceding.set(store.calendar_id, check);
    return check;
  });
  const dueCalendars = checked.filter((item): item is DueWatchCalendar => item !== undefined);

  return {
    dueCalendars,
    skipped: checked.length - dueCalendars.length
  };
};

const processDueWatchCalendar = async (input: {
  db: D1Database;
  item: DueWatchCalendar;
  webhookUrl: string;
  accessToken: string;
  fetcher: typeof fetch;
  nowMs: number;
  nowIso: string;
}): Promise<WatchCalendarOutcome> => {
  const watch = await createWatchChannel({
    calendarId: input.item.store.calendar_id,
    webhookUrl: input.webhookUrl,
    accessToken: input.accessToken,
    fetcher: input.fetcher,
    nowMs: input.nowMs
  });
  if (!watch.ok) {
    const errorClass = mapWatchErrorToClass(watch.reason);
    logGoogleEvent({
      event_type: "channel_watch_register",
      outcome: "failure",
      calendar_id: input.item.store.calendar_id,
      store_id: input.item.store.store_id,
      error_class: errorClass
    });
    // A register/renew RESULT failure returns normally, so the outer try/catch —
    // which only catches transport throws — never saw it; it was invisible in
    // Sentry (structured log only). Surface PERSISTENT, actionable failures
    // (service-account auth misconfig, contract/parse anomalies). Self-healing
    // transient classes (Google 5xx / 429) are suppressed from Sentry to avoid a
    // per-calendar-per-sweep flood during an outage — they remain in the log above.
    if (!TRANSIENT_WATCH_ERROR_CLASSES.has(errorClass)) {
      safeCaptureException(
        new Error(`channel-watch: register_watch_channel failed (${watch.reason})`),
        {
          tags: {
            google_module: "channel-watch",
            operation: "register_watch_channel",
            error_class: errorClass
          },
          contexts: {
            d1_query: {
              store_id: input.item.store.store_id,
              calendar_id: input.item.store.calendar_id,
              reason: watch.reason
            }
          }
        }
      );
    }
    return {
      created: 0,
      renewed: 0,
      stopped: 0,
      failed: 1
    };
  }

  await persistNewChannel({
    db: input.db,
    storeId: input.item.store.store_id,
    calendarAuthConnectionId: input.item.connection.id,
    calendarId: input.item.store.calendar_id,
    channelId: watch.channelId,
    resourceId: watch.resourceId,
    tokenHash: watch.tokenHash,
    // Inherit the retiring channel's sync_token so the replacement does not
    // restart from a full event walk (NULL for a calendar's first channel).
    syncToken: input.item.currentChannel?.sync_token ?? null,
    expirationAt: watch.expirationAt,
    nowIso: input.nowIso
  });

  if (!input.item.currentChannel) {
    logGoogleEvent({
      event_type: "channel_watch_register",
      outcome: "success",
      calendar_id: input.item.store.calendar_id,
      store_id: input.item.store.store_id
    });
    return {
      created: 1,
      renewed: 0,
      stopped: 0,
      failed: 0
    };
  }

  await markChannelStatus(input.db, input.item.currentChannel, "renewing", input.nowIso);
  const stopped = await stopWatchChannel({
    channel: input.item.currentChannel,
    accessToken: input.accessToken,
    fetcher: input.fetcher
  });
  // Always retire the old channel once the new 'active' one is persisted. A failed
  // stop call previously left it stuck in 'renewing' forever (the renewal sweep only
  // revisits status='active'), and the import path PREFERS a stale 'renewing' row over
  // the freshly-created 'active' one — so the system never migrated onto the new
  // channel. Google expires the un-stopped channel on its own TTL; webhooks delivered
  // to a 'stopped' channel are not matched (webhook lookup is status IN active/renewing).
  await markChannelStatus(input.db, input.item.currentChannel, "stopped", input.nowIso);

  logGoogleEvent({
    event_type: "channel_watch_renew",
    outcome: stopped ? "success" : "failure",
    calendar_id: input.item.store.calendar_id,
    store_id: input.item.store.store_id
  });

  return {
    created: 1,
    renewed: 1,
    stopped: stopped ? 1 : 0,
    failed: stopped ? 0 : 1
  };
};

const mapWatchErrorToClass = (reason: string): GoogleErrorClass => {
  if (reason.startsWith("google-watch-http-401") || reason.startsWith("google-watch-http-403")) {
    return "google_auth_failure";
  }
  if (reason.startsWith("google-watch-http-429")) {
    return "google_quota_exceeded";
  }
  if (reason.startsWith("google-watch-http-5")) {
    return "google_api_unavailable";
  }
  // An outbound timeout / transport error reaching Google is, like a 5xx, a
  // self-healing transient condition (network blip / Google-side outage) — class
  // it as api_unavailable so it shares the Sentry suppression and is never paged
  // per-calendar-per-sweep. This leaves "unexpected" for genuinely actionable
  // contract anomalies (invalid-google-watch-response), which stay captured.
  if (reason === "google-watch-fetch-failed") {
    return "google_api_unavailable";
  }
  return "unexpected";
};

export async function ensureGoogleCalendarWatchChannels(input: {
  db: D1Database;
  env: GoogleCalendarWatchEnv;
  fetcher?: typeof fetch;
  accessTokenProvider?: () => Promise<string | undefined>;
  now?: () => number;
}): Promise<GoogleCalendarWatchResult> {
  const result = createEmptyResult();
  // Bind to globalThis so the fetcher keeps its expected `this`.
  // Without the bind, Cloudflare Workers raise
  // "Illegal invocation: function called with incorrect `this` reference"
  // when the extracted reference is invoked from a nested helper.
  const fetcher = input.fetcher ?? withOutboundTimeout(fetch.bind(globalThis));
  const now = input.now ?? Date.now;
  const nowMs = now();
  const nowIso = toIso(nowMs);
  const webhookUrl = parseHttpsUrl(input.env.GOOGLE_CALENDAR_WEBHOOK_URL);
  if (!webhookUrl) {
    logGoogleEvent({
      event_type: "channel_watch_no_webhook_url",
      outcome: "failure",
      error_class: "unexpected"
    });
    result.failed += 1;
    return result;
  }

  const calendars = await fetchStoreCalendars(input.db);
  result.checked = calendars.length;
  const due = await collectDueWatchCalendars({
    db: input.db,
    calendars,
    serviceAccountEmail: input.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    nowIso,
    nowMs
  });
  result.skipped += due.skipped;

  if (due.dueCalendars.length === 0) {
    return result;
  }

  const accessToken = input.accessTokenProvider
    ? await input.accessTokenProvider()
    : await defaultGoogleCalendarAccessTokenProvider(input.env, fetcher, now);
  if (!accessToken) {
    logGoogleEvent({
      event_type: "channel_watch_token_mismatch",
      outcome: "failure",
      error_class: "google_auth_failure"
    });
    // A null token fails the WHOLE sweep — every due channel is marked failed and
    // Google push delivery silently stops until a later tick succeeds. The
    // per-calendar try/catch below captures transport throws, but this early exit
    // bypasses it, so without an explicit capture here a service-account auth
    // outage is invisible in Sentry (structured log only).
    safeCaptureException(
      new Error("channel-watch: service account access token unavailable; all due channels marked failed"),
      {
        tags: { google_module: "channel-watch", operation: "acquire_access_token" },
        contexts: { d1_query: { due_calendars: due.dueCalendars.length } }
      }
    );
    result.failed += due.dueCalendars.length;
    return result;
  }

  // A shared calendar's create/persist/retire sequence must finish before its next store starts.
  const preceding = new Map<string, Promise<void>>();
  await mapConcurrent(due.dueCalendars, (item) => {
    const processed = (preceding.get(item.store.calendar_id) ?? Promise.resolve()).then(async () => {
      try {
        const outcome = await processDueWatchCalendar({
          db: input.db,
          item,
          webhookUrl,
          accessToken,
          fetcher,
          nowMs,
          nowIso
        });
        result.created += outcome.created;
        result.renewed += outcome.renewed;
        result.stopped += outcome.stopped;
        result.failed += outcome.failed;
      } catch (error) {
        // One calendar's failure must not reject the sweep or skip later calendars.
        logGoogleEvent({
          event_type: "channel_watch_register",
          outcome: "failure",
          calendar_id: item.store.calendar_id,
          store_id: item.store.store_id,
          error_class: "unexpected"
        });
        safeCaptureException(error, {
          tags: { google_module: "channel-watch", operation: "process_due_calendar" },
          contexts: { d1_query: { store_id: item.store.store_id, calendar_id: item.store.calendar_id } }
        });
        result.failed += 1;
      }
    });
    preceding.set(item.store.calendar_id, processed);
    return processed;
  });

  return result;
}
