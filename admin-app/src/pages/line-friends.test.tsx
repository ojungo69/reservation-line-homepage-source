import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, createQueryWrapper } from "@/test-utils/query-client";
import type { LineFriendListItem, Store } from "@/types/api";

let items: LineFriendListItem[] = [];
let stores: Store[] = [];
let isStoresPending = false;
let selectedStoreId: string | null = null;
let searchResults: Array<{ id: string; displayName: string; displayNameKana: string | null; phoneNormalized: string | null }> = [];
const linkMutate = vi.fn();
const lineFriendsArgs = vi.fn();

vi.mock("@/hooks/use-line-friends", () => ({
  useLineFriends: (args: unknown) => {
    lineFriendsArgs(args);
    return { items, total: items.length, pageSize: 50, isPending: false, isError: false };
  },
  useLineFriendSync: () => ({ mutate: vi.fn(), isPending: false }),
  useLineFriendLink: () => ({ mutate: linkMutate, isPending: false }),
  useCustomerSearch: (q: string) => ({ results: q.trim() ? searchResults : [], isPending: false }),
}));

vi.mock("@/hooks/use-stores", () => ({
  useStores: () => ({ stores, isPending: isStoresPending, selectedStoreId }),
}));

import LineFriendsPage from "./line-friends";

// ページが最終ページ補正でキャッシュを無効化するため QueryClient が要る。
const wrapper = createQueryWrapper(createTestQueryClient());

const store: Store = {
  id: "store-1",
  name: "本店",
  timezone: "Asia/Tokyo",
  googleCalendarId: null,
  googleControlledEditMode: false,
  maxActiveReservationsPerCustomer: 2,
  bookingWindowDays: 30,
  customerNotice: null,
};

const friend: LineFriendListItem = {
  lineUserId: "U1",
  displayName: "山田 花子",
  pictureUrl: null,
  profileStatus: "fetched",
  linked: false,
  linkedCustomerId: null,
};

beforeEach(() => {
  items = [friend];
  stores = [store];
  isStoresPending = false;
  selectedStoreId = null;
  searchResults = [];
  linkMutate.mockClear();
  lineFriendsArgs.mockClear();
});

describe("LINE友だち紐付けの操作案内", () => {
  it("複数店舗でも、紐付け先の店舗の欄や案内は無く、紐付けの操作が押せる", () => {
    stores = [store, { ...store, id: "store-2", name: "支店" }];
    render(<LineFriendsPage />, { wrapper });

    expect(screen.queryByText("紐付け先の店舗")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByText(/紐付け先の店舗を選択/)).toBeNull();
    for (const name of ["既存客に紐付け", "新規登録して紐付け"]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it.each([
    { selected: "store-2", expected: "store-2" },
    { selected: null, expected: "store-1" },
  ])("画面で選んでいる店舗 $selected のとき、storeId $expected で紐付ける", async ({ selected, expected }) => {
    stores = [store, { ...store, id: "store-2", name: "支店" }];
    selectedStoreId = selected;
    searchResults = [{ id: "customer-1", displayName: "鈴木 一郎", displayNameKana: null, phoneNormalized: null }];
    const user = userEvent.setup();
    render(<LineFriendsPage />, { wrapper });

    await user.click(screen.getByRole("button", { name: "既存客に紐付け" }));
    await user.type(screen.getByRole("textbox", { name: "既存のお客様を名前または電話番号で検索" }), "鈴木");
    await user.click(await screen.findByRole("button", { name: /鈴木 一郎/ }));

    expect(linkMutate).toHaveBeenCalledWith(
      { lineUserId: "U1", body: { mode: "existing", storeId: expected, customerId: "customer-1" } },
      expect.anything(),
    );
  });

  it("店舗を読み込み中の理由は取得後に消え、紐付け操作を再開できる", () => {
    stores = [];
    isStoresPending = true;
    const { rerender } = render(<LineFriendsPage />, { wrapper });
    expect(screen.getByText("店舗情報を読み込み中のため紐付けできません。")).toBeTruthy();

    stores = [store];
    isStoresPending = false;
    rerender(<LineFriendsPage />);
    expect(screen.queryByText("店舗情報を読み込み中のため紐付けできません。")).toBeNull();
    expect((screen.getByRole("button", { name: "既存客に紐付け" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("検索対象を名前から読み取ってLINE友だちの検索語を入力できる", async () => {
    const user = userEvent.setup();
    render(<LineFriendsPage />, { wrapper });

    const search = screen.getByRole("textbox", { name: "LINE友だちを名前で検索" });
    await user.type(search, "山田");
    expect((search as HTMLInputElement).value).toBe("山田");
  });

  it("未紐付け・紐付け済み・すべての切り替えは無く、一覧は未紐付けだけを取る", () => {
    render(<LineFriendsPage />, { wrapper });

    for (const name of ["未紐付け", "紐付け済み", "すべて"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(lineFriendsArgs).toHaveBeenLastCalledWith(expect.objectContaining({ filter: "unlinked", page: 1 }));
  });

  it.each([
    {
      name: "店舗情報がない",
      profileStatus: "fetched" as const,
      hasStore: false,
      reason: "店舗情報がないため紐付けできません。",
    },
    {
      name: "プロフィールが未取得",
      profileStatus: "pending" as const,
      hasStore: true,
      reason: "プロフィールが未取得のため紐付けできません。「友だちを同期」をお試しください。",
    },
    {
      name: "プロフィールが取得不可",
      profileStatus: "unavailable" as const,
      hasStore: true,
      reason: "プロフィールを取得できないため紐付けできません。",
    },
  ])("$nameときは無効な操作の理由を表示する", async ({ profileStatus, hasStore, reason }) => {
    items = [{ ...friend, profileStatus }];
    stores = hasStore ? [store] : [];
    const user = userEvent.setup();
    render(<LineFriendsPage />, { wrapper });

    expect(screen.getByText(reason)).toBeTruthy();
    for (const name of ["既存客に紐付け", "新規登録して紐付け"]) {
      const button = screen.getByRole("button", { name, description: reason });
      expect((button as HTMLButtonElement).disabled).toBe(true);
      await user.click(button);
    }
    expect(screen.queryByRole("dialog")).toBeNull();
    if (!hasStore) {
      expect(screen.getByText("店舗情報を読み込めませんでした。設定を確認してください。")).toBeTruthy();
    }
  });

  it("取得済みの友だちは既存のお客様への紐付け画面を開ける", async () => {
    const user = userEvent.setup();
    render(<LineFriendsPage />, { wrapper });

    const button = screen.getByRole("button", { name: "既存客に紐付け" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    await user.click(button);
    expect(within(screen.getByRole("dialog")).getByRole("heading", {
      name: "既存のお客様に紐付け（山田 花子）",
    })).toBeTruthy();
  });
});
