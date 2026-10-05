import { readFileSync } from "node:fs";
import { join } from "node:path";

import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// FR-005 (specs/002-monotone-glass): category-jump menu picker (user-selected V1).
// Contracts pinned here (dom-api-invariants.md):
// - sections derive from serviceCategory() in first-appearance order, per store
// - no-separator / unknown categories render as their own sections (「その他」)
// - checkbox input[name='serviceIds'] stays the single source of selection truth
// - operator-entered names render as inert text (never markup / ids)
// - jump nav moves focus to the section heading; Escape still closes the popover

import { buildServices130 } from "../scripts/browser-verification/fixtures/services-130.mjs";

const STORE2_SERVICES = [
  { id: "b-1", storeId: "store-2", name: "フェイシャル｜毛穴ケア", durationMinutes: 60 },
  { id: "b-2", storeId: "store-2", name: "区切りなし整体", durationMinutes: 30 },
  { id: "b-3", storeId: "store-2", name: "新規部門｜モニターコース", durationMinutes: 30 },
  { id: "b-4", storeId: "store-2", name: "フェイシャル｜保湿ケア", durationMinutes: 60 }
];

const OPTIONS_BODY = {
  ok: true,
  stores: [
    { id: "store-1", name: "本店", timezone: "Asia/Tokyo" },
    { id: "store-2", name: "二号店", timezone: "Asia/Tokyo" }
  ],
  services: [...buildServices130("store-1"), ...STORE2_SERVICES],
  resources: [
    { id: "r1", storeId: "store-1", name: "枠1" },
    { id: "r2", storeId: "store-2", name: "枠1" }
  ],
  turnstile: { siteKey: "", action: "reservation-submit" },
  consentVersions: {
    notice: "1",
    cancellationPolicy: "1",
    privacyPolicy: "1",
    minorGuardian: "1",
    duplicateReservationWarning: "1"
  },
  liffId: "liff-1"
};

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => "application/json" },
  json: async () => body
});

let dom: JSDOM;

const stubFetch = (url: string) => {
  if (url.includes("/api/public/reservation-options")) return Promise.resolve(jsonResponse(OPTIONS_BODY));
  if (url.includes("/api/public/availability")) {
    return Promise.resolve(jsonResponse({ ok: true, timezone: "Asia/Tokyo", slots: [] }));
  }
  return Promise.resolve(jsonResponse({ ok: true }));
};

