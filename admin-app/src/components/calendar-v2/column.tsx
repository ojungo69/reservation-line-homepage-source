import { useState, type KeyboardEvent } from "react";
import { displayServiceName } from "@/lib/service-pricing";
import { formatTime, statusLabel } from "@/lib/timeline";
import type { ExternalBlock, Reservation } from "@/types/api";
import type { CalendarColumn } from "./columns";
import { CalendarEvent, eventLines, type EventTone } from "./event";
import { DAY_MINUTES, MIN_EVENT_PX, PX_PER_MINUTE, SLOT_MINUTES, clipToDay, drawnSpan, layoutLanes, type Span } from "./geometry";
import { spanLabel } from "./labels";

export type CalendarItem =
  | Readonly<{ kind: "reservation"; span: Span; reservation: Reservation }>
  | Readonly<{ kind: "block"; span: Span; block: ExternalBlock }>;

export type ClosureBand = Readonly<{ id: string; span: Span; reason: string | null }>;

const DAY_PX = DAY_MINUTES * PX_PER_MINUTE;
const MIN_EVENT_MINUTES = MIN_EVENT_PX / PX_PER_MINUTE;
// RESERVATION_INTERVAL_MINUTES (src/reservations/slot-times.ts): every stored
// booking ends with this much cleaning.
const CLEANING_MINUTES = 5;

