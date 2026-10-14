import { readFileSync } from "node:fs";

import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

const START_AT = "2026-06-01T01:00:00.000Z";
const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => "application/json" },
  json: async () => body
});

let dom: JSDOM;
let reservationBodies: Record<string, unknown>[];
let issueToken: (token: string) => void;
let optionsFail: boolean;
let upcomingReservations: Record<string, unknown>[];
const submitResponse = vi.fn();
const gateResponse = vi.fn();

const existingReservation = (index: number) => ({
  reservationId: `existing-example-${index}`, storeId: "st1", storeName: "架空店舗", serviceName: "架空メニュー",
  startAt: "2026-06-02T01:00:00.000Z", status: "pending_approval", isWithinLeadTime: false, cancelBlocked: false
});

const setup = async ({ cap = 3, menuCount = 1, failOptions = false, securityLoaded = true, siteKey = "example-site-key", existingCount = 0 } = {}) => {
  optionsFail = failOptions;
  upcomingReservations = Array.from({ length: existingCount }, (_, index) => existingReservation(index));
  reservationBodies = [];
  submitResponse.mockReset().mockImplementation(async () =>
    jsonResponse({ ok: true, reservationId: "reservation-example", status: "pending_approval", startAt: START_AT })
  );
  gateResponse.mockReset().mockImplementation(async () =>
    jsonResponse({ allowed: true, lineUserId: "U-example", stage: "form", upcomingReservations })
  );
  const options = {
    ok: true,
    stores: [{ id: "st1", name: "架空店舗", timezone: "Asia/Tokyo", maxActiveReservationsPerCustomer: cap }],
    services: Array.from({ length: menuCount }, (_, index) => ({
      id: `s${index + 1}`, storeId: "st1", name: `メニュー${index + 1}`, durationMinutes: 5, priceAmount: 100
    })),
    resources: [{ id: "r1", storeId: "st1", name: "枠1" }],
    turnstile: { siteKey, action: "reservation-submit" },
    consentVersions: { notice: "1", cancellationPolicy: "1", privacyPolicy: "1", minorGuardian: "1", duplicateReservationWarning: "1" },
    liffId: "example-liff"
  };
  dom = new JSDOM(readFileSync("public/index.html", "utf8"), {
    runScripts: "outside-only", url: "https://example.com/", pretendToBeVisual: true
  });
  const { window } = dom;
  // app.js uses the browser realm's clock to build selectable dates.
  const RealDate = window.Date;
  const now = Date.parse("2026-06-01T00:00:00.000Z");
  const browser = window as unknown as Record<string, unknown>;
  browser.Date = new Proxy(RealDate, {
    construct: (target, args) => Reflect.construct(target, args.length === 0 ? [now] : args),
    apply: () => new RealDate(now).toString(),
    get: (target, prop, receiver) => prop === "now" ? () => now : Reflect.get(target, prop, receiver)
  });
  browser.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  browser.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  browser.fetch = vi.fn(async (url: string, init?: { body?: string }) => {
    if (url.includes("/reservation-options")) {
      if (optionsFail) throw new TypeError("offline");
      return jsonResponse(options);
    }
    if (url.includes("/availability")) {
      return jsonResponse({ ok: true, timezone: "Asia/Tokyo", slots: [{ startAt: START_AT, endAt: "2026-06-01T01:10:00.000Z", resourceId: "r1" }] });
    }
    if (url.includes("/reservation-gate")) return gateResponse();
    if (url.includes("/reservations")) {
      reservationBodies.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
      return submitResponse();
    }
    throw new Error(`unexpected request: ${url}`);
  });
  browser.liff = {
    init: async () => undefined, isInClient: () => true, isLoggedIn: () => true,
    getIDToken: () => "example-id-token", getAccessToken: () => "example-access-token",
    getDecodedIDToken: () => ({ nonce: "example-nonce" })
  };
  if (securityLoaded) {
    browser.turnstile = {
      render: (_target: unknown, callbacks: { callback: (token: string) => void }) => {
        issueToken = callbacks.callback;
        issueToken("example-token-1");
        return "example-widget";
      },
      reset: () => {}, remove: () => {}
    };
  }
  // External SDKs are system boundaries; keep the real booking code and DOM.
  for (const id of securityLoaded ? ["liff-sdk", "turnstile-sdk"] : ["liff-sdk"]) {
    const script = window.document.createElement("script");
    script.id = id;
    window.document.head.appendChild(script);
  }
  window.eval(readFileSync("public/app.js", "utf8"));
  await vi.waitFor(() => {
    if (failOptions) expect(q("status").textContent).toContain("初期化できませんでした");
    else expect(q("line-state").textContent).toBe("本人確認が完了しました");
  });
};

