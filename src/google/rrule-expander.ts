// Pure RRULE expansion utility. The recurring/all-day wizard turns a single
// Google Calendar RRULE-bearing event into N D1 external_blocks rows
// (one per occurrence within a 90-day window). This module is the core
// expansion function consumed by the SSR preview UI and the
// POST /api/admin/recurring/commit endpoint.
//
// Scope: RFC 5545 RRULE subset that covers the recurring patterns Google
// Calendar actually emits for the typical shop-hour / staff-vacation
// flows seen in this codebase:
//   - FREQ=DAILY | WEEKLY | MONTHLY
//   - INTERVAL (default 1)
//   - COUNT  (occurrence cap)
//   - UNTIL  (RFC 5545 yyyymmddTHHMMSSZ ISO basic UTC)
//   - BYDAY  (WEEKLY only: comma-separated SU/MO/TU/WE/TH/FR/SA)
//   - BYMONTHDAY (MONTHLY only: comma-separated integers 1-31)
//
// Out of scope (rejected for this iteration):
//   - FREQ=SECONDLY | MINUTELY | HOURLY | YEARLY (rare; no shop use case)
//   - BYSETPOS / BYWEEKNO / BYYEARDAY (advanced)
//   - WKST (week-start override; we use Monday=0 internally)
//   - RDATE / EXDATE additions (separate concern)
//   - Timezone-aware DTSTART (today's call sites pass UTC instants)
//
// Calendar-day and weekday matching (WEEKLY BYDAY, MONTHLY BYMONTHDAY,
// default day when those parts are omitted) uses `localOffsetMs` so callers
// that store JST-local wall times as UTC instants can expand against the
// local calendar. Omit it (or pass 0) for pure UTC calendar semantics.
// UNTIL / windowEndMs / dtstartMs comparisons always stay on real UTC ms.
//
// The expander returns an array of `Date` instants in ascending order.
// Callers cap the result to the wizard's preview window
// (typically 90 days from DTSTART).

export type RruleExpanderInput = {
  // RFC 5545 RRULE clause, with or without a leading "RRULE:" prefix.
  rrule: string;
  // Start instant. The expander treats this as the first candidate
  // occurrence and walks forward by `INTERVAL` units of `FREQ`.
  dtstartMs: number;
  // Hard end of the search window (inclusive). Occurrences strictly after
  // this instant are not emitted. Typical: dtstart + 90 days.
  windowEndMs: number;
  // Hard cap on the number of occurrences returned regardless of the
  // RRULE itself. Defends against malformed input or runaway expansion.
  maxOccurrences?: number;
  /**
   * Offset of the caller's local timezone from UTC in milliseconds
   * (e.g. JST = 9 * 60 * 60 * 1000). Calendar day and weekday for
   * WEEKLY/MONTHLY matching are derived on a virtual clock of
   * `instantMs + localOffsetMs` via getUTC* / setUTCHours / Date.UTC.
   * Omit (or 0) to keep UTC calendar semantics. Does not change DAILY
   * expansion (interval arithmetic only).
   */
  localOffsetMs?: number;
};

export type RruleExpanderResult =
  | { ok: true; occurrences: Date[]; truncatedByWindow: boolean; truncatedByCap: boolean }
  | { ok: false; reason: "invalid_rrule" | "unsupported_freq" | "invalid_dtstart" };

type ParsedRrule = {
  freq: "DAILY" | "WEEKLY" | "MONTHLY";
  interval: number;
  count: number | null;
  untilMs: number | null;
  byDay: number[] | null; // 0=Sunday..6=Saturday
  byMonthDay: number[] | null;
};

const DEFAULT_MAX_OCCURRENCES = 500;
const ABSOLUTE_MAX_OCCURRENCES = 1000; // 1000 occurrences × 7 MB = ~7 MB; safe upper bound.

const WEEKDAY_CODE_TO_NUMBER: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6
};

