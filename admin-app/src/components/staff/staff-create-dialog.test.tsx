import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createStaff = vi.fn();
let createPending = false;

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { role: "system_admin" } }),
}));

vi.mock("@/hooks/use-staff", () => ({
  useStaffCreate: () => ({ mutate: createStaff, isPending: createPending }),
}));

import { StaffCreateDialog } from "./staff-create-dialog";

const stores = [
  { id: "store-1", name: "テスト中央店" },
  { id: "store-2", name: "テスト北店" },
];

beforeEach(() => {
  createStaff.mockReset();
  createPending = false;
});

describe("StaffCreateDialog 店舗の初期選択", () => {
  it("閉じている間に変更された店舗を開いた時点で選択し、作成先に使う", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <StaffCreateDialog open={false} onOpenChange={onOpenChange} stores={stores} defaultStoreId="store-1" />,
    );

    rerender(
      <StaffCreateDialog open={false} onOpenChange={onOpenChange} stores={stores} defaultStoreId="store-2" />,
    );
    rerender(
      <StaffCreateDialog open onOpenChange={onOpenChange} stores={stores} defaultStoreId="store-2" />,
    );

    expect(screen.getByLabelText("店舗").textContent).toContain("テスト北店");
    await user.type(screen.getByLabelText("表示名"), "テスト担当");
    await user.click(screen.getByRole("button", { name: "追加" }));
    expect(createStaff).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: "store-2", displayName: "テスト担当" }),
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("開いた後に店舗が届いたら先頭店舗を選択し、入力中の表示名を保持する", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <StaffCreateDialog open onOpenChange={onOpenChange} stores={[]} defaultStoreId={null} />,
    );

    await user.type(screen.getByLabelText("表示名"), "テスト担当");
    expect((screen.getByRole("button", { name: "追加" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(
      <StaffCreateDialog open onOpenChange={onOpenChange} stores={stores} defaultStoreId={null} />,
    );

    expect(screen.getByLabelText("店舗").textContent).toContain("テスト中央店");
    expect((screen.getByLabelText("表示名") as HTMLInputElement).value).toBe("テスト担当");
    await user.click(screen.getByRole("button", { name: "追加" }));
    expect(createStaff).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: "store-1", displayName: "テスト担当" }),
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("閉じている間に店舗一覧が届いた場合も開いた時点の先頭店舗を使う", () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <StaffCreateDialog open={false} onOpenChange={onOpenChange} stores={[]} defaultStoreId={null} />,
    );
    rerender(
      <StaffCreateDialog open={false} onOpenChange={onOpenChange} stores={stores} defaultStoreId={null} />,
    );
    rerender(
      <StaffCreateDialog open onOpenChange={onOpenChange} stores={stores} defaultStoreId={null} />,
    );

    expect(screen.getByLabelText("店舗").textContent).toContain("テスト中央店");
  });

  it("手動の店舗選択とドラフトを再取得・送信待ち・再試行でも保持する", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <StaffCreateDialog open onOpenChange={onOpenChange} stores={stores} defaultStoreId="store-1" />,
    );
    await user.type(screen.getByLabelText("表示名"), "テスト担当");
    screen.getByLabelText("店舗").focus();
    await user.keyboard("テスト北店");
    expect(screen.getByLabelText("店舗").textContent).toContain("テスト北店");

    rerender(
      <StaffCreateDialog open onOpenChange={onOpenChange} stores={[...stores]} defaultStoreId={null} />,
    );
    expect(screen.getByLabelText("店舗").textContent).toContain("テスト北店");
    await user.click(screen.getByRole("button", { name: "追加" }));
    const submitted = createStaff.mock.calls[0][0];
    expect(submitted).toEqual(expect.objectContaining({ storeId: "store-2", displayName: "テスト担当" }));

    createPending = true;
    rerender(
      <StaffCreateDialog open onOpenChange={onOpenChange} stores={[...stores]} defaultStoreId="store-1" />,
    );
    expect(screen.getByLabelText("店舗").textContent).toContain("テスト北店");
    expect((screen.getByLabelText("表示名") as HTMLInputElement).value).toBe("テスト担当");
    await user.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalled();

    createPending = false;
    rerender(
      <StaffCreateDialog open onOpenChange={onOpenChange} stores={[...stores]} defaultStoreId="store-1" />,
    );
    await user.click(screen.getByRole("button", { name: "追加" }));
    expect(createStaff).toHaveBeenLastCalledWith(
      submitted,
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });
});
