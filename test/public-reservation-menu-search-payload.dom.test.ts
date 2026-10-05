import { readFileSync } from "node:fs";
import { join } from "node:path";

import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// FR-005 search × submission (specs/002-monotone-glass): the contract scenario
// from dom-api-invariants.md §V3 検索 — "A 選択 → A を検索で非表示 → B 選択 →
// 検索解除" must keep BOTH menus selected all the way into the actual POST
// body (serviceIds = [A, B]). A regression that drops hidden-but-selected
// menus from the payload would pass any checked-set-only assertion; this test
// drives the real submit flow and captures the request body.

const OPTIONS_BODY = {
  ok: true,
  stores: [{ id: "st1", name: "本店", timezone: "Asia/Tokyo" }],
  services: [
    { id: "sv-a", storeId: "st1", name: "脱毛｜全身脱毛 1回コース", durationMinutes: 60 },
    { id: "sv-b", storeId: "st1", name: "脱毛｜ワキ脱毛 1回コース", durationMinutes: 30 }
  ],
  resources: [{ id: "r1", storeId: "st1", name: "枠1" }],
  turnstile: { siteKey: "test-site-key", action: "reservation-submit" },
  consentVersions: {
    notice: "notice-v3",
    cancellationPolicy: "cancel-v2",
    privacyPolicy: "privacy-v4",
    minorGuardian: "minor-v1",
    duplicateReservationWarning: "dup-v1"
  },
  liffId: "liff-1"
};

const AVAILABILITY_BODY = {
  ok: true,
  timezone: "Asia/Tokyo",
  slots: [{ startAt: "2026-06-01T01:00:00.000Z", endAt: "2026-06-01T02:30:00.000Z", resourceId: "r1" }]
};

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => "application/json" },
  json: async () => body
});

let dom: JSDOM;
let capturedReservationBody: Record<string, unknown> | null = null;

const stubFetch = (url: string, init?: { body?: string }) => {
  if (url.includes("/api/public/reservation-options")) return Promise.resolve(jsonResponse(OPTIONS_BODY));
  if (url.includes("/api/public/availability")) return Promise.resolve(jsonResponse(AVAILABILITY_BODY));
  if (url.includes("/api/public/reservation-gate")) {
    return Promise.resolve(
      jsonResponse({
        allowed: true,
        lineUserId: "U1",
        stage: "form",
        customer: { displayName: "山田 花子", displayNameKana: "ヤマダ ハナコ", phoneMasked: "****5678" }
      })
    );
  }
  if (url.includes("/api/public/reservations")) {
    capturedReservationBody = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    return Promise.resolve(
      jsonResponse({ ok: true, reservationId: "r-1", status: "pending_approval", startAt: "2026-06-01T01:00:00.000Z" })
    );
  }
  return Promise.resolve(jsonResponse({ ok: true }));
};

