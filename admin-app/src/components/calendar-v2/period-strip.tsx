import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type PeriodPane = Readonly<{ key: string; content: ReactNode }>;

/**
 * The shown period with the one before it to its left and the one after it to
 * its right, out of sight until a swipe moves the strip (usePeriodSwipe), so the
 * next day comes in with the finger as in a native pager (T006). The neighbours
 * are previews: inert, so nothing in them takes a press or focus, and hidden
 * from screen readers; each is clipped to the strip's height. Keyed by period,
 * so after a step the pane that came in keeps its DOM. fromTop: a list, whose
 * neighbours a swipe shows from their own top while it is scrolled.
 */
export function PeriodStrip({
  prev,
  current,
  next,
  fromTop = false,
  className,
}: Readonly<{ prev: PeriodPane; current: PeriodPane; next: PeriodPane; fromTop?: boolean; className?: string }>) {
  const panes = [
    { pane: prev, side: -1 },
    { pane: current, side: 0 },
    { pane: next, side: 1 },
  ];
  return (
    <div data-swipe-pane="" data-swipe-from-top={fromTop ? "" : undefined} className={cn("relative", className)}>
      {panes.map(({ pane, side }) => (
        <div
          key={pane.key}
          data-period-side={side}
          inert={side !== 0}
          aria-hidden={side === 0 ? undefined : true}
          className={side === 0 ? undefined : cn("absolute inset-y-0 w-full overflow-hidden", side < 0 ? "right-full" : "left-full")}
        >
          {pane.content}
        </div>
      ))}
    </div>
  );
}
