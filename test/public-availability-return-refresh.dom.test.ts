import { readFileSync } from "node:fs";
import { join } from "node:path";

import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

// Behavioural test for the on-return availability refresh: returning to the page
// fires BOTH visibilitychange and focus, and the pair must coalesce into exactly
// one availability fetch (a second concurrent start bumps availabilityRequestId
// and discards the first, still-valid response). Quick alt-tabs (data fresher
// than one poll interval) must not fetch at all.

const OPTIONS_BODY = {
  ok: true,
  stores: [{ id: "st1", name: "本店", timezone: "Asia/Tokyo" }],
  services: [{ id: "s1", storeId: "st1", name: "カット｜カット", durationMinutes: 60 }],
  resources: [{ id: "r1", storeId: "st1", name: "枠1" }],
  consentVersions: { notice: "1", cancellationPolicy: "1", privacyPolicy: "1", minorGuardian: "1" },
  liffId: "liff-1"
};

const AVAILABILITY_BODY = { ok: true, timezone: "Asia/Tokyo", slots: [] };

const jsonResponse = (body: unknown) => ({
  ok: true,
  headers: { get: () => "application/json" },
  json: async () => body
});

let dom: JSDOM;

afterEach(() => {
  dom?.window.close();
  vi.restoreAllMocks();
});

const setup = async () => {
  const html = readFileSync(join(process.cwd(), "public/index.html"), "utf8");
  const appJs = readFileSync(join(process.cwd(), "public/app.js"), "utf8");
  dom = new JSDOM(html, { runScripts: "outside-only", url: "https://example.com/", pretendToBeVisual: true });
  const { window } = dom;
  const win = window as unknown as Record<string, unknown> & { crypto?: { randomUUID?: () => string } };
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  win.scrollTo = () => {};
  const availabilityCalls = { count: 0 };
  const failure = { next: false };
  const hang = { next: false, release: null as (() => void) | null };
  win.fetch = vi.fn((input: unknown) => {
    const url = String(input);
    if (url.includes("/api/public/reservation-options")) return Promise.resolve(jsonResponse(OPTIONS_BODY));
    if (url.includes("/api/public/availability")) {
      availabilityCalls.count += 1;
      if (failure.next) {
        failure.next = false;
        return Promise.resolve(jsonResponse({ ok: false }));
      }
      if (hang.next) {
        hang.next = false;
        return new Promise((resolve) => {
          hang.release = () => resolve(jsonResponse(AVAILABILITY_BODY));
        });
      }
      return Promise.resolve(jsonResponse(AVAILABILITY_BODY));
    }
    return Promise.resolve(jsonResponse({ ok: true }));
  });
  if (!win.crypto?.randomUUID) {
    win.crypto = {
      randomUUID: () => `uuid-${Math.random().toString(16).slice(2)}`,
      getRandomValues: (arr: Uint32Array) => arr.map(() => Math.floor(Math.random() * 0xffffffff))
    } as Crypto;
  }
  window.eval(appJs);
  await vi.waitFor(() => {
    if ((window.document.getElementById("store") as unknown as HTMLSelectElement).options.length === 0) {
      throw new Error("options not loaded yet");
    }
  });
  return { window, availabilityCalls, failure, hang };
};

const completeBookingInputs = async (window: JSDOM["window"]) => {
  const doc = window.document;
  const store = doc.getElementById("store") as unknown as HTMLSelectElement;
  store.value = "st1";
  store.dispatchEvent(new window.Event("change", { bubbles: true }));
  const service = doc.querySelector('input[name="serviceIds"]') as unknown as HTMLInputElement;
  service.checked = true;
  service.dispatchEvent(new window.Event("change", { bubbles: true }));
  const resource = doc.getElementById("resource") as unknown as HTMLSelectElement;
  resource.value = "r1";
  resource.dispatchEvent(new window.Event("change", { bubbles: true }));
  const date = doc.getElementById("date") as unknown as HTMLInputElement;
  date.value = isoDatePlus(7);
  date.dispatchEvent(new window.Event("change", { bubbles: true }));
  // requestAvailabilityUpdate debounces 120ms; let the initial fetches settle.
  await new Promise((resolve) => setTimeout(resolve, 300));
};

const dispatchReturn = (window: JSDOM["window"]) => {
  window.document.dispatchEvent(new window.Event("visibilitychange"));
  window.dispatchEvent(new window.Event("focus"));
};

