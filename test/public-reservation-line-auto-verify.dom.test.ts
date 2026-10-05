import { readFileSync } from "node:fs";
import { join } from "node:path";

import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

// Behavioural test (JSDOM) for auto LINE verification on page load:
// when the LIFF session is already present (opened inside the LINE app, or a cached
// external-browser session), the booking page runs the form-stage gate automatically
// at load — WITHOUT the customer pressing the "LINEでログイン" button — so the button
// morphs to "本人確認済み" and a recognized customer is pre-filled. When NOT logged in,
// the page must NOT auto-redirect: it leaves the manual button in place and only calls
// liff.login() when the button is clicked.

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
let gateCustomer: GateCustomer | null = null;
let gateAllowed = true;
// Store cap + the customer's existing reservations, for the at-cap auto-verify path.
let storeCap: number | null = null;
let gateUpcoming: unknown[] = [];
// When non-null, each /reservation-gate call parks a resolver here so a test can resolve
// the load-time auto request and a manual-click request in a controlled order.
let gateQueue: Array<(body: unknown) => void> | null = null;

const settleGate = (index: number, body: unknown): void => {
  const resolver = gateQueue?.[index];
  if (!resolver) throw new Error(`no parked gate request at index ${index}`);
  resolver(body);
};

const defaultGateBody = () =>
  gateAllowed
    ? {
        allowed: true,
        lineUserId: "U1",
        stage: "form",
        ...(gateCustomer ? { customer: gateCustomer } : {}),
        ...(gateUpcoming.length > 0 ? { upcomingReservations: gateUpcoming } : {})
      }
    : { allowed: false, reason: "line_not_friend" };

const optionsBody = () => ({
  ...OPTIONS_BODY,
  stores: [
    {
      ...OPTIONS_BODY.stores[0],
      ...(storeCap !== null ? { maxActiveReservationsPerCustomer: storeCap } : {})
    }
  ]
});

const stubFetch = (url: string) => {
  if (url.includes("/api/public/reservation-options")) return Promise.resolve(jsonResponse(optionsBody()));
  if (url.includes("/api/public/availability")) return Promise.resolve(jsonResponse(AVAILABILITY_BODY));
  if (url.includes("/api/public/reservation-gate")) {
    if (!gateQueue) return Promise.resolve(jsonResponse(defaultGateBody()));
    return new Promise((resolve) => {
      gateQueue!.push((body) => resolve(jsonResponse(body)));
    });
  }
  return Promise.resolve(jsonResponse({ ok: true }));
};

type SetupOptions = {
  loggedIn?: boolean;
  customer?: GateCustomer | null;
  allowed?: boolean;
  cap?: number | null;
  upcoming?: unknown[];
};

// Spies let tests assert the LINE OAuth redirect and how many times the LIFF SDK is
// initialised (the auto-verify + a manual click must share one liff.init()).
let loginSpy: ReturnType<typeof vi.fn>;
let initSpy: ReturnType<typeof vi.fn>;
let isLoggedInSpy: ReturnType<typeof vi.fn>;

const setup = async (options: SetupOptions = {}): Promise<void> => {
  const { loggedIn = true, customer = null, allowed = true, cap = null, upcoming = [] } = options;
  gateCustomer = customer;
  gateAllowed = allowed;
  storeCap = cap;
  gateUpcoming = upcoming;
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
  win.fetch = vi.fn((input: unknown) => stubFetch(String(input)));
  if (!win.crypto?.randomUUID) {
    win.crypto = {
      randomUUID: () => `uuid-${Math.random().toString(16).slice(2)}`,
      getRandomValues: (arr: Uint32Array) => arr.map(() => Math.floor(Math.random() * 0xffffffff))
    } as Crypto;
  }
  loginSpy = vi.fn();
  initSpy = vi.fn(async () => undefined);
  isLoggedInSpy = vi.fn(() => loggedIn);
  // Fake LINE LIFF SDK. `loggedIn` toggles the already-logged-in vs not-logged-in path;
  // login is a spy so a test can assert the OAuth redirect is (not) triggered.
  win.liff = {
    init: initSpy,
    isInClient: () => loggedIn,
    isLoggedIn: isLoggedInSpy,
    login: loginSpy,
    getIDToken: () => "id_token_1",
    getAccessToken: () => "line_access_token",
    getDecodedIDToken: () => ({ nonce: "nonce_1" }),
    requestFriendship: async () => undefined,
    permission: { query: async () => ({ state: "granted" }) },
    logout: () => {}
  };
  win.turnstile = {
    render: (_el: unknown, opts: { callback?: (t: string) => void }) => {
      opts.callback?.("turnstile-token");
      return "turnstile-widget-1";
    },
    reset: () => {},
    remove: () => {}
  };
  // Pre-register the SDK <script> ids BEFORE eval so loadExternalScript short-circuits
  // when the auto-verify (which runs during init, before any user interaction) resolves
  // the faked liff global instead of attempting a real network load.
  for (const id of ["liff-sdk", "turnstile-sdk"]) {
    const script = window.document.createElement("script");
    script.id = id;
    window.document.head.appendChild(script);
  }
  window.eval(appJs);
  await vi.waitFor(() => {
    if (window.document.querySelectorAll("#services input[name='serviceIds']").length === 0) {
      throw new Error("menu not rendered yet");
    }
  });
};

