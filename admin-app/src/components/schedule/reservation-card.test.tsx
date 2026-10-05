import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Reservation } from "@/types/api";
import { ReservationCard } from "./reservation-card";

const START = "2026-08-01T10:00:00+09:00";
const reservation = (minutes: number, status = "confirmed"): Reservation =>
  ({
    id: "rsv-1",
    status,
    customerDisplayName: "田中 美咲",
    serviceName: "カット",
    startAt: START,
    endAt: new Date(Date.parse(START) + minutes * 60000).toISOString(),
    cancellationFeeUnpaidAt: null,
  }) as unknown as Reservation;

// minutes は getCardStyle が返す clip 済み分数 (行出し分けの基準)。
const style = (minutes: number) => ({ top: "0%", height: "10%", minutes });

describe("ReservationCard", () => {
  it.each([
    { status: "confirmed", label: "確定" },
    { status: "completed", label: "完了" },
  ])("$labelを色以外の文字と読み上げ名で伝える", ({ status, label }) => {
    render(<ReservationCard reservation={reservation(45, status)} style={style(45)} slotPx={40} onClick={() => {}} />);
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByRole("button").getAttribute("aria-label")).toContain(label);
    expect(screen.getByText("田中 美咲")).toBeTruthy();
  });
  it("標準密度 (slotPx=40) の30分予約は顧客名・メニュー・時刻を全て表示する", () => {
    render(
      <ReservationCard reservation={reservation(30)} style={style(30)} slotPx={40} onClick={() => {}} />,
    );
    expect(screen.getByText("田中 美咲")).toBeTruthy();
    expect(screen.getByText("カット")).toBeTruthy();
    expect(screen.getByText("10:00–10:30")).toBeTruthy();
  });

  it("compact (slotPx=24) の30分予約 (48px) は時刻行を出さない — 途中で切れる行を作らない", () => {
    render(
      <ReservationCard reservation={reservation(30)} style={style(30)} slotPx={24} onClick={() => {}} />,
    );
    expect(screen.getByText("田中 美咲")).toBeTruthy();
    expect(screen.getByText("カット")).toBeTruthy();
    expect(screen.queryByText("10:00–10:30")).toBeNull();
  });

  it("compact の15分予約 (24px) は顧客名と状態を1行で表示する", () => {
    render(
      <ReservationCard reservation={reservation(15)} style={style(15)} slotPx={24} onClick={() => {}} />,
    );
    expect(screen.getByText("田中 美咲")).toBeTruthy();
    expect(screen.queryByText("カット")).toBeNull();
    expect(screen.getByText("確定")).toBeTruthy();
    expect(screen.queryByText("10:00–10:15")).toBeNull();
    // 視覚行を落としても、隠した情報の到達手段は読み上げ名に残す
    // (PR#350「title= 依存はタッチだと情報が読めない」と同じ理由)。
    expect(screen.getByRole("button").getAttribute("aria-label")).toBe(
      "確定 田中 美咲 カット 10:00–10:15",
    );
    // スロット未満の高さでも氏名行が clip されない下限。text-xs 1 行 16px +
    // py 4px + border 2px = 22px (実ブラウザ実測で確認。20px だと clip する)。
    expect(screen.getByRole("button").style.minHeight).toBe("22px");
  });

  it.each([
    { status: "pending_approval", label: "待ち", fullLabel: "承認待ち" },
    { status: "completed", label: "完了", fullLabel: "完了" },
  ])("15分にclipされた$fullLabelも色だけに頼らず表示する", ({ status, label, fullLabel }) => {
    render(<ReservationCard
      reservation={{ ...reservation(60, status), cancellationFeeUnpaidAt: START }}
      style={style(15)} slotPx={24} onClick={() => {}}
    />);
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByText(label).parentElement).toBe(screen.getByText("田中 美咲").parentElement);
    expect(screen.getByText("料未")).toBeTruthy();
    expect(screen.queryByText("⚠️")).toBeNull();
    expect(screen.queryByText("カット")).toBeNull();
    expect(screen.getByRole("button").getAttribute("aria-label")).toContain(fullLabel);
  });

  it("表示窓で clip された予約は clip 後の高さで行を間引く (60分予約が30分分しか描画されない場合)", () => {
    render(
      <ReservationCard reservation={reservation(60)} style={style(30)} slotPx={24} onClick={() => {}} />,
    );
    expect(screen.getByText("田中 美咲")).toBeTruthy();
    expect(screen.getByText("カット")).toBeTruthy();
    // 総施術時間 (60分=96px) 基準なら時刻行が出てしまうが、clip 済み 48px では出さない。
    expect(screen.queryByText("10:00–11:00")).toBeNull();
  });

  it("クリックで onClick に予約 id が渡り、承認待ちは警告マーカーを出す", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <ReservationCard
        reservation={{ ...reservation(30, "pending_approval"), cancellationFeeUnpaidAt: START }}
        style={style(30)}
        slotPx={40}
        onClick={onClick}
      />,
    );
    expect(screen.getByText("⚠️")).toBeTruthy();
    expect(screen.getByText("料未")).toBeTruthy();
    expect(screen.getByText("田中 美咲").parentElement).not.toBe(screen.getByText("承認待ち").parentElement);
    expect(screen.getByText("承認待ち").parentElement).toBe(screen.getByText("カット").parentElement);
    expect(screen.getByRole("button").getAttribute("aria-label")).toBe("承認待ち 田中 美咲 カット 10:00–10:30 キャンセル料未納");
    await user.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledWith("rsv-1");
  });
});
