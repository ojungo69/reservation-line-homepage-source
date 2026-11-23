import type { CSSProperties, MouseEvent, PointerEventHandler } from "react";
import { cn } from "@/lib/utils";

export type EventTone = "confirmed" | "pending" | "external";

// wrap: a narrow block lets the name run onto a second line rather than cut it
// to one character.
export type EventLine = Readonly<{ part: "marker" | "title" | "time" | "detail"; text: string; strong?: boolean; wrap?: boolean }>;

// Below these heights a block has room for one row, then for a marker and a name
// on one line (the approved prototype's steps).
const ONE_ROW_PX = 34;
const TIGHT_PX = 52;
// A line (leading-4), and a block's padding plus the 承認待ち border (py-0.5,
// border): the menu line shows only where it fits below the others.
const LINE_PX = 16;
const EDGE_PX = 6;
// Under this usable width a block keeps only the name, or only its marker.
const NARROW_PX = 72;
// A one-row block shows its start time (or a marked block its name) only from
// this width: below it, both would be cut to a character.
const INLINE_TIME_PX = 100;

// One row: the marker and, when wide enough, the name; else the start time and
// the name.
function oneRowLines(marker: string | null, title: string, start: string, roomy: boolean): EventLine[] {
  if (marker) return [{ part: "marker", text: marker, strong: true }, ...(roomy ? [{ part: "title" as const, text: title }] : [])];
  return [...(roomy ? [{ part: "time" as const, text: start }] : []), { part: "title", text: title, strong: true }];
}

/**
 * What a block can show at its drawn size. The marker (承認待ち, or the source of
 * an external event) is never dropped: the fill alone must not be what tells
 * those blocks apart from a booking (DESIGN.md §3). The time and the name go
 * first.
 */
export function eventLines({
  marker,
  heightPx,
  widthPx,
  title,
  start,
  range,
  detail,
}: Readonly<{
  marker: string | null;
  heightPx: number;
  widthPx: number | null;
  title: string;
  start: string;
  range: string;
  detail: string;
}>): { inline: boolean; lines: EventLine[] } {
  const narrow = widthPx !== null && widthPx < NARROW_PX;
  if (heightPx < ONE_ROW_PX) {
    return { inline: true, lines: oneRowLines(marker, title, start, widthPx === null || widthPx >= INLINE_TIME_PX) };
  }
  let head: EventLine[] = [{ part: "title", text: title, strong: true, wrap: narrow }];
  if (marker) {
    head = heightPx < TIGHT_PX
      ? [{ part: "title", text: `${marker}・${title}`, strong: true }]
      : [{ part: "marker", text: marker, wrap: narrow }, ...head];
  }
  const time: EventLine[] = marker && narrow ? [] : [{ part: "time", text: narrow ? start : range }];
  const fitsMore = heightPx >= (head.length + time.length + 1) * LINE_PX + EDGE_PX;
  const more: EventLine[] = fitsMore && !narrow && detail ? [{ part: "detail", text: detail }] : [];
  return { inline: false, lines: [...head, ...time, ...more] };
}

const TONE_CLASSES: Record<EventTone, string> = {
  confirmed: "bg-cal-confirmed text-cal-on-confirmed",
  // The fill alone is about 1.1:1 on the light work surface, so the block's edge
  // is drawn in the outline color, which keeps 3:1 on every surface under it
  // (test/admin-calendar-tokens.test.ts).
  pending: "border border-cal-outline bg-cal-pending text-cal-on-pending",
  external: "bg-cal-external text-cal-on-external",
};

/**
 * One booking or external event on the time grid. A surface-colored ring keeps
 * touching blocks apart; the selected one gets a primary ring outside a surface
 * gap. Only blocks that open something are buttons (onSelect, which gets the
 * button so focus can go back to it).
 */
export function CalendarEvent({
  tone,
  lines,
  inline,
  label,
  style,
  selected = false,
  expanded = false,
  cleaning = null,
  onSelect,
  onPointerDown,
}: Readonly<{
  tone: EventTone;
  lines: readonly EventLine[];
  inline: boolean;
  label: string;
  style: CSSProperties;
  selected?: boolean;
  expanded?: boolean;
  // The cleaning time at the end of a booking, in px from the block's top: marked
  // by a dashed line drawn behind the text, with no tint, so the text keeps its
  // contrast where the band crosses it (a short block centers its label).
  cleaning?: Readonly<{ top: number; height: number }> | null;
  onSelect?: (opener: HTMLElement) => void;
  onPointerDown?: PointerEventHandler<HTMLButtonElement>;
}>) {
  const className = cn(
    "absolute z-10 overflow-hidden rounded-md px-1.5 text-left text-xs leading-4 ring-1 ring-cal-surface",
    inline ? "flex items-center gap-1.5 py-0" : "flex flex-col py-0.5",
    TONE_CLASSES[tone],
    selected && "z-20 ring-2 ring-cal-primary ring-offset-2 ring-offset-cal-surface",
  );
  const band = cleaning && (
    <span
      aria-hidden="true"
      data-cleaning=""
      className="absolute inset-x-0 -z-1 border-t border-dashed border-current"
      style={{ top: cleaning.top, height: cleaning.height }}
    />
  );
  const body = lines.map((line) => (
    <span key={line.part} className={cn("min-w-0", line.wrap ? "line-clamp-2 wrap-anywhere" : "truncate", line.strong && "font-semibold")}>
      {line.text}
    </span>
  ));
  if (!onSelect) {
    return (
      <div className={className} style={style} data-event-tone={tone}>
        <span className="sr-only">{label}</span>
        <span aria-hidden="true" className="contents">
          {body}
        </span>
        {band}
      </div>
    );
  }
  return (
    <button
      type="button"
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-current={selected || undefined}
      onClick={(event: MouseEvent<HTMLButtonElement>) => onSelect(event.currentTarget)}
      onPointerDown={onPointerDown}
      className={cn(
        className,
        "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-cal-primary",
        onPointerDown && "cursor-grab select-none active:cursor-grabbing [-webkit-touch-callout:none]",
      )}
      style={style}
      data-event-tone={tone}
    >
      {body}
      {band}
      {onPointerDown && (
        <span aria-hidden="true" data-calendar-resize-grip="" className="absolute inset-x-0 bottom-0 hidden h-2 cursor-ns-resize place-items-center any-pointer-fine:grid">
          <span className="h-0.5 w-4 max-w-1/2 rounded-full bg-current" />
        </span>
      )}
    </button>
  );
}
