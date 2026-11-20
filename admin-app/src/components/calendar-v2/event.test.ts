import { describe, expect, it } from "vitest";
import { eventLines } from "./event";

const base = { title: "山田 花子", start: "10:00", range: "10:00–11:00", detail: "カット" } as const;
const texts = (args: Parameters<typeof eventLines>[0]) => eventLines(args).lines.map((line) => line.text);

describe("eventLines", () => {
  it("shows the name, time range and menu when the block is tall and wide", () => {
    expect(texts({ ...base, tone: "confirmed", heightPx: 60, widthPx: 140 })).toEqual(["山田 花子", "10:00–11:00", "カット"]);
  });

  it("puts a short booking on one row with its start time first", () => {
    const result = eventLines({ ...base, tone: "confirmed", heightPx: 24, widthPx: 140 });
    expect(result.inline).toBe(true);
    expect(result.lines.map((line) => line.text)).toEqual(["10:00", "山田 花子"]);
  });

  it("drops the time before the name on a narrow block", () => {
    expect(texts({ ...base, tone: "confirmed", heightPx: 24, widthPx: 60 })).toEqual(["山田 花子"]);
    expect(texts({ ...base, tone: "confirmed", heightPx: 60, widthPx: 60 })).toEqual(["山田 花子", "10:00"]);
  });

  it("keeps a one-row block's time only where time and name both fit", () => {
    // At 74px "10:00 山田 花子" cut both to a character in a browser.
    expect(texts({ ...base, tone: "confirmed", heightPx: 24, widthPx: 74 })).toEqual(["山田 花子"]);
    expect(texts({ ...base, tone: "pending", heightPx: 24, widthPx: 74 })).toEqual(["承認待ち"]);
    expect(texts({ ...base, tone: "confirmed", heightPx: 24, widthPx: 100 })).toEqual(["10:00", "山田 花子"]);
  });

  it("lets the name of a narrow tall block wrap instead of cutting it", () => {
    const narrowName = eventLines({ ...base, tone: "confirmed", heightPx: 60, widthPx: 40 }).lines.find((line) => line.part === "title");
    expect(narrowName?.wrap).toBe(true);
    const wideName = eventLines({ ...base, tone: "confirmed", heightPx: 60, widthPx: 140 }).lines.find((line) => line.part === "title");
    expect(wideName?.wrap).toBe(false);
  });

  it("never drops 承認待ち, which the fill alone does not convey", () => {
    expect(texts({ ...base, tone: "pending", heightPx: 24, widthPx: 60 })).toEqual(["承認待ち"]);
    expect(texts({ ...base, tone: "pending", heightPx: 24, widthPx: 140 })).toEqual(["承認待ち", "山田 花子"]);
    expect(texts({ ...base, tone: "pending", heightPx: 40, widthPx: 140 })).toEqual(["承認待ち・山田 花子", "10:00–11:00"]);
    expect(texts({ ...base, tone: "pending", heightPx: 60, widthPx: 140 })).toEqual([
      "承認待ち", "山田 花子", "10:00–11:00", "カット",
    ]);
    expect(texts({ ...base, tone: "pending", heightPx: 60, widthPx: 60 })).toEqual(["承認待ち", "山田 花子"]);
  });

  it("gives every line a distinct part, so the parts can be keys", () => {
    for (const heightPx of [20, 40, 60]) {
      for (const tone of ["confirmed", "pending", "external"] as const) {
        const parts = eventLines({ ...base, tone, heightPx, widthPx: 140 }).lines.map((line) => line.part);
        expect(new Set(parts).size).toBe(parts.length);
      }
    }
  });
});
