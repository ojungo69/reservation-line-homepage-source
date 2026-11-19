import { useId } from "react";
import { NavLink } from "react-router";
import { Code, type LucideIcon } from "lucide-react";
import { INSTANCE_CONFIG } from "../../../../src/instance-config";
import { useAuth } from "@/hooks/use-auth";
import { usePendingReservations } from "@/hooks/use-reservations";
import { navItemsBySection, type NavItem, type NavSection } from "@/lib/nav-items";
import { cn } from "@/lib/utils";
import type { Theme } from "@/hooks/use-theme";
import { AccountMenuV2 } from "./account-menu-v2";
import { PRESSABLE } from "./pressable";

const SECTIONS: ReadonlyArray<{ key: NavSection; label: string }> = [
  { key: "daily", label: "日常業務" },
  { key: "admin", label: "管理" },
  { key: "settings", label: "設定" },
];

type ItemProps = Readonly<{ item: NavItem; badge?: number; onNavigate?: () => void }>;

function NavItemV2({ item, badge = 0, onNavigate }: ItemProps) {
  const Icon: LucideIcon = item.icon;
  return (
    <NavLink
      to={item.path}
      end={item.end}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          "flex min-h-11 items-center gap-3 rounded-full px-4 text-sm",
          PRESSABLE,
          isActive ? "bg-cal-selected font-medium text-cal-on-selected" : "text-cal-text hover:bg-cal-text/8",
        )
      }
    >
      <Icon className="size-5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {badge > 0 && (
        <>
          {/* The link's name carries the real count; the capped badge is visual only. */}
          <span className="sr-only">（未対応 {badge}件）</span>
          <span
            aria-hidden="true"
            className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-cal-pending px-2 text-xs font-semibold tabular-nums text-cal-on-pending"
          >
            {badge > 99 ? "99+" : badge}
          </span>
        </>
      )}
    </NavLink>
  );
}

type NavGroupProps = Readonly<{ label: string; items: readonly NavItem[]; pending: number; onNavigate?: () => void }>;

// The visible heading names the group, so screen readers hear the section name.
function NavGroup({ label, items, pending, onNavigate }: NavGroupProps) {
  const headingId = useId();
  return (
    <div role="group" aria-labelledby={headingId} className="pt-2 first:pt-0">
      <p id={headingId} className="px-4 pb-1 pt-2 text-xs font-medium text-cal-text-secondary">
        {label}
      </p>
      {items.map((item) => (
        <NavItemV2 key={item.path} item={item} badge={item.path === "/" ? pending : 0} onNavigate={onNavigate} />
      ))}
    </div>
  );
}

type SidebarV2Props = Readonly<{ theme: Theme; onThemeChange: (theme: Theme) => void; onNavigate?: () => void }>;

/** The V2 shell's sidebar: brand, the same nav and privilege rules as the current Sidebar. */
export function SidebarV2({ theme, onThemeChange, onNavigate }: SidebarV2Props) {
  const { isPrivileged } = useAuth();
  const { data: pendingData } = usePendingReservations();
  const pending = pendingData?.ok ? pendingData.reservations.length : 0;

  return (
    <div className="flex h-full flex-col">
      {/* pr-14 keeps a long name clear of the drawer's close button (44px at right-2). */}
      <div className="flex h-14 shrink-0 items-center pl-5 pr-14">
        <span className="truncate text-base font-semibold tracking-tight text-cal-text">
          {INSTANCE_CONFIG.displayName}
        </span>
      </div>

      <nav aria-label="メインナビゲーション" className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {SECTIONS.map(({ key, label }) => {
          const items = navItemsBySection(key).filter((item) => !item.privileged || isPrivileged);
          // A section shows when the user can see at least one of its items (same rule as Sidebar).
          if (items.length === 0) return null;
          return <NavGroup key={key} label={label} items={items} pending={pending} onNavigate={onNavigate} />;
        })}
      </nav>

      <div className="shrink-0 space-y-1 border-t border-cal-grid px-3 py-3">
        <a
          href="/source"
          target="_blank"
          rel="noreferrer"
          className={cn("flex min-h-11 items-center gap-3 rounded-full px-4 text-sm text-cal-text-secondary hover:bg-cal-text/8", PRESSABLE)}
        >
          <Code className="size-5 shrink-0" aria-hidden="true" />
          ソースコード
        </a>
        <AccountMenuV2 theme={theme} onThemeChange={onThemeChange} />
      </div>
    </div>
  );
}
