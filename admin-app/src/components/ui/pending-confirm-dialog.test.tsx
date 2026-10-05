import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PendingConfirmDialog } from "./pending-confirm-dialog";

describe("PendingConfirmDialog", () => {
  it("確認操作を呼び、処理中は操作を無効化する", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <PendingConfirmDialog
        open
        pending={false}
        title="確認"
        description="実行しますか"
        confirmLabel="実行"
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />,
    );

    await user.click(screen.getByRole("button", { name: "実行" }));
    expect(onConfirm).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);

    rerender(
      <PendingConfirmDialog
        open
        pending
        title="確認"
        description="実行しますか"
        confirmLabel="実行"
        pendingLabel="送信中..."
        destructive
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />,
    );
    expect((screen.getByRole("button", { name: "送信中..." }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "キャンセル" }) as HTMLButtonElement).disabled).toBe(true);
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledTimes(1);
  });
});
