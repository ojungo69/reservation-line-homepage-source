import { readFileSync } from "node:fs";
import { join } from "node:path";

import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Behavioural test for the collapsible multi-select menu (task ②). It evaluates the
// real public/app.js inside a JSDOM window with stubbed public APIs, so it catches
// runtime errors (TDZ / ReferenceError) and verifies the dropdown trigger summary,
// the removable tags, and that multi-select still drives the checkbox state.

const OPTIONS_BODY = {
  ok: true,
  stores: [{ id: "st1", name: "本店", timezone: "Asia/Tokyo" }],
  // s1 has a price, s2 has an explicit null, s3 has NO priceLabel property at all —
  // that last shape is what the previous Worker's KV-cached options payload returns
  // for up to 60s after a deploy, and it must render the same as null.
  services: [
    { id: "s1", storeId: "st1", name: "カット｜カット", durationMinutes: 60, priceLabel: "¥5,500〜" },
    { id: "s2", storeId: "st1", name: "カット｜前髪カット", durationMinutes: 15, priceLabel: null },
    { id: "s3", storeId: "st1", name: "カラー｜フルカラー", durationMinutes: 90 }
  ] as Array<{ id: string; storeId: string; name: string; durationMinutes: number; priceLabel?: string | null }>,
  resources: [{ id: "r1", storeId: "st1", name: "枠1" }],
  consentVersions: { notice: "1", cancellationPolicy: "1", privacyPolicy: "1", minorGuardian: "1" },
  liffId: "liff-1"
};

const AVAILABILITY_BODY = { ok: true, timezone: "Asia/Tokyo", slots: [] };

const jsonResponse = (body: unknown) => ({
  ok: true,
  headers: { get: () => "application/json" },
  json: async () => body
});

const stubFetch = (url: string) => {
  if (url.includes("/api/public/reservation-options")) return Promise.resolve(jsonResponse(OPTIONS_BODY));
  if (url.includes("/api/public/availability")) return Promise.resolve(jsonResponse(AVAILABILITY_BODY));
  return Promise.resolve(jsonResponse({ ok: true }));
};

let dom: JSDOM;

const setup = async (extraJs = "") => {
  const html = readFileSync(join(process.cwd(), "public/index.html"), "utf8");
  const appJs = readFileSync(join(process.cwd(), "public/app.js"), "utf8") + extraJs;
  dom = new JSDOM(html, { runScripts: "outside-only", url: "https://example.com/", pretendToBeVisual: true });
  const { window } = dom;
  // Polyfills app.js relies on that JSDOM does not implement. Cast to a loose shim
  // type so the test can install browser globals JSDOM omits.
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
  // init() runs on eval; wait until the stubbed options have rendered the menu.
  await vi.waitFor(() => {
    const count = window.document.querySelectorAll("#services input[name='serviceIds']").length;
    if (count === 0) throw new Error("menu not rendered yet");
  });
};

const q = (sel: string) => dom.window.document.querySelector(sel) as HTMLElement | null;
const qa = (sel: string) => Array.from(dom.window.document.querySelectorAll(sel)) as HTMLElement[];

const checkServiceByValue = (value: string, checked: boolean) => {
  const cb = q(`#services input[name='serviceIds'][value='${value}']`) as HTMLInputElement | null;
  if (!cb) throw new Error(`checkbox ${value} not found`);
  cb.checked = checked;
  cb.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
};

