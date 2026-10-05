import { readFileSync } from "node:fs";
import { join } from "node:path";

import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Behavioural test (JSDOM) for the LINE-recognized existing-customer "skip mode":
// after the form-stage gate returns a masked on-file contact, the booking page hides
// + disables the name/phone inputs, shows a confirmation line, and submits WITHOUT a
// customer object. Also covers the no-phone fallback, the "情報を変更" override, the
// unrecognized case, and clearing the recognized state on gate failure.

type GateCustomer = { displayName: string; displayNameKana: string | null; phoneMasked: string | null };

const OPTIONS_BODY = {
  ok: true,
  stores: [{ id: "st1", name: "本店", timezone: "Asia/Tokyo" }],
  services: [{ id: "s1", storeId: "st1", name: "カット｜カット", durationMinutes: 60 }],
  resources: [{ id: "r1", storeId: "st1", name: "枠1" }],
  consentVersions: { notice: "1", cancellationPolicy: "1", privacyPolicy: "1", minorGuardian: "1" },
  liffId: "liff-1"
};

const AVAILABILITY_BODY = {
  ok: true,
  timezone: "Asia/Tokyo",
  slots: [{ startAt: "2026-06-01T01:00:00.000Z", endAt: "2026-06-01T02:00:00.000Z", resourceId: "r1" }]
};

const jsonResponse = (body: unknown) => ({
  ok: true,
  headers: { get: () => "application/json" },
  json: async () => body
});

let dom: JSDOM;
// Per-test gate response + captured reservation submit body.
let gateCustomer: GateCustomer | null = null;
let gateAllowed = true;
let capturedReservationBody: Record<string, unknown> | null = null;
// Override the /api/public/reservations response body (default = success).
let reservationResponse: Record<string, unknown> = {
  ok: true,
  reservationId: "r-1",
  status: "pending_approval",
  startAt: "2026-06-01T01:00:00.000Z"
};

const stubFetch = (url: string, init?: { body?: string }) => {
  if (url.includes("/api/public/reservation-options")) return Promise.resolve(jsonResponse(OPTIONS_BODY));
  if (url.includes("/api/public/availability")) return Promise.resolve(jsonResponse(AVAILABILITY_BODY));
  if (url.includes("/api/public/reservation-gate")) {
    if (!gateAllowed) {
      return Promise.resolve(jsonResponse({ allowed: false, reason: "line_not_friend" }));
    }
    return Promise.resolve(
      jsonResponse({
        allowed: true,
        lineUserId: "U1",
        stage: "form",
        ...(gateCustomer ? { customer: gateCustomer } : {})
      })
    );
  }
  if (url.includes("/api/public/reservations")) {
    capturedReservationBody = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    return Promise.resolve(jsonResponse(reservationResponse));
  }
  return Promise.resolve(jsonResponse({ ok: true }));
};