const q = (id: string): HTMLElement => {
  const el = dom.window.document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
};
const input = (id: string): HTMLInputElement => q(id) as HTMLInputElement;
const lineLoginLabel = (): string => q("line-login").querySelector(".line-login-label")?.textContent ?? "";
const stepItem = (n: number): HTMLElement =>
  dom.window.document.querySelector(`.step-item[data-step="${n}"]`) as HTMLElement;

const AT_CAP_UPCOMING = [
  {
    reservationId: "ex1",
    storeId: "st1",
    storeName: "本店",
    serviceName: "カット",
    startAt: "2026-06-02T03:00:00.000Z",
    status: "confirmed",
    isWithinLeadTime: false,
    cancelBlocked: false
  }
];

const selectSlot = async (): Promise<void> => {
  const fire = (el: HTMLElement) => el.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  const svc = dom.window.document.querySelector("#services input[name='serviceIds']") as HTMLInputElement;
  svc.checked = true;
  fire(svc);
  input("resource").value = "r1";
  fire(input("resource"));
  input("date").value = "2026-06-01";
  fire(input("date"));
  await vi.waitFor(() => {
    if (!dom.window.document.querySelector(".slot-button")) throw new Error("slot not rendered yet");
  });
  (dom.window.document.querySelector(".slot-button") as HTMLButtonElement).click();
};

