import { useContext } from "react";

import { useSettingsSelect } from "./use-settings";
import { useAuth } from "@/hooks/use-auth";
import { StoreContext } from "@/providers/store-context";
import type { Store } from "@/types/api";

export function useStores() {
  const { user } = useAuth();

  // 他の設定系フック（useSettings / useStaffList / useServiceList）と同じ
  // ["settings"] キー + /api/admin/settings を共有し、重複リクエストと
  // 分岐したキャッシュを避ける。stores は select で導出する。
  // staff も fetch する: GET /api/admin/settings は staff に自店舗スコープの
  // allowlist (stores/services/closures 等) を返すので、店名解決のためにも
  // 取得してよい (以前の enabled ガードは staff が 403 だった頃の名残)。
  const { data: stores, isPending } = useSettingsSelect((data): Store[] =>
    data?.ok ? data.settings.stores : []
  );

  // Read the shared selection from StoreProvider so the header switcher and the
  // schedule/timeline (and every per-page selector) stay in sync. Previously each
  // useStores() owned its own useState, so the header could never reach the schedule.
  const selection = useContext(StoreContext);
  if (!selection) {
    throw new Error("useStores must be used within a StoreProvider");
  }

  return {
    stores: stores ?? [],
    isPending,
    selectedStoreId: selection.selectedStoreId,
    selectStore: selection.selectStore,
    isStoreFixed: user.role === "staff",
  };
}
