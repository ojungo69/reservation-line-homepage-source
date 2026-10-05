import { describe, expect, it } from "vitest";

import {
  STRICT_ISO_INSTANT_RE,
  parseStrictIsoInstantMs,
  parseStrictIsoOffsetInstantMs,
  parseIsoInstantToCanonical
} from "../src/admin/parse-iso-instant";

// ---------------------------------------------------------------------------
// parseStrictIsoInstantMs — returns ms-since-epoch or null
// ---------------------------------------------------------------------------

describe("parseStrictIsoInstantMs", () => {
  describe("valid inputs", () => {
    it("parses canonical 3-digit fractional seconds", () => {
      expect(parseStrictIsoInstantMs("2026-05-20T03:30:00.000Z")).toBe(
        Date.UTC(2026, 4, 20, 3, 30, 0, 0)
      );
    });

    it("parses without fractional seconds", () => {
      expect(parseStrictIsoInstantMs("2026-05-20T03:30:00Z")).toBe(
        Date.UTC(2026, 4, 20, 3, 30, 0, 0)
      );
    });

    it("parses epoch (1970-01-01T00:00:00.000Z)", () => {
      expect(parseStrictIsoInstantMs("1970-01-01T00:00:00.000Z")).toBe(0);
    });

    it("parses far-future date", () => {
      expect(parseStrictIsoInstantMs("2099-12-31T23:59:59.999Z")).toBe(
        Date.UTC(2099, 11, 31, 23, 59, 59, 999)
      );
    });

    it("parses non-zero milliseconds correctly", () => {
      expect(parseStrictIsoInstantMs("2026-01-01T00:00:00.123Z")).toBe(
        Date.UTC(2026, 0, 1, 0, 0, 0, 123)
      );
    });

    it("parses midnight boundary", () => {
      expect(parseStrictIsoInstantMs("2026-06-15T00:00:00Z")).toBe(
        Date.UTC(2026, 5, 15, 0, 0, 0, 0)
      );
    });

    it("parses end-of-day 23:59:59", () => {
      expect(parseStrictIsoInstantMs("2026-06-15T23:59:59.999Z")).toBe(
        Date.UTC(2026, 5, 15, 23, 59, 59, 999)
      );
    });

    it("parses leap year Feb 29", () => {
      expect(parseStrictIsoInstantMs("2024-02-29T12:00:00Z")).toBe(
        Date.UTC(2024, 1, 29, 12, 0, 0, 0)
      );
    });
  });

  describe("variable-length fractional seconds (1-3 digits)", () => {
    it("interprets .5 as 500ms (not 5ms)", () => {
      // This is the core ms-interpretation bug that was fixed.
      // .5 in ISO 8601 means 0.5 seconds = 500ms.
      expect(parseStrictIsoInstantMs("2026-01-01T00:00:00.5Z")).toBe(
        Date.UTC(2026, 0, 1, 0, 0, 0, 500)
      );
    });

    it("interprets .05 as 50ms (not 5ms)", () => {
      expect(parseStrictIsoInstantMs("2026-01-01T00:00:00.05Z")).toBe(
        Date.UTC(2026, 0, 1, 0, 0, 0, 50)
      );
    });

    it("interprets .1 as 100ms", () => {
      expect(parseStrictIsoInstantMs("2026-01-01T00:00:00.1Z")).toBe(
        Date.UTC(2026, 0, 1, 0, 0, 0, 100)
      );
    });

    it("interprets .01 as 10ms", () => {
      expect(parseStrictIsoInstantMs("2026-01-01T00:00:00.01Z")).toBe(
        Date.UTC(2026, 0, 1, 0, 0, 0, 10)
      );
    });

    it("interprets .9 as 900ms", () => {
      expect(parseStrictIsoInstantMs("2026-01-01T00:00:00.9Z")).toBe(
        Date.UTC(2026, 0, 1, 0, 0, 0, 900)
      );
    });

    it("interprets .99 as 990ms", () => {
      expect(parseStrictIsoInstantMs("2026-01-01T00:00:00.99Z")).toBe(
        Date.UTC(2026, 0, 1, 0, 0, 0, 990)
      );
    });

    it("interprets .999 as 999ms (3-digit unchanged)", () => {
      expect(parseStrictIsoInstantMs("2026-01-01T00:00:00.999Z")).toBe(
        Date.UTC(2026, 0, 1, 0, 0, 0, 999)
      );
    });

    it("interprets .001 as 1ms", () => {
      expect(parseStrictIsoInstantMs("2026-01-01T00:00:00.001Z")).toBe(
        Date.UTC(2026, 0, 1, 0, 0, 0, 1)
      );
    });
  });

  describe("silently-normalised invalid dates (must reject)", () => {
    it("rejects Feb 30 (normalised to Mar 2)", () => {
      expect(parseStrictIsoInstantMs("2026-02-30T00:00:00.000Z")).toBeNull();
    });

    it("rejects Feb 29 in non-leap year", () => {
      expect(parseStrictIsoInstantMs("2025-02-29T12:00:00Z")).toBeNull();
    });

    it("rejects Apr 31", () => {
      expect(parseStrictIsoInstantMs("2026-04-31T00:00:00Z")).toBeNull();
    });

    it("rejects Jun 31", () => {
      expect(parseStrictIsoInstantMs("2026-06-31T00:00:00Z")).toBeNull();
    });
  });

  describe("out-of-range component values", () => {
    it("rejects month 13", () => {
      expect(parseStrictIsoInstantMs("2026-13-01T00:00:00.000Z")).toBeNull();
    });

    it("rejects month 00", () => {
      expect(parseStrictIsoInstantMs("2026-00-01T00:00:00.000Z")).toBeNull();
    });

    it("rejects day 00", () => {
      expect(parseStrictIsoInstantMs("2026-01-00T00:00:00.000Z")).toBeNull();
    });

    it("rejects day 32", () => {
      expect(parseStrictIsoInstantMs("2026-01-32T00:00:00.000Z")).toBeNull();
    });

    it("rejects hour 24", () => {
      expect(parseStrictIsoInstantMs("2026-05-20T24:00:00.000Z")).toBeNull();
    });

    it("rejects minute 60", () => {
      expect(parseStrictIsoInstantMs("2026-05-20T00:60:00.000Z")).toBeNull();
    });

    it("rejects second 60", () => {
      expect(parseStrictIsoInstantMs("2026-05-20T00:00:60.000Z")).toBeNull();
    });
  });

  describe("format violations (must reject)", () => {
    it("rejects 4+ fractional digits (.123456Z)", () => {
      expect(parseStrictIsoInstantMs("2026-05-20T03:30:00.123456Z")).toBeNull();
    });

    it("rejects missing Z suffix", () => {
      expect(parseStrictIsoInstantMs("2026-05-20T03:30:00.000")).toBeNull();
    });

    it("rejects offset instead of Z", () => {
      expect(parseStrictIsoInstantMs("2026-05-20T03:30:00.000+09:00")).toBeNull();
    });

    it("rejects trailing characters after Z", () => {
      expect(parseStrictIsoInstantMs("2026-05-20T03:30:00.000Z/")).toBeNull();
    });

    it("rejects date-only (no time)", () => {
      expect(parseStrictIsoInstantMs("2026-05-20")).toBeNull();
    });

    it("rejects empty string", () => {
      expect(parseStrictIsoInstantMs("")).toBeNull();
    });

    it("rejects plain text", () => {
      expect(parseStrictIsoInstantMs("not-a-date")).toBeNull();
    });

    it("rejects space-separated datetime", () => {
      expect(parseStrictIsoInstantMs("2026-05-20 03:30:00Z")).toBeNull();
    });

    it("rejects lowercase z", () => {
      expect(parseStrictIsoInstantMs("2026-05-20T03:30:00.000z")).toBeNull();
    });

    it("rejects dot-only fractional (.Z)", () => {
      expect(parseStrictIsoInstantMs("2026-05-20T03:30:00.Z")).toBeNull();
    });
  });

  describe("epoch sanity checks", () => {
    it("epoch returns exactly 0", () => {
      expect(parseStrictIsoInstantMs("1970-01-01T00:00:00.000Z")).toBe(0);
      expect(parseStrictIsoInstantMs("1970-01-01T00:00:00Z")).toBe(0);
    });

    it("one second after epoch returns 1000", () => {
      expect(parseStrictIsoInstantMs("1970-01-01T00:00:01.000Z")).toBe(1000);
    });

    it("one millisecond after epoch returns 1", () => {
      expect(parseStrictIsoInstantMs("1970-01-01T00:00:00.001Z")).toBe(1);
    });

    it("Date.UTC round-trip matches for a representative date", () => {
      const raw = "2026-05-20T15:30:45.123Z";
      const result = parseStrictIsoInstantMs(raw);
      expect(result).toBe(Date.UTC(2026, 4, 20, 15, 30, 45, 123));
      // And the result, when fed back to Date, produces the same ISO string
      expect(new Date(result!).toISOString()).toBe(raw);
    });
  });
});

