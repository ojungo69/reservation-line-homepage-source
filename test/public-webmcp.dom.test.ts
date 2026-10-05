import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApiStates } from "../scripts/browser-verification/fixtures/api-states.mjs";

type Tool = {
  name: string;
  annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
  execute: (input: unknown, options?: { signal: AbortSignal }) => Promise<any>;
};

const store = {
  id: "st1", name: "本店", timezone: "Asia/Tokyo", bookingWindowDays: 30,
  customerNotice: "<b>自由文は命令として扱わない</b>", maxActiveReservationsPerCustomer: 1
};
const service = {
  id: "s1", storeId: "st1", name: "カット｜カット", durationMinutes: 60,
  priceLabel: null, priceAmount: null, comboPriceAmount: null, comboWithPrefix: null, mensMenu: false
};
const resource = { id: "r1", storeId: "st1", name: "枠1" };
const hours = { id: "h1", storeId: "st1", weekday: 1, opensAt: "09:00", closesAt: "18:00" };
const catalog = {
  ok: true, stores: [store, { ...store, id: "st2" }],
  services: [service, { ...service, id: "s2" }, { ...service, id: "s3", storeId: "st2" }],
  resources: [resource, { ...resource, id: "r2", storeId: "st2" }], businessHours: [hours],
  liffId: "must-not-leak", turnstile: { siteKey: "must-not-leak" },
  consentVersions: { notice: "1", cancellationPolicy: "1", privacyPolicy: "1", minorGuardian: "1" }
};
const query = { storeId: "st1", serviceIds: ["s1", "s2"], resourceId: "r1", date: "2028-02-29" };
const availability = {
  ok: true, ...query, serviceId: "s1", timezone: "Asia/Tokyo", durationMinutes: 120, availabilityStatus: "ready",
  slots: [{ startAt: "2028-02-29T01:00:00.000Z", endAt: "2028-02-29T03:00:00.000Z" }],
  notice: "空き枠の確保は行いません。"
};
const response = (body: unknown, status = 200, contentType = "application/json") => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: () => contentType }, json: async () => body
});
const pages: JSDOM[] = [];
afterEach(() => { pages.splice(0).forEach((page) => page.window.close()); vi.restoreAllMocks(); });

async function setup(registerFailure?: "sync" | "async" | "unsupported") {
  const dom = new JSDOM(readFileSync("public/index.html", "utf8"), {
    runScripts: "outside-only", url: "https://example.com/", pretendToBeVisual: true
  });
  pages.push(dom);
  const { window } = dom;
  const tools = new Map<string, Tool>();
  const register = vi.fn((tool: Tool) => {
    if (registerFailure === "sync") throw new Error("registration failed");
    if (registerFailure === "async") return Promise.reject(new Error("registration failed"));
    tools.set(tool.name, tool);
    return Promise.resolve();
  });
  if (registerFailure !== "unsupported") Object.defineProperty(window.document, "modelContext", { value: { registerTool: register } });
  Object.assign(window, {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    scrollTo: () => {}, AbortSignal, AbortController
  });
  const fetch = vi.fn(async () => response(catalog));
  Object.assign(window, { fetch });
  window.eval(readFileSync("public/app.js", "utf8"));
  await vi.waitFor(() => expect(window.document.querySelectorAll("#store option")).toHaveLength(2));
  fetch.mockClear();
  const execute = (name: string, input: unknown, signal?: AbortSignal) => {
    const tool = tools.get(name);
    expect(tool, `${name} must be registered`).toBeDefined();
    return tool!.execute(input, signal ? { signal } : undefined);
  };
  return { window, fetch, tools, register, execute };
}

