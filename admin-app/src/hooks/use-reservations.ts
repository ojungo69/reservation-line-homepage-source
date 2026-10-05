import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api-client";
import { showErrorToast } from "@/lib/error-messages";
import {
  endReservationAction,
  tryBeginReservationAction,
} from "@/lib/reservation-action-lock";
import { RESERVATION_ACTION_MUTATION_KEY } from "@/lib/pending-mutation-ids";
import type {
  ReservationsResponse,
  PendingReservationsResponse,
  ReservationDetailResponse,
  ReservationAction,
  AvailableSlotsResponse,
  MutationOkResponse,
  CreateReservationPayload,
} from "@/types/api";

export function useReservations(date: string) {
  // 取得は range=date のみで全店舗分を返し、店舗フィルタは呼び出し側で行う。
  // storeId を queryKey に含めると WeekView が店舗切替ごとに 7 リクエストを
  // 無駄に再発行してしまうため、キーは date のみにする。
  return useQuery({
    queryKey: ["reservations", date],
    queryFn: () =>
      api.get<ReservationsResponse>(
        `/api/admin/reservations?range=date&date=${date}`,
      ),
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always",
  });
}

export function usePendingReservations() {
  return useQuery({
    queryKey: ["reservations", "pending"],
    queryFn: () =>
      api.get<PendingReservationsResponse>("/api/admin/reservations/pending"),
    staleTime: 30_000,
    // 全予約承認制ではこの一覧が Web 予約の唯一の受付窓口 (既存客の承認待ちは
    // LINE 通知なし・24h で自動失効)。開きっぱなしの画面でも新着に気づけるよう
    // ポーリングする (グローバル既定は refetchOnWindowFocus:false のため必須。
    // use-sync-status.ts と同じ間隔)。
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always",
  });
}

export function useReservationDetail(id: string | null) {
  return useQuery({
    queryKey: ["reservations", "detail", id],
    queryFn: () =>
      api.get<ReservationDetailResponse>(`/api/admin/reservations/${id}`),
    enabled: !!id,
    staleTime: 15_000,
  });
}

export function useReservationAction() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: RESERVATION_ACTION_MUTATION_KEY,
    mutationFn: async ({
      reservationId,
      action,
      reason,
      expectedVersion,
    }: {
      reservationId: string;
      action: ReservationAction;
      reason?: string;
      // 楽観ロック。訂正 (correct-no-show / restore-completed) では backend が
      // 必須にしているため、渡さないと必ず 400 になる。
      expectedVersion?: number;
    }) => {
      // 一括承認の実行中、または同一予約の単件操作が in-flight の間は開始しない
      // (同一予約への approve/reject 並行送信で先着勝ちの意図反転が起きる)。
      // 全単件操作はこの hook を通るため、どのページの入口でもここ1箇所で遮断される。
      // 確認と in-flight 登録は tryBeginReservationAction 内で原子的に行う。
      const rejection = tryBeginReservationAction(reservationId);
      if (rejection) {
        throw new ApiError(409, { reason: rejection });
      }
      try {
        return await api.post(`/api/admin/reservations/${reservationId}/${action}`, {
          idempotencyKey: crypto.randomUUID(),
          reason: reason ?? "",
          ...(expectedVersion === undefined ? {} : { expectedVersion }),
        });
      } finally {
        endReservationAction(reservationId);
      }
    },
    onSuccess: () => {
      toast.success("操作を実行しました");
    },
    onError: (err) => showErrorToast(err),
    // onSuccess ではなく onSettled で無効化する。stale_snapshot (409) は onError に
    // 入るため、成功時だけ再取得すると「競合しました」と言われた画面が古い version を
    // 掴んだままになり、再操作もまた 409 になる。
    // customers も落とすのは、訂正が customer_visits を動かして顧客一覧の visitCount /
    // lastVisitAt とスケジュール側の valid_visit_count (新規/既存判定) に効くため。
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["reservations"] });
      queryClient.invalidateQueries({ queryKey: ["customers"] });
    },
  });
}

export function useReservationCancellationFee() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      reservationId,
      unpaid,
    }: {
      reservationId: string;
      unpaid: boolean;
    }) =>
      api.put<MutationOkResponse>(
        `/api/admin/reservations/${reservationId}/cancellation-fee`,
        { unpaid },
      ),
    onSuccess: (_d, vars) => {
      queryClient.invalidateQueries({ queryKey: ["reservations"] });
      toast.success(vars.unpaid ? "キャンセル料未納にしました" : "入金済みにしました");
    },
    onError: (err) => showErrorToast(err, "キャンセル料の更新に失敗しました"),
  });
}

