import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReservationListCard } from "./reservation-list-card";

const reservation = {
  id: "reservation-1",
  status: "confirmed",
  startAt: "2026-07-24T23:45:00+09:00",
  endAt: "2026-07-25T00:30:00+09:00",
  customerDisplayName: "山田 花子",
  serviceName: "カット / カラー",
  storeName: "渋谷店",
  resourceName: "担当 佐藤",
  cancellationFeeUnpaidAt: "2026-07-24T23:50:00+09:00",
};

describe("ReservationListCard", () => {
  it("深夜を跨ぐ予約の終了日と担当・状態を読み、詳細を開ける", () => {
    const onDetails = vi.fn();
    render(<ReservationListCard reservation={reservation} onDetails={onDetails} />);

    const card = screen.getByRole("article");
    expect(card.textContent).toContain("23:45–翌日 00:30");
    expect(card.textContent).toContain("山田 花子");
    expect(card.textContent).toContain("カット / カラー");
    expect(card.textContent).toContain("渋谷店 · 担当 佐藤");
    expect(card.textContent).toContain("確定");
    expect(card.textContent).toContain("キャンセル料未納");
    fireEvent.click(screen.getByRole("button", { name: "詳細" }));
    expect(onDetails).toHaveBeenCalledWith("reservation-1");
  });

  it("予約管理から顧客導線と既存操作ボタンを渡せる", () => {
    const onCustomerClick = vi.fn();
    const onApprove = vi.fn();
    render(
      <ReservationListCard
        reservation={{ ...reservation, status: "pending_approval" }}
        showDate
        onDetails={() => {}}
        onCustomerClick={onCustomerClick}
        actions={<button type="button" onClick={onApprove}>承認</button>}
      />,
    );

    expect(screen.getByRole("article").textContent).toContain("7月24日");
    fireEvent.click(screen.getByRole("button", { name: "山田 花子の顧客情報を開く" }));
    fireEvent.click(screen.getByRole("button", { name: "承認" }));
    expect(onCustomerClick).toHaveBeenCalledOnce();
    expect(onApprove).toHaveBeenCalledOnce();
  });
});