describe("reservation menu dropdown (behavioural, JSDOM)", () => {
  // Wrap: beforeEach passes the vitest TestContext as the first argument, which must
  // not leak into setup's optional extraJs string parameter.
  beforeEach(() => setup());
  afterEach(() => dom?.window.close());

  it("renders the menu inside the collapsed popover, not as an always-open list", () => {
    expect(qa("#services input[name='serviceIds']")).toHaveLength(3);
    expect(q("#services-popover")?.hasAttribute("hidden")).toBe(true);
    expect(q("#services-trigger-text")?.textContent).toBe("メニューを選択");
  });

  it("opens and closes the popover via the trigger and Escape", () => {
    const trigger = q("#services-trigger") as HTMLButtonElement;
    trigger.click();
    expect(q("#services-popover")?.hasAttribute("hidden")).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape" }));
    expect(q("#services-popover")?.hasAttribute("hidden")).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps multi-select: choosing two menus shows a count summary and two removable tags", () => {
    checkServiceByValue("s1", true);
    checkServiceByValue("s3", true);

    expect(q("#services-trigger-text")?.textContent).toBe("2件選択中");
    expect(q("#services-trigger-text")?.classList.contains("has-selection")).toBe(true);
    const tags = qa("#services-tags .services-tag");
    expect(tags).toHaveLength(2);
    // Duration is intentionally hidden — the tag shows the bare menu label only.
    expect(tags.map((t) => t.textContent)).toContain("カット×");
  });

  it("removing a tag unchecks the underlying checkbox and updates the summary", () => {
    checkServiceByValue("s1", true);
    checkServiceByValue("s3", true);
    expect(qa("#services-tags .services-tag")).toHaveLength(2);

    // Remove the first tag.
    (qa("#services-tags .services-tag")[0] as HTMLButtonElement).click();

    const s1 = q("#services input[name='serviceIds'][value='s1']") as HTMLInputElement;
    expect(s1.checked).toBe(false);
    expect(qa("#services-tags .services-tag")).toHaveLength(1);
    expect(q("#services-trigger-text")?.textContent).toBe("1件選択中");
  });

  it("keeps keyboard focus on a remaining tag (not <body>) after a tag is removed", () => {
    checkServiceByValue("s1", true);
    checkServiceByValue("s3", true);
    const firstTag = qa("#services-tags .services-tag")[0] as HTMLButtonElement;
    firstTag.focus();
    firstTag.click();
    const active = dom.window.document.activeElement as HTMLElement;
    expect(active).not.toBe(dom.window.document.body);
    expect(active.classList.contains("services-tag")).toBe(true);
  });

  it("moves focus to the trigger when the last tag is removed", () => {
    checkServiceByValue("s1", true);
    const onlyTag = qa("#services-tags .services-tag")[0] as HTMLButtonElement;
    onlyTag.focus();
    onlyTag.click();
    expect(dom.window.document.activeElement?.id).toBe("services-trigger");
  });

  it("keeps the popover open when removing a tag (tag click does not trigger outside-close)", () => {
    checkServiceByValue("s1", true);
    checkServiceByValue("s3", true);
    (q("#services-trigger") as HTMLButtonElement).click();
    expect(q("#services-popover")?.hasAttribute("hidden")).toBe(false);
    (qa("#services-tags .services-tag")[0] as HTMLButtonElement).click();
    // Tag removal must not bubble to the document outside-click handler.
    expect(q("#services-popover")?.hasAttribute("hidden")).toBe(false);
    expect(qa("#services-tags .services-tag")).toHaveLength(1);
  });

  const chipPriceEl = (value: string) =>
    (q(`#services input[name='serviceIds'][value='${value}']`)?.closest("label") ?? null)
      ?.querySelector(".service-price") ?? null;

  it("shows the price as a second line only for menus that have one (null and missing render alike)", () => {
    expect(chipPriceEl("s1")?.textContent).toBe("¥5,500〜");
    expect(chipPriceEl("s2")).toBeNull();
    expect(chipPriceEl("s3")).toBeNull();
  });

  it("keeps the removable tags name-only (price stays out of the compact tag list)", () => {
    checkServiceByValue("s1", true);
    expect(qa("#services-tags .services-tag")[0]?.textContent).toBe("カット×");
  });

  it("distinguishes identical display names with registered prices and keeps removal precise", async () => {
    const original = OPTIONS_BODY.services;
    OPTIONS_BODY.services = [
      { id: "s1", storeId: "st1", name: "ボディ｜マッサージ 60分", durationMinutes: 60, priceLabel: "4000" },
      { id: "s2", storeId: "st1", name: "ボディ｜マッサージ 90分", durationMinutes: 90, priceLabel: "5000" }
    ];
    try {
      dom.window.close();
      await setup();
      expect(chipPriceEl("s1")?.textContent).toBe("4,000円");
      checkServiceByValue("s1", true);
      checkServiceByValue("s2", true);
      expect(qa(".services-tag").map((tag) => tag.getAttribute("aria-label"))).toEqual([
        "マッサージ（4,000円） を選択解除", "マッサージ（5,000円） を選択解除"
      ]);
      qa(".services-tag")[0].click();
      expect((q("input[value='s1']") as HTMLInputElement).checked).toBe(false);
      expect((q("input[value='s2']") as HTMLInputElement).checked).toBe(true);
      expect(qa(".services-tag")[0].textContent).toBe("マッサージ（5,000円）×");
      expect(q("#services-tags")?.textContent).not.toMatch(/60分|90分/);
    } finally {
      OPTIONS_BODY.services = original;
    }
  });

  it("renders an HTML-looking price label as plain text, never as elements", async () => {
    const original = OPTIONS_BODY.services[0].priceLabel;
    OPTIONS_BODY.services[0].priceLabel = "<b>¥100</b>";
    try {
      dom.window.close();
      await setup();
      const price = chipPriceEl("s1");
      expect(price?.textContent).toBe("<b>¥100</b>");
      expect(price?.children).toHaveLength(0);
    } finally {
      OPTIONS_BODY.services[0].priceLabel = original;
    }
  });

  it("appends the price inline in the shared step-2/step-3 formatter (name only when absent)", async () => {
    // Top-level consts inside window.eval are not reachable from a later eval, so
    // re-evaluate app.js with a test-only export appended in the same script.
    dom.window.close();
    await setup("\n;window.__fmtWithPrice = formatServiceLabelWithPrice;");
    const fmt = (dom.window as unknown as Record<string, unknown>).__fmtWithPrice as (
      service: { name: string; priceLabel?: string | null }
    ) => string;
    expect(fmt({ name: "カット｜カット 60分", priceLabel: "¥5,500" })).toBe("カット（¥5,500）");
    expect(fmt({ name: "カット｜カット 60分" })).toBe("カット");
    expect(fmt({ name: "整体 30分", priceLabel: null })).toBe("整体");
  });
});
