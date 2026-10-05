import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { useSettingsSelect } from "./use-settings";
import { showErrorToast } from "@/lib/error-messages";
import type {
  ServiceCreateRequest,
  ServiceCreateResponse,
  ServiceUpdateRequest,
  MutationOkResponse,
  Service,
} from "@/types/api";

export function useServiceList(storeId: string | null) {
  const query = useSettingsSelect((d): { services: Service[]; storeNames: Map<string, string> } => {
    const services = d?.settings?.services ?? [];
    const stores = d?.settings?.stores ?? [];
    const storeNames = new Map(stores.map((s) => [s.id, s.name]));
    return {
      services: storeId ? services.filter((s) => s.storeId === storeId) : services,
      storeNames,
    };
  });
  return {
    serviceList: query.data?.services ?? [],
    storeNames: query.data?.storeNames ?? new Map<string, string>(),
    isPending: query.isPending,
  };
}

export function useServiceCreate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: ServiceCreateRequest) =>
      api.post<ServiceCreateResponse>("/api/admin/settings/services", req),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      toast.success("メニューを追加しました");
    },
    onError: (err) => showErrorToast(err, "メニューの追加に失敗しました"),
  });
}

export function useServiceUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: ServiceUpdateRequest & { id: string }) =>
      api.put<MutationOkResponse>(`/api/admin/settings/services/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      toast.success("メニューを更新しました");
    },
    onError: (err) => showErrorToast(err, "メニューの更新に失敗しました"),
  });
}

export function useServiceDelete() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.delete<MutationOkResponse>(`/api/admin/settings/services/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      toast.success("メニューを削除しました");
    },
    onError: (err) => showErrorToast(err, "メニューの削除に失敗しました"),
  });
}
