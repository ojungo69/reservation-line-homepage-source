import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { useSettingsSelect } from "./use-settings";
import { showErrorToast } from "@/lib/error-messages";
import { RESERVATION_CAP_MUTATION_KEY } from "@/lib/pending-mutation-ids";
import type { Store, ReservationCapUpdateRequest, MutationOkResponse } from "@/types/api";

// The cap lives on the per-store settings snapshot (store_settings). Reuse the
// shared ["settings"] query so this stays in sync with the other settings tabs.
export function useReservationCaps() {
  const query = useSettingsSelect((d): Store[] => d?.settings?.stores ?? []);
  return { stores: query.data ?? [], isPending: query.isPending };
}

export function useReservationCapUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: RESERVATION_CAP_MUTATION_KEY,
    mutationFn: (req: ReservationCapUpdateRequest) =>
      api.put<MutationOkResponse>("/api/admin/settings/reservation-cap", req),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      toast.success("1人あたりの予約上限を更新しました");
    },
    onError: (err) => showErrorToast(err, "予約上限の更新に失敗しました"),
  });
}
