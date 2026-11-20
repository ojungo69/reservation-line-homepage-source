import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onlineManager } from "@tanstack/react-query";
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
afterEach(() => onlineManager.setOnline(true));

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
    expect(screen.queryByText("未紐付けの友だちはいません。「友だちを同期」で最新化できます。")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "再読み込み" }));
    await screen.findByText("変更前の友だち");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("件数が減って現在のページが最終ページを超えたら、最終ページへ戻り空表示を出さない", async () => {
    const emptyMessage = "未紐付けの友だちはいません。「友だちを同期」で最新化できます。";
    const lastOnPage2 = { ...friend, lineUserId: "U-page2", displayName: "2ページ目の友だち" };
    const firstOnPage1 = { ...friend, lineUserId: "U-page1", displayName: "1ページ目の友だち" };
    let linked = false;
    let resolvePage1: ((value: ReturnType<typeof response>) => void) | undefined;
    const pendingPage1 = new Promise<ReturnType<typeof response>>((resolve) => { resolvePage1 = resolve; });
    api.get.mockImplementation(async (url: string) => {
      const page = new URL(url, "http://localhost").searchParams.get("page");
      if (!linked) return { ok: true, items: [page === "2" ? lastOnPage2 : firstOnPage1], total: 51, page: Number(page), pageSize: 50 };
      if (page === "2") return { ok: true, items: [], total: 50, page: 2, pageSize: 50 };
      return pendingPage1;
    });
    api.post.mockResolvedValue({ ok: true, totalFriends: 50, fetched: 0, pending: 0, failed: 0 });
    renderPage();
    await screen.findByText("1ページ目の友だち");
    fireEvent.click(screen.getByRole("button", { name: "次へ" }));
    await screen.findByText("2ページ目の友だち");

    // 一瞬だけ出て消える空表示も拾うため、追加された DOM ノードを記録する。
    let emptyShown = false;
    const noteEmpty = (records: MutationRecord[]) => records.forEach((r) => r.addedNodes.forEach((n) => {
      if (n.textContent?.includes(emptyMessage)) emptyShown = true;
    }));
    const observer = new MutationObserver(noteEmpty);
    observer.observe(document.body, { childList: true, subtree: true });

    linked = true;
    fireEvent.click(screen.getByRole("button", { name: "友だちを同期" }));
    await waitFor(() => expect(api.get).toHaveBeenLastCalledWith(expect.stringContaining("page=1")));
    expect(screen.getByText("読み込み中...")).toBeTruthy();
    expect(screen.queryByText(emptyMessage)).toBeNull();
    expect(screen.queryByText("2ページ目の友だち")).toBeNull();

    await act(async () => resolvePage1?.({ ok: true, items: [firstOnPage1], total: 50, page: 1, pageSize: 50 }));
    await screen.findByText("1ページ目の友だち");
    noteEmpty(observer.takeRecords());
    observer.disconnect();
    expect(emptyShown).toBe(false);
    expect(screen.queryByText("読み込み中...")).toBeNull();
  });

  it("最終ページへ戻る先がキャッシュ済みでも取得し直し、他で紐付けた友だちを再表示しない", async () => {
    const emptyMessage = "未紐付けの友だちはいません。「友だちを同期」で最新化できます。";
    const linkedElsewhere = { ...friend, lineUserId: "U-page1", displayName: "1ページ目の友だち" };
    const remaining = { ...friend, lineUserId: "U-remain", displayName: "残った友だち" };
    let otherSessionLinked = false;
    api.get.mockImplementation(async (url: string) => {
      const page = Number(new URL(url, "http://localhost").searchParams.get("page"));
      if (!otherSessionLinked) return { ok: true, items: [linkedElsewhere], total: 51, page, pageSize: 50 };
      return { ok: true, items: page === 2 ? [] : [remaining], total: 50, page, pageSize: 50 };
    });
    renderPage();
    await screen.findByText("1ページ目の友だち");

    otherSessionLinked = true;
    fireEvent.click(screen.getByRole("button", { name: "次へ" }));
    await screen.findByText("残った友だち");

    expect(screen.queryByText("1ページ目の友だち")).toBeNull();
    expect(screen.queryByText(emptyMessage)).toBeNull();
    expect(api.get.mock.calls.map((call) => call[0])).toEqual([
      "/api/admin/line-friends?filter=unlinked&page=1",
      "/api/admin/line-friends?filter=unlinked&page=2",
      "/api/admin/line-friends?filter=unlinked&page=1",
    ]);
  });

  it("最終ページへ戻す取り直しが通信の切断で止まっている間は、古い行と紐付けの操作を出さない", async () => {
    const linkedElsewhere = { ...friend, lineUserId: "U-linked", displayName: "別の端末で紐付けた友だち" };
    const remaining = { ...friend, lineUserId: "U-rest", displayName: "残った友だち" };
    let linked = false;
    api.get.mockImplementation(async (url: string) => {
      const page = new URL(url, "http://localhost").searchParams.get("page");
      if (!linked) return { ok: true, items: [linkedElsewhere], total: 51, page: Number(page), pageSize: 50 };
      if (page === "2") {
        onlineManager.setOnline(false);
        return { ok: true, items: [], total: 50, page: 2, pageSize: 50 };
      }
      return { ok: true, items: [remaining], total: 50, page: 1, pageSize: 50 };
    });
    renderPage();
    await screen.findByText("別の端末で紐付けた友だち");

    linked = true;
    fireEvent.click(screen.getByRole("button", { name: "次へ" }));
    await waitFor(() => expect(onlineManager.isOnline()).toBe(false));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getByText("読み込み中...")).toBeTruthy();
    expect(screen.queryByText("別の端末で紐付けた友だち")).toBeNull();
    expect(screen.queryByRole("button", { name: "既存客に紐付け" })).toBeNull();

    act(() => onlineManager.setOnline(true));
    await screen.findByText("残った友だち");
    expect(screen.queryByText("別の端末で紐付けた友だち")).toBeNull();
  });
});
