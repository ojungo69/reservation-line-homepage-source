import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Store } from "@/types/api";
import { TimelineGrid } from "./timeline-grid";

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

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

describe("TimelineGridの店舗表示", () => {
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
});