const q = <T = HTMLElement>(id: string): T => {
  const node = dom.window.document.getElementById(id);
  if (!node) throw new Error(`#${id} missing`);
  return node as T;
};
const change = (node: HTMLElement) => node.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
const submitForm = () => q("reservation-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));

const prepareIdentity = async () => {
  (dom.window.document.querySelector("#services input[name='serviceIds']") as HTMLInputElement).click();
  q<HTMLSelectElement>("resource").value = "r1";
  change(q("resource"));
  q<HTMLSelectElement>("date").value = "2026-06-01";
  change(q("date"));
  await vi.waitFor(() => expect(dom.window.document.querySelector(".slot-button")).not.toBeNull());
  (dom.window.document.querySelector(".slot-button") as HTMLButtonElement).click();
  q<HTMLButtonElement>("step1-next").click();
  q<HTMLInputElement>("display-name").value = "架空 太郎";
  q<HTMLInputElement>("phone").value = "09012345678";
  q<HTMLInputElement>("required-consent").click();
  if (!q("duplicate-warning").hidden) q<HTMLInputElement>("duplicate-consent").click();
};
const prepareConfirm = async () => {
  await prepareIdentity();
  await vi.waitFor(() => expect(q<HTMLButtonElement>("submit").disabled).toBe(false));
  submitForm();
  expect(q("confirm-panel").hidden).toBe(false);
};
const completeBooking = async () => {
  await prepareConfirm();
  q<HTMLButtonElement>("confirm-submit").click();
  await vi.waitFor(() => expect(q("success-panel").hidden).toBe(false));
};

afterEach(() => dom?.window.close());

describe("F17: reservation submission feedback and recovery", () => {
  it("announces submission progress inside the visible confirmation panel", async () => {
    await setup();
    await prepareConfirm();
    submitResponse.mockImplementationOnce(() => new Promise(() => {}));
    q<HTMLButtonElement>("confirm-submit").click();
    const liveStatus = q("confirm-panel").querySelector<HTMLElement>("[role='status']");
    expect(liveStatus?.textContent).toBe("送信中です…");
    expect(liveStatus?.hidden).toBe(false);
    expect(q("reservation-form").hidden).toBe(true);
  });

  it("returns a network failure to the visible identity step and requires a fresh token for retry", async () => {
    await setup();
    await prepareConfirm();
    submitResponse.mockRejectedValueOnce(new TypeError("offline"));
    q<HTMLButtonElement>("confirm-submit").click();
    await vi.waitFor(() => expect(q("reservation-form").hidden).toBe(false));
    expect(q("confirm-panel").hidden).toBe(true);
    expect(q("step2-content").hidden).toBe(false);
    expect(q("status").textContent).toContain("通信エラーが発生しました");
    expect(q<HTMLButtonElement>("submit").disabled).toBe(true);
    q<HTMLButtonElement>("confirm-submit").click();
    expect(reservationBodies).toHaveLength(1);
    issueToken("example-token-2");
    submitForm();
    q<HTMLButtonElement>("confirm-submit").click();
    await vi.waitFor(() => expect(q("success-panel").hidden).toBe(false));
    expect(reservationBodies.map(body => body.turnstileToken)).toEqual(["example-token-1", "example-token-2"]);
    expect(reservationBodies[1].idempotencyKey).toBe(reservationBodies[0].idempotencyKey);
  });

  it("clears submission progress after success and when starting another booking", async () => {
    await setup();
    await completeBooking();
    expect(q("status").textContent).toBe("");
    q<HTMLButtonElement>("success-new").click();
    expect(q("status").textContent).toBe("");
  });
});

describe("U4: loading failures offer recovery", () => {
  it("offers an options retry and reload instructions after initialization fails", async () => {
    await setup({ failOptions: true });
    expect(q("status").textContent).toContain("再読み込み");
    expect(q<HTMLButtonElement>("init-retry").hidden).toBe(false);
    optionsFail = false;
    q<HTMLButtonElement>("init-retry").click();
    await vi.waitFor(() => expect(dom.window.document.querySelectorAll("#services input[name='serviceIds']")).toHaveLength(1));
    expect(q("init-retry").hidden).toBe(true);
    expect(q("status").textContent).toBe("");
  });

  it.each(["script error", "SDK timeout"])("puts a retry beside the security widget after %s", async failure => {
    await setup({ securityLoaded: false });
    if (failure === "SDK timeout") {
      const realTimeout = dom.window.setTimeout.bind(dom.window);
      vi.spyOn(dom.window, "setTimeout").mockImplementation((handler, delay, ...args) =>
        realTimeout(handler, delay === 150 ? 0 : delay, ...args)
      );
    }
    await prepareIdentity();
    await vi.waitFor(() => expect(dom.window.document.getElementById("turnstile-sdk")).not.toBeNull());
    q("turnstile-sdk").dispatchEvent(new dom.window.Event(failure === "script error" ? "error" : "load"));
    await vi.waitFor(() => expect(q("turnstile-status").textContent).toContain("再読み込み"));
    expect(q("turnstile-status").previousElementSibling).toBe(q("turnstile-widget"));
    expect(q("turnstile-status").getAttribute("role")).toBe("status");
    expect(q("submit-hint").textContent).toContain("セキュリティ確認");
    expect(q<HTMLButtonElement>("submit").disabled).toBe(true);
    expect(q<HTMLButtonElement>("turnstile-retry").hidden).toBe(false);

    (dom.window as unknown as Record<string, unknown>).turnstile = {
      render: (_target: unknown, callbacks: { callback: (token: string) => void }) => {
        callbacks.callback("example-recovered-token");
        return "example-widget";
      }, reset: () => {}, remove: () => {}
    };
    q<HTMLButtonElement>("turnstile-retry").click();
    await vi.waitFor(() => expect(dom.window.document.getElementById("turnstile-sdk")).not.toBeNull());
    q("turnstile-sdk").dispatchEvent(new dom.window.Event("load"));
    await vi.waitFor(() => expect(q<HTMLButtonElement>("submit").disabled).toBe(false));
    expect(q("turnstile-status").textContent).toBe("");
    expect(q("turnstile-retry").hidden).toBe(true);
    expect(q("status").textContent).toBe("");
  });

  it("explains a security check that cannot render instead of silently disabling submit", async () => {
    await setup({ siteKey: "" });
    await prepareIdentity();
    await vi.waitFor(() => expect(q("turnstile-status").textContent).toContain("セキュリティ確認を読み込めませんでした"));
    expect(q("turnstile-status").textContent).toContain("再読み込み");
    expect(q<HTMLButtonElement>("submit").disabled).toBe(true);
  });
});

describe("U5: customer input validation", () => {
  it("rejects a whitespace-only name before confirmation and allows correction", async () => {
    await setup();
    await prepareIdentity();
    q<HTMLInputElement>("display-name").value = " \u3000 ";
    submitForm();
    expect(q("confirm-panel").hidden).toBe(true);
    expect(q<HTMLInputElement>("display-name").validationMessage).toBe("お名前を入力してください");
    expect(reservationBodies).toHaveLength(0);
    q<HTMLInputElement>("display-name").value = "架空 太郎";
    q("display-name").dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    expect(q<HTMLInputElement>("display-name").checkValidity()).toBe(true);
    submitForm();
    expect(q("confirm-panel").hidden).toBe(false);
  });

  it.each(["０９０－１２３４－５６７８", "090‐1234‐5678", "＋８１（９０）１２３４ ５６７８"])("accepts Japanese phone input %s and sends normalized digits", async phone => {
    await setup();
    await prepareIdentity();
    await vi.waitFor(() => expect(q<HTMLButtonElement>("submit").disabled).toBe(false));
    q<HTMLInputElement>("phone").value = phone;
    submitForm();
    expect(q("confirm-panel").hidden).toBe(false);
    q<HTMLButtonElement>("confirm-submit").click();
    await vi.waitFor(() => expect(reservationBodies).toHaveLength(1));
    expect(reservationBodies[0].customer).toMatchObject({ phone: phone.startsWith("＋") ? "+819012345678" : "09012345678" });
  });
});

describe("U7: menu selection limit", () => {
  it("blocks a thirteenth menu visibly and lets deselection free a place", async () => {
    await setup({ menuCount: 13 });
    const menus = [...dom.window.document.querySelectorAll<HTMLInputElement>("#services input[name='serviceIds']")];
    menus.slice(0, 12).forEach(menu => menu.click());
    expect(menus[12].disabled).toBe(true);
    expect(q("services-limit-status").textContent).toBe("メニューは12件まで選択できます");
    expect(q("services-limit-status").closest("[hidden]")).toBeNull();
    menus[12].click();
    expect(menus[12].checked).toBe(false);
    expect(q("services-total").textContent).toBe("合計 1,200円（税込）");
    (q("services-tags").querySelector("button") as HTMLButtonElement).click();
    expect(menus[12].disabled).toBe(false);
    expect(q("services-limit-status").textContent).toBe("");
    menus[12].click();
    expect(menus[12].checked).toBe(true);
    expect(dom.window.document.querySelectorAll("#services input:checked")).toHaveLength(12);
  });
});

describe("U8: another booking after success", () => {
  it.each([{ cap: 1, existingCount: 0 }, { cap: 2, existingCount: 1 }])("hides another booking when the new request reaches cap $cap", async config => {
    await setup(config);
    await completeBooking();
    expect(q("success-new").hidden).toBe(true);
  });

  it("re-verifies silently when another booking is possible and shows a newly reached cap immediately", async () => {
    await setup({ cap: 3 });
    await completeBooking();
    expect(q("success-new").hidden).toBe(false);
    upcomingReservations = [existingReservation(1), existingReservation(2), existingReservation(3)];
    gateResponse.mockClear();
    q<HTMLButtonElement>("success-new").click();
    await vi.waitFor(() => expect(gateResponse).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(q("status").textContent).toContain("ご予約の上限に達しています"));
    expect(q("step2-content").hidden).toBe(true);
    expect(q<HTMLButtonElement>("step1-next").disabled).toBe(true);
    expect(q("pending-recovery").hidden).toBe(false);
    expect(q("line-login").textContent).toContain("本人確認済み");
  });
});
