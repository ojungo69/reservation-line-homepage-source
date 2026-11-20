import { useEffect, useMemo, useRef, useState } from "react";
import { Outlet, useLocation } from "react-router";
import { CommandPalette } from "@/components/command-palette";
import { CHUNK_RELOAD_FLAG } from "@/components/error-boundary";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useAdminPushReconcile } from "@/hooks/use-admin-push";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useTheme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";
import { StoreProvider } from "@/providers/store-provider";
import { HeaderV2 } from "./header-v2";
import { ShellV2Context, type ShellV2 } from "./shell-context";
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
 * exists. Below 64rem (1024px at a 16px default font size) the sidebar is a
 * drawer, as in the approved prototype.
 */
export default function AppShellV2() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The calendar's own top bar (T005) stands in for the header; see ShellV2.
  const [ownTopBar, setOwnTopBar] = useState(false);
  const paletteBlocked = useRef(false);
  const { pathname } = useLocation();
  const docked = useMediaQuery(DOCKED_QUERY);
  // Held here, not in the menu: the drawer's menu unmounts on close.
  const { theme, setTheme } = useTheme();
  // The header's menu button, or the calendar bar's when that bar stands in for the
  // header. Two refs, not one shared: the header unmounting would null a shared one
  // after the bar had set it.
  const headerMenuRef = useRef<HTMLButtonElement>(null);
  const barMenuRef = useRef<HTMLButtonElement>(null);
  const menuButton = () => barMenuRef.current ?? headerMenuRef.current;
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
  // closes the drawer. Focus goes back to the button that opened it (Safari does
  // not focus buttons on click), else to what had focus for ⌘K, else the page.
  const onPaletteOpenChange = (open: boolean, opener?: HTMLElement) => {
    if (open && paletteBlocked.current) return;
    if (open) {
      paletteReturnRef.current =
        opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
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

  // The element that last had focus, so the effect below can tell focus that fell
  // off a removed element from a page nobody has focused yet (where the first Tab
  // must still reach the skip link).
  const lastFocused = useRef<Element | null>(null);
  useEffect(() => {
    const remember = (event: FocusEvent) => {
      lastFocused.current = event.target instanceof Element ? event.target : null;
    };
    // Focus left for <body> (a click on plain text): forget the element, unless it
    // is gone by the next microtask, which means it was removed while focused.
    const forget = (event: FocusEvent) => {
      const left = event.target;
      if (event.relatedTarget !== null || !(left instanceof Element)) return;
      queueMicrotask(() => {
        if (left.isConnected && lastFocused.current === left) lastFocused.current = null;
      });
    };
    document.addEventListener("focusin", remember);
    document.addEventListener("focusout", forget);
    return () => {
      document.removeEventListener("focusin", remember);
      document.removeEventListener("focusout", forget);
    };
  }, []);

  // A page change or a layout switch can remove the focused element: page move
  // returns focus to the old page before a lazy page replaces it, and narrowing
  // the screen unmounts the docked sidebar. When that left focus on <body>, move it
  // to the new page, or after a layout switch to the menu button that replaced the
  // sidebar (the page once the button is gone). The first render leaves it alone.
  const shown = useRef({ pathname, docked });
  useEffect(() => {
    const before = shown.current;
    shown.current = { pathname, docked };
    if (document.activeElement !== document.body || lastFocused.current?.isConnected !== false) return;
    if (before.pathname !== pathname) mainRef.current?.focus();
    else if (before.docked !== docked) (menuButton() ?? mainRef.current)?.focus();
  }, [pathname, docked]);

  const shell = useMemo<ShellV2>(
    () => ({
      showMenuButton: !docked,
      menuButtonRef: barMenuRef,
      menuOpen: drawerOpen,
      openMenu: () => setDrawerOpen(true),
      // onPaletteOpenChange reads only refs and setters, so the first render's copy is current.
      openPalette: (opener) => onPaletteOpenChange(true, opener),
      setOwnTopBar,
      setPaletteBlocked: (blocked) => {
        paletteBlocked.current = blocked;
      },
    }),
    [docked, drawerOpen],
  );

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
          // Docked sidebar: the prototype's faux glass, an opaque gradient and a
          // hairline with no blur and no shadow (DESIGN.md §3).
          <aside className="w-64 shrink-0 overflow-hidden rounded-3xl bg-linear-to-b from-cal-surface to-cal-detail ring-1 ring-inset ring-cal-grid dark:from-cal-detail dark:to-cal-surface">
            <SidebarV2 theme={theme} onThemeChange={setTheme} />
          </aside>
        ) : (
          <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
            <SheetContent
              side="left"
              // Capped like the prototype, so the close button stays on screen
              // on a narrow phone with a large default font size.
              className="w-72 max-w-[86vw] p-0"
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
                // The menu button opened it. Once the screen is wide that button is
                // unmounted (its ref is null by the time this runs), so the page gets focus.
                event.preventDefault();
                (menuButton() ?? mainRef.current)?.focus();
              }}
            >
              <SheetTitle className="sr-only">メニュー</SheetTitle>
              <SidebarV2 theme={theme} onThemeChange={setTheme} onNavigate={() => setDrawerOpen(false)} />
            </SheetContent>
          </Sheet>
        )}

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {!ownTopBar && (
            <HeaderV2
              showMenuButton={!docked}
              menuButtonRef={headerMenuRef}
              menuOpen={drawerOpen}
              onMenuToggle={() => setDrawerOpen(true)}
              onOpenPalette={(opener) => onPaletteOpenChange(true, opener)}
            />
          )}
          {/* Pages keep today's colors; only the shell, the calendar and the chart change (plan.md). */}
          <main
            ref={mainRef}
            id="main-content"
            tabIndex={-1}
            className={cn(
              "min-h-0 flex-1 bg-background text-foreground lg:rounded-3xl",
              ownTopBar ? "overflow-hidden" : "overflow-auto",
            )}
          >
            <ShellV2Context.Provider value={shell}>
              <Outlet />
            </ShellV2Context.Provider>
          </main>
        </div>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={onPaletteOpenChange} />
    </StoreProvider>
  );
}
