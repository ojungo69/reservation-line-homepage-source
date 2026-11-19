import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

let role: "owner" | "staff" = "owner";
let pendingCount = 2;
let theme: "light" | "dark" | "system" = "light";
const setTheme = vi.fn();
const logout = vi.fn();

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { role, email: "owner@example.com", storeId: role === "staff" ? "store-1" : null },
    isPrivileged: role === "owner",
  }),
}));

vi.mock("@/hooks/use-reservations", () => ({
  usePendingReservations: () => ({
    data: { ok: true, reservations: Array.from({ length: pendingCount }, (_, i) => ({ id: `r${i}` })) },
  }),
}));

vi.mock("@/lib/auth-logout", () => ({ logout: () => logout() }));

import { SidebarV2 } from "./sidebar-v2";

const renderSidebar = (path = "/", onNavigate?: () => void) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <SidebarV2 theme={theme} onThemeChange={setTheme} onNavigate={onNavigate} />
    </MemoryRouter>,
  );

const PRIVILEGED = ["スタッフ", "LINE友だち紐付け", "店舗ログイン", "Google連携", "操作記録"];

beforeEach(() => {
  role = "owner";
  pendingCount = 2;
  theme = "light";
  setTheme.mockClear();
  logout.mockClear();
});

describe("SidebarV2 のメニュー", () => {
  it("owner には 3 つの区分と、権限の要る項目も出る", () => {
    renderSidebar();
    // Each link sits in its own list item directly under the list its heading names.
    const itemOf = (list: string, link: string) => {
      const item = within(screen.getByRole("list", { name: list })).getByRole("link", { name: link }).closest("li");
      return item?.parentElement?.getAttribute("aria-labelledby") ? item.parentElement : null;
    };
    expect(itemOf("日常業務", "顧客")).toBe(screen.getByRole("list", { name: "日常業務" }));
    expect(itemOf("管理", "スタッフ")).toBe(screen.getByRole("list", { name: "管理" }));
    expect(itemOf("設定", "店舗ログイン")).toBe(screen.getByRole("list", { name: "設定" }));
    for (const label of ["スケジュール", "顧客", "メニュー", "店舗設定", "通知", ...PRIVILEGED]) {
      expect(screen.getByRole("link", { name: new RegExp(label) })).toBeTruthy();
    }
  });

  it("staff には権限の要る項目が出ず、設定の区分は残る", () => {
    role = "staff";
    renderSidebar();
    for (const label of PRIVILEGED) expect(screen.queryByRole("link", { name: new RegExp(label) })).toBeNull();
    const settings = screen.getByRole("list", { name: "設定" });
    expect(within(settings).getByRole("link", { name: "店舗設定" })).toBeTruthy();
    expect(within(settings).getByRole("link", { name: "通知" })).toBeTruthy();
  });

  it("今いる画面の項目を選択中として示す", () => {
    renderSidebar("/customers");
    expect(screen.getByRole("link", { name: "顧客" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: /スケジュール/ }).getAttribute("aria-current")).toBeNull();
  });

  it("承認待ちの件数をスケジュールの読み上げ名に含め、100 件以上の表示は 99+ にする", () => {
    const { unmount } = renderSidebar();
    const link = screen.getByRole("link", { name: "スケジュール（未対応 2件）" });
    expect(within(link).getByText("2")).toBeTruthy();
    expect(screen.getAllByText(/未対応/)).toHaveLength(1);
    unmount();
    pendingCount = 120;
    renderSidebar();
    const capped = screen.getByRole("link", { name: "スケジュール（未対応 120件）" });
    expect(within(capped).getByText("99+")).toBeTruthy();
  });

  it("承認待ちが無いときは件数を出さない", () => {
    pendingCount = 0;
    renderSidebar();
    expect(screen.queryByText(/未対応/)).toBeNull();
    expect(screen.getByRole("link", { name: "スケジュール" })).toBeTruthy();
  });

  it("項目を押すと onNavigate を呼ぶ（引き出しを閉じるため）", async () => {
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    renderSidebar("/", onNavigate);
    await user.click(screen.getByRole("link", { name: "顧客" }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});

describe("SidebarV2 の下部", () => {
  it("ソースコードへのリンクを新しいタブで開く", () => {
    renderSidebar();
    const link = screen.getByRole("link", { name: "ソースコード" });
    expect(link.getAttribute("href")).toBe("/source");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });

  it("アカウントのメニューに、ログイン中のメールアドレスと権限を出す", async () => {
    const user = userEvent.setup();
    renderSidebar();
    await user.click(screen.getByRole("button", { name: "アカウントメニュー（owner）" }));
    expect(screen.getByText("owner@example.com（owner）")).toBeTruthy();
  });

  it.each([
    { current: "light", label: "ダークモード", next: "dark" },
    { current: "dark", label: "システム設定", next: "system" },
    { current: "system", label: "ライトモード", next: "light" },
  ] as const)("テーマを $current から $label（$next）に切り替える", async ({ current, label, next }) => {
    theme = current;
    const user = userEvent.setup();
    renderSidebar();
    await user.click(screen.getByRole("button", { name: "アカウントメニュー（owner）" }));
    await user.click(screen.getByRole("menuitem", { name: label }));
    expect(setTheme).toHaveBeenCalledWith(next);
  });

  it("ログアウトを選ぶと共通のログアウトを呼ぶ", async () => {
    const user = userEvent.setup();
    renderSidebar();
    await user.click(screen.getByRole("button", { name: "アカウントメニュー（owner）" }));
    await user.click(screen.getByRole("menuitem", { name: "ログアウト" }));
    expect(logout).toHaveBeenCalledTimes(1);
  });
});
