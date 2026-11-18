import { describe, expect, it } from "vitest";
import { readScheduleContext } from "./schedule-context";

const value = {
  scope: "owner:store-1", date: "2026-12-07T01:00:00.000Z", viewMode: "week",
  mobileView: "agenda", reservationId: "reservation-1", mainScroll: 20,
  scheduleScroll: 350, scheduleScrollLeft: 80,
};

describe("カレンダーの履歴状態", () => {
  it("同じログイン・店舗の有効な状態のみ復元する", () => {
    expect(readScheduleContext({ scheduleContext: value }, value.scope)).toEqual(value);
    expect(readScheduleContext({ scheduleContext: value }, "other-store")).toBeNull();
  });

  it.each([
    { date: "invalid" }, { reservationId: "../settings" }, { scheduleScroll: Infinity },
    { mainScroll: -1 }, { viewMode: "unknown" },
  ])("不正な履歴状態を破棄する: %s", (invalid) => {
    expect(readScheduleContext({ scheduleContext: { ...value, ...invalid } }, value.scope)).toBeNull();
  });
});
