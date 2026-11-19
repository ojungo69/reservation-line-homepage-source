import { Check, ChevronDown, Store } from "lucide-react";
import { useStores } from "@/hooks/use-stores";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MENU_ITEM_FOCUS, PRESSABLE } from "./pressable";

/**
 * Store scope control for the V2 shell (and, in T005, the calendar's top bar).
 * Same rules as the current Header: staff are fixed to their store, and only a
 * user who can see two or more stores gets the menu. The trigger is told apart
 * by its text and icon, never by an outline (DESIGN.md §3).
 */
export function StoreSwitchV2() {
  const { stores, selectedStoreId, selectStore, isStoreFixed } = useStores();
  const selected = stores.find((store) => store.id === selectedStoreId);
  // One accessible store reads as that store, not 全店舗 (DESIGN.md §5).
  const name = selected?.name ?? (stores.length === 1 ? stores[0].name : "全店舗");

  if (isStoreFixed || stores.length < 2) {
    return (
      <span title={name} className="flex min-h-11 max-w-48 items-center gap-2 px-3 text-sm font-medium text-cal-text">
        <Store className="size-4 shrink-0" aria-hidden="true" />
        <span className="truncate">{name}</span>
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`店舗を切り替え（現在：${name}）`}
          className={cn(
            "flex min-h-11 max-w-48 items-center gap-2 rounded-full px-4 text-sm font-medium text-cal-text hover:bg-cal-detail",
            PRESSABLE,
          )}
        >
          <Store className="size-4 shrink-0" aria-hidden="true" />
          <span className="truncate">{name}</span>
          <ChevronDown className="size-4 shrink-0 text-cal-text-secondary" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          role="menuitemradio"
          aria-checked={selectedStoreId === null}
          onSelect={() => selectStore(null)}
          className={MENU_ITEM_FOCUS}
        >
          <Check className={cn("size-4", selectedStoreId !== null && "invisible")} aria-hidden="true" />
          全店舗
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {stores.map((store) => (
          <DropdownMenuItem
            key={store.id}
            role="menuitemradio"
            aria-checked={selectedStoreId === store.id}
            onSelect={() => selectStore(store.id)}
            className={cn(MENU_ITEM_FOCUS, selectedStoreId === store.id && "font-medium")}
          >
            <Check className={cn("size-4", selectedStoreId !== store.id && "invisible")} aria-hidden="true" />
            {store.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
