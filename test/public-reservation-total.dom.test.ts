import { readFileSync } from "node:fs";
import { join } from "node:path";

import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

// Behavioural test for the numeric total ("合計 ◯円（税込）") shown on the booking
// form. It evaluates the real public/app.js inside JSDOM and verifies the three
// display surfaces (menu-selection summary, step-2 summary card, step-3 confirm
// panel) plus the fail-closed rules: the total renders ONLY when every selected
// menu resolves to a valid numeric price, and broken combo rows hide it entirely.

type TestService = {
  id: string;
  storeId: string;
  name: string;
  durationMinutes: number;
  priceLabel?: string | null;
  priceAmount?: unknown;
  comboPriceAmount?: unknown;
  comboWithPrefix?: unknown;
};

// photo: combo pricing (1,500 alone / 1,000 with any 脱毛｜* menu).
// hair: plain numeric price. plainNoPrice: admin never registered an amount —
// and it also has NO priceAmount property, the shape a pre-deploy KV-cached
// options payload serves for up to 60s. broken: half-set combo pair.
const SERVICES: TestService[] = [
  {
    id: "photo", storeId: "st1", name: "フェイシャル｜サンプル 06", durationMinutes: 30,
    priceAmount: 1500, comboPriceAmount: 1000, comboWithPrefix: "脱毛"
  },
  { id: "hair", storeId: "st1", name: "脱毛｜ヒゲ 30分", durationMinutes: 30, priceAmount: 3000 },
  { id: "plainNoPrice", storeId: "st1", name: "カット｜カット 60分", durationMinutes: 60 },
  {
    id: "broken", storeId: "st1", name: "その他｜ケア 10分", durationMinutes: 10,
    priceAmount: 500, comboPriceAmount: 400
  }
];

const optionsBody = () => ({
  ok: true,
  stores: [{ id: "st1", name: "本店", timezone: "Asia/Tokyo" }],
  services: SERVICES,
  resources: [{ id: "r1", storeId: "st1", name: "枠1" }],
  consentVersions: { notice: "1", cancellationPolicy: "1", privacyPolicy: "1", minorGuardian: "1" },
  liffId: "liff-1"
});

const AVAILABILITY_BODY = { ok: true, timezone: "Asia/Tokyo", slots: [] };

const jsonResponse = (body: unknown) => ({
  ok: true,
  headers: { get: () => "application/json" },
  json: async () => body
});

const stubFetch = (url: string) => {
  if (url.includes("/api/public/reservation-options")) return Promise.resolve(jsonResponse(optionsBody()));
  if (url.includes("/api/public/availability")) return Promise.resolve(jsonResponse(AVAILABILITY_BODY));
  return Promise.resolve(jsonResponse({ ok: true }));
};

let dom: JSDOM;

type PriceTestExports = {
  effectiveServicePriceAmount: (service: unknown, selected: unknown[]) => number | null;
  selectionTotalAmount: (selected: unknown[]) => number | null;
  servicePriceLabel: (service: unknown, storeServices?: unknown[]) => string | null;
  updateStep2Summary: () => void;
  showConfirmPanel: () => void;
};

const setup = async () => {
  const html = readFileSync(join(process.cwd(), "public/index.html"), "utf8");
  const appJs =
    readFileSync(join(process.cwd(), "public/app.js"), "utf8") +
    "\n;window.__priceTest = { effectiveServicePriceAmount, selectionTotalAmount, servicePriceLabel, updateStep2Summary, showConfirmPanel };";
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
  return (window as unknown as Record<string, unknown>).__priceTest as PriceTestExports;
};

const q = (sel: string) => dom.window.document.querySelector(sel) as HTMLElement | null;

const checkServiceByValue = (value: string, checked: boolean) => {
  const cb = q(`#services input[name='serviceIds'][value='${value}']`) as HTMLInputElement | null;
  if (!cb) throw new Error(`checkbox ${value} not found`);
  cb.checked = checked;
  cb.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
};

const step2TotalRow = () => {
  const rows = Array.from(dom.window.document.querySelectorAll("#step2-summary .step2-row"));
  return rows.find((row) => row.querySelector(".step2-key")?.textContent === "合計") ?? null;
};

