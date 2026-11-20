import { addDays, jstWeekday } from "@/lib/timeline";
import type { BusinessHour } from "@/types/api";

// The approved prototype's grid: 48px per hour over the whole day (DESIGN.md §5).
export const HOUR_PX = 48;
export const PX_PER_MINUTE = HOUR_PX / 60;
export const DAY_MINUTES = 24 * 60;
// A 5-minute booking stays visible and tappable, but is not stretched to the 44px
// touch size: its height stays close to its length (DESIGN.md §4).
export const MIN_EVENT_PX = 18;

const DAY_MS = 86_400_000;

export type Span = Readonly<{ start: number; end: number }>;

/** The part of a span inside one JST day, as minutes from its midnight; null when it misses the day. */
export function clipToDay(startAt: string, endAt: string, dayKey: string): Span | null {
  const dayStart = Date.parse(`${dayKey}T00:00:00+09:00`);
  const start = Math.max(Date.parse(startAt), dayStart);
  const end = Math.min(Date.parse(endAt), dayStart + DAY_MS);
  // Also false for NaN, so an unreadable time is never drawn.
  if (!(end > start)) return null;
  return { start: (start - dayStart) / 60_000, end: (end - dayStart) / 60_000 };
}

export type Placed<T> = Readonly<{ item: T; start: number; end: number; lane: number; lanes: number; span: number }>;

type Laned<T> = { item: T; start: number; end: number; drawnEnd: number; lane: number };

function overlaps(a: { start: number; drawnEnd: number }, b: { start: number; drawnEnd: number }): boolean {
  return a.start < b.drawnEnd && b.start < a.drawnEnd;
}

function placeCluster<T>(cluster: ReadonlyArray<Laned<T>>, lanes: number): Placed<T>[] {
  return cluster.map((entry) => {
    let span = 1;
    while (
      entry.lane + span < lanes &&
      !cluster.some((other) => other.lane === entry.lane + span && overlaps(entry, other))
    ) {
      span++;
    }
    return { item: entry.item, start: entry.start, end: entry.end, lane: entry.lane, lanes, span };
  });
}

/**
 * Side-by-side lanes for the items of one column, so overlapping bookings never
 * hide each other (the approved prototype's layout). Each item takes the first
 * free lane; a run of overlapping items shares one lane count; an item widens
 * into free lanes on its right. Overlap uses the drawn end (minMinutes), so a
 * booking floored to the minimum height never covers the next one.
 */
export function layoutLanes<T>(items: ReadonlyArray<{ item: T; start: number; end: number }>, minMinutes = 0): Placed<T>[] {
  const sorted = items
    .map((entry) => ({ ...entry, drawnEnd: Math.max(entry.end, entry.start + minMinutes) }))
    .sort((a, b) => a.start - b.start || b.drawnEnd - a.drawnEnd);
  const placed: Placed<T>[] = [];
  let cluster: Laned<T>[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = Number.NEGATIVE_INFINITY;
  for (const entry of sorted) {
    if (cluster.length > 0 && entry.start >= clusterEnd) {
      placed.push(...placeCluster(cluster, laneEnds.length));
      cluster = [];
      laneEnds = [];
    }
    let lane = laneEnds.findIndex((end) => end <= entry.start);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = entry.drawnEnd;
    cluster.push({ ...entry, lane });
    clusterEnd = cluster.length === 1 ? entry.drawnEnd : Math.max(clusterEnd, entry.drawnEnd);
  }
  if (cluster.length > 0) placed.push(...placeCluster(cluster, laneEnds.length));
  return placed;
}

/** The seven days of the Monday-start week that contains date, in JST (DESIGN.md §5). */
export function mondayWeek(date: Date): Date[] {
  const monday = addDays(date, -((jstWeekday(date) + 6) % 7));
  return Array.from({ length: 7 }, (_, index) => addDays(monday, index));
}

function minutesOf(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

/**
 * The parts of a store's day outside its opening hours. A store with hours set up
 * but none open that weekday is closed all day; a store with no hours at all is
 * not tinted, since nothing says it is closed.
 */
export function closedRanges(businessHours: readonly BusinessHour[], storeId: string, weekday: number): Span[] {
  const rows = businessHours.filter((row) => row.storeId === storeId);
  if (rows.length === 0) return [];
  const open = rows
    .filter((row) => row.active && row.weekday === weekday)
    .map((row) => ({ start: minutesOf(row.opensAt), end: minutesOf(row.closesAt) }))
    .sort((a, b) => a.start - b.start);
  const closed: Span[] = [];
  let cursor = 0;
  for (const range of open) {
    if (range.start > cursor) closed.push({ start: cursor, end: range.start });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < DAY_MINUTES) closed.push({ start: cursor, end: DAY_MINUTES });
  return closed;
}
