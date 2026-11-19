import { useEffect } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
vi.mock("@/hooks/use-admin-push", () => ({ useAdminPushReconcile: () => reconcile() }));
// Opens and closes the way the real palette does: Cmd/Ctrl+K toggles it, and
// every close goes through onOpenChange(false).
vi.mock("@/components/command-palette", async () => {
  const React = await import("react");
  return {
    CommandPalette: ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) => {
      React.useEffect(() => {
        const handler = (event: KeyboardEvent) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "k") {
            event.preventDefault();
            onOpenChange(!open);
          }
        };
        document.addEventListener("keydown", handler);
        return () => document.removeEventListener("keydown", handler);
      }, [open, onOpenChange]);
      return open ? (
        <div role="dialog" aria-label="ページ移動">
          <button type="button" onClick={() => onOpenChange(false)}>
            閉じる
          </button>
        </div>
      ) : null;
    },
  };
});

import AppShellV2, { DOCKED_QUERY } from "./app-shell-v2";

// A matchMedia whose docked breakpoint the test can flip, firing "change" the way
// a rotation or a window resize does. The real useMediaQuery and useTheme read it.
let wide = true;
const listeners = new Set<() => void>();
const setWide = (value: boolean) =>
  act(() => {
    wide = value;
    for (const listener of listeners) listener();
  });

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
const palette = () => screen.queryByRole("dialog", { name: "ページ移動" });
const navs = () => screen.queryAllByRole("navigation", { name: "メインナビゲーション" });

const openDrawer = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: "メニュー" }));
  expect(drawer()).not.toBeNull();
};

const closePalette = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(within(palette() as HTMLElement).getByRole("button", { name: "閉じる" }));
  expect(palette()).toBeNull();
};

// Blur utilities on root or anything under it, variants and arbitrary values included.
const blurClasses = (root: Element) =>
  [root, ...root.querySelectorAll("*")].flatMap((el) =>
    [...el.classList].filter((token) =>
      /^!?(backdrop-|blur|glass-)/.test(token.replaceAll(/\[[^\]]*\]/g, "[]").split(":").pop() ?? ""),
    ),
  );

beforeEach(() => {
  reconcile.mockClear();
  sessionStorage.clear();
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  wide = true;
  listeners.clear();
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return query === DOCKED_QUERY ? wide : false;
    },
    addEventListener: (_type: "change", listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: "change", listener: () => void) => listeners.delete(listener),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

  it("本文は今の色のままにし、カレンダーの色を持ち込まない", () => {
    renderShell();
    const classes = [...screen.getByRole("main").classList];
    expect(classes).toEqual(expect.arrayContaining(["bg-background", "text-foreground"]));
    expect(classes.filter((name) => /(^|:)(bg|text)-cal-/.test(name))).toEqual([]);
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
    await user.click(within(navs()[0]).getByRole("link", { name: "顧客" }));
    expect(screen.getByText("顧客のページ")).toBeTruthy();
    expect(screen.getByRole("button", { name: "店舗を切り替え（現在：支店）" })).toBeTruthy();
  });

  it("ページ移動を外枠から開く", async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(screen.getByRole("button", { name: "ページ移動 (Cmd/Ctrl+K)" }));
    expect(palette()).not.toBeNull();
  });
});

