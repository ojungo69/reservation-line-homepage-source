import type { WorkerBindings } from "../bindings";
import { parseDateJstToUtcIso } from "../date-parse";
import { isTransientAbortError, withOutboundTimeout } from "../outbound-timeout";
import { getCachedServiceAccountAccessToken } from "./service-account";

// --- Public types ---

export type BusyInterval = {
  startUtc: string;
  endUtc: string;
  classification: "opaque" | "conflict" | "recurring_manual_task" | "all_day_block" | "freebusy_union";
};

export type GoogleBusyIntervalsResult =
  | { ok: true; busyIntervals: BusyInterval[] }
  | { ok: false; reason: "fail_closed"; errorClass: string };

export type FetchGoogleBusyIntervalsInput = {
  env: Partial<WorkerBindings>;
  storeId: string;
  calendarId: string;
  rangeStartUtc: string;
  rangeEndUtc: string;
  signal?: AbortSignal;
  /** Injected fetcher for testing. Defaults to global fetch. */
  fetcher?: typeof fetch;
  /** Injected access-token provider for testing. */
  accessTokenProvider?: (env: Partial<WorkerBindings>) => Promise<string | undefined>;
  /** Injected clock for testing. */
  now?: () => number;
  /** Logging hook (no-op by default; G3 will wire logGoogleEvent). */
  onLog?: (entry: { level: "warn" | "info"; message: string; context?: Record<string, unknown> }) => void;
};

// --- Google Calendar API response shapes (minimal) ---

type GoogleCalendarEvent = {
  id?: string;
  status?: string;
  transparency?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  recurringEventId?: string;
  extendedProperties?: {
    private?: Record<string, string>;
  };
};

type GoogleEventsListResponse = {
  kind?: string;
  nextPageToken?: string;
  items?: GoogleCalendarEvent[];
};

type GoogleFreeBusyResponse = {
  calendars?: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: unknown[] }>;
};

type GoogleSourceFailure = { ok: false; errorClass: "api_failed" | "api_parse_failed" | "pagination_limit" };
type GoogleSourceResult = { ok: true; busyIntervals: BusyInterval[] } | GoogleSourceFailure;

// --- Module-level in-memory cache ---

const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 256;

type CacheEntry = {
  busyIntervals: BusyInterval[];
  expiresAt: number;
};

const busyCache = new Map<string, CacheEntry>();

const evictOldestIfNeeded = () => {
  if (busyCache.size < CACHE_MAX_ENTRIES) {
    return;
  }
  const oldestKey = busyCache.keys().next().value;
  if (oldestKey !== undefined) {
    busyCache.delete(oldestKey);
  }
};

const getCacheKey = (storeId: string, calendarId: string, rangeStartUtc: string, rangeEndUtc: string) => {
  return `${storeId}:${calendarId}:${rangeStartUtc}:${rangeEndUtc}`;
};

/** Exported for testing only. */
export const _resetCacheForTesting = () => {
  busyCache.clear();
};

// --- Constants ---

const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const API_TIMEOUT_MS = 5_000;
const MAX_RETRIES = 1;
const MAX_EVENT_PAGES = 10;

// Keep one fetcher identity so the service-account token cache is shared across calls.
const accessTokenFetcher: typeof fetch = (url, init) => withOutboundTimeout(fetch, API_TIMEOUT_MS)(url, init);

// --- Helpers ---

const defaultAccessTokenProvider = async (env: Partial<WorkerBindings>): Promise<string | undefined> => {
  const email = env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  if (!email || !key) {
    return undefined;
  }
  const result = await getCachedServiceAccountAccessToken(
    { serviceAccountEmail: email, privateKey: key, scopes: [GOOGLE_CALENDAR_SCOPE] },
    accessTokenFetcher
  );
  return result.ok ? result.accessToken : undefined;
};

const isTransientError = (status: number) => {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
};