const setup = async () => {
  dom?.window.close();
  capturedReservationBody = null;
  const html = readFileSync(join(process.cwd(), "public/index.html"), "utf8");
  const appJs = readFileSync(join(process.cwd(), "public/app.js"), "utf8");
  dom = new JSDOM(html, { runScripts: "outside-only", url: "https://example.com/", pretendToBeVisual: true });
  const { window } = dom;
  const win = window as unknown as Record<string, unknown> & { crypto?: { randomUUID?: () => string } };
  const FIXED_NOW = new Date("2026-06-01T00:00:00.000Z").getTime();
  const RealDate = window.Date;
  const FixedDate = new Proxy(RealDate, {
    construct: (target, args) => Reflect.construct(target, args.length === 0 ? [FIXED_NOW] : args),
    apply: () => new RealDate(FIXED_NOW).toString(),
    get: (target, prop, receiver) => (prop === "now" ? () => FIXED_NOW : Reflect.get(target, prop, receiver))
  });
  (win as { Date: DateConstructor }).Date = FixedDate as unknown as DateConstructor;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  win.scrollTo = () => {};
  (window.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
  win.fetch = vi.fn((i: unknown, init?: unknown) => stubFetch(String(i), init as { body?: string }));
  if (!win.crypto?.randomUUID) {
    win.crypto = {
      randomUUID: () => `uuid-${Math.random().toString(16).slice(2)}`,
      getRandomValues: (arr: Uint32Array) => {
        for (let i = 0; i < arr.length; i += 1) arr[i] = Math.floor(Math.random() * 0xffffffff);
        return arr;
      }
    } as Crypto;
  }
  win.liff = {
    init: async () => undefined,
    isInClient: () => true,
    isLoggedIn: () => true,
    getIDToken: () => "id_token_1",
    getAccessToken: () => "line_access_token",
    getDecodedIDToken: () => ({ nonce: "nonce_1" }),
    requestFriendship: async () => undefined
  };
  win.turnstile = {
    render: (_el: unknown, opts: { callback?: (t: string) => void }) => {
      opts.callback?.("turnstile-token");
      return "turnstile-widget-1";
    },
    reset: () => {},
    remove: () => {}
  };
  window.eval(appJs);
  await vi.waitFor(() => {
    if (window.document.querySelectorAll("#services input[name='serviceIds']").length === 0) {
      throw new Error("menu not rendered yet");
    }
  });
  for (const id of ["liff-sdk", "turnstile-sdk"]) {
    const script = window.document.createElement("script");
    script.id = id;
    window.document.head.appendChild(script);
  }
};

const q = (id: string): HTMLElement => {
  const el = dom.window.document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
};
const input = (id: string): HTMLInputElement => q(id) as HTMLInputElement;
const fireChange = (el: HTMLInputElement) => el.dispatchEvent(new dom.window.Event("change", { bubbles: true }));

describe("search-filtered selection reaches the POST body (FR-005 × dom-api-invariants)", () => {
  beforeEach(() => setup());
  afterEach(() => dom?.window.close());

  it("submits serviceIds [A, B] after A was hidden by search while B was picked", async () => {
    const doc = dom.window.document;
    (q("services-trigger") as HTMLButtonElement).click();
    const search = doc.querySelector<HTMLInputElement>(".services-search");
    expect(search).not.toBeNull();
    if (!search) return;
    const setQuery = (value: string) => {
      search.value = value;
      search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    };

    // A selected → filtered out by「わき」→ B selected while A is hidden →
    // filter cleared.
    const a = doc.querySelector<HTMLInputElement>("#services input[value='sv-a']");
    const b = doc.querySelector<HTMLInputElement>("#services input[value='sv-b']");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    if (!a || !b) return;
    a.click();
    expect(a.checked).toBe(true);
    setQuery("わき");
    expect(a.closest<HTMLElement>(".service-option")?.hidden).toBe(true);
    expect(b.closest<HTMLElement>(".service-option")?.hidden).toBe(false);
    b.click();
    expect(b.checked).toBe(true);
    setQuery("");

    // Drive the rest of the real flow: slot, LINE gate, consent, confirm.
    const resource = input("resource");
    resource.value = "r1";
    fireChange(resource);
    const date = input("date");
    date.value = "2026-06-01";
    fireChange(date);
    await vi.waitFor(() => {
      if (!doc.querySelector(".slot-button")) throw new Error("slot not rendered yet");
    });
    (doc.querySelector(".slot-button") as HTMLButtonElement).click();
    (q("step1-next") as HTMLButtonElement).click();
    const PENDING = "__pending__";
    q("line-state").textContent = PENDING;
    (q("line-login") as HTMLButtonElement).click();
    await vi.waitFor(
      () => {
        const t = q("line-state").textContent ?? "";
        if (t === PENDING || t === "確認中です…" || t === "") throw new Error("gate not resolved yet");
      },
      { timeout: 3000 }
    );
    const consent = input("required-consent");
    consent.checked = true;
    fireChange(consent);

    // Implicit-submission guard: with the form otherwise satisfied, Enter in
    // the search box must be prevented (a browser would otherwise activate the
    // submit button and jump to the confirm panel mid-search) — but the IME
    // conversion-confirm Enter (isComposing, or keyCode 229 in some WebViews)
    // must pass through untouched or Japanese input breaks.
    const enter = new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    search.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(q("confirm-panel").hidden).toBe(true);
    const imeEnter = new dom.window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      isComposing: true
    });
    search.dispatchEvent(imeEnter);
    expect(imeEnter.defaultPrevented).toBe(false);
    const webViewImeEnter = new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    Object.defineProperty(webViewImeEnter, "keyCode", { value: 229 });
    search.dispatchEvent(webViewImeEnter);
    expect(webViewImeEnter.defaultPrevented).toBe(false);

    q("reservation-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    expect(q("confirm-panel").hidden).toBe(false);
    (q("confirm-submit") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      if (!capturedReservationBody) throw new Error("reservation not submitted yet");
    });

    // The captured POST body must carry BOTH menus, in selection (DOM) order.
    expect((capturedReservationBody as { serviceIds?: string[] }).serviceIds).toEqual(["sv-a", "sv-b"]);
  });
});
