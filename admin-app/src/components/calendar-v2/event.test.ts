import { describe, expect, it } from "vitest";
import { eventLines } from "./event";

const base = { title: "山田 花子", start: "10:00", range: "10:00–11:00", detail: "カット" } as const;
const booking = { ...base, marker: null };
const pending = { ...base, marker: "承認待ち" };
const texts = (args: Parameters<typeof eventLines>[0]) => eventLines(args).lines.map((line) => line.text);

describe("eventLines", () => {
  it("shows the name, time range and menu when the block is tall and wide", () => {
    expect(texts({ ...booking, heightPx: 60, widthPx: 140 })).toEqual(["山田 花子", "10:00–11:00", "カット"]);
  });

  it("puts a short booking on one row with its start time first", () => {
    const result = eventLines({ ...booking, heightPx: 24, widthPx: 140 });
    expect(result.inline).toBe(true);
    expect(result.lines.map((line) => line.text)).toEqual(["10:00", "山田 花子"]);
  });

  it("drops the time before the name on a narrow block", () => {
    expect(texts({ ...booking, heightPx: 24, widthPx: 60 })).toEqual(["山田 花子"]);
    expect(texts({ ...booking, heightPx: 60, widthPx: 60 })).toEqual(["山田 花子", "10:00"]);
  });

  it("keeps a one-row block's time only where time and name both fit", () => {
    // At 74px "10:00 山田 花子" cut both to a character in a browser.
    expect(texts({ ...booking, heightPx: 24, widthPx: 74 })).toEqual(["山田 花子"]);
    expect(texts({ ...pending, heightPx: 24, widthPx: 74 })).toEqual(["承認待ち"]);
    expect(texts({ ...booking, heightPx: 24, widthPx: 100 })).toEqual(["10:00", "山田 花子"]);
  });

  it("lets the name of a narrow tall block wrap instead of cutting it", () => {
    const name = (widthPx: number) =>
      eventLines({ ...booking, heightPx: 60, widthPx }).lines.find((line) => line.part === "title");
    expect(name(40)?.wrap).toBe(true);
    expect(name(140)?.wrap).toBe(false);
  });

  it("never drops the marker, which the fill alone does not convey", () => {
    expect(texts({ ...pending, heightPx: 24, widthPx: 60 })).toEqual(["承認待ち"]);
    expect(texts({ ...pending, heightPx: 24, widthPx: 140 })).toEqual(["承認待ち", "山田 花子"]);
    expect(texts({ ...pending, heightPx: 40, widthPx: 140 })).toEqual(["承認待ち・山田 花子", "10:00–11:00"]);
    expect(texts({ ...pending, heightPx: 60, widthPx: 140 })).toEqual(["承認待ち", "山田 花子", "10:00–11:00"]);
    expect(texts({ ...pending, heightPx: 70, widthPx: 140 })).toEqual(["承認待ち", "山田 花子", "10:00–11:00", "カット"]);
    expect(texts({ ...pending, heightPx: 60, widthPx: 60 })).toEqual(["承認待ち", "山田 花子"]);
  });

  it("names the source of a short external event, not just its color", () => {
    const external = { ...base, title: "歯科", marker: "Google", detail: "" };
    expect(texts({ ...external, heightPx: 24, widthPx: 140 })).toEqual(["Google", "歯科"]);
    expect(texts({ ...external, heightPx: 40, widthPx: 140 })).toEqual(["Google・歯科", "10:00–11:00"]);
  });

  it("shows the menu line only where it fits below the other lines", () => {
    // Three 16px lines and the 6px padding and border: 54px.
    expect(texts({ ...booking, heightPx: 53, widthPx: 140 })).toEqual(["山田 花子", "10:00–11:00"]);
    expect(texts({ ...booking, heightPx: 54, widthPx: 140 })).toEqual(["山田 花子", "10:00–11:00", "カット"]);
    // With a marker on its own line, four lines need 70px.
    expect(texts({ ...pending, heightPx: 69, widthPx: 140 })).toHaveLength(3);
  });

  it("gives every line a distinct part, so the parts can be keys", () => {
    for (const heightPx of [20, 40, 60]) {
      for (const marker of [null, "承認待ち", "Google"]) {
        const parts = eventLines({ ...base, marker, heightPx, widthPx: 140 }).lines.map((line) => line.part);
        expect(new Set(parts).size).toBe(parts.length);
      }
    }
  });
});
