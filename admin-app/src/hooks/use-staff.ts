import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { useSettingsSelect } from "./use-settings";
import { showErrorToast } from "@/lib/error-messages";
import type {
  StaffCreateRequest,
  StaffCreateResponse,
  StaffUpdateRequest,
  MutationOkResponse,
  StaffMember,
} from "@/types/api";

export function useStaffList(storeId: string | null) {
  const query = useSettingsSelect((d): StaffMember[] => {
    const staff = d?.settings?.staff ?? [];
    if (!storeId) return staff;
    return staff.filter((s) => s.storeId === storeId);
  });
  return { staffList: query.data ?? [], isPending: query.isPending, isError: query.isError };
}

export function useStaffCreate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: StaffCreateRequest) =>
      api.post<StaffCreateResponse>("/api/admin/settings/staff", req),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      toast.success("スタッフを追加しました");
    },
    onError: (err) => showErrorToast(err, "スタッフの追加に失敗しました"),
  });
}

export function useStaffUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: StaffUpdateRequest & { id: string }) =>
      api.put<MutationOkResponse>(`/api/admin/settings/staff/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      toast.success("スタッフを更新しました");
    },
    onError: (err) => showErrorToast(err, "スタッフの更新に失敗しました"),
  });
}

export function useStaffDelete() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.delete<MutationOkResponse>(`/api/admin/settings/staff/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      toast.success("スタッフを無効化しました");
    },
    onError: (err) => showErrorToast(err, "スタッフの無効化に失敗しました"),
  });
}
