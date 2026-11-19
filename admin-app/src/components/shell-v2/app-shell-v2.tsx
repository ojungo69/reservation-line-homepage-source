import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Outlet, useLocation } from "react-router";
import { CommandPalette } from "@/components/command-palette";
import { CHUNK_RELOAD_FLAG } from "@/components/error-boundary";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useAdminPushReconcile } from "@/hooks/use-admin-push";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useTheme } from "@/hooks/use-theme";
import { StoreProvider } from "@/providers/store-provider";
import { HeaderV2 } from "./header-v2";
import { SidebarV2 } from "./sidebar-v2";

// The docked sidebar's breakpoint: Tailwind's lg, in the same unit. Media queries
// size rem from the browser's default font size, so a px value would part from the
// lg: classes when that setting is not 16px. Only one SidebarV2 is mounted at a
// time: the docked one, or the drawer's while it is open.
export const DOCKED_QUERY = "(min-width: 64rem)";

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
  const docked = useMediaQuery(DOCKED_QUERY);
  // The drawer's close handler runs after a widening screen has already removed
  // the drawer, so it reads the latest value here (set before that handler runs).
  const dockedRef = useRef(docked);
  useLayoutEffect(() => {
    dockedRef.current = docked;
  }, [docked]);
  // Held here, not in the menu: the drawer's menu unmounts on close.
  const { theme, setTheme } = useTheme();
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const paletteReturnRef = useRef<HTMLElement | null>(null);

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

  // A new page, or a screen wide enough for the docked sidebar, closes the drawer.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname, docked]);

  // One modal at a time (DESIGN.md §3): opening page move, by button or ⌘K,
  // closes the drawer. Focus goes back where it was, or to the page.
  const onPaletteOpenChange = (open: boolean) => {
    if (open) {
      paletteReturnRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setDrawerOpen(false);
    }
    setPaletteOpen(open);
  };
  useEffect(() => {
    if (paletteOpen || !paletteReturnRef.current) return;
    const target = paletteReturnRef.current;
    paletteReturnRef.current = null;
    target.focus();
    // Gone, hidden or disabled meanwhile: focus did not land, so use the page.
    if (target === document.body || document.activeElement !== target) mainRef.current?.focus();
  }, [paletteOpen]);

  // A page change can remove the focused element (page move returns focus to the
  // old page, then a lazy page commits and replaces it). Focus the new page then
  // instead of leaving it on <body>. Skips the first render.
  const shownPath = useRef(pathname);
  useEffect(() => {
    if (shownPath.current === pathname) return;
    shownPath.current = pathname;
    if (document.activeElement === document.body) mainRef.current?.focus();
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

        {docked ? (
          // Docked sidebar: opaque surface, no blur (DESIGN.md §3).
          <aside className="surface w-64 shrink-0 overflow-hidden rounded-3xl">
            <SidebarV2 theme={theme} onThemeChange={setTheme} />
          </aside>
        ) : (
          <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
            <SheetContent
              side="left"
              className="w-72 p-0"
              aria-describedby={undefined}
              onOpenAutoFocus={(event) => {
                // Radix skips links when it picks the first focus, which lands on the
                // account button at the bottom. Start at the current page instead.
                event.preventDefault();
                const panel = event.currentTarget as HTMLElement;
                (
                  panel.querySelector<HTMLElement>("[aria-current='page']") ?? panel.querySelector<HTMLElement>("nav a")
                )?.focus();
              }}
              onCloseAutoFocus={(event) => {
                // The menu button opened it; once the screen is wide, that button
                // is hidden, so focus moves to the page instead.
                event.preventDefault();
                (dockedRef.current ? mainRef.current : menuButtonRef.current)?.focus();
              }}
            >
              <SheetTitle className="sr-only">メニュー</SheetTitle>
              <SidebarV2 theme={theme} onThemeChange={setTheme} onNavigate={() => setDrawerOpen(false)} />
            </SheetContent>
          </Sheet>
        )}

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <HeaderV2
            showMenuButton={!docked}
            menuButtonRef={menuButtonRef}
            menuOpen={drawerOpen}
            onMenuToggle={() => setDrawerOpen(true)}
            onOpenPalette={() => onPaletteOpenChange(true)}
          />
          {/* Pages keep today's colors; only the shell, the calendar and the chart change (plan.md). */}
          <main
            ref={mainRef}
            id="main-content"
            tabIndex={-1}
            className="min-h-0 flex-1 overflow-auto bg-background text-foreground lg:rounded-3xl"
          >
            <Outlet />
          </main>
        </div>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={onPaletteOpenChange} />
    </StoreProvider>
  );
}
