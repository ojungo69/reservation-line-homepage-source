import { useEffect } from "react";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHUNK_RELOAD_FLAG } from "@/components/error-boundary";

const reconcile = vi.fn();

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { role: "owner", email: "owner@example.com", storeId: null }, isPrivileged: true }),
}));
// The real useStores and StoreProvider run; only the settings fetch is stubbed.
vi.mock("@/hooks/use-settings", () => ({
  useSettingsSelect: (select: (data: unknown) => unknown) => ({
    data: select({
      ok: true,
      settings: { stores: [{ id: "store-1", name: "本店" }, { id: "store-2", name: "支店" }] },
    }),
    isPending: false,
  }),
}));
vi.mock("@/hooks/use-reservations", () => ({
  usePendingReservations: () => ({ data: { ok: true, reservations: [] } }),
}));
vi.mock("@/hooks/use-theme", () => ({ useTheme: () => ({ theme: "light", setTheme: vi.fn() }) }));
vi.mock("@/hooks/use-admin-push", () => ({ useAdminPushReconcile: () => reconcile() }));
vi.mock("@/components/command-palette", () => ({
  CommandPalette: ({ open }: { open: boolean }) => (open ? <div role="dialog" aria-label="ページ移動" /> : null),
}));

import AppShellV2 from "./app-shell-v2";

// Navigates when the test fires "test:navigate", i.e. from outside the drawer.
function NavigateFromOutside() {
  const navigate = useNavigate();
  useEffect(() => {
    const go = () => navigate("/customers");
    window.addEventListener("test:navigate", go);
    return () => window.removeEventListener("test:navigate", go);
  }, [navigate]);
  return <p>予定表のページ</p>;
}

const renderShell = (path = "/") =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<AppShellV2 />}>
          <Route index element={<NavigateFromOutside />} />
          <Route path="customers" element={<p>顧客のページ</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

const drawer = () => screen.queryByRole("dialog", { name: "メニュー" });

const openDrawer = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: "メニュー" }));
  expect(drawer()).not.toBeNull();
};

beforeEach(() => {
  reconcile.mockClear();
  sessionStorage.clear();
});

describe("AppShellV2 の役目", () => {
  it("本文へスキップのリンクと、本文の main を持つ", () => {
    renderShell();
    expect(screen.getByRole("link", { name: "本文へスキップ" }).getAttribute("href")).toBe("#main-content");
    const main = screen.getByRole("main");
    expect(main.id).toBe("main-content");
    expect(main.getAttribute("tabindex")).toBe("-1");
    expect(within(main).getByText("予定表のページ")).toBeTruthy();
  });

  it("読み込み直しの印を消し、通知の購読を結び直す", () => {
    sessionStorage.setItem(CHUNK_RELOAD_FLAG, "1");
    renderShell();
    expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBeNull();
    expect(reconcile).toHaveBeenCalled();
  });

  it("選んだ店舗を、画面を移っても保つ", async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(screen.getByRole("button", { name: "店舗を切り替え（現在：全店舗）" }));
    await user.click(screen.getByRole("menuitemradio", { name: "支店" }));
    const docked = screen.getAllByRole("navigation", { name: "メインナビゲーション" })[0];
    await user.click(within(docked).getByRole("link", { name: "顧客" }));
    expect(screen.getByText("顧客のページ")).toBeTruthy();
    expect(screen.getByRole("button", { name: "店舗を切り替え（現在：支店）" })).toBeTruthy();
  });

  it("引き出しは、画面が外から変わっても閉じる", async () => {
    const user = userEvent.setup();
    renderShell();
    await openDrawer(user);
    act(() => {
      window.dispatchEvent(new Event("test:navigate"));
    });
    expect(screen.getByText("顧客のページ")).toBeTruthy();
    expect(drawer()).toBeNull();
  });

  it("引き出しは、今の画面の項目を押しても閉じる", async () => {
    const user = userEvent.setup();
    renderShell();
    await openDrawer(user);
    await user.click(within(drawer() as HTMLElement).getByRole("link", { name: "スケジュール" }));
    expect(drawer()).toBeNull();
  });

  it("ページ移動を外枠から開く", async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(screen.getByRole("button", { name: "ページ移動 (Cmd/Ctrl+K)" }));
    expect(screen.getByRole("dialog", { name: "ページ移動" })).toBeTruthy();
  });

  it("スクロールする本文とメニューの中にぼかしを置かない (research R1 / iPad の電池)", () => {
    renderShell();
    const isBlur = (token: string) => /^!?(backdrop-blur|glass-)/.test(token.replaceAll(/\[[^\]]*\]/g, "[]").split(":").pop() ?? "");
    const scrollers = [screen.getByRole("main"), ...screen.getAllByRole("navigation", { name: "メインナビゲーション" })];
    const blurred = scrollers.flatMap((root) =>
      [root, ...root.querySelectorAll("*")].flatMap((el) => [...el.classList].filter(isBlur)),
    );
    expect(blurred).toEqual([]);
  });
});
