import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { UnpaidCancellationFeesResponse } from "@/types/api";

// queryKey は ["reservations", ...] 配下に置く。useReservationCancellationFee の
// onSuccess が ["reservations"] を prefix で invalidate するため、入金済みにした
// 直後にこの一覧も自動で再取得される (フック側に追記は不要)。
export function useUnpaidCancellationFees() {
  return useQuery({
    queryKey: ["reservations", "unpaid-cancellation-fees"],
    queryFn: () =>
      api.get<UnpaidCancellationFeesResponse>(
        "/api/admin/reservations/unpaid-cancellation-fees",
      ),
    staleTime: 30_000,
    // 未納一覧も複数の店舗端末で同時に開かれる業務キュー。別のスタッフが入金処理
    // した行が消えないと二重に催促してしまうため、承認待ち一覧と同じ間隔で追従する
    // (グローバル既定は refetchOnWindowFocus:false のためポーリングが必須)。
    refetchInterval: 30_000,
  });
}
