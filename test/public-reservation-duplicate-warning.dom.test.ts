import { readFileSync } from "node:fs";
import { join } from "node:path";

import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Behavioural test (JSDOM) for the duplicate-reservation warning on the booking page.
// When the form-stage gate reports the recognized customer already holds active future
// reservations, the page shows a warning block + an acknowledgement checkbox, gates the
// submit on it, switches between soft/hard styling, and echoes the warning version in
// the submit payload. No upcoming reservations → the block stays hidden and inert.

type Upcoming = {
  reservationId: string;
  storeId: string;
  storeName: string;
  serviceName: string;
  startAt: string;
  status: "confirmed" | "pending_approval";
  isWithinLeadTime: boolean;
  cancelBlocked: boolean;
};

const OPTIONS_BODY = {
  ok: true,
  stores: [{ id: "st1", name: "本店", timezone: "Asia/Tokyo" }],
  services: [{ id: "s1", storeId: "st1", name: "カット｜カット", durationMinutes: 60 }],
  resources: [{ id: "r1", storeId: "st1", name: "枠1" }],
  // siteKey present so renderTurnstile proceeds and the stub resolves a token, letting
  // the submit button reach its enabled state (the gate we assert on).
  turnstile: { siteKey: "test-site-key", action: "reservation-submit" },
  consentVersions: {
    notice: "1",
    cancellationPolicy: "1",
    privacyPolicy: "1",
    minorGuardian: "1",
    duplicateReservationWarning: "dup-warning-2026-08-31"
  },
  liffId: "liff-1"
};

const AVAILABILITY_BODY = {
  ok: true,
  timezone: "Asia/Tokyo",
  slots: [{ startAt: "2026-06-01T01:00:00.000Z", endAt: "2026-06-01T02:00:00.000Z", resourceId: "r1" }]
};

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => "application/json" },
  json: async () => body
});

let dom: JSDOM;
let upcoming: Upcoming[] = [];
let capturedReservationBody: Record<string, unknown> | null = null;
// When set, the FIRST /reservations POST returns a 409 duplicate-consent rejection and
// makes `dupRaceAppears` materialise (simulating a reservation that appeared between
// form-load and submit). Subsequent POSTs succeed.
let dupRaceAppears: Upcoming[] | null = null;
let reservationCallCount = 0;
// The duplicate-warning consent version the options endpoint currently serves. A test
// can start it stale and set `nextOptionsVersion` to have the 409 branch flip it — this
// simulates a deploy between form-load and submit, so the recovery path must re-fetch
// the options (not just the gate) to pick up the canonical version.
let optionsVersion = "dup-warning-2026-08-31";
let nextOptionsVersion: string | null = null;
// store_settings.max_active_reservations_per_customer as served by /reservation-options.
// null = field absent (older cached payload) → the page must fall back to the
// acknowledge-and-continue flow.
let storeCap: number | null = null;
// When true the form-stage gate answers with a transient failure, so the page cannot
// refresh state.upcomingReservations. Used to prove a raised cap still lifts the block.
let gateUnavailable = false;