export function useUpdateTreatmentNotes() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      customerId,
      visitId,
      ...body
    }: {
      customerId: string;
      visitId: string;
      treatmentNotes: string | null;
      expectedTreatmentNotes?: string | null;
    }) =>
      api.put(`/api/admin/customers/${customerId}/visits/${visitId}/notes`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reservations"] });
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      toast.success("施術メモを保存しました");
    },
    onError: (err) => showErrorToast(err, "施術メモの保存に失敗しました"),
  });
}

// 判別 union で2モードを型レベルでも排他にする（サーバは併用を 400 で拒否）:
// - reschedule 照会: excludeReservationId のみ。resource / duration / customer は
//   サーバが予約行から導出するため他のオプションは渡せない（never）。
// - create / legacy 照会: excludeReservationId 無し。customerId は既存客モードで
//   顧客の他店舗/他リソース予約と重なる枠を候補から除外する。
export type AvailableSlotsOptions =
  | {
      excludeReservationId: string;
      durationMinutes?: never;
      resourceId?: never;
      customerId?: never;
    }
  | {
      excludeReservationId?: never;
      durationMinutes?: number;
      resourceId?: string | null;
      customerId?: string | null;
    };

// オプションはオブジェクトで受ける（位置引数の undefined 並べは配線ミスの温床）。
// queryKey と URL は同じ正規化済み値から組み立てる。
export function useAvailableSlots(
  storeId: string | null,
  date: string | null,
  options: AvailableSlotsOptions = {},
) {
  const durationMinutes = options.durationMinutes;
  const resourceId = options.resourceId ?? null;
  const excludeReservationId = options.excludeReservationId ?? null;
  const customerId = options.customerId ?? null;

  const params = new URLSearchParams();
  if (storeId) params.set("storeId", storeId);
  if (date) params.set("date", date);
  if (durationMinutes) params.set("durationMinutes", String(durationMinutes));
  if (resourceId) params.set("resourceId", resourceId);
  if (excludeReservationId) params.set("excludeReservationId", excludeReservationId);
  if (customerId) params.set("customerId", customerId);

  return useQuery({
    queryKey: [
      "reservations",
      "available-slots",
      storeId,
      date,
      durationMinutes ?? null,
      resourceId,
      excludeReservationId,
      customerId,
    ],
    queryFn: () =>
      api.get<AvailableSlotsResponse>(
        `/api/admin/reservations/available-slots?${params.toString()}`,
      ),
    enabled: !!storeId && !!date,
    staleTime: 15_000,
  });
}

export function useCreateReservation() {
  const queryClient = useQueryClient();

  return useMutation({
    // idempotencyKey は呼び出し元 (ReservationCreatePanel) の ref から渡される。
    // ここで毎回 randomUUID() すると、応答喪失後の手動リトライが別キー扱いになり
    // replay されず、作成成功済みでも slot_unavailable の偽エラーになる。
    mutationFn: (data: CreateReservationPayload) =>
      api.post("/api/admin/reservations", {
        source: "phone_admin" as const,
        ...data,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reservations"] });
      toast.success("予約を作成しました");
    },
    onError: (err) => showErrorToast(err, "予約作成に失敗しました"),
  });
}

export function useRescheduleReservation() {
  const queryClient = useQueryClient();

  return useMutation({
    // idempotencyKey は呼び出し元 (ReservationRescheduleDialog) の ref から渡される
    // （応答喪失後の手動リトライで同じキーを再送すれば replay される。useCreateReservation と同じ理由）。
    mutationFn: ({
      reservationId,
      startAt,
      idempotencyKey,
      treatmentMinutes,
    }: {
      reservationId: string;
      startAt: string;
      idempotencyKey: string;
      treatmentMinutes?: number;
    }) =>
      api.post(`/api/admin/reservations/${reservationId}/reschedule`, {
        idempotencyKey,
        startAt,
        ...(treatmentMinutes !== undefined ? { treatmentMinutes } : {}),
      }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["reservations"] });
      toast.success(
        variables.treatmentMinutes !== undefined ? "施術時間を変更しました" : "予約時間を変更しました",
      );
    },
    onError: (err) => showErrorToast(err, "変更に失敗しました"),
  });
}