const clock = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(Math.floor(minute % 60)).padStart(2, "0")}`;

// A marker the block always shows, so its state is said in words, not only by its
// color (DESIGN.md §3): 承認待ち has its own fill, the others share the booking's.
const STATUS_MARKERS: Partial<Record<string, string>> = {
  pending_approval: "承認待ち",
  checked_in: "来店中",
  completed: "完了",
};

// Arrow keys walk the column's open slots: up and down to the next one, Home and
// End to the ends, left and right to the nearest time next door.
function moveSlotFocus(event: KeyboardEvent<HTMLButtonElement>) {
  const slot = event.currentTarget;
  const column = slot.closest<HTMLElement>("[data-calendar-column]");
  if (!column) return;
  const slotsOf = (scope: Element | undefined) => [...(scope?.querySelectorAll<HTMLElement>("[data-slot-minutes]") ?? [])];
  const own = slotsOf(column);
  const at = own.indexOf(slot);
  const minute = Number(slot.dataset.slotMinutes);
  const columns = [...(column.parentElement?.querySelectorAll<HTMLElement>("[data-calendar-column]") ?? [])];
  const nearest = (scope: Element | undefined) =>
    slotsOf(scope).reduce<HTMLElement | undefined>(
      (best, next) =>
        !best || Math.abs(Number(next.dataset.slotMinutes) - minute) < Math.abs(Number(best.dataset.slotMinutes) - minute) ? next : best,
      undefined,
    );
  const targets: Record<string, () => HTMLElement | undefined> = {
    ArrowUp: () => own[at - 1],
    ArrowDown: () => own[at + 1],
    Home: () => own[0],
    End: () => own.at(-1),
    ArrowLeft: () => nearest(columns[columns.indexOf(column) - 1]),
    ArrowRight: () => nearest(columns[columns.indexOf(column) + 1]),
  };
  const target = targets[event.key]?.();
  if (!target) return;
  event.preventDefault();
  target.focus();
}

function present(item: CalendarItem, dayLabel: string, dateKey: string) {
  if (item.kind === "reservation") {
    const { reservation } = item;
    // The stored end includes the cleaning: the label gives the treatment's end,
    // and the cleaning is drawn as its own band (DESIGN.md §5). An old booking
    // stored with 5 minutes in all has no treatment part (contracts/
    // reservation-interactions.md), so no floor here, unlike the edit dialog.
    const treatmentEnd = new Date(Math.max(Date.parse(reservation.startAt), Date.parse(reservation.endAt) - CLEANING_MINUTES * 60_000));
    const start = formatTime(reservation.startAt);
    const finish = formatTime(treatmentEnd.toISOString());
    const release = formatTime(reservation.endAt);
    const detail = displayServiceName(reservation.serviceName);
    const cleaning = treatmentEnd.getTime() < Date.parse(reservation.endAt)
      ? clipToDay(treatmentEnd.toISOString(), reservation.endAt, dateKey)
      : null;
    return {
      id: reservation.id,
      tone: (reservation.status === "pending_approval" ? "pending" : "confirmed") as EventTone,
      marker: STATUS_MARKERS[reservation.status] ?? null,
      title: reservation.customerDisplayName,
      start,
      range: `${start}–${finish}`,
      detail,
      cleaning,
      label: `${reservation.customerDisplayName}、${dayLabel}、${start}から${finish}（枠の解放 ${release}）、${detail}、${statusLabel(reservation.status)}`,
    };
  }
  const { block } = item;
  // A block can run past midnight (a Google event), so the block shows the part
  // drawn in this day's column, and the label says its real days and times.
  const start = clock(item.span.start);
  const end = clock(item.span.end);
  const title = block.titleSnapshot ?? "外部予定";
  // Only Google's own blocks say Google; the store's and the system's are blocks.
  const google = block.source === "google_calendar";
  return {
    id: block.id,
    tone: "external" as EventTone,
    // The source is the marker, so a short block still says where it came from.
    marker: google ? "Google" : "ブロック",
    title,
    start,
    range: `${start}–${end}`,
    detail: "",
    cleaning: null,
    label: `${title}、${spanLabel(block.startAt, block.endAt)}、${google ? "Googleカレンダー" : "ブロック"}`,
  };
}

type ColumnProps = Readonly<{
  column: CalendarColumn;
  dayLabel: string;
  items: readonly CalendarItem[];
  // What 表示する予定 hides: still taken (spec.md, clarifications), so a plain band
  // at each one's own time keeps it from looking free and takes the presses there.
  hidden: readonly Span[];
  closed: readonly Span[];
  closures: readonly ClosureBand[];
  // The slot that takes Tab until the user moves: the opening time, where work starts.
  entryMinute: number;
  // The slots offered as a way into the booking form (openSlotMinutes); none
  // while the day's data is incomplete, which must not read as free time (UX-21).
  slots: readonly number[];
  tint: boolean;
  nowMinute: number | null;
  showNowDot: boolean;
  widthPx: number | null;
  selectedId: string | null;
  // Each gets the element that was pressed, so focus can go back to it.
  onSlot: (column: CalendarColumn, minute: number, opener: HTMLElement) => void;
  onReservation: (id: string, opener: HTMLElement) => void;
  onBlock?: (block: ExternalBlock, opener: HTMLElement) => void;
}>;

/** One day of one store on the shared time axis (UX-02, UX-03). */
export function CalendarColumnView({
  column,
  dayLabel,
  items,
  hidden,
  closed,
  closures,
  entryMinute,
  slots,
  tint,
  nowMinute,
  showNowDot,
  widthPx,
  selectedId,
  onSlot,
  onReservation,
  onBlock,
}: ColumnProps) {
  // Roving tab stop: the slot last focused keeps Tab, so Shift+Tab leaves the grid
  // instead of jumping back to the opening time.
  const [tabMinute, setTabMinute] = useState<number | null>(null);
  const tabStop =
    tabMinute !== null && slots.includes(tabMinute) ? tabMinute : (slots.find((minute) => minute >= entryMinute) ?? slots[0]);
  const placed = layoutLanes(items.map((item) => ({ item, ...drawnSpan(item.span, MIN_EVENT_MINUTES) })));
  return (
    <div data-calendar-column={column.key} className="relative min-w-0 flex-1 border-l border-cal-grid" style={{ height: DAY_PX }}>
      {tint && <div aria-hidden="true" className="absolute inset-0 bg-cal-selected/20" />}
      {closed.map((range) => (
        <div
          key={`closed-${range.start}`}
          aria-hidden="true"
          data-closed-hours=""
          className="absolute inset-x-0 bg-cal-text/5 dark:bg-cal-outer"
          style={{ top: range.start * PX_PER_MINUTE, height: (range.end - range.start) * PX_PER_MINUTE }}
        />
      ))}
      {closures.map((closure) => (
        <div
          key={closure.id}
          data-closure=""
          className="absolute inset-x-0 overflow-hidden bg-cal-text/5 px-1 pt-1 text-xs text-cal-text-secondary dark:bg-cal-outer"
          style={{ top: closure.span.start * PX_PER_MINUTE, height: (closure.span.end - closure.span.start) * PX_PER_MINUTE }}
        >
          休業{closure.reason ? `（${closure.reason}）` : ""}
        </div>
      ))}
      {slots.map((minute) => (
        <button
          key={minute}
          type="button"
          tabIndex={minute === tabStop ? 0 : -1}
          data-slot-minutes={minute}
          // The band below is not read out, so the slot says what it covers.
          aria-label={`${dayLabel} ${clock(minute)} ${column.storeName}に予約を追加${
            hidden.some((span) => minute < span.end && minute + SLOT_MINUTES > span.start) ? "（この時間には非表示の予定があります）" : ""
          }`}
          onClick={(event) => onSlot(column, minute, event.currentTarget)}
          onFocus={() => setTabMinute(minute)}
          onKeyDown={moveSlotFocus}
          // The slot stays under the bookings, so a focused one never takes their
          // clicks; only its ring is drawn above them, on a layer clicks pass through.
          // Two tones (a surface line inside the primary one), so the ring shows on a
          // dark confirmed booking of the same blue; the outline also stays under
          // forced colors, which drop the shadow-drawn ring.
          className="absolute inset-x-0 hover:bg-cal-text/5 focus-visible:outline-hidden focus-visible:after:pointer-events-none focus-visible:after:absolute focus-visible:after:inset-0 focus-visible:after:z-40 focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-cal-primary focus-visible:after:outline-2 focus-visible:after:-outline-offset-4 focus-visible:after:outline-cal-surface"
          // In px like its position: a rem height grows with the browser's text
          // size and would reach into the next slot or a closed band.
          style={{ top: minute * PX_PER_MINUTE, height: SLOT_MINUTES * PX_PER_MINUTE }}
        />
      ))}
      {hidden.map((span, index) => {
        // Not stretched like a short booking: the slots' names go by the same time.
        const height = (span.end - span.start) * PX_PER_MINUTE;
        return (
          // This plain box takes the presses, at exactly that time; the look inside it
          // takes none, so its edge, padding and corners cannot move where presses go.
          // It also clips the look, which large text can make taller than a short time.
          <div
            key={`hidden-${index}-${span.start}`}
            aria-hidden="true"
            data-hidden-item=""
            className="absolute inset-x-0 z-10 overflow-hidden"
            style={{ top: span.start * PX_PER_MINUTE, height }}
          >
            {/* The fill is about 1.1:1 on the surface, so the edge is drawn in the outline
                color (3:1, as the pending booking's; DESIGN.md §3), dashed to stay apart from it. */}
            <div className="pointer-events-none h-full overflow-hidden rounded-md border border-dashed border-cal-outline bg-cal-text/5 px-1.5 pt-0.5 text-xs text-cal-text-secondary dark:bg-cal-outer">
              {height >= MIN_EVENT_PX && "非表示の予定"}
            </div>
          </div>
        );
      })}
      {placed.map(({ item, start, end, lane, lanes, span }) => {
        const top = start * PX_PER_MINUTE;
        const height = (end - start) * PX_PER_MINUTE;
        const shown = present(item, dayLabel, column.dateKey);
        const { inline, lines } = eventLines({
          marker: shown.marker,
          heightPx: height,
          widthPx: widthPx === null ? null : (widthPx * span) / lanes - 4,
          title: shown.title,
          start: shown.start,
          range: shown.range,
          detail: shown.detail,
        });
        // At its true time: a short booking drawn taller keeps its band where the
        // cleaning is, with the extra height below it.
        const { cleaning } = shown;
        let onSelect: ((opener: HTMLElement) => void) | undefined;
        if (item.kind === "reservation") onSelect = (opener) => onReservation(item.reservation.id, opener);
        else if (onBlock && item.block.source === "admin_block") onSelect = (opener) => onBlock(item.block, opener);
        return (
          <CalendarEvent
            key={`${item.kind}-${shown.id}`}
            tone={shown.tone}
            lines={lines}
            inline={inline}
            label={shown.label}
            selected={selectedId === shown.id}
            onSelect={onSelect}
            cleaning={cleaning ? { top: (cleaning.start - start) * PX_PER_MINUTE, height: (cleaning.end - cleaning.start) * PX_PER_MINUTE } : null}
            style={{
              top,
              height,
              left: `calc(${(lane / lanes) * 100}% + 2px)`,
              width: `calc(${(span / lanes) * 100}% - 4px)`,
            }}
          />
        );
      })}
      {nowMinute !== null && (
        // A surface halo keeps the line 3:1 apart from whatever it crosses: in dark
        // mode it is about as light as a confirmed booking (tasks.md T005).
        <div
          aria-hidden="true"
          data-now-line=""
          className="pointer-events-none absolute inset-x-0 z-30 h-1 -translate-y-1/2 border-y border-cal-surface bg-cal-alert"
          style={{ top: nowMinute * PX_PER_MINUTE }}
        >
          {showNowDot && (
            <div className="absolute -left-1.5 top-1/2 size-3 -translate-y-1/2 rounded-full bg-cal-alert ring-1 ring-cal-surface" />
          )}
        </div>
      )}
    </div>
  );
}
