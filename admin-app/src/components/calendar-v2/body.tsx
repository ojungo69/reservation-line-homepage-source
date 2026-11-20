import { useRef } from "react";
import { ReservationListCard } from "@/components/schedule/reservation-list-card";
import { addDays, formatJstDate, getInitialScrollMinutes, isScheduleVisibleReservationStatus, jstWeekday } from "@/lib/timeline";
import { cn } from "@/lib/utils";
import type { ExternalBlock, SettingsResponse } from "@/types/api";
import { CalendarColumnView, type CalendarItem, type ClosureBand } from "./column";
import type { CalendarColumn } from "./columns";
import { clipToDay, closedRanges, DAY_MINUTES, openSlotMinutes, SLOT_MINUTES, type Span } from "./geometry";
import { dayLabel, dayOfMonth, weekdayOf } from "./labels";
import type { DayData } from "./use-calendar-days";

export type CalendarSettings = Extract<SettingsResponse, { ok: true }>["settings"];

// The settings list keeps each store's 200 closures that start last, with no
// sign that it cut older ones (src/admin/operations.ts).
const CLOSURE_ROW_CAP = 200;
// The longest booking: MAX_TOTAL_SERVICE_DURATION_MINUTES plus the cleaning time
// (src/reservations/slot-times.ts). A booking from the day before reaches no
// further into the next day than this.
const LONGEST_BOOKING_MINUTES = 240;

/** The day before a column's day: bookings that started then can run past midnight into it. */
export function previousDayKey(date: Date): string {
  return formatJstDate(addDays(date, -1));
}

function reservationsComplete(day: DayData | undefined): boolean {
  return day !== undefined && !day.loading && day.failed.length === 0 && !day.capped;
}

function columnItems(column: CalendarColumn, day: DayData | undefined, before: DayData | undefined): CalendarItem[] {
  const items: CalendarItem[] = [];
  // The day list holds bookings that start that day, so one that starts the day
  // before and runs past midnight comes from the previous day's list.
  for (const reservation of [...(before?.reservations ?? []), ...(day?.reservations ?? [])]) {
    if (reservation.storeId !== column.storeId || !isScheduleVisibleReservationStatus(reservation.status)) continue;
    const span = clipToDay(reservation.startAt, reservation.endAt, column.dateKey);
    if (span) items.push({ kind: "reservation", span, reservation });
  }
  // Blocks are listed by overlap with the day, so a block across midnight is in both days' lists already.
  for (const block of day?.blocks ?? []) {
    if (block.storeId !== column.storeId) continue;
    const span = clipToDay(block.startAt, block.endAt, column.dateKey);
    if (span) items.push({ kind: "block", span, block });
  }
  return items;
}

function closureBands(column: CalendarColumn, settings: CalendarSettings | null): ClosureBand[] {
  if (!settings) return [];
  return settings.closures.flatMap((closure) => {
    if (closure.storeId !== column.storeId) return [];
    const span = clipToDay(closure.startsAt, closure.endsAt, column.dateKey);
    return span ? [{ id: closure.id, span, reason: closure.reason }] : [];
  });
}

// A capped list is complete only from the oldest start it still holds: a day
// before that may have closures that were cut off.
function closuresKnown(column: CalendarColumn, settings: CalendarSettings): boolean {
  const starts = settings.closures.filter((closure) => closure.storeId === column.storeId).map((closure) => Date.parse(closure.startsAt));
  if (starts.length < CLOSURE_ROW_CAP) return true;
  return Date.parse(`${column.dateKey}T00:00:00+09:00`) >= Math.min(...starts);
}

/** The store's earliest opening that weekday, else 09:00 (the current calendar's rule). */
export function openingMinute(settings: CalendarSettings | null, column: CalendarColumn): number {
  return getInitialScrollMinutes(settings?.businessHours ?? [], jstWeekday(column.date), column.storeId);
}

export type ColumnState = Readonly<{
  column: CalendarColumn;
  items: CalendarItem[];
  closed: Span[];
  closures: ClosureBand[];
  // Null while the column cannot offer slots: incomplete data must not read as
  // free time (UX-21).
  slots: number[] | null;
  noResource: boolean;
  closuresUnknown: boolean;
}>;

/** Everything one column needs, from the day's lists and the store settings. */
export function columnState(
  column: CalendarColumn,
  dayByKey: ReadonlyMap<string, DayData>,
  settings: CalendarSettings | null,
  settingsUsable: boolean,
): ColumnState {
  const day = dayByKey.get(column.dateKey);
  const before = dayByKey.get(previousDayKey(column.date));
  const items = columnItems(column, day, before);
  const closures = closureBands(column, settings);
  const closed = settings ? closedRanges(settings.businessHours, column.storeId, jstWeekday(column.date)) : [];
  const resourceIds = (settings?.resources ?? [])
    .filter((resource) => resource.storeId === column.storeId && resource.active)
    .map((resource) => resource.id);
  const closuresUnknown = settings !== null && !closuresKnown(column, settings);
  const complete = settingsUsable && reservationsComplete(day) && !closuresUnknown;
  // Without the day before, its bookings into this morning are unknown: hold
  // back only the hours they could reach.
  const unknownMorning = reservationsComplete(before) ? [] : [{ start: 0, end: LONGEST_BOOKING_MINUTES }];
  const taken = items.map((item) => ({
    span: item.span,
    resourceId: item.kind === "reservation" ? item.reservation.resourceId : item.block.resourceId,
  }));
  return {
    column,
    items,
    closed,
    closures,
    slots: complete
      ? openSlotMinutes({ closed: [...closed, ...closures.map((band) => band.span), ...unknownMorning], taken, resourceIds })
      : null,
    noResource: settings !== null && resourceIds.length === 0,
    closuresUnknown,
  };
}

