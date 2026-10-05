export type JstDateParts = {
  year: number;
  month: number;
  day: number;
};

const pad2 = (value: number) => value.toString().padStart(2, "0");

export const jstDateParts = (nowMs: number): JstDateParts => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(nowMs));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    year: Number(value("year")),
    month: Number(value("month")),
    day: Number(value("day"))
  };
};

export const jstDayKey = (nowMs: number): string => {
  const parts = jstDateParts(nowMs);
  return `${parts.year.toString().padStart(4, "0")}-${pad2(parts.month)}-${pad2(parts.day)}`;
};

export type JstDayRange = {
  startAt: string;
  endAt: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const toIso = (ms: number) => new Date(ms).toISOString();

const jstDayRangeFromParts = (parts: JstDateParts, offsetDays = 0): JstDayRange => {
  const startMs = Date.UTC(parts.year, parts.month - 1, parts.day + offsetDays, -9, 0, 0, 0);
  return {
    startAt: toIso(startMs),
    endAt: toIso(startMs + DAY_MS)
  };
};

export const jstDayRange = (nowMs: number, offsetDays = 0): JstDayRange =>
  jstDayRangeFromParts(jstDateParts(nowMs), offsetDays);

export const isJstDayKey = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value);

export const jstDayRangeFromKey = (dayKey: string): JstDayRange | null => {
  if (!isJstDayKey(dayKey)) return null;
  const year = Number(dayKey.slice(0, 4));
  const month = Number(dayKey.slice(5, 7));
  const day = Number(dayKey.slice(8, 10));
  const startMs = Date.UTC(year, month - 1, day, -9, 0, 0, 0);
  if (jstDayKey(startMs) !== dayKey) return null;
  return {
    startAt: toIso(startMs),
    endAt: toIso(startMs + DAY_MS)
  };
};

// 日本の番号は「+81 90-1234-5678」「81 90-1234-5678」「090-1234-5678」の 3 通りで書ける。
// 同じ番号が別文字列のまま保存されると phone_hash も別値になり、**電話番号に効かせている
// ブロックが表記を変えるだけで迂回できる** (issue #639)。ブロック判定はアプリ 3 経路と
// migrations/0052 のトリガの計 4 箇所あるが、4 つとも「保存済みハッシュの完全一致」を
// 前提にしているので、揃えるべき場所は保存する文字列そのもの。
//
// 寄せ先は国内表記 (0 始まり)。保存済みの国内表記と同じ形式へ正規化する。
//
const PHONE_PATTERN = /^\+?\d{8,16}$/;
const JAPAN_COUNTRY_CODE_PATTERN = /^\+?81/;
// 国内表記の日本の番号。市外局番を含めて 10 桁 (固定電話) か 11 桁 (携帯・IP) で、0 始まり。
const JAPAN_DOMESTIC_PATTERN = /^0\d{9,10}$/;
// 携帯 (090/080/070/060) と IP 電話 (050)。いずれも 0X0 + 8 桁 = 11 桁。060 は
// 携帯番号の枯渇に備えて後から割り当てが始まった帯で、大阪の市外局番 06 とは
// 桁数で分かれる (06 の固定電話は 10 桁)。
const JAPAN_MOBILE_PATTERN = /^0[56789]0\d{8}$/;

/**
 * 日本の国番号で書かれた番号を国内表記へ寄せる。寄せた結果が日本の番号として
 * 成立しないものは `undefined` を返す (呼び出し側が**元の入力**を残す)。読み替え後の
 * 途中形を返すと、`0081…` のように寄せきれなかった値が `+81…` に化けて保存され、
 * backfill 側 (`scripts/backfill-phone-canonical.mjs` の `canonicalizePhone`) と食い違う。
 *
 * **"+" の有無で判定を変えている。**
 *
 * - `+81…` は書いた本人が「これは国番号だ」と宣言しているので、寄せた形が国内表記
 *   (0 始まりの 10〜11 桁) になれば寄せる。
 * - `81…` (+ なし) は国番号とは限らない。ブラジルの国内表記は市外局番 81 で始まり、
 *   `81912345678` を機械的に落とすと `0912345678` という別人の番号に化ける。桁数だけでは
 *   日本の固定電話の国番号表記 (81 + 9 桁 = 11 桁) と見分けが付かないので、**携帯に
 *   限って**寄せる。携帯は寄せる前が 81 + 10 桁 = 12 桁になり、81 を市外局番に持つ国の
 *   国内表記 (最長 11 桁) と長さで分かれる。
 *
 * issue #639 の迂回に実際に使われるのは携帯番号なので、この条件でも穴は塞がる。
 * 残るのは「ブロック対象の固定電話を + 無しの国番号表記で書き直す」経路だけで、
 * `+81` 表記のほうは引き続き寄せる。
 */
