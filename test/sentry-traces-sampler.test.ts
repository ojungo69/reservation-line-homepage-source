import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  extractPathnameFromSpanName,
  getBaseSampleRate,
  parseTracesSampleRateOverride,
  __resetSentryOverrideWarnCache
} from "../src/index";

describe("extractPathnameFromSpanName", () => {
  it("extracts pathname from 'METHOD /path' format", () => {
    expect(extractPathnameFromSpanName("GET /api/public/availability")).toBe(
      "/api/public/availability"
    );
  });

  it("extracts pathname from POST request", () => {
    expect(extractPathnameFromSpanName("POST /api/public/reservations")).toBe(
      "/api/public/reservations"
    );
  });

  it("handles bare pathname with no method prefix", () => {
    expect(extractPathnameFromSpanName("/api/admin/reservations")).toBe(
      "/api/admin/reservations"
    );
  });

  it("returns undefined for non-path span names", () => {
    expect(extractPathnameFromSpanName("scheduled")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(extractPathnameFromSpanName("")).toBeUndefined();
  });

  it("returns undefined when text after space is not a path", () => {
    expect(extractPathnameFromSpanName("some thing")).toBeUndefined();
  });

  it("handles path with query-like suffix", () => {
    expect(extractPathnameFromSpanName("GET /api/public/availability?store=1")).toBe(
      "/api/public/availability?store=1"
    );
  });
});

describe("getBaseSampleRate", () => {
  describe("cron handlers", () => {
    // @sentry/cloudflare v10.53.1 root span name format
    it("returns 0.1 for 'Scheduled Cron */10 * * * *' (maintenance cron)", () => {
      expect(getBaseSampleRate("Scheduled Cron */10 * * * *")).toBe(0.1);
    });

    it("returns 0.1 for 'Scheduled Cron 3 19 * * *' (reminder cron 04:03 JST)", () => {
      expect(getBaseSampleRate("Scheduled Cron 3 19 * * *")).toBe(0.1);
    });

    it("returns 0.1 for 'Scheduled Cron 0 11 * * *' (daily_ops cron 20:00 JST)", () => {
      expect(getBaseSampleRate("Scheduled Cron 0 11 * * *")).toBe(0.1);
    });

    // Back-compat for older SDK span name format
    it("returns 0.1 for legacy 'scheduled'", () => {
      expect(getBaseSampleRate("scheduled")).toBe(0.1);
    });

    it("returns 0.1 for legacy 'scheduled */10 * * * *'", () => {
      expect(getBaseSampleRate("scheduled */10 * * * *")).toBe(0.1);
    });

    it("returns 0.1 for legacy 'scheduled 3 19 * * *'", () => {
      expect(getBaseSampleRate("scheduled 3 19 * * *")).toBe(0.1);
    });

    it("returns 0.1 for legacy 'scheduled 0 11 * * *'", () => {
      expect(getBaseSampleRate("scheduled 0 11 * * *")).toBe(0.1);
    });
  });

  describe("public availability", () => {
    it("returns 0.01 for GET /api/public/availability", () => {
      expect(getBaseSampleRate("GET /api/public/availability")).toBe(0.01);
    });

    it("returns 0.01 for bare /api/public/availability", () => {
      expect(getBaseSampleRate("/api/public/availability")).toBe(0.01);
    });
  });

  describe("public reservations", () => {
    it("returns 0.1 for POST /api/public/reservations", () => {
      expect(getBaseSampleRate("POST /api/public/reservations")).toBe(0.1);
    });

    it("returns 0.1 for GET /api/public/reservations/abc", () => {
      expect(getBaseSampleRate("GET /api/public/reservations/abc")).toBe(0.1);
    });

    it("returns 0.1 for bare /api/public/reservations", () => {
      expect(getBaseSampleRate("/api/public/reservations")).toBe(0.1);
    });
  });

  describe("admin routes", () => {
    it("returns 0.05 for GET /api/admin/reservations", () => {
      expect(getBaseSampleRate("GET /api/admin/reservations")).toBe(0.05);
    });

    it("returns 0.05 for POST /api/admin/customers/123/merge", () => {
      expect(getBaseSampleRate("POST /api/admin/customers/123/merge")).toBe(0.05);
    });

    it("returns 0.05 for bare /api/admin", () => {
      expect(getBaseSampleRate("/api/admin")).toBe(0.05);
    });

    it("returns 0.05 for /api/admin/ with trailing slash in name", () => {
      expect(getBaseSampleRate("GET /api/admin/settings")).toBe(0.05);
    });
  });

  describe("everything else", () => {
    it("returns 0 for GET /", () => {
      expect(getBaseSampleRate("GET /")).toBe(0);
    });

    it("returns 0 for GET /api/health", () => {
      expect(getBaseSampleRate("GET /api/health")).toBe(0);
    });

    it("returns 0 for GET /api/public/reservation-options", () => {
      expect(getBaseSampleRate("GET /api/public/reservation-options")).toBe(0);
    });

    it("returns 0 for unknown span names", () => {
      expect(getBaseSampleRate("some-internal-span")).toBe(0);
    });

    it("returns 0 for empty string", () => {
      expect(getBaseSampleRate("")).toBe(0);
    });

    it("returns 0 for static asset paths", () => {
      expect(getBaseSampleRate("GET /styles.css")).toBe(0);
    });
  });
});

describe("parseTracesSampleRateOverride", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetSentryOverrideWarnCache();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("returns 1.0 when undefined", () => {
    expect(parseTracesSampleRateOverride(undefined)).toBe(1.0);
  });

  it("returns 1.0 when empty string", () => {
    expect(parseTracesSampleRateOverride("")).toBe(1.0);
  });

  it("returns 1.0 when whitespace-only string", () => {
    expect(parseTracesSampleRateOverride("   ")).toBe(1.0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("returns parsed value for valid '0.5'", () => {
    expect(parseTracesSampleRateOverride("0.5")).toBe(0.5);
  });

  it("returns 0 for '0'", () => {
    expect(parseTracesSampleRateOverride("0")).toBe(0);
  });

  it("returns 1 for '1'", () => {
    expect(parseTracesSampleRateOverride("1")).toBe(1);
  });

  it("rejects partial-numeric string '0.5abc' as non-finite", () => {
    // Number("0.5abc") === NaN, so this falls back to 1.0 + warn (unlike
    // Number.parseFloat which would silently accept 0.5).
    expect(parseTracesSampleRateOverride("0.5abc")).toBe(1.0);
    expect(warnSpy).toHaveBeenCalledWith(
      "sentry_traces_sample_rate_override_warn",
      expect.objectContaining({ raw: "0.5abc", reason: "non_finite", fallback: 1.0 })
    );
  });

  it("returns 1.0 and warns for non-numeric input", () => {
    expect(parseTracesSampleRateOverride("abc")).toBe(1.0);
    expect(warnSpy).toHaveBeenCalledWith(
      "sentry_traces_sample_rate_override_warn",
      expect.objectContaining({ raw: "abc", reason: "non_finite", fallback: 1.0 })
    );
  });

  it("clamps to 1 and warns for override above 1", () => {
    expect(parseTracesSampleRateOverride("1.5")).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "sentry_traces_sample_rate_override_warn",
      expect.objectContaining({ raw: "1.5", reason: "above_one", clamped: 1 })
    );
  });

  it("clamps to 0 and warns for negative override", () => {
    expect(parseTracesSampleRateOverride("-0.1")).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      "sentry_traces_sample_rate_override_warn",
      expect.objectContaining({ raw: "-0.1", reason: "below_zero", clamped: 0 })
    );
  });

  it("treats Infinity literal as non-finite fallback", () => {
    expect(parseTracesSampleRateOverride("Infinity")).toBe(1.0);
    expect(warnSpy).toHaveBeenCalledWith(
      "sentry_traces_sample_rate_override_warn",
      expect.objectContaining({ raw: "Infinity", reason: "non_finite", fallback: 1.0 })
    );
  });

  it("returns exact boundary value 0", () => {
    expect(parseTracesSampleRateOverride("0")).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("returns exact boundary value 1", () => {
    expect(parseTracesSampleRateOverride("1")).toBe(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("handles very small valid override", () => {
    expect(parseTracesSampleRateOverride("0.001")).toBe(0.001);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("warns only once per unique invalid raw value across repeated calls", () => {
    parseTracesSampleRateOverride("2");
    parseTracesSampleRateOverride("2");
    parseTracesSampleRateOverride("2");
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("warns once per distinct invalid value (different raw values do warn)", () => {
    parseTracesSampleRateOverride("2");
    parseTracesSampleRateOverride("3");
    parseTracesSampleRateOverride("2");
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});

describe("tracesSampler integration (rate * override)", () => {
  it.each([
    { routeName: "cron", spanName: "scheduled", expected: 0.05 },
    { routeName: "availability", spanName: "GET /api/public/availability", expected: 0.005 },
    { routeName: "admin", spanName: "GET /api/admin/reservations", expected: 0.025 }
  ])("override 0.5 halves the $routeName rate", ({ spanName, expected }) => {
    const override = parseTracesSampleRateOverride("0.5");
    const base = getBaseSampleRate(spanName);
    expect(base * override).toBeCloseTo(expected, 10);
  });

  it("override 0 disables all sampling", () => {
    const override = parseTracesSampleRateOverride("0");
    expect(getBaseSampleRate("scheduled") * override).toBe(0);
    expect(getBaseSampleRate("GET /api/public/availability") * override).toBe(0);
    expect(getBaseSampleRate("POST /api/public/reservations") * override).toBe(0);
    expect(getBaseSampleRate("GET /api/admin/reservations") * override).toBe(0);
  });

  it("NaN override defaults to 1.0, rates unchanged", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const override = parseTracesSampleRateOverride("not-a-number");
    expect(override).toBe(1.0);
    expect(getBaseSampleRate("scheduled") * override).toBe(0.1);
    expect(getBaseSampleRate("GET /api/public/availability") * override).toBe(0.01);
  });

  it("out-of-range 1.5 clamps to 1, rates unchanged", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const override = parseTracesSampleRateOverride("1.5");
    expect(override).toBe(1);
    expect(getBaseSampleRate("scheduled") * override).toBe(0.1);
  });

  it("out-of-range -0.1 clamps to 0, all rates zero", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const override = parseTracesSampleRateOverride("-0.1");
    expect(override).toBe(0);
    expect(getBaseSampleRate("scheduled") * override).toBe(0);
  });

  it("everything-else routes remain 0 regardless of override", () => {
    const override = parseTracesSampleRateOverride("1");
    expect(getBaseSampleRate("GET /") * override).toBe(0);
    expect(getBaseSampleRate("GET /api/health") * override).toBe(0);
    expect(getBaseSampleRate("") * override).toBe(0);
  });
});
