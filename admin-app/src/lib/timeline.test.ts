import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { BusinessHour } from "@/types/api";
import {
  getTimeSlots,
  isRebookableStatus,
  addDays,
  formatJstDate,
  formatFullJstDate,
  firstOfJstMonth,
  getMonthGrid,
  toggleWeekday,
  toJstDate,
  formatTime,
  formatDateDisplay,
  jstWeekday,
  statusColor,
  visitStatusLabel,
  statusLabel,
  isSameDay,
  currentTimePosition,
  getInitialScrollMinutes,
  getCardStyle,
  isScheduleVisibleReservationStatus,
} from "@/lib/timeline";

describe("toggleWeekday", () => {
  it("adds a day and keeps the selection in numeric order", () => {
    expect(toggleWeekday([1, 6], 0)).toEqual([0, 1, 6]);
    expect(toggleWeekday([0, 6], 3)).toEqual([0, 3, 6]);
  });

  it("removes a day that is already selected", () => {
    expect(toggleWeekday([0, 3, 6], 3)).toEqual([0, 6]);
  });

  it("does not mutate the input array", () => {
    const prev = [2];
    expect(toggleWeekday(prev, 5)).toEqual([2, 5]);
    expect(prev).toEqual([2]);
  });

  // 既定の sort() は文字列比較。曜日は 0-6 なので今日は同じ結果になるが、
  // comparator が消えた場合にここで落ちるよう 2 桁を含めて固定する。
  it("sorts numerically, not lexicographically", () => {
    expect(toggleWeekday([1, 10], 2)).toEqual([1, 2, 10]);
  });
});

// vitest はテスト実行時に Node の `process` を提供するが、admin-app の
// tsconfig は @types/node を含まない (Vite フロントエンドで通常不要)。
// DST 回帰テストの TZ 切替でのみ使う最小限のアンビエント宣言。
declare const process: { env: Record<string, string | undefined> };

describe("isRebookableStatus", () => {
  // 「次回予約」ショートカットは来店が終わってから(completed / no_show)のみ。
  it("allows rebook only for concluded visits", () => {
    expect(isRebookableStatus("completed")).toBe(true);
    expect(isRebookableStatus("no_show")).toBe(true);
  });

  it("does not offer rebook during/before the visit or for cancelled (B14 regression guard)", () => {
    // checked_in = mid-visit (complete/no_show still pending) — must NOT show rebook.
    expect(isRebookableStatus("checked_in")).toBe(false);
    expect(isRebookableStatus("confirmed")).toBe(false);
    expect(isRebookableStatus("pending_approval")).toBe(false);
    expect(isRebookableStatus("cancelled_by_admin")).toBe(false);
    expect(isRebookableStatus("cancelled_by_customer")).toBe(false);
    expect(isRebookableStatus("rejected")).toBe(false);
    expect(isRebookableStatus("expired")).toBe(false);
  });
});

