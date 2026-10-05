import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkerBindings } from "../src/bindings";
import {
  listPublicAvailability,
  _resetGoogleLiveCacheForTesting
} from "../src/reservations/public-options";
import {
  _resetCacheForTesting,
  fetchGoogleBusyIntervals
} from "../src/google/availability-live-check";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const NOW_MS = Date.parse("2026-05-09T23:00:00.000Z");

const ENABLED_ENV: Partial<WorkerBindings> = {
  GOOGLE_IMPORT_ENABLED: "true",
  GOOGLE_LIVE_AVAILABILITY_ENABLED: "true",
  GOOGLE_SERVICE_ACCOUNT_EMAIL: "sa@example.iam.gserviceaccount.com",
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
};

const DISABLED_ENV: Partial<WorkerBindings> = {
  GOOGLE_IMPORT_ENABLED: "true",
  GOOGLE_LIVE_AVAILABILITY_ENABLED: "false"
};

const availabilityInput = (
  d1: SqliteD1Database,
  env: Partial<WorkerBindings>,
  overrides: {
    fetcher?: typeof fetch;
    accessTokenProvider?: (env: Partial<WorkerBindings>) => Promise<string | undefined>;
  } = {}
) => ({
  db: d1 as unknown as D1Database,
  env,
  storeId: "kyoto",
  serviceId: "service_kyoto_default_60",
  resourceId: "resource_kyoto_calendar",
  date: "2026-06-01",
  now: () => NOW_MS,
  ...overrides
});

const makeEventsListResponse = (items: unknown[]) =>
  Response.json({ items });

const makeFreebusyResponse = (calendarId: string, busy: Array<{ start: string; end: string }>) =>
  Response.json({
    calendars: {
      [calendarId]: { busy }
    }
  });

const createMockFetcher = (
  eventsResponse: Response | "error",
  freebusyResponse: Response | "error"
) => {
  return vi.fn(async (url: string | URL | Request) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    if (urlStr.includes("/events")) {
      if (eventsResponse === "error") {
        throw new Error("network error");
      }
      return eventsResponse.clone();
    }
    if (urlStr.includes("/freeBusy")) {
      if (freebusyResponse === "error") {
        throw new Error("network error");
      }
      return freebusyResponse.clone();
    }
    throw new Error("unexpected url: " + urlStr);
  }) as unknown as typeof fetch;
};

const mockAccessTokenProvider = async (_env: Partial<WorkerBindings>) => "test_access_token";