describe("auto LINE verification on load (JSDOM)", () => {
  afterEach(() => {
    dom?.window.close();
    gateQueue = null;
  });

  it("verifies automatically without a button click when already LINE-logged-in", async () => {
    await setup({ loggedIn: true, customer: { displayName: "山田 花子", displayNameKana: "ヤマダ ハナコ", phoneMasked: "****5678" } });
    // No button click — the page should verify on its own.
    await vi.waitFor(() => {
      if (lineLoginLabel() !== "本人確認済み") throw new Error("not auto-verified yet");
    });
    expect(q("line-login").classList.contains("verified")).toBe(true);
    // Recognized existing customer (phone on file) → confirmation line shown, inputs hidden.
    expect(q("recognized-contact").hidden).toBe(false);
    expect(q("recognized-name").textContent).toContain("山田 花子");
    expect(q("recognized-phone").textContent).toContain("****5678");
    expect(input("display-name").disabled).toBe(true);
  });

  it("does not advance the step indicator past slot selection during auto-verify", async () => {
    await setup({ loggedIn: true, customer: { displayName: "山田 花子", displayNameKana: null, phoneMasked: "****5678" } });
    await vi.waitFor(() => {
      if (lineLoginLabel() !== "本人確認済み") throw new Error("not auto-verified yet");
    });
    // Auto-verify must NOT yank the user from slot selection (step 1) to the identity step.
    expect(stepItem(1).classList.contains("active")).toBe(true);
    expect(stepItem(2).classList.contains("active")).toBe(false);
    expect(q("step2-content").hidden).toBe(true);
  });

  it("warns an at-cap customer in #status on step 1, before any date/time is chosen", async () => {
    await setup({
      loggedIn: true,
      customer: { displayName: "山田 花子", displayNameKana: null, phoneMasked: "****5678" },
      cap: 1,
      upcoming: AT_CAP_UPCOMING
    });
    await vi.waitFor(() => {
      if (lineLoginLabel() !== "本人確認済み") throw new Error("not auto-verified yet");
    });
    // The cap reason reaches the customer while still on step 1 — before they invest
    // in choosing a date/time — via the always-visible #status, with the recovery link.
    expect(q("status").textContent).toContain("上限に達しています");
    expect(q("status").dataset.tone).toBe("danger");
    expect(stepItem(1).classList.contains("active")).toBe(true);
    expect(q("step2-content").hidden).toBe(true);
    expect(q("pending-recovery").hidden).toBe(false);
    // Selecting a slot AFTER the at-cap auto-verify must not re-enable 次へ:
    // selectSlotButton syncs its enabled state from the cap, and the click guard is
    // only a backstop (an enabled-looking button that ignores clicks is still a bug).
    await selectSlot();
    const next = q("step1-next") as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    next.click();
    expect(q("step2-content").hidden).toBe(true);
  });

  it("pulls the customer back to step 1 when a delayed at-cap auto-verify lands after they advanced to step 2", async () => {
    // The gate response is parked, so the page boots with the cap unknown.
    // Deliberately customer-LESS: today's server always couples customer with
    // upcomingReservations (resolveFormStageExtras), but the client must not depend on
    // that — applyVerifiedGate once wiped the at-cap list via clearRecognizedCustomer
    // when customer was absent, so this shape pins the defensive assignment order too.
    gateQueue = [];
    await setup({ loggedIn: true, cap: 1, upcoming: AT_CAP_UPCOMING });
    await vi.waitFor(() => {
      if (!gateQueue || gateQueue.length === 0) throw new Error("auto-verify gate request not parked yet");
    });
    // With the cap unknown the customer can legitimately advance to step 2.
    await selectSlot();
    const next = q("step1-next") as HTMLButtonElement;
    expect(next.disabled).toBe(false);
    next.click();
    expect(q("step2-content").hidden).toBe(false);
    // The delayed at-cap result lands now — it must pull the customer back to step 1
    // instead of leaving them on a form that can never submit.
    settleGate(0, defaultGateBody());
    await vi.waitFor(() => {
      if (!q("step2-content").hidden) throw new Error("still on step 2");
    });
    expect(q("group-booking").hidden).toBe(false);
    expect(next.disabled).toBe(true);
    expect(q("status").textContent).toContain("上限に達しています");
    expect(q("status").dataset.tone).toBe("danger");
  });

  it("auto-verifies a recognized customer with no phone on file (name pre-filled, inputs editable)", async () => {
    await setup({ loggedIn: true, customer: { displayName: "紙カルテ 太郎", displayNameKana: null, phoneMasked: null } });
    await vi.waitFor(() => {
      if (lineLoginLabel() !== "本人確認済み") throw new Error("not auto-verified yet");
    });
    expect(q("contact-fields").hidden).toBe(false);
    expect(input("display-name").value).toBe("紙カルテ 太郎");
    expect(input("display-name").disabled).toBe(false);
    expect(input("phone").value).toBe("");
  });

  it("does NOT auto-redirect or auto-verify when not LINE-logged-in (manual button preserved)", async () => {
    await setup({ loggedIn: false });
    // Deterministic wait: once the load-time auto-verify has consulted isLoggedIn(), its
    // (synchronous) no-redirect decision is already made — no fixed sleep needed.
    await vi.waitFor(() => {
      if (isLoggedInSpy.mock.calls.length === 0) throw new Error("auto-verify has not run yet");
    });
    expect(loginSpy).not.toHaveBeenCalled();
    expect(lineLoginLabel()).toBe("LINEでログイン");
    expect(q("line-login").classList.contains("verified")).toBe(false);
    // The manual button still works: clicking it triggers the LINE OAuth redirect, and the
    // SDK is initialised only once (the cached init promise is reused, not re-run).
    (q("line-login") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      if (loginSpy.mock.calls.length === 0) throw new Error("liff.login not called yet");
    });
    expect(loginSpy).toHaveBeenCalledTimes(1);
    expect(initSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps an auto-verified context when a near-simultaneous manual click is rate-limited", async () => {
    // Reproduces the race: the load-time auto-verify and a manual click both hit the
    // IP-rate-limited gate; the manual one comes back rate_limited. It must NOT tear down
    // the context the auto request just verified (otherwise the customer flips to
    // unverified despite a successful check).
    gateQueue = [];
    await setup({ loggedIn: true, customer: { displayName: "山田 花子", displayNameKana: null, phoneMasked: "****5678" } });
    // Auto-verify fired at load and parked gate request #0. Click the (still-enabled)
    // button before it resolves → parks the interactive gate request #1.
    await vi.waitFor(() => {
      if (gateQueue!.length < 1) throw new Error("auto gate request not in flight yet");
    });
    (q("line-login") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      if (gateQueue!.length < 2) throw new Error("manual gate request not in flight yet");
    });
    // Auto (#0) succeeds and verifies; manual (#1) is rate-limited afterwards.
    settleGate(0, { allowed: true, lineUserId: "U1", stage: "form", customer: { displayName: "山田 花子", displayNameKana: null, phoneMasked: "****5678" } });
    await vi.waitFor(() => {
      if (lineLoginLabel() !== "本人確認済み") throw new Error("auto verification not applied yet");
    });
    settleGate(1, { allowed: false, reason: "rate_limited" });
    // The manual failure branch is now triggered and timer-free (gate resolve →
    // response.json() → branch), so a single macrotask boundary deterministically drains
    // it — no fixed-delay polling. Then assert the auto-verified state survived.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lineLoginLabel()).toBe("本人確認済み");
    expect(q("line-login").classList.contains("verified")).toBe(true);
    expect(q("recognized-contact").hidden).toBe(false);
  });

  // liff.requestFriendship() は LINE アプリ内ブラウザ限定。外部ブラウザで呼ぶと SDK が
  // 投げるので呼ばない。ただしこのボタンは「友だち追加後に再確認」も兼ねているので、
  // LINE アプリ側で友だち追加を済ませて外部ブラウザのフォームに戻ってきた人が、
  // フォームを捨てずに続けられること。
  it("still rechecks the gate when 友だち追加 is pressed outside the LINE app", async () => {
    await setup({ loggedIn: true, allowed: false });
    const win = dom.window as unknown as {
      liff: { isInClient: () => boolean; requestFriendship: () => Promise<void> };
    };
    win.liff.isInClient = () => false;
    let requested = false;
    win.liff.requestFriendship = async () => {
      requested = true;
    };

    // 友だち追加ボタンが有効になるのは、手動の本人確認が line_not_friend を返した後だけ
    // (自動確認の経路は interactive でないのでボタンに触らない)。押せる状態を作る。
    (q("line-login") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      if ((q("friendship") as HTMLButtonElement).disabled) throw new Error("friendship button still disabled");
    });
    // LINE アプリ側で友だち追加を済ませて戻ってきた状態。
    gateAllowed = true;
    (q("friendship") as HTMLButtonElement).click();

    await vi.waitFor(() => {
      if (lineLoginLabel() !== "本人確認済み") throw new Error(`not verified yet: ${lineLoginLabel()}`);
    });
    // 外部ブラウザでは SDK を呼ばない (呼ぶと投げて、再確認そのものが失われる)。
    expect(requested).toBe(false);
  });

  // LIFF アプリのサイズが Full でない・Login チャネルに公式アカウントが未紐付け、
  // といった理由でも requestFriendship() は投げる。アプリ内でその失敗を素通しすると、
  // もう友だちなのに再確認が走らず、送信できないフォームから抜けられない。
  it("still rechecks the gate when requestFriendship fails inside the LINE app", async () => {
    await setup({ loggedIn: true, allowed: false });
    const win = dom.window as unknown as {
      liff: { isInClient: () => boolean; requestFriendship: () => Promise<void> };
    };
    win.liff.isInClient = () => true;
    let attempted = false;
    win.liff.requestFriendship = async () => {
      attempted = true;
      throw new Error("subwindowOpen is not allowed in this LIFF app");
    };

    (q("line-login") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      if ((q("friendship") as HTMLButtonElement).disabled) throw new Error("friendship button still disabled");
    });
    // 別のトークから友だち追加を済ませて戻ってきた状態。
    gateAllowed = true;
    (q("friendship") as HTMLButtonElement).click();

    await vi.waitFor(() => {
      if (lineLoginLabel() !== "本人確認済み") throw new Error(`not verified yet: ${lineLoginLabel()}`);
    });
    // アプリ内では SDK を呼んだ上で、その失敗を握って再確認まで進む。呼んでいなければ
    // 「投げても再確認する」を確かめたことにならない。
    expect(attempted).toBe(true);
  });

  it("names the LINE app when 友だち追加 is pressed outside it and the friendship is still missing", async () => {
    await setup({ loggedIn: true, allowed: false });
    const win = dom.window as unknown as { liff: { isInClient: () => boolean } };
    win.liff.isInClient = () => false;

    (q("line-login") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      if ((q("friendship") as HTMLButtonElement).disabled) throw new Error("friendship button still disabled");
    });
    (q("friendship") as HTMLButtonElement).click();

    await vi.waitFor(() => {
      if (!(q("line-state").textContent ?? "").includes("LINEアプリで当店公式アカウントを友だち追加")) {
        throw new Error(`unexpected line-state: ${q("line-state").textContent}`);
      }
    });
    // 追加し直せるよう、ボタンは押せるまま残す。
    expect((q("friendship") as HTMLButtonElement).disabled).toBe(false);
  });
});
