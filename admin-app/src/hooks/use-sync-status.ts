import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { showErrorToast } from "@/lib/error-messages";
import type { SyncStatusResponse, MutationOkResponse } from "@/types/api";

const SYNC_KEY = ["sync-status"] as const;

export function useSyncStatus(enabled = true) {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: SYNC_KEY,
    enabled,
    queryFn: ({ signal }) => api.get<SyncStatusResponse>("/api/admin/sync/status", { signal }),
    refetchInterval: 30_000,
    refetchOnWindowFocus: "always",
  });

  return { syncStatus: data ?? null, isPending, isError, error, refetch };
}

export function useSyncJobRetry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { jobId: string; source: string; idempotencyKey: string }) =>
      api.post<MutationOkResponse>("/api/admin/sync/jobs/retry", params),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SYNC_KEY });
      toast.success("リトライを開始しました");
    },
    onError: (err) => showErrorToast(err, "リトライに失敗しました"),
  });
}

export function useSyncJobAcknowledge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { jobId: string; source: string; idempotencyKey: string; note: string }) =>
      api.post<MutationOkResponse>("/api/admin/sync/jobs/acknowledge", params),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SYNC_KEY });
      toast.success("確認済みにしました");
    },
    onError: (err) => showErrorToast(err, "確認済みにできませんでした"),
  });
}

type ConflictActionPath =
  | `conflicts/${string}/ignore`
  | `conflicts/${string}/manual-resolve`
  | `conflicts/${string}/approve-cancel`
  | `conflicts/${string}/reject-delete`
  | `all-day-candidates/${string}/approve`
  | `all-day-candidates/${string}/reject`;

export function useConflictAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { path: ConflictActionPath; body: Record<string, unknown> }) =>
      api.post<MutationOkResponse>(`/api/admin/sync/${params.path}`, params.body),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: SYNC_KEY });
      if (variables.path.includes("approve-cancel") || variables.path.includes("reject-delete")) {
        qc.invalidateQueries({ queryKey: ["reservations"] });
      }
      if (variables.path.includes("all-day-candidates")) {
        qc.invalidateQueries({ queryKey: ["settings"] });
      }
      toast.success("競合を処理しました");
    },
    onError: (err) => showErrorToast(err, "競合の処理に失敗しました"),
  });
}

export function useGoogleEditMode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { storeId: string; enabled: boolean }) =>
      api.put<{ ok: true; storeId: string; enabled: boolean }>("/api/admin/settings/google-edit-mode", params),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: SYNC_KEY });
      qc.invalidateQueries({ queryKey: ["settings"] });
      toast.success(`Google編集モードを${data.enabled ? "有効" : "無効"}にしました`);
    },
    onError: (err) => showErrorToast(err, "Google編集モードの変更に失敗しました"),
  });
}
