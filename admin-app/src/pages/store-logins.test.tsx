import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoreLogin } from "@/types/api";

const revoke = vi.fn();
let state: {
  storeLogins: StoreLogin[];
  isPending: boolean;
  isError: boolean;
} = { storeLogins: [], isPending: false, isError: false };

vi.mock("@/hooks/use-store-logins", () => ({
  useStoreLogins: () => state,
  useStoreLoginRevoke: () => ({ mutate: revoke, isPending: false }),
}));

vi.mock("@/components/store-logins/store-login-dialog", () => ({
  StoreLoginDialog: ({ store }: { store: StoreLogin }) => (
    <div>設定対象: {store.storeName}</div>
  ),
}));

import StoreLoginsPage from "./store-logins";

beforeEach(() => {
  revoke.mockReset();
  state = { storeLogins: [], isPending: false, isError: false };
});

describe("StoreLoginsPage", () => {
  it("読込中・失敗・空一覧を区別する", () => {
    state = { storeLogins: [], isPending: true, isError: false };
    const { rerender } = render(<StoreLoginsPage />);
    expect(document.querySelectorAll(".animate-pulse")).toHaveLength(6);

    state = { storeLogins: [], isPending: false, isError: true };
    rerender(<StoreLoginsPage />);
    expect(screen.getByText("店舗ログインの取得に失敗しました。")).toBeTruthy();

    state = { storeLogins: [], isPending: false, isError: false };
    rerender(<StoreLoginsPage />);
    expect(screen.getByText("店舗がありません")).toBeTruthy();
  });

  it("有効な店舗ログインを確認後に無効化する", async () => {
    const user = userEvent.setup();
    state = {
      isPending: false,
      isError: false,
      storeLogins: [
        {
          storeId: "store-1",
          storeName: "新宿店",
          email: "store@example.com",
          role: "owner",
          status: "active",
          lastSeenAt: "2026-07-24T10:00:00Z",
          attention: null,
          canConfigure: true,
        },
        {
          storeId: "store-2",
          storeName: "渋谷店",
          email: null,
          role: null,
          status: "unset",
          lastSeenAt: null,
          attention: "ambiguous_login",
          canConfigure: false,
        },
      ],
    };
    render(<StoreLoginsPage />);

    await user.click(screen.getByRole("button", { name: "再設定" }));
    expect(screen.getByText("設定対象: 新宿店")).toBeTruthy();
    expect(screen.getByText("要手動対応")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "無効化" }));
    await user.click(screen.getByRole("button", { name: "無効化する" }));

    expect(revoke).toHaveBeenCalledWith("store-1", expect.objectContaining({
      onSuccess: expect.any(Function),
    }));
  });
});