describe("reservation total price (behavioural, JSDOM)", () => {
  afterEach(() => dom?.window.close());

  it("shows the total on all three surfaces when every selected menu has a price", async () => {
    const api = await setup();
    checkServiceByValue("hair", true);

    const summaryTotal = q("#services-total");
    expect(summaryTotal?.hasAttribute("hidden")).toBe(false);
    expect(summaryTotal?.textContent).toBe("合計 3,000円（税込）");

    api.updateStep2Summary();
    expect(step2TotalRow()?.querySelector(".step2-val")?.textContent).toBe("3,000円（税込）");

    api.showConfirmPanel();
    expect(q("#confirm-total-label")?.hasAttribute("hidden")).toBe(false);
    expect(q("#confirm-total")?.hasAttribute("hidden")).toBe(false);
    expect(q("#confirm-total")?.textContent).toBe("3,000円（税込）");
  });

  it("applies the combo price when a matching-category menu is co-selected", async () => {
    await setup();
    checkServiceByValue("photo", true);
    expect(q("#services-total")?.textContent).toBe("合計 1,500円（税込）");

    // 脱毛｜ヒゲ joins the selection → photo drops to its 1,000円 combo price.
    checkServiceByValue("hair", true);
    expect(q("#services-total")?.textContent).toBe("合計 4,000円（税込）");
  });

  it("reverts to the standalone price when the combo partner is deselected", async () => {
    await setup();
    checkServiceByValue("photo", true);
    checkServiceByValue("hair", true);
    expect(q("#services-total")?.textContent).toBe("合計 4,000円（税込）");

    checkServiceByValue("hair", false);
    expect(q("#services-total")?.textContent).toBe("合計 1,500円（税込）");
  });

  it("hides the total on all three surfaces when any selected menu has no price", async () => {
    const api = await setup();
    checkServiceByValue("hair", true);
    checkServiceByValue("plainNoPrice", true);

    const summaryTotal = q("#services-total");
    expect(summaryTotal?.hasAttribute("hidden")).toBe(true);
    expect(summaryTotal?.textContent).toBe("");

    api.updateStep2Summary();
    expect(step2TotalRow()).toBeNull();

    api.showConfirmPanel();
    expect(q("#confirm-total-label")?.hasAttribute("hidden")).toBe(true);
    expect(q("#confirm-total")?.hasAttribute("hidden")).toBe(true);
  });

  it("hides the total when nothing is selected", async () => {
    await setup();
    expect(q("#services-total")?.hasAttribute("hidden")).toBe(true);
  });

  it("hides the total for a broken combo row (half-set pair) even though base is valid", async () => {
    await setup();
    checkServiceByValue("broken", true);
    expect(q("#services-total")?.hasAttribute("hidden")).toBe(true);
  });

  it("fails closed on malformed amounts (string / float / missing / out of range)", async () => {
    const api = await setup();
    const svc = (priceAmount: unknown) => ({ id: "x", name: "テスト｜X", priceAmount });
    expect(api.selectionTotalAmount([svc("1500")])).toBeNull();
    expect(api.selectionTotalAmount([svc(1500.5)])).toBeNull();
    expect(api.selectionTotalAmount([svc(undefined)])).toBeNull();
    expect(api.selectionTotalAmount([svc(-1)])).toBeNull();
    expect(api.selectionTotalAmount([svc(1_000_001)])).toBeNull();
    expect(api.selectionTotalAmount([svc(0)])).toBe(0);
  });

  it("treats malformed combo fields as broken (hide) but a stale non-matching prefix as base price", async () => {
    const api = await setup();
    const base = { id: "a", name: "その他｜A", priceAmount: 2000 };
    const partner = { id: "b", name: "脱毛｜B", priceAmount: 1000 };

    // Stale but well-formed prefix that matches nothing in the selection → base.
    const stale = { ...base, comboPriceAmount: 900, comboWithPrefix: "存在しないカテゴリ" };
    expect(api.effectiveServicePriceAmount(stale, [stale, partner])).toBe(2000);

    // Malformed pairs → null (total hidden), never a silent base fallback.
    const halfAmount = { ...base, comboPriceAmount: 900 };
    const halfPrefix = { ...base, comboWithPrefix: "脱毛" };
    const floatCombo = { ...base, comboPriceAmount: 900.5, comboWithPrefix: "脱毛" };
    const blankPrefix = { ...base, comboPriceAmount: 900, comboWithPrefix: "　 " };
    const separatorPrefix = { ...base, comboPriceAmount: 900, comboWithPrefix: "脱毛｜ヒゲ" };
    for (const brokenService of [halfAmount, halfPrefix, floatCombo, blankPrefix, separatorPrefix]) {
      expect(api.effectiveServicePriceAmount(brokenService, [brokenService, partner])).toBeNull();
    }

    // Well-formed matching combo still applies.
    const combo = { ...base, comboPriceAmount: 900, comboWithPrefix: "脱毛" };
    expect(api.effectiveServicePriceAmount(combo, [combo, partner])).toBe(900);
    // A menu never discounts against itself.
    expect(api.effectiveServicePriceAmount(combo, [combo])).toBe(2000);
  });

  it("derives the per-menu price line from priceAmount when no free-form label is set", async () => {
    const api = await setup();
    const combo = { id: "a", priceAmount: 1500, comboPriceAmount: 1000, comboWithPrefix: "脱毛" };
    const partner = { id: "b", name: "脱毛｜ヒゲ 30分" };
    // Admin's free-form label always wins over the derived text.
    expect(api.servicePriceLabel({ priceLabel: " カスタム表記 ", priceAmount: 2000 })).toBe("カスタム表記");
    // Plain numeric price → formatted yen text.
    expect(api.servicePriceLabel({ priceAmount: 3000 })).toBe("3,000円");
    // Fully-set combo pair with a selectable partner in the store → discount
    // noted inline (／ so the step-2/3 （...） wrapper never nests brackets).
    expect(api.servicePriceLabel(combo, [combo, partner])).toBe(
      "1,500円／脱毛メニューと同時予約で 1,000円",
    );
    // A stale prefix (no other menu in the category — renamed, deactivated, or
    // only the menu itself) advertises nothing: base price only, matching the
    // total which can never apply the discount.
    expect(api.servicePriceLabel(combo, [combo])).toBe("1,500円");
    expect(api.servicePriceLabel(combo, [combo, { id: "c", name: "整体 30分" }])).toBe("1,500円");
    // Fail-closed, same contract as the total: no/invalid amount shows nothing,
    // and a half-set or malformed combo row shows NO price (its total is hidden
    // too — a plausible base price next to a hidden total would contradict it).
    expect(api.servicePriceLabel({})).toBeNull();
    expect(api.servicePriceLabel({ priceAmount: "3000" })).toBeNull();
    expect(api.servicePriceLabel({ priceAmount: 500, comboPriceAmount: 400 }, [partner])).toBeNull();
    expect(api.servicePriceLabel({ priceAmount: 500, comboWithPrefix: "脱毛" }, [partner])).toBeNull();
    expect(api.servicePriceLabel({ priceAmount: 500, comboPriceAmount: 400.5, comboWithPrefix: "脱毛" }, [partner])).toBeNull();
    expect(api.servicePriceLabel({ priceAmount: 500, comboPriceAmount: 400, comboWithPrefix: "脱毛｜ヒゲ" }, [partner])).toBeNull();

    // The rendered menu list shows the derived price line for a numeric-only menu.
    const hairLabel = q("#services input[name='serviceIds'][value='hair']")?.closest("label");
    expect(hairLabel?.querySelector(".service-price")?.textContent).toBe("3,000円");
    const photoLabel = q("#services input[name='serviceIds'][value='photo']")?.closest("label");
    expect(photoLabel?.querySelector(".service-price")?.textContent).toBe(
      "1,500円／脱毛メニューと同時予約で 1,000円",
    );
    // Menus with no registered amount and broken combo rows render no price line.
    const plainLabel = q("#services input[name='serviceIds'][value='plainNoPrice']")?.closest("label");
    expect(plainLabel?.querySelector(".service-price")).toBeNull();
    const brokenLabel = q("#services input[name='serviceIds'][value='broken']")?.closest("label");
    expect(brokenLabel?.querySelector(".service-price")).toBeNull();
  });

  it("shows the derived price inside step-2 and step-3 menu labels", async () => {
    const api = await setup();
    checkServiceByValue("hair", true);

    api.updateStep2Summary();
    const rows = Array.from(dom.window.document.querySelectorAll("#step2-summary .step2-row"));
    const menuRow = rows.find((row) => row.querySelector(".step2-key")?.textContent === "メニュー");
    expect(menuRow?.querySelector(".step2-val")?.textContent).toBe("ヒゲ（3,000円）");

    api.showConfirmPanel();
    expect(q("#confirm-services")?.textContent).toBe("ヒゲ（3,000円）");
  });

  it("matches the combo category by extracted prefix, tolerating whitespace around ｜", async () => {
    const api = await setup();
    const combo = { id: "a", name: "その他｜A", priceAmount: 2000, comboPriceAmount: 900, comboWithPrefix: "脱毛" };
    // Same category rule as the admin screen's candidates: "脱毛 ｜B" (space
    // before the separator) still counts as the 脱毛 category.
    const spacedPartner = { id: "b", name: "脱毛 ｜B", priceAmount: 1000 };
    expect(api.effectiveServicePriceAmount(combo, [combo, spacedPartner])).toBe(900);
    // A partner without any category prefix never matches.
    const noCategory = { id: "c", name: "整体 30分", priceAmount: 1000 };
    expect(api.effectiveServicePriceAmount(combo, [combo, noCategory])).toBe(2000);
  });
});
