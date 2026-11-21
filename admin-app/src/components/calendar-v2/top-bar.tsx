import { useLayoutEffect, useState, type ReactNode, type Ref } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Menu, Search } from "lucide-react";
import { MiniCalendar } from "@/components/schedule/mini-calendar";
import { PRESSABLE } from "@/components/shell-v2/pressable";
import { useShellV2 } from "@/components/shell-v2/shell-context";
import { StoreSwitchV2 } from "@/components/shell-v2/store-switch-v2";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
 * scrolling grid, in place of the shell's header, so it also carries the
 * shell's menu and page move. Text on the glass is body color only; the pending
 * entry and the chosen view are fills with their own text colors, and the
 * chosen view also has a check, so it is not told apart by hue alone. Today,
 * back and forward move by the view's unit, as a swipe or a sideways wheel on
 * the body does (usePeriodSwipe); the heading opens a Monday-start month to
 * pick a date from (T006, DESIGN.md §5).
 */
export function CalendarTopBar({
  heading,
  spoken,
  headingRef,
  date,
  onPickDate,
  view,
  weekShown,
  onView,
  onToday,
  onStep,
  stepUnit,
  pendingCount,
  pendingCapped,
  onOpenPending,
  dayHeader,
}: Readonly<{
  heading: string;
  // The shown period in full, read out when it changes: a week keeps its month
  // heading while its days change (INT-12-05).
  spoken: string;
  // Focus lands here when the control that had it goes away (a day header in the
  // week, a retry button once its alert clears).
  headingRef: Ref<HTMLHeadingElement>;
  date: Date;
  onPickDate: (date: Date) => void;
  view: CalendarView;
  // Phones get no week button: seven columns do not fit (DESIGN.md §5).
  weekShown: boolean;
  onView: (view: CalendarView) => void;
  onToday: () => void;
  onStep: (direction: -1 | 1) => void;
  stepUnit: "日" | "週";
  pendingCount: number | null;
  // The pending list hit its row limit, so the count is a floor.
  pendingCapped: boolean;
  onOpenPending: (opener: HTMLElement) => void;
  dayHeader: ReactNode;
}>) {
  const shell = useShellV2();
  const setOwnTopBar = shell?.setOwnTopBar;
  const [pickerOpen, setPickerOpen] = useState(false);
  let pendingLabel = "承認待ち";
  if (pendingCount !== null) pendingLabel += ` ${pendingCount}件${pendingCapped ? "以上" : ""}`;
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
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <h1 ref={headingRef} tabIndex={-1} className="min-w-0 outline-hidden">
            <PopoverTrigger asChild>
              <button
                type="button"
                className={cn("flex min-h-11 max-w-full items-center gap-1 rounded-full px-2 text-xl hover:bg-cal-text/8 max-sm:text-lg", PRESSABLE)}
              >
                <span className="truncate">{heading}</span>
                <ChevronDown className="size-4 shrink-0" aria-hidden="true" />
              </button>
            </PopoverTrigger>
          </h1>
          {/* Opaque: DESIGN.md §3 keeps glass to the bar, the + button, details and page move. */}
          <PopoverContent align="start" material="surface" aria-label="日付選択">
            <MiniCalendar
              selected={date}
              weekStartsOn={1}
              onSelect={(day) => {
                onPickDate(day);
                setPickerOpen(false);
              }}
            />
          </PopoverContent>
        </Popover>
        <p className="sr-only" aria-live="polite">
          {spoken}
        </p>
        <div className="flex-1" />
        {shell && (
          // Not on phones: the drawer lists every page there, and one more button
          // would wrap the bar to a third row.
          <button
            type="button"
            onClick={(event) => shell.openPalette(event.currentTarget)}
            aria-label="ページ移動 (Cmd/Ctrl+K)"
            aria-keyshortcuts="Meta+K Control+K"
            className={cn(ICON_BUTTON, "max-sm:hidden")}
          >
            <Search className="size-5" aria-hidden="true" />
          </button>
        )}
        <StoreSwitchV2 />
        <button
          type="button"
          onClick={(event) => onOpenPending(event.currentTarget)}
          className={cn("min-h-11 rounded-full bg-cal-pending px-4 text-sm font-medium text-cal-on-pending max-sm:px-3", PRESSABLE)}
        >
          {pendingLabel}
        </button>
        <fieldset className="flex rounded-full bg-cal-detail p-0.5">
          <legend className="sr-only">表示</legend>
          {VIEWS.filter((entry) => weekShown || entry.view !== "week").map((entry) => {
            const chosen = view === entry.view;
            return (
              <button
                key={entry.view}
                type="button"
                aria-pressed={chosen}
                onClick={() => onView(entry.view)}
                className={cn(
                  // Tighter on phones, so the check fits without a third row of tools.
                  "flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-full px-3 text-sm max-sm:gap-0.5 max-sm:px-2",
                  chosen ? "bg-cal-selected font-medium text-cal-on-selected" : "text-cal-text",
                  PRESSABLE,
                )}
              >
                {chosen && <Check className="size-4" aria-hidden="true" data-chosen-mark="" />}
                {entry.label}
              </button>
            );
          })}
        </fieldset>
      </div>
      {dayHeader}
    </div>
  );
}

/**
 * The row of day or store names under the bar's tools, lined up with the columns.
 * As wide as the body, so its period strip moves with the body's (usePeriodSwipe)
 * and keeps the neighbours out of sight.
 */
export function DayHeader({ scrollbarPx, children }: Readonly<{ scrollbarPx: number; children: ReactNode }>) {
  return (
    <div className="overflow-hidden" style={{ marginRight: scrollbarPx }}>
      {children}
    </div>
  );
}

/** One period's names: the time zone over the gutter, then one per column. */
export function DayHeaderRow({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="flex">
      <div className={cn("flex items-end justify-end pb-1 pr-2 text-xs", GUTTER_CLASS)}>JST</div>
      <div className="flex min-w-0 flex-1">{children}</div>
    </div>
  );
}