const stubFetch = (url: string, init?: { body?: string }) => {
  if (url.includes("/api/public/reservation-options")) {
    return Promise.resolve(
      jsonResponse({
        ...OPTIONS_BODY,
        stores: OPTIONS_BODY.stores.map((store) =>
          storeCap === null ? store : { ...store, maxActiveReservationsPerCustomer: storeCap }
        ),
        consentVersions: { ...OPTIONS_BODY.consentVersions, duplicateReservationWarning: optionsVersion }
      })
    );
  }
  if (url.includes("/api/public/availability")) return Promise.resolve(jsonResponse(AVAILABILITY_BODY));
  if (url.includes("/api/public/reservation-gate")) {
    if (gateUnavailable) return Promise.resolve(jsonResponse({ ok: false, reason: "rate_limited" }, 429));
    return Promise.resolve(
      jsonResponse({
        allowed: true,
        lineUserId: "U1",
        stage: "form",
        customer: { displayName: "山田 花子", displayNameKana: "ヤマダ ハナコ", phoneMasked: "****5678" },
        ...(upcoming.length > 0 ? { upcomingReservations: upcoming } : {})
      })
    );
  }
  if (url.includes("/api/public/reservations")) {
    capturedReservationBody = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    reservationCallCount += 1;
    if (dupRaceAppears && reservationCallCount === 1) {
      // The race: a reservation appeared since form-load, so the gate will now report it.
      // Mirror the real transport status (HTTP 409) alongside the body, not just ok:false.
      upcoming = dupRaceAppears;
      if (nextOptionsVersion) optionsVersion = nextOptionsVersion;
      return Promise.resolve(jsonResponse({ ok: false, reason: "duplicate_reservation_consent_required" }, 409));
    }
    return Promise.resolve(
      jsonResponse({ ok: true, reservationId: "r-1", status: "pending_approval", startAt: "2026-06-01T01:00:00.000Z" })
    );
  }
  return Promise.resolve(jsonResponse({ ok: true }));
};

