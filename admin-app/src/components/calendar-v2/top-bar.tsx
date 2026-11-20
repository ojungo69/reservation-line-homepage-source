import { useLayoutEffect, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Menu } from "lucide-react";
import { PRESSABLE } from "@/components/shell-v2/pressable";
import { useShellV2 } from "@/components/shell-v2/shell-context";
import { StoreSwitchV2 } from "@/components/shell-v2/store-switch-v2";
import { cn } from "@/lib/utils";
import type { CalendarView } from "./columns";
import { GUTTER_CLASS } from "./grid";

const ICON_BUTTON = cn("grid min-h-11 min-w-11 place-items-center rounded-full hover:bg-cal-text/8", PRESSABLE);

const VIEWS: Array<{ view: CalendarView; label: string }> = [
  { view: "list", label: "一覧" },
  { view: "day", label: "日" },
  { view: "week", label: "週" },
];

/**
 * The calendar's floating top bar (DESIGN.md §3, §5): glass-thick over the
 * scrolling grid, in place of the shell's header. Text on the glass is body
 * color only; the pending entry and the chosen view are fills with their own
 * text colors. Today, back and forward move by the view's unit here; swipe,
 * wheel and the mini calendar come with T006.
 */
export function CalendarTopBar({
  heading,
  view,
  weekShown,
  onView,
  onToday,
  onStep,
  stepUnit,
  pendingCount,
  onOpenPending,
  dayHeader,
}: Readonly<{
  heading: string;
  view: CalendarView;
  // Phones get no week button: seven columns do not fit (DESIGN.md §5).
  weekShown: boolean;
  onView: (view: CalendarView) => void;
  onToday: () => void;
  onStep: (direction: -1 | 1) => void;
  stepUnit: "日" | "週";
  pendingCount: number | null;
  onOpenPending: () => void;
  dayHeader: ReactNode;
}>) {
  const shell = useShellV2();
  const setOwnTopBar = shell?.setOwnTopBar;
  // Layout effect, so the shell drops its header before the first paint.
  useLayoutEffect(() => {
    if (!setOwnTopBar) return;
    setOwnTopBar(true);
    return () => setOwnTopBar(false);
  }, [setOwnTopBar]);

  return (
    <div className="glass-thick pointer-events-auto text-cal-text">
      <div className="flex min-h-15 flex-wrap items-center gap-1 px-2 py-1.5">
        {shell?.showMenuButton && (
          <button
            ref={shell.menuButtonRef}
            type="button"
            onClick={shell.openMenu}
            aria-label="メニュー"
            aria-expanded={shell.menuOpen}
            className={ICON_BUTTON}
          >
            <Menu className="size-5" aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          onClick={onToday}
          className={cn("min-h-11 rounded-full px-4 text-sm font-medium hover:bg-cal-text/8", PRESSABLE)}
        >
          今日
        </button>
        <button type="button" onClick={() => onStep(-1)} aria-label={`前の${stepUnit}`} className={ICON_BUTTON}>
          <ChevronLeft className="size-5" aria-hidden="true" />
        </button>
        <button type="button" onClick={() => onStep(1)} aria-label={`次の${stepUnit}`} className={ICON_BUTTON}>
          <ChevronRight className="size-5" aria-hidden="true" />
        </button>
        <h1 aria-live="polite" className="min-w-0 truncate px-1 text-xl max-sm:text-lg">
          {heading}
        </h1>
        <div className="flex-1" />
        <StoreSwitchV2 />
        <button
          type="button"
          onClick={onOpenPending}
          className={cn("min-h-11 rounded-full bg-cal-pending px-4 text-sm font-medium text-cal-on-pending", PRESSABLE)}
        >
          承認待ち{pendingCount === null ? "" : ` ${pendingCount}件`}
        </button>
        <fieldset className="flex rounded-full bg-cal-detail p-0.5">
          <legend className="sr-only">表示</legend>
          {VIEWS.filter((entry) => weekShown || entry.view !== "week").map((entry) => (
            <button
              key={entry.view}
              type="button"
              aria-pressed={view === entry.view}
              onClick={() => onView(entry.view)}
              className={cn(
                "min-h-11 min-w-11 rounded-full px-3 text-sm",
                view === entry.view ? "bg-cal-selected font-medium text-cal-on-selected" : "text-cal-text",
                PRESSABLE,
              )}
            >
              {entry.label}
            </button>
          ))}
        </fieldset>
      </div>
      {dayHeader}
    </div>
  );
}

/** The row of day or store names under the bar's tools, lined up with the columns. */
export function DayHeader({ scrollbarPx, children }: Readonly<{ scrollbarPx: number; children: ReactNode }>) {
  return (
    <div className="flex" style={{ paddingRight: scrollbarPx }}>
      <div className={cn("flex items-end justify-end pb-1 pr-2 text-xs", GUTTER_CLASS)}>JST</div>
      <div className="flex min-w-0 flex-1">{children}</div>
    </div>
  );
}