describe("AppShellV2 のフォーカス (UX-22)", () => {
  it("ページ移動を閉じると、開いたボタンへフォーカスを戻す", async () => {
    const user = userEvent.setup();
    renderShell();
    const opener = screen.getByRole("button", { name: "ページ移動 (Cmd/Ctrl+K)" });
    await user.click(opener);
    await closePalette(user);
    expect(document.activeElement).toBe(opener);
  });

  it("キーボードで開いたページ移動を閉じると、戻る先が無いので本文へフォーカスを移す", async () => {
    const user = userEvent.setup();
    renderShell();
    const main = screen.getByRole("main");
    await user.keyboard("{Control>}k{/Control}");
    await closePalette(user);
    expect(document.activeElement).toBe(main);
  });

  it("引き出しを開くと、一番下のアカウントでなく今の画面の項目へフォーカスを置く", async () => {
    wide = false;
    const user = userEvent.setup();
    renderShell("/customers");
    await openDrawer(user);
    const current = within(drawer() as HTMLElement).getByRole("link", { name: "顧客" });
    await waitFor(() => expect(document.activeElement).toBe(current));
  });

  it("引き出しを Esc で閉じると、メニューのボタンへフォーカスを戻す", async () => {
    wide = false;
    const user = userEvent.setup();
    renderShell();
    const button = screen.getByRole("button", { name: "メニュー" });
    await openDrawer(user);
    await user.keyboard("{Escape}");
    expect(drawer()).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  it("引き出しを開いたまま 1024px 以上に広がると、隠れたメニューのボタンでなく本文へフォーカスを移す", async () => {
    wide = false;
    const user = userEvent.setup();
    renderShell();
    const main = screen.getByRole("main");
    await openDrawer(user);
    setWide(true);
    await waitFor(() => expect(document.activeElement).toBe(main));
  });

  it("ページ移動を開くと引き出しを閉じ、モーダルを重ねない (DESIGN.md §3)", async () => {
    wide = false;
    const user = userEvent.setup();
    renderShell();
    await openDrawer(user);
    await user.keyboard("{Control>}k{/Control}");
    await waitFor(() => expect(drawer()).toBeNull());
    expect(palette()).not.toBeNull();
  });
});

describe("AppShellV2 のサイドバーと引き出し", () => {
  it("広い画面では常設のサイドバーを 1 つだけ置く", () => {
    renderShell();
    expect(navs()).toHaveLength(1);
    expect(drawer()).toBeNull();
  });

  it("狭い画面では、引き出しを開いた間だけサイドバーを 1 つ置く", async () => {
    wide = false;
    const user = userEvent.setup();
    renderShell();
    expect(navs()).toHaveLength(0);
    await openDrawer(user);
    expect(navs()).toHaveLength(1);
  });

  it("引き出しは、画面が外から変わっても閉じる", async () => {
    wide = false;
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
    wide = false;
    const user = userEvent.setup();
    renderShell();
    await openDrawer(user);
    await user.click(within(drawer() as HTMLElement).getByRole("link", { name: "スケジュール" }));
    expect(drawer()).toBeNull();
  });

  it("画面が 1024px 以上に広がると引き出しを閉じ、また狭くなっても勝手に開かない", async () => {
    wide = false;
    const user = userEvent.setup();
    renderShell();
    await openDrawer(user);
    setWide(true);
    expect(drawer()).toBeNull();
    expect(navs()).toHaveLength(1);
    setWide(false);
    expect(drawer()).toBeNull();
    expect(navs()).toHaveLength(0);
  });

  it("保存できない環境でも、引き出しを開き直したときに選んだテーマを保つ", async () => {
    const blocked = () => {
      throw new Error("storage blocked");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(blocked);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(blocked);
    wide = false;
    const user = userEvent.setup();
    renderShell();
    const pick = async (label: string) => {
      await user.click(screen.getByRole("button", { name: "アカウントメニュー（owner）" }));
      await user.click(screen.getByRole("menuitem", { name: label }));
    };

    await openDrawer(user);
    await pick("ライトモード");
    await pick("ダークモード");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    await user.keyboard("{Escape}");
    expect(drawer()).toBeNull();

    await openDrawer(user);
    await user.click(screen.getByRole("button", { name: "アカウントメニュー（owner）" }));
    expect(screen.getByRole("menuitem", { name: "システム設定" })).toBeTruthy();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("スクロールする本文・メニューと、外枠の常設部分にぼかしを置かない (research R1 / iPad の電池)", () => {
    renderShell();
    const roots = [
      screen.getByRole("main"),
      screen.getByRole("banner"),
      screen.getByRole("complementary"),
      ...navs(),
    ];
    expect(roots.flatMap(blurClasses)).toEqual([]);
  });

  it("引き出しのガラスは外側の面だけにし、中のスクロール領域にぼかしを置かない", async () => {
    wide = false;
    const user = userEvent.setup();
    renderShell();
    await openDrawer(user);
    const panel = drawer() as HTMLElement;
    expect(panel.classList.contains("glass-modal")).toBe(true);
    expect(panel.classList.contains("overflow-y-auto")).toBe(false);
    const scrollers = [...panel.querySelectorAll("*")].filter((el) => el.classList.contains("overflow-y-auto"));
    expect(scrollers.length).toBeGreaterThanOrEqual(2);
    expect(scrollers.flatMap(blurClasses)).toEqual([]);
  });
});
