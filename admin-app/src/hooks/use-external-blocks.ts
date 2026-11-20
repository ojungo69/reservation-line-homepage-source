import { queryOptions, useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { showErrorToast } from "@/lib/error-messages";
import type {
  ExternalBlocksResponse,
  ExternalBlockCreateRequest,
  ExternalBlockActionResponse,
} from "@/types/api";

const EXTERNAL_BLOCKS_KEY = ["external-blocks"] as const;

// 1 日分の外部ブロックの取得定義。新しい予定表 (specs/008) は週の 7 日を日ごとに
// 取る: 期間で 1 本にすると全店舗の週で上限 (200 件) に届きやすく、日表示と
// キャッシュも共有できないため。
export function externalBlocksQuery(dateKey: string) {
  const params = new URLSearchParams({ from: dateKey, to: dateKey, status: "active" });
  return queryOptions({
    queryKey: [...EXTERNAL_BLOCKS_KEY, dateKey],
    queryFn: () =>
      api.get<ExternalBlocksResponse>(`/api/admin/external-blocks?${params}`),
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always",
  });
}

export function useExternalBlocks(dateKey: string) {
  return useQuery(externalBlocksQuery(dateKey));
}

export function useExternalBlockCreate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: ExternalBlockCreateRequest) =>
      api.post<ExternalBlockActionResponse>("/api/admin/external-blocks", req),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: EXTERNAL_BLOCKS_KEY });
      // ブロックはスロットを占有するため空き状況にも影響する。
      qc.invalidateQueries({ queryKey: ["reservations"] });
      toast.success("ブロックを作成しました");
    },
    onError: (err) => showErrorToast(err, "ブロックの作成に失敗しました"),
  });
}

export function useExternalBlockCancel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      externalBlockId,
      reason,
    }: {
      externalBlockId: string;
      reason?: string;
    }) =>
      api.post<ExternalBlockActionResponse>(
        `/api/admin/external-blocks/${externalBlockId}/cancel`,
        {
          idempotencyKey: crypto.randomUUID(),
          ...(reason?.trim() ? { reason: reason.trim() } : {}),
        },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: EXTERNAL_BLOCKS_KEY });
      qc.invalidateQueries({ queryKey: ["reservations"] });
      toast.success("ブロックを解除しました");
    },
    onError: (err) => showErrorToast(err, "ブロックの解除に失敗しました"),
  });
}