const toDomesticJapanPhone = (value: string): string | undefined => {
  if (!JAPAN_COUNTRY_CODE_PATTERN.test(value)) {
    return undefined;
  }
  // 「+81 090-…」のように国番号の後ろに国内プレフィックスの 0 を残したまま書く人が
  // いるので、寄せる前に落とす。
  const candidate = "0" + value.replace(JAPAN_COUNTRY_CODE_PATTERN, "").replace(/^0+/, "");
  const accepted = value.startsWith("+")
    ? JAPAN_DOMESTIC_PATTERN.test(candidate)
    : JAPAN_MOBILE_PATTERN.test(candidate);
  return accepted ? candidate : undefined;
};

// ITU が国際発信のために予約している `00` だけは読み替える。`00` はどの国の**国内表記**の
// 先頭にも来ないので、`+` と同じく「ここから国番号」という宣言として扱える。`0081 90-…` は
// 名刺やサイトで実際に使われる書き方で、寄せないと #639 の迂回がそのまま成立する。
const ITU_INTERNATIONAL_PREFIX = /^00(?=81)/;

// **これ以外の発信プレフィックス (010 / 001 / 011 / 0011 / 810 / 1xx0 …) は読み替えない。**
// 一度は「先頭 1〜4 桁を落とした残りが 81 で始まれば寄せる」という長さ走査を入れたが、
// これは実在の番号を壊す: ブラジルの市外発信 `0` + 事業者 `15` + DDD `81` + 9 桁携帯
// (`01581912345678`) が `0912345678` という別人の番号に化ける (実測)。逆に走査を
// 先頭 `0` / `8` に限ると、チリの `1xx0` 形式は寄らない。どちらに寄せても外れる = 国ごとに
// 綴りが違うプレフィックスを当てにいく設計自体が誤り。`00` だけが例外なのは、値が国ごとに
// 変わらず、国内表記と見分けが付くため。
//
// 寄らない綴り (`01081…`) は値をそのまま残すので壊れない。折り返しにも使えない書き方なので、
// 連絡先として登録される見込みも薄い。

export const normalizePhone = (phone: string): string | undefined => {
  // 桁数の検査は**読み替える前**に行う。読み替えは値を 2〜4 桁短くするので、後に回すと
  // 8〜16 桁の上限を超えていた入力が読み替えで枠内に収まり、これまで弾いていた値を
  // 受け入れてしまう。
  const digits = phone.replace(/[\s\-().]/g, "");
  if (!PHONE_PATTERN.test(digits)) {
    return undefined;
  }
  // 既に国内表記の形をしている値は触らない。他国の国内番号 (韓国の携帯 010-8123-4567、
  // 札幌の 011-812-3456) が発信プレフィックスに見えるため、寄せると顧客の番号が別の値に
  // 化けて折り返せなくなる。国際発信の書き方は国番号ぶんが足されて 14 桁以上になる。
  if (JAPAN_DOMESTIC_PATTERN.test(digits)) {
    return digits;
  }
  // 寄せられない書き方は**元の入力のまま**残す (寄らないだけで、値は壊れない)。
  return toDomesticJapanPhone(digits.replace(ITU_INTERNATIONAL_PREFIX, "+")) ?? digits;
};

export const phoneExactSearchVariants = (raw: string): string[] => {
  const canonical = normalizePhone(raw.trim());
  if (canonical === undefined) {
    return [];
  }
  // normalizePhone が国内表記へ寄せるので新しい行は 0 始まりになるが、双方向のままにする。
  // 寄せ先が日本の国内表記 (0 始まりの 10〜11 桁) にならない値は `+81…` のまま保存される
  // (`+8125551234` など) うえ、正規化を入れる前に作られた行も `+81` 表記で残り得る。
  // 片方向にすると、その番号を国際表記で検索したスタッフに顧客が見つからなくなる。
  if (canonical.startsWith("+81")) {
    return [canonical, "0" + canonical.slice(3)];
  }
  if (canonical.startsWith("0")) {
    return [canonical, "+81" + canonical.slice(1)];
  }
  return [canonical];
};