const readGoogleJson = async (
  response: Response,
  signal: AbortSignal
): Promise<{ ok: true; payload: unknown } | GoogleSourceFailure | undefined> => {
  try {
    const payload: unknown = await response.json();
    return signal.aborted ? undefined : { ok: true, payload };
  } catch (error) {
    // Body timeouts can be retried while the shared deadline remains open.
    if (isTransientAbortError(error)) return undefined;
    return { ok: false, errorClass: "api_parse_failed" };
  }
};

const fetchJsonWithTimeoutAndRetry = async (
  url: string,
  init: RequestInit,
  fetcher: typeof fetch,
  signal: AbortSignal
): Promise<{ ok: true; payload: unknown } | GoogleSourceFailure> => {
  const timedFetcher = withOutboundTimeout((request, options) => fetcher(request, {
    ...options,
    signal: options?.signal ? AbortSignal.any([options.signal, signal]) : signal
  }), API_TIMEOUT_MS);
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal.aborted) break;

    try {
      const response = await timedFetcher(url, init);

      if (response.ok) {
        const result = await readGoogleJson(response, signal);
        if (result) return result;
      } else {
        void response.body?.cancel().catch(() => {});
        if (!isTransientError(response.status)) break;
      }
    } catch {
      // Retry transport failures once, within the shared request deadline.
    }
  }
  return { ok: false, errorClass: "api_failed" };
};

// --- Event classification (SPEC S9) ---

const classifyEvent = (event: GoogleCalendarEvent): BusyInterval | null | undefined => {
  if (event.status === "cancelled") {
    return undefined;
  }

  const isTransparent = event.transparency === "transparent";
  const markers = event.extendedProperties?.private;
  const hasSystemMarker = Boolean(markers?.owner_type || markers?.reservation_id || markers?.external_block_id);
  const isAllDay = Boolean(event.start?.date) && !event.start?.dateTime;
  const isRecurring = Boolean(event.recurringEventId);

  // Google date-only boundaries are store-local JST dates; end.date is exclusive.
  const startRaw =
    event.start?.dateTime ??
    (event.start?.date ? parseDateJstToUtcIso(event.start.date) ?? undefined : undefined);
  const endRaw =
    event.end?.dateTime ??
    (event.end?.date ? parseDateJstToUtcIso(event.end.date) ?? undefined : undefined);

  if (!startRaw || !endRaw || !isValidInterval({ startUtc: startRaw, endUtc: endRaw })) return null;

  // Valid transparent events without a system marker do not occupy a slot.
  if (isTransparent && !hasSystemMarker) return undefined;

  // transparent + system marker = busy conflict
  if (isTransparent && hasSystemMarker) {
    return { startUtc: startRaw, endUtc: endRaw, classification: "conflict" };
  }

  // all-day event (including recurring all-day — isAllDay is checked first)
  if (isAllDay) {
    return { startUtc: startRaw, endUtc: endRaw, classification: "all_day_block" };
  }

  // recurring occurrence (already expanded via singleEvents=true)
  if (isRecurring) {
    return { startUtc: startRaw, endUtc: endRaw, classification: "recurring_manual_task" };
  }

  // opaque default = busy
  return { startUtc: startRaw, endUtc: endRaw, classification: "opaque" };
};

const isValidInterval = (interval: Pick<BusyInterval, "startUtc" | "endUtc">): boolean => {
  return typeof interval.startUtc === "string" && typeof interval.endUtc === "string" &&
    Number.isFinite(Date.parse(interval.startUtc)) && Number.isFinite(Date.parse(interval.endUtc)) &&
    Date.parse(interval.startUtc) < Date.parse(interval.endUtc);
};

const collectEventIntervals = (events: GoogleCalendarEvent[], busyIntervals: BusyInterval[]): boolean => {
  try {
    for (const event of events) {
      const interval = classifyEvent(event);
      if (interval === null) return false;
      if (interval) busyIntervals.push(interval);
    }
    return true;
  } catch {
    return false;
  }
};

