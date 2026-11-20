import { describe, expect, it } from "vitest";
import { formatJstDate } from "@/lib/timeline";
import type { BusinessHour } from "@/types/api";
import { clipToDay, closedRanges, layoutLanes, mondayWeek } from "./geometry";

const hours = (rows: Array<Partial<BusinessHour>>): BusinessHour[] =>
  rows.map((row, index) => ({
    id: `bh-${index}`,
    storeId: "s1",
    weekday: 1,
    opensAt: "10:00",
    closesAt: "19:00",
    active: true,
    ...row,
  }));

describe("clipToDay", () => {
  it("returns minutes from the JST midnight of the day", () => {
    expect(clipToDay("2026-11-20T01:00:00Z", "2026-11-20T02:30:00Z", "2026-11-20")).toEqual({ start: 600, end: 690 });
  });

  it("clips a booking that crosses midnight to each day it touches", () => {
    const start = "2026-11-20T14:00:00Z"; // 23:00 JST
    const end = "2026-11-20T16:00:00Z"; // 01:00 JST next day
    expect(clipToDay(start, end, "2026-11-20")).toEqual({ start: 1380, end: 1440 });
    expect(clipToDay(start, end, "2026-11-21")).toEqual({ start: 0, end: 60 });
  });

  it("returns null for a span outside the day, an empty span, or an unreadable time", () => {
    expect(clipToDay("2026-11-21T01:00:00Z", "2026-11-21T02:00:00Z", "2026-11-20")).toBeNull();
    expect(clipToDay("2026-11-20T01:00:00Z", "2026-11-20T01:00:00Z", "2026-11-20")).toBeNull();
    expect(clipToDay("not a time", "2026-11-20T01:00:00Z", "2026-11-20")).toBeNull();
  });
});

describe("layoutLanes", () => {
  const item = (id: string, start: number, end: number) => ({ item: id, start, end });
  const byId = (placed: ReturnType<typeof layoutLanes<string>>) =>
    Object.fromEntries(placed.map((p) => [p.item, { lane: p.lane, lanes: p.lanes, span: p.span }]));

  it("keeps items that do not overlap full width, including touching ones", () => {
    expect(byId(layoutLanes([item("a", 600, 660), item("b", 660, 720)]))).toEqual({
      a: { lane: 0, lanes: 1, span: 1 },
      b: { lane: 0, lanes: 1, span: 1 },
    });
  });

  it("places overlapping items side by side and never on top of each other", () => {
    expect(byId(layoutLanes([item("a", 600, 720), item("b", 630, 690), item("c", 640, 700)]))).toEqual({
      a: { lane: 0, lanes: 3, span: 1 },
      b: { lane: 1, lanes: 3, span: 1 },
      c: { lane: 2, lanes: 3, span: 1 },
    });
  });

  it("widens an item into free lanes on its right", () => {
    // b and c take the second and third lanes. e starts after b ends, so it reuses
    // the second lane and widens into the third, which c has left by then.
    const placed = byId(layoutLanes([item("a", 600, 720), item("b", 600, 630), item("c", 600, 615), item("e", 660, 690)]));
    expect(placed.e).toEqual({ lane: 1, lanes: 3, span: 2 });
    expect(placed.a).toEqual({ lane: 0, lanes: 3, span: 1 });
  });

  it("starts a new cluster after every overlap ends, with its own lane count", () => {
    const placed = byId(layoutLanes([item("a", 600, 660), item("b", 610, 640), item("c", 700, 760)]));
    expect(placed.c).toEqual({ lane: 0, lanes: 1, span: 1 });
    expect(placed.a.lanes).toBe(2);
  });

  it("treats a floored short item as reaching its drawn end", () => {
    // A 5-minute booking drawn at the minimum height covers the next booking unless
    // the lanes use the drawn end.
    const placed = byId(layoutLanes([item("short", 600, 605), item("next", 610, 660)], 20));
    expect(placed.short.lanes).toBe(2);
    expect(placed.next.lane).toBe(1);
  });
});

describe("mondayWeek", () => {
  it.each([
    ["a Sunday", "2026-11-22T03:00:00Z", "2026-11-16"],
    ["a Monday", "2026-11-16T03:00:00Z", "2026-11-16"],
    ["Sunday just before JST midnight", "2026-11-22T14:59:00Z", "2026-11-16"],
    ["Monday just after JST midnight", "2026-11-22T15:00:00Z", "2026-11-23"],
  ])("starts the week of %s on Monday in JST", (_label, iso, monday) => {
    const days = mondayWeek(new Date(iso)).map(formatJstDate);
    expect(days).toHaveLength(7);
    expect(days[0]).toBe(monday);
    expect(new Set(days).size).toBe(7);
  });

  it("crosses a year end", () => {
    expect(mondayWeek(new Date("2026-12-31T03:00:00Z")).map(formatJstDate)).toEqual([
      "2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03",
    ]);
  });
});

describe("closedRanges", () => {
  it("tints the day outside the store's opening hours", () => {
    expect(closedRanges(hours([{}]), "s1", 1)).toEqual([
      { start: 0, end: 600 },
      { start: 1140, end: 1440 },
    ]);
  });

  it("leaves a break between two opening rows closed", () => {
    expect(closedRanges(hours([{ closesAt: "13:00" }, { opensAt: "14:00" }]), "s1", 1)).toEqual([
      { start: 0, end: 600 },
      { start: 780, end: 840 },
      { start: 1140, end: 1440 },
    ]);
  });

  it("closes the whole day when the store has hours but none that day", () => {
    expect(closedRanges(hours([{ weekday: 2 }]), "s1", 1)).toEqual([{ start: 0, end: 1440 }]);
    expect(closedRanges(hours([{ active: false }]), "s1", 1)).toEqual([{ start: 0, end: 1440 }]);
  });

  it("tints nothing for a store without any configured hours", () => {
    expect(closedRanges(hours([{ storeId: "other" }]), "s1", 1)).toEqual([]);
  });
});