// A customer's current LINE official-account friend status, resolved at the
// CUSTOMER level rather than from the reservation's line_identity_id FK. A
// reservation booked by phone/admin (line_identity_id = NULL) — or booked
// before an owner manually linked the customer's LINE friend — would otherwise
// show 不明 even though the customer IS linked. Resolving per-customer makes the
// admin reservation views answer "can I reach this customer on LINE?".
//
// This is a SCALAR correlated subquery (LIMIT 1), NOT a JOIN: a customer can own
// multiple line_identities rows (the only UNIQUE is
// (provider, channel_id, line_user_id); there is none on customer_id alone), so
// JOIN-ing on customer_id would multiply reservation rows. LIMIT 1 returns a
// single value. idx_line_identities_customer(customer_id) keeps it cheap.
//
// The ORDER BY is single-sourced as LINE_IDENTITY_RECENCY_ORDER_BY below and is
// also used by the getAdminCustomerDetail identity query (operations.ts) so the
// reservation panel and the customer panel select the SAME identity — including
// on equal updated_at ties.
//
// ⚠️ The OUTER query MUST expose a table named `reservations`; this subquery
// correlates on `reservations.customer_id`.
//
// ⚠️ DISPLAY / CSV ONLY. This value must NOT drive any gate or decision. The
// approve gate and LINE-reachability check deliberately read the reservation's
// OWN identity via reservations.line_identity_id (fetchReservationForAction in
// admin/reservations.ts), because notifications route to the LINE thread the
// booking was made on — which can differ from the customer's newest identity.
// Promoting this subquery into business logic without also changing that path
// would send to / gate on the wrong identity.
//
// Recency ordering for a customer's LINE identities: newest first, with
// created_at then id (the PRIMARY KEY) as deterministic tiebreakers on equal
// updated_at. Single source of truth — every query that picks "the customer's
// current identity" MUST reuse this and alias line_identities as `li`, so the
// reservation panels and the customer panel can never drift apart.
export const LINE_IDENTITY_RECENCY_ORDER_BY =
  "ORDER BY li.updated_at DESC, li.created_at DESC, li.id DESC";

// customer_visits.visited_at には 2 通りの書式が混在する。手動の来店記録は JST の日付キー
// ('YYYY-MM-DD' の 10 文字)、予約由来の自動記録は UTC の ISO 文字列。素の文字列比較で
// 並べると、JST 09:00 より前に始まる予約の UTC 日付が前日になり、同じ JST 日の手入力
// レコードと前後が入れ替わる。並び替えに使うキーはこの 1 箇所だけに置く — PR#647 で
// 1 箇所だけ正規化して 2 箇所を見落としたのがこの式が複製された経緯なので、来店を
// 日付順に並べるクエリを足すときはこれを参照する。列名は修飾しない: JOIN 先に
// visited_at を持つ表が無い間はこれで曖昧にならない (現在の呼び出し元は
// admin_users / staff_members / stores と結合している)。visited_at という名前の列を
// 持つ表を将来ここへ結合するなら、この式のほうを修飾すること。
export const VISITED_AT_JST_ORDER_KEY =
  "CASE WHEN length(visited_at) = 10 THEN visited_at ELSE datetime(visited_at, '+9 hours') END";

export const RESERVATION_LINE_FRIEND_STATUS_SUBQUERY = `(
  SELECT li.official_friend_status
  FROM line_identities li
  WHERE li.customer_id = reservations.customer_id
  ${LINE_IDENTITY_RECENCY_ORDER_BY}
  LIMIT 1
)`;

// Cloudflare D1 caps LIKE/GLOB patterns at 50 bytes (UTF-8) — see
// https://developers.cloudflare.com/d1/platform/limits/. Local SQLite does NOT
// enforce this, so an over-long search only fails in production. Every caller
// that builds a LIKE pattern from user input must escape it AND reject
// over-budget patterns, so both live here as one source of truth.
export const LIKE_PATTERN_BYTE_BUDGET = 50;

const LIKE_PATTERN_ENCODER = new TextEncoder();

export const exceedsLikePatternBudget = (pattern: string): boolean =>
  LIKE_PATTERN_ENCODER.encode(pattern).byteLength > LIKE_PATTERN_BYTE_BUDGET;

// Escape `%`, `_`, and `\` in a LIKE pattern with `\` so a user-supplied
// substring is treated literally. Pair every binding with `ESCAPE '\'`.
export const escapeLikePattern = (raw: string): string =>
  raw.replace(/[\\%_]/g, String.raw`\$&`);
