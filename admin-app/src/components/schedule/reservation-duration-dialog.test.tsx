import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// use-reservations は React Query に依存するため、コンポーネントが使う
// useRescheduleReservation だけを差し替える。ネットワークには触れない。
const reschedule = vi.fn();
let isPending = false;
vi.mock("@/hooks/use-reservations", () => ({
  useRescheduleReservation: () => ({ mutate: reschedule, isPending }),
}));

import { ReservationDurationDialog } from "./reservation-duration-dialog";

// 09:00–10:00 = 60分占有 → 現在の施術時間 55分。
const reservation = {
  id: "res-1",
  startAt: "2026-09-01T09:00:00+09:00",
  endAt: "2026-09-01T10:00:00+09:00",
  resourceName: "担当A",
};

beforeEach(() => {
  reschedule.mockReset();
  isPending = false;
});

describe("ReservationDurationDialog", () => {
  it("現在の施術時間を初期値に表示し、有効入力で終了予定プレビューを更新する", () => {
    render(<ReservationDurationDialog reservation={reservation} onClose={() => {}} />);

    const input = screen.getByLabelText("新しい施術時間（分）") as HTMLInputElement;
    // occupancyToTreatment(60分) = 55 が初期値。
    expect(input.value).toBe("55");

    // 90分に伸ばすと 終了 = 開始 + 90 + 5分バッファ = 10:35。
    fireEvent.change(input, { target: { value: "90" } });
    expect(screen.getByText("終了予定 09:00 → 10:35")).toBeTruthy();
  });

  it("現在と同じ長さの送信を拒否し、reschedule を呼ばない", async () => {
    const user = userEvent.setup();
    render(<ReservationDurationDialog reservation={reservation} onClose={() => {}} />);

    // 初期値 55分のまま送信 → 現在と同じなので弾く。
    await user.click(screen.getByRole("button", { name: "施術時間を変更" }));

    expect(screen.getByRole("alert").textContent).toContain(
      "施術時間が現在と同じです",
    );
    expect(reschedule).not.toHaveBeenCalled();
  });

  it("刻み外の入力を拒否し、reschedule を呼ばない", async () => {
    const user = userEvent.setup();
    render(<ReservationDurationDialog reservation={reservation} onClose={() => {}} />);

    const input = screen.getByLabelText("新しい施術時間（分）") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "62" } }); // 5分刻みでない
    await user.click(screen.getByRole("button", { name: "施術時間を変更" }));

    expect(screen.getByRole("alert").textContent).toContain("5分刻み");
    expect(reschedule).not.toHaveBeenCalled();
  });

  it("有効な変更を開始時刻そのままで reschedule に渡す", async () => {
    const user = userEvent.setup();
    render(<ReservationDurationDialog reservation={reservation} onClose={() => {}} />);

    const input = screen.getByLabelText("新しい施術時間（分）") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "90" } });
    await user.click(screen.getByRole("button", { name: "施術時間を変更" }));

    expect(reschedule).toHaveBeenCalledTimes(1);
    expect(reschedule.mock.calls[0][0]).toMatchObject({
      reservationId: "res-1",
      startAt: "2026-09-01T09:00:00+09:00",
      treatmentMinutes: 90,
    });
  });

  it("送信中は操作ボタンを無効化し「変更中...」を表示する", () => {
    isPending = true;
    render(<ReservationDurationDialog reservation={reservation} onClose={() => {}} />);

    const submit = screen.getByRole("button", { name: "変更中..." }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "キャンセル" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
