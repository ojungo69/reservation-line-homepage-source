/**
 * Strict ISO-8601 instant parser with round-trip validation.
 *
 * Accepts only the canonical `YYYY-MM-DDTHH:MM:SS(.s{1,3})?Z` form and
 * round-trips through `Date.UTC` + `getUTC*` to reject silently-normalised
 * invalid dates (e.g. `2026-02-30` → `2026-03-02`).
 *
 * ### Fractional seconds
 *
 * The regex accepts 1-3 fractional digits (`.5`, `.05`, `.005`, `.500`).
 * Fractional digits are right-padded to 3 before conversion so that `.5`
 * is interpreted as 500ms (not 5ms) and `.05` as 50ms — matching the
 * semantics of RFC 3339 / ISO 8601 fractional seconds.
 *
 * Inputs with more than 3 fractional digits (e.g. `.123456Z`) are rejected
 * to avoid silent truncation ambiguity.
 */

/**
 * Matches `YYYY-MM-DDTHH:MM:SS(.s{1,3})?Z` — strict UTC instant format.
 *
 * Capture groups:
 *   1: year  2: month  3: day  4: hour  5: minute  6: second  7: frac (optional, 1-3 digits)
 */
export const STRICT_ISO_INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

/**
 * Parse a strict ISO instant string into ms-since-epoch.
 *
 * @returns The UTC epoch timestamp in milliseconds, or `null` if the input
 *   is not a valid strict ISO instant.
 */
export const parseStrictIsoInstantMs = (raw: string): number | null => {
  const match = STRICT_ISO_INSTANT_RE.exec(raw);
  if (!match) return null;
  const y = Number(match[1]);
  const mo = Number(match[2]);
  const d = Number(match[3]);
  const h = Number(match[4]);
  const mi = Number(match[5]);
  const s = Number(match[6]);
  // ISO fractional seconds: `.1` means 0.1s = 100ms, not 1ms; `.01` is 10ms.
  // Right-pad to 3 digits before Number() so the integer literal matches the
  // decimal interpretation Date.parse would give the same string.
  const ms = Number((match[7] ?? "0").padEnd(3, "0"));
  if (mo < 1 || mo > 12) return null;
  if (d < 1 || d > 31) return null;
  if (h > 23 || mi > 59 || s > 59) return null;
  const utc = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  if (!Number.isFinite(utc)) return null;
  const dt = new Date(utc);
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return utc;
};

/**
 * Matches the strict instant form with an explicit UTC designator OR a
 * numeric offset suffix: `YYYY-MM-DDTHH:MM:SS(.s{1,3})?(Z|±HH:MM)`.
 *
 * Capture groups 1-7 mirror {@link STRICT_ISO_INSTANT_RE}; group 8 is the
 * offset suffix (`Z`, `+09:00`, `-05:30`, …).
 */
export const STRICT_ISO_OFFSET_INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Parse a strict ISO instant that may carry a numeric UTC offset.
 *
 * Same strictness as {@link parseStrictIsoInstantMs} (round-trip date
 * validation, 1-3 fractional digits), but additionally accepts `±HH:MM`
 * offsets — needed where existing clients legitimately send local-time
 * instants (e.g. the admin activity filter sends `…T00:00:00+09:00` for a
 * JST day start) and the storage layer normalises with SQLite `datetime()`,
 * which understands offsets.
 *
 * @returns The UTC epoch timestamp in milliseconds, or `null` if the input
 *   is not a valid strict ISO offset instant (offset hours > 23 or minutes
 *   > 59 are rejected).
 */
export const parseStrictIsoOffsetInstantMs = (raw: string): number | null => {
  const match = STRICT_ISO_OFFSET_INSTANT_RE.exec(raw);
  if (!match) return null;
  const offsetRaw = match[8];
  let offsetMinutes = 0;
  if (offsetRaw !== "Z") {
    const sign = offsetRaw.startsWith("-") ? -1 : 1;
    const offsetHours = Number(offsetRaw.slice(1, 3));
    const offsetMins = Number(offsetRaw.slice(4, 6));
    if (offsetHours > 23 || offsetMins > 59) return null;
    offsetMinutes = sign * (offsetHours * 60 + offsetMins);
  }
  // Reuse the strict parser on the wall-clock portion by canonicalising the
  // suffix to Z, then shift by the offset (an instant at +09:00 wall time is
  // offset minutes EARLIER in UTC).
  const wallClockUtc = parseStrictIsoInstantMs(
    `${raw.slice(0, raw.length - offsetRaw.length)}Z`
  );
  if (wallClockUtc === null) return null;
  return wallClockUtc - offsetMinutes * 60 * 1000;
};

/**
 * Parse a strict ISO instant string and return the canonical
 * `YYYY-MM-DDTHH:MM:SS.sssZ` form (via `Date.toISOString()`).
 *
 * This is the preferred form for SQLite TEXT columns where lexicographic
 * ordering must match chronological ordering — non-canonical fractional
 * widths (`.1Z` vs `.150Z`) sort wrong as TEXT.
 *
 * @returns The canonical ISO string, or `null` if the input is invalid or
 *   `value` is not a string.
 */
export const parseIsoInstantToCanonical = (
  value: unknown,
): string | null => {
  if (typeof value !== "string") return null;
  const utc = parseStrictIsoInstantMs(value);
  if (utc === null) return null;
  return new Date(utc).toISOString();
};