// The date <select> only offers today..today+bookingWindowDays (real clock), so a
// hardcoded fixture date silently falls out of the dropdown once real time passes
// it (value becomes "" → zero availability fetches; this bit us on 2026-07-11).
// Always pick a date relative to the real clock, well inside the 30-day window.
const isoDatePlus = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

describe("public reservation — on-return availability refresh", () => {
  it("coalesces visibilitychange+focus into one fetch, and skips fresh data", async () => {
    const { window, availabilityCalls } = await setup();
    await completeBookingInputs(window);
    const settled = availabilityCalls.count;
    expect(settled).toBeGreaterThan(0);

    const realNow = Date.now();
    let fakeNow = realNow;
    const winDate = (window as unknown as { Date: DateConstructor }).Date;
    vi.spyOn(winDate, "now").mockImplementation(() => fakeNow);

    // Fresh data (< poll interval): a return must not fetch at all.
    dispatchReturn(window);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(availabilityCalls.count).toBe(settled);

    // Stale data (>= poll interval): the visibilitychange+focus pair → exactly ONE fetch.
    fakeNow = realNow + 31_000;
    dispatchReturn(window);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(availabilityCalls.count).toBe(settled + 1);

    // Immediate re-fire within the coalesce window adds nothing.
    fakeNow = realNow + 31_500;
    dispatchReturn(window);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(availabilityCalls.count).toBe(settled + 1);
  });

  it("refetches on return after a failed fetch even when the last success is recent", async () => {
    const { window, availabilityCalls, failure } = await setup();
    await completeBookingInputs(window);
    const settled = availabilityCalls.count;

    const realNow = Date.now();
    let fakeNow = realNow;
    const winDate = (window as unknown as { Date: DateConstructor }).Date;
    vi.spyOn(winDate, "now").mockImplementation(() => fakeNow);

    // A manual refresh 5s after the last success fails → error state, but
    // availabilityLoadedAt still points at the recent success.
    failure.next = true;
    fakeNow = realNow + 5_000;
    window.document.getElementById("refresh-slots")?.dispatchEvent(new window.Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(availabilityCalls.count).toBe(settled + 1);

    // Returning 2s later: the freshness gate would normally block (< 30s since
    // the last SUCCESS), but a failed state must not linger — it refetches.
    fakeNow = realNow + 7_000;
    dispatchReturn(window);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(availabilityCalls.count).toBe(settled + 2);
  });

  it("never starts a second fetch behind a slow in-flight one, even past the coalesce window", async () => {
    const { window, availabilityCalls, hang } = await setup();
    await completeBookingInputs(window);
    const settled = availabilityCalls.count;

    const realNow = Date.now();
    let fakeNow = realNow;
    const winDate = (window as unknown as { Date: DateConstructor }).Date;
    vi.spyOn(winDate, "now").mockImplementation(() => fakeNow);

    // Stale return starts a fetch that hangs (slow network).
    hang.next = true;
    fakeNow = realNow + 31_000;
    dispatchReturn(window);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(availabilityCalls.count).toBe(settled + 1);

    // 2s later (beyond the 1s coalesce window) the request is still unresolved:
    // a return event must NOT start a competing fetch — it would bump
    // availabilityRequestId and discard the first response.
    fakeNow = realNow + 33_000;
    dispatchReturn(window);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(availabilityCalls.count).toBe(settled + 1);

    // Once the slow response lands it still applies (nothing superseded it).
    hang.release?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(availabilityCalls.count).toBe(settled + 1);
  });

  it("defers to a pending input-change debounce instead of racing it", async () => {
    const { window, availabilityCalls } = await setup();
    await completeBookingInputs(window);
    const settled = availabilityCalls.count;

    const realNow = Date.now();
    let fakeNow = realNow + 31_000;
    const winDate = (window as unknown as { Date: DateConstructor }).Date;
    vi.spyOn(winDate, "now").mockImplementation(() => fakeNow);

    // An input change (e.g. date committed on tab-away) schedules the 120ms
    // debounced fetch; the return event lands while it is still pending.
    const date = window.document.getElementById("date") as unknown as HTMLInputElement;
    date.value = isoDatePlus(8);
    date.dispatchEvent(new window.Event("change", { bubbles: true }));
    dispatchReturn(window);

    // Only the debounced fetch runs — the return refresh must not race it.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(availabilityCalls.count).toBe(settled + 1);
  });
});
