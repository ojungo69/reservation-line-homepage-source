import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { useSettingsSelect } from "./use-settings";
import { showErrorToast } from "@/lib/error-messages";
import type { Closure, ClosureCreateRequest, ClosureUpdateRequest, MutationOkResponse } from "@/types/api";

export function useClosureList(storeId: string | null) {
  const query = useSettingsSelect((d): Closure[] => {
    const closures = d?.settings?.closures ?? [];
    if (!storeId) return closures;
    return closures.filter((c) => c.storeId === storeId);
  });
  return { closureList: query.data ?? [], isPending: query.isPending };
}

export function useClosureCreate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: ClosureCreateRequest) =>
      api.post<{ ok: true; closureId: string }>("/api/admin/settings/closures", req),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      toast.success("休業日を追加しました");
    },
    onError: (err) => showErrorToast(err, "休業日の追加に失敗しました"),
  });
}

export function useClosureUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: ClosureUpdateRequest & { id: string }) =>
      api.put<MutationOkResponse>(`/api/admin/settings/closures/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      toast.success("休業日を更新しました");
    },
    onError: (err) => showErrorToast(err, "休業日の更新に失敗しました"),
  });
}

export function useClosureDelete() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.delete<MutationOkResponse>(`/api/admin/settings/closures/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      toast.success("休業日を削除しました");
    },
    onError: (err) => {
      showErrorToast(err, "休業日の削除に失敗しました");
      // 失敗時 (削除は成立したが応答が失われた 404 再試行や、別端末で先に
      // 削除・変更済みの stale 表示を含む) はサーバの現状を取り直し、
      // 消えたはずの行が一覧に残り続けるのを防ぐ。
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
  });
}
