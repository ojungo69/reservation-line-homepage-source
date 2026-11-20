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
  // 一度も取得できていない間は resourceList が [] になり「枠が 0 件」と区別できないので、データの有無を示す。
  // 取り直しの間と取り直しの失敗では前のデータが残るので、true のまま。
  return { resourceList: query.data ?? [], isPending: query.isPending, isLoaded: query.data !== undefined };
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
    // 画面からの更新は無効化だけが将来の予約で断られる（共通の文言は削除向け）。
    onError: (err) =>
      showErrorToast(err, "リソースの更新に失敗しました", {
        has_future_reservations: "将来の予約があるため無効化できません",
      }),
  });
}
