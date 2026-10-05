import { describe, expect, it } from "vitest";

import {
  jstDateParts,
  jstDayKey,
  normalizePhone,
  phoneExactSearchVariants
} from "../src/admin/shared";

describe("jstDateParts", () => {
  it("maps UTC midnight to JST 09:00 on the same calendar day", () => {
    const parts = jstDateParts(Date.parse("2026-05-12T00:00:00.000Z"));
    expect(parts).toEqual({ year: 2026, month: 5, day: 12 });
  });

  it("treats UTC 14:59:59 as the same JST day", () => {
    const parts = jstDateParts(Date.parse("2026-05-12T14:59:59.000Z"));
    expect(parts).toEqual({ year: 2026, month: 5, day: 12 });
  });

  it("crosses to the next JST day at UTC 15:00", () => {
    const parts = jstDateParts(Date.parse("2026-05-12T15:00:00.000Z"));
    expect(parts).toEqual({ year: 2026, month: 5, day: 13 });
  });

  it("handles year and month rollover via the JST window", () => {
    const parts = jstDateParts(Date.parse("2026-12-31T15:00:00.000Z"));
    expect(parts).toEqual({ year: 2027, month: 1, day: 1 });
  });
});

describe("jstDayKey", () => {
  it("formats single-digit month and day with zero padding", () => {
    expect(jstDayKey(Date.parse("2026-01-02T00:00:00.000Z"))).toBe("2026-01-02");
  });

  it("returns the UNIX epoch JST day for zero", () => {
    expect(jstDayKey(0)).toBe("1970-01-01");
  });

  it("rolls forward exactly at UTC 15:00", () => {
    expect(jstDayKey(Date.parse("2026-05-12T14:59:59.000Z"))).toBe("2026-05-12");
    expect(jstDayKey(Date.parse("2026-05-12T15:00:00.000Z"))).toBe("2026-05-13");
  });
});

