import { act, render, screen } from "@testing-library/react";
import { afterAll, afterEach, assert, beforeAll, describe, expect, it, vi } from "vitest";
import type { Store } from "@/types/api";
import { TimelineGrid } from "./timeline-grid";

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterAll(() => vi.unstubAllGlobals());

const props = {
  date: new Date("2026-09-29T10:00:00+09:00"),
  resources: [
    { id: "resource-1", storeId: "store-1", name: "同じ担当者", resourceType: "staff_calendar", active: true },
    { id: "resource-2", storeId: "store-2", name: "同じ担当者", resourceType: "staff_calendar", active: true },
  ],
  stores: [{ id: "store-1", name: "渋谷店" }, { id: "store-2", name: "新宿店" }] as Store[],
  reservations: [], externalBlocks: [], businessHours: [], storeId: null,
  isLoading: false, slotPx: 40, onReservationClick: vi.fn(), onSlotClick: vi.fn(),
};

afterEach(() => vi.useRealTimers());

describe("TimelineGridの店舗表示", () => {
  it.each([true, false])("取得完了後の開店位置から履歴のスクロールを復元できる (初期読み込み中: %s)", (initiallyLoading) => {
    const openingPositions: number[] = [];
    const onReady = () => {
      const viewport = document.querySelector<HTMLElement>("[data-schedule-scroll] [data-radix-scroll-area-viewport]");
      assert(viewport);
      openingPositions.push(viewport.scrollTop);
      viewport.scrollTop = 1800;
      viewport.scrollLeft = 120;
    };
    const { container, rerender } = render(<TimelineGrid {...props} isLoading={initiallyLoading} onReady={onReady} />);
    if (initiallyLoading) {
      expect(openingPositions).toEqual([]);
      expect(container.querySelector("[data-schedule-scroll]")).toBeNull();
      rerender(<TimelineGrid {...props} onReady={onReady} />);
    }

    const viewport = container.querySelector<HTMLElement>("[data-schedule-scroll] [data-radix-scroll-area-viewport]");
    assert(viewport);
    expect(openingPositions).toEqual([1430]);
    expect(viewport.scrollTop).toBe(1800);
    expect(viewport.scrollLeft).toBe(120);
    rerender(<TimelineGrid {...props} onReady={onReady} />);
    expect(openingPositions).toEqual([1430]);
    expect(viewport.scrollTop).toBe(1800);
    expect(viewport.scrollLeft).toBe(120);
  });

  it("全店舗では列と空き枠の名前に所属店舗を出し、単店では重複表示しない", () => {
    const { rerender } = render(<TimelineGrid {...props} />);
    expect(screen.getByText("渋谷店 · 同じ担当者")).toBeTruthy();
    expect(screen.getByText("新宿店 · 同じ担当者")).toBeTruthy();
    expect(screen.getByRole("button", { name: "渋谷店 · 同じ担当者 09:00 に予約作成" })).toBeTruthy();
    rerender(<TimelineGrid {...props} storeId="store-1" />);
    expect(screen.getByText("同じ担当者")).toBeTruthy();
    expect(screen.queryByText(/新宿店/)).toBeNull();
    expect(screen.queryByText("渋谷店 · 同じ担当者")).toBeNull();
  });

  it.each([
    ["2026-11-16T00:00:00+09:00", true, false],
    ["2026-11-17T00:00:00+09:00", false, true],
  ])("JST深夜0時をまたいだ表示日 %s の現在時刻線を更新する", (displayDate, before, after) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-16T23:59:00+09:00"));
    const { container, unmount } = render(<TimelineGrid {...props} date={new Date(displayDate)} />);
    const line = () => container.querySelector<HTMLElement>(".pointer-events-none > .border-t-2");
    expect(line() !== null).toBe(before);
    act(() => vi.advanceTimersByTime(61_000));
    expect(line() !== null).toBe(after);
    if (after) expect(line()?.style.top).toBe("0%");
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
