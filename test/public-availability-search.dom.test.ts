import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const options = {
  ok: true,
  stores: [{ id: "st1", name: "本店", timezone: "Asia/Tokyo", bookingWindowDays: 15 }],
  services: [{ id: "s1", storeId: "st1", name: "カット", durationMinutes: 60 }],
  resources: [{ id: "r1", storeId: "st1", name: "枠1" }, { id: "r2", storeId: "st1", name: "枠2" }],
  consentVersions: {}, liffId: "liff-1"
};
const json = (body: unknown, ok = true) => ({ ok, headers: { get: () => "application/json" }, json: async () => body });
const ready = (date: string, hasSlots = false) => ({
  ok: true, availabilityStatus: "ready", timezone: "Asia/Tokyo",
  slots: hasSlots ? [{ startAt: `${date}T01:00:00.000Z`, endAt: `${date}T02:00:00.000Z` }] : []
});
let dom: JSDOM;
let responder: (url: URL, signal: AbortSignal) => Promise<ReturnType<typeof json>>;
let requests: { date: string; signal: AbortSignal }[];
const element = <T = HTMLElement>(id: string) => dom.window.document.getElementById(id) as unknown as T;
const change = (id: string, value: string) => {
  element<HTMLSelectElement>(id).value = value;
  element(id).dispatchEvent(new dom.window.Event("change", { bubbles: true }));
};
const button = (id: string) => element<HTMLButtonElement>(id);
const dateAt = (index: number) => element<HTMLSelectElement>("date").options[index].value;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
  dom = new JSDOM(readFileSync("public/index.html", "utf8"), { runScripts: "outside-only", url: "https://example.com/", pretendToBeVisual: true });
  const win = dom.window as unknown as Record<string, unknown>;
  Object.assign(win, {
    Date, setTimeout, clearTimeout, setInterval, clearInterval,
    matchMedia: () => ({ matches: false }), scrollTo: () => {}
  });
  requests = [];
  responder = async (url) => json(ready(url.searchParams.get("date")!));
  win.fetch = vi.fn(async (input: string, init?: { signal?: AbortSignal }) => {
    const url = new URL(input, "https://example.com");
    if (url.pathname.endsWith("reservation-options")) return json(options);
    if (url.pathname.endsWith("availability")) {
      const signal = init?.signal as AbortSignal;
      requests.push({ date: url.searchParams.get("date")!, signal });
      return responder(url, signal);
    }
    return json({ ok: true });
  });
  dom.window.eval(readFileSync("public/app.js", "utf8"));
  await vi.advanceTimersByTimeAsync(0);
  const service = dom.window.document.querySelector<HTMLInputElement>("input[name='serviceIds']")!;
  service.checked = true;
  service.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await vi.advanceTimersByTimeAsync(121);
  requests = [];
});