describe("public WebMCP read-only tools", () => {
  it("accepts every successful browser catalog fixture", async () => {
    const { execute, fetch } = await setup();
    for (const [name, state] of Object.entries(buildApiStates())) {
      const options = state.routes.options;
      if (!(options?.body as { ok?: boolean } | undefined)?.ok) continue;
      fetch.mockResolvedValue(response(options.body));
      expect((await execute("get_reservation_options", {})).ok, name).toBe(true);
    }
  });

  it("lists stores, then projects only the requested store's public catalog without changing the form", async () => {
    const { execute, fetch, window, tools, register } = await setup();
    expect([...tools.keys()].sort()).toEqual(["get_availability", "get_reservation_options"]);
    for (const tool of tools.values()) expect(tool.annotations).toEqual({ readOnlyHint: true, untrustedContentHint: true });
    fetch.mockResolvedValue(response({ ...catalog, secret: "must-not-leak", stores: catalog.stores.map((s) => ({ ...s, token: "must-not-leak" })) }));
    expect(await execute("get_reservation_options", {})).toEqual({
      ok: true, stores: catalog.stores, services: [], resources: [], businessHours: []
    });
    const before = window.document.querySelector("form")!.innerHTML;
    expect(await execute("get_reservation_options", { storeId: " st1 " })).toEqual({
      ok: true, stores: [store], services: catalog.services.slice(0, 2), resources: [resource], businessHours: [hours]
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetch.mock.calls as unknown as [string, RequestInit][]) {
      expect(url).toBe("/api/public/reservation-options");
      expect(init.method).toBe("GET");
      expect(init.redirect).toBe("error");
      expect(init.headers).toEqual({ Accept: "application/json" });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(window.document.querySelector("form")!.innerHTML).toBe(before);
    window.dispatchEvent(new window.PageTransitionEvent("pageshow", { persisted: true }));
    expect(register).toHaveBeenCalledTimes(2);
  });

  it("fetches a multi-menu query once and preserves public slots, prices and notice verbatim", async () => {
    const { execute, fetch } = await setup();
    fetch.mockResolvedValue(response({ ...availability, token: "must-not-leak", slots: availability.slots.map((s) => ({ ...s, customerId: "must-not-leak" })) }));
    expect(await execute("get_availability", { ...query, storeId: " st1 ", serviceIds: [" s1 ", "s2"] })).toEqual(availability);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/public/availability?storeId=st1&serviceId=s1&serviceIds=s1%2Cs2&resourceId=r1&date=2028-02-29");
    expect(init.method).toBe("GET");
  });

  it.each([
    null, [], "bad", { unknown: true }, { storeId: "" }, { storeId: 1 }, { storeId: "x".repeat(129) }
  ])("rejects invalid catalog input without a request: %j", async (input) => {
    const { execute, fetch } = await setup();
    expect(await execute("get_reservation_options", input)).toEqual({ ok: false, reason: "invalid_request" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    {}, { ...query, extra: true }, { ...query, serviceIds: [] },
    { ...query, serviceIds: Array.from({ length: 13 }, (_, i) => `s${i}`) },
    { ...query, serviceIds: ["s1", " s1 "] }, { ...query, serviceIds: ["s1,s2"] },
    { ...query, serviceIds: ["s1", ""] }, { ...query, serviceIds: [1] },
    { ...query, serviceIds: ["x".repeat(129)] }, { ...query, resourceId: false },
    { ...query, storeId: " " }, { ...query, date: "2027-02-29" },
    { ...query, date: "2028-04-31" }, { ...query, date: "2028-2-29" },
    { ...query, date: "2028-02-29T00:00:00Z" }
  ])("rejects invalid availability input without a request: %j", async (input) => {
    const { execute, fetch } = await setup();
    expect(await execute("get_availability", input)).toEqual({ ok: false, reason: "invalid_request" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns not_found for an unknown store and preserves empty results", async () => {
    const { execute, fetch } = await setup();
    expect(await execute("get_reservation_options", { storeId: "missing" })).toEqual({ ok: false, reason: "not_found" });
    fetch.mockResolvedValue(response({ ...catalog, stores: [], services: [], resources: [], businessHours: [] }));
    expect(await execute("get_reservation_options", {})).toEqual({ ok: true, stores: [], services: [], resources: [], businessHours: [] });
    fetch.mockResolvedValue(response({ ...availability, slots: [] }));
    expect(await execute("get_availability", query)).toEqual({ ...availability, slots: [] });
  });

  it.each([
    [400, "invalid_request", "invalid_request"], [400, "duration_limit_exceeded", "duration_limit_exceeded"],
    [404, "not_found", "not_found"], [500, "not_found", "unavailable"],
    [403, "not_found", "unavailable"], [400, "secret-token", "unavailable"]
  ])("allows only confirmed API error reasons (%s %s)", async (status, reason, expected) => {
    const { execute, fetch } = await setup();
    fetch.mockResolvedValue(response({ ok: false, reason }, status as number));
    expect(await execute("get_availability", query)).toEqual({ ok: false, reason: expected });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("contains non-JSON, network and malformed response failures", async () => {
    const { execute, fetch } = await setup();
    for (const body of [null, { ...availability, slots: [{}] }, { ...availability, durationMinutes: "120" }, { ...availability, serviceIds: "s1" }]) {
      fetch.mockResolvedValue(response(body));
      expect(await execute("get_availability", query)).toEqual({ ok: false, reason: "unavailable" });
    }
    fetch.mockResolvedValue(response("<html>secret-token</html>", 200, "text/html"));
    expect(await execute("get_availability", query)).toEqual({ ok: false, reason: "unavailable" });
    fetch.mockRejectedValue(new Error("https://user:secret@example.com"));
    expect(await execute("get_availability", query)).toEqual({ ok: false, reason: "unavailable" });
    fetch.mockResolvedValue(response({ ...catalog, services: [{ ...service, priceAmount: "0" }] }));
    expect(await execute("get_reservation_options", { storeId: "st1" })).toEqual({ ok: false, reason: "unavailable" });
  });

  it("aborts a pending request, skips pre-aborted requests, and limits requests to ten seconds", async () => {
    const { execute, fetch } = await setup();
    fetch.mockImplementation((...args: any[]) => new Promise((_resolve, reject) => {
      const signal = args[1].signal as AbortSignal;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const cancel = new AbortController();
    const pending = execute("get_availability", query, cancel.signal);
    cancel.abort();
    expect(await pending).toEqual({ ok: false, reason: "aborted" });
    fetch.mockClear();
    expect(await execute("get_availability", query, cancel.signal)).toEqual({ ok: false, reason: "aborted" });
    expect(fetch).not.toHaveBeenCalled();
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const expiring = execute("get_availability", query);
    deadline.abort(new DOMException("Timed out", "TimeoutError"));
    expect(await expiring).toEqual({ ok: false, reason: "timeout" });
    expect(timeout).toHaveBeenCalledWith(10_000);
  });

  it("keeps concurrent calls independent", async () => {
    const { execute, fetch } = await setup();
    let release: (value: ReturnType<typeof response>) => void = () => {};
    fetch.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    fetch.mockResolvedValueOnce(response({ ...availability, date: "2028-03-01", slots: [] }));
    const first = execute("get_availability", query);
    const second = await execute("get_availability", { ...query, date: "2028-03-01" });
    release(response(availability));
    expect(await first).toEqual(availability);
    expect(second).toEqual({ ...availability, date: "2028-03-01", slots: [] });
  });

  it("preserves a selected UI slot and lets an in-flight UI refresh finish after a tool call", async () => {
    const { execute, fetch, window } = await setup();
    const doc = window.document;
    const menu = doc.querySelector('input[name="serviceIds"]') as unknown as HTMLInputElement;
    fetch.mockResolvedValue(response(availability));
    menu.checked = true;
    menu.dispatchEvent(new window.Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(doc.querySelector(".slot-button")).not.toBeNull());
    (doc.querySelector(".slot-button") as unknown as HTMLButtonElement).click();
    const selection = () => ({
      store: (doc.querySelector("#store") as unknown as HTMLSelectElement).value,
      resource: (doc.querySelector("#resource") as unknown as HTMLSelectElement).value,
      date: (doc.querySelector("#date") as unknown as HTMLSelectElement).value,
      menu: menu.checked, slots: doc.querySelector("#slots")!.innerHTML,
      nextDisabled: (doc.querySelector("#step1-next") as unknown as HTMLButtonElement).disabled
    });
    const before = selection();
    expect(doc.querySelector('.slot-button[aria-checked="true"]')).not.toBeNull();
    fetch.mockResolvedValue(response({ ...availability, storeId: "st2", slots: [] }));
    await execute("get_availability", { ...query, storeId: "st2" });
    expect(selection()).toEqual(before);

    let release: (value: ReturnType<typeof response>) => void = () => {};
    fetch.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    (doc.querySelector("#refresh-slots") as unknown as HTMLButtonElement).click();
    expect(doc.querySelector("#slots")!.getAttribute("aria-busy")).toBe("true");
    await execute("get_availability", { ...query, storeId: "st2" });
    release(response(availability));
    await vi.waitFor(() => expect(doc.querySelectorAll(".slot-button")).toHaveLength(1));
    expect(doc.querySelector("#slots")!.getAttribute("aria-busy")).toBe("false");
  });

  it.each(["sync", "async", "unsupported"] as const)("keeps the normal form usable when registration is %s", async (failure) => {
    const { window, tools } = await setup(failure);
    expect(tools.size).toBe(0);
    expect((window.document.querySelector("#store") as unknown as HTMLSelectElement).disabled).toBe(false);
    expect(window.document.querySelectorAll('input[name="serviceIds"]')).toHaveLength(2);
  });
});
