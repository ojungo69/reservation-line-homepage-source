import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { DAY_MINUTES, HOUR_PX, PX_PER_MINUTE } from "./geometry";

// The time labels' gutter; the bar's day header uses the same width to line up.
export const GUTTER_CLASS = "w-14 shrink-0 max-sm:w-12";

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/**
 * The shared 24-hour axis (DESIGN.md §5): hour labels in the gutter and the hour
 * and half-hour lines behind the columns. There is no 00:00 label, so the first
 * row is not crowded by the bar's edge.
 */
export function CalendarGrid({
  children,
  minColumnsWidth,
  columnsOverflow,
  gutterNowMinute,
}: Readonly<{
  children: ReactNode;
  minColumnsWidth: number | undefined;
  columnsOverflow: boolean;
  gutterNowMinute: number | null;
}>) {
  const scrollableColumns = minColumnsWidth !== undefined;
  const columns = (
    <div className="relative flex min-w-0 flex-1" style={{ minWidth: minColumnsWidth }}>
      {/* Above the closed-hours bands (opaque in dark mode), below the bookings. */}
      <div aria-hidden="true" data-grid-lines="" className="pointer-events-none absolute inset-0 z-1">
        {HOURS.map((hour) => (
          <Fragment key={hour}>
            {hour > 0 && <div className="absolute inset-x-0 border-t border-cal-grid" style={{ top: hour * HOUR_PX }} />}
            <div className="absolute inset-x-0 border-t border-cal-grid/50" style={{ top: hour * HOUR_PX + HOUR_PX / 2 }} />
          </Fragment>
        ))}
      </div>
      {children}
    </div>
  );
  return (
    // In the all-stores grid, leave room below the last hour for a native scrollbar.
    <div className="flex" style={scrollableColumns ? undefined : { height: DAY_MINUTES * PX_PER_MINUTE }}>
      <div aria-hidden="true" className={cn("relative", GUTTER_CLASS)}>
        {HOURS.slice(1).map((hour) => (
          <span
            key={hour}
            className="absolute right-2 -translate-y-1/2 text-xs tabular-nums text-cal-text-secondary"
            style={{ top: hour * HOUR_PX }}
          >
            {String(hour).padStart(2, "0")}:00
          </span>
        ))}
        {gutterNowMinute !== null && (
          <div
            className="pointer-events-none absolute -right-1.5 z-40 size-3 -translate-y-1/2 rounded-full bg-cal-alert ring-1 ring-cal-surface"
            style={{ top: gutterNowMinute * PX_PER_MINUTE }}
          />
        )}
      </div>
      {scrollableColumns ? (
        <div
          data-calendar-columns-scroll=""
          className={cn("min-w-0 flex-1 overflow-x-auto overscroll-x-contain", !columnsOverflow && "touch-pan-y touch-pinch-zoom")}
        >
          {columns}
        </div>
      ) : columns}
    </div>
  );
}
