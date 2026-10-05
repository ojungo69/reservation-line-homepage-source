/**
 * Snapshot tests for sanitizeCustomerNameForCalendarSummary and related
 * calendar-summary PII patterns consolidated from calendar-sync.ts into
 * pii-normalize.ts (Phase E).
 *
 * These snapshots anchor byte-identical output across the consolidation to
 * prove no behavioral change. The test vectors cover:
 *   - Japanese names (benign passthrough)
 *   - Surrogate pairs and emoji
 *   - Zero-width characters in names
 *   - PII-bearing strings (phone, email, date)
 *   - Edge whitespace / empty / null
 *   - Full-width numeral bypass attempts
 */
import { describe, expect, it } from "vitest";

import {
  sanitizeCustomerNameForCalendarSummary,
  normalizeForPii,
  EMAIL_LIKE_PATTERN,
  CONTROL_CHARS_PATTERN,
  PHONE_LIKE_DIGIT_RUN,
  CALENDAR_PHONE_SEPARATOR_PATTERN,
  DATE_ANY_PATTERN
} from "../src/pii-normalize";

describe("sanitizeCustomerNameForCalendarSummary — consolidation snapshot", () => {
  const vectors: Array<[string, string | null, string]> = [
    // [label, input, expected output]
    ["benign Japanese name", "田中 太郎", "田中 太郎"],
    ["benign katakana name", "タナカ タロウ", "タナカ タロウ"],
    ["null input", null, "氏名未登録"],
    ["empty string", "", "氏名未登録"],
    ["whitespace only", "   \t  ", "氏名未登録"],
    ["phone — hyphen separated", "090-1234-5678", "ご予約"],
    ["phone — full-width digits", "０９０１２３４５６７８", "ご予約"],
    ["phone — full-width dash", "０９０−１２３４−５６７８", "ご予約"],
    ["email — ASCII", "taro@example.com", "ご予約"],
    ["email — full-width @", "taro＠example.com", "ご予約"],
    ["date — ISO", "1990-03-15", "ご予約"],
    ["date — Japanese 年月日", "1990年3月15日", "ご予約"],
    ["date — full-width digits", "１９９０年０３月１５日", "ご予約"],
    ["surrogate pair name", "𠮷野 太郎", "𠮷野 太郎"],
    ["emoji in name", "太郎 🎉", "太郎 🎉"],
    ["zero-width joiner in name", "田中‍太郎", "田中‍太郎"],
    ["zero-width space separating phone", "090​1234​5678", "ご予約"],
    ["control chars stripped — result benign", "太郎\x00\x07花子", "太郎花子"],
    ["phone — parenthesised", "090(1234)5678", "ご予約"],
    ["phone — slash separated", "075/123/4567", "ご予約"],
    ["name with trailing spaces", "  田中 太郎  ", "田中 太郎"],
    ["bare @ sign in name", "田中@花子", "ご予約"],
    ["phone — international +81", "+81 90 1234 5678", "ご予約"],
    ["katakana prolonged sound dash phone", "０７５ー１２３ー４５６７", "ご予約"],
    ["mixed benign + PII — at-sign wins", "田中太郎 taro@example.com", "ご予約"]
  ];

  it.each(vectors)("%s → %s", (_label, input, expected) => {
    expect(sanitizeCustomerNameForCalendarSummary(input)).toBe(expected);
  });

  // Snapshot the full vector map for regression detection
  it("snapshot of all vectors", () => {
    const results = vectors.map(([label, input]) => ({
      label,
      input: input === null ? "null" : JSON.stringify(input),
      output: sanitizeCustomerNameForCalendarSummary(input)
    }));
    expect(results).toMatchSnapshot();
  });
});

describe("normalizeForPii — consolidation equivalence", () => {
  it.each([
    ["full-width digits", "０９０１２３４５６７８", "09012345678"],
    ["katakana prolonged sound mark", "ー", "-"],
    ["EN DASH", "–", "-"],
    ["EM DASH", "—", "-"],
    ["MINUS SIGN", "−", "-"],
    ["mixed", "田中−太郎", "田中-太郎"],
    ["already ASCII", "hello", "hello"],
    ["full-width @", "＠", "@"]
  ])("normalizes %s", (_label, input, expected) => {
    expect(normalizeForPii(input)).toBe(expected);
  });
});

