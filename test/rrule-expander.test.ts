import { describe, expect, it } from "vitest";

import { expandRrule, __testing__ } from "../src/google/rrule-expander";
import { JST_OFFSET_MS } from "../src/time-utils";

const { parseRrule, parseUtcBasicIso, ABSOLUTE_MAX_OCCURRENCES } = __testing__;

const iso = (raw: string): number => Date.parse(raw);

describe("parseUtcBasicIso", () => {
  it("parses YYYYMMDDTHHMMSSZ form", () => {
    expect(parseUtcBasicIso("20260519T120000Z")).toBe(Date.parse("2026-05-19T12:00:00Z"));
  });
  it("parses YYYYMMDD date-only form as midnight UTC", () => {
    expect(parseUtcBasicIso("20260519")).toBe(Date.parse("2026-05-19T00:00:00Z"));
  });
  it("rejects time component without Z suffix", () => {
    expect(parseUtcBasicIso("20260519T120000")).toBeNull();
  });
  it("rejects malformed input", () => {
    expect(parseUtcBasicIso("not-a-date")).toBeNull();
    expect(parseUtcBasicIso("2026-05-19")).toBeNull();
  });
});

describe("parseRrule", () => {
  it("parses FREQ=DAILY with INTERVAL", () => {
    const r = parseRrule("FREQ=DAILY;INTERVAL=2");
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.freq).toBe("DAILY");
    expect(r.interval).toBe(2);
  });
  it("strips the RRULE: prefix", () => {
    const r = parseRrule("RRULE:FREQ=WEEKLY");
    expect("error" in r).toBe(false);
  });
  it("parses BYDAY for WEEKLY in sorted order", () => {
    const r = parseRrule("FREQ=WEEKLY;BYDAY=FR,MO,WE");
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.byDay).toEqual([1, 3, 5]);
  });
  it("rejects BYDAY on non-WEEKLY", () => {
    const r = parseRrule("FREQ=DAILY;BYDAY=MO");
    expect("error" in r && r.error === "invalid_rrule").toBe(true);
  });
  it("rejects BYMONTHDAY on non-MONTHLY", () => {
    const r = parseRrule("FREQ=WEEKLY;BYMONTHDAY=15");
    expect("error" in r && r.error === "invalid_rrule").toBe(true);
  });
  it("rejects unsupported FREQ", () => {
    const r = parseRrule("FREQ=YEARLY");
    expect("error" in r && r.error === "unsupported_freq").toBe(true);
  });
  it("rejects empty rule", () => {
    expect("error" in parseRrule("")).toBe(true);
  });
  it("rejects malformed segment", () => {
    expect("error" in parseRrule("FREQ=DAILY;NOEQUALS")).toBe(true);
  });

  it("rejects unknown / out-of-scope RRULE keys (WKST, BYSETPOS, BYHOUR)", () => {
    expect("error" in parseRrule("FREQ=WEEKLY;BYDAY=MO;WKST=MO")).toBe(true);
    expect("error" in parseRrule("FREQ=MONTHLY;BYMONTHDAY=15;BYSETPOS=-1")).toBe(true);
    expect("error" in parseRrule("FREQ=DAILY;BYHOUR=10")).toBe(true);
  });

  it("rejects partial numeric tokens (INTERVAL=2x, COUNT=10abc, BYMONTHDAY=15foo)", () => {
    expect("error" in parseRrule("FREQ=DAILY;INTERVAL=2x")).toBe(true);
    expect("error" in parseRrule("FREQ=DAILY;COUNT=10abc")).toBe(true);
    expect("error" in parseRrule("FREQ=MONTHLY;BYMONTHDAY=15foo")).toBe(true);
  });

  it("rejects UNTIL pointing at a non-existent calendar date", () => {
    // 20260230 = Feb 30 (does not exist). Date.parse would silently
    // normalise to Mar 2; the round-trip guard must reject it.
    expect("error" in parseRrule("FREQ=DAILY;UNTIL=20260230T000000Z")).toBe(true);
  });
});

