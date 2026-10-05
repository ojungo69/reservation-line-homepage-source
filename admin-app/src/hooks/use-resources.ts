import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { useSettingsSelect } from "./use-settings";
import { showErrorToast } from "@/lib/error-messages";
import type { Resource, ResourceCreateRequest, ResourceUpdateRequest, MutationOkResponse } from "@/types/api";

export function useResourceList(storeId: string | null) {
  const query = useSettingsSelect((d): Resource[] => {
    const resources = d?.settings?.resources ?? [];
    if (!storeId) return resources;
    return resources.filter((r) => r.storeId === storeId);
  });
  return { resourceList: query.data ?? [], isPending: query.isPending };
}

export function useResourceCreate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: ResourceCreateRequest) =>
      api.post<{ ok: true; resourceId: string }>("/api/admin/settings/resources", req),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      toast.success("リソースを追加しました");
    },
    onError: (err) => showErrorToast(err, "リソースの追加に失敗しました"),
  });
}

export function useResourceUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: ResourceUpdateRequest & { id: string }) =>
      api.put<MutationOkResponse>(`/api/admin/settings/resources/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      toast.success("リソースを更新しました");
    },
    onError: (err) => showErrorToast(err, "リソースの更新に失敗しました"),
  });
}

export function useResourceDelete() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.delete<MutationOkResponse>(`/api/admin/settings/resources/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      toast.success("リソースを削除しました");
    },
    onError: (err) => showErrorToast(err, "リソースの削除に失敗しました"),
  });
}
