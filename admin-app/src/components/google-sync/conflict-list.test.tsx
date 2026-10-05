import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncConflict, SyncConflictType } from "@/types/api";

const actionMutation = { mutate: vi.fn(), isPending: false };

vi.mock("@/hooks/use-sync-status", () => ({
  useConflictAction: () => actionMutation,
}));

import { ConflictList } from "./conflict-list";

const conflict = (id: string, conflictType: SyncConflictType): SyncConflict => ({
  id,
  storeId: "store-1",
  calendarId: "calendar-1",
  googleEventId: `event-${id}`,
  reservationId: null,
  externalBlockId: null,
  conflictType,
  summary: `${id} の要約`,
  googleSafeSnapshotJson: "{}",
  d1SafeSnapshotJson: null,
  resolutionStatus: "open",
  createdAt: "2026-07-24T10:30:00+09:00",
  resolvedAt: null,
  resolvedBy: null,
  overlappingReservations: [{
    id: "reservation-1",
    customerDisplayName: "予約 花子",
    startAt: "2026-07-24T10:00:00+09:00",
    endAt: "2026-07-24T11:00:00+09:00",
    status: "confirmed",
  }],
});

beforeEach(() => {
  actionMutation.mutate.mockReset();
  actionMutation.isPending = false;
});

describe("ConflictList", () => {
  it("競合がなければ案内を表示する", () => {
    render(<ConflictList conflicts={[]} />);
    expect(screen.getByText("未解決の競合はありません。")).toBeTruthy();
  });

  it("競合種別ラベル、重複予約、各種別の操作を表示する", () => {
    render(
      <ConflictList
        conflicts={[
          conflict("slot", "external_block_slot_conflict"),
          conflict("deleted", "external_block_event_deleted"),
          conflict("reservation", "reservation_event_deleted"),
          conflict("all-day", "google_all_day_event"),
        ]}
      />,
    );

    expect(screen.getByRole("heading", { name: "競合一覧 (4)" })).toBeTruthy();
    expect(screen.getByText("外部ブロック競合")).toBeTruthy();
    expect(screen.getByText("外部ブロック削除")).toBeTruthy();
    expect(screen.getByText("Google側で予約削除")).toBeTruthy();
    expect(screen.getByText("終日イベント候補")).toBeTruthy();
    expect(screen.getAllByText("重複する予約:")).toHaveLength(4);
    expect(screen.getAllByText(/予約 花子:/)).toHaveLength(4);
    expect(screen.getByRole("button", { name: "解決（ブロック取消）" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "キャンセル承認" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "休業日承認" })).toBeTruthy();
  });

  it("任意メモの操作を実行すると成功時だけダイアログを閉じる", async () => {
    const user = userEvent.setup();
    actionMutation.mutate.mockImplementation((_variables, options) => options.onSuccess());
    render(<ConflictList conflicts={[conflict("slot", "external_block_slot_conflict")]} />);

    await user.click(screen.getByRole("button", { name: "手動解決" }));
    expect(screen.getByRole("heading", { name: "手動解決" })).toBeTruthy();
    const input = screen.getByPlaceholderText("メモを入力（任意）");
    await user.type(input, "確認済み");
    await user.click(screen.getByRole("button", { name: "実行" }));

    expect(actionMutation.mutate).toHaveBeenCalledWith(
      {
        path: "conflicts/slot/manual-resolve",
        body: expect.objectContaining({ note: "確認済み", idempotencyKey: expect.any(String) }),
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
    expect(screen.queryByRole("heading", { name: "手動解決" })).toBeNull();
  });

  it("理由必須の操作は空入力を無効化し、失敗時は理由を残して再試行できる", async () => {
    const user = userEvent.setup();
    render(<ConflictList conflicts={[conflict("reservation", "reservation_event_deleted")]} />);

    await user.click(screen.getByRole("button", { name: "キャンセル承認" }));
    const execute = screen.getByRole("button", { name: "実行" }) as HTMLButtonElement;
    expect(execute.disabled).toBe(true);
    const reason = screen.getByPlaceholderText("理由を入力");
    await user.type(reason, "お客様確認済み");
    expect(execute.disabled).toBe(false);
    await user.click(execute);

    expect(actionMutation.mutate).toHaveBeenCalledWith(
      {
        path: "conflicts/reservation/approve-cancel",
        body: expect.objectContaining({ reason: "お客様確認済み", idempotencyKey: expect.any(String) }),
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
    expect(screen.getByRole("heading", { name: "キャンセル承認" })).toBeTruthy();
    expect((reason as HTMLInputElement).value).toBe("お客様確認済み");

    const firstKey = actionMutation.mutate.mock.calls[0]?.[0].body.idempotencyKey;
    await user.click(execute);
    expect(actionMutation.mutate).toHaveBeenCalledTimes(2);
    expect(actionMutation.mutate.mock.calls[1]?.[0].body.idempotencyKey).toBe(firstKey);
  });
});