// ---------------------------------------------------------------------------
// STRICT_ISO_INSTANT_RE — regex-level tests
// ---------------------------------------------------------------------------

describe("STRICT_ISO_INSTANT_RE", () => {
  it("matches canonical form with 3-digit fractional", () => {
    expect(STRICT_ISO_INSTANT_RE.test("2026-05-20T03:30:00.000Z")).toBe(true);
  });

  it("matches without fractional seconds", () => {
    expect(STRICT_ISO_INSTANT_RE.test("2026-05-20T03:30:00Z")).toBe(true);
  });

  it("matches 1-digit fractional", () => {
    expect(STRICT_ISO_INSTANT_RE.test("2026-05-20T03:30:00.5Z")).toBe(true);
  });

  it("matches 2-digit fractional", () => {
    expect(STRICT_ISO_INSTANT_RE.test("2026-05-20T03:30:00.05Z")).toBe(true);
  });

  it("rejects 4-digit fractional", () => {
    expect(STRICT_ISO_INSTANT_RE.test("2026-05-20T03:30:00.1234Z")).toBe(false);
  });

  it("rejects 6-digit fractional", () => {
    expect(STRICT_ISO_INSTANT_RE.test("2026-05-20T03:30:00.123456Z")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseIsoInstantToCanonical — returns canonical ISO string or null
// ---------------------------------------------------------------------------

describe("parseIsoInstantToCanonical", () => {
  it("returns canonical form for valid 3-digit fractional input", () => {
    expect(parseIsoInstantToCanonical("2026-05-20T03:30:00.123Z")).toBe(
      "2026-05-20T03:30:00.123Z"
    );
  });

  it("normalises no-fractional input to .000Z", () => {
    expect(parseIsoInstantToCanonical("2026-05-20T03:30:00Z")).toBe(
      "2026-05-20T03:30:00.000Z"
    );
  });

  it("normalises 1-digit fractional .5 to .500Z", () => {
    expect(parseIsoInstantToCanonical("2026-05-20T03:30:00.5Z")).toBe(
      "2026-05-20T03:30:00.500Z"
    );
  });

  it("normalises 2-digit fractional .05 to .050Z", () => {
    expect(parseIsoInstantToCanonical("2026-05-20T03:30:00.05Z")).toBe(
      "2026-05-20T03:30:00.050Z"
    );
  });

  it("rejects non-string input (number)", () => {
    expect(parseIsoInstantToCanonical(12345 as unknown)).toBeNull();
  });

  it("rejects non-string input (null)", () => {
    expect(parseIsoInstantToCanonical(null as unknown)).toBeNull();
  });

  it("rejects non-string input (undefined)", () => {
    expect(parseIsoInstantToCanonical(undefined as unknown)).toBeNull();
  });

  it("rejects non-string input (object)", () => {
    expect(parseIsoInstantToCanonical({} as unknown)).toBeNull();
  });

  it("rejects invalid date (Feb 30)", () => {
    expect(parseIsoInstantToCanonical("2026-02-30T00:00:00.000Z")).toBeNull();
  });

  it("returns canonical form for epoch", () => {
    expect(parseIsoInstantToCanonical("1970-01-01T00:00:00Z")).toBe(
      "1970-01-01T00:00:00.000Z"
    );
  });
});

describe("parseStrictIsoOffsetInstantMs", () => {
  it("accepts Z form (same value as strict parser)", () => {
    expect(parseStrictIsoOffsetInstantMs("2026-05-10T00:00:00Z")).toBe(
      Date.UTC(2026, 4, 10, 0, 0, 0)
    );
  });

  it("accepts +09:00 offset (JST day start = 15:00 UTC previous day)", () => {
    expect(parseStrictIsoOffsetInstantMs("2026-05-10T00:00:00+09:00")).toBe(
      Date.UTC(2026, 4, 9, 15, 0, 0)
    );
  });

  it("accepts -05:30 offset", () => {
    expect(parseStrictIsoOffsetInstantMs("2026-05-10T00:00:00-05:30")).toBe(
      Date.UTC(2026, 4, 10, 5, 30, 0)
    );
  });

  it("accepts fractional seconds with offset", () => {
    expect(parseStrictIsoOffsetInstantMs("2026-05-10T12:00:00.5+09:00")).toBe(
      Date.UTC(2026, 4, 10, 3, 0, 0, 500)
    );
  });

  it("rejects missing suffix entirely", () => {
    expect(parseStrictIsoOffsetInstantMs("2026-05-10T00:00:00")).toBeNull();
  });

  it("rejects single-digit offset hour (+9:00)", () => {
    expect(parseStrictIsoOffsetInstantMs("2026-05-10T00:00:00+9:00")).toBeNull();
  });

  it("rejects offset without colon (+0900)", () => {
    expect(parseStrictIsoOffsetInstantMs("2026-05-10T00:00:00+0900")).toBeNull();
  });

  it("rejects out-of-range offset (+24:00)", () => {
    expect(parseStrictIsoOffsetInstantMs("2026-05-10T00:00:00+24:00")).toBeNull();
  });

  it("rejects out-of-range offset minutes (+09:60)", () => {
    expect(parseStrictIsoOffsetInstantMs("2026-05-10T00:00:00+09:60")).toBeNull();
  });

  it("rejects silently-normalised invalid date with offset (Feb 30)", () => {
    expect(parseStrictIsoOffsetInstantMs("2026-02-30T00:00:00+09:00")).toBeNull();
  });
});
