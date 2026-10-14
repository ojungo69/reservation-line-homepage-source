import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { LineFriendListItem } from "@/types/api";

const link = vi.fn();

vi.mock("@/hooks/use-line-friends", () => ({
  useLineFriendLink: () => ({ mutate: link, isPending: false }),
  useCustomerSearch: (query: string) => ({
    results: query === "山田" ? [{
      id: "customer-1",
      displayName: "山田 花子",
      displayNameKana: null,
      phoneNormalized: "09012345678",
      blockStatus: "active",
      memo: null,
    }] : [],
    isPending: false,
  }),
}));

import { LinkExistingDialog } from "./link-dialogs";

const friend: LineFriendListItem = {
  lineUserId: "U1",
  displayName: "LINEの花子",
  pictureUrl: null,
  profileStatus: "fetched",
  linked: false,
  linkedCustomerId: null,
};

describe("既存のお客様へのLINE紐付け", () => {
  it("検索欄の名前からお客様を検索し、既存の紐付け操作を行える", async () => {
    const user = userEvent.setup();
    render(<LinkExistingDialog friend={friend} storeId="store-1" onClose={vi.fn()} />);

    const search = screen.getByRole("textbox", { name: "既存のお客様を名前または電話番号で検索" });
    await user.type(search, "山田");
    expect((search as HTMLInputElement).value).toBe("山田");
    await user.click(await screen.findByRole("button", { name: /^山田 花子/ }));

    expect(link).toHaveBeenCalledWith({
      lineUserId: "U1",
      body: { mode: "existing", storeId: "store-1", customerId: "customer-1" },
    }, expect.objectContaining({ onSuccess: expect.any(Function) }));
  });
});