afterEach(() => {
  dom?.window.close();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("availability context and bounded next-day search", () => {
  it("invalidates the previous response before the input debounce fires", async () => {
    let release!: (value: ReturnType<typeof json>) => void;
    const oldDate = element<HTMLSelectElement>("date").value;
    responder = () => new Promise((resolve) => { release = resolve; });
    button("refresh-slots").click();
    await vi.advanceTimersByTimeAsync(0);
    change("date", dateAt(1));
    release(json(ready(oldDate, true)));
    await vi.advanceTimersByTimeAsync(0);
    expect(dom.window.document.querySelectorAll(".slot-button")).toHaveLength(0);
    expect(requests[0].signal.aborted).toBe(true);
    expect(button("step1-next").disabled).toBe(true);
  });

  it("checks days sequentially, applies the first ready day, and leaves time selection explicit", async () => {
    responder = async (url) => json(ready(url.searchParams.get("date")!, url.searchParams.get("date") === dateAt(3)));
    button("find-next-date").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(requests.map((r) => r.date)).toEqual([dateAt(1), dateAt(2), dateAt(3)]);
    expect(element<HTMLSelectElement>("date").value).toBe(dateAt(3));
    expect(dom.window.document.querySelectorAll(".slot-button")).toHaveLength(1);
    expect(dom.window.document.activeElement?.classList.contains("slot-button")).toBe(true);
    expect(button("step1-next").disabled).toBe(true);
  });

  it("checks at most seven days per click and offers explicit continuation within the store window", async () => {
    button("find-next-date").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(requests.map((r) => r.date)).toEqual(Array.from({ length: 7 }, (_, i) => dateAt(i + 1)));
    expect(button("find-next-date").textContent).toContain("続き");
    await vi.advanceTimersByTimeAsync(31_000);
    dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
    dom.window.dispatchEvent(new dom.window.Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(7);
    button("find-next-date").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(14);
    button("find-next-date").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(15);
    expect(button("find-next-date").disabled).toBe(true);
    expect(element<HTMLSelectElement>("date").value).toBe(dateAt(0));
  });

  it.each([
    { ok: true, availabilityStatus: "unavailable", slots: [] },
    { ok: true, slots: [] },
    { ok: false, reason: "rate_limited" },
    { ok: true, availabilityStatus: "ready", slots: [{}] }
  ])("stops on unknown availability instead of skipping it: %j", async (body) => {
    responder = async () => json(body);
    button("find-next-date").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(1);
    expect(element("next-date-status").textContent).toContain("確認できませんでした");
    expect(element<HTMLSelectElement>("date").value).toBe(dateAt(0));
  });

  it("stops the whole search after 20 seconds and ignores a late response", async () => {
    let release!: (value: ReturnType<typeof json>) => void;
    responder = () => new Promise((resolve) => { release = resolve; });
    button("find-next-date").click();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(requests[0].signal.aborted).toBe(true);
    expect(button("cancel-date-search").hidden).toBe(true);
    expect(element("slots").getAttribute("aria-busy")).toBe("false");
    expect(element("next-date-status").textContent).toContain("時間がかかっています");
    release(json(ready(dateAt(1), true)));
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(1);
    expect(element<HTMLSelectElement>("date").value).toBe(dateAt(0));
    expect(dom.window.document.querySelectorAll(".slot-button")).toHaveLength(0);
  });

  it.each(["date", "resource", "store", "service", "cancel"])("aborts immediately on %s and never applies late search results", async (trigger) => {
    let release!: (value: ReturnType<typeof json>) => void;
    responder = () => new Promise((resolve) => { release = resolve; });
    button("find-next-date").click();
    await vi.advanceTimersByTimeAsync(0);
    if (trigger === "cancel") button("cancel-date-search").click();
    else if (trigger === "service") {
      const service = dom.window.document.querySelector<HTMLInputElement>("input[name='serviceIds']")!;
      service.checked = false;
      service.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    } else change(trigger, trigger === "date" ? dateAt(5) : trigger === "resource" ? "r2" : "st1");
    expect(element("slots").getAttribute("aria-busy")).toBe("false");
    release(json(ready(dateAt(1), true)));
    await vi.advanceTimersByTimeAsync(0);
    expect(requests[0].signal.aborted).toBe(true);
    expect(requests).toHaveLength(1);
    expect(element<HTMLSelectElement>("date").value).not.toBe(dateAt(1));
    expect(dom.window.document.querySelectorAll(".slot-button")).toHaveLength(0);
  });

  it("coalesces return events while searching and retries network failures explicitly", async () => {
    let reject!: (error: Error) => void;
    responder = () => new Promise((_, fail) => { reject = fail; });
    button("find-next-date").click();
    await vi.advanceTimersByTimeAsync(2_000);
    dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
    dom.window.dispatchEvent(new dom.window.Event("focus"));
    expect(requests).toHaveLength(1);
    reject(new Error("offline"));
    await vi.advanceTimersByTimeAsync(0);
    expect(button("find-next-date").disabled).toBe(false);
    expect(element("next-date-status").textContent).toContain("確認できませんでした");
  });
});
