import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// use-reservations は React Query に依存するため、ダイアログが使う 2 本だけを差し替える。
vi.mock("@/hooks/use-reservations", () => ({
  useRescheduleReservation: () => ({ mutate: vi.fn(), isPending: false }),
  useAvailableSlots: () => ({
    data: { ok: true, slots: [] },
    isFetching: false,
    isError: false,
  }),
}));

import { ReservationRescheduleDialog } from "./reservation-reschedule-dialog";

// resourceName は古い呼び出し側が渡してくる値。画面の文に出ないことを確かめるために残す。
const reservation = {
  id: "res-1",
  storeId: "store-1",
  resourceId: "resource-1",
  resourceName: "担当A",
  startAt: "2026-09-01T09:00:00+09:00",
  endAt: "2026-09-01T10:00:00+09:00",
};

describe("ReservationRescheduleDialog", () => {
  it("題名は「開始時刻を変更」、送信は「この開始時刻に変更」", () => {
    render(<ReservationRescheduleDialog reservation={reservation} onClose={() => {}} />);

    expect(screen.getByRole("heading", { name: "開始時刻を変更" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "この開始時刻に変更" })).toBeTruthy();
  });

  it("説明文と空き枠の見出しに、枠の名前を出さない", () => {
    render(<ReservationRescheduleDialog reservation={reservation} onClose={() => {}} />);

    expect(
      screen.getByText(
        "施術時間はそのままに、開始時刻を移動します。確定済みの予約はお客様に変更が通知されます。",
      ),
    ).toBeTruthy();
    expect(screen.getByText("空き枠")).toBeTruthy();
    expect(screen.queryByText(/担当/)).toBeNull();
  });
});
