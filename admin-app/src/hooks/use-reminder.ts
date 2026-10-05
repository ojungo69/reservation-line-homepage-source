import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { useSettingsSelect } from "./use-settings";
import { showErrorToast } from "@/lib/error-messages";
import type { ReminderOffset, ReminderUpdateRequest, MutationOkResponse } from "@/types/api";

export function useReminderOffsets() {
  const query = useSettingsSelect((d): ReminderOffset[] => d?.settings?.reminderOffsets ?? []);
  return { offsets: query.data ?? [], isPending: query.isPending };
}

export function useReminderUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: ReminderUpdateRequest) =>
      api.put<MutationOkResponse>("/api/admin/settings/reminder", req),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      toast.success("リマインダー設定を更新しました");
    },
    onError: (err) => showErrorToast(err, "リマインダー設定の更新に失敗しました"),
  });
}