const fetchEventsIntervals = async (
  url: string,
  headers: Record<string, string>,
  fetcher: typeof fetch,
  signal: AbortSignal
): Promise<GoogleSourceResult> => {
  const pageUrl = new URL(url);
  const busyIntervals: BusyInterval[] = [];
  for (let page = 0; page < MAX_EVENT_PAGES; page++) {
    const result = await fetchJsonWithTimeoutAndRetry(pageUrl.toString(), { method: "GET", headers }, fetcher, signal);
    if (!result.ok) return result;
    const data = result.payload as GoogleEventsListResponse | null;
    // Google may omit items on an empty page; kind identifies a real collection.
    if (!data || (data.kind !== undefined && data.kind !== "calendar#events") ||
      (!Array.isArray(data.items) && !(data.items === undefined && data.kind === "calendar#events"))) {
      return { ok: false, errorClass: "api_parse_failed" };
    }
    if (!collectEventIntervals(data.items ?? [], busyIntervals)) {
      return { ok: false, errorClass: "api_parse_failed" };
    }
    if (data.nextPageToken === undefined || data.nextPageToken === "") return { ok: true, busyIntervals };
    if (typeof data.nextPageToken !== "string") return { ok: false, errorClass: "api_parse_failed" };
    pageUrl.searchParams.set("pageToken", data.nextPageToken);
  }
  return { ok: false, errorClass: "pagination_limit" };
};

const fetchFreebusyIntervals = async (
  url: string,
  init: RequestInit,
  calendarId: string,
  fetcher: typeof fetch,
  signal: AbortSignal
): Promise<GoogleSourceResult> => {
  const result = await fetchJsonWithTimeoutAndRetry(url, init, fetcher, signal);
  if (!result.ok) return result;
  const data = result.payload as GoogleFreeBusyResponse | null;
  const calendar = data?.calendars?.[calendarId];
  if (!Array.isArray(calendar?.busy) ||
    (calendar.errors !== undefined && (!Array.isArray(calendar.errors) || calendar.errors.length > 0))) {
    return { ok: false, errorClass: "api_parse_failed" };
  }
  const busyIntervals: BusyInterval[] = [];
  for (const slot of calendar.busy) {
    const interval: BusyInterval = { startUtc: slot?.start, endUtc: slot?.end, classification: "freebusy_union" };
    if (!isValidInterval(interval)) return { ok: false, errorClass: "api_parse_failed" };
    busyIntervals.push(interval);
  }
  return { ok: true, busyIntervals };
};

// --- Merge & dedup intervals ---

const mergeIntervals = (intervals: BusyInterval[]): BusyInterval[] => {
  if (intervals.length === 0) {
    return [];
  }
  const sorted = [...intervals].sort(
    (a, b) => new Date(a.startUtc).getTime() - new Date(b.startUtc).getTime()
  );
  const merged: BusyInterval[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = merged.at(-1)!;
    if (new Date(current.startUtc).getTime() <= new Date(last.endUtc).getTime()) {
      // Overlapping or adjacent -- extend
      if (new Date(current.endUtc).getTime() > new Date(last.endUtc).getTime()) {
        last.endUtc = current.endUtc;
      }
    } else {
      merged.push(current);
    }
  }
  return merged;
};

// --- Main exported function ---

