import {
  Calendar,
  ClipboardList,
  Users,
  User,
  UtensilsCrossed,
  Settings,
  RefreshCw,
  FileText,
  UserPlus,
  KeyRound,
  Wallet,
  Bell,
  type LucideIcon,
} from "lucide-react";

export type NavSection = "daily" | "admin" | "settings";

export type NavItem = {
  path: string;
  label: string;
  icon: LucideIcon;
  /** Free-text search aliases for the command palette. */
  keywords: string;
  section: NavSection;
  /** Owner-only pages (hidden from staff in both the sidebar and the palette). */
  privileged?: boolean;
  /** react-router `end` matching — only the index route needs it. */
  end?: boolean;
};

// Single source of truth for the admin navigation. Both the sidebar (grouped by
// section) and the command palette (flat, searchable) render from this list, so a
// route/icon/privilege change is made in exactly one place and cannot drift.
export const NAV_ITEMS: readonly NavItem[] = [
  { path: "/", label: "スケジュール", icon: Calendar, keywords: "schedule timeline", section: "daily", end: true },
  { path: "/reservations", label: "予約管理", icon: ClipboardList, keywords: "reservation booking", section: "daily" },
  // Staff may now manage their OWN store's customers (search/detail/memo/カルテ);
  // the backend store-scopes every customer read/write for staff, and owner-only
  // actions (block/archive/merge, archived view) stay gated inside the page by
  // isPrivileged. So this nav item is visible to all roles (not privileged-only).
  { path: "/customers", label: "顧客", icon: Users, keywords: "customer client", section: "daily" },
  {
    path: "/cancellation-fees",
    label: "キャンセル料未納",
    icon: Wallet,
    keywords: "cancellation fee unpaid 未納 キャンセル料 入金",
    section: "daily",
  },
  { path: "/staff", label: "スタッフ", icon: User, keywords: "staff member", section: "admin", privileged: true },
  {
    path: "/line-friends",
    label: "LINE友だち紐付け",
    icon: UserPlus,
    keywords: "line friend link paper chart 紐付け 友だち",
    section: "admin",
    privileged: true,
  },
  { path: "/menu", label: "メニュー", icon: UtensilsCrossed, keywords: "menu service", section: "admin" },
  {
    path: "/notifications",
    label: "通知",
    icon: Bell,
    keywords: "notification push web push 通知 プッシュ スマホ",
    section: "settings",
  },
  // 店舗設定は staff もアクセス可 (営業時間・休業日を自店舗スコープで編集できる。
  // バックエンドが store-scope を強制し、owner 限定タブは settings.tsx 側で
  // isPrivileged ゲートする)。
  { path: "/settings", label: "店舗設定", icon: Settings, keywords: "settings config", section: "settings" },
  {
    path: "/store-logins",
    label: "店舗ログイン",
    icon: KeyRound,
    keywords: "store login staff access ログイン 店舗 鍵",
    section: "settings",
    privileged: true,
  },
  {
    path: "/google-sync",
    label: "Google連携",
    icon: RefreshCw,
    keywords: "google sync calendar",
    section: "settings",
    privileged: true,
  },
  { path: "/activity", label: "操作記録", icon: FileText, keywords: "activity audit log", section: "settings", privileged: true },
];

export const navItemsBySection = (section: NavSection): readonly NavItem[] =>
  NAV_ITEMS.filter((item) => item.section === section);
