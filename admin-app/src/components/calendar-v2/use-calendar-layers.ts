import { useState } from "react";
import { ALL_LAYERS, type Layers } from "./body";

const STORAGE_KEY = "admin-calendar-layers";

// A blocked store (a private window, cleared site data) or a value this
// version cannot read shows everything.
function savedLayers(): Layers {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (typeof value === "object" && value !== null) {
      const { pending, google } = value as Record<string, unknown>;
      if (typeof pending === "boolean" && typeof google === "boolean") return { pending, google };
    }
  } catch {
    // Falls through to everything shown.
  }
  return ALL_LAYERS;
}

/**
 * 表示する予定, remembered per device like the view (useCalendarView): the
 * owner chose this on 2026-11-22. Hidden pending bookings stay counted on the
 * bar's 承認待ち button either way.
 */
export function useCalendarLayers() {
  const [layers, setLayers] = useState<Layers>(savedLayers);
  const choose = (next: Layers) => {
    setLayers(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // The choice still applies to this visit.
    }
  };
  return [layers, choose] as const;
}