export async function fetchGoogleBusyIntervals(
  input: FetchGoogleBusyIntervalsInput
): Promise<GoogleBusyIntervalsResult> {
  const fetcher = input.fetcher ?? fetch.bind(globalThis);
  const getAccessToken = input.accessTokenProvider ?? defaultAccessTokenProvider;
  const nowMs = (input.now ?? Date.now)();
  const log = input.onLog ?? (() => {});

  if (input.signal?.aborted) return { ok: false, reason: "fail_closed", errorClass: "aborted" };

  // Check cache (successful results, including empty/free windows, are cached)
  const cacheKey = getCacheKey(input.storeId, input.calendarId, input.rangeStartUtc, input.rangeEndUtc);
  const cached = busyCache.get(cacheKey);
  if (cached && cached.expiresAt > nowMs) {
    return { ok: true, busyIntervals: cached.busyIntervals };
  }
  // If stale, remove
  if (cached) {
    busyCache.delete(cacheKey);
  }

  // Bound the entire lookup, including token acquisition and every events page.
  const deadline = AbortSignal.timeout(API_TIMEOUT_MS * (MAX_RETRIES + 1));
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  let stopTokenWait = () => {};
  const tokenAborted = new Promise<undefined>((resolve) => {
    stopTokenWait = () => resolve(undefined);
    signal.addEventListener("abort", stopTokenWait, { once: true });
  });
  let accessToken: string | undefined;
  try {
    accessToken = await Promise.race([getAccessToken(input.env), tokenAborted]);
  } catch {
    accessToken = undefined;
  } finally {
    signal.removeEventListener("abort", stopTokenWait);
  }
  if (signal.aborted) {
    return { ok: false, reason: "fail_closed", errorClass: input.signal?.aborted ? "aborted" : "deadline_exceeded" };
  }
  if (!accessToken) {
    log({ level: "warn", message: "Google access token unavailable, fail-closed", context: { storeId: input.storeId } });
    return { ok: false, reason: "fail_closed", errorClass: "token_unavailable" };
  }

  const encodedCalendarId = encodeURIComponent(input.calendarId);
  const authHeaders = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json"
  };

  // events.list + freebusy.query in parallel
  const eventsUrl =
    `https://www.googleapis.com/calendar/v3/calendars/${encodedCalendarId}/events` +
    `?singleEvents=true&timeMin=${encodeURIComponent(input.rangeStartUtc)}` +
    `&timeMax=${encodeURIComponent(input.rangeEndUtc)}` +
    `&maxResults=250&fields=kind,nextPageToken,items(id,status,transparency,start,end,recurringEventId,extendedProperties)`;

  const freebusyUrl = "https://www.googleapis.com/calendar/v3/freeBusy";
  const freebusyBody = JSON.stringify({
    timeMin: input.rangeStartUtc,
    timeMax: input.rangeEndUtc,
    items: [{ id: input.calendarId }]
  });

  const [eventsResult, freebusyResult] = await Promise.all([
    fetchEventsIntervals(eventsUrl, authHeaders, fetcher, signal),
    fetchFreebusyIntervals(
      freebusyUrl,
      { method: "POST", headers: authHeaders, body: freebusyBody },
      input.calendarId,
      fetcher,
      signal
    )
  ]);

  if (signal.aborted) {
    return { ok: false, reason: "fail_closed", errorClass: input.signal?.aborted ? "aborted" : "deadline_exceeded" };
  }

  // FreeBusy omits transparent events, including system-event conflicts.
  // Neither source alone satisfies SPEC §9's complete fail-closed check.
  if (!eventsResult.ok || !freebusyResult.ok) {
    const failedEventsSource = freebusyResult.ok ? "events" : "both";
    const source = eventsResult.ok ? "freebusy" : failedEventsSource;
    const failure = !eventsResult.ok ? eventsResult : freebusyResult as GoogleSourceFailure;
    const errorClass = !eventsResult.ok && !freebusyResult.ok && eventsResult.errorClass !== freebusyResult.errorClass
      ? "both_api_failed"
      : `${source}_${failure.errorClass}`;
    log({
      level: "warn",
      message: "Google API data incomplete, fail-closed",
      context: { storeId: input.storeId, errorClass }
    });
    return { ok: false, reason: "fail_closed", errorClass };
  }

  const merged = mergeIntervals([...eventsResult.busyIntervals, ...freebusyResult.busyIntervals]);

  // Cache all successful results, including empty/free windows, to avoid repeated Google calls
  evictOldestIfNeeded();
  busyCache.set(cacheKey, {
    busyIntervals: merged,
    expiresAt: nowMs + CACHE_TTL_MS
  });

  return { ok: true, busyIntervals: merged };
}
