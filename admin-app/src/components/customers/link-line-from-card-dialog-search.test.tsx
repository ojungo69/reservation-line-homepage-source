import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, createQueryWrapper } from "@/test-utils/query-client";
import type { LineFriendsResponse } from "@/types/api";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api-client", () => ({ api }));
vi.mock("@/hooks/use-stores", () => ({ useStores: () => ({ stores: [{ id: "store-1", name: "本店" }] }) }));
import { LinkLineFromCardDialog } from "./link-line-from-card-dialog";

const response: LineFriendsResponse = {
  ok: true, total: 1, page: 1, pageSize: 50,
  items: [{ lineUserId: "U1", displayName: "山田 見本", pictureUrl: null, profileStatus: "fetched", linked: false, linkedCustomerId: null }],
};
const search = () => fireEvent.change(screen.getByRole("textbox", { name: "LINE友だちを名前で検索" }), { target: { value: "山" } });
const renderDialog = () => render(<LinkLineFromCardDialog customer={{ id: "customer-1", displayName: "カルテ見本" }} onClose={vi.fn()} />, { wrapper: createQueryWrapper(createTestQueryClient()) });

beforeEach(() => vi.resetAllMocks());

describe("カルテ起点のLINE友だち検索", () => {
  it("検索失敗を0件と区別し、再取得中は候補を隠して成功後だけ紐付ける", async () => {
    let finishRetry: (value: LineFriendsResponse) => void = () => { throw new Error("retry not started"); };
    api.get.mockRejectedValueOnce(new Error("offline")).mockImplementationOnce(() => new Promise<LineFriendsResponse>((resolve) => { finishRetry = resolve; }));
    api.post.mockResolvedValue({ ok: true, customerId: "customer-1" });
    renderDialog();
    search();
    await screen.findByRole("alert");
    expect(screen.queryByText(/該当する未紐付けのLINE友だちがいません/)).toBeNull();
    expect(screen.queryByRole("button", { name: /山田 見本$/ })).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "再読み込み" }));
    await screen.findByText("検索中...");
    expect(screen.queryByRole("button", { name: /山田 見本$/ })).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    expect(api.get.mock.calls[1][0]).toBe("/api/admin/line-friends?filter=unlinked&page=1&q=%E5%B1%B1");
    finishRetry(response);
    fireEvent.click(await screen.findByRole("button", { name: /山田 見本$/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/admin/line-friends/U1/link", { mode: "existing", storeId: "store-1", customerId: "customer-1" }));
  });

  it("成功時の0件は該当なしと表示する", async () => {
    api.get.mockResolvedValue({ ...response, items: [], total: 0 });
    renderDialog();
    search();
    await screen.findByText(/該当する未紐付けのLINE友だちがいません/);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("再取得が失敗したらキャッシュに残る前の候補も選択させない", async () => {
    api.get.mockResolvedValueOnce(response).mockRejectedValueOnce(new Error("offline"));
    const client = createTestQueryClient();
    render(<LinkLineFromCardDialog customer={{ id: "customer-1", displayName: "カルテ見本" }} onClose={vi.fn()} />, { wrapper: createQueryWrapper(client) });
    search();
    await screen.findByRole("button", { name: /山田 見本$/ });
    await act(() => client.invalidateQueries({ queryKey: ["line-friends"] }));
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: /山田 見本$/ })).toBeNull();
    expect(screen.queryByText(/該当する未紐付けのLINE友だちがいません/)).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });
});
