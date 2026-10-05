import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { showErrorToast } from "@/lib/error-messages";
import type {
  LineFriendsResponse,
  LineFriendSyncResponse,
  LineFriendsFilter,
  LinkLineFriendRequest,
  CustomerSearchResponse
} from "@/types/api";

export function useLineFriends(params: { filter: LineFriendsFilter; q: string; page: number; enabled?: boolean }) {
  const query = useQuery({
    queryKey: ["line-friends", params.filter, params.q, params.page],
    queryFn: () => {
      const qs = new URLSearchParams({ filter: params.filter, page: String(params.page) });
      if (params.q.trim()) qs.set("q", params.q.trim());
      return api.get<LineFriendsResponse>(`/api/admin/line-friends?${qs.toString()}`);
    },
    // Default true keeps the line-friends page behaviour; the card dialog passes
    // false until a search term is entered so it does not fetch the full list.
    enabled: params.enabled ?? true,
    placeholderData: keepPreviousData,
    staleTime: 30_000
  });
  return {
    items: query.data?.items ?? [],
    total: query.data?.total ?? 0,
    pageSize: query.data?.pageSize ?? 50,
    isPending: query.isPending,
    // keepPreviousData keeps stale items during a refetch; isFetching lets callers
    // hide them while a new search term is loading (avoids clicking a no-longer-matching row).
    isFetching: query.isFetching,
    isError: query.isError
  };
}

export function useLineFriendSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<LineFriendSyncResponse>("/api/admin/line-friends/sync"),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["line-friends"] });
      toast.success(
        res.pending > 0
          ? `同期しました（取得済み ${res.fetched} / 残り ${res.pending} 件）。残りはもう一度「同期」を押してください。`
          : `同期しました（友だち ${res.totalFriends} 名・取得済み ${res.fetched} 名）。`
      );
      if (res.failed > 0) {
        toast.warning(
          `${res.failed} 件のプロフィール取得に失敗しました。LINEの連携設定（トークン等）をご確認のうえ、もう一度お試しください。`
        );
      }
    },
    onError: (err) => showErrorToast(err, "LINE友だちの同期に失敗しました")
  });
}

export function useLineFriendLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { lineUserId: string; body: LinkLineFriendRequest }) =>
      api.post<{ ok: true; customerId: string }>(
        `/api/admin/line-friends/${encodeURIComponent(vars.lineUserId)}/link`,
        vars.body
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["line-friends"] });
      // link は customers(新規)/line_identities を作るため、顧客一覧・検索キャッシュも
      // 無効化して古い顧客状態が残らないようにする。
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["customer-search"] });
      toast.success("紐付けました");
    },
    onError: (err) => showErrorToast(err, "紐付けに失敗しました")
  });
}

// 既存顧客検索（紐付けダイアログ用）。GET /customers?q= を流用。
export function useCustomerSearch(q: string) {
  const query = useQuery({
    queryKey: ["customer-search", q],
    queryFn: () => api.get<CustomerSearchResponse>(`/api/admin/customers?q=${encodeURIComponent(q)}`),
    enabled: q.trim().length >= 1,
    staleTime: 30_000
  });
  return { results: query.data?.customers ?? [], isPending: query.isFetching };
}
