import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { showErrorToast } from "@/lib/error-messages";
import type { BusinessHourRow, BusinessHoursResponse } from "@/types/api";

export function useBusinessHours(storeId: string | null) {
  return useQuery({
    queryKey: ["business-hours", storeId],
    queryFn: () => api.get<BusinessHoursResponse>(`/api/admin/settings/business-hours/${storeId}`),
    enabled: !!storeId,
    staleTime: 60_000,
  });
}

export function useBusinessHoursUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ storeId, hours }: { storeId: string; hours: BusinessHourRow[] }) =>
      api.put<{ ok: true }>(`/api/admin/settings/business-hours/${storeId}`, { hours }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["business-hours", vars.storeId] });
      qc.invalidateQueries({ queryKey: ["settings"] });
      toast.success("営業時間を更新しました");
    },
    onError: (err) => showErrorToast(err, "営業時間の更新に失敗しました"),
  });
}
