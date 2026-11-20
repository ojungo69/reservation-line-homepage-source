import { createContext, useContext, type Ref } from "react";

/**
 * What the V2 shell lends the page inside it. Only the calendar uses it (spec 008
 * T005): its floating top bar replaces the shell's header, so the shell's menu
 * button moves into that bar and keeps the drawer's focus rules (T004b).
 */
export type ShellV2 = Readonly<{
  showMenuButton: boolean;
  menuButtonRef: Ref<HTMLButtonElement>;
  menuOpen: boolean;
  openMenu: () => void;
  /**
   * Set while the page's own top bar is mounted. The shell then drops its header
   * and keeps <main> from scrolling, so the bar's glass never sits inside a
   * scroller (DESIGN.md §3). The bar sets it itself, so a page that fails before
   * drawing the bar keeps the header, and with it the menu button.
   */
  setOwnTopBar: (own: boolean) => void;
  /**
   * While true, page move does not open. Its modal would stack on the page's sheet
   * (DESIGN.md §3), and closing that sheet from outside would drop unsaved input:
   * the sheets guard drafts only when they are the ones closing.
   */
  setPaletteBlocked: (blocked: boolean) => void;
}>;

export const ShellV2Context = createContext<ShellV2 | null>(null);

export function useShellV2(): ShellV2 | null {
  return useContext(ShellV2Context);
}