describe("normalizePhone", () => {
  it("normalizes valid formatted strings correctly", () => {
    expect(normalizePhone("(123) 456-7890")).toBe("1234567890");
    expect(normalizePhone("+1 123.456.7890")).toBe("+11234567890");
    expect(normalizePhone("123-456-7890")).toBe("1234567890");
    expect(normalizePhone("12345678")).toBe("12345678");
    expect(normalizePhone("+1234567890123456")).toBe("+1234567890123456");
  });

  it("returns undefined for too-short strings", () => {
    expect(normalizePhone("1234567")).toBeUndefined();
    expect(normalizePhone("123")).toBeUndefined();
  });

  it("returns undefined for too-long strings", () => {
    expect(normalizePhone("12345678901234567")).toBeUndefined();
    expect(normalizePhone("+12345678901234567")).toBeUndefined();
  });

  // issue #639: ブロックは phone_hash の完全一致で効くので、同じ番号が 2 通りの
  // 文字列として保存されると、表記を変えるだけでブロックをすり抜けられる。
  // 保存前に国内表記へ寄せることでハッシュが 1 つに定まる。
  it("folds the +81 international form into the domestic 0 form", () => {
    expect(normalizePhone("+819012345678")).toBe("09012345678");
    expect(normalizePhone("+81 90-1234-5678")).toBe("09012345678");
    expect(normalizePhone("09012345678")).toBe("09012345678");
  });

  it("folds +81 written with the trunk 0 still attached", () => {
    expect(normalizePhone("+81 090 1234 5678")).toBe("09012345678");
  });

  // "+" を落として国番号だけ書く人がいる。ここを畳まないと 3 つ目の表記として
  // 別ハッシュになり、ブロックは同じやり方で迂回できてしまう。
  it("folds the country code written without a plus sign", () => {
    expect(normalizePhone("819012345678")).toBe("09012345678");
    expect(normalizePhone("81-90-1234-5678")).toBe("09012345678");
    expect(normalizePhone("81 090 1234 5678")).toBe("09012345678");
  });

  // "81" で始まる番号がすべて日本のものとは限らない。米国の 812 局番を区切り無しで
  // 書いた "8125551234" を機械的に畳むと "025551234" になり、実在する新潟の市外局番と
  // 衝突しかねない別人の番号に化ける。畳んだ形が日本の国内表記 (0 始まりの 10〜11 桁)
  // になったときだけ日本の番号と見なす。
  it("only folds when the result is a Japanese domestic number", () => {
    expect(normalizePhone("812-555-1234")).toBe("8125551234");
    expect(normalizePhone("+8125551234")).toBe("+8125551234");
    // 国番号だけで加入者番号が実質空になる入力も畳まない。
    expect(normalizePhone("+8100000000")).toBe("+8100000000");
    expect(normalizePhone("810000001")).toBe("810000001");
    // "+" が付いていれば固定電話 (10 桁) も携帯 (11 桁) も畳む。
    expect(normalizePhone("+81312345678")).toBe("0312345678");
    expect(normalizePhone("+810 90-1234-5678")).toBe("09012345678");
  });

  // "+" の無い "81…" は日本の国番号とは限らない。ブラジルの国内表記は市外局番 81 で
  // 始まり、桁数だけでは日本の固定電話の国番号表記 (81 + 9 桁 = 11 桁) と見分けが
  // 付かない。携帯 (寄せる前が 81 + 10 桁 = 12 桁) に限れば長さで分かれる。
  it("folds a bare 81 prefix only for mobile numbers", () => {
    expect(normalizePhone("819012345678")).toBe("09012345678");
    expect(normalizePhone("81-80-1234-5678")).toBe("08012345678");
    // ブラジルの携帯 (市外局番 81 + 9 桁)。畳むと "0912345678" という別人の番号になる。
    expect(normalizePhone("81912345678")).toBe("81912345678");
    // 日本の固定電話でも "+" が無ければ畳まない (上の番号と区別できないため)。
    expect(normalizePhone("81752345678")).toBe("81752345678");
  });

  // 060 は携帯番号の枯渇に備えて後から割り当てが始まった帯。落とすと、この帯の
  // 顧客だけ表記違いでブロックを迂回できる。大阪の 06 は固定電話 10 桁なので、
  // 11 桁を要求するこの判定には当たらない。
  it("folds the 060 mobile range as well", () => {
    expect(normalizePhone("+81 60-1234-5678")).toBe("06012345678");
    expect(normalizePhone("816012345678")).toBe("06012345678");
    // 大阪の固定電話 (06 + 8 桁 = 10 桁)。国内表記のまま変わらない。
    expect(normalizePhone("06-1234-5678")).toBe("0612345678");
  });

  // 国際発信プレフィックスは読み替えない。長さ走査は実在の番号を壊し (ブラジル)、
  // 走査を先頭 0 / 8 に限ると別の綴りが漏れる (チリ) ので、綴りの集合を当てにいく
  // 設計自体を採らない。#639 の実害は `090…` と `+8190…` の 2 通りだけで、そこは
  // 国番号の読み替えが塞ぐ。
  it("folds only the ITU 00 prefix and leaves every other dial prefix alone", () => {
    // `00` は ITU が国際発信に予約していて、どの国の国内表記の先頭にも来ない。
    // 名刺やサイトで実際に使われる書き方なので、ここだけは寄せる。
    expect(normalizePhone("0081 90-1234-5678")).toBe("09012345678");
    expect(normalizePhone("0081 3-1234-5678")).toBe("0312345678");
    // 読み替えても日本の番号として成立しない `0081…` は**元の綴りのまま**残す。
    // 途中形 (`+8112345678`) を返すと backfill 側の `canonicalizePhone` と食い違い、
    // 「残り 0 行」が嘘になる。
    expect(normalizePhone("008112345678")).toBe("008112345678");
    // ブラジルの国際発信は `00` + 事業者 + 国番号。`0081` にはならないので寄らない。
    expect(normalizePhone("0015 81 90-1234-5678")).toBe("0015819012345678");
    expect(normalizePhone("010 81 90-1234-5678")).toBe("010819012345678");
    expect(normalizePhone("001 81 90-1234-5678")).toBe("001819012345678");
    expect(normalizePhone("810 81 90-1234-5678")).toBe("810819012345678");
    // ブラジルの市外発信 0 + 事業者 15 + DDD 81 + 9 桁携帯。長さ走査を入れていたときは
    // `0912345678` という**別人の番号**に化けていた (実測)。寄せずにそのまま残す。
    expect(normalizePhone("0158 1912345678")).toBe("01581912345678");
    // 日本の国内番号は 00 でも 010 でも始まらないので、国内表記とは衝突しない。
    expect(normalizePhone("0120-123-456")).toBe("0120123456");
    // 桁数の検査は読み替えの前。17 桁は読み替えれば 16 桁に収まるが、読み替え前に
    // 上限を超えているので受け付けない (これまでも弾いていた値を通さないため)。
    expect(normalizePhone("00811234567890123")).toBeUndefined();
  });

  // 正規化では閉じられない残りを明示的に固定する。ここが緑なだけでは #639 は
  // 塞がっていないので、テスト名で「まだ通る」と言い切っておく (issue #669)。
  it("still lets zero-padded spellings through — normalization cannot close them", () => {
    // ブロック済みの `09012345678` / `0312345678` に対して、受理されるのに別の値で
    // 保存される入力。`0` を 1 文字足すだけで成立する。
    expect(normalizePhone("009012345678")).toBe("009012345678");
    expect(normalizePhone("0009012345678")).toBe("0009012345678");
    expect(normalizePhone("00312345678")).toBe("00312345678");
    expect(normalizePhone("+0819012345678")).toBe("+0819012345678");
    expect(normalizePhone("810819012345678")).toBe("810819012345678");
    // 上の 5 件はすべて入力と出力が等しい = 不動点。「寄せるべきなのに寄っていない値を
    // 拒否する」DB トリガでも塞がらないことが、この等式からそのまま読める。
    // 先頭の連続 0 を 1 個に潰して塞ぐ案を採らない理由。KDDI の 001 + 韓国の携帯
    // 8123-4567 が、秋田の固定電話 0181-23-4567 に化ける。
    expect(normalizePhone("00181234567")).toBe("00181234567");
  });

  // 発信プレフィックスに見える他国の**国内番号**。読み替えると顧客の番号が別の値に
  // 化けて折り返せなくなる。
  it("keeps foreign domestic numbers that look like a dial prefix", () => {
    // 韓国の携帯。010 は市外局番ではなく携帯の識別番号で、続く 4 桁が 81xx でもあり得る。
    expect(normalizePhone("010-8123-4567")).toBe("01081234567");
    // 札幌の市外局番 011。局番が 812 の番号は実在する。
    expect(normalizePhone("011-812-3456")).toBe("0118123456");
    expect(normalizePhone("001-8123-4567")).toBe("00181234567");
    // ポーランドの番号。1 桁落とすと 81 で始まるが、寄せない。
    expect(normalizePhone("481901234567")).toBe("481901234567");
    // 米国の 818 局番。
    expect(normalizePhone("8181234567")).toBe("8181234567");
  });

  // 検索の変換は双方向でなければならない。normalizePhone は「寄せた結果が日本の国内表記に
  // ならない値」を `+81…` のまま保存する (`+8125551234` など) ので、片方向にすると、その
  // 番号を国際表記で検索したスタッフに顧客が見つからなくなる。正規化を入れる前に作られた
  // `+81` 表記の行も同じ理由で拾えなくなる。
  it("derives the domestic/international twin in both directions for search", () => {
    expect(phoneExactSearchVariants(" 090-1234-5678 ")).toEqual([
      "09012345678",
      "+819012345678"
    ]);
    // 寄せられずに `+81` のまま残る値。国内表記の相方も試す。
    expect(phoneExactSearchVariants("+81 2555-1234")).toEqual(["+8125551234", "025551234"]);
    // 電話番号として読めない入力では電話の検索条件そのものを外す (部分一致で全件出さない)。
    expect(phoneExactSearchVariants("0901")).toEqual([]);
  });

  it("leaves non-Japanese international numbers untouched", () => {
    expect(normalizePhone("+11234567890")).toBe("+11234567890");
    expect(normalizePhone("+441234567890")).toBe("+441234567890");
  });

  it("returns undefined for strings with invalid characters", () => {
    expect(normalizePhone("123abc456")).toBeUndefined();
    expect(normalizePhone("12345678a")).toBeUndefined();
    expect(normalizePhone("!12345678")).toBeUndefined();
  });
});
