import { Routes, Route, Navigate } from "react-router";
import { lazy, Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { ProtectedRoute } from "@/components/protected-route";

const SchedulePage = lazy(() => import("@/pages/schedule"));
const ReservationsPage = lazy(() => import("@/pages/reservations"));
const CustomersPage = lazy(() => import("@/pages/customers"));
const StaffPage = lazy(() => import("@/pages/staff"));
const MenuPage = lazy(() => import("@/pages/menu"));
const SettingsPage = lazy(() => import("@/pages/settings"));
const GoogleSyncPage = lazy(() => import("@/pages/google-sync"));
const ActivityPage = lazy(() => import("@/pages/activity"));
const LineFriendsPage = lazy(() => import("@/pages/line-friends"));
const StoreLoginsPage = lazy(() => import("@/pages/store-logins"));
const CancellationFeesPage = lazy(() => import("@/pages/cancellation-fees"));
const NotificationsPage = lazy(() => import("@/pages/notifications"));
const NotFoundPage = lazy(() => import("@/pages/not-found"));

function PageLoading() {
  return (
    <div className="space-y-4 p-6">
      <div className="h-8 w-48 animate-pulse rounded bg-muted" />
      <div className="h-4 w-96 animate-pulse rounded bg-muted" />
    </div>
  );
}

export function AppRoutes() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<SchedulePage />} />
          <Route path="reservations" element={<ReservationsPage />} />
          <Route path="menu" element={<MenuPage />} />
          {/* Customers are staff-accessible (own-store only). The backend store-scopes
              every customer read/write for staff (search/list/detail/memo/カルテ) and
              owner-only actions (block/archive/merge, archived view) stay gated inside
              the page by isPrivileged. Keep it OUT of the requiredPrivilege block. */}
          <Route path="customers" element={<CustomersPage />} />

          {/* 未納一覧も staff がアクセスできる (回収するのは現場のため)。バックエンドが
              一覧を自店舗に scope し、入金済み操作も自店舗の予約だけ許可する。
              requiredPrivilege ブロックには入れない。 */}
          <Route path="cancellation-fees" element={<CancellationFeesPage />} />

          {/* 端末ごとのプッシュ通知設定。スタッフも自分の端末で受け取れる要件が
              あるため、オーナー専用の店舗設定ではなく独立ページに置いている。 */}
          <Route path="notifications" element={<NotificationsPage />} />

          {/* Legacy SSR path /admin/sync -> SPA sync page. Target is basename-relative
              ("/google-sync"); React Router prepends the /admin basename. */}
          <Route path="sync" element={<Navigate to="/google-sync" replace />} />

          {/* 店舗設定は staff もアクセス可。バックエンドは営業時間・休業日の
              mutation を自店舗スコープで許可し (isAdminAllowedForStoreSettings)、
              owner 限定タブ (リソース/リマインダー/繰り返しブロック) は
              settings.tsx 側で isPrivileged ゲートする。 */}
          <Route path="settings" element={<SettingsPage />} />

          <Route element={<ProtectedRoute requiredPrivilege />}>
            <Route path="line-friends" element={<LineFriendsPage />} />
            <Route path="staff" element={<StaffPage />} />
            <Route path="google-sync" element={<GoogleSyncPage />} />
            <Route path="store-logins" element={<StoreLoginsPage />} />
            <Route path="activity" element={<ActivityPage />} />
          </Route>

          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
