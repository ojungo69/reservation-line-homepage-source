import { useLayoutEffect, useRef, useState } from "react";

type Layout = Readonly<{ barPx: number; scrollbarPx: number; columnPx: number | null; columnsOverflow: boolean }>;

const SHOWN_PERIOD = '[data-period-side="0"]';
const COLUMNS_SCROLL = "[data-calendar-columns-scroll]";

function hasOverflow(viewport: HTMLElement | null) {
  return viewport !== null && viewport.scrollWidth > viewport.clientWidth;
}

/**
 * Sizes read from the DOM: the floating bar's height (the grid starts below it
 * and scrolls under it), the scrollbar's width (the bar's day header lines up
 * with the columns), and one column's width (blocks choose what text fits).
 */
export function useCalendarLayout(columnCount: number, periodKey: string) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const columnsViewport = useRef<HTMLElement | null>(null);
  const syncColumns = useRef(() => {});
  const [layout, setLayout] = useState<Layout>({ barPx: 0, scrollbarPx: 0, columnPx: null, columnsOverflow: false });
  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    const scroller = scrollerRef.current;
    if (!overlay || !scroller) return;
    const shown = scroller.querySelector(SHOWN_PERIOD);
    const viewport = shown?.querySelector<HTMLElement>(COLUMNS_SCROLL) ?? null;
    columnsViewport.current = viewport;
    // The header and both previews follow the visible column scroller. A period
    // that slides into view keeps its DOM, including its column scroll position.
    const mirrors = [...overlay.querySelectorAll<HTMLElement>(COLUMNS_SCROLL), ...scroller.querySelectorAll<HTMLElement>(COLUMNS_SCROLL)]
      .filter((element) => element !== viewport);
    syncColumns.current = () => {
      if (!viewport) return;
      const left = viewport.scrollLeft;
      for (const mirror of mirrors) if (mirror.scrollLeft !== left) mirror.scrollLeft = left;
    };
    const sync = syncColumns.current;
    viewport?.addEventListener("scroll", sync, { passive: true });

    const measure = () => {
      const next: Layout = {
        barPx: overlay.offsetHeight,
        scrollbarPx: Math.max(0, scroller.offsetWidth - scroller.clientWidth),
        columnPx: shown?.querySelector<HTMLElement>("[data-calendar-column]")?.offsetWidth || null,
        columnsOverflow: hasOverflow(viewport),
      };
      setLayout((prev) =>
        prev.barPx === next.barPx && prev.scrollbarPx === next.scrollbarPx && prev.columnPx === next.columnPx &&
        prev.columnsOverflow === next.columnsOverflow ? prev : next,
      );
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(overlay);
    observer?.observe(scroller);
    if (viewport) observer?.observe(viewport);
    return () => {
      observer?.disconnect();
      viewport?.removeEventListener("scroll", sync);
    };
    // Rebind when the shown pane changes or columns appear or change in number.
  }, [columnCount, periodKey]);
  useLayoutEffect(() => {
    syncColumns.current();
  }, [columnCount, periodKey, layout.scrollbarPx]);
  return { overlayRef, scrollerRef, layout, columnsOverflow: () => hasOverflow(columnsViewport.current) };
}
