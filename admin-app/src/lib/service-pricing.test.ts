import { describe, expect, it } from "vitest";

import serviceDisplayCases from "../../../test/fixtures/service-display-cases.json";

import {
  MAX_SERVICE_NAME_LENGTH,
  bodyOfName,
  buildPricingPayload,
  categoryCandidates,
  categoryOfName,
  composeServiceName,
  composedNameError,
  displayServiceName,
  isStalePrefix,
  parseAmountInput,
  prefixCandidates,
} from "./service-pricing";

describe("parseAmountInput", () => {
  it("empty and whitespace mean not-set (null), never 0", () => {
    expect(parseAmountInput("")).toBeNull();
    expect(parseAmountInput("   ")).toBeNull();
  });

  it("accepts integer yen in range", () => {
    expect(parseAmountInput("0")).toBe(0);
    expect(parseAmountInput("1500")).toBe(1500);
    expect(parseAmountInput("1000000")).toBe(1_000_000);
  });

  it("rejects floats, negatives, overflow, and junk", () => {
    expect(parseAmountInput("1500.5")).toBe("invalid");
    expect(parseAmountInput("-1")).toBe("invalid");
    expect(parseAmountInput("1000001")).toBe("invalid");
    expect(parseAmountInput("abc")).toBe("invalid");
  });
});

describe("buildPricingPayload", () => {
  it("empty base clears the combo pair too", () => {
    expect(buildPricingPayload({ priceAmountInput: "", comboPriceInput: "900", comboPrefix: "脱毛" })).toEqual({
      ok: true,
      payload: { priceAmount: null, comboPriceAmount: null, comboWithPrefix: null },
    });
  });

  it("full combo pair round-trips", () => {
    expect(buildPricingPayload({ priceAmountInput: "1500", comboPriceInput: "1000", comboPrefix: "脱毛" })).toEqual({
      ok: true,
      payload: { priceAmount: 1500, comboPriceAmount: 1000, comboWithPrefix: "脱毛" },
    });
  });

  it("base only (no combo) sends nulls for the pair", () => {
    expect(buildPricingPayload({ priceAmountInput: "1500", comboPriceInput: "", comboPrefix: "" })).toEqual({
      ok: true,
      payload: { priceAmount: 1500, comboPriceAmount: null, comboWithPrefix: null },
    });
  });

  it("half-set combo is invalid in both directions", () => {
    expect(buildPricingPayload({ priceAmountInput: "1500", comboPriceInput: "1000", comboPrefix: "" }).ok).toBe(false);
    expect(buildPricingPayload({ priceAmountInput: "1500", comboPriceInput: "", comboPrefix: "脱毛" }).ok).toBe(false);
  });

  it("malformed amounts surface the offending field", () => {
    const badBase = buildPricingPayload({ priceAmountInput: "15.5", comboPriceInput: "", comboPrefix: "" });
    expect(badBase.ok === false && badBase.field).toBe("price");
    const badCombo = buildPricingPayload({ priceAmountInput: "1500", comboPriceInput: "-5", comboPrefix: "脱毛" });
    expect(badCombo.ok === false && badCombo.field).toBe("comboPrice");
  });
});

const SERVICES = [
  { storeId: "st1", name: "脱毛｜ヒゲ 30分" },
  { storeId: "st1", name: "脱毛｜全身 60分" },
  { storeId: "st1", name: "フェイシャル｜サンプル 06" },
  { storeId: "st1", name: "整体 30分" },
  { storeId: "st2", name: "ネイル｜ケア 30分" },
];

describe("prefixCandidates", () => {
  it("dedupes per store in appearance order, skips prefix-less names", () => {
    expect(prefixCandidates(SERVICES, "st1")).toEqual(["脱毛", "フェイシャル"]);
    expect(prefixCandidates(SERVICES, "st2")).toEqual(["ネイル"]);
  });

  it("excludes prefixes the API would reject (over 40 chars)", () => {
    const long = [{ storeId: "st1", name: `${"あ".repeat(41)}｜メニュー` }];
    expect(prefixCandidates(long, "st1")).toEqual([]);
  });
});

describe("isStalePrefix", () => {
  it("true only for a saved prefix with zero matching menus in the store", () => {
    expect(isStalePrefix("脱毛", SERVICES, "st1")).toBe(false);
    expect(isStalePrefix("存在しない", SERVICES, "st1")).toBe(true);
    expect(isStalePrefix("ネイル", SERVICES, "st1")).toBe(true);
    expect(isStalePrefix(null, SERVICES, "st1")).toBe(false);
    expect(isStalePrefix("", SERVICES, "st1")).toBe(false);
  });

  it("treats a category whose menus are all inactive as stale (they never reach the booking screen)", () => {
    const inactiveOnly = [{ storeId: "st1", name: "脱毛｜ヒゲ 30分", active: false }];
    expect(isStalePrefix("脱毛", inactiveOnly, "st1")).toBe(true);
    const oneStillActive = [
      { storeId: "st1", name: "脱毛｜ヒゲ 30分", active: false },
      { storeId: "st1", name: "脱毛｜全身 60分", active: true },
    ];
    expect(isStalePrefix("脱毛", oneStillActive, "st1")).toBe(false);
  });

  it("matches by extracted category, tolerating whitespace around the ｜ separator", () => {
    const spaced = [{ storeId: "st1", name: "脱毛 ｜ヒゲ 30分" }];
    expect(isStalePrefix("脱毛", spaced, "st1")).toBe(false);
  });

  it("excludes the menu being edited: a self-only category is stale (no discount partner exists)", () => {
    const selfOnly = [{ id: "svc1", storeId: "st1", name: "脱毛｜ヒゲ 30分" }];
    expect(isStalePrefix("脱毛", selfOnly, "st1", "svc1")).toBe(true);
    const withPartner = [
      { id: "svc1", storeId: "st1", name: "脱毛｜ヒゲ 30分" },
      { id: "svc2", storeId: "st1", name: "脱毛｜全身 60分" },
    ];
    expect(isStalePrefix("脱毛", withPartner, "st1", "svc1")).toBe(false);
    // Without currentServiceId (or ids on the list) behaviour is unchanged.
    expect(isStalePrefix("脱毛", selfOnly, "st1")).toBe(false);
  });
});

