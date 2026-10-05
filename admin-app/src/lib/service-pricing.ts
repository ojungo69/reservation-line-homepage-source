// Pure helpers for the numeric menu pricing inputs (price_amount /
// combo_price_amount / combo_with_prefix). Kept free of React so they run
// under the node-only admin test suite.

export type PricingPayload = {
  priceAmount: number | null;
  comboPriceAmount: number | null;
  comboWithPrefix: string | null;
};

export type PricingInvalid = {
  field: "price" | "comboPrice" | "comboPrefix";
  message: string;
};

const AMOUNT_MAX = 1_000_000;

// Empty input means "not set" (null) — never 0: Number("") is 0, which would
// silently register a free menu. Anything non-empty must parse to an integer
// yen amount in range.
export const parseAmountInput = (raw: string): number | null | "invalid" => {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value >= 0 && value <= AMOUNT_MAX ? value : "invalid";
};

// Builds the 3-field API payload from the raw input strings, enforcing the
// pair invariant client-side: combo needs both its amount and category, and a
// cleared base price clears the combo too (the UI hides the combo fields when
// base is empty, but the payload must hold regardless of UI state).
export const buildPricingPayload = (input: {
  priceAmountInput: string;
  comboPriceInput: string;
  comboPrefix: string;
}): { ok: true; payload: PricingPayload } | ({ ok: false } & PricingInvalid) => {
  const priceAmount = parseAmountInput(input.priceAmountInput);
  if (priceAmount === "invalid") {
    return { ok: false, field: "price", message: "料金は0〜1,000,000円の整数で入力してください" };
  }
  if (priceAmount === null) {
    return { ok: true, payload: { priceAmount: null, comboPriceAmount: null, comboWithPrefix: null } };
  }
  const comboPriceAmount = parseAmountInput(input.comboPriceInput);
  if (comboPriceAmount === "invalid") {
    return { ok: false, field: "comboPrice", message: "組み合わせ時料金は0〜1,000,000円の整数で入力してください" };
  }
  const comboPrefix = input.comboPrefix.trim();
  if ((comboPriceAmount === null) !== (comboPrefix === "")) {
    return {
      ok: false,
      field: comboPrefix === "" ? "comboPrefix" : "comboPrice",
      message: "組み合わせ割引は対象カテゴリと料金の両方を入力してください",
    };
  }
  return {
    ok: true,
    payload: {
      priceAmount,
      comboPriceAmount,
      comboWithPrefix: comboPrefix === "" ? null : comboPrefix,
    },
  };
};

// Category of a menu name: the trimmed segment before the first ｜, or null
// when there is no category prefix. The public booking screen's combo matching
// (comboCategoryOf in public/app.js) uses the SAME rule — keep them in sync so
// a category offered here always matches on the booking screen.
export const categoryOfName = (name: string): string | null => {
  const separator = name.indexOf("｜");
  if (separator <= 0) return null;
  const category = name.slice(0, separator).trim();
  return category === "" ? null : category;
};

// カテゴリ選択制ダイアログ用の分解・合成。categoryOfName と同じ「最初の全角｜」
// 規約で、分解→再合成が保存済み name を必ず復元することを service-pricing.test.ts
// の round-trip テストで担保する。
export const bodyOfName = (name: string): string =>
  categoryOfName(name) === null ? name : name.slice(name.indexOf("｜") + 1);

export const composeServiceName = (category: string, body: string): string => {
  const trimmedCategory = category.trim();
  const trimmedBody = body.trim();
  return trimmedCategory === "" ? trimmedBody : `${trimmedCategory}｜${trimmedBody}`;
};

// サーバ (src/admin/settings-common.ts の trimAndCap + MAX_NAME_LENGTH=100) は
// 100文字超の name を切り詰めず invalid_request で拒否し、管理画面には汎用エラー
// しか出ない。合成後の長さをクライアントで検証してフィールドに紐づけて出す。
export const MAX_SERVICE_NAME_LENGTH = 100;

