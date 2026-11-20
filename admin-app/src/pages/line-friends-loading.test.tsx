import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, createQueryWrapper } from "@/test-utils/query-client";
import type { LineFriendListItem } from "@/types/api";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api-client", () => ({ api }));
vi.mock("@/hooks/use-stores", () => ({
  useStores: () => ({ stores: [{ id: "store-1", name: "本店" }], isPending: false }),
}));

import LineFriendsPage from "./line-friends";

const friend: LineFriendListItem = {
  lineUserId: "U-old", displayName: "変更前の友だち", pictureUrl: null,
  profileStatus: "fetched", linked: false, linkedCustomerId: null,
};
const response = (item = friend) => ({ ok: true, items: [item], total: 100, page: 1, pageSize: 50 });
const renderPage = () => render(<LineFriendsPage />, { wrapper: createQueryWrapper(createTestQueryClient()) });

beforeEach(() => vi.resetAllMocks());

describe("LINE友だち一覧の条件と表示", () => {
  it.each(["検索語", "ページ"])("%s の応答待ちでは旧結果を操作できず、新しい結果だけを表示する", async (change) => {
    let resolveResponse: ((value: ReturnType<typeof response>) => void) | undefined;
    const pending = new Promise<ReturnType<typeof response>>((resolve) => { resolveResponse = resolve; });
    api.get.mockResolvedValueOnce(response()).mockReturnValueOnce(pending);
    renderPage();
    await screen.findByText("変更前の友だち");

    if (change === "検索語") {
      fireEvent.change(screen.getByRole("textbox", { name: "LINE友だちを名前で検索" }), { target: { value: "変更後" } });
    } else {
      fireEvent.click(screen.getByRole("button", { name: "次へ" }));
    }
    expect(screen.queryByText("変更前の友だち")).toBeNull();
    expect(screen.queryByRole("button", { name: "既存客に紐付け" })).toBeNull();
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("変更前の友だち")).toBeNull();
    expect(screen.getByText("読み込み中...")).toBeTruthy();

    await act(async () => resolveResponse?.(response({ ...friend, lineUserId: "U-new", displayName: "変更後の友だち" })));
    await screen.findByText("変更後の友だち");
    expect(screen.getByRole("button", { name: "既存客に紐付け" })).toHaveProperty("disabled", false);
  });

  it("再取得失敗時に旧結果を表示せず、再読み込みで復帰する", async () => {
    api.get.mockResolvedValueOnce(response()).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(response());
    renderPage();
    await screen.findByText("変更前の友だち");
    fireEvent.click(screen.getByRole("button", { name: "次へ" }));
    await screen.findByRole("alert");
    expect(screen.queryByText("変更前の友だち")).toBeNull();
    expect(screen.queryByText("該当がありません。")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "再読み込み" }));
    await screen.findByText("変更前の友だち");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
