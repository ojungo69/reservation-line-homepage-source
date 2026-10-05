import { useState, useEffect } from "react";
import { Outlet, useLocation } from "react-router";
import { Sidebar } from "@/components/sidebar";
import { Header } from "@/components/header";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { CHUNK_RELOAD_FLAG } from "@/components/error-boundary";
import { StoreProvider } from "@/providers/store-provider";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useAdminPushReconcile } from "@/hooks/use-admin-push";
import { cn } from "@/lib/utils";

// Collapse the sidebar to an icon-rail only on tablet-width screens that also
// have a hover-capable pointer (laptop trackpad/mouse): the collapsed rail
// relies on hover tooltips for labels, which never fire on touch. Touch tablets
// (iPad, `hover: none` / `pointer: coarse`) therefore keep the full-label
// sidebar so store staff can read each nav item.
const TABLET_MQ =
  "(min-width: 768px) and (max-width: 1023px) and (hover: hover) and (pointer: fine)";

export function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const collapsed = useMediaQuery(TABLET_MQ);
  const location = useLocation();

  // 共有端末の購読行を、いま署名している管理者へ結び直す。通知ページに来たとき
  // だけでは遅い: それまでの間、前の担当者の店舗の通知が届き続ける。
  useAdminPushReconcile();

  // AppShell は Suspense 境界の内側にあり、初回マウントは lazy なルートチャンクが
  // 解決して commit された後にしか起こらない。よってここでガードを解除すれば
  // 「アプリが正常に読み込めた」ことを保証でき、後続の別チャンクエラーでも再び
  // 一回限りの自動リロードが効く。App 直下（Suspense の外）で解除すると chunk が
  // 失敗する前にフラグが消え、stale デプロイで無限リロードになるため不可。
  useEffect(() => {
    try {
      sessionStorage.removeItem(CHUNK_RELOAD_FLAG);
    } catch {
      // sessionStorage 不可環境では何もしない。
    }
  }, []);

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  return (
    <StoreProvider>
    <div className="flex h-screen overflow-hidden">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:shadow focus:ring-2 focus:ring-ring"
      >
        本文へスキップ
      </a>
      <aside
        className={cn(
          "surface relative hidden shrink-0 md:block",
          collapsed ? "w-16" : "w-64",
        )}
      >
        <Sidebar collapsed={collapsed} />
      </aside>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-64 p-0" aria-describedby={undefined}>
          <span className="sr-only">メニュー</span>
          <Sidebar onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>

      <div className="flex flex-1 flex-col overflow-hidden">
        <Header onMenuToggle={() => setMobileOpen(true)} />
        <main id="main-content" tabIndex={-1} className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
    </StoreProvider>
  );
}
