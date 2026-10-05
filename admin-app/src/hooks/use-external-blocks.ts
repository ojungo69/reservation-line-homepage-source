import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { showErrorToast } from "@/lib/error-messages";
import type {
  ExternalBlocksResponse,
  ExternalBlockCreateRequest,
  ExternalBlockActionResponse,
} from "@/types/api";

const EXTERNAL_BLOCKS_KEY = ["external-blocks"] as const;

export function useExternalBlocks() {
  return useQuery({
    queryKey: EXTERNAL_BLOCKS_KEY,
    queryFn: () =>
      api.get<ExternalBlocksResponse>("/api/admin/external-blocks"),
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always",
  });
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
