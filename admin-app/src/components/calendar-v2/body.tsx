import { useRef } from "react";
import { ReservationListCard } from "@/components/schedule/reservation-list-card";
import { isScheduleVisibleReservationStatus, jstWeekday, parseHHMM } from "@/lib/timeline";
import { cn } from "@/lib/utils";
import type { ExternalBlock, SettingsResponse } from "@/types/api";
import { CalendarColumnView, type CalendarItem, type ClosureBand } from "./column";
import { activeResourceIds, type CalendarColumn } from "./columns";
import { clipToDay, closedRanges, openSlotMinutes, SLOT_MINUTES, type Span } from "./geometry";
import { dayLabel, dayOfMonth, weekdayOf } from "./labels";
import type { DayData } from "./use-calendar-days";

export type CalendarSettings = Extract<SettingsResponse, { ok: true }>["settings"];

// The settings list keeps each store's 200 closures that start last, with no
// sign that it cut older ones (src/admin/operations.ts). A cut one can be long
// enough to reach any shown day, so a store at the cap draws no slots at all.
const CLOSURE_ROW_CAP = 200;

function reservationsComplete(day: DayData | undefined): boolean {
  return day !== undefined && !day.loading && day.failed.length === 0 && !day.capped;
}

function columnItems(column: CalendarColumn, day: DayData | undefined): CalendarItem[] {
  const items: CalendarItem[] = [];
  // The day list holds bookings that start that day, which is all of them: every
  // write path keeps a booking's start and end on one day (ensureBusinessTime in
  // src/reservations/business-hours.ts, and the Google import's own check).
  for (const reservation of day?.reservations ?? []) {
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


/**
 * What 表示する予定 in the sidebar shows (DESIGN.md §5): pending bookings and the
 * blocks from Google Calendar. Every other block (the store's own, a system one)
 * always shows. Free slots never read it (INT-06-02): they come from opening hours
 * and closures only, and the booking form checks the time against the server's
 * free slots.
 */
export type Layers = Readonly<{ pending: boolean; google: boolean }>;
export const ALL_LAYERS: Layers = { pending: true, google: true };

function shown(item: CalendarItem, layers: Layers): boolean {
  if (item.kind === "reservation") return layers.pending || item.reservation.status !== "pending_approval";
  return layers.google || item.block.source !== "google_calendar";
}

// Where a column starts when its store has no opening that day (the current
// calendar's fallback).
export const FALLBACK_OPENING_MINUTE = 9 * 60;

/** The store's earliest opening that weekday; null when it does not open then. */
export function openingOf(settings: CalendarSettings | null, column: CalendarColumn): number | null {
  const weekday = jstWeekday(column.date);
  const opens = (settings?.businessHours ?? [])
    .filter((row) => row.active && row.storeId === column.storeId && row.weekday === weekday)
    .map((row) => parseHHMM(row.opensAt));
  return opens.length > 0 ? Math.min(...opens) : null;
}

export type ColumnState = Readonly<{
  column: CalendarColumn;
  items: CalendarItem[];
  closed: Span[];
  closures: ClosureBand[];
  // The slot that takes Tab first: the opening time, where work starts.
  entryMinute: number;
  // None while the day's data is incomplete (UX-21: it must not read as free
  // time) or the store has no active resource to book.
  slots: number[];
  noResource: boolean;
  // No opening hours saved at all: the settings call the store 未設定・予約受付不可.
  noHours: boolean;
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
  const items = columnItems(column, day);
  const closures = closureBands(column, settings);
  const closed = settings ? closedRanges(settings.businessHours, column.storeId, jstWeekday(column.date)) : [];
  const noResource = settings !== null && activeResourceIds(column.storeId, settings.resources).length === 0;
  // Any row, open or closed, counts as set, as in the settings (src/admin/settings-business-hours.ts).
  const noHours = settings !== null && !settings.businessHours.some((row) => row.storeId === column.storeId);
  const closuresUnknown =
    settings !== null && settings.closures.filter((closure) => closure.storeId === column.storeId).length >= CLOSURE_ROW_CAP;
  const offers = settingsUsable && reservationsComplete(day) && !closuresUnknown && !noResource && !noHours;
  return {
    column,
    items,
    closed,
    closures,
    entryMinute: Math.floor((openingOf(settings, column) ?? FALLBACK_OPENING_MINUTE) / SLOT_MINUTES) * SLOT_MINUTES,
    slots: offers ? openSlotMinutes([...closed, ...closures.map((band) => band.span)]) : [],
    noResource,
    noHours,
    closuresUnknown,
  };
}

function dayStatus(day: DayData | undefined): string {
  if (!day || day.loading) return "読み込み中";
  if (day.failed.length > 0) return "読み込み失敗";
  return day.capped ? "上限到達" : "";
}

/** The columns of the grid, each with its bookings, closed times and slots. */
export function CalendarColumns({
  states,
  week,
  todayKey,
  nowMinute,
  columnPx,
  selectedId,
  layers,
  onSlot,
  onReservation,
  onBlock,
}: Readonly<{
  states: readonly ColumnState[];
  week: boolean;
  todayKey: string;
  nowMinute: number;
  columnPx: number | null;
  selectedId: string | null;
  layers: Layers;
  onSlot: (column: CalendarColumn, minute: number, opener: HTMLElement) => void;
  onReservation: (id: string, opener: HTMLElement) => void;
  onBlock?: (block: ExternalBlock, opener: HTMLElement) => void;
}>) {
  const firstToday = states.find((state) => state.column.dateKey === todayKey)?.column.key;
  return states.map((state) => {
    const { column } = state;
    const today = column.dateKey === todayKey;
    return (
      <CalendarColumnView
        key={column.key}
        column={column}
        dayLabel={dayLabel(column.date)}
        items={state.items.filter((item) => shown(item, layers))}
        hidden={state.items.filter((item) => !shown(item, layers)).map((item) => item.span)}
        closed={state.closed}
        closures={state.closures}
        entryMinute={state.entryMinute}
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
    const statusSuffix = status ? `（${status}）` : "";
    return (
      <button
        key={column.key}
        type="button"
        onClick={() => onOpenDay(column.date)}
        aria-label={`${dayLabel(column.date)}の日表示を開く${statusSuffix}`}
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
  layers,
  addButton,
  onDetails,
}: Readonly<{
  day: DayData | undefined;
  storeId: string | null;
  layers: Layers;
  // The floating ＋ button is on screen: the last card stays scrollable above it.
  addButton: boolean;
  onDetails: (id: string, opener: HTMLElement) => void;
}>) {
  // The shared card does not pass on which button was pressed, and Safari does not
  // focus buttons on click, so the press is caught on its way down.
  const pressed = useRef<HTMLElement | null>(null);
  const all = [...(day?.reservations ?? [])]
    .filter((reservation) => isScheduleVisibleReservationStatus(reservation.status) && (!storeId || reservation.storeId === storeId))
    .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  const rows = layers.pending ? all : all.filter((reservation) => reservation.status !== "pending_approval");
  const hidden = all.length - rows.length;
  const loading = !day || day.reservationsStatus === "pending";
  // A capped or failed list may be missing bookings: never call it empty (UX-21),
  // nor a day whose bookings 表示する予定 hides.
  const empty = day?.reservationsStatus === "ready" && all.length === 0;
  return (
    <section aria-label="選択日の予約" className={cn("px-4 pt-3", addButton ? "pb-24" : "pb-3")}>
      {/* Always there, so a screen reader hears the day's state after 前/次. */}
      <output className={cn("block text-sm", (loading || empty || hidden > 0) && "mb-2")}>
        {loading && "予定を読み込み中…"}
        {empty && <span className="block rounded-md border border-cal-grid p-6 text-center">この日の予約はありません</span>}
        {hidden > 0 && `承認待ちの予約${hidden}件を「表示する予定」で隠しています。`}
      </output>
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