const setup = async () => {
  gateCustomer = null;
  gateAllowed = true;
  capturedReservationBody = null;
  reservationResponse = {
    ok: true,
    reservationId: "r-1",
    status: "pending_approval",
    startAt: "2026-06-01T01:00:00.000Z"
  };
  const html = readFileSync(join(process.cwd(), "public/index.html"), "utf8");
  const appJs = readFileSync(join(process.cwd(), "public/app.js"), "utf8");
  dom = new JSDOM(html, { runScripts: "outside-only", url: "https://example.com/", pretendToBeVisual: true });
  const { window } = dom;
  const win = window as unknown as Record<string, unknown> & { crypto?: { randomUUID?: () => string } };
  // Freeze the JSDOM realm clock to the hardcoded slot date. app.js builds the date
  // <select> from `new Date()` (app.js:536) and the booking flow drops past slots, so
  // once the real wall-clock passes 2026-06-01 the hardcoded date is no longer a
  // selectable option and no slot renders. The app runs via window.eval in THIS realm,
  // so the Node global Date / vi fake timers never reach it — override window.Date.
  const FIXED_NOW = new Date("2026-06-01T00:00:00.000Z").getTime();
  const RealDate = window.Date;
  // Proxy (not an ES6 subclass) so `Date()` called WITHOUT `new` also works — a
  // subclass throws "Class constructor cannot be invoked without 'new'" if app.js
  // or a dependency ever calls Date() as a function. construct → new Date() frozen;
  // apply → Date() frozen string; get → Date.now() frozen, other statics intact.
  const FixedDate = new Proxy(RealDate, {
    construct: (target, args) => Reflect.construct(target, args.length === 0 ? [FIXED_NOW] : args),
    apply: () => new RealDate(FIXED_NOW).toString(),
    get: (target, prop, receiver) => (prop === "now" ? () => FIXED_NOW : Reflect.get(target, prop, receiver))
  });
  (win as { Date: DateConstructor }).Date = FixedDate as unknown as DateConstructor;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  win.scrollTo = () => {};
  win.fetch = vi.fn((input: unknown, init?: unknown) => stubFetch(String(input), init as { body?: string }));
  if (!win.crypto?.randomUUID) {
    win.crypto = {
      randomUUID: () => `uuid-${Math.random().toString(16).slice(2)}`,
      getRandomValues: (arr: Uint32Array) => arr.map(() => Math.floor(Math.random() * 0xffffffff))
    } as Crypto;
  }
  // Fake LINE LIFF SDK so getLineTokens resolves a verified token without the network.
  win.liff = {
    init: async () => undefined,
    isInClient: () => true,
    isLoggedIn: () => true,
    getIDToken: () => "id_token_1",
    getAccessToken: () => "line_access_token",
    getDecodedIDToken: () => ({ nonce: "nonce_1" }),
    requestFriendship: async () => undefined
  };
  // Fake Cloudflare Turnstile so reaching the security-check step resolves a token
  // synchronously instead of leaving the SDK-polling timers pending past teardown.
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
  // loadExternalScript(id, …) short-circuits when an element with that id exists,
  // so the faked liff / turnstile globals are used without real network script loads.
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

const loginWith = async (customer: GateCustomer | null, allowed = true): Promise<void> => {
  gateCustomer = customer;
  gateAllowed = allowed;
  // Reset to a sentinel so the waitFor keys off THIS attempt's terminal result,
  // not a prior login's lingering "✓ …" / "⚠ …" message.
  const PENDING = "__pending__";
  q("line-state").textContent = PENDING;
  (q("line-login") as HTMLButtonElement).click();
  await vi.waitFor(
    () => {
      const t = q("line-state").textContent ?? "";
      // Terminal states: "本人確認が完了しました" (ok) or a danger reason message (fail).
      if (t === PENDING || t === "確認中です…" || t === "") {
        throw new Error("gate not resolved yet");
      }
    },
    { timeout: 3000 }
  );
};

const fireChange = (el: HTMLInputElement) => el.dispatchEvent(new dom.window.Event("change", { bubbles: true }));

// Pick store/service/resource/date so loadAvailability fetches and renders a slot.
const selectSlot = async (): Promise<void> => {
  const svc = dom.window.document.querySelector("#services input[name='serviceIds']") as HTMLInputElement;
  svc.checked = true;
  fireChange(svc);
  const resource = input("resource");
  resource.value = "r1";
  fireChange(resource);
  const date = input("date");
  date.value = "2026-06-01";
  fireChange(date);
  await vi.waitFor(() => {
    if (!dom.window.document.querySelector(".slot-button")) throw new Error("slot not rendered yet");
  });
  (dom.window.document.querySelector(".slot-button") as HTMLButtonElement).click();
};

describe("recognized existing-customer skip mode (JSDOM)", () => {
  beforeEach(setup);
  afterEach(() => dom?.window.close());

  it("hides + disables the inputs and shows the confirmation line when a phone is on file", async () => {
    await loginWith({ displayName: "山田 花子", displayNameKana: "ヤマダ ハナコ", phoneMasked: "****5678" });
    expect(q("contact-fields").hidden).toBe(true);
    expect(q("recognized-contact").hidden).toBe(false);
    expect(q("recognized-name").textContent).toContain("山田 花子");
    expect(q("recognized-phone").textContent).toContain("****5678");
    expect(input("display-name").disabled).toBe(true);
    expect(input("phone").disabled).toBe(true);
  });

  it("shows the inputs and pre-fills name when the customer has no phone on file", async () => {
    await loginWith({ displayName: "紙カルテ 太郎", displayNameKana: null, phoneMasked: null });
    expect(q("contact-fields").hidden).toBe(false);
    expect(q("recognized-contact").hidden).toBe(true);
    expect(input("display-name").value).toBe("紙カルテ 太郎");
    expect(input("display-name").disabled).toBe(false);
    expect(input("phone").value).toBe("");
    expect(input("phone").disabled).toBe(false);
  });

  it("leaves the inputs visible and editable for an unrecognized LINE user", async () => {
    await loginWith(null);
    expect(q("contact-fields").hidden).toBe(false);
    expect(q("recognized-contact").hidden).toBe(true);
    expect(input("phone").disabled).toBe(false);
  });

  it("re-enables + pre-fills the inputs when the customer taps 情報を変更", async () => {
    await loginWith({ displayName: "山田 花子", displayNameKana: "ヤマダ ハナコ", phoneMasked: "****5678" });
    (q("contact-edit") as HTMLButtonElement).click();
    expect(q("contact-fields").hidden).toBe(false);
    expect(q("recognized-contact").hidden).toBe(true);
    expect(input("display-name").value).toBe("山田 花子");
    expect(input("display-name").disabled).toBe(false);
    expect(input("phone").disabled).toBe(false);
  });

  it("never shows recognized PII when the gate check fails (no leaked summary)", async () => {
    // A failed gate (e.g. friendship lost) must clear any recognized state: the
    // confirmation line stays hidden, inputs stay visible + enabled, no stale name.
    await loginWith(null, false);
    expect(q("recognized-contact").hidden).toBe(true);
    expect(q("contact-fields").hidden).toBe(false);
    expect(input("phone").disabled).toBe(false);
    expect(input("display-name").disabled).toBe(false);
    expect(q("recognized-name").textContent).toBe("");
  });

  it("passes form validation and omits customer in the submit payload (skip mode)", async () => {
    // Drive the full booking flow: pick a slot, advance to step 2, LINE-login into
    // skip mode, accept consents, submit, and confirm.
    await selectSlot();
    (q("step1-next") as HTMLButtonElement).click();
    await loginWith({ displayName: "山田 花子", displayNameKana: "ヤマダ ハナコ", phoneMasked: "****5678" });
    for (const id of ["required-consent"]) {
      const cb = input(id);
      cb.checked = true;
      cb.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    }
    // The form submit handler gates on reportValidity; disabled inputs in skip mode
    // must let it through even though name/phone are empty + required.
    q("reservation-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    expect(q("confirm-panel").hidden).toBe(false);
    (q("confirm-submit") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      if (!capturedReservationBody) throw new Error("reservation not submitted yet");
    });
    expect(capturedReservationBody?.customer).toBeUndefined();
    await vi.waitFor(() => expect(q("success-panel").hidden).toBe(false));
    expect(dom.window.document.querySelector(".identity-group")?.classList.contains("identity-verified")).toBe(true);
    expect((dom.window.document.querySelector(".auth-note") as HTMLElement).hidden).toBe(true);
    input("minor-consent").checked = true;
    (q("success-new") as HTMLButtonElement).click();
    expect(input("required-consent").checked).toBe(false);
    expect(input("minor-consent").checked).toBe(false);
    expect(q("recognized-contact").hidden).toBe(true);
    expect(dom.window.document.querySelector(".identity-group")?.classList.contains("identity-verified")).toBe(false);
    expect((dom.window.document.querySelector(".auth-note") as HTMLElement).hidden).toBe(false);
  });

  it("wipes pre-filled PII from the inputs when LINE auth is lost at submit time", async () => {
    // No-phone recognized customer: name is pre-filled into a visible input.
    await selectSlot();
    (q("step1-next") as HTMLButtonElement).click();
    await loginWith({ displayName: "紙カルテ 太郎", displayNameKana: "カミカルテ タロウ", phoneMasked: null });
    expect(input("display-name").value).toBe("紙カルテ 太郎");
    input("phone").value = "09011112222";
    for (const id of ["required-consent"]) {
      const cb = input(id);
      cb.checked = true;
      cb.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    }
    // Submit fails with a LINE auth reason → the recognized PII must be wiped.
    reservationResponse = { ok: false, reason: "auth_failed", authReason: "line_not_friend" };
    q("reservation-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    expect(q("confirm-panel").hidden).toBe(false);
    (q("confirm-submit") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      if (input("display-name").value !== "") throw new Error("PII not cleared yet");
    });
    expect(input("display-name").value).toBe("");
    expect(input("display-name-kana").value).toBe("");
    expect(input("phone").value).toBe("");
    expect(input("required-consent").checked).toBe(false);
    expect(dom.window.document.querySelector(".identity-group")?.classList.contains("identity-verified")).toBe(false);
    expect((dom.window.document.querySelector(".auth-note") as HTMLElement).hidden).toBe(false);
  });
});