const parseUtcBasicIso = (raw: string): number | null => {
  // RFC 5545 basic UTC form: YYYYMMDDTHHMMSSZ. Also accept the
  // date-only variant YYYYMMDD which Google sometimes emits for
  // all-day RRULEs (we treat it as midnight UTC).
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(raw);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, z] = match;
  if (hour && !z) return null; // require Z when time component is present
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  const h = Number(hour ?? "00");
  const mi = Number(minute ?? "00");
  const s = Number(second ?? "00");
  // Range guards before Date.UTC, because Date.UTC silently normalizes
  // invalid days (Feb 30 → Mar 2). Round-trip the constructed date back
  // through getUTC* and reject if any component drifted.
  if (mo < 1 || mo > 12) return null;
  if (d < 1 || d > 31) return null;
  if (h > 23 || mi > 59 || s > 59) return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  if (!Number.isFinite(ms)) return null;
  const dt = new Date(ms);
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return ms;
};

type ParseError = "invalid_rrule" | "unsupported_freq";

// Explicit allowlist: any RRULE key outside this set is rejected so a
// caller cannot smuggle WKST/BYSETPOS/BYHOUR/etc. past the expander and
// receive occurrences with subtly wrong semantics. Add new keys here
// only after the expander honors them.
const SUPPORTED_RRULE_KEYS: ReadonlySet<string> = new Set([
  "FREQ",
  "INTERVAL",
  "COUNT",
  "UNTIL",
  "BYDAY",
  "BYMONTHDAY"
]);

const POSITIVE_INT_RE = /^\d+$/;

const parsePositiveInt = (raw: string): number | null => {
  if (!POSITIVE_INT_RE.test(raw)) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : null;
};

const parseRrule = (raw: string): ParsedRrule | { error: ParseError } => {
  const stripped = raw.trim().replace(/^RRULE:/, "");
  if (stripped.length === 0) {
    return { error: "invalid_rrule" };
  }
  const parts = new Map<string, string>();
  for (const segment of stripped.split(";")) {
    const eq = segment.indexOf("=");
    if (eq < 0) return { error: "invalid_rrule" };
    const key = segment.slice(0, eq).trim().toUpperCase();
    const value = segment.slice(eq + 1).trim();
    if (key.length === 0 || value.length === 0) return { error: "invalid_rrule" };
    if (!SUPPORTED_RRULE_KEYS.has(key)) {
      // Reject silently-ignored advanced clauses (WKST, BYHOUR, BYSETPOS,
      // BYWEEKNO, BYYEARDAY, etc.). Honoring them later would change
      // occurrence semantics so we surface the gap as an explicit error.
      return { error: "invalid_rrule" };
    }
    parts.set(key, value);
  }
  const freq = parts.get("FREQ");
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY") {
    return { error: "unsupported_freq" };
  }
  let interval = 1;
  const intervalRaw = parts.get("INTERVAL");
  if (intervalRaw !== undefined) {
    const parsed = parsePositiveInt(intervalRaw);
    if (parsed === null) return { error: "invalid_rrule" };
    interval = parsed;
  }
  let count: number | null = null;
  const countRaw = parts.get("COUNT");
  if (countRaw !== undefined) {
    const parsed = parsePositiveInt(countRaw);
    if (parsed === null) return { error: "invalid_rrule" };
    count = parsed;
  }
  let untilMs: number | null = null;
  const untilRaw = parts.get("UNTIL");
  if (untilRaw !== undefined) {
    const parsed = parseUtcBasicIso(untilRaw);
    if (parsed === null) return { error: "invalid_rrule" };
    untilMs = parsed;
  }
  let byDay: number[] | null = null;
  const byDayRaw = parts.get("BYDAY");
  if (byDayRaw !== undefined) {
    if (freq !== "WEEKLY") return { error: "invalid_rrule" }; // we only honour BYDAY on WEEKLY
    const tokens = byDayRaw.split(",").map((t) => t.trim().toUpperCase());
    const numbers: number[] = [];
    for (const token of tokens) {
      const num = WEEKDAY_CODE_TO_NUMBER[token];
      if (num === undefined) return { error: "invalid_rrule" };
      if (!numbers.includes(num)) numbers.push(num);
    }
    if (numbers.length === 0) return { error: "invalid_rrule" };
    byDay = numbers.toSorted((a, b) => a - b);
  }
  let byMonthDay: number[] | null = null;
  const byMonthDayRaw = parts.get("BYMONTHDAY");
  if (byMonthDayRaw !== undefined) {
    if (freq !== "MONTHLY") return { error: "invalid_rrule" };
    const tokens = byMonthDayRaw.split(",").map((t) => t.trim());
    const numbers: number[] = [];
    for (const token of tokens) {
      if (!POSITIVE_INT_RE.test(token)) return { error: "invalid_rrule" };
      const num = Number.parseInt(token, 10);
      if (!Number.isFinite(num) || num < 1 || num > 31) return { error: "invalid_rrule" };
      if (!numbers.includes(num)) numbers.push(num);
    }
    if (numbers.length === 0) return { error: "invalid_rrule" };
    byMonthDay = numbers.toSorted((a, b) => a - b);
  }
  return { freq, interval, count, untilMs, byDay, byMonthDay };
};