const setup = async (cap: number | null = null) => {
  // A test may re-run setup() to serve a different store cap; close the JSDOM beforeEach
  // already built so windows do not pile up.
  dom?.window.close();
  upcoming = [];
  capturedReservationBody = null;
  dupRaceAppears = null;
  reservationCallCount = 0;
  optionsVersion = "dup-warning-2026-08-31";
  nextOptionsVersion = null;
  storeCap = cap;
  gateUnavailable = false;
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
  win.fetch = vi.fn((i: unknown, init?: unknown) => stubFetch(String(i), init as { body?: string }));
  if (!win.crypto?.randomUUID) {
    win.crypto = {
      randomUUID: () => `uuid-${Math.random().toString(16).slice(2)}`,
      // Fill the buffer in place (real Web Crypto contract) rather than returning a new
      // array from TypedArray.map().
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

const login = async (): Promise<void> => {
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
};

const checkBaseConsents = () => {
  for (const id of ["required-consent"]) {
    const cb = input(id);
    cb.checked = true;
    fireChange(cb);
  }
};

const SOFT: Upcoming = {
  reservationId: "ex1",
  storeId: "st1",
  storeName: "本店",
  serviceName: "カット",
  startAt: "2026-08-01T03:00:00.000Z",
  status: "confirmed",
  isWithinLeadTime: false,
  cancelBlocked: false
};
const HARD: Upcoming = {
  ...SOFT,
  reservationId: "ex2",
  startAt: "2026-06-01T12:00:00.000Z",
  isWithinLeadTime: true,
  // Inside the lead time the recovery page offers no cancel action either.
  cancelBlocked: true
};
// Far enough out to be soft, but the customer has used up their rejected/withdrawn
// change-request allowance, so "予約の確認・変更" still offers no cancellation.
const RETRIES_EXHAUSTED: Upcoming = { ...SOFT, reservationId: "ex4", cancelBlocked: true };
// 全予約承認制: Web 予約は承認まで pending_approval。hard 文言の status 分岐を検証する。
const HARD_PENDING: Upcoming = { ...HARD, reservationId: "ex3", status: "pending_approval" };

describe("duplicate-reservation warning (JSDOM)", () => {
  beforeEach(() => setup());
  afterEach(() => dom?.window.close());

  it("keeps the warning hidden and does not require an extra acknowledgement when there are no upcoming reservations", async () => {
    upcoming = [];
    await selectSlot();
    (q("step1-next") as HTMLButtonElement).click();
    await login();
    checkBaseConsents();
    expect(q("duplicate-warning").hidden).toBe(true);
    // Submit enables on the base consents alone (turnstile auto-resolves in the stub).
    await vi.waitFor(() => {
      if ((q("submit") as HTMLButtonElement).disabled) throw new Error("submit still disabled");
    });
  });

  it("renders upcoming menu names per the shared display contract fixture (all cases)", async () => {
    // Every case from test/fixtures/service-display-cases.json rendered at once —
    // pins the booking screen's local displayServiceSnapshot to the shared contract
    // (category stripped, メンズ｜ kept, ' / ' segments, no-category passthrough).
    const { cases } = JSON.parse(
      readFileSync(join(process.cwd(), "test/fixtures/service-display-cases.json"), "utf8")
    ) as { cases: Array<{ input: string; expected: string }> };
    expect(cases.length).toBeGreaterThan(0);
    upcoming = cases.map((c, i) => ({ ...SOFT, reservationId: `fx${i}`, serviceName: c.input }));
    await selectSlot();
    (q("step1-next") as HTMLButtonElement).click();
    await login();
    checkBaseConsents();
    const text = q("duplicate-warning-list").textContent ?? "";
    for (const { input, expected } of cases) {
      expect(text).toContain(expected);
      if (input !== expected) {
        expect(text, `raw category-prefixed name leaked: ${input}`).not.toContain(input);
      }
    }
  });

  it("shows a soft warning and blocks submit until the acknowledgement is checked", async () => {
    upcoming = [SOFT];
    await selectSlot();
    (q("step1-next") as HTMLButtonElement).click();
    await login();
    checkBaseConsents();
    const warning = q("duplicate-warning");
    expect(warning.hidden).toBe(false);
    expect(warning.dataset.level).toBe("soft");
    expect(warning.getAttribute("role")).toBe("status");
    expect(q("duplicate-warning-list").textContent).toContain("本店");
    // Base consents satisfied but the acknowledgement is not → submit stays disabled.
    expect((q("submit") as HTMLButtonElement).disabled).toBe(true);
    // The submit hint (in the button's aria-describedby) names the extra acknowledgement
    // so the disabled reason is reachable by a screen reader.
    expect(q("submit-hint").textContent).toContain("既存のご予約についての確認");
    const ack = input("duplicate-consent");
    ack.checked = true;
    fireChange(ack);
    await vi.waitFor(() => {
      if ((q("submit") as HTMLButtonElement).disabled) throw new Error("submit still disabled after ack");
    });
  });

  it("blocks the booking outright (no acknowledgement offered) when the customer is already at the store cap", async () => {
    // beforeEach already booted the page with no cap in the payload; re-boot it so
    // /reservation-options serves this store cap.
    await setup(1);
    upcoming = [SOFT];
    await selectSlot();
    (q("step1-next") as HTMLButtonElement).click();
    await login();
    checkBaseConsents();
    const warning = q("duplicate-warning");
    expect(warning.hidden).toBe(false);
    // At the cap the trigger would reject the insert, so this is an error, not a choice.
    expect(warning.dataset.level).toBe("hard");
    expect(warning.getAttribute("role")).toBe("alert");
    expect(q("duplicate-warning-title").textContent).toContain("お申し込みいただけません");
    expect(q("duplicate-warning-lead").textContent).toContain("上限に達しています");
    // The same reason is mirrored into the always-visible #status, so the customer can
    // read it on step 1 before investing in a date/time.
    expect(q("status").textContent).toContain("上限に達しています");
    expect((q("status") as HTMLElement).dataset.tone).toBe("danger");
    // Manual login runs on step 2 (次へ was pressed before LINEでログイン), so the gate
    // must send the customer back to step 1 instead of stranding them on a form that
    // can never submit.
    expect(q("group-booking").hidden).toBe(false);
    expect(q("step2-content").hidden).toBe(true);
    expect(q("step1-next").hidden).toBe(false);
    // The slot is still selected, so 次へ must be disabled (and its handler guarded)
    // or the customer could immediately re-enter the unsubmittable step 2.
    expect((q("step1-next") as HTMLButtonElement).disabled).toBe(true);
    (q("step1-next") as HTMLButtonElement).click();
    expect(q("step2-content").hidden).toBe(true);
    // The acknowledgement row is hidden: ticking it could never make the submit succeed.
    expect(q("duplicate-consent-row").hidden).toBe(true);
    expect(q("submit-hint").textContent).toContain("お申し込みいただけません");
    // Even if the (hidden) checkbox is forced on, the submit stays disabled.
    const ack = input("duplicate-consent");
    ack.checked = true;
    fireChange(ack);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((q("submit") as HTMLButtonElement).disabled).toBe(true);
    // Enter inside a text field fires submit even with the button disabled — the
    // confirm panel must stay closed.
    q("reservation-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    expect(q("confirm-panel").hidden).toBe(true);
  });

  it("lifts the at-cap block when the customer cancels elsewhere and returns to the tab", async () => {
    await setup(1);
    upcoming = [SOFT];
    await selectSlot();
    (q("step1-next") as HTMLButtonElement).click();
    await login();
    checkBaseConsents();
    expect(q("duplicate-consent-row").hidden).toBe(true);
    expect((q("submit") as HTMLButtonElement).disabled).toBe(true);
    expect(q("status").textContent).toContain("上限に達しています");
    // The customer cancels on the "予約の確認・変更" page, then comes back to this tab.
    upcoming = [];
    dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
    await vi.waitFor(() => {
      if (!q("duplicate-warning").hidden) throw new Error("warning still shown");
      if ((q("submit") as HTMLButtonElement).disabled) throw new Error("submit still disabled");
    });
    // The "review my reservations" link the at-cap branch put up is dropped too.
    expect(q("pending-recovery").hidden).toBe(true);
    // The at-cap #status message must not outlive the cap itself.
    expect(q("status").textContent).not.toContain("上限");
  });

  it("lifts the at-cap block when the owner raises the store cap and the tab regains focus", async () => {
    await setup(1);
    upcoming = [SOFT];
    await selectSlot();
    (q("step1-next") as HTMLButtonElement).click();
    await login();
    checkBaseConsents();
    expect((q("submit") as HTMLButtonElement).disabled).toBe(true);
    expect(q("pending-recovery").hidden).toBe(false);
    // Owner raises max_active_reservations_per_customer; the reservation itself stays.
    storeCap = 3;
    dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
    await vi.waitFor(() => {
      if (q("duplicate-consent-row").hidden) throw new Error("acknowledgement still hidden");
    });
    // A raised cap clears the at-cap #status message as well.
    expect(q("status").textContent).not.toContain("上限");
    // …and re-enables 次へ, so the customer can proceed to step 2 again.
    const next = q("step1-next") as HTMLButtonElement;
    expect(next.disabled).toBe(false);
    next.click();
    expect(q("step2-content").hidden).toBe(false);
    const ack = input("duplicate-consent");
    ack.checked = true;
    fireChange(ack);
    await vi.waitFor(() => {
      if ((q("submit") as HTMLButtonElement).disabled) throw new Error("submit still disabled after ack");
    });
  });

  it("does not tell an at-cap customer to cancel when every reservation is past the change deadline", async () => {
    await setup(1);
    // The only existing reservation is already inside the 24h lead time, so
    // canCustomerRequestChange would reject a cancellation as too_late.
    upcoming = [HARD];
    await selectSlot();
    (q("step1-next") as HTMLButtonElement).click();
    await login();
    checkBaseConsents();
    const lead = q("duplicate-warning-lead").textContent ?? "";
    expect(lead).toContain("上限に達しています");
    expect(lead).toContain("当店公式LINEのトークからご連絡");
    // The dead-end instruction must be gone, and the billing consequence kept.
    expect(lead).not.toContain("キャンセルを申請");
    expect(lead).toContain("キャンセル変更料");
    expect(q("submit-hint").textContent).not.toContain("キャンセルされるまで");
    expect((q("submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("uses the contact-store copy at the cap when the reservation has no cancel action left", async () => {
    await setup(1);
    // Far enough out that the lead time is not the problem — the rejected/withdrawn
    // change-request allowance is what removed the cancel action.
    upcoming = [RETRIES_EXHAUSTED];
    await selectSlot();
    (q("step1-next") as HTMLButtonElement).click();
    await login();
    checkBaseConsents();
    const lead = q("duplicate-warning-lead").textContent ?? "";
    expect(lead).toContain("当店公式LINEのトークからご連絡");
    expect(lead).not.toContain("キャンセルを申請");
  });

  it("lifts the at-cap block on a raised cap even when the gate refresh fails", async () => {
    await setup(1);
    upcoming = [SOFT];
    await selectSlot();
    (q("step1-next") as HTMLButtonElement).click();
    await login();
    checkBaseConsents();
    expect(q("duplicate-consent-row").hidden).toBe(true);
    // Owner raises the cap, but the gate call transiently fails on the way back: the
    // fresh cap alone must already lift the block (the DB would accept the booking).
    storeCap = 3;
    gateUnavailable = true;
    dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
    await vi.waitFor(() => {
      if (q("duplicate-consent-row").hidden) throw new Error("acknowledgement still hidden");
    });
    const ack = input("duplicate-consent");
    ack.checked = true;
    fireChange(ack);
    await vi.waitFor(() => {
      if ((q("submit") as HTMLButtonElement).disabled) throw new Error("submit still disabled after ack");
    });
  });

  it("still offers the acknowledgement when the cap leaves room for another reservation", async () => {
    // beforeEach already booted the page with no cap in the payload; re-boot it so
    // /reservation-options serves this store cap.
    await setup(3);
    upcoming = [SOFT];
    await selectSlot();
    (q("step1-next") as HTMLButtonElement).click();
    await login();
    checkBaseConsents();
    expect(q("duplicate-warning").dataset.level).toBe("soft");
    expect(q("duplicate-consent-row").hidden).toBe(false);
    const ack = input("duplicate-consent");
    ack.checked = true;
    fireChange(ack);
    await vi.waitFor(() => {
      if ((q("submit") as HTMLButtonElement).disabled) throw new Error("submit still disabled after ack");
    });
  });

  it("re-displays the existing reservations read-only on the confirm panel (no second checkbox)", async () => {
    upcoming = [SOFT];
    await selectSlot();
    (q("step1-next") as HTMLButtonElement).click();
    await login();
    checkBaseConsents();
    const ack = input("duplicate-consent");
    ack.checked = true;
    fireChange(ack);
    q("reservation-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    expect(q("confirm-panel").hidden).toBe(false);
    expect(q("confirm-duplicate-notice").hidden).toBe(false);
    expect(q("confirm-duplicate-list").textContent).toContain("本店");
    // The acknowledgement checkbox is NOT re-requested on the confirm panel.
    expect(dom.window.document.querySelector("#confirm-panel #duplicate-consent")).toBeNull();
  });

  it("recovers inline (re-fetches the gate) when the server rejects with duplicate_reservation_consent_required", async () => {
    // Form loads with no upcoming reservations → no warning, no version echoed. A booking
    // appears before submit, so the server returns 409; the client must re-fetch the gate
    // and surface the warning inline instead of leaving the user stuck.
    upcoming = [];
    dupRaceAppears = [SOFT];
    await selectSlot();
    (q("step1-next") as HTMLButtonElement).click();
    await login();
    expect(q("duplicate-warning").hidden).toBe(true);
    checkBaseConsents();
    q("reservation-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    expect(q("confirm-panel").hidden).toBe(false);
    (q("confirm-submit") as HTMLButtonElement).click();
    // After the 409, the client re-runs the gate (now reporting the new reservation) and
    // the warning becomes visible on the form again.
    await vi.waitFor(() => {
      if (q("duplicate-warning").hidden) throw new Error("warning not surfaced after 409 re-gate");
    });
    expect(q("duplicate-warning-list").textContent).toContain("本店");
    expect(q("confirm-panel").hidden).toBe(true);
  });

  it("renders a hard warning (role=alert) when an existing reservation is within the lead time", async () => {
    upcoming = [HARD];
    await selectSlot();
    (q("step1-next") as HTMLButtonElement).click();
    await login();
    const warning = q("duplicate-warning");
    expect(warning.hidden).toBe(false);
    expect(warning.dataset.level).toBe("hard");
    expect(warning.getAttribute("role")).toBe("alert");
    expect(warning.getAttribute("aria-live")).toBe("assertive");
    // Hard copy: reframed as "already-confirmed reservation, accepted as an additional
    // booking" with the no-show fee consequence (not "cannot change/cancel"). Assert all
    // three lines so a future copy edit that drops a line is caught.
    const HARD_TITLE = "既に確定しているご予約があります。";
    const HARD_LINES = [
      "既に確定しているご予約に追加でご予約を承ることになります。",
      "追加のご予約によって既存のご予約を取り消す事はできません。",
      "既存のご予約日時にご来店が無い場合、施術料金・キャンセル変更料の対象となります。"
    ];
    expect(q("duplicate-warning-title").textContent).toBe(HARD_TITLE);
    const leadText = q("duplicate-warning-lead").textContent ?? "";
    for (const line of HARD_LINES) expect(leadText).toContain(line);
    // The consent checkbox is described by the lead, so all three lines reach a screen
    // reader through that single aria-describedby target.
    expect(input("duplicate-consent").getAttribute("aria-describedby")).toBe("duplicate-warning-lead");

    // The same hard copy (title + 3 lines) is re-displayed read-only on the confirm panel.
    checkBaseConsents();
    const ack = input("duplicate-consent");
    ack.checked = true;
    fireChange(ack);
    q("reservation-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    expect(q("confirm-panel").hidden).toBe(false);
    const confirmLead = q("confirm-duplicate-lead").textContent ?? "";
    expect(confirmLead).toContain(HARD_TITLE);
    for (const line of HARD_LINES) expect(confirmLead).toContain(line);
  });

  it("re-fetches the options on 409 so a stale consent version is replaced before resubmit", async () => {
    // デプロイを跨いで開きっぱなしのページ: form-load 時は旧 version、submit 時に
    // server が 409 で拒否。リカバリの loadOptions() が options を再取得して新 version
    // に更新しなければ、再送は旧 version のまま永遠に 409 になる (red/green 検証)。
    optionsVersion = "dup-warning-stale-old";
    upcoming = [];
    dupRaceAppears = [SOFT];
    nextOptionsVersion = "dup-warning-2026-08-31";
    await selectSlot();
    (q("step1-next") as HTMLButtonElement).click();
    await login();
    checkBaseConsents();
    q("reservation-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    expect(q("confirm-panel").hidden).toBe(false);
    (q("confirm-submit") as HTMLButtonElement).click();
    // 409 後: options 再取得 + gate 再取得で警告がフォームに出る。
    await vi.waitFor(() => {
      if (q("duplicate-warning").hidden) throw new Error("warning not surfaced after 409 recovery");
    });
    // 再同意して再送 → payload には更新後の version が乗る (loadOptions() を
    // 削るとここが旧 version のまま失敗する)。
    const ack = input("duplicate-consent");
    ack.checked = true;
    fireChange(ack);
    q("reservation-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    (q("confirm-submit") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      const consents = (capturedReservationBody as { consents?: Record<string, unknown> } | null)?.consents;
      if (consents?.duplicateReservationWarningVersion !== "dup-warning-2026-08-31") {
        throw new Error("resubmit did not carry the refreshed consent version");
      }
    });
  });

  it("switches to non-committal hard copy and marks the row when the existing reservation is still pending approval", async () => {
    upcoming = [HARD_PENDING];
    await selectSlot();
    (q("step1-next") as HTMLButtonElement).click();
    await login();
    const warning = q("duplicate-warning");
    expect(warning.hidden).toBe(false);
    expect(warning.dataset.level).toBe("hard");
    // 承認待ちしか無いのに「既に確定している」と断定しない。
    const PENDING_TITLE = "既にご予約のお申し込みがあります。";
    const PENDING_LINES = [
      "既存のご予約・承認待ちのお申し込みに追加で、新しいご予約を承ることになります。",
      "追加のご予約によって既存のご予約を取り消す事はできません。",
      "既存のご予約が確定している場合、ご予約日時にご来店が無いと施術料金・キャンセル変更料の対象となります。"
    ];
    expect(q("duplicate-warning-title").textContent).toBe(PENDING_TITLE);
    const leadText = q("duplicate-warning-lead").textContent ?? "";
    for (const line of PENDING_LINES) expect(leadText).toContain(line);
    // 一覧の行には承認待ちマーカーが付く。
    expect(q("duplicate-warning-list").textContent).toContain("（承認待ち）");
    // 静的な同意ラベルは status 中立 (確定済み・承認待ちのどちらにも真)。
    expect(q("duplicate-consent-label").textContent).toBe(
      "上記の既存のご予約・お申し込みはそのまま残ること、確定したご予約にご来店が無い場合は施術料金・キャンセル変更料の対象になることを理解しました"
    );

    // confirm パネル側も同じ pending 文言 + マーカー。
    checkBaseConsents();
    const ack = input("duplicate-consent");
    ack.checked = true;
    fireChange(ack);
    q("reservation-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    expect(q("confirm-panel").hidden).toBe(false);
    const confirmLead = q("confirm-duplicate-lead").textContent ?? "";
    expect(confirmLead).toContain(PENDING_TITLE);
    for (const line of PENDING_LINES) expect(confirmLead).toContain(line);
    expect(q("confirm-duplicate-list").textContent).toContain("（承認待ち）");
  });

  it("uses the non-committal copy for a mixed list and marks only the pending rows", async () => {
    // 混在ケース: pending が1件でも含まれれば non-committal 文言に倒す。
    upcoming = [HARD, HARD_PENDING];
    await selectSlot();
    (q("step1-next") as HTMLButtonElement).click();
    await login();
    expect(q("duplicate-warning-title").textContent).toBe("既にご予約のお申し込みがあります。");
    // 確定済みの行にはマーカーを付けない。
    const items = Array.from(
      dom.window.document.querySelectorAll("#duplicate-warning-list li")
    ).map((li) => li.textContent ?? "");
    expect(items).toHaveLength(2);
    expect(items.filter((text) => text.includes("（承認待ち）"))).toHaveLength(1);
  });

  it("echoes the duplicate-warning version in the submit payload when the warning was shown", async () => {
    upcoming = [SOFT];
    await selectSlot();
    (q("step1-next") as HTMLButtonElement).click();
    await login();
    checkBaseConsents();
    const ack = input("duplicate-consent");
    ack.checked = true;
    fireChange(ack);
    q("reservation-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    expect(q("confirm-panel").hidden).toBe(false);
    (q("confirm-submit") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      if (!capturedReservationBody) throw new Error("reservation not submitted yet");
    });
    const consents = (capturedReservationBody as { consents: Record<string, unknown> }).consents;
    expect(consents.duplicateReservationWarningVersion).toBe("dup-warning-2026-08-31");
  });

  it("does not send a duplicate-warning version when no warning was shown", async () => {
    upcoming = [];
    await selectSlot();
    (q("step1-next") as HTMLButtonElement).click();
    await login();
    checkBaseConsents();
    q("reservation-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    (q("confirm-submit") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      if (!capturedReservationBody) throw new Error("reservation not submitted yet");
    });
    const consents = (capturedReservationBody as { consents: Record<string, unknown> }).consents;
    expect(consents.duplicateReservationWarningVersion).toBeUndefined();
  });
});
