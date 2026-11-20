import { describe, expect, it } from "vitest";
import { formatJstDate } from "@/lib/timeline";
import type { Resource, Store } from "@/types/api";
import { activeResourceIds, buildColumns, effectiveView, visibleStoreId } from "./columns";

const store = (id: string, name: string): Store => ({
  id,
  name,
  timezone: "Asia/Tokyo",
  googleCalendarId: null,
  googleControlledEditMode: false,
  maxActiveReservationsPerCustomer: null,
  bookingWindowDays: null,
  customerNotice: null,
} as unknown as Store);
const resource = (id: string, storeId: string, active = true): Resource =>
  ({ id, storeId, name: id, resourceType: "chair", active }) as Resource;

const STORES = [store("s1", "本店"), store("s2", "駅前店")];
const FRIDAY = new Date("2026-11-20T03:00:00Z");

describe("visibleStoreId", () => {
  it("keeps the selected store", () => {
    expect(visibleStoreId("s2", STORES)).toBe("s2");
  });

  it("treats the only store a user can see as selected, so there is no all-stores mode", () => {
    expect(visibleStoreId(null, [store("s1", "本店")])).toBe("s1");
  });

  it("means all stores when two or more are visible and none is selected", () => {
    expect(visibleStoreId(null, STORES)).toBeNull();
  });
});

describe("effectiveView", () => {
  it("shows the week for one store on a wide screen", () => {
    expect(effectiveView("week", { narrow: false, storeId: "s1" })).toBe("week");
  });

  it("shows the day instead of the week for all stores, or on a phone", () => {
    expect(effectiveView("week", { narrow: false, storeId: null })).toBe("day");
    expect(effectiveView("week", { narrow: true, storeId: "s1" })).toBe("day");
  });

  it("keeps the day and the list as chosen", () => {
    expect(effectiveView("day", { narrow: true, storeId: null })).toBe("day");
    expect(effectiveView("list", { narrow: false, storeId: "s1" })).toBe("list");
  });
});

describe("buildColumns", () => {
  it("lays out one store's week from Monday", () => {
    const columns = buildColumns("week", FRIDAY, "s1", STORES);
    expect(columns.map((column) => formatJstDate(column.date))).toEqual([
      "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22",
    ]);
    expect(new Set(columns.map((column) => column.storeId))).toEqual(new Set(["s1"]));
    expect(new Set(columns.map((column) => column.key)).size).toBe(7);
  });

  it("gives the day one column for the chosen store, and one per store for all stores", () => {
    expect(buildColumns("day", FRIDAY, "s2", STORES).map((column) => column.storeName)).toEqual(["駅前店"]);
    const all = buildColumns("day", FRIDAY, null, STORES);
    expect(all.map((column) => column.storeName)).toEqual(["本店", "駅前店"]);
    expect(all.map((column) => column.dateKey)).toEqual(["2026-11-20", "2026-11-20"]);
  });

  it("draws no column for a store that is not loaded yet", () => {
    expect(buildColumns("day", FRIDAY, "s1", [])).toEqual([]);
    expect(buildColumns("week", FRIDAY, "s1", [])).toEqual([]);
  });
});

describe("activeResourceIds", () => {
  it("keeps the store's active resources only", () => {
    expect(activeResourceIds("s1", [resource("r1", "s1"), resource("r-off", "s1", false), resource("r2", "s2"), resource("r3", "s1")])).toEqual([
      "r1",
      "r3",
    ]);
  });

  it("is empty for a store without an active resource", () => {
    expect(activeResourceIds("s1", [resource("r-off", "s1", false), resource("r2", "s2")])).toEqual([]);
  });
});