const setup = async () => {
  dom?.window.close();
  const html = readFileSync(join(process.cwd(), "public/index.html"), "utf8");
  const appJs = readFileSync(join(process.cwd(), "public/app.js"), "utf8");
  dom = new JSDOM(html, { runScripts: "outside-only", url: "https://example.com/", pretendToBeVisual: true });
  const { window } = dom;
  const win = window as unknown as Record<string, unknown>;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  win.scrollTo = () => {};
  // jsdom does not implement scrollIntoView; the jump nav calls it on real browsers.
  (window.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
  win.fetch = vi.fn((i: unknown) => stubFetch(String(i)));
  window.eval(appJs);
  await vi.waitFor(() => {
    if (window.document.querySelectorAll("#services input[name='serviceIds']").length === 0) {
      throw new Error("menu not rendered yet");
    }
  });
};

const doc = () => dom.window.document;
const q = (id: string): HTMLElement => {
  const el = doc().getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
};
const selectStore = (storeId: string) => {
  const store = q("store") as unknown as HTMLSelectElement;
  store.value = storeId;
  store.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
};
const sectionTitles = () =>
  [...doc().querySelectorAll("#services .service-category-title")].map((el) => el.textContent);

describe("category-jump menu picker (FR-005, JSDOM)", () => {
  beforeEach(() => setup());
  afterEach(() => dom?.window.close());

  it("renders sections per store in serviceCategory() first-appearance order", () => {
    // store-1: the 130-item fixture (脱毛→メンズ→マッサージ→フェイシャル→ネイル・フットケア
    // plus the edge-case tail in appearance order).
    const titles = sectionTitles();
    expect(titles.slice(0, 5)).toEqual(["脱毛", "メンズ", "マッサージ", "フェイシャル", "ネイル・フットケア"]);
    // store-2: unknown categories and no-separator names form their own sections,
    // still in first-appearance order (フェイシャル → その他 → 新規部門).
    selectStore("store-2");
    expect(sectionTitles()).toEqual(["フェイシャル", "その他", "新規部門"]);
  });

  it("shows only the selected store's menus", () => {
    expect(doc().querySelectorAll("#services input[name='serviceIds']")).toHaveLength(130);
    selectStore("store-2");
    expect(doc().querySelectorAll("#services input[name='serviceIds']")).toHaveLength(4);
  });

  it("keeps the checkbox contract wired to tags and totals at 130-item scale", () => {
    const checkboxes = doc().querySelectorAll<HTMLInputElement>("#services input[name='serviceIds']");
    const first = checkboxes[0];
    const last = checkboxes[checkboxes.length - 1];
    for (const cb of [first, last]) {
      cb.checked = true;
      cb.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    }
    const tags = doc().querySelectorAll("#services-tags .services-tag");
    expect(tags).toHaveLength(2);
    // Selection truth lives in the DOM checkboxes (selectedServiceIds()).
    expect(
      [...doc().querySelectorAll<HTMLInputElement>("#services input[name='serviceIds']:checked")].map(
        (cb) => cb.value
      )
    ).toEqual([first.value, last.value]);
    // The total must actually show (fixture rows carry the priceAmount app.js
    // reads) and equal the sum of the selected menus — a fixture drifting off
    // the API shape re-hides the total and fails here.
    const total = q("services-total");
    const priceOf = (id: string) => {
      // store-2 rows carry no priceAmount (that hides the total by design), so
      // the union type needs widening for this store-1-only lookup.
      const service = OPTIONS_BODY.services.find((s) => s.id === id) as
        | { priceAmount?: number }
        | undefined;
      if (typeof service?.priceAmount !== "number") throw new Error(`${id} has no priceAmount`);
      return service.priceAmount;
    };
    expect(total.hidden).toBe(false);
    const expectedTotal = priceOf(first.value) + priceOf(last.value);
    expect(total.textContent).toBe(`合計 ${expectedTotal.toLocaleString("ja-JP")}円（税込）`);
  });

  it("keeps a hidden-but-selected menu selected while more menus are picked (A+B contract)", () => {
    (q("services-trigger") as HTMLButtonElement).click();
    const search = doc().querySelector<HTMLInputElement>(".services-tools .services-search");
    expect(search).not.toBeNull();
    if (!search) return;
    const setQuery = (value: string) => {
      search.value = value;
      search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    };

    // A = the first 脱毛 menu (全身脱毛 1回コース).
    const a = doc().querySelector<HTMLInputElement>("#services input[name='serviceIds']");
    expect(a).not.toBeNull();
    if (!a) return;
    a.click();
    expect(a.checked).toBe(true);

    // Filter A out (hiragana query matching katakana「ワキ」names only), then
    // select a visible B while A is hidden.
    setQuery("わき");
    const labels = [...doc().querySelectorAll<HTMLElement>("#services .service-option")];
    const visible = labels.filter((label) => !label.hidden);
    expect(visible.length).toBeGreaterThan(1);
    for (const label of visible) {
      expect(label.textContent).toContain("ワキ");
    }
    const aLabel = a.closest<HTMLElement>(".service-option");
    expect(aLabel?.hidden).toBe(true);
    const b = visible[0].querySelector<HTMLInputElement>("input[name='serviceIds']");
    expect(b).not.toBeNull();
    if (!b) return;
    b.click();
    expect(b.checked).toBe(true);

    // Selecting B while A is hidden must not drop A: filtering only toggles
    // hidden, so A is still the SAME node, still checked, and both selections
    // surface in the tags, the checked set (what the payload reads), and the
    // total.
    expect(doc().querySelectorAll("#services input[name='serviceIds']")).toHaveLength(130);
    expect(doc().querySelector<HTMLInputElement>("#services input[name='serviceIds']")).toBe(a);
    expect(a.checked).toBe(true);

    setQuery("");
    expect(labels.filter((label) => !label.hidden)).toHaveLength(130);
    expect(doc().querySelectorAll("#services-tags .services-tag")).toHaveLength(2);
    expect(
      [...doc().querySelectorAll<HTMLInputElement>("#services input[name='serviceIds']:checked")].map(
        (cb) => cb.value
      )
    ).toEqual([a.value, b.value]);
    const priceOf = (id: string) => {
      const service = OPTIONS_BODY.services.find((s) => s.id === id) as
        | { priceAmount?: number }
        | undefined;
      if (typeof service?.priceAmount !== "number") throw new Error(`${id} has no priceAmount`);
      return service.priceAmount;
    };
    const total = q("services-total");
    expect(total.hidden).toBe(false);
    expect(total.textContent).toBe(
      `合計 ${(priceOf(a.value) + priceOf(b.value)).toLocaleString("ja-JP")}円（税込）`
    );
  });

  it("announces hit counts via a permanently-exposed live region", () => {
    (q("services-trigger") as HTMLButtonElement).click();
    const search = doc().querySelector<HTMLInputElement>(".services-search");
    const status = doc().querySelector<HTMLElement>("#services .services-search-status");
    expect(search).not.toBeNull();
    expect(status).not.toBeNull();
    if (!search || !status) return;
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.getAttribute("role")).toBe("status");
    // The live region must sit in the accessibility tree from the start —
    // [hidden] would display:none it, and the announcement of the update that
    // reveals it is not guaranteed. Only textContent may change.
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe("");

    const setQuery = (value: string) => {
      search.value = value;
      search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    };
    setQuery("わき");
    const hits = [...doc().querySelectorAll<HTMLElement>("#services .service-option")].filter(
      (label) => !label.hidden
    ).length;
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe(`${hits}件のメニューが該当`);

    setQuery("存在しないメニュー名xyz");
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe("該当するメニューがありません");
    for (const section of doc().querySelectorAll<HTMLElement>("#services .service-category")) {
      expect(section.hidden).toBe(true);
    }
    for (const button of doc().querySelectorAll<HTMLElement>(".service-cat-nav-btn")) {
      expect(button.hidden).toBe(true);
    }

    // Clearing empties the text but never re-hides the region.
    setQuery("");
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe("");
  });

  it("keeps the full forward-Tab order: nav buttons → search → checkboxes", () => {
    (q("services-trigger") as HTMLButtonElement).click();
    const search = doc().querySelector<HTMLInputElement>(".services-search");
    const navButtons = [...doc().querySelectorAll(".service-cat-nav-btn")];
    const firstCheckbox = doc().querySelector("#services input[name='serviceIds']");
    expect(search).not.toBeNull();
    expect(navButtons.length).toBeGreaterThan(1);
    expect(firstCheckbox).not.toBeNull();
    if (!search || !firstCheckbox) return;
    const follows = (a: Node, b: Node) =>
      (a.compareDocumentPosition(b) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    // LAST nav button → search → FIRST checkbox pins the whole chain — a
    // search moved after the checkboxes would break the second link.
    expect(follows(navButtons[navButtons.length - 1], search)).toBe(true);
    expect(follows(search, firstCheckbox)).toBe(true);
    // Open still lands on the first nav button (asserted in its own test), so
    // forward-Tab passes the remaining nav buttons, then search, then the list.
  });

  it("renders operator-entered names as inert text (XSS fixture)", () => {
    // The 130-item fixture ends with '<img onerror=alert(1)>｜<b>名称</b>'.
    expect(doc().querySelector("#services img")).toBeNull();
    expect(doc().querySelector("#services b")).toBeNull();
    const navText = [...doc().querySelectorAll(".service-cat-nav-btn")].map((b) => b.textContent);
    expect(navText).toContain("<img onerror=alert(1)>");
    // Section ids stay sequential — never derived from the raw category name.
    for (const group of doc().querySelectorAll("#services .service-category")) {
      expect(group.id).toMatch(/^service-category-\d+$/);
    }
  });

  it("focuses the first category button on open so forward-Tab reaches the nav", () => {
    (q("services-trigger") as HTMLButtonElement).click();
    const active = doc().activeElement as HTMLElement;
    expect(active.classList.contains("service-cat-nav-btn")).toBe(true);
    // Nav is first in DOM order, so Tab continues into the checkboxes from here.
    expect(active).toBe(doc().querySelector(".service-cat-nav-btn"));
  });

  it("skips filter-hidden nav buttons when focusing on reopen", () => {
    // Filter so the FIRST category is hidden, close, reopen: focus() on a
    // hidden element is a silent no-op that would strand keyboard focus on
    // the trigger (2026-08-02 connector finding).
    const trigger = q("services-trigger") as HTMLButtonElement;
    trigger.click();
    const search = doc().querySelector<HTMLInputElement>(".services-search");
    expect(search).not.toBeNull();
    search!.value = "マッサージ";
    search!.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    const firstNav = doc().querySelector<HTMLButtonElement>(".service-cat-nav-btn");
    expect(firstNav?.hidden).toBe(true);
    trigger.click(); // close
    trigger.click(); // reopen with the filter still applied
    const active = doc().activeElement as HTMLElement;
    expect(active.hidden).toBe(false);
    expect(active).toBe(doc().querySelector(".service-cat-nav-btn:not([hidden])"));
  });

  it("moves focus to the section heading on jump (V1 a11y contract)", () => {
    (q("services-trigger") as HTMLButtonElement).click();
    const nav = [...doc().querySelectorAll<HTMLButtonElement>(".service-cat-nav-btn")];
    const target = nav.find((b) => b.textContent === "マッサージ");
    expect(target).toBeDefined();
    target?.click();
    const active = doc().activeElement as HTMLElement;
    expect(active.classList.contains("service-category-title")).toBe(true);
    expect(active.textContent).toBe("マッサージ");
  });

  it("still closes the popover with Escape", () => {
    (q("services-trigger") as HTMLButtonElement).click();
    expect(q("services-popover").hidden).toBe(false);
    doc().dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    );
    expect(q("services-popover").hidden).toBe(true);
  });
});
