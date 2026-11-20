import { formatJstDate } from "@/lib/timeline";
import type { Resource, Store } from "@/types/api";
import { mondayWeek } from "./geometry";

export type CalendarView = "list" | "day" | "week";
export type GridView = Exclude<CalendarView, "list">;

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

export type SlotResource = { kind: "one"; resourceId: string } | { kind: "choose" } | { kind: "none" };

/**
 * The resource a booking made from an empty slot starts with: the store's only
 * active one. With two or more the form asks; with none the store cannot take a
 * booking, and the caller says so instead of opening an unfinishable form.
 */
export function slotResource(storeId: string, resources: readonly Resource[]): SlotResource {
  const active = resources.filter((resource) => resource.storeId === storeId && resource.active);
  if (active.length === 1) return { kind: "one", resourceId: active[0].id };
  return active.length === 0 ? { kind: "none" } : { kind: "choose" };
}