describe("expandRrule", () => {
  it("DAILY: 7 occurrences within a 7-day window", () => {
    const dtstart = iso("2026-05-19T10:00:00Z");
    const result = expandRrule({
      rrule: "FREQ=DAILY",
      dtstartMs: dtstart,
      windowEndMs: dtstart + 6 * 24 * 60 * 60 * 1000
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.occurrences).toHaveLength(7);
    expect(result.occurrences[0].toISOString()).toBe("2026-05-19T10:00:00.000Z");
    expect(result.occurrences[6].toISOString()).toBe("2026-05-25T10:00:00.000Z");
  });

  it("DAILY INTERVAL=2: every other day, 5 occurrences over 8-day window", () => {
    const dtstart = iso("2026-05-19T10:00:00Z");
    const result = expandRrule({
      rrule: "FREQ=DAILY;INTERVAL=2",
      dtstartMs: dtstart,
      windowEndMs: dtstart + 8 * 24 * 60 * 60 * 1000
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.occurrences.map((d) => d.toISOString())).toEqual([
      "2026-05-19T10:00:00.000Z",
      "2026-05-21T10:00:00.000Z",
      "2026-05-23T10:00:00.000Z",
      "2026-05-25T10:00:00.000Z",
      "2026-05-27T10:00:00.000Z"
    ]);
  });

  it("WEEKLY BYDAY=MO,WE,FR: 3 weeks → 9 occurrences", () => {
    // 2026-05-18 is a Monday.
    const dtstart = iso("2026-05-18T10:00:00Z");
    const result = expandRrule({
      rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR",
      dtstartMs: dtstart,
      windowEndMs: dtstart + 20 * 24 * 60 * 60 * 1000 // ~3 weeks
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.occurrences).toHaveLength(9);
    expect(result.occurrences[0].toISOString()).toBe("2026-05-18T10:00:00.000Z");
    // Each occurrence falls on Monday (1), Wednesday (3), or Friday (5).
    for (const occ of result.occurrences) {
      expect([1, 3, 5]).toContain(occ.getUTCDay());
    }
  });

  it("MONTHLY BYMONTHDAY=15: 3 months → 3 occurrences", () => {
    const dtstart = iso("2026-05-15T10:00:00Z");
    const result = expandRrule({
      rrule: "FREQ=MONTHLY;BYMONTHDAY=15",
      dtstartMs: dtstart,
      windowEndMs: iso("2026-08-15T10:00:00Z")
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.occurrences.map((d) => d.toISOString())).toEqual([
      "2026-05-15T10:00:00.000Z",
      "2026-06-15T10:00:00.000Z",
      "2026-07-15T10:00:00.000Z",
      "2026-08-15T10:00:00.000Z"
    ]);
  });

  it("MONTHLY BYMONTHDAY=31: February skipped (no day 31)", () => {
    const dtstart = iso("2026-01-31T10:00:00Z");
    const result = expandRrule({
      rrule: "FREQ=MONTHLY;BYMONTHDAY=31",
      dtstartMs: dtstart,
      windowEndMs: iso("2026-05-31T10:00:00Z")
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.occurrences.map((d) => d.toISOString())).toEqual([
      "2026-01-31T10:00:00.000Z",
      "2026-03-31T10:00:00.000Z",
      "2026-05-31T10:00:00.000Z"
    ]);
  });

  it("respects COUNT cap (stops at N occurrences)", () => {
    const dtstart = iso("2026-05-19T10:00:00Z");
    const result = expandRrule({
      rrule: "FREQ=DAILY;COUNT=3",
      dtstartMs: dtstart,
      windowEndMs: dtstart + 30 * 24 * 60 * 60 * 1000
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.occurrences).toHaveLength(3);
  });

  it("respects UNTIL cap (stops at the boundary)", () => {
    const dtstart = iso("2026-05-19T10:00:00Z");
    const result = expandRrule({
      rrule: "FREQ=DAILY;UNTIL=20260522T100000Z",
      dtstartMs: dtstart,
      windowEndMs: dtstart + 30 * 24 * 60 * 60 * 1000
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.occurrences.map((d) => d.toISOString())).toEqual([
      "2026-05-19T10:00:00.000Z",
      "2026-05-20T10:00:00.000Z",
      "2026-05-21T10:00:00.000Z",
      "2026-05-22T10:00:00.000Z"
    ]);
  });

  it("respects maxOccurrences hard cap and marks truncatedByCap", () => {
    const dtstart = iso("2026-05-19T10:00:00Z");
    const result = expandRrule({
      rrule: "FREQ=DAILY",
      dtstartMs: dtstart,
      windowEndMs: dtstart + 1000 * 24 * 60 * 60 * 1000,
      maxOccurrences: 5
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.occurrences).toHaveLength(5);
    expect(result.truncatedByCap).toBe(true);
  });

  it("clamps maxOccurrences to ABSOLUTE_MAX_OCCURRENCES", () => {
    const dtstart = iso("2026-05-19T10:00:00Z");
    const result = expandRrule({
      rrule: "FREQ=DAILY;COUNT=10000",
      dtstartMs: dtstart,
      windowEndMs: dtstart + 10000 * 24 * 60 * 60 * 1000,
      maxOccurrences: 999999
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.occurrences.length).toBeLessThanOrEqual(ABSOLUTE_MAX_OCCURRENCES);
  });

  it.each([
    {
      caseName: "malformed input",
      input: {
        rrule: "NOT A VALID RULE",
        dtstartMs: iso("2026-05-19T10:00:00Z"),
        windowEndMs: iso("2026-05-26T10:00:00Z")
      },
      reason: "invalid_rrule"
    },
    {
      caseName: "FREQ=YEARLY",
      input: {
        rrule: "FREQ=YEARLY",
        dtstartMs: iso("2026-05-19T10:00:00Z"),
        windowEndMs: iso("2030-05-19T10:00:00Z")
      },
      reason: "unsupported_freq"
    },
    {
      caseName: "windowEndMs < dtstartMs",
      input: {
        rrule: "FREQ=DAILY",
        dtstartMs: iso("2026-05-19T10:00:00Z"),
        windowEndMs: iso("2026-05-18T10:00:00Z")
      },
      reason: "invalid_dtstart"
    },
    {
      // A non-finite offset makes every candidate NaN, and NaN loses every
      // comparison — without this guard the cap fills with Invalid Date.
      caseName: "non-finite localOffsetMs",
      input: {
        rrule: "FREQ=WEEKLY;BYDAY=MO",
        dtstartMs: iso("2026-05-19T10:00:00Z"),
        windowEndMs: iso("2026-06-19T10:00:00Z"),
        localOffsetMs: Number.NaN
      },
      reason: "invalid_dtstart"
    }
  ])("returns $reason for $caseName", ({ input, reason }) => {
    const result = expandRrule(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(reason);
  });

  it("truncatedByWindow=true when WEEKLY BYDAY rule has a candidate past the window before UNTIL", () => {
    // dtstart Mon May18 10:00, UNTIL May25, BYDAY=MO,WE,FR.
    // Window ends Sat May23, so within: Mon18, Wed20, Fri22 = 3.
    // Real next valid candidate is Mon25 (which is <= UNTIL) → truncated.
    const dtstart = iso("2026-05-18T10:00:00Z");
    const result = expandRrule({
      rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20260525T100000Z",
      dtstartMs: dtstart,
      windowEndMs: iso("2026-05-23T23:59:59Z")
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.occurrences.map((d) => d.toISOString())).toEqual([
      "2026-05-18T10:00:00.000Z",
      "2026-05-20T10:00:00.000Z",
      "2026-05-22T10:00:00.000Z"
    ]);
    expect(result.truncatedByWindow).toBe(true);
  });

  it("truncatedByWindow=true when an unbounded rule's last occurrence equals windowEndMs and another step would still fit", () => {
    const dtstart = iso("2026-05-19T10:00:00Z");
    // DAILY rule with no UNTIL / COUNT; window ends exactly on the
    // 7th occurrence. Real next would be May26 → window-truncated.
    const result = expandRrule({
      rrule: "FREQ=DAILY",
      dtstartMs: dtstart,
      windowEndMs: iso("2026-05-25T10:00:00Z")
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.occurrences).toHaveLength(7);
    expect(result.occurrences[6].toISOString()).toBe("2026-05-25T10:00:00.000Z");
    expect(result.truncatedByWindow).toBe(true);
  });

  it("truncatedByWindow=false when UNTIL has been reached before window cap", () => {
    const dtstart = iso("2026-05-18T10:00:00Z");
    const result = expandRrule({
      rrule: "FREQ=DAILY;UNTIL=20260520T100000Z",
      dtstartMs: dtstart,
      windowEndMs: iso("2026-06-30T00:00:00Z")
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.occurrences).toHaveLength(3); // 18, 19, 20
    expect(result.truncatedByWindow).toBe(false);
  });

  it("truncatedByWindow=true when MONTHLY BYMONTHDAY=31 has a skipped-month candidate past window", () => {
    // dtstart Jan31 10:00, BYMONTHDAY=31, window ends May15.
    // Inside window: Jan31, Mar31 (Feb skipped). Real next valid is May31
    // (Apr skipped, May 31 > windowEnd) → truncated.
    const dtstart = iso("2026-01-31T10:00:00Z");
    const result = expandRrule({
      rrule: "FREQ=MONTHLY;BYMONTHDAY=31",
      dtstartMs: dtstart,
      windowEndMs: iso("2026-05-15T00:00:00Z")
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.occurrences.map((d) => d.toISOString())).toEqual([
      "2026-01-31T10:00:00.000Z",
      "2026-03-31T10:00:00.000Z"
    ]);
    expect(result.truncatedByWindow).toBe(true);
  });

  it("WEEKLY BYDAY=SA,SU keeps the final Saturday when UNTIL falls on that Saturday", () => {
    // Regression: BYDAY sorted by weekday code yields [SU(0), SA(6)], so the
    // inner loop visited Sunday (later in the Mon-anchored week) before
    // Saturday (earlier). With UNTIL on a Saturday, the next week's Sunday
    // candidate exceeded UNTIL and the early-return dropped that week's
    // Saturday — which is <= UNTIL — entirely.
    // 2026-05-23 = Saturday, 2026-05-24 = Sunday, 2026-05-30 = Saturday.
    const dtstart = iso("2026-05-23T10:00:00Z");
    const result = expandRrule({
      rrule: "FREQ=WEEKLY;BYDAY=SA,SU;UNTIL=20260530T100000Z",
      dtstartMs: dtstart,
      windowEndMs: iso("2026-07-01T00:00:00Z")
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.occurrences.map((d) => d.toISOString())).toEqual([
      "2026-05-23T10:00:00.000Z",
      "2026-05-24T10:00:00.000Z",
      "2026-05-30T10:00:00.000Z"
    ]);
  });

  it("WEEKLY BYDAY emits occurrences in ascending chronological order even when BYDAY contains SU", () => {
    // 2026-05-18 = Monday. BYDAY=SU,SA must still produce Sat-before-Sun
    // ordering each week (Sat is earlier in a Monday-anchored week).
    const dtstart = iso("2026-05-18T10:00:00Z");
    const result = expandRrule({
      rrule: "FREQ=WEEKLY;BYDAY=SU,SA",
      dtstartMs: dtstart,
      windowEndMs: dtstart + 13 * 24 * 60 * 60 * 1000
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ms = result.occurrences.map((d) => d.getTime());
    const ascending = [...ms].sort((a, b) => a - b);
    expect(ms).toEqual(ascending);
  });

  it("preserves time-of-day across WEEKLY BYDAY occurrences", () => {
    // 2026-05-18 = Monday 14:30:00. Expand to MO + TH for 2 weeks.
    const dtstart = iso("2026-05-18T14:30:00Z");
    const result = expandRrule({
      rrule: "FREQ=WEEKLY;BYDAY=MO,TH",
      dtstartMs: dtstart,
      windowEndMs: dtstart + 13 * 24 * 60 * 60 * 1000
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const occ of result.occurrences) {
      expect(occ.getUTCHours()).toBe(14);
      expect(occ.getUTCMinutes()).toBe(30);
    }
    // Mon May 18, Thu May 21, Mon May 25, Thu May 28 = 4 occurrences
    expect(result.occurrences).toHaveLength(4);
  });

  // JST local-calendar expansion (localOffsetMs). Without the offset, a
  // 07:00 JST Monday (UTC Sunday 22:00) was matched as WEEKLY BYDAY=MO on
  // the UTC calendar and landed on Tuesday JST.
  const formatJst = (ms: number): string =>
    new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      weekday: "short"
    }).format(new Date(ms));

  it("WEEKLY BYDAY=MO with localOffsetMs=JST keeps 07:00 JST Monday on Monday", () => {
    // 2026-08-10 07:00 JST = 2026-08-09T22:00:00.000Z (UTC Sunday).
    // UTC-calendar expansion wrongly advances to Tue 08-11 07:00 JST.
    const dtstart = iso("2026-08-09T22:00:00.000Z");
    const result = expandRrule({
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      dtstartMs: dtstart,
      windowEndMs: dtstart + 14 * 24 * 60 * 60 * 1000,
      localOffsetMs: JST_OFFSET_MS
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.occurrences.length).toBeGreaterThanOrEqual(1);
    const first = result.occurrences[0].getTime();
    expect(first).toBe(dtstart);
    // ja-JP short weekday for Monday is "月"
    const jst = formatJst(first);
    expect(jst).toMatch(/2026\/08\/10/);
    expect(jst).toMatch(/07:00/);
    expect(jst).toMatch(/月/);
  });

  it("MONTHLY BYMONTHDAY=1 with localOffsetMs=JST keeps 00:00 JST on the 1st", () => {
    // 2026-08-01 00:00 JST = 2026-07-31T15:00:00.000Z. UTC calendar day is
    // July 31, so a UTC expander with BYMONTHDAY=1 would skip Aug 1 entirely
    // and land on Sep 1 (or emit nothing in the first local month).
    const dtstart = iso("2026-07-31T15:00:00.000Z");
    const result = expandRrule({
      rrule: "FREQ=MONTHLY;BYMONTHDAY=1",
      dtstartMs: dtstart,
      windowEndMs: dtstart + 100 * 24 * 60 * 60 * 1000,
      localOffsetMs: JST_OFFSET_MS
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.occurrences.length).toBeGreaterThanOrEqual(1);
    const first = result.occurrences[0].getTime();
    expect(first).toBe(dtstart);
    const jst = formatJst(first);
    expect(jst).toMatch(/2026\/08\/01/);
  });
});