export const composedNameError = (category: string, body: string): string | null =>
  composeServiceName(category, body).length > MAX_SERVICE_NAME_LENGTH
    ? `カテゴリを含めたメニュー名が長すぎます。合計${MAX_SERVICE_NAME_LENGTH}文字以内になるよう短くしてください`
    : null;

// Display name for stored service-name snapshots ("カテゴリ｜メニュー名"; multi-menu
// bookings join segments with " / "). Strips the category prefix per segment —
// same contract as sanitizeServiceNamesForCalendarSummary (src/google/
// calendar-sync.ts), keep the two in sync:
// - "メンズ｜" is KEPT: men's menus are name-duplicates of the ordinary ones and
//   become indistinguishable without the prefix.
// - Trailing treatment durations ("60分") are KEPT — admins read them at a glance.
// Menu MANAGEMENT screens (menu.tsx, service dialogs) and the create panel's
// picker deliberately do not use this: they need the raw category for editing
// and grouping.
const MENS_CATEGORY_PREFIX = "メンズ｜";
const MULTI_MENU_JOIN = " / ";

const stripCategoryFromSegment = (segment: string): string => {
  if (segment.startsWith(MENS_CATEGORY_PREFIX)) return segment;
  const separator = segment.indexOf("｜");
  return separator === -1 ? segment : segment.slice(separator + 1);
};

export const displayServiceName = (name: string | null | undefined): string => {
  if (!name) return "";
  return name.split(MULTI_MENU_JOIN).map(stripCategoryFromSegment).join(MULTI_MENU_JOIN);
};

// Category candidates for the combo select: the ｜-prefixes of the store's menu
// names, deduplicated in appearance order. Prefixes the API would reject
// (over 40 chars) are excluded rather than offered and bounced.
export const prefixCandidates = (
  services: ReadonlyArray<{ storeId: string; name: string }>,
  storeId: string,
): string[] => {
  const seen = new Set<string>();
  for (const service of services) {
    if (service.storeId !== storeId) continue;
    const prefix = categoryOfName(service.name);
    if (prefix !== null && prefix.length <= 40) seen.add(prefix);
  }
  return [...seen];
};

// メニュー自体のカテゴリ候補: 店舗のメニュー名の ｜ プレフィックスを出現順で dedup
// したもの。combo 用の prefixCandidates と違い長さで除外しない — comboWithPrefix は
// サーバが40文字で拒否するが、カテゴリ自体は合成 name が100文字以内なら受理される
// ため、旧UI・API 直経由の40文字超カテゴリにも新しいメニューを追加できる必要がある。
export const categoryCandidates = (
  services: ReadonlyArray<{ storeId: string; name: string }>,
  storeId: string,
): string[] => {
  const seen = new Set<string>();
  for (const service of services) {
    if (service.storeId !== storeId) continue;
    const prefix = categoryOfName(service.name);
    if (prefix !== null) seen.add(prefix);
  }
  return [...seen];
};

// A saved prefix whose discount can never apply right now: no ACTIVE menu in
// the store falls in that category (renamed, deleted, or all deactivated —
// inactive menus never appear on the public booking screen, so they cannot
// trigger the combo). The menu owning the prefix is excluded via
// currentServiceId, because the public calculation never discounts a menu
// against itself. Worth a warning on the detail panel, not an API error.
export const isStalePrefix = (
  prefix: string | null | undefined,
  services: ReadonlyArray<{ id?: string; storeId: string; name: string; active?: boolean }>,
  storeId: string,
  currentServiceId?: string,
): boolean => {
  if (typeof prefix !== "string" || prefix.trim() === "") return false;
  const needle = prefix.trim();
  return !services.some(
    (service) =>
      service.storeId === storeId &&
      service.active !== false &&
      (currentServiceId === undefined || service.id !== currentServiceId) &&
      categoryOfName(service.name) === needle,
  );
};
