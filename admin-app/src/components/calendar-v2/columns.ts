import { formatJstDate } from "@/lib/timeline";
import type { Resource, Store } from "@/types/api";
import { mondayWeek } from "./geometry";

export type CalendarView = "list" | "day" | "week";
type GridView = Exclude<CalendarView, "list">;

// Match the store columns in the original schedule.
export const STORE_COLUMN_MIN_WIDTH_PX = 120;

export type CalendarColumn = Readonly<{
  key: string;
  dateKey: string;
  date: Date;
  storeId: string;
  storeName: string;
}>;

/**
 * The store the calendar shows. A user who can see one store has it selected,
 * with no all-stores mode and no guidance (DESIGN.md §5); null means all stores.
 */
export function visibleStoreId(selectedStoreId: string | null, stores: readonly Store[]): string | null {
  return selectedStoreId ?? (stores.length === 1 ? stores[0].id : null);
}

/** A week needs one store and a wide screen; otherwise its day is shown. */
export function effectiveView(view: CalendarView, { narrow, storeId }: { narrow: boolean; storeId: string | null }): CalendarView {
  return view === "week" && (narrow || storeId === null) ? "day" : view;
}

/** One store's seven days from Monday, or one day with a column per shown store. */
export function buildColumns(view: GridView, date: Date, storeId: string | null, stores: readonly Store[]): CalendarColumn[] {
  const shown = storeId === null ? stores : stores.filter((store) => store.id === storeId);
  const days = view === "week" && storeId !== null ? mondayWeek(date) : [date];
  return days.flatMap((day) => {
    const dateKey = formatJstDate(day);
    return shown.map((store) => ({ key: `${dateKey}:${store.id}`, dateKey, date: day, storeId: store.id, storeName: store.name }));
  });
}

/**
 * The store's active resources. None: the grid offers no slots there. One: a
 * booking from a slot starts with it. Two or more: the form asks.
 */
export function activeResourceIds(storeId: string, resources: readonly Resource[]): string[] {
  return resources.filter((resource) => resource.storeId === storeId && resource.active).map((resource) => resource.id);
}
