import type { Ref } from "react";
import { Menu, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { PRESSABLE } from "./pressable";
import { StoreSwitchV2 } from "./store-switch-v2";

type HeaderV2Props = Readonly<{
  menuButtonRef?: Ref<HTMLButtonElement>;
  menuOpen: boolean;
  onMenuToggle: () => void;
  onOpenPalette: () => void;
}>;

/**
 * Flat header of the V2 shell for routes other than the calendar (T005 gives the
 * calendar its own floating top bar). It sits above <main>, never over a
 * scroller, so it carries no blur.
 */
export function HeaderV2({ menuButtonRef, menuOpen, onMenuToggle, onOpenPalette }: HeaderV2Props) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 px-2 text-cal-text lg:px-1">
      <button
        ref={menuButtonRef}
        type="button"
        onClick={onMenuToggle}
        aria-label="メニュー"
        aria-expanded={menuOpen}
        className={cn("grid min-h-11 min-w-11 place-items-center rounded-full hover:bg-cal-detail lg:hidden", PRESSABLE)}
      >
        <Menu className="size-5" aria-hidden="true" />
      </button>

      <button
        type="button"
        onClick={onOpenPalette}
        aria-label="ページ移動 (Cmd/Ctrl+K)"
        aria-keyshortcuts="Meta+K Control+K"
        className={cn("flex min-h-11 min-w-11 items-center gap-2 rounded-full px-3 text-sm hover:bg-cal-detail", PRESSABLE)}
      >
        <Search className="size-5 shrink-0" aria-hidden="true" />
        <span className="hidden sm:inline">ページ移動</span>
        <kbd className="hidden rounded-md bg-cal-detail px-1.5 py-0.5 font-mono text-xs text-cal-text-secondary sm:inline">
          ⌘K
        </kbd>
      </button>

      <div className="flex-1" />

      <StoreSwitchV2 />
    </header>
  );
}