// addDays は epoch + 固定 24h 加算で JST 日付を進める必要がある。旧実装は
// local `setDate` 加算だったため、DST のあるブラウザ TZ (例: America/New_York)
// で DST 境界を跨ぐと実加算が 23h/25h になり JST 日付が 1 日進まない/進み過ぎる
// バグがあった (JST 自体は DST 無し)。process.env.TZ を切り替えて固定する。
describe("addDays — DST-safe day arithmetic (regression)", () => {
  let originalTz: string | undefined;

  beforeAll(() => {
    originalTz = process.env.TZ;
    process.env.TZ = "America/New_York";
  });

  afterAll(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it("advances the JST date by exactly 1 day across the US spring-forward boundary", () => {
    // 2026-03-08T00:00:00+09:00 (JST) = 2026-03-07T15:00:00Z
    const base = new Date("2026-03-07T15:00:00.000Z");
    expect(formatJstDate(base)).toBe("2026-03-08");
    const next = addDays(base, 1);
    expect(formatJstDate(next)).toBe("2026-03-09");
  });

  it("advances the JST date by exactly 1 day across the US fall-back boundary", () => {
    // 2026-11-01T00:00:00+09:00 (JST) = 2026-10-31T15:00:00Z
    const base = new Date("2026-10-31T15:00:00.000Z");
    expect(formatJstDate(base)).toBe("2026-11-01");
    const next = addDays(base, 1);
    expect(formatJstDate(next)).toBe("2026-11-02");
  });

  it("moves the JST date back by exactly 1 day (negative direction)", () => {
    const base = new Date("2026-03-07T15:00:00.000Z"); // 2026-03-08 JST
    const prev = addDays(base, -1);
    expect(formatJstDate(prev)).toBe("2026-03-07");
  });
});

const bh = (over: Partial<BusinessHour>): BusinessHour =>
  ({
    id: "bh1",
    storeId: "s1",
    weekday: 1,
    opensAt: "10:00",
    closesAt: "19:00",
    active: true,
    ...over,
  }) as BusinessHour;

describe("getTimeSlots — fixed 0:00–24:00 window", () => {
  it("returns 96 fifteen-minute slots from 00:00 to 23:45 regardless of business hours", () => {
    const slots = getTimeSlots([bh({})], 1, "s1");
    expect(slots).toHaveLength(96);
    expect(slots[0].time).toBe("00:00");
    expect(slots[slots.length - 1].time).toBe("23:45");
  });

  it("returns the same full-day window when there are no matching business hours", () => {
    const slots = getTimeSlots([], 3, "s1");
    expect(slots).toHaveLength(96);
    expect(slots[0].time).toBe("00:00");
    expect(slots[slots.length - 1].time).toBe("23:45");
  });

  it("labels only the top-of-hour slots", () => {
    const slots = getTimeSlots([bh({})], 1, "s1");
    expect(slots[0].label).toBe("0:00"); // 00:00 labelled
    expect(slots[1].label).toBe(""); // 00:15 unlabelled
    expect(slots.find((s) => s.time === "09:00")?.label).toBe("9:00");
  });
});

describe("getInitialScrollMinutes", () => {
  it("returns the earliest open time (in minutes) for the matching weekday/store", () => {
    expect(getInitialScrollMinutes([bh({ opensAt: "10:00" })], 1, "s1")).toBe(600);
  });

  it("uses the earliest open across multiple matching rows", () => {
    const hours = [
      bh({ id: "a", opensAt: "11:00" }),
      bh({ id: "b", opensAt: "09:30" }),
    ];
    expect(getInitialScrollMinutes(hours, 1, "s1")).toBe(570);
  });

  it("keeps the earliest time when a later row opens later", () => {
    const hours = [
      bh({ id: "a", opensAt: "09:30" }),
      bh({ id: "b", opensAt: "11:00" }),
    ];
    expect(getInitialScrollMinutes(hours, 1, "s1")).toBe(570);
  });

  it("ignores inactive rows and other weekdays/stores", () => {
    const hours = [
      bh({ id: "a", opensAt: "08:00", active: false }),
      bh({ id: "b", opensAt: "07:00", weekday: 2 }),
      bh({ id: "c", opensAt: "07:30", storeId: "other" }),
      bh({ id: "d", opensAt: "10:00" }),
    ];
    expect(getInitialScrollMinutes(hours, 1, "s1")).toBe(600);
  });

  it("falls back to 09:00 (540) when no business hours match", () => {
    expect(getInitialScrollMinutes([], 4, "s1")).toBe(540);
  });

  it("matches across all stores when storeId is null", () => {
    const hours = [bh({ storeId: "x", opensAt: "08:00" })];
    expect(getInitialScrollMinutes(hours, 1, null)).toBe(480);
  });
});

describe("getCardStyle — full-day (0–1440) clip", () => {
  it("positions a 10:00–11:00 JST card relative to the full day", () => {
    // 2026-05-14T01:00Z = 10:00 JST, 02:00Z = 11:00 JST
    const style = getCardStyle(
      "2026-05-14T01:00:00Z",
      "2026-05-14T02:00:00Z",
      0,
      24 * 60,
      "2026-05-14",
    );
    expect(style).not.toBeNull();
    // 600/1440 = 41.666…%
    expect(style!.top).toBe("41.66666666666667%");
    // 60/1440 = 4.1666…%
    expect(style!.height).toBe("4.166666666666666%");
  });

  it("keeps a card ending at midnight (24:00) within the day", () => {
    // 23:00 JST → 24:00 JST (next-day 00:00 UTC handled by adjustedEndMin)
    const style = getCardStyle(
      "2026-05-14T14:00:00Z",
      "2026-05-14T15:00:00Z",
      0,
      24 * 60,
      "2026-05-14",
    );
    expect(style).not.toBeNull();
    expect(style!.height).toBe("4.166666666666666%");
  });
});

describe("isScheduleVisibleReservationStatus", () => {
  it("hides terminal statuses (cancelled / rejected / no_show / expired)", () => {
    for (const s of [
      "cancelled_by_admin",
      "cancelled_by_customer",
      "rejected",
      "no_show",
      "expired",
    ]) {
      expect(isScheduleVisibleReservationStatus(s)).toBe(false);
    }
  });

  it("shows active statuses on the schedule", () => {
    for (const s of ["pending_approval", "confirmed", "completed", "checked_in"]) {
      expect(isScheduleVisibleReservationStatus(s)).toBe(true);
    }
  });

  it("shows unknown statuses by default (fail-open to visible)", () => {
    expect(isScheduleVisibleReservationStatus("some_future_status")).toBe(true);
  });
});

describe("formatFullJstDate", () => {
  it("formats year/month/day with the JST weekday in parentheses", () => {
    // 2026-07-21 JST is a Tuesday (火)
    expect(formatFullJstDate(new Date("2026-07-21T00:00:00+09:00"))).toBe("2026年7月21日 (火)");
  });
});

describe("firstOfJstMonth", () => {
  it("returns the 1st of the anchor's JST month at offset 0", () => {
    const anchor = new Date("2026-07-21T00:00:00+09:00");
    expect(formatJstDate(firstOfJstMonth(anchor))).toBe("2026-07-01");
  });

  it("moves forward/backward across a year boundary", () => {
    const dec = new Date("2026-12-15T00:00:00+09:00");
    expect(formatJstDate(firstOfJstMonth(dec, 1))).toBe("2027-01-01");
    const jan = new Date("2027-01-15T00:00:00+09:00");
    expect(formatJstDate(firstOfJstMonth(jan, -1))).toBe("2026-12-01");
  });
});

describe("getMonthGrid", () => {
  it("returns 42 cells starting on Sunday for a mid-month anchor", () => {
    const anchor = new Date("2026-07-21T00:00:00+09:00");
    const grid = getMonthGrid(anchor);
    expect(grid).toHaveLength(42);
    expect(formatJstDate(grid[0])).toBe("2026-06-28"); // Sunday before Wed 2026-07-01
    expect(formatJstDate(grid[3])).toBe("2026-07-01");
    expect(formatJstDate(grid[41])).toBe("2026-08-08");
  });

  it("includes the leap day for a leap-year February", () => {
    const anchor = new Date("2028-02-10T00:00:00+09:00");
    const grid = getMonthGrid(anchor);
    expect(grid.some((d) => formatJstDate(d) === "2028-02-29")).toBe(true);
  });

  it("crosses a year boundary: a December grid's tail includes the following January", () => {
    const anchor = new Date("2026-12-15T00:00:00+09:00");
    const grid = getMonthGrid(anchor);
    expect(formatJstDate(grid[41])).toBe("2027-01-09");
  });

  it("crosses a year boundary: a January grid's head includes the preceding December", () => {
    const anchor = new Date("2027-01-15T00:00:00+09:00");
    const grid = getMonthGrid(anchor);
    expect(formatJstDate(grid[0])).toBe("2026-12-27");
  });
});

describe("getMonthGrid — JST-fixed regardless of runtime TZ", () => {
  let originalTz: string | undefined;

  beforeAll(() => {
    originalTz = process.env.TZ;
    process.env.TZ = "America/New_York";
  });

  afterAll(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it("produces the same JST date keys under a DST-observing runtime TZ", () => {
    const anchor = new Date("2026-07-21T00:00:00+09:00");
    const grid = getMonthGrid(anchor);
    expect(grid).toHaveLength(42);
    expect(formatJstDate(grid[0])).toBe("2026-06-28");
    expect(formatJstDate(grid[3])).toBe("2026-07-01");
    expect(formatJstDate(grid[41])).toBe("2026-08-08");
  });
});

describe("JST display helpers", () => {
  const instant = new Date("2026-07-23T15:30:00.000Z");

  it("shifts strings and Date instances to a JST wall-clock Date", () => {
    expect(toJstDate(instant).toISOString()).toBe(
      "2026-07-24T00:30:00.000Z",
    );
    expect(toJstDate("2026-07-23T15:30:00.000Z").toISOString()).toBe(
      "2026-07-24T00:30:00.000Z",
    );
  });

  it("formats JST time, short date, and weekday", () => {
    expect(formatTime(instant.toISOString())).toBe("00:30");
    expect(formatDateDisplay(instant)).toBe("7月24日 (金)");
    expect(jstWeekday(instant)).toBe(5);
  });

  it("compares calendar days in JST across UTC boundaries", () => {
    const start = new Date("2026-07-23T15:00:00.000Z");
    const sameDayEnd = new Date("2026-07-24T14:59:59.000Z");
    const nextDay = new Date("2026-07-24T15:00:00.000Z");

    expect(isSameDay(start, sameDayEnd)).toBe(true);
    expect(isSameDay(start, nextDay)).toBe(false);
  });
});

describe("getCardStyle without an explicit day key", () => {
  it("positions a card relative to the supplied visible window", () => {
    expect(
      getCardStyle(
        "2026-07-24T01:00:00.000Z",
        "2026-07-24T01:30:00.000Z",
        9 * 60,
        12 * 60,
      ),
    ).toEqual({
      top: "33.33333333333333%",
      height: "16.666666666666664%",
      minutes: 30,
    });
  });

  it("clips minutes to the visible window (60-min reservation, 30 visible)", () => {
    // 10:30–11:30 JST の予約を 9:00–11:00 窓で描画 — minutes は総施術時間 60 では
    // なく clip 後の 30 を返す (ReservationCard の行出し分けの回帰ガード)。
    expect(
      getCardStyle(
        "2026-07-24T01:30:00.000Z",
        "2026-07-24T02:30:00.000Z",
        9 * 60,
        11 * 60,
      ),
    ).toEqual({
      top: "75%",
      height: "25%",
      minutes: 30,
    });
  });

  it("treats an end at midnight as 24:00", () => {
    expect(
      getCardStyle(
        "2026-07-24T14:00:00.000Z",
        "2026-07-24T15:00:00.000Z",
        0,
        24 * 60,
      ),
    ).toEqual({
      top: "95.83333333333334%",
      height: "4.166666666666666%",
      minutes: 60,
    });
  });

  it("returns null when clipping leaves no visible duration", () => {
    expect(
      getCardStyle(
        "2026-07-24T11:00:00.000Z",
        "2026-07-24T12:00:00.000Z",
        9 * 60,
        19 * 60,
      ),
    ).toBeNull();
  });

  it("keeps very short cards at a visible one-percent height", () => {
    expect(
      getCardStyle(
        "2026-07-24T01:00:00.000Z",
        "2026-07-24T01:01:00.000Z",
        0,
        24 * 60,
      )?.height,
    ).toBe("1%");
  });
});

describe("reservation status presentation", () => {
  it("returns configured colors and labels for known statuses", () => {
    expect(statusColor("confirmed")).toContain("bg-blue-100");
    expect(statusLabel("confirmed")).toBe("確定");
    expect(statusColor("rejected")).toContain("bg-orange-100");
    expect(statusLabel("rejected")).toBe("却下");
  });

  it("falls back safely for future statuses", () => {
    expect(statusColor("future_status")).toBe(
      "bg-muted border-border text-foreground",
    );
    expect(statusLabel("future_status")).toBe("future_status");
  });
});

describe("currentTimePosition", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the percentage for a time inside the visible window", () => {
    vi.setSystemTime(new Date("2026-07-24T03:00:00.000Z")); // 12:00 JST
    expect(currentTimePosition(9 * 60, 15 * 60)).toBe(50);
  });

  it("returns null before or after the visible window", () => {
    vi.setSystemTime(new Date("2026-07-23T23:00:00.000Z")); // 08:00 JST
    expect(currentTimePosition(9 * 60, 19 * 60)).toBeNull();

    vi.setSystemTime(new Date("2026-07-24T11:00:00.000Z")); // 20:00 JST
    expect(currentTimePosition(9 * 60, 19 * 60)).toBeNull();
  });
});

describe("visitStatusLabel", () => {
  it("来店実績のステータスを日本語にする", () => {
    expect(visitStatusLabel("valid")).toBe("有効");
    expect(visitStatusLabel("voided")).toBe("無効");
  });
});
