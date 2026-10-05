import { readFileSync } from "node:fs";
import { join } from "node:path";

import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// SC-003 merge gate (specs/002-monotone-glass, quickstart §3): with the
// category-jump picker, EVERY menu of EVERY store must be reachable within
// 3 control operations (tap / jump / search-input-start). This file measures
// the structural operation count exhaustively in jsdom; swipe count (scroll
// geometry) is measured in the real-browser sweep instead (jsdom has no layout).

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

const jsonResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  headers: { get: () => "application/json" },
  json: async () => body
});

let dom: JSDOM;

const setup = async () => {
  dom?.window.close();
  const html = readFileSync(join(process.cwd(), "public/index.html"), "utf8");
  const appJs = readFileSync(join(process.cwd(), "public/app.js"), "utf8");
  dom = new JSDOM(html, { runScripts: "outside-only", url: "https://example.com/", pretendToBeVisual: true });
  const { window } = dom;
  const win = window as unknown as Record<string, unknown>;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  win.scrollTo = () => {};
  (window.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
  win.fetch = vi.fn((i: unknown) => {
    const url = String(i);
    if (url.includes("/api/public/reservation-options")) return Promise.resolve(jsonResponse(OPTIONS_BODY));
    if (url.includes("/api/public/availability")) {
      return Promise.resolve(jsonResponse({ ok: true, timezone: "Asia/Tokyo", slots: [] }));
    }
    return Promise.resolve(jsonResponse({ ok: true }));
  });
  window.eval(appJs);
  await vi.waitFor(() => {
    if (window.document.querySelectorAll("#services input[name='serviceIds']").length === 0) {
      throw new Error("menu not rendered yet");
    }
  });
};

describe("menu reachability — every menu within 3 control operations (SC-003)", () => {
  beforeEach(() => setup());
  afterEach(() => dom?.window.close());

  it("reaches every menu of every store in 3 real operations via search", { timeout: 20_000 }, () => {
    const doc = dom.window.document;
    const storeSelect = doc.getElementById("store") as unknown as HTMLSelectElement;
    const trigger = doc.getElementById("services-trigger") as unknown as HTMLButtonElement;
    const popover = doc.getElementById("services-popover") as unknown as HTMLElement;
    const stores = OPTIONS_BODY.stores.map((s) => s.id);
    const measured: Array<{ storeId: string; serviceId: string; operations: number }> = [];

    // Mirrors normalizeSearchText in app.js. Note NFKC folds the fullwidth
    // 「｜」separator to "|", so the suffix split below uses the halfwidth bar.
    const normalize = (text: string) =>
      text
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[ぁ-ゖ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60));

    for (const storeId of stores) {
      storeSelect.value = storeId;
      storeSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true }));

      const expected = OPTIONS_BODY.services.filter((s) => s.storeId === storeId);

      for (const service of expected) {
        // Every menu starts from the closed popover so each count is honest —
        // the operations below are performed for real (click / input / checked),
        // not merely tallied. The gate exercises the SEARCH path: it is the
        // path that makes the ≤3-swipe cap hold for the tail of the largest
        // category, so it must fail this test if filtering breaks.
        expect(popover.hidden, `${service.id}: popover should start closed`).toBe(true);
        let operations = 0;

        trigger.click(); // operation 1: open the picker
        operations += 1;
        expect(popover.hidden).toBe(false);

        const checkbox = doc.querySelector<HTMLInputElement>(
          `#services input[name='serviceIds'][value='${service.id}']`
        );
        expect(checkbox, `${storeId}/${service.id} has no checkbox`).not.toBeNull();
        if (!checkbox) continue;
        const section = checkbox.closest<HTMLElement>(".service-category");
        expect(section, `${service.id} outside a category section`).not.toBeNull();

        const search = doc.querySelector<HTMLInputElement>(".services-search");
        expect(search, "search input missing from the tools bar").not.toBeNull();
        if (!search) continue;
        const normalized = normalize(service.name);
        const query = normalized.includes("|")
          ? normalized.split("|").slice(1).join("|")
          : normalized;
        search.value = query; // operation 2: type the menu name (1 op per SC-003)
        search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        operations += 1;
        // The target must actually survive the filter — hidden target = the
        // search path is broken and this gate must go red.
        const label = checkbox.closest<HTMLElement>(".service-option");
        expect(label?.hidden, `${service.id} filtered out by its own name`).toBe(false);
        expect(section?.hidden, `${service.id}'s section filtered out`).toBe(false);
        expect(popover.hidden).toBe(false);

        checkbox.click(); // operation 3: select the menu
        operations += 1;
        expect(checkbox.checked).toBe(true);
        const tags = [...doc.querySelectorAll("#services-tags .services-tag")];
        expect(tags.length, `${service.id}: selection must surface as a tag`).toBe(1);

        expect(operations, `${storeId}/${service.id} needs ${operations} ops`).toBeLessThanOrEqual(3);
        measured.push({ storeId, serviceId: service.id, operations });

        // Cleanup (not counted): clear the filter, deselect, close.
        search.value = "";
        search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        checkbox.click();
        expect(checkbox.checked).toBe(false);
        trigger.click();
        expect(popover.hidden).toBe(true);
      }
    }

    // Exhaustive: every fixture menu across every store was measured (130
    // synthetic + 4 store-2 edge cases).
    expect(measured).toHaveLength(OPTIONS_BODY.services.length);
    expect(measured).toHaveLength(134);
  });

  it("keeps the category-jump path working (focus lands on the heading)", () => {
    const doc = dom.window.document;
    const trigger = doc.getElementById("services-trigger") as unknown as HTMLButtonElement;
    trigger.click();
    const nav = [...doc.querySelectorAll<HTMLButtonElement>(".service-cat-nav-btn")];
    expect(nav.length).toBeGreaterThan(1);
    for (const button of nav) {
      button.click();
      const active = doc.activeElement as HTMLElement;
      expect(active.classList.contains("service-category-title")).toBe(true);
      expect(active.textContent).toBe(button.textContent);
      // Heading semantics: screen-reader heading navigation must see the
      // category sections, not just this jump nav.
      expect(active.getAttribute("role")).toBe("heading");
      expect(active.getAttribute("aria-level")).toBe("3");
      expect((doc.getElementById("services-popover") as HTMLElement).hidden).toBe(false);
    }
  });
});
