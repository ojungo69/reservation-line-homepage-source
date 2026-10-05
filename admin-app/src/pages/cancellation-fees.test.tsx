import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CancellationFeesPage from "./cancellation-fees";
import { useUnpaidCancellationFees } from "@/hooks/use-cancellation-fees";

const updateCancellationFee = vi.fn();
let isUpdating = false;

vi.mock("@/hooks/use-cancellation-fees", () => ({
  useUnpaidCancellationFees: vi.fn(),
}));

vi.mock("@/hooks/use-reservations", () => ({
  useReservationCancellationFee: () => ({
    mutate: updateCancellationFee,
    isPending: isUpdating,
  }),
}));

const row = {
  id: "reservation-1",
  status: "no_show",
  storeId: "store-1",
  storeName: "京都店",
  serviceNames: "脱毛｜全身脱毛（フォト付き）",
  startAt: "2026-07-20T04:00:00.000Z",
  endAt: "2026-07-20T05:00:00.000Z",
  customerDisplayName: "山田 花子",
  cancellationFeeUnpaidAt: "2026-07-20T05:30:00.000Z",
};

const mockList = (
  value: Partial<{ data: unknown; isPending: boolean; isError: boolean }>,
) => {
  vi.mocked(useUnpaidCancellationFees).mockReturnValue({
    data: undefined,
    isPending: false,
    isError: false,
    ...value,
  } as ReturnType<typeof useUnpaidCancellationFees>);
};

beforeEach(() => {
  updateCancellationFee.mockReset();
  isUpdating = false;
  vi.mocked(useUnpaidCancellationFees).mockReset();
});

describe("CancellationFeesPage", () => {
  it("未納が無いときは空状態を出す", () => {
    mockList({ data: { ok: true, reservations: [], truncated: false } });
    render(<CancellationFeesPage />);
    expect(screen.getByText("未納のキャンセル料はありません")).toBeTruthy();
  });

  it("取得に失敗したらエラーを出す", () => {
    mockList({ isError: true });
    render(<CancellationFeesPage />);
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("未納の行を表示し、確認してから入金済みにする", async () => {
    const user = userEvent.setup();
    mockList({ data: { ok: true, reservations: [row], truncated: false } });
    render(<CancellationFeesPage />);

    expect(screen.getByText("山田 花子")).toBeTruthy();
    expect(screen.getByText("京都店")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "入金済みにする" }));
    // 確認ダイアログを経由してから mutation が走る (誤タップ防止)。
    expect(updateCancellationFee).not.toHaveBeenCalled();

    const dialog = await screen.findByRole("alertdialog");
    await user.click(
      screen.getAllByRole("button", { name: "入金済みにする" }).find((b) => dialog.contains(b))!,
    );
    expect(updateCancellationFee).toHaveBeenCalledWith({
      reservationId: "reservation-1",
      unpaid: false,
    });
  });

  it("上限で切り捨てられたら件数付きで警告する (全件だと誤解させない)", () => {
    mockList({ data: { ok: true, reservations: [row], truncated: true } });
    render(<CancellationFeesPage />);
    const notice = screen.getByRole("status");
    expect(notice.textContent).toContain("1");
    expect(notice.textContent).toContain("のみ表示");
  });

  it("処理中は操作を再送できない", async () => {
    const user = userEvent.setup();
    isUpdating = true;
    mockList({ data: { ok: true, reservations: [row], truncated: false } });
    render(<CancellationFeesPage />);

    const button = screen.getByRole("button", { name: "入金済みにする" });
    expect(button.hasAttribute("disabled")).toBe(true);
    await user.click(button);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(updateCancellationFee).not.toHaveBeenCalled();
  });

  it("来店なし以外のステータスは併記する (取り違え防止)", () => {
    mockList({
      data: { ok: true, reservations: [{ ...row, status: "cancelled_by_admin" }], truncated: false },
    });
    render(<CancellationFeesPage />);
    expect(screen.getByText("管理者キャンセル")).toBeTruthy();
  });
});
