import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, createQueryWrapper } from "@/test-utils/query-client";
import type { LineFriendListItem } from "@/types/api";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api-client", () => ({ api }));
import { LinkExistingDialog } from "./link-dialogs";

const friend: LineFriendListItem = { lineUserId: "U1", displayName: "LINE見本", pictureUrl: null, profileStatus: "fetched", linked: false, linkedCustomerId: null };
const customer = { id: "customer-1", displayName: "山田 見本", displayNameKana: null, phoneNormalized: "09012345678", blockStatus: "active", memo: null };
const search = () => fireEvent.change(screen.getByRole("textbox", { name: "既存のお客様を名前または電話番号で検索" }), { target: { value: "山" } });
const renderDialog = () => render(<LinkExistingDialog friend={friend} storeId="store-1" onClose={vi.fn()} />, { wrapper: createQueryWrapper(createTestQueryClient()) });

beforeEach(() => vi.resetAllMocks());

describe("LINE紐付けの顧客検索結果", () => {
  it("検索失敗を0件と区別し、再読み込みで回復して既存のpayloadで紐付ける", async () => {
    api.get.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ ok: true, customers: [customer], truncated: false });
    api.post.mockResolvedValue({ ok: true, customerId: customer.id });
    renderDialog();
    search();
    await screen.findByRole("alert");
    expect(screen.queryByText("該当する顧客がいません")).toBeNull();
    expect(screen.queryByRole("button", { name: /^山田/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "再読み込み" }));
    fireEvent.click(await screen.findByRole("button", { name: /^山田 見本/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/admin/line-friends/U1/link", { mode: "existing", storeId: "store-1", customerId: "customer-1" }));
  });

  it.each([true, false])("成功時だけ truncated=%s に対応する上限案内を表示する", async (truncated) => {
    api.get.mockResolvedValue({ ok: true, customers: [customer], truncated });
    renderDialog();
    search();
    await screen.findByRole("button", { name: /^山田 見本/ });
    expect(screen.queryByText("候補が多いため一部のみ表示しています。名前をもう少し入力してください") !== null).toBe(truncated);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("正常に0件なら該当なしだけを表示する", async () => {
    api.get.mockResolvedValue({ ok: true, customers: [], truncated: false });
    renderDialog();
    search();
    await screen.findByText("該当する顧客がいません");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