describe("public availability with Google live check", () => {
  let d1: SqliteD1Database;

  beforeEach(() => {
    d1 = createMigratedSqliteD1();
    _resetCacheForTesting();
  });

  afterEach(() => {
    d1.sqlite.close();
    _resetCacheForTesting();
    vi.restoreAllMocks();
  });

  it("checks later events pages before displaying a slot containing a transparent system event", async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      const requestUrl = new URL(String(url));
      if (requestUrl.pathname.endsWith("/freeBusy")) {
        return makeFreebusyResponse("calendar-a@example.invalid", []);
      }
      if (requestUrl.searchParams.get("pageToken") === "next page +/=?") {
        return makeEventsListResponse([{
          id: "system_event_on_second_page",
          transparency: "transparent",
          extendedProperties: { private: { owner_type: "reservation" } },
          start: { dateTime: "2026-06-01T01:00:00Z" },
          end: { dateTime: "2026-06-01T02:00:00Z" }
        }]);
      }
      return Response.json({ items: [], nextPageToken: "next page +/=?" });
    }) as typeof fetch;

    const result = await listPublicAvailability(availabilityInput(d1, ENABLED_ENV, {
      fetcher, accessTokenProvider: mockAccessTokenProvider
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slots.some((slot) => slot.startAt === "2026-06-01T01:00:00.000Z")).toBe(false);
    expect(result.slots.some((slot) => slot.startAt === "2026-06-01T04:00:00.000Z")).toBe(true);
    const eventsUrl = new URL(String(vi.mocked(fetcher).mock.calls[0]?.[0]));
    expect(eventsUrl.searchParams.get("fields")).toContain("nextPageToken");
  });

  const googleInput = () => ({
    env: ENABLED_ENV,
    storeId: "kyoto",
    calendarId: "calendar-a@example.invalid",
    rangeStartUtc: "2026-05-31T15:00:00.000Z",
    rangeEndUtc: "2026-06-01T15:00:00.000Z",
    accessTokenProvider: mockAccessTokenProvider,
    now: () => NOW_MS
  });

  it("fails closed without caching when a later events page is unavailable", async () => {
    const partialFetcher = (async (url: RequestInfo | URL) => {
      const requestUrl = new URL(String(url));
      if (requestUrl.pathname.endsWith("/freeBusy")) return makeFreebusyResponse("calendar-a@example.invalid", []);
      if (requestUrl.searchParams.has("pageToken")) return new Response(null, { status: 503 });
      return Response.json({ items: [], nextPageToken: "second" });
    }) as typeof fetch;

    await expect(fetchGoogleBusyIntervals({ ...googleInput(), fetcher: partialFetcher })).resolves.toEqual({
      ok: false, reason: "fail_closed", errorClass: "events_api_failed"
    });
    await expect(fetchGoogleBusyIntervals({
      ...googleInput(), fetcher: createMockFetcher(makeEventsListResponse([]), makeFreebusyResponse("calendar-a@example.invalid", []))
    })).resolves.toEqual({ ok: true, busyIntervals: [] });
  });

  it("fails closed after bounded pagination rather than caching a truncated result", async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL) => String(url).includes("/freeBusy")
      ? makeFreebusyResponse("calendar-a@example.invalid", [])
      : Response.json({ items: [], nextPageToken: "still_more" })) as typeof fetch;

    await expect(fetchGoogleBusyIntervals({ ...googleInput(), fetcher })).resolves.toEqual({
      ok: false, reason: "fail_closed", errorClass: "events_pagination_limit"
    });
    expect(vi.mocked(fetcher).mock.calls.length).toBeLessThanOrEqual(12);
  });

  it("fails closed when FreeBusy fails despite a valid events response", async () => {
    await expect(fetchGoogleBusyIntervals({
      ...googleInput(), fetcher: createMockFetcher(makeEventsListResponse([]), "error")
    })).resolves.toEqual({ ok: false, reason: "fail_closed", errorClass: "freebusy_api_failed" });
  });

  it("accepts an identified empty events collection with omitted items", async () => {
    await expect(fetchGoogleBusyIntervals({
      ...googleInput(), fetcher: createMockFetcher(Response.json({ kind: "calendar#events" }), makeFreebusyResponse("calendar-a@example.invalid", []))
    })).resolves.toEqual({ ok: true, busyIntervals: [] });
  });

  it.each([
    { items: [null] },
    { items: [{ start: { dateTime: "2026-06-01T01:00:00Z" } }] },
    { items: [{ start: { dateTime: "invalid" }, end: { dateTime: "2026-06-01T02:00:00Z" } }] },
    { items: [], nextPageToken: 1 },
    {}
  ])("fails closed for incomplete events data %j", async (payload) => {
    await expect(fetchGoogleBusyIntervals({
      ...googleInput(), fetcher: createMockFetcher(Response.json(payload), makeFreebusyResponse("calendar-a@example.invalid", []))
    })).resolves.toEqual({ ok: false, reason: "fail_closed", errorClass: "events_api_parse_failed" });
  });

  it.each([
    {},
    { start: { dateTime: "2026-06-01T01:00:00Z" } },
    { start: { dateTime: "invalid" }, end: { dateTime: "2026-06-01T02:00:00Z" } },
    { start: { dateTime: 1 }, end: { dateTime: "2026-06-01T02:00:00Z" } },
    { start: { dateTime: "2026-06-01T02:00:00Z" }, end: { dateTime: "2026-06-01T01:00:00Z" } },
    { start: { date: "2026-02-30" }, end: { date: "2026-03-02" } }
  ])("rejects malformed transparent boundaries without caching a free window: %j", async (boundaries) => {
    await expect(fetchGoogleBusyIntervals({
      ...googleInput(), fetcher: createMockFetcher(makeEventsListResponse([{
        id: "transparent_personal", status: "confirmed", transparency: "transparent", ...boundaries
      }]), makeFreebusyResponse("calendar-a@example.invalid", []))
    })).resolves.toEqual({ ok: false, reason: "fail_closed", errorClass: "events_api_parse_failed" });

    await expect(fetchGoogleBusyIntervals({
      ...googleInput(), fetcher: createMockFetcher(makeEventsListResponse([{
        start: { dateTime: "2026-06-01T01:00:00Z" }, end: { dateTime: "2026-06-01T02:00:00Z" }
      }]), makeFreebusyResponse("calendar-a@example.invalid", []))
    })).resolves.toEqual({ ok: true, busyIntervals: [{
      startUtc: "2026-06-01T01:00:00Z", endUtc: "2026-06-01T02:00:00Z", classification: "opaque"
    }] });
  });

  it("accepts cancelled tombstones without event boundaries", async () => {
    await expect(fetchGoogleBusyIntervals({
      ...googleInput(), fetcher: createMockFetcher(makeEventsListResponse([{
        id: "deleted_event", status: "cancelled"
      }]), makeFreebusyResponse("calendar-a@example.invalid", []))
    })).resolves.toEqual({ ok: true, busyIntervals: [] });
  });

  it("does not use FreeBusy data that reports a per-calendar error", async () => {
    await expect(fetchGoogleBusyIntervals({
      ...googleInput(), fetcher: createMockFetcher(makeEventsListResponse([]), Response.json({
        calendars: { "calendar-a@example.invalid": { busy: [], errors: [{ reason: "internalError" }] } }
      }))
    })).resolves.toEqual({ ok: false, reason: "fail_closed", errorClass: "freebusy_api_parse_failed" });
  });

  it("reports a combined failure when events JSON is malformed and FreeBusy is unavailable", async () => {
    await expect(fetchGoogleBusyIntervals({
      ...googleInput(), fetcher: createMockFetcher(new Response("{"), "error")
    })).resolves.toEqual({ ok: false, reason: "fail_closed", errorClass: "both_api_failed" });
  });

  it.each(["headers", "body"])("keeps the Google deadline through stalled %s", async (stage) => {
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => nativeTimeout(milliseconds === 10_000 ? 200 : 20));
    const fetcher = ((url, init) => {
      if (String(url).includes("/freeBusy")) return Promise.resolve(makeFreebusyResponse("calendar-a@example.invalid", []));
      if (stage === "headers") return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
      return Promise.resolve(new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"items":'));
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
        }
      })));
    }) as typeof fetch;

    await expect(fetchGoogleBusyIntervals({ ...googleInput(), fetcher })).resolves.toEqual({
      ok: false, reason: "fail_closed", errorClass: "events_api_failed"
    });
  }, 1_000);

  it("recovers a transient events body timeout within the shared deadline", async () => {
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => nativeTimeout(milliseconds === 10_000 ? 200 : 20));
    let eventsAttempts = 0;
    const fetcher = (async (url, init) => {
      if (String(url).includes("/freeBusy")) return makeFreebusyResponse("calendar-a@example.invalid", []);
      if (++eventsAttempts > 1) return makeEventsListResponse([]);
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"items":'));
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
        }
      }));
    }) as typeof fetch;

    await expect(fetchGoogleBusyIntervals({ ...googleInput(), fetcher })).resolves.toEqual({ ok: true, busyIntervals: [] });
    expect(eventsAttempts).toBe(2);
  }, 1_000);

  it("does not contact Google for an already aborted caller", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = createMockFetcher(makeEventsListResponse([]), makeFreebusyResponse("calendar-a@example.invalid", []));

    await expect(fetchGoogleBusyIntervals({ ...googleInput(), fetcher, signal: controller.signal })).resolves.toEqual({
      ok: false, reason: "fail_closed", errorClass: "aborted"
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["reservation_id", "external_block_id"])("blocks transparent system events marked only by %s", async (marker) => {
    await expect(fetchGoogleBusyIntervals({
      ...googleInput(), fetcher: createMockFetcher(makeEventsListResponse([{
        transparency: "transparent",
        extendedProperties: { private: { [marker]: "system_owner" } },
        start: { dateTime: "2026-06-01T01:00:00Z" },
        end: { dateTime: "2026-06-01T02:00:00Z" }
      }]), makeFreebusyResponse("calendar-a@example.invalid", []))
    })).resolves.toEqual({ ok: true, busyIntervals: [{
      startUtc: "2026-06-01T01:00:00Z", endUtc: "2026-06-01T02:00:00Z", classification: "conflict"
    }] });
  });

  it("preserves caller cancellation during an events body read and does not cache it", async () => {
    const controller = new AbortController();
    let bodyStarted = () => {};
    const started = new Promise<void>((resolve) => { bodyStarted = resolve; });
    const fetcher = (async (url, init) => String(url).includes("/freeBusy")
      ? makeFreebusyResponse("calendar-a@example.invalid", [])
      : new Response(new ReadableStream({
        start(stream) {
          stream.enqueue(new TextEncoder().encode('{"items":'));
          init?.signal?.addEventListener("abort", () => stream.error(init.signal?.reason), { once: true });
          bodyStarted();
        }
      }))) as typeof fetch;
    const result = fetchGoogleBusyIntervals({ ...googleInput(), fetcher, signal: controller.signal });
    await started;
    controller.abort();

    await expect(result).resolves.toEqual({ ok: false, reason: "fail_closed", errorClass: "aborted" });
    await expect(fetchGoogleBusyIntervals({
      ...googleInput(), fetcher: createMockFetcher(makeEventsListResponse([]), makeFreebusyResponse("calendar-a@example.invalid", []))
    })).resolves.toEqual({ ok: true, busyIntervals: [] });
  }, 1_000);

  it("bounds the combined time across successful events pages", async () => {
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => nativeTimeout(milliseconds === 10_000 ? 50 : 200));
    const fetcher = ((url, init) => {
      if (String(url).includes("/freeBusy")) return Promise.resolve(makeFreebusyResponse("calendar-a@example.invalid", []));
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(Response.json({ items: [], nextPageToken: "more" })), 30);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(init.signal?.reason);
        }, { once: true });
      });
    }) as typeof fetch;

    await expect(fetchGoogleBusyIntervals({ ...googleInput(), fetcher })).resolves.toEqual({
      ok: false, reason: "fail_closed", errorClass: "deadline_exceeded"
    });
  }, 1_000);

  it("bounds token acquisition before any calendar request", async () => {
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => nativeTimeout(20));
    const fetcher = createMockFetcher(makeEventsListResponse([]), makeFreebusyResponse("calendar-a@example.invalid", []));

    await expect(fetchGoogleBusyIntervals({
      ...googleInput(), fetcher, accessTokenProvider: () => new Promise(() => {})
    })).resolves.toEqual({ ok: false, reason: "fail_closed", errorClass: "deadline_exceeded" });
    expect(fetcher).not.toHaveBeenCalled();
  }, 1_000);

  it("removes slots that overlap a Google opaque busy event (import-before scenario)", async () => {
    // Google reports a busy event at 10:00-11:00 JST (01:00-02:00 UTC)
    const fetcher = createMockFetcher(
      makeEventsListResponse([
        {
          id: "google_event_1",
          status: "confirmed",
          transparency: "opaque",
          start: { dateTime: "2026-06-01T01:00:00Z" },
          end: { dateTime: "2026-06-01T02:00:00Z" }
        }
      ]),
      makeFreebusyResponse("calendar-a@example.invalid", [
        { start: "2026-06-01T01:00:00Z", end: "2026-06-01T02:00:00Z" }
      ])
    );

    const result = await listPublicAvailability(
      availabilityInput(d1, ENABLED_ENV, { fetcher, accessTokenProvider: mockAccessTokenProvider })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // No slot should start within the 01:00-02:00 UTC busy window
    const busyStartMs = Date.parse("2026-06-01T01:00:00Z");
    const busyEndMs = Date.parse("2026-06-01T02:00:00Z");
    for (const slot of result.slots) {
      const slotStart = Date.parse(slot.startAt);
      const slotEnd = Date.parse(slot.endAt);
      // A slot that overlaps the busy interval should not exist
      const overlaps = slotStart < busyEndMs && slotEnd > busyStartMs;
      expect(overlaps).toBe(false);
    }
    // But there should still be some available slots outside the busy window
    expect(result.slots.length).toBeGreaterThan(0);
  });

  it("blocks the trailing 5-minute bucket of an unaligned Google busy interval", async () => {
    const fetcher = createMockFetcher(
      makeEventsListResponse([
        {
          id: "google_event_unaligned_tail",
          status: "confirmed",
          transparency: "opaque",
          start: { dateTime: "2026-06-01T01:11:00Z" },
          end: { dateTime: "2026-06-01T01:16:00Z" }
        }
      ]),
      makeFreebusyResponse("calendar-a@example.invalid", [])
    );

    const result = await listPublicAvailability(
      availabilityInput(d1, ENABLED_ENV, { fetcher, accessTokenProvider: mockAccessTokenProvider })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slots.some((slot) => slot.startAt === "2026-06-01T01:15:00.000Z")).toBe(false);
    expect(result.slots.some((slot) => slot.startAt === "2026-06-01T01:30:00.000Z")).toBe(true);
  });

  it("returns zero slots (fail-closed) when Google API returns errors", async () => {
    const fetcher = createMockFetcher("error", "error");

    const result = await listPublicAvailability(
      availabilityInput(d1, ENABLED_ENV, { fetcher, accessTokenProvider: mockAccessTokenProvider })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slots).toEqual([]);
  });

  it("fails closed and does not cache when both Google responses contain malformed JSON", async () => {
    const malformedFetcher = createMockFetcher(
      new Response("{", { headers: { "Content-Type": "application/json" } }),
      new Response("{", { headers: { "Content-Type": "application/json" } })
    );
    const input = {
      env: ENABLED_ENV,
      storeId: "kyoto",
      calendarId: "calendar-a@example.invalid",
      rangeStartUtc: "2026-05-31T15:00:00.000Z",
      rangeEndUtc: "2026-06-01T15:00:00.000Z",
      accessTokenProvider: mockAccessTokenProvider,
      now: () => NOW_MS
    };

    const malformed = await fetchGoogleBusyIntervals({ ...input, fetcher: malformedFetcher });
    expect(malformed).toEqual({
      ok: false,
      reason: "fail_closed",
      errorClass: "both_api_parse_failed"
    });

    const validFetcher = createMockFetcher(
      makeEventsListResponse([]),
      makeFreebusyResponse("calendar-a@example.invalid", [])
    );
    const retry = await fetchGoogleBusyIntervals({ ...input, fetcher: validFetcher });
    expect(retry).toEqual({ ok: true, busyIntervals: [] });
    expect(validFetcher).toHaveBeenCalledTimes(2);
  });

  it("fails closed when events cannot be verified even if FreeBusy returns busy data", async () => {
    const fetcher = createMockFetcher(
      new Response("{", { headers: { "Content-Type": "application/json" } }),
      makeFreebusyResponse("calendar-a@example.invalid", [
        { start: "2026-06-01T01:00:00.000Z", end: "2026-06-01T02:00:00.000Z" }
      ])
    );

    const result = await fetchGoogleBusyIntervals({
      env: ENABLED_ENV,
      storeId: "kyoto",
      calendarId: "calendar-a@example.invalid",
      rangeStartUtc: "2026-05-31T15:00:00.000Z",
      rangeEndUtc: "2026-06-01T15:00:00.000Z",
      fetcher,
      accessTokenProvider: mockAccessTokenProvider,
      now: () => NOW_MS
    });

    expect(result).toEqual({ ok: false, reason: "fail_closed", errorClass: "events_api_parse_failed" });
  });

  it("serves cached free results within TTL after Google API error", async () => {
    // First call: Google returns empty (free)
    const freeFetcher = createMockFetcher(
      makeEventsListResponse([]),
      makeFreebusyResponse("calendar-a@example.invalid", [])
    );

    const freeResult = await listPublicAvailability(
      availabilityInput(d1, ENABLED_ENV, { fetcher: freeFetcher, accessTokenProvider: mockAccessTokenProvider })
    );
    expect(freeResult.ok).toBe(true);
    if (!freeResult.ok) return;
    const freeSlotCount = freeResult.slots.length;
    expect(freeSlotCount).toBeGreaterThan(0);

    // Second call: Google API fails -- should still return cached free within TTL
    const errorFetcher = createMockFetcher("error", "error");

    const errorResult = await listPublicAvailability(
      availabilityInput(d1, ENABLED_ENV, { fetcher: errorFetcher, accessTokenProvider: mockAccessTokenProvider })
    );
    expect((errorFetcher as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect(errorResult.ok).toBe(true);
    if (!errorResult.ok) return;
    expect(errorResult.slots).toHaveLength(freeSlotCount);
  });

  it("reuses cached busy results within TTL window (safe-side)", async () => {
    // First call: Google returns busy
    const busyFetcher = createMockFetcher(
      makeEventsListResponse([
        {
          id: "event_busy",
          status: "confirmed",
          transparency: "opaque",
          start: { dateTime: "2026-06-01T01:00:00Z" },
          end: { dateTime: "2026-06-01T02:00:00Z" }
        }
      ]),
      makeFreebusyResponse("calendar-a@example.invalid", [
        { start: "2026-06-01T01:00:00Z", end: "2026-06-01T02:00:00Z" }
      ])
    );

    await listPublicAvailability(
      availabilityInput(d1, ENABLED_ENV, { fetcher: busyFetcher, accessTokenProvider: mockAccessTokenProvider })
    );

    // Second call with an error fetcher should still use cached busy intervals
    // (since busy intervals are cached and safe-side)
    const errorFetcher = createMockFetcher("error", "error");

    const result = await listPublicAvailability(
      availabilityInput(d1, ENABLED_ENV, { fetcher: errorFetcher, accessTokenProvider: mockAccessTokenProvider })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Busy slots should still be removed
    const busyStartMs = Date.parse("2026-06-01T01:00:00Z");
    const busyEndMs = Date.parse("2026-06-01T02:00:00Z");
    for (const slot of result.slots) {
      const overlaps = Date.parse(slot.startAt) < busyEndMs && Date.parse(slot.endAt) > busyStartMs;
      expect(overlaps).toBe(false);
    }
  });

  it("fails closed when stores.google_calendar_id IS NULL", async () => {
    // Set kyoto's google_calendar_id to NULL
    d1.sqlite.exec("UPDATE stores SET google_calendar_id = NULL WHERE id = 'kyoto'");

    const fetcher = createMockFetcher(
      makeEventsListResponse([]),
      makeFreebusyResponse("calendar-a@example.invalid", [])
    );

    const result = await listPublicAvailability(
      availabilityInput(d1, ENABLED_ENV, { fetcher, accessTokenProvider: mockAccessTokenProvider })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slots).toEqual([]);
  });

  it("preserves existing D1-only behavior when flag is disabled", async () => {
    const result = await listPublicAvailability(
      availabilityInput(d1, DISABLED_ENV)
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Should have slots (D1 is clean, no slot_locks)
    expect(result.slots.length).toBeGreaterThan(0);
  });

  it("skips transparent events without system marker (not busy)", async () => {
    const fetcher = createMockFetcher(
      makeEventsListResponse([
        {
          id: "transparent_personal",
          status: "confirmed",
          transparency: "transparent",
          start: { dateTime: "2026-06-01T01:00:00Z" },
          end: { dateTime: "2026-06-01T02:00:00Z" }
          // No extendedProperties.private.owner_type
        }
      ]),
      makeFreebusyResponse("calendar-a@example.invalid", [])
    );

    const result = await listPublicAvailability(
      availabilityInput(d1, ENABLED_ENV, { fetcher, accessTokenProvider: mockAccessTokenProvider })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Transparent event without marker should NOT block slots
    const busyWindow = { start: Date.parse("2026-06-01T01:00:00Z"), end: Date.parse("2026-06-01T02:00:00Z") };
    const overlappingSlots = result.slots.filter((slot) => {
      const s = Date.parse(slot.startAt);
      const e = Date.parse(slot.endAt);
      return s < busyWindow.end && e > busyWindow.start;
    });
    expect(overlappingSlots.length).toBeGreaterThan(0);
  });

  it("treats transparent event with system marker (owner_type) as busy conflict", async () => {
    const fetcher = createMockFetcher(
      makeEventsListResponse([
        {
          id: "system_transparent",
          status: "confirmed",
          transparency: "transparent",
          start: { dateTime: "2026-06-01T01:00:00Z" },
          end: { dateTime: "2026-06-01T02:00:00Z" },
          extendedProperties: {
            private: {
              owner_type: "reservation"
            }
          }
        }
      ]),
      makeFreebusyResponse("calendar-a@example.invalid", [])
    );

    const result = await listPublicAvailability(
      availabilityInput(d1, ENABLED_ENV, { fetcher, accessTokenProvider: mockAccessTokenProvider })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // System transparent event should block slots
    const busyWindow = { start: Date.parse("2026-06-01T01:00:00Z"), end: Date.parse("2026-06-01T02:00:00Z") };
    for (const slot of result.slots) {
      const overlaps = Date.parse(slot.startAt) < busyWindow.end && Date.parse(slot.endAt) > busyWindow.start;
      expect(overlaps).toBe(false);
    }
  });

  it("blocks all business-hour slots for an all-day event", async () => {
    const fetcher = createMockFetcher(
      makeEventsListResponse([
        {
          id: "all_day_event",
          status: "confirmed",
          start: { date: "2026-06-01" },
          end: { date: "2026-06-02" }
        }
      ]),
      makeFreebusyResponse("calendar-a@example.invalid", [])
    );

    const result = await listPublicAvailability(
      availabilityInput(d1, ENABLED_ENV, { fetcher, accessTokenProvider: mockAccessTokenProvider })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slots).toEqual([]);
  });

  it("interprets Google all-day start and exclusive end dates at JST midnight", async () => {
    const fetcher = createMockFetcher(
      makeEventsListResponse([
        {
          id: "all_day_event_jst_boundary",
          status: "confirmed",
          start: { date: "2026-06-01" },
          end: { date: "2026-06-02" }
        }
      ]),
      makeFreebusyResponse("calendar-a@example.invalid", [])
    );

    const result = await fetchGoogleBusyIntervals({
      env: ENABLED_ENV,
      storeId: "kyoto",
      calendarId: "calendar-a@example.invalid",
      rangeStartUtc: "2026-05-31T15:00:00.000Z",
      rangeEndUtc: "2026-06-01T15:00:00.000Z",
      fetcher,
      accessTokenProvider: mockAccessTokenProvider,
      now: () => NOW_MS
    });

    expect(result).toEqual({
      ok: true,
      busyIntervals: [
        {
          startUtc: "2026-05-31T15:00:00.000Z",
          endUtc: "2026-06-01T15:00:00.000Z",
          classification: "all_day_block"
        }
      ]
    });
  });

  it("blocks slots for recurring event occurrences (singleEvents=true expansion)", async () => {
    const fetcher = createMockFetcher(
      makeEventsListResponse([
        {
          id: "recurring_instance_1",
          recurringEventId: "recurring_master",
          status: "confirmed",
          start: { dateTime: "2026-06-01T01:00:00Z" },
          end: { dateTime: "2026-06-01T02:00:00Z" }
        }
      ]),
      makeFreebusyResponse("calendar-a@example.invalid", [
        { start: "2026-06-01T01:00:00Z", end: "2026-06-01T02:00:00Z" }
      ])
    );

    const result = await listPublicAvailability(
      availabilityInput(d1, ENABLED_ENV, { fetcher, accessTokenProvider: mockAccessTokenProvider })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const busyWindow = { start: Date.parse("2026-06-01T01:00:00Z"), end: Date.parse("2026-06-01T02:00:00Z") };
    for (const slot of result.slots) {
      const overlaps = Date.parse(slot.startAt) < busyWindow.end && Date.parse(slot.endAt) > busyWindow.start;
      expect(overlaps).toBe(false);
    }
    expect(result.slots.length).toBeGreaterThan(0);
  });

  it("recurring all-day event blocks the whole business window (fail-closed busy)", async () => {
    const fetcher = createMockFetcher(
      makeEventsListResponse([
        {
          id: "recurring_allday_instance",
          recurringEventId: "r-1",
          status: "confirmed",
          start: { date: "2026-06-01" },
          end: { date: "2026-06-02" }
          // No start.dateTime — this is the bug scenario
        }
      ]),
      makeFreebusyResponse("calendar-a@example.invalid", [])
    );

    const result = await listPublicAvailability(
      availabilityInput(d1, ENABLED_ENV, { fetcher, accessTokenProvider: mockAccessTokenProvider })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Recurring all-day must block all slots (fail-closed per SPEC S9)
    expect(result.slots).toEqual([]);
  });

  it("treats opaque event without reservation linkage as busy", async () => {
    const fetcher = createMockFetcher(
      makeEventsListResponse([
        {
          id: "opaque_no_link",
          status: "confirmed",
          // No transparency field = opaque default
          start: { dateTime: "2026-06-01T03:00:00Z" },
          end: { dateTime: "2026-06-01T04:00:00Z" }
        }
      ]),
      makeFreebusyResponse("calendar-a@example.invalid", [
        { start: "2026-06-01T03:00:00Z", end: "2026-06-01T04:00:00Z" }
      ])
    );

    const result = await listPublicAvailability(
      availabilityInput(d1, ENABLED_ENV, { fetcher, accessTokenProvider: mockAccessTokenProvider })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const busyWindow = { start: Date.parse("2026-06-01T03:00:00Z"), end: Date.parse("2026-06-01T04:00:00Z") };
    for (const slot of result.slots) {
      const overlaps = Date.parse(slot.startAt) < busyWindow.end && Date.parse(slot.endAt) > busyWindow.start;
      expect(overlaps).toBe(false);
    }
  });

  it("ignores an expired (TTL-lapsed) pending slot_lock but still blocks a confirmed NULL-TTL lock", async () => {
    const insertLock = (id: string, slotAt: string, lockStatus: string, expiresAt: string | null) =>
      d1
        .prepare(
          `INSERT INTO slot_locks (id, store_id, resource_id, slot_at, owner_type, owner_id, lock_status, expires_at)
           VALUES (?, 'kyoto', 'resource_kyoto_calendar', ?, 'reservation', ?, ?, ?)`,
        )
        .bind(id, slotAt, id, lockStatus, expiresAt)
        .run();

    // Confirmed lock (permanent, expires_at = NULL) must keep blocking 10:00 JST = 01:00 UTC.
    await insertLock("lock_confirmed", "2026-06-01T01:00:00.000Z", "confirmed", null);
    // Pending lock whose TTL already lapsed before NOW must NOT block 11:00 JST = 02:00 UTC —
    // availability self-heals even if the out-of-band expiry sweep stranded the lock.
    await insertLock("lock_expired", "2026-06-01T02:00:00.000Z", "pending", "2026-05-09T22:00:00.000Z");

    const result = await listPublicAvailability(availabilityInput(d1, DISABLED_ENV));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const starts = new Set(result.slots.map((s) => s.startAt));
    expect(starts.has("2026-06-01T01:00:00.000Z")).toBe(false); // confirmed NULL-TTL lock still blocks
    expect(starts.has("2026-06-01T02:00:00.000Z")).toBe(true); // expired pending lock is ignored
  });

  it("keeps a confirmed slot_lock busy even when its expires_at is in the past", async () => {
    // Defensive: confirmed locks normally use expires_at=NULL, but a non-NULL past value
    // (data anomaly) must STILL block — only stranded expired PENDING locks are ignored.
    d1.sqlite
      .prepare(
        `INSERT INTO slot_locks (id, store_id, resource_id, slot_at, owner_type, owner_id, lock_status, expires_at)
         VALUES ('lock_confirmed_past', 'kyoto', 'resource_kyoto_calendar', '2026-06-01T01:00:00.000Z', 'reservation', 'owner_confirmed_past', 'confirmed', '2023-01-01T00:00:00.000Z')`,
      )
      .run();

    const result = await listPublicAvailability(availabilityInput(d1, DISABLED_ENV));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const starts = new Set(result.slots.map((s) => s.startAt));
    expect(starts.has("2026-06-01T01:00:00.000Z")).toBe(false); // confirmed lock blocks despite a past expires_at
  });
});
