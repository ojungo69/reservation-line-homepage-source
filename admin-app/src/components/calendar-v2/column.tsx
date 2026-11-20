import { useState, type KeyboardEvent } from "react";
import { displayServiceName } from "@/lib/service-pricing";
import { formatTime, statusLabel } from "@/lib/timeline";
import type { ExternalBlock, Reservation } from "@/types/api";
import type { CalendarColumn } from "./columns";
import { CalendarEvent, eventLines, type EventTone } from "./event";
import { DAY_MINUTES, MIN_EVENT_PX, PX_PER_MINUTE, layoutLanes, type Span } from "./geometry";

export type CalendarItem =
  | Readonly<{ kind: "reservation"; span: Span; reservation: Reservation }>
  | Readonly<{ kind: "block"; span: Span; block: ExternalBlock }>;

export type ClosureBand = Readonly<{ id: string; span: Span; reason: string | null }>;

const DAY_PX = DAY_MINUTES * PX_PER_MINUTE;
const SLOT_MINUTES = 15;
const SLOTS = Array.from({ length: DAY_MINUTES / SLOT_MINUTES }, (_, index) => index * SLOT_MINUTES);

const clock = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

// Arrow keys walk the slots like the current grid: up and down by 15 minutes,
// Home and End to the day's ends, left and right to the same time next door.
function moveSlotFocus(event: KeyboardEvent<HTMLButtonElement>) {
  const minute = Number(event.currentTarget.dataset.slotMinutes);
  const column = event.currentTarget.closest<HTMLElement>("[data-calendar-column]");
  if (!column) return;
  const siblings = [...(column.parentElement?.querySelectorAll<HTMLElement>("[data-calendar-column]") ?? [])];
  const at = siblings.indexOf(column);
  const targets: Record<string, [HTMLElement | undefined, number]> = {
    ArrowUp: [column, minute - SLOT_MINUTES],
    ArrowDown: [column, minute + SLOT_MINUTES],
    Home: [column, 0],
    End: [column, DAY_MINUTES - SLOT_MINUTES],
    ArrowLeft: [siblings[at - 1], minute],
    ArrowRight: [siblings[at + 1], minute],
  };
  const [scope, nextMinute] = targets[event.key] ?? [];
  const target = scope?.querySelector<HTMLElement>(`[data-slot-minutes="${nextMinute}"]`);
  if (!target) return;
  event.preventDefault();
  target.focus();
}

function present(item: CalendarItem, dayLabel: string) {
  if (item.kind === "reservation") {
    const { reservation } = item;
    const pending = reservation.status === "pending_approval";
    const start = formatTime(reservation.startAt);
    const end = formatTime(reservation.endAt);
    const detail = displayServiceName(reservation.serviceName);
    return {
      id: reservation.id,
      tone: (pending ? "pending" : "confirmed") as EventTone,
      marker: pending ? "承認待ち" : null,
      title: reservation.customerDisplayName,
      start,
      range: `${start}–${end}`,
      detail,
      label: `${reservation.customerDisplayName}、${dayLabel}、${start}から${end}、${detail}、${statusLabel(reservation.status)}`,
    };
  }
  const { block } = item;
  const start = formatTime(block.startAt);
  const end = formatTime(block.endAt);
  const title = block.titleSnapshot ?? "外部予定";
  const manual = block.source === "admin_block";
  return {
    id: block.id,
    tone: "external" as EventTone,
    // The source is the marker, so a short block still says where it came from.
    marker: manual ? "ブロック" : "Google",
    title,
    start,
    range: `${start}–${end}`,
    detail: "",
    label: `${title}、${dayLabel}、${start}から${end}、${manual ? "ブロック" : "Googleカレンダー"}`,
  };
}

type ColumnProps = Readonly<{
  column: CalendarColumn;
  dayLabel: string;
  items: readonly CalendarItem[];
  closed: readonly Span[];
  closures: readonly ClosureBand[];
  // The slot that takes Tab until the user moves: the opening time, where work starts.
  entryMinute: number;
  // Off while the day is loading, failed or capped: incomplete data must not
  // read as free time (UX-21).
  canCreate: boolean;
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
  closed,
  closures,
  entryMinute,
  canCreate,
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
  const tabStop = tabMinute ?? entryMinute;
  const placed = layoutLanes(
    items.map((item) => ({ item, start: item.span.start, end: item.span.end })),
    MIN_EVENT_PX / PX_PER_MINUTE,
  );
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
      {canCreate &&
        SLOTS.map((minute) => (
          <button
            key={minute}
            type="button"
            tabIndex={minute === tabStop ? 0 : -1}
            data-slot-minutes={minute}
            aria-label={`${dayLabel} ${clock(minute)} ${column.storeName}に予約を追加`}
            onClick={(event) => onSlot(column, minute, event.currentTarget)}
            onFocus={() => setTabMinute(minute)}
            onKeyDown={moveSlotFocus}
            className="absolute inset-x-0 h-3 hover:bg-cal-text/5 focus-visible:z-40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cal-primary"
            style={{ top: minute * PX_PER_MINUTE }}
          />
        ))}
      {placed.map(({ item, start, end, lane, lanes, span }) => {
        // Keep the minimum height at the day's end too, by drawing a late block
        // upward rather than cutting it to a sliver.
        const height = Math.max((end - start) * PX_PER_MINUTE, MIN_EVENT_PX);
        const top = Math.min(start * PX_PER_MINUTE, DAY_PX - height);
        const shown = present(item, dayLabel);
        const { inline, lines } = eventLines({
          marker: shown.marker,
          heightPx: height,
          widthPx: widthPx === null ? null : (widthPx * span) / lanes - 4,
          title: shown.title,
          start: shown.start,
          range: shown.range,
          detail: shown.detail,
        });
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
