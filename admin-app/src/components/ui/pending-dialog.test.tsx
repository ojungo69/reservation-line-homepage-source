import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    children,
    onOpenChange,
  }: {
    children: ReactNode;
    onOpenChange: (open: boolean) => void;
  }) => (
    <>
      <button onClick={() => onOpenChange(false)}>close</button>
      {children}
    </>
  ),
  DialogContent: ({
    children,
    onEscapeKeyDown,
    onInteractOutside,
  }: {
    children: ReactNode;
    onEscapeKeyDown: (event: { preventDefault: () => void }) => void;
    onInteractOutside: (event: { preventDefault: () => void }) => void;
  }) => (
    <div>
      {children}
      <button onClick={() => onEscapeKeyDown({ preventDefault: vi.fn() })}>escape</button>
      <button onClick={() => onInteractOutside({ preventDefault: vi.fn() })}>outside</button>
    </div>
  ),
}));

import { PendingDialog } from "./pending-dialog";

describe("PendingDialog", () => {
  it("待機中だけ閉じる操作を遮断する", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { rerender } = render(
      <PendingDialog open pending={false} onClose={onClose}>
        content
      </PendingDialog>,
    );

    await user.click(screen.getByRole("button", { name: "close" }));
    await user.click(screen.getByRole("button", { name: "escape" }));
    await user.click(screen.getByRole("button", { name: "outside" }));
    expect(onClose).toHaveBeenCalledOnce();

    rerender(
      <PendingDialog open pending onClose={onClose}>
        content
      </PendingDialog>,
    );
    await user.click(screen.getByRole("button", { name: "close" }));
    await user.click(screen.getByRole("button", { name: "escape" }));
    await user.click(screen.getByRole("button", { name: "outside" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
