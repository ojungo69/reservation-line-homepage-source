import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router";
import { CommandPalette } from "@/components/command-palette";
import { CHUNK_RELOAD_FLAG } from "@/components/error-boundary";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useAdminPushReconcile } from "@/hooks/use-admin-push";
import { StoreProvider } from "@/providers/store-provider";
import { HeaderV2 } from "./header-v2";
import { SidebarV2 } from "./sidebar-v2";

/**
 * The admin shell on the calendar switch's on side (spec 008 T004b).
 *
 * It copies AppShell's duties (push reconcile, chunk-reload flag, drawer close
 * on navigation, skip link, StoreProvider) instead of sharing code with it:
 * plan.md keeps the current shell and its tests unchanged while the switch
 * exists. Below 1024px the sidebar is a drawer, as in the approved prototype.
 */
export default function AppShellV2() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { pathname } = useLocation();

  // Re-binds the shared device's push subscription to the signed-in admin.
  useAdminPushReconcile();

  // This shell mounts only after the lazy route chunk committed, so clearing the
  // flag here proves the app loaded (clearing it earlier loops on stale deploys).
  useEffect(() => {
    try {
      sessionStorage.removeItem(CHUNK_RELOAD_FLAG);
    } catch {
      // Storage blocked: nothing to clear.
    }
  }, []);

  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  return (
    <StoreProvider>
      <div className="flex h-dvh overflow-hidden bg-cal-outer text-cal-text lg:gap-3 lg:p-3">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-full focus:bg-cal-surface focus:px-4 focus:py-2 focus:text-sm focus:ring-2 focus:ring-cal-primary"
        >
          本文へスキップ
        </a>

        {/* Docked sidebar: opaque surface, no blur (DESIGN.md §3). */}
        <aside className="surface hidden w-64 shrink-0 overflow-hidden rounded-3xl lg:block">
          <SidebarV2 />
        </aside>

        <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
          <SheetContent side="left" className="w-72 p-0" aria-describedby={undefined}>
            <SheetTitle className="sr-only">メニュー</SheetTitle>
            <SidebarV2 onNavigate={() => setDrawerOpen(false)} />
          </SheetContent>
        </Sheet>

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <HeaderV2
            menuOpen={drawerOpen}
            onMenuToggle={() => setDrawerOpen(true)}
            onOpenPalette={() => setPaletteOpen(true)}
          />
          {/* Pages keep today's colors; only the shell, the calendar and the chart change (plan.md). */}
          <main
            id="main-content"
            tabIndex={-1}
            className="min-h-0 flex-1 overflow-auto bg-background text-foreground lg:rounded-3xl"
          >
            <Outlet />
          </main>
        </div>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </StoreProvider>
  );
}
