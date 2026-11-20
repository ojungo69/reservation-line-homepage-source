import { ReservationListCard } from "@/components/schedule/reservation-list-card";
import { getInitialScrollMinutes, isScheduleVisibleReservationStatus, jstWeekday } from "@/lib/timeline";
import { cn } from "@/lib/utils";
import type { ExternalBlock, SettingsResponse } from "@/types/api";
import { CalendarColumnView, type CalendarItem, type ClosureBand } from "./column";
import type { CalendarColumn } from "./columns";
import { clipToDay, closedRanges, DAY_MINUTES } from "./geometry";
import { dayLabel, dayOfMonth, weekdayOf } from "./labels";
import type { DayData } from "./use-calendar-days";

export type CalendarSettings = Extract<SettingsResponse, { ok: true }>["settings"];

const SLOT_MINUTES = 15;

function columnItems(column: CalendarColumn, day: DayData | undefined): CalendarItem[] {
  if (!day) return [];
  const items: CalendarItem[] = [];
  for (const reservation of day.reservations) {
    if (reservation.storeId !== column.storeId || !isScheduleVisibleReservationStatus(reservation.status)) continue;
    const span = clipToDay(reservation.startAt, reservation.endAt, column.dateKey);
    if (span) items.push({ kind: "reservation", span, reservation });
  }
  for (const block of day.blocks) {
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

/** The store's earliest opening that weekday, else 09:00 (the current calendar's rule). */
export function openingMinute(settings: CalendarSettings | null, column: CalendarColumn): number {
  return getInitialScrollMinutes(settings?.businessHours ?? [], jstWeekday(column.date), column.storeId);
}

function dayStatus(day: DayData | undefined): string {
  if (!day || day.loading) return "読み込み中";
  if (day.failed.length > 0) return "読み込み失敗";
  return day.capped ? "件数超過" : "";
}

// Slots are offered only on complete data: a loading, failed or capped day, or
// missing store settings, must not read as free time (UX-21).
function creatable(day: DayData | undefined, settingsUsable: boolean): boolean {
  return settingsUsable && day !== undefined && !day.loading && day.failed.length === 0 && !day.capped;
}

/** The columns of the grid, each with its bookings, closed times and slots. */
export function CalendarColumns({
  columns,
  dayByKey,
  settings,
  settingsUsable,
  week,
  todayKey,
  nowMinute,
  columnPx,
  selectedId,
  onSlot,
  onReservation,
  onBlock,
}: Readonly<{
  columns: readonly CalendarColumn[];
  dayByKey: ReadonlyMap<string, DayData>;
  settings: CalendarSettings | null;
  settingsUsable: boolean;
  week: boolean;
  todayKey: string;
  nowMinute: number;
  columnPx: number | null;
  selectedId: string | null;
  onSlot: (column: CalendarColumn, minute: number, opener: HTMLElement) => void;
  onReservation: (id: string, opener: HTMLElement) => void;
  onBlock?: (block: ExternalBlock, opener: HTMLElement) => void;
}>) {
  const firstToday = columns.find((column) => column.dateKey === todayKey)?.key;
  return columns.map((column) => {
    const day = dayByKey.get(column.dateKey);
    const today = column.dateKey === todayKey;
    const entry = Math.floor(openingMinute(settings, column) / SLOT_MINUTES) * SLOT_MINUTES;
    return (
      <CalendarColumnView
        key={column.key}
        column={column}
        dayLabel={dayLabel(column.date)}
        items={columnItems(column, day)}
        closed={settings ? closedRanges(settings.businessHours, column.storeId, jstWeekday(column.date)) : []}
        closures={closureBands(column, settings)}
        entryMinute={Math.min(entry, DAY_MINUTES - SLOT_MINUTES)}
        canCreate={creatable(day, settingsUsable)}
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
  const rows = [...(day?.reservations ?? [])]
    .filter((reservation) => isScheduleVisibleReservationStatus(reservation.status) && (!storeId || reservation.storeId === storeId))
    .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  const settled = day !== undefined && !day.loading && day.failed.length === 0;
  return (
    <section aria-label="選択日の予約" className="space-y-2 px-4 py-3">
      {(!day || day.loading) && <p className="text-sm">予定を読み込み中…</p>}
      {settled && rows.length === 0 && (
        <p className="rounded-md border border-cal-grid p-6 text-center text-sm">この日の予約はありません</p>
      )}
      {rows.length > 0 && (
        <ul className="space-y-2">
          {rows.map((reservation) => (
            <li key={reservation.id}>
              <ReservationListCard
                reservation={reservation}
                // The card's 詳細 button had focus when pressed (or Safari's click
                // left it on <body>): give back what is focused, else the list.
                onDetails={(id) => onDetails(id, document.activeElement instanceof HTMLElement ? document.activeElement : document.body)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