describe("displayServiceName", () => {
  it("strips the category prefix but keeps the trailing duration", () => {
    expect(displayServiceName("脱毛｜全身脱毛 60分")).toBe("全身脱毛 60分");
  });

  it("keeps the メンズ｜ prefix (same-name duplicates stay distinguishable)", () => {
    expect(displayServiceName("メンズ｜全身脱毛 60分")).toBe("メンズ｜全身脱毛 60分");
  });

  it("returns names without a category unchanged", () => {
    expect(displayServiceName("カット 30分")).toBe("カット 30分");
  });

  it("applies per segment on ' / '-joined multi-menu strings", () => {
    expect(displayServiceName("脱毛｜全身脱毛 60分 / メンズ｜サンプル 10 / フェイシャル 45分")).toBe(
      "全身脱毛 60分 / メンズ｜サンプル 10 / フェイシャル 45分",
    );
  });

  it("is safe on null / undefined / empty", () => {
    expect(displayServiceName(null)).toBe("");
    expect(displayServiceName(undefined)).toBe("");
    expect(displayServiceName("")).toBe("");
  });

  it("matches the shared display contract fixture (drift guard vs calendar-sync)", () => {
    // Same fixture as test/google-calendar-sync.test.ts — changing the display
    // contract on one side without the other breaks that side's test.
    expect(serviceDisplayCases.cases.length).toBeGreaterThan(0);
    for (const { input, expected } of serviceDisplayCases.cases) {
      expect(displayServiceName(input)).toBe(expected);
    }
  });
});

describe("composeServiceName / bodyOfName round-trip", () => {
  it("splits and recomposes real production-shaped names losslessly", () => {
    const names = [
      "脱毛｜全身脱毛（フォト付き）",
      "メンズ｜サンプル 23",
      "ネイル・フットケア｜サンプル 01",
      "マッサージ｜サンプル 05",
    ];
    for (const name of names) {
      const category = categoryOfName(name) ?? "";
      expect(composeServiceName(category, bodyOfName(name))).toBe(name);
    }
  });

  it("returns the body unchanged for names without a category", () => {
    expect(bodyOfName("カット 30分")).toBe("カット 30分");
    expect(composeServiceName("", "カット 30分")).toBe("カット 30分");
  });

  it("trims category and body before composing", () => {
    expect(composeServiceName(" 脱毛 ", " 全身 ")).toBe("脱毛｜全身");
  });

  it("keeps only the first ｜ as the separator (body may contain none)", () => {
    // 本番データは全件区切り1個 (2026-07-31 実測 137件)。分解は最初の ｜ のみで行う。
    expect(bodyOfName("脱毛｜全身")).toBe("全身");
    expect(categoryOfName("脱毛｜全身")).toBe("脱毛");
  });
});

describe("categoryCandidates", () => {
  it("店舗のカテゴリを出現順 dedup で返し、40文字超も combo 用と違い除外しない", () => {
    const longCategory = "リ".repeat(45);
    const services = [
      { storeId: "store-1", name: "脱毛｜全身" },
      { storeId: "store-1", name: "脱毛｜腕" },
      { storeId: "store-1", name: `${longCategory}｜特別コース` },
      { storeId: "store-1", name: "カテゴリなし単品" },
      { storeId: "store-2", name: "他店舗｜メニュー" },
    ];
    expect(categoryCandidates(services, "store-1")).toEqual(["脱毛", longCategory]);
    // combo 用の prefixCandidates はサーバの comboWithPrefix 40文字上限に合わせて除外する
    expect(prefixCandidates(services, "store-1")).toEqual(["脱毛"]);
  });
});

describe("composedNameError", () => {
  // サーバ (settings-common.ts trimAndCap + MAX_NAME_LENGTH=100) は超過を切り詰めず
  // 拒否する。クライアント上限がサーバと同じであることをここで固定する。
  it("合計100文字ちょうどは許可し、101文字は拒否する (区切り｜も1文字に数える)", () => {
    const category = "あ".repeat(40);
    // 40 + 1 (｜) + 59 = 100
    expect(composedNameError(category, "い".repeat(59))).toBeNull();
    // 40 + 1 (｜) + 60 = 101
    expect(composedNameError(category, "い".repeat(60))).toMatch(/長すぎます/);
    expect(MAX_SERVICE_NAME_LENGTH).toBe(100);
  });

  it("カテゴリなしなら名前単体の長さで判定する", () => {
    expect(composedNameError("", "あ".repeat(100))).toBeNull();
    expect(composedNameError("", "あ".repeat(101))).toMatch(/長すぎます/);
  });

  it("trim 後の長さで判定する (未編集保存の誤検知を防ぐ)", () => {
    expect(composedNameError(" あ ", ` ${"い".repeat(98)} `)).toBeNull();
  });
});
