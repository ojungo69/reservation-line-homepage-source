import { readFileSync } from "node:fs";
import { join } from "node:path";

import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

// Behavioural test for the two customer-facing halves of the men's menu:
//
//   1. Men's menus are deliberate duplicates of the ordinary ones and differ ONLY
//      in the category prefix, so every surface WITHOUT a category heading (the
//      selected tags, the step-2 summary, the confirm panel) has to keep it.
//   2. The men's booking-window notice belongs to a store + menu selection, not to
//      a date: it must disappear the moment the customer switches to an ordinary
//      menu (even while the next availability request is still in flight), and must
//      NOT be rewritten by the 30s poll of the same selection (aria-live re-reads).

const NOTICE =
  "メンズメニューのご予約は、火曜日は営業時間内すべて、水・土・日曜日は13時以降のみ承っております（月・木曜日はメンズメニューのご予約を承っておりません）。";

const SERVICES = [
  {
    id: "womens",
    storeId: "kyoto",
    name: "脱毛｜サンプル 11 55分",
    durationMinutes: 55,
    priceAmount: 5000,
    mensMenu: false
  },
  {
    id: "mens",
    storeId: "kyoto",
    name: "メンズ｜サンプル 11 55分",
    durationMinutes: 55,
    priceAmount: 6000,
    mensMenu: true
  },
  // The admin checkbox allows this combination: flagged, but the free-form name has
  // no "メンズ｜" prefix. The flag gates the booking window, so the display must
  // follow the flag rather than the name.
  {
    id: "mens_unprefixed",
    storeId: "kyoto",
    name: "サンプル 16 15分",
    durationMinutes: 15,
    priceAmount: 3000,
    mensMenu: true
  }
];

const optionsBody = () => ({
  ok: true,
  stores: [{ id: "kyoto", name: "京都店", timezone: "Asia/Tokyo" }],
  services: SERVICES,
  resources: [{ id: "r1", storeId: "kyoto", name: "枠1" }],
  consentVersions: { notice: "1", cancellationPolicy: "1", privacyPolicy: "1", minorGuardian: "1" },
  liffId: "liff-1"
});

const jsonResponse = (body: unknown) => ({
  ok: true,
  headers: { get: () => "application/json" },
  json: async () => body
});

let dom: JSDOM;
// Set to true to make the NEXT availability request hang, so the test can look at
// the page in the state it is in while a request is in flight.
let hangNextAvailability = false;

const stubFetch = (url: string) => {
  if (url.includes("/api/public/reservation-options")) return Promise.resolve(jsonResponse(optionsBody()));
  if (url.includes("/api/public/availability")) {
    if (hangNextAvailability) return new Promise(() => {});
    // The server attaches the notice whenever the selection contains a men's menu.
    const hasMens = url.includes("mens");
    return Promise.resolve(
      jsonResponse({ ok: true, timezone: "Asia/Tokyo", slots: [], ...(hasMens ? { notice: NOTICE } : {}) })
    );
  }
  return Promise.resolve(jsonResponse({ ok: true }));
};

type MensTestExports = {
  loadAvailability: () => Promise<void>;
  updateStep2Summary: () => void;
  showConfirmPanel: () => void;
};

const setup = async () => {
  const html = readFileSync(join(process.cwd(), "public/index.html"), "utf8");
  const appJs =
    readFileSync(join(process.cwd(), "public/app.js"), "utf8") +
    "\n;window.__mensTest = { loadAvailability, updateStep2Summary, showConfirmPanel };";
  dom = new JSDOM(html, { runScripts: "outside-only", url: "https://example.com/", pretendToBeVisual: true });
  const { window } = dom;
  const win = window as unknown as Record<string, unknown> & { crypto?: { randomUUID?: () => string } };
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  win.scrollTo = () => {};
  win.fetch = vi.fn((input: unknown) => stubFetch(String(input)));
  if (!win.crypto?.randomUUID) {
    win.crypto = {
      randomUUID: () => `uuid-${Math.random().toString(16).slice(2)}`,
      getRandomValues: (arr: Uint32Array) => arr.map(() => Math.floor(Math.random() * 0xffffffff))
    } as Crypto;
  }
  window.eval(appJs);
  await vi.waitFor(() => {
    const count = window.document.querySelectorAll("#services input[name='serviceIds']").length;
    if (count === 0) throw new Error("menu not rendered yet");
  });
  return (window as unknown as Record<string, unknown>).__mensTest as MensTestExports;
};

