import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { getTimeSlots } from "@/lib/timeline";
import { TimelineColumn } from "./timeline-column";

const props = {
  resourceId: "resource-1", resourceName: "担当者1", reservations: [], externalBlocks: [],
  slots: getTimeSlots([], 2, null), slotPx: 40, dayStartMinutes: 0, dayEndMinutes: 1440,
  dayDateKey: "2026-09-29", onReservationClick: vi.fn(), onSlotClick: vi.fn(),
};
const slot = (resource: number, time: string) => screen.getByRole("button", { name: `担当者${resource} ${time} に予約作成` });

describe("TimelineColumn keyboard", () => {
  it("日付・店舗の列・営業時間が変わったときだけTab入口を更新する", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<TimelineColumn {...props} />);
    await user.tab();
    await user.keyboard("{ArrowDown}");
    expect(slot(1, "09:15").tabIndex).toBe(0);
    rerender(<TimelineColumn {...props} slots={[...props.slots]} />);
    expect(slot(1, "09:15").tabIndex).toBe(0);
    rerender(<TimelineColumn {...props} initialFocusMinutes={11 * 60} />);
    expect(slot(1, "11:00").tabIndex).toBe(0);
    await user.click(slot(1, "11:15"));
    rerender(<TimelineColumn {...props} initialFocusMinutes={11 * 60} dayDateKey="2026-09-30" />);
    expect(slot(1, "11:00").tabIndex).toBe(0);
    await user.click(slot(1, "11:15"));
    rerender(<TimelineColumn {...props} initialFocusMinutes={11 * 60} dayDateKey="2026-09-30" resourceName="別店舗 · 担当者2" />);
    expect(screen.getByRole("button", { name: "別店舗 · 担当者2 11:00 に予約作成" }).tabIndex).toBe(0);
  });

  it("15分の最終枠より遅い開店時刻では00:00でなく最終枠を入口にする", async () => {
    render(<TimelineColumn {...props} initialFocusMinutes={23 * 60 + 50} />);
    await userEvent.setup().tab();
    expect(document.activeElement).toBe(slot(1, "23:45"));
  });
  it("96枠を1つのTab先にし、上下/Home/EndとEnter/Spaceで操作する", async () => {
    const user = userEvent.setup();
    const onSlotClick = vi.fn();
    render(<><TimelineColumn {...props} onSlotClick={onSlotClick} /><button>次の操作</button></>);
    await user.tab();
    expect(document.activeElement).toBe(slot(1, "09:00"));
    expect(screen.getByRole("button", {
      name: "担当者1 09:00 に予約作成",
      description: "上下矢印で時刻、左右矢印で担当者を移動します。Home/Endで一日の端へ、Enter/Spaceで予約作成へ進みます。",
    })).toBe(slot(1, "09:00"));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(slot(1, "09:15"));
    await user.keyboard("{Enter}");
    expect(onSlotClick).toHaveBeenCalledWith("resource-1", 555);
    await user.keyboard("{ArrowUp}{Home}");
    expect(document.activeElement).toBe(slot(1, "00:00"));
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(slot(1, "23:45"));
    await user.keyboard(" ");
    expect(onSlotClick).toHaveBeenCalledTimes(2);
    expect(onSlotClick).toHaveBeenLastCalledWith("resource-1", 1425);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "次の操作" }));
  });

  it("左右矢印で同じ時刻の隣のリソースへ移動する", async () => {
    const user = userEvent.setup();
    render(<div><TimelineColumn {...props} /><TimelineColumn {...props} resourceId="resource-2" resourceName="担当者2" /></div>);
    await user.tab();
    await user.keyboard("{ArrowRight}{ArrowDown}");
    expect(document.activeElement).toBe(slot(2, "09:15"));
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(slot(1, "09:15"));
  });
});
