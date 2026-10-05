import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatFullJstDate } from "@/lib/timeline";
import { MiniCalendar } from "./mini-calendar";

beforeEach(() => {
  // 「今日」ハイライトが実日付で陳腐化しないよう Date を固定する
  // (schedule.test.tsx と同じ方式)。2026-07-24 10:00 JST。
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-07-24T01:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

// 今日 (7/24) と別日を選択日にする — 同日だと aria-current (今日) と
// aria-pressed (選択) の取り違え回帰を検出できない。
const selected = new Date("2026-07-10T01:00:00Z");

describe("MiniCalendar", () => {
  it("選択月のグリッドと曜日見出しを描画し、今日・選択日・月外日を区別する", () => {
    render(<MiniCalendar selected={selected} onSelect={() => {}} />);

    expect(screen.getByText("2026年7月")).toBeTruthy();
    for (const w of ["日", "月", "火", "水", "木", "金", "土"]) {
      expect(screen.getByText(w)).toBeTruthy();
    }

    const today = screen.getByRole("button", { name: "2026年7月24日 (金)" });
    expect(today.getAttribute("aria-current")).toBe("date");
    expect(today.getAttribute("aria-pressed")).toBe("false");

    const selectedDay = screen.getByRole("button", { name: "2026年7月10日 (金)" });
    expect(selectedDay.getAttribute("aria-current")).toBeNull();
    expect(selectedDay.getAttribute("aria-pressed")).toBe("true");

    // 2026-07-01 は水曜なので、グリッド先頭に前月 6/28(日)〜6/30 が入る。
    // 月外日は弱調 (text-muted-foreground) だがタップ可能な実ボタン。
    const outside = screen.getByRole("button", { name: "2026年6月28日 (日)" });
    expect(outside.className).toContain("text-muted-foreground");
    expect(selectedDay.className).not.toContain("text-muted-foreground");
  });

  it("日付クリックで onSelect にその日付が渡る (月外日も含む)", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<MiniCalendar selected={selected} onSelect={onSelect} />);

    await user.click(screen.getByRole("button", { name: "2026年7月15日 (水)" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(formatFullJstDate(onSelect.mock.calls[0][0])).toBe("2026年7月15日 (水)");

    await user.click(screen.getByRole("button", { name: "2026年6月28日 (日)" }));
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(formatFullJstDate(onSelect.mock.calls[1][0])).toBe("2026年6月28日 (日)");
  });

  it("前の月・次の月ナビで表示月が切り替わる", async () => {
    const user = userEvent.setup();
    render(<MiniCalendar selected={selected} onSelect={() => {}} />);

    await user.click(screen.getByRole("button", { name: "前の月" }));
    expect(screen.getByText("2026年6月")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "次の月" }));
    await user.click(screen.getByRole("button", { name: "次の月" }));
    expect(screen.getByText("2026年8月")).toBeTruthy();
  });
});
