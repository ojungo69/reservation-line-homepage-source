import { useLayoutEffect, useRef, useState } from "react";

type Layout = Readonly<{ barPx: number; scrollbarPx: number; columnPx: number | null }>;

/**
 * Sizes read from the DOM: the floating bar's height (the grid starts below it
 * and scrolls under it), the scrollbar's width (the bar's day header lines up
 * with the columns), and one column's width (blocks choose what text fits).
 */
export function useCalendarLayout(columnCount: number, gutterPx: number) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<Layout>({ barPx: 0, scrollbarPx: 0, columnPx: null });
  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    const scroller = scrollerRef.current;
    // jsdom has no ResizeObserver and no layout: keep the defaults there.
    if (!overlay || !scroller || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const next: Layout = {
        barPx: overlay.offsetHeight,
        scrollbarPx: scroller.offsetWidth - scroller.clientWidth,
        columnPx: columnCount > 0 ? (scroller.clientWidth - gutterPx) / columnCount : null,
      };
      setLayout((prev) =>
        prev.barPx === next.barPx && prev.scrollbarPx === next.scrollbarPx && prev.columnPx === next.columnPx ? prev : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(overlay);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [columnCount, gutterPx]);
  return { overlayRef, scrollerRef, layout };
}
