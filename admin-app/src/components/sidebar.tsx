import { NavLink } from "react-router";
import { INSTANCE_CONFIG } from "../../../src/instance-config";
import type { LucideIcon } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { usePendingReservations } from "@/hooks/use-reservations";
import { cn } from "@/lib/utils";
import { navItemsBySection, type NavItem as NavItemDef } from "@/lib/nav-items";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const DAILY_ITEMS = navItemsBySection("daily");
const ADMIN_ITEMS = navItemsBySection("admin");
const SETTINGS_ITEMS = navItemsBySection("settings");

type NavItemProps = {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  collapsed?: boolean;
  badge?: number;
  onNavigate?: () => void;
};

// 未対応件数バッジ付きのラベル文字列を作る(折りたたみ時の aria-label とツールチップで共用)。
function getNavItemLabelWithBadge(label: string, badge: number | undefined, showBadge: boolean): string {
  if (showBadge) return `${label}（未対応 ${badge}件）`;
  return label;
}

function NavItem({ to, label, icon: Icon, end, collapsed, badge, onNavigate }: Readonly<NavItemProps>) {
  const showBadge = typeof badge === "number" && badge > 0;
  const link = (
    <NavLink
      to={to}
      end={end}
      onClick={onNavigate}
      aria-label={collapsed ? getNavItemLabelWithBadge(label, badge, showBadge) : undefined}
      className={({ isActive }) =>
        cn(
          "relative flex min-h-11 items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
          collapsed && "justify-center px-2",
          isActive
            ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
            : "text-sidebar-foreground hover:bg-muted",
        )
      }
    >
      <Icon className="size-4" aria-hidden="true" />
      {!collapsed && <span className="flex-1 truncate">{label}</span>}
      {!collapsed && showBadge && (
        <span
          className="ml-auto inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-amber-500 px-1.5 text-xs font-semibold text-amber-950"
          aria-label={`未対応 ${badge}件`}
        >
          {badge > 99 ? "99+" : badge}
        </span>
      )}
      {collapsed && showBadge && (
        <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-amber-500" aria-hidden="true" />
      )}
    </NavLink>
  );

  if (collapsed) {
    // 折りたたみ時はラベルが消えるので、ホバー/フォーカスでラベルをツールチップ表示する。
    return (
      <Tooltip>
        <TooltipTrigger asChild>{link}</TooltipTrigger>
        <TooltipContent side="right">
          {getNavItemLabelWithBadge(label, badge, showBadge)}
        </TooltipContent>
      </Tooltip>
    );
  }

  return link;
}

type NavSectionProps = {
  items: readonly NavItemDef[];
  isPrivileged: boolean;
  collapsed?: boolean;
  onNavigate?: () => void;
  badges: Record<string, number>;
};

function NavSection({ items, isPrivileged, collapsed, onNavigate, badges }: Readonly<NavSectionProps>) {
  return (
    <>
      {items
        .filter((item) => !item.privileged || isPrivileged)
        .map((item) => (
          <NavItem
            key={item.path}
            to={item.path}
            label={item.label}
            icon={item.icon}
            end={item.end}
            collapsed={collapsed}
            badge={badges[item.path]}
            onNavigate={onNavigate}
          />
        ))}
    </>
  );
}

type SidebarProps = {
  collapsed?: boolean;
  onNavigate?: () => void;
};

export function Sidebar({ collapsed, onNavigate }: Readonly<SidebarProps>) {
  const { user, isPrivileged } = useAuth();
  // Surface unhandled work on the nav so operators on other pages don't miss it.
  const { data: pendingData } = usePendingReservations();
  const badges: Record<string, number> = {
    "/": pendingData?.ok ? pendingData.reservations.length : 0,
  };

  return (
    <TooltipProvider delayDuration={300}>
    <div className="flex h-full flex-col">
      {!collapsed && (
        <div className="flex h-14 items-center border-b px-4">
          <span className="text-sm font-semibold tracking-tight">{INSTANCE_CONFIG.displayName}</span>
        </div>
      )}
      {collapsed && (
        <div className="flex h-14 items-center justify-center border-b">
          <span className="text-lg font-bold">{Array.from(INSTANCE_CONFIG.displayName)[0]}</span>
        </div>
      )}

      <nav aria-label="メインナビゲーション" className="flex-1 space-y-1 overflow-auto p-2">
        {!collapsed && <p className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground">日常業務</p>}
        <NavSection items={DAILY_ITEMS} isPrivileged={isPrivileged} collapsed={collapsed} onNavigate={onNavigate} badges={badges} />

        <Separator className="my-2" />
        {!collapsed && <p className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground">管理</p>}
        <NavSection items={ADMIN_ITEMS} isPrivileged={isPrivileged} collapsed={collapsed} onNavigate={onNavigate} badges={badges} />

        {/* セクションは「staff に見える項目が1つでもあるか」で出す。以前の
            isPrivileged 丸ごとゲートだと、privileged でない項目 (店舗設定・通知)
            まで staff のサイドバーから消えていた (command palette とは非対称)。 */}
        {SETTINGS_ITEMS.some((item) => !item.privileged || isPrivileged) && (
          <>
            <Separator className="my-2" />
            {!collapsed && <p className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground">設定</p>}
            <NavSection items={SETTINGS_ITEMS} isPrivileged={isPrivileged} collapsed={collapsed} onNavigate={onNavigate} badges={badges} />
          </>
        )}
      </nav>

      <div className="border-t p-3">
        <a href="https://github.com/ojungo69/reservation-line-homepage-source"
          target="_blank" rel="noreferrer"
          className="mb-2 flex min-h-11 items-center justify-center text-xs underline"
          aria-label="ソースコード">
          {collapsed ? "</>" : "ソースコード"}
        </a>
        <p className="truncate text-xs text-muted-foreground">{user.email}</p>
        {!collapsed && <p className="text-xs capitalize text-muted-foreground">{user.role}</p>}
      </div>
    </div>
    </TooltipProvider>
  );
}
