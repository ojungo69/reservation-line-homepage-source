import { readFileSync } from "node:fs";
import { join } from "node:path";

import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// FR-012 (specs/002-monotone-glass): the three required consents are one
// consolidated checkbox (#required-consent), while the payload keeps sending the
// three version strings unchanged and minor/duplicate consents stay independent.
// Contract: specs/002-monotone-glass/contracts/dom-api-invariants.md.

const OPTIONS_BODY = {
  ok: true,
  stores: [{ id: "st1", name: "本店", timezone: "Asia/Tokyo" }],
  services: [{ id: "s1", storeId: "st1", name: "カット｜カット", durationMinutes: 60 }],
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
  slots: [{ startAt: "2026-06-01T01:00:00.000Z", endAt: "2026-06-01T02:00:00.000Z", resourceId: "r1" }]
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

const reachConsentStep = async (): Promise<void> => {
  await selectSlot();
  (q("step1-next") as HTMLButtonElement).click();
  await login();
};

const submitViaForm = () =>
  q("reservation-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));

const submittedConsents = () =>
  (capturedReservationBody as { consents?: Record<string, unknown> } | null)?.consents;

describe("consolidated required consent (FR-012, JSDOM)", () => {
  beforeEach(() => setup());
  afterEach(() => dom?.window.close());

  it("keeps every submit path blocked until the single required consent is checked", async () => {
    await reachConsentStep();
    // Button path: stays disabled without the consolidated consent.
    expect((q("submit") as HTMLButtonElement).disabled).toBe(true);
    // Bypass paths (Enter key / scripted submit dispatch the form's submit event
    // directly): the confirm panel must not open and nothing may be POSTed.
    submitViaForm();
    expect(q("confirm-panel").hidden).toBe(true);
    expect(capturedReservationBody).toBeNull();

    const consent = input("required-consent");
    consent.checked = true;
    fireChange(consent);
    await vi.waitFor(() => {
      if ((q("submit") as HTMLButtonElement).disabled) throw new Error("submit still disabled");
    });
  });

  it("sends the three required consent versions unchanged from the single checkbox", async () => {
    await reachConsentStep();
    const consent = input("required-consent");
    consent.checked = true;
    fireChange(consent);
    submitViaForm();
    expect(q("confirm-panel").hidden).toBe(false);
    (q("confirm-submit") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      if (!capturedReservationBody) throw new Error("reservation not submitted yet");
    });
    const consents = submittedConsents();
    expect(consents?.noticeVersion).toBe("notice-v3");
    expect(consents?.cancellationPolicyVersion).toBe("cancel-v2");
    expect(consents?.privacyPolicyVersion).toBe("privacy-v4");
    // Conditional consents stay absent on the plain path.
    expect(consents?.minorGuardianVersion).toBeUndefined();
    expect(consents?.duplicateReservationWarningVersion).toBeUndefined();
  });

  it("includes minorGuardianVersion only when the independent minor consent is checked", async () => {
    await reachConsentStep();
    for (const id of ["required-consent", "minor-consent"]) {
      const cb = input(id);
      cb.checked = true;
      fireChange(cb);
    }
    submitViaForm();
    (q("confirm-submit") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      if (!capturedReservationBody) throw new Error("reservation not submitted yet");
    });
    expect(submittedConsents()?.minorGuardianVersion).toBe("minor-v1");
  });

  it("keeps the four document links outside the label and individually openable", () => {
    const { document } = dom.window;
    const row = document.getElementById("required-consent")?.closest(".consent-row");
    expect(row).not.toBeNull();
    if (!row) return;
    const links = [...row.querySelectorAll<HTMLAnchorElement>(".consent-links a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/legal/terms",
      "/legal/notice",
      "/legal/cancellation",
      "/legal/privacy"
    ]);
    const checkbox = row.querySelector<HTMLInputElement>("input[type='checkbox']");
    for (const link of links) {
      expect(link.closest("label")).toBeNull();
      expect(link.target).toBe("_blank");
      if (!checkbox) continue;
      checkbox.checked = false;
      link.click();
      expect(checkbox.checked, `${link.href} toggled the consolidated checkbox`).toBe(false);
    }
  });
});
