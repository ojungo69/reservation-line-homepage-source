import { useState } from "react";
import type { CalendarView } from "./columns";

const STORAGE_KEY = "admin-calendar-view";

// A blocked store (a private window, cleared site data) reads as no choice.
function savedView(): CalendarView | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "list" || value === "day" || value === "week" ? value : null;
  } catch {
    return null;
  }
}

/**
 * The view the user asked for, remembered per device (spec 008 T006, UX-07).
 * Without a saved choice a phone starts on the list and a wider screen on the
 * week (DESIGN.md §5). Only `choose` saves. `openDay` shows a day opened from
 * the week for the store shown, without saving it; picking a store ends it, so
 * a saved week comes back (INT-02-03). The day shown in place of a week for all
 * stores or on a phone (effectiveView) leaves the saved choice as it is too.
 */
export function useCalendarView(narrow: boolean, storeId: string | null) {
  const [chosen, setChosen] = useState<CalendarView>(() => savedView() ?? (narrow ? "list" : "week"));
  // The store a day was opened from the week for; undefined while none is.
  const [dayFor, setDayFor] = useState<string | null | undefined>(undefined);
  // Set while rendering, so a store switch never paints the day it ends.
  if (dayFor !== undefined && dayFor !== storeId) setDayFor(undefined);
  const choose = (next: CalendarView) => {
    setChosen(next);
    setDayFor(undefined);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // The choice still applies to this visit.
    }
  };
  const requested: CalendarView = dayFor === storeId ? "day" : chosen;
  return { requested, choose, openDay: () => setDayFor(storeId) };
}
