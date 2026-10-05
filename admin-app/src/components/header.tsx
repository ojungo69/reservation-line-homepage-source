import { useState } from "react";
import { Menu, Search, Moon, Monitor, Sun, ChevronDown, LogOut, type LucideIcon } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useTheme } from "@/hooks/use-theme";
import { useStores } from "@/hooks/use-stores";
import { ACCESS_LOGOUT_PATH } from "@/lib/auth-logout";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CommandPalette } from "@/components/command-palette";

type HeaderProps = {
  onMenuToggle?: () => void;
};

type Theme = "light" | "dark" | "system";

// テーマ切替ボタンのクリックで次に適用するテーマを決める(循環: light→dark→system→light)。
function getNextTheme(theme: Theme): Theme {
  if (theme === "dark") return "light";
  if (theme === "light") return "system";
  return "dark";
}

type ThemeMenuOption = { Icon: LucideIcon; label: string };

// 現在のテーマに応じたメニュー表示(アイコン+ラベル=次に切り替わる先)を決める。
function getThemeMenuOption(theme: Theme): ThemeMenuOption {
  if (theme === "light") return { Icon: Moon, label: "ダークモード" };
  if (theme === "dark") return { Icon: Monitor, label: "システム設定" };
  return { Icon: Sun, label: "ライトモード" };
}

export function Header({ onMenuToggle }: Readonly<HeaderProps>) {
  const { user } = useAuth();
  const { theme, setTheme } = useTheme();
  const { stores, selectedStoreId, selectStore, isStoreFixed } = useStores();
  const [commandOpen, setCommandOpen] = useState(false);

  const selectedStore = stores.find((s) => s.id === selectedStoreId);

  return (
    <>
      <header className="glass-thin flex h-14 items-center gap-2 px-4">
        <button
          type="button"
          onClick={onMenuToggle}
          className="mr-2 min-h-11 min-w-11 rounded-md p-2.5 text-muted-foreground hover:bg-accent md:hidden"
          aria-label="メニュー"
        >
          <Menu className="size-5" aria-hidden="true" />
        </button>

        <button
          type="button"
          onClick={() => setCommandOpen(true)}
          aria-label="ページ移動 (Cmd/Ctrl+K)"
          aria-keyshortcuts="Meta+K Control+K"
          className="flex min-h-11 min-w-11 items-center gap-2 rounded-md border bg-muted/50 px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted"
        >
          <Search className="size-4" aria-hidden="true" />
          <span className="hidden sm:inline">ページ移動</span>
          <kbd className="hidden rounded border bg-background px-1.5 py-0.5 text-xs font-mono sm:inline">⌘K</kbd>
        </button>

        <div className="flex-1" />

        <Badge variant="outline" className="hidden text-xs sm:inline-flex">
          {selectedStore?.name ?? "全店舗"}
        </Badge>

        {!isStoreFixed && stores.length > 1 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="店舗を切り替え"
                className="flex min-h-11 min-w-11 items-center gap-1 rounded-md px-2 py-2 text-xs text-muted-foreground hover:bg-accent"
              >
                店舗切替
                <ChevronDown className="size-3" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => selectStore(null)}>
                全店舗
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {stores.map((store) => (
                <DropdownMenuItem
                  key={store.id}
                  onClick={() => selectStore(store.id)}
                  className={cn(selectedStoreId === store.id && "font-medium")}
                >
                  {store.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="アカウントメニュー"
              className="flex min-h-11 min-w-11 items-center gap-1 rounded-md px-2 py-2 text-sm text-muted-foreground hover:bg-accent"
            >
              {user.email.split("@")[0]}
              <ChevronDown className="size-3" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled className="text-xs text-muted-foreground">
              {user.email} ({user.role})
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setTheme(getNextTheme(theme))}>
              {(() => {
                const { Icon, label } = getThemeMenuOption(theme);
                return (
                  <>
                    <Icon className="mr-2 size-4" aria-hidden="true" />
                    {label}
                  </>
                );
              })()}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                window.location.href = ACCESS_LOGOUT_PATH;
              }}
            >
              <LogOut className="mr-2 size-4" aria-hidden="true" />
              ログアウト
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} />
    </>
  );
}