type ExpandResult = {
  occurrences: Date[];
  cappedByCap: boolean;
  // True when at least one valid candidate exists strictly past
  // windowEndMs AND is not blocked by COUNT/UNTIL/cap. Drives the
  // top-level truncatedByWindow flag without resorting to a probe.
  sawAfterWindow: boolean;
};

const expandDaily = (
  rule: ParsedRrule,
  dtstartMs: number,
  windowEndMs: number,
  cap: number
): ExpandResult => {
  const occurrences: Date[] = [];
  const dayMs = 24 * 60 * 60 * 1000;
  const step = rule.interval * dayMs;
  let current = dtstartMs;
  let count = 0;
  while (true) {
    if (rule.untilMs !== null && current > rule.untilMs) {
      return { occurrences, cappedByCap: false, sawAfterWindow: false };
    }
    if (rule.count !== null && count >= rule.count) {
      return { occurrences, cappedByCap: false, sawAfterWindow: false };
    }
    if (current > windowEndMs) {
      return { occurrences, cappedByCap: false, sawAfterWindow: true };
    }
    if (occurrences.length >= cap) {
      return { occurrences, cappedByCap: true, sawAfterWindow: false };
    }
    occurrences.push(new Date(current));
    count += 1;
    current += step;
  }
};

const expandWeekly = (
  rule: ParsedRrule,
  dtstartMs: number,
  windowEndMs: number,
  cap: number,
  localOffsetMs: number
): ExpandResult => {
  const occurrences: Date[] = [];
  const dayMs = 24 * 60 * 60 * 1000;
  const weekMs = 7 * dayMs;
  // getUTCDay returns Sun=0..Sat=6, so we shift to Mon=0..Sun=6 with
  // (n + 6) % 7. Used both to anchor weekStart on Monday and to order the
  // BYDAY weekdays by their position within the Monday-anchored week.
  const offsetFromMonday = (utcDay: number): number => (utcDay + 6) % 7;
  // Virtual clock: shift by localOffsetMs so getUTC* / setUTCHours reflect
  // the caller's local calendar. Candidate values built on this clock are
  // converted back to real UTC ms before comparing with dtstart/UNTIL/window.
  const virtualDtstart = dtstartMs + localOffsetMs;
  // BYDAY is stored in Sun=0..Sat=6 code order, but the per-week loop relies
  // on candidates being visited in ascending chronological order — the UNTIL
  // early-return assumes that once a candidate exceeds UNTIL, every later one
  // does too. Sun(0) maps to the LAST day of the Monday-anchored week, so we
  // must iterate by Monday-offset rather than raw weekday code; otherwise a
  // BYDAY set such as SA,SU would visit Sunday before the earlier Saturday and
  // could drop a valid Saturday occurrence sitting on the UNTIL date.
  const targetWeekdays = (rule.byDay ?? [new Date(virtualDtstart).getUTCDay()]).toSorted(
    (a, b) => offsetFromMonday(a) - offsetFromMonday(b)
  );
  const dtMidnight = new Date(virtualDtstart);
  dtMidnight.setUTCHours(0, 0, 0, 0);
  const dtMidnightMs = dtMidnight.getTime();
  // weekStart = local-midnight of the Monday in dtstart's ISO week
  // (WKST=MO is the RFC 5545 default; the file header says we anchor on
  // Monday internally). Still on the virtual clock.
  let weekStart = dtMidnightMs - offsetFromMonday(dtMidnight.getUTCDay()) * dayMs;
  const dtTimeOfDayMs = virtualDtstart - dtMidnightMs;
  let count = 0;
  // Iterate weeks; for each week walk every BYDAY weekday. The maxLookahead
  // cap stops a runaway BYDAY-with-no-matches loop after a hard ceiling on
  // weeks scanned. 10x ABSOLUTE_MAX_OCCURRENCES is generous enough for any
  // realistic rule and prevents pathological infinite loops on bad inputs.
  const maxWeeks = ABSOLUTE_MAX_OCCURRENCES * 10;
  for (let wi = 0; wi < maxWeeks; wi += 1) {
    let sawAnyCandidateThisWeek = false;
    for (const weekday of targetWeekdays) {
      // weekday is in Sun=0..Sat=6 form (matches getUTCDay + WEEKDAY_CODE_TO_NUMBER).
      // Convert to Mon=0..Sun=6 offset so the candidate aligns with the
      // Monday-anchored weekStart. Subtract localOffsetMs to get real UTC.
      const candidate =
        weekStart + offsetFromMonday(weekday) * dayMs + dtTimeOfDayMs - localOffsetMs;
      if (candidate < dtstartMs) continue;
      if (rule.untilMs !== null && candidate > rule.untilMs) {
        // No further candidate can satisfy UNTIL — neither this week
        // nor any later week.
        return { occurrences, cappedByCap: false, sawAfterWindow: false };
      }
      if (rule.count !== null && count >= rule.count) {
        return { occurrences, cappedByCap: false, sawAfterWindow: false };
      }
      if (candidate > windowEndMs) {
        // Valid candidate exists past the window → truncatedByWindow.
        return { occurrences, cappedByCap: false, sawAfterWindow: true };
      }
      if (occurrences.length >= cap) {
        return { occurrences, cappedByCap: true, sawAfterWindow: false };
      }
      occurrences.push(new Date(candidate));
      count += 1;
      sawAnyCandidateThisWeek = true;
    }
    // Defensive: if BYDAY produces no candidates AT ALL in a week, we've
    // already terminated via UNTIL/COUNT/cap above. Bail just in case.
    // weekStart is virtual; compare real-UTC week start against windowEndMs.
    if (!sawAnyCandidateThisWeek && weekStart - localOffsetMs > windowEndMs) {
      return { occurrences, cappedByCap: false, sawAfterWindow: false };
    }
    weekStart += rule.interval * weekMs;
  }
  return { occurrences, cappedByCap: false, sawAfterWindow: false };
};

