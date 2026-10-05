import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { SettingsResponse } from "@/types/api";

const settingsQuery = {
  queryKey: ["settings"],
  queryFn: () => api.get<SettingsResponse>("/api/admin/settings"),
  staleTime: 5 * 60_000,
} as const;

export function useSettings({ live = false }: { live?: boolean } = {}) {
  return useQuery({
    ...settingsQuery,
    ...(live ? {
      staleTime: 30_000,
      refetchInterval: 30_000,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: "always" as const,
    } : {}),
  });
}

// GET /api/admin/settings は一度の取得で stores / services / staff / closures /
// reminderOffsets を全部返す。派生フックはこれを使って select だけ差し替える
// こと — queryKey / URL を各フックで書き直してキャッシュを分岐させない。
// schedule の live は observer 単位の頻度だけを変え、同じ cache を共有する。
export function useSettingsSelect<T>(select: (data: SettingsResponse) => T) {
  return useQuery({ ...settingsQuery, select });
}
