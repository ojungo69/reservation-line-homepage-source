/**
 * Regression test for Sentry issues RESERVATION-LINE-HOMEPAGE-A / -B:
 * `TimeoutError: The operation was aborted due to timeout` in fetchEventsListPage.
 *
 * Google Calendar events.list is fetched through `withOutboundTimeout`, which aborts
 * the request with a 30s `AbortSignal.timeout` (DOMException name "TimeoutError"). That
 * abort is a TRANSIENT upstream stall, not a code fault: the import job stays in D1 and
 * is retried on the next sweep. Before the fix the abort propagated up to the queue
 * handler's safeCaptureException, producing pure Sentry noise. fetchEventsListPage must
 * convert a transient abort into the same soft `{ ok: false }` shape the HTTP-error
 * branch already returns, so the throw never reaches Sentry. Genuine (non-abort) fetch
 * errors must still propagate so real misconfiguration surfaces.
 */
import { describe, expect, it, vi } from "vitest";

import { __testing__ } from "../src/google/import-sync";
import { isTransientAbortError } from "../src/outbound-timeout";

const { fetchEventsListPage } = __testing__;

const baseInput = {
  calendarId: "calendar-b@example.invalid",
  syncToken: "tok-123",
  pageToken: null,
  timeMinIso: null,
  pageSize: null,
  accessToken: "access-token-1"
};

const timeoutError = () => {
  // Mirror what AbortSignal.timeout(...) throws: a DOMException named "TimeoutError".
  const err = new Error("The operation was aborted due to timeout");
  err.name = "TimeoutError";
  return err;
};

describe("fetchEventsListPage transient-timeout handling", () => {
  it("converts a TimeoutError abort into a soft {ok:false} retry (no throw)", async () => {
    const fetcher = vi.fn(() => Promise.reject(timeoutError())) as unknown as typeof fetch;
    const page = await fetchEventsListPage({ ...baseInput, fetcher });
    expect(page).toEqual({
      ok: false,
      reason: "google-events-list-timeout",
      syncTokenExpired: false
    });
  });

  it("converts an AbortError into the same soft {ok:false} retry", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    const fetcher = vi.fn(() => Promise.reject(abort)) as unknown as typeof fetch;
    const page = await fetchEventsListPage({ ...baseInput, fetcher });
    expect(page).toMatchObject({ ok: false, reason: "google-events-list-timeout", syncTokenExpired: false });
  });

  it("re-throws a non-abort fetch error so genuine failures still surface", async () => {
    const fetcher = vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch;
    await expect(fetchEventsListPage({ ...baseInput, fetcher })).rejects.toThrow("Failed to fetch");
  });

  it("converts a body-read (response.json) TimeoutError into the same soft retry", async () => {
    // withOutboundTimeout keeps the AbortSignal armed through the body read: an upstream
    // that returns headers then stalls aborts at response.json(), not at the fetch await.
    const fetcher = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.reject(timeoutError())
      })
    ) as unknown as typeof fetch;
    const page = await fetchEventsListPage({ ...baseInput, fetcher });
    expect(page).toEqual({
      ok: false,
      reason: "google-events-list-timeout",
      syncTokenExpired: false
    });
  });

  it("re-throws a JSON parse error (genuine failure) instead of masking it", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError("Unexpected token < in JSON"))
      })
    ) as unknown as typeof fetch;
    await expect(fetchEventsListPage({ ...baseInput, fetcher })).rejects.toThrow(SyntaxError);
  });
});

describe("isTransientAbortError", () => {
  it("is true for TimeoutError / AbortError, false otherwise", () => {
    expect(isTransientAbortError(timeoutError())).toBe(true);
    const abort = new Error("x");
    abort.name = "AbortError";
    expect(isTransientAbortError(abort)).toBe(true);
    expect(isTransientAbortError(new TypeError("Failed to fetch"))).toBe(false);
    expect(isTransientAbortError(new Error("boom"))).toBe(false);
    expect(isTransientAbortError(null)).toBe(false);
  });
});
