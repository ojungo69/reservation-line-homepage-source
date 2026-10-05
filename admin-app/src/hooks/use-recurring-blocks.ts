import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { showErrorToast } from "@/lib/error-messages";
import type { RecurringPreviewRequest, RecurringPreviewResponse, RecurringCommitRequest, RecurringCommitResponse } from "@/types/api";

export function useRecurringPreview() {
  return useMutation({
    mutationFn: (req: RecurringPreviewRequest) =>
      api.post<RecurringPreviewResponse>("/api/admin/recurring/preview", req),
    onError: (err) => showErrorToast(err, "プレビューの取得に失敗しました"),
  });
}

export function useRecurringCommit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: RecurringCommitRequest) =>
      api.post<RecurringCommitResponse>("/api/admin/recurring/commit", req),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["external-blocks"] });
      qc.invalidateQueries({ queryKey: ["reservations"] });
      toast.success(`${data.createdCount}件のブロックを作成しました`);
    },
    onError: (err) => showErrorToast(err, "ブロックの作成に失敗しました"),
  });
}
