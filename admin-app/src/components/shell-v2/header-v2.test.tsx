import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("./store-switch-v2", () => ({ StoreSwitchV2: () => <span>店舗の切り替え</span> }));

import { HeaderV2 } from "./header-v2";

describe("HeaderV2", () => {
  it("メニューのボタンで引き出しを開き、開閉の状態を伝える", async () => {
    const onMenuToggle = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<HeaderV2 showMenuButton menuOpen={false} onMenuToggle={onMenuToggle} onOpenPalette={vi.fn()} />);
    const button = screen.getByRole("button", { name: "メニュー" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await user.click(button);
    expect(onMenuToggle).toHaveBeenCalledTimes(1);
    rerender(<HeaderV2 showMenuButton menuOpen onMenuToggle={onMenuToggle} onOpenPalette={vi.fn()} />);
    expect(screen.getByRole("button", { name: "メニュー" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("ページ移動のボタンでページ移動を開く", async () => {
    const onOpenPalette = vi.fn();
    const user = userEvent.setup();
    render(<HeaderV2 showMenuButton menuOpen={false} onMenuToggle={vi.fn()} onOpenPalette={onOpenPalette} />);
    const button = screen.getByRole("button", { name: "ページ移動 (Cmd/Ctrl+K)" });
    expect(button.getAttribute("aria-keyshortcuts")).toBe("Meta+K Control+K");
    await user.click(button);
    expect(onOpenPalette).toHaveBeenCalledTimes(1);
    expect(onOpenPalette).toHaveBeenCalledWith(button);
  });

  it("サイドバーが常に出ている間は、メニューのボタンを出さない", () => {
    render(<HeaderV2 showMenuButton={false} menuOpen={false} onMenuToggle={vi.fn()} onOpenPalette={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "メニュー" })).toBeNull();
    expect(screen.getByRole("button", { name: "ページ移動 (Cmd/Ctrl+K)" })).toBeTruthy();
  });

  it("店舗の切り替えを出す", () => {
    render(<HeaderV2 showMenuButton menuOpen={false} onMenuToggle={vi.fn()} onOpenPalette={vi.fn()} />);
    expect(screen.getByText("店舗の切り替え")).toBeTruthy();
  });
});