const expandMonthly = (
  rule: ParsedRrule,
  dtstartMs: number,
  windowEndMs: number,
  cap: number,
  localOffsetMs: number
): ExpandResult => {
  const occurrences: Date[] = [];
  // Virtual clock for year/month/day/time-of-day extraction (local calendar).
  const virtualDt = new Date(dtstartMs + localOffsetMs);
  const targetDays = rule.byMonthDay ?? [virtualDt.getUTCDate()];
  const startYear = virtualDt.getUTCFullYear();
  const startMonth = virtualDt.getUTCMonth();
  const timeMs =
    virtualDt.getUTCHours() * 60 * 60 * 1000 +
    virtualDt.getUTCMinutes() * 60 * 1000 +
    virtualDt.getUTCSeconds() * 1000 +
    virtualDt.getUTCMilliseconds();
  let monthOffset = 0;
  let count = 0;
  let sawAfterWindow = false;
  // Cap month iterations to defend against bad inputs (huge INTERVAL +
  // small COUNT could in theory still loop). 10x ABSOLUTE_MAX_OCCURRENCES
  // months is ~83 years at INTERVAL=1.
  const maxMonths = ABSOLUTE_MAX_OCCURRENCES * 10;
  for (let mi = 0; mi < maxMonths; mi += 1) {
    const year = startYear + Math.floor((startMonth + monthOffset) / 12);
    const month = (startMonth + monthOffset) % 12;
    // Virtual local midnight of day 1 → real UTC for UNTIL early-exit.
    const firstOfMonth = Date.UTC(year, month, 1) - localOffsetMs;
    // If even day 1 of this month is past UNTIL, no further month can match.
    if (rule.untilMs !== null && firstOfMonth > rule.untilMs) break;
    // If we're past windowEnd AND haven't yet detected an after-window
    // candidate, walk this month's candidates to see if any sit within
    // [windowEndMs+1, UNTIL]. As soon as we find one, set sawAfterWindow
    // and break out.
    const sortedDays = targetDays.slice().sort((a, b) => a - b);
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    for (const day of sortedDays) {
      if (day > daysInMonth) continue;
      // Build on virtual local calendar, then convert back to real UTC ms.
      const candidate = Date.UTC(year, month, day) + timeMs - localOffsetMs;
      if (candidate < dtstartMs) continue;
      if (rule.untilMs !== null && candidate > rule.untilMs) {
        // Past UNTIL → nothing more to emit.
        return { occurrences, cappedByCap: false, sawAfterWindow };
      }
      if (rule.count !== null && count >= rule.count) {
        return { occurrences, cappedByCap: false, sawAfterWindow };
      }
      if (candidate > windowEndMs) {
        sawAfterWindow = true;
        return { occurrences, cappedByCap: false, sawAfterWindow };
      }
      if (occurrences.length >= cap) {
        return { occurrences, cappedByCap: true, sawAfterWindow: false };
      }
      occurrences.push(new Date(candidate));
      count += 1;
    }
    monthOffset += rule.interval;
  }
  return { occurrences, cappedByCap: false, sawAfterWindow };
};

