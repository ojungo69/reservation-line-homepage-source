// Shared pure date/time helpers used across reservation, admin, and Google sync
// paths. Flat src-root util (same pattern as crypto-utils.ts, date-parse.ts).

export const toIso = (date: Date): string => date.toISOString();

export const addMinutes = (date: Date, minutes: number): Date =>
  new Date(date.getTime() + minutes * 60 * 1000);

/** JST (UTC+9) offset in milliseconds. Japan has no DST, so a fixed offset is exact. */
export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

// Maps Intl weekday short names (UTC/JST `weekday` field) to JS getUTCDay() index.
export const WEEKDAY_MAP: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};
