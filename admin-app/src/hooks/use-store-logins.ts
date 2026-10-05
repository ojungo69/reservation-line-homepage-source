import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { showErrorToast } from "@/lib/error-messages";
import type {
  StoreLoginsResponse,
  StoreLogin,
  StoreLoginUpsertRequest,
  MutationOkResponse,
} from "@/types/api";

export function useStoreLogins() {
  const q = useQuery({
    queryKey: ["store-logins"],
    queryFn: () => api.get<StoreLoginsResponse>("/api/admin/store-logins"),
    staleTime: 60_000,
    select: (d): StoreLogin[] => d.storeLogins,
  });
  return { storeLogins: q.data ?? [], isPending: q.isPending, isError: q.isError };
}

export function useStoreLoginUpsert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: StoreLoginUpsertRequest) =>
      api.post<MutationOkResponse>("/api/admin/store-logins", req),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["store-logins"] });
      toast.success("店舗ログインを設定しました");
    },
    onError: (err) => showErrorToast(err, "店舗ログインの設定に失敗しました"),
  });
}

export function useStoreLoginRevoke() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (storeId: string) =>
      api.delete<MutationOkResponse>(`/api/admin/store-logins/${storeId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["store-logins"] });
      toast.success("店舗ログインを無効化しました");
    },
    onError: (err) => showErrorToast(err, "無効化に失敗しました"),
  });
}