export const expandRrule = (input: RruleExpanderInput): RruleExpanderResult => {
  if (!Number.isFinite(input.dtstartMs)) {
    return { ok: false, reason: "invalid_dtstart" };
  }
  if (!Number.isFinite(input.windowEndMs) || input.windowEndMs < input.dtstartMs) {
    return { ok: false, reason: "invalid_dtstart" };
  }
  // A non-finite offset poisons every candidate: NaN fails all of the
  // dtstart / UNTIL / window comparisons below, so nothing short-circuits and
  // the loop fills the cap with Invalid Date entries under ok: true.
  if (input.localOffsetMs !== undefined && !Number.isFinite(input.localOffsetMs)) {
    return { ok: false, reason: "invalid_dtstart" };
  }
  const parsed = parseRrule(input.rrule);
  if ("error" in parsed) {
    return {
      ok: false,
      reason: parsed.error === "unsupported_freq" ? "unsupported_freq" : "invalid_rrule"
    };
  }
  const requestedCap = input.maxOccurrences ?? DEFAULT_MAX_OCCURRENCES;
  const cap = Math.max(1, Math.min(ABSOLUTE_MAX_OCCURRENCES, Math.floor(requestedCap)));
  const localOffsetMs = input.localOffsetMs ?? 0;

  let expanded: ExpandResult;
  if (parsed.freq === "DAILY") {
    expanded = expandDaily(parsed, input.dtstartMs, input.windowEndMs, cap);
  } else if (parsed.freq === "WEEKLY") {
    expanded = expandWeekly(parsed, input.dtstartMs, input.windowEndMs, cap, localOffsetMs);
  } else {
    expanded = expandMonthly(parsed, input.dtstartMs, input.windowEndMs, cap, localOffsetMs);
  }

  // truncatedByWindow: the per-FREQ expand function already tracks
  // sawAfterWindow precisely. It's true when a valid candidate exists
  // strictly past windowEndMs AND would not be blocked by COUNT/UNTIL/
  // cap. False positives ruled out by the cap path returning
  // sawAfterWindow=false directly.
  return {
    ok: true,
    occurrences: expanded.occurrences,
    truncatedByWindow: expanded.sawAfterWindow,
    truncatedByCap: expanded.cappedByCap
  };
};

export const __testing__ = {
  parseRrule,
  parseUtcBasicIso,
  DEFAULT_MAX_OCCURRENCES,
  ABSOLUTE_MAX_OCCURRENCES
};
