import { ChevronUp, LogOut, Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useTheme } from "@/hooks/use-theme";
import { logout } from "@/lib/auth-logout";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PRESSABLE } from "./pressable";

type Theme = "light" | "dark" | "system";

// Same cycle and labels as the current Header. header.tsx keeps its own copy
// because plan.md leaves the old shell untouched while the switch exists.
const NEXT_THEME: Record<Theme, { next: Theme; label: string; Icon: LucideIcon }> = {
  light: { next: "dark", label: "ダークモード", Icon: Moon },
  dark: { next: "system", label: "システム設定", Icon: Monitor },
  system: { next: "light", label: "ライトモード", Icon: Sun },
};

/** Account menu at the foot of the V2 sidebar: who is signed in, theme, and logout. */
export function AccountMenuV2() {
  const { user } = useAuth();
  const { theme, setTheme } = useTheme();
  const { next, label, Icon } = NEXT_THEME[theme];
  const name = user.email.split("@")[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="アカウントメニュー"
          className={cn(
            "flex min-h-11 w-full items-center gap-3 rounded-full px-3 text-left text-sm text-cal-text hover:bg-cal-detail",
            PRESSABLE,
          )}
        >
          <span
            aria-hidden="true"
            className="grid size-7 shrink-0 place-items-center rounded-full bg-cal-selected text-xs font-semibold uppercase text-cal-on-selected"
          >
            {name.charAt(0)}
          </span>
          <span className="min-w-0 flex-1 truncate">{name}</span>
          <ChevronUp className="size-4 shrink-0 text-cal-text-secondary" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-60">
        <DropdownMenuItem disabled className="text-xs">{`${user.email}（${user.role}）`}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => setTheme(next)}>
          <Icon className="mr-2 size-4" aria-hidden="true" />
          {label}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => logout()}>
          <LogOut className="mr-2 size-4" aria-hidden="true" />
          ログアウト
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
