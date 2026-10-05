import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { useSettingsSelect } from "./use-settings";
import { showErrorToast } from "@/lib/error-messages";
import { BOOKING_WINDOW_MUTATION_KEY } from "@/lib/pending-mutation-ids";
import type { Store, BookingWindowUpdateRequest, MutationOkResponse } from "@/types/api";

// The booking window lives on the per-store settings snapshot (store_settings).
// Reuse the shared ["settings"] query so this stays in sync with the other
// settings tabs (same pattern as use-reservation-cap).
export function useBookingWindows() {
  const query = useSettingsSelect((d): Store[] => d?.settings?.stores ?? []);
  return { stores: query.data ?? [], isPending: query.isPending };
}

export function useBookingWindowUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: BOOKING_WINDOW_MUTATION_KEY,
    mutationFn: (req: BookingWindowUpdateRequest) =>
      api.put<MutationOkResponse>("/api/admin/settings/booking-window", req),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      toast.success("予約受付期間を更新しました");
    },
    onError: (err) => showErrorToast(err, "予約受付期間の更新に失敗しました"),
  });
}