describe("exported calendar-summary patterns", () => {
  it("EMAIL_LIKE_PATTERN detects @", () => {
    expect(EMAIL_LIKE_PATTERN.test("foo@bar")).toBe(true);
    expect(EMAIL_LIKE_PATTERN.test("foobar")).toBe(false);
  });

  it("CONTROL_CHARS_PATTERN matches control characters", () => {
    expect("\x00\x07\x1F\x7F".replace(CONTROL_CHARS_PATTERN, "")).toBe("");
    expect("hello".replace(CONTROL_CHARS_PATTERN, "")).toBe("hello");
  });

  it("PHONE_LIKE_DIGIT_RUN detects 8+ digit runs", () => {
    expect(PHONE_LIKE_DIGIT_RUN.test("12345678")).toBe(true);
    expect(PHONE_LIKE_DIGIT_RUN.test("1234567")).toBe(false);
  });

  it("CALENDAR_PHONE_SEPARATOR_PATTERN strips expected separators", () => {
    expect("090-1234-5678".replace(CALENDAR_PHONE_SEPARATOR_PATTERN, "")).toBe(
      "09012345678"
    );
    expect("(090) 1234 5678".replace(CALENDAR_PHONE_SEPARATOR_PATTERN, "")).toBe(
      "09012345678"
    );
    expect("+81 90 1234 5678".replace(CALENDAR_PHONE_SEPARATOR_PATTERN, "")).toBe(
      "819012345678"
    );
  });

  it("DATE_ANY_PATTERN matches date-like strings", () => {
    expect(DATE_ANY_PATTERN.test("1990-03-15")).toBe(true);
    expect(DATE_ANY_PATTERN.test("1990/03/15")).toBe(true);
    expect(DATE_ANY_PATTERN.test("1990.03.15")).toBe(true);
    expect(DATE_ANY_PATTERN.test("1990年3月15日")).toBe(true);
    expect(DATE_ANY_PATTERN.test("hello world")).toBe(false);
  });
  it("CONTROL_CHARS_PATTERN strips bidi format controls (U+202A..U+202E, U+2066..U+2069, U+2028, U+2029, U+FEFF)", () => {
    const inputs = [
      "\u202A", "\u202B", "\u202C", "\u202D", "\u202E",
      "\u2066", "\u2067", "\u2068", "\u2069",
      "\u2028", "\u2029", "\uFEFF"
    ].join("");
    expect(inputs.replace(CONTROL_CHARS_PATTERN, "")).toBe("");
  });
});

describe("sanitizeCustomerNameForCalendarSummary — bidi bypass defense", () => {
  it.each([
    {
      name: "rejects phone-like digits split by U+202E (RLO)",
      input: "090\u202E1234\u202E5678",
      expected: "ご予約"
    },
    {
      name: "rejects phone-like digits split by U+2066 (LRI)",
      input: "090\u20661234\u20665678",
      expected: "ご予約"
    },
    {
      name: "rejects phone-like digits split by U+202A (LRE)",
      input: "090\u202A1234\u202A5678",
      expected: "ご予約"
    },
    {
      name: "rejects date YYYY-MM-DD obscured by U+202E",
      input: "1990\u202E-03-15",
      expected: "ご予約"
    },
    {
      name: "rejects date YYYY年M月D日 obscured by U+2068 (FSI)",
      input: "1990\u2068年3月15日",
      expected: "ご予約"
    },
    {
      // U+200F (RLM) is already in CALENDAR_PHONE_SEPARATOR_PATTERN; it is
      // stripped at the separator step, but the @ in the probe is still
      // detected directly by EMAIL_LIKE_PATTERN, so this should be PII.
      name: "rejects email containing U+200F + @",
      input: "user\u200F@example.com",
      expected: "ご予約"
    },
    {
      name: "preserves legitimate Japanese name with no bidi controls",
      input: "予約 太郎",
      expected: "予約 太郎"
    },
    {
      name: "preserves legitimate name even if surrounded by stray bidi (stripped)",
      input: "\u202E予約 太郎\u2069",
      expected: "予約 太郎"
    },
    {
      name: "rejects phone-like digits split by U+061C (Arabic Letter Mark)",
      input: "090\u061C1234\u061C5678",
      expected: "ご予約"
    },
    {
      name: "rejects date YYYY-MM-DD obscured by U+061C",
      input: "1990\u061C-03-15",
      expected: "ご予約"
    },
    {
      name: "preserves legitimate name even if surrounded by U+200F (RLM) + U+061C",
      input: "\u200F\u061C予約 太郎\u061C\u200F",
      expected: "予約 太郎"
    }
  ])("$name", ({ input, expected }) => {
    expect(sanitizeCustomerNameForCalendarSummary(input)).toBe(expected);
  });
});
