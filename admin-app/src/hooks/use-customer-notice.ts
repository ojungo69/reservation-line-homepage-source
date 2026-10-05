import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { useSettingsSelect } from "./use-settings";
import { showErrorToast } from "@/lib/error-messages";
import { CUSTOMER_NOTICE_MUTATION_KEY } from "@/lib/pending-mutation-ids";
import type { Store, CustomerNoticeUpdateRequest, MutationOkResponse } from "@/types/api";

// The customer notice lives on the per-store settings snapshot (store_settings).
// Reuse the shared ["settings"] query so this stays in sync with the other
// settings tabs (same pattern as use-booking-window).
export function useCustomerNotices() {
  const query = useSettingsSelect((d): Store[] => d?.settings?.stores ?? []);
  return { stores: query.data ?? [], isPending: query.isPending };
}

export function useCustomerNoticeUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: CUSTOMER_NOTICE_MUTATION_KEY,
    mutationFn: (req: CustomerNoticeUpdateRequest) =>
      api.put<MutationOkResponse>("/api/admin/settings/customer-notice", req),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      toast.success("お知らせを更新しました");
    },
    onError: (err) => showErrorToast(err, "お知らせの更新に失敗しました"),
  });
}