function dayStatus(day: DayData | undefined): string {
  if (!day || day.loading) return "読み込み中";
  if (day.failed.length > 0) return "読み込み失敗";
  return day.capped ? "件数超過" : "";
}

/** The columns of the grid, each with its bookings, closed times and slots. */
export function CalendarColumns({
  states,
  settings,
  week,
  todayKey,
  nowMinute,
  columnPx,
  selectedId,
  onSlot,
  onReservation,
  onBlock,
}: Readonly<{
  states: readonly ColumnState[];
  settings: CalendarSettings | null;
  week: boolean;
  todayKey: string;
  nowMinute: number;
  columnPx: number | null;
  selectedId: string | null;
  onSlot: (column: CalendarColumn, minute: number, opener: HTMLElement) => void;
  onReservation: (id: string, opener: HTMLElement) => void;
  onBlock?: (block: ExternalBlock, opener: HTMLElement) => void;
}>) {
  const firstToday = states.find((state) => state.column.dateKey === todayKey)?.column.key;
  return states.map((state) => {
    const { column } = state;
    const today = column.dateKey === todayKey;
    const entry = Math.floor(openingMinute(settings, column) / SLOT_MINUTES) * SLOT_MINUTES;
    return (
      <CalendarColumnView
        key={column.key}
        column={column}
        dayLabel={dayLabel(column.date)}
        items={state.items}
        closed={state.closed}
        closures={state.closures}
        entryMinute={Math.min(entry, DAY_MINUTES - SLOT_MINUTES)}
        slots={state.slots}
        tint={week && today}
        nowMinute={today ? nowMinute : null}
        showNowDot={column.key === firstToday}
        widthPx={columnPx}
        selectedId={selectedId}
        onSlot={onSlot}
        onReservation={onReservation}
        onBlock={onBlock}
      />
    );
  });
}

/**
 * The bar's day header: in the week a button per day that opens that day; in a
 * day, the store's day or, for all stores, the store names. A day that is not
 * fully loaded says so under its date.
 */
export function DayHeaderCells({
  columns,
  dayByKey,
  week,
  allStores,
  todayKey,
  onOpenDay,
}: Readonly<{
  columns: readonly CalendarColumn[];
  dayByKey: ReadonlyMap<string, DayData>;
  week: boolean;
  allStores: boolean;
  todayKey: string;
  onOpenDay: (date: Date) => void;
}>) {
  return columns.map((column) => {
    const status = dayStatus(dayByKey.get(column.dateKey));
    if (!week) {
      return (
        <div key={column.key} className="flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center px-1 py-1 text-sm">
          <span className="max-w-full truncate font-medium">
            {allStores ? column.storeName : `${weekdayOf(column.date)} ${dayOfMonth(column.date)}`}
          </span>
          {status && <span className="text-xs">{status}</span>}
        </div>
      );
    }
    const today = column.dateKey === todayKey;
    return (
      <button
        key={column.key}
        type="button"
        onClick={() => onOpenDay(column.date)}
        aria-label={`${dayLabel(column.date)}の日表示を開く${status && `（${status}）`}`}
        aria-current={today ? "date" : undefined}
        className="flex min-h-11 min-w-0 flex-1 flex-col items-center py-1 hover:bg-cal-text/8 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cal-primary"
      >
        <span className="text-xs">{weekdayOf(column.date)}</span>
        <span className={cn("grid size-9 place-items-center rounded-full text-lg", today && "bg-cal-primary text-cal-on-primary")}>
          {dayOfMonth(column.date)}
        </span>
        {status && <span className="text-xs">{status}</span>}
      </button>
    );
  });
}

/** The phone's first view: the day's bookings in time order, as on the current calendar. */
export function DayList({
  day,
  storeId,
  onDetails,
}: Readonly<{ day: DayData | undefined; storeId: string | null; onDetails: (id: string, opener: HTMLElement) => void }>) {
  // The shared card does not pass on which button was pressed, and Safari does not
  // focus buttons on click, so the press is caught on its way down.
  const pressed = useRef<HTMLElement | null>(null);
  const rows = [...(day?.reservations ?? [])]
    .filter((reservation) => isScheduleVisibleReservationStatus(reservation.status) && (!storeId || reservation.storeId === storeId))
    .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  // A capped list may be missing this store's bookings: never call it empty (UX-21).
  return (
    <section aria-label="選択日の予約" className="space-y-2 px-4 py-3">
      {(!day || day.loading) && <p className="text-sm">予定を読み込み中…</p>}
      {reservationsComplete(day) && rows.length === 0 && (
        <p className="rounded-md border border-cal-grid p-6 text-center text-sm">この日の予約はありません</p>
      )}
      {rows.length > 0 && (
        <ul className="space-y-2">
          {rows.map((reservation) => (
            <li
              key={reservation.id}
              onClickCapture={(event) => {
                pressed.current = event.target instanceof Element ? event.target.closest("button") : null;
              }}
            >
              <ReservationListCard reservation={reservation} onDetails={(id) => onDetails(id, pressed.current ?? document.body)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