const q = (sel: string) => dom.window.document.querySelector(sel) as HTMLElement | null;

const checkServiceByValue = (value: string, checked: boolean) => {
  const cb = q(`#services input[name='serviceIds'][value='${value}']`) as HTMLInputElement | null;
  if (!cb) throw new Error(`checkbox ${value} not found`);
  cb.checked = checked;
  cb.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
};

// #date is a select the app fills once a store + menu are chosen, so a date can
// only be picked after the selection is made.
const selectFirstDate = async () => {
  const date = q("#date") as unknown as HTMLSelectElement;
  await vi.waitFor(() => {
    if (date.options.length === 0) throw new Error("date options not rendered yet");
  });
  date.value = date.options[0].value;
};

const tagLabels = () =>
  Array.from(dom.window.document.querySelectorAll("#services-tags .services-tag")).map((tag) =>
    (tag.firstElementChild?.textContent ?? "").trim()
  );

describe("men's menu (behavioural, JSDOM)", () => {
  afterEach(() => {
    hangNextAvailability = false;
    dom?.window.close();
  });

  it("keeps the men's category wherever no category heading is shown", async () => {
    const api = await setup();
    checkServiceByValue("mens", true);

    // The picker groups by category, so the chip itself stays prefix-free.
    const chip = q("#services input[name='serviceIds'][value='mens']")
      ?.closest("label")
      ?.querySelector(".service-option-name");
    expect(chip?.textContent).toBe("サンプル 11");

    expect(tagLabels()).toEqual(["メンズ｜サンプル 11"]);

    api.updateStep2Summary();
    expect(q("#step2-summary")?.textContent).toContain("メンズ｜サンプル 11");

    api.showConfirmPanel();
    expect(q("#confirm-services")?.textContent).toContain("メンズ｜サンプル 11");
  });

  it("follows the flag, not the name, when the owner ticks the box without renaming", async () => {
    await setup();

    // Grouped under メンズ even though the name has no prefix. Without this the server
    // sorts it right after 脱毛 while the heading says その他, wedging a stray group
    // into the middle of the list with the men's restriction silently applied.
    const heading = q("#services input[name='serviceIds'][value='mens_unprefixed']")
      ?.closest(".service-category")
      ?.querySelector(".service-category-title");
    expect(heading?.textContent).toBe("メンズ");

    checkServiceByValue("mens_unprefixed", true);
    expect(tagLabels()).toEqual(["メンズ｜サンプル 16"]);
  });

  it("does not prefix ordinary menus, so the two are told apart when both are picked", async () => {
    await setup();
    checkServiceByValue("womens", true);
    expect(tagLabels()).toEqual(["サンプル 11"]);

    checkServiceByValue("mens", true);
    expect(tagLabels()).toEqual([
      "サンプル 11",
      "メンズ｜サンプル 11"
    ]);
  });

  it("shows the booking-window notice for a men's menu and keeps it across a re-poll", async () => {
    const api = await setup();
    checkServiceByValue("mens", true);
    await selectFirstDate();
    await api.loadAvailability();

    const notice = q("#slot-notice");
    expect(notice?.hasAttribute("hidden")).toBe(false);
    expect(notice?.textContent).toBe(NOTICE);

    // Same selection polled again: the node must not be TOUCHED. Equal text is not
    // enough — an aria-live region re-announces on every write, so a rewrite with
    // the identical sentence still makes screen readers read it out every 30s.
    const writes: MutationRecord[] = [];
    const observer = new dom.window.MutationObserver((records) => writes.push(...records));
    observer.observe(notice as Node, { childList: true, characterData: true, subtree: true });
    await api.loadAvailability();
    observer.disconnect();

    expect(writes).toEqual([]);
    expect(q("#slot-notice")?.textContent).toBe(NOTICE);
    expect(q("#slot-notice")?.hasAttribute("hidden")).toBe(false);
  });

  it("clears the notice as soon as the selection changes, not when the request lands", async () => {
    const api = await setup();
    checkServiceByValue("mens", true);
    await selectFirstDate();
    await api.loadAvailability();
    expect(q("#slot-notice")?.hasAttribute("hidden")).toBe(false);

    checkServiceByValue("mens", false);
    checkServiceByValue("womens", true);
    hangNextAvailability = true;
    void api.loadAvailability();

    // Still in flight — the men's notice must already be gone.
    expect(q("#slot-notice")?.hasAttribute("hidden")).toBe(true);
    expect(q("#slot-notice")?.textContent).toBe("");
  });
});
