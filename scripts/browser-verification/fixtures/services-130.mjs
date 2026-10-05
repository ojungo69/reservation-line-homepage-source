// 130-item synthetic menu fixture (FR-005 load test — quickstart §3).
// Shape mirrors /api/public/reservation-options services entries consumed by
// app.js (id / storeId / name "カテゴリ｜名称" / mensMenu / durationMinutes /
// priceAmount — the numeric price servicePriceLabel() and the total derive
// from; priceLabel/comboPriceAmount/comboWithPrefix stay absent = the plain
// numeric-price path).
// Includes the required edge cases: duplicate search hits, a dominant category
// with a long tail, a name without the "｜" separator (→「その他」), an unknown
// category, and an XSS-looking name that must render as inert text.

const CATEGORIES = [
  ["脱毛", 79],
  ["メンズ", 18],
  ["マッサージ", 16],
  ["フェイシャル", 11],
  ["ネイル・フットケア", 6]
];

const PARTS = [
  "全身", "顔", "うなじ", "ワキ", "腕", "ひじ下", "ひざ下", "太もも", "背中", "胸",
  "お腹", "VIO", "手の甲", "足の甲", "もみあげ", "あご", "ほほ", "鼻下", "えりあし", "指"
];

export function buildServices130(storeId = "store-1") {
  const services = [];
  let seq = 0;
  for (const [category, count] of CATEGORIES) {
    for (let i = 0; i < count; i++) {
      const part = PARTS[i % PARTS.length];
      const variant = Math.floor(i / PARTS.length) + 1;
      services.push({
        id: `svc-${String(++seq).padStart(3, "0")}`,
        storeId,
        // Duplicate-search-hit design: the same part name recurs across
        // categories and variants, so a "ワキ" search matches many items.
        name: `${category}｜サンプル ${part}脱毛 ${variant}回コース`,
        mensMenu: category === "メンズ",
        durationMinutes: 30 + (i % 4) * 15,
        priceAmount: 3000 + (i % 10) * 500
      });
    }
  }
  // Edge cases (replace the tail so the total stays 130).
  services[127].name = "サンプル 区切りなし単品メニュー"; // no「｜」→「その他」節
  services[128].name = "新カテゴリ｜サンプル 未知カテゴリのメニュー"; // unknown category
  services[129].name = '<img onerror=alert(1)>｜<b>名称</b>'; // must render as inert text
  return services;
}
