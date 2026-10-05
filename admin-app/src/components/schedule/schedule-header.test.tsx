import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ScheduleHeader } from "./schedule-header";

const baseProps = {
  date: new Date("2026-07-24T10:00:00+09:00"),
  onDateChange: () => {},
  viewMode: "day" as const,
  onViewModeChange: () => {},
  pendingCount: 0,
  confirmedCount: 1,
  completedCount: 0,
  onCreateClick: () => {},
};

describe("ScheduleHeader density toggle", () => {
  it("density props が渡された時だけトグルを表示する (週表示 = 未配線で非表示)", () => {
    const { rerender } = render(<ScheduleHeader {...baseProps} />);
    expect(screen.queryByRole("radiogroup", { name: "タイムラインの表示密度" })).toBeNull();

    rerender(
      <ScheduleHeader {...baseProps} density="standard" onDensityChange={() => {}} />,
    );
    expect(screen.getByRole("radiogroup", { name: "タイムラインの表示密度" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "標準" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "コンパクト" })).toBeTruthy();
  });

  it("切替で onDensityChange が新しい密度で発火する", async () => {
    const user = userEvent.setup();
    const onDensityChange = vi.fn();
    render(
      <ScheduleHeader {...baseProps} density="standard" onDensityChange={onDensityChange} />,
    );

    await user.click(screen.getByRole("radio", { name: "コンパクト" }));
    expect(onDensityChange).toHaveBeenCalledWith("compact");
  });
});

describe("ScheduleHeader mobile view", () => {
  it("スマホだけ予定一覧と時間軸を切り替え、一覧では密度操作を出さない", async () => {
    const onMobileViewChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <ScheduleHeader {...baseProps} isNarrow mobileView="agenda" onMobileViewChange={onMobileViewChange} density="compact" onDensityChange={() => {}} />,
    );
    expect(screen.getByRole("radiogroup", { name: "スマホの予定表示" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "予定一覧" })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "週" })).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: "タイムラインの表示密度" })).toBeNull();
    await user.click(screen.getByRole("radio", { name: "時間軸" }));
    expect(onMobileViewChange).toHaveBeenCalledWith("timeline");

    rerender(
      <ScheduleHeader {...baseProps} isNarrow mobileView="timeline" onMobileViewChange={onMobileViewChange} density="compact" onDensityChange={() => {}} />,
    );
    expect(screen.getByRole("radiogroup", { name: "タイムラインの表示密度" })).toBeTruthy();
  });
});
