import { useEffect, useRef, type RefObject } from "react";

/**
 * Where focus goes when one of the page's sheets closes. They open without a
 * Radix trigger, so Radix has nowhere to return focus. Callers set the returned
 * ref to what opened a sheet, or to <body> when nothing on the page did; when
 * an open sheet closes, focus goes back there, else to the fallback (the grid).
 */
export function useReturnFocus(sheetOpen: boolean, fallbackRef: RefObject<HTMLElement | null>) {
  const opener = useRef<HTMLElement | null>(null);
  // Only a sheet that was open and has closed uses it: StrictMode runs effects
  // twice on mount, before a sheet opened by an effect (次回予約) shows.
  const sheetWasOpen = useRef(false);
  useEffect(() => {
    if (sheetOpen) {
      sheetWasOpen.current = true;
      return;
    }
    if (!sheetWasOpen.current || !opener.current) return;
    sheetWasOpen.current = false;
    const target = opener.current;
    opener.current = null;
    if (target !== document.body && target.isConnected) target.focus();
    // <body> stands for "nothing to go back to": the fallback takes focus then.
    if (target === document.body || document.activeElement !== target) fallbackRef.current?.focus();
  }, [sheetOpen, fallbackRef]);
  return opener;
}
