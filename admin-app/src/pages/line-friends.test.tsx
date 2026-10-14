import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LineFriendListItem, Store } from "@/types/api";

let items: LineFriendListItem[] = [];
let stores: Store[] = [];
let isStoresPending = false;

vi.mock("@/hooks/use-line-friends", () => ({
  useLineFriends: () => ({ items, total: items.length, pageSize: 50, isPending: false, isError: false }),
  useLineFriendSync: () => ({ mutate: vi.fn(), isPending: false }),
  useLineFriendLink: () => ({ mutate: vi.fn(), isPending: false }),
  useCustomerSearch: () => ({ results: [], isPending: false }),
}));

vi.mock("@/hooks/use-stores", () => ({
  useStores: () => ({ stores, isPending: isStoresPending }),
}));

import LineFriendsPage from "./line-friends";

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
});

describe("LINE友だち紐付けの操作案内", () => {
  it("複数店舗で未選択のときは店舗選択の案内と操作の理由を表示する", () => {
    stores = [store, { ...store, id: "store-2", name: "支店" }];
    render(<LineFriendsPage />);

    const reason = "紐付け先の店舗を選択すると紐付けできます。";
    expect(screen.getByText(reason)).toBeTruthy();
    expect(screen.getByText("紐付け先の店舗を選択してください。")).toBeTruthy();
    for (const name of ["既存客に紐付け", "新規登録して紐付け"]) {
      expect((screen.getByRole("button", { name, description: reason }) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("店舗を読み込み中の理由は取得後に消え、紐付け操作を再開できる", () => {
    stores = [];
    isStoresPending = true;
    const { rerender } = render(<LineFriendsPage />);
    expect(screen.getByText("店舗情報を読み込み中のため紐付けできません。")).toBeTruthy();

    stores = [store];
    isStoresPending = false;
    rerender(<LineFriendsPage />);
    expect(screen.queryByText("店舗情報を読み込み中のため紐付けできません。")).toBeNull();
    expect((screen.getByRole("button", { name: "既存客に紐付け" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("検索対象を名前から読み取ってLINE友だちの検索語を入力できる", async () => {
    const user = userEvent.setup();
    render(<LineFriendsPage />);

    const search = screen.getByRole("textbox", { name: "LINE友だちを名前で検索" });
    await user.type(search, "山田");
    expect((search as HTMLInputElement).value).toBe("山田");
  });

  it("未紐付け・紐付け済み・すべての選択状態を操作に合わせて読み取れる", async () => {
    const user = userEvent.setup();
    render(<LineFriendsPage />);

    expect(screen.getByRole("button", { name: "未紐付け", pressed: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "紐付け済み", pressed: false })).toBeTruthy();
    expect(screen.getByRole("button", { name: "すべて", pressed: false })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "紐付け済み" }));
    expect(screen.getByRole("button", { name: "紐付け済み", pressed: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "未紐付け", pressed: false })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "すべて" }));
    expect(screen.getByRole("button", { name: "すべて", pressed: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "紐付け済み", pressed: false })).toBeTruthy();
    expect(screen.getByRole("button", { name: "未紐付け", pressed: false })).toBeTruthy();
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
    render(<LineFriendsPage />);

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
    render(<LineFriendsPage />);

    const button = screen.getByRole("button", { name: "既存客に紐付け" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    await user.click(button);
    expect(within(screen.getByRole("dialog")).getByRole("heading", {
      name: "既存のお客様に紐付け（山田 花子）",
    })).toBeTruthy();
  });
});
