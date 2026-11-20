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
 * week (DESIGN.md §5). Only `choose` saves: a day opened from the week, and the
 * day shown in place of a week for all stores or on a phone (effectiveView),
 * leave the saved choice as it was (INT-02-03).
 */
export function useCalendarView(narrow: boolean) {
  const [requested, setRequested] = useState<CalendarView>(() => savedView() ?? (narrow ? "list" : "week"));
  const choose = (next: CalendarView) => {
    setRequested(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // The choice still applies to this visit.
    }
  };
  return { requested, setRequested, choose };
}
