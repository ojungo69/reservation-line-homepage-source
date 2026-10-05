import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { showErrorToast } from "@/lib/error-messages";
import { useAuth } from "@/hooks/use-auth";
import type {
  CustomerListResponse,
  CustomerSearchResponse,
  CustomerDetailResponse,
  CustomerConsentsPageResponse,
  CustomerVisitsPageResponse,
  CustomerReservationsPageResponse,
  MergeCandidatesResponse,
  CustomerMergeResponse,
  CustomerDeleteResponse,
  AddCustomerVisitRequest,
  UpdateCustomerVisitRequest,
  CreateCustomerRequest,
  CreateCustomerResponse,
} from "@/types/api";

export function useCustomerList(
  offset: number,
  archivedOnly = false,
  storeId: string | null = null,
) {
  return useQuery({
    queryKey: ["customers", "list", offset, archivedOnly, storeId],
    queryFn: () => {
      const storeParam = storeId ? `&store=${encodeURIComponent(storeId)}` : "";
      return api.get<CustomerListResponse>(
        `/api/admin/customers?mode=list&offset=${offset}${archivedOnly ? "&view=archived" : ""}${storeParam}`,
      );
    },
    staleTime: 30_000,
    // 顧客タブの承認 (spec 008) は 12 時間で切れるが、QueryClient は
    // refetchOnWindowFocus: false なので、開いたままのタブは期限が過ぎても一覧を描画した
    // ままになる。取得済みのデータとはいえ「12 時間で閉じる」と言っている以上、定期的に
    // 取り直して 403 を踏ませる。
    // refetchIntervalInBackground は既定の false のままなので、正確には「タブに戻ってきて
    // から最大 5 分後に閉じる」。裏に回ったタブが描いたままなのは画面だけで、API は毎回
    // サーバー側で拒否する。
    // ponytail: 5 分間隔のポーリング。期限ちょうどに閉じたければ grantedUntil を応答に
    // 載せて一発のタイマーにするが、そのために API の表面を増やすほどの精度は要らない。
    // **顧客詳細を開いている間も止めない。** 止めると、パネルを開いたままにするだけで
    // 承認の失効に気付かない時間をいくらでも延ばせる (#651 の P1)。書きかけが消える件
    // (#652-3) はこちらを止める理由にはしない — 承認が切れている以上その保存はサーバー側でも
    // 弾かれるので、消えないようにしても保存はできない。判断は
    // `admin-app/src/pages/customers.test.tsx` の「顧客詳細を開いても承認失効のポーリングは
    // 止めない」で固定してある。
    refetchInterval: 5 * 60_000,
    // Keep the previous page only across offset (pagination) changes for the SAME
    // store + archived filter. When the store filter or archived view changes the
    // query key, drop the placeholder so we never briefly render (and allow editing
    // of) another store's customers under the new filter with no loading state.
    // queryKey = ["customers", "list", offset, archivedOnly, storeId]. (codex PR#375)
    placeholderData: (prev, prevQuery) => {
      const prevKey = prevQuery?.queryKey as
        | readonly [string, string, number, boolean, string | null]
        | undefined;
      return prevKey?.[3] === archivedOnly && prevKey?.[4] === storeId
        ? prev
        : undefined;
    },
  });
}

export function useCustomerSearch(query: string, storeId: string | null = null) {
  return useQuery({
    queryKey: ["customers", "search", query, storeId],
    queryFn: () => {
      const storeParam = storeId ? `&store=${encodeURIComponent(storeId)}` : "";
      return api.get<CustomerSearchResponse>(
        `/api/admin/customers?q=${encodeURIComponent(query)}${storeParam}`,
      );
    },
    enabled: query.length >= 2,
    staleTime: 15_000,
  });
}

export function useMergeCandidates() {
  const { isPrivileged } = useAuth();
  return useQuery({
    queryKey: ["customers", "merge-candidates"],
    queryFn: () =>
      api.get<MergeCandidatesResponse>("/api/admin/customers/merge-candidates"),
    enabled: isPrivileged,
    staleTime: 30_000,
  });
}

export function useCustomerDetail(customerId: string | null) {
  return useQuery({
    queryKey: ["customers", "detail", customerId],
    queryFn: () =>
      api.get<CustomerDetailResponse>(`/api/admin/customers/${customerId}`),
    enabled: !!customerId,
    staleTime: 15_000,
  });
}

// 来店履歴の続きを 1 ページ取る。顧客詳細のキャッシュには載せない — 詳細が再取得
// されたときに追加ぶんだけ残ると、件数と並びが噛み合わなくなるため。読み込んだ
// ぶんは呼び出し側が持ち、パネルを閉じれば消える。
export function useCustomerVisitsPage() {
  return useMutation({
    mutationFn: ({ customerId, offset }: { customerId: string; offset: number }) =>
      api.get<CustomerVisitsPageResponse>(
        `/api/admin/customers/${customerId}/visits?offset=${offset}`,
      ),
    onError: (err) => showErrorToast(err, "来店履歴の読み込みに失敗しました"),
  });
}

export function useCustomerReservationsPage() {
  return useMutation({
    mutationFn: ({ customerId, offset }: { customerId: string; offset: number }) =>
      api.get<CustomerReservationsPageResponse>(`/api/admin/customers/${customerId}/reservations?offset=${offset}`),
    onError: (err) => showErrorToast(err, "予約履歴の読み込みに失敗しました"),
  });
}

export function useCustomerConsentsPage() {
  return useMutation({
    mutationFn: ({ customerId, offset }: { customerId: string; offset: number }) =>
      api.get<CustomerConsentsPageResponse>(
        `/api/admin/customers/${customerId}/consents?offset=${offset}`,
      ),
    onError: (err) => showErrorToast(err, "同意履歴の読み込みに失敗しました"),
  });
}

export function useCustomerMemoUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ customerId, ...body }: { customerId: string; memo: string | null; expectedMemo?: string | null }) =>
      api.put(`/api/admin/customers/${customerId}/memo`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      // 顧客メモは予約詳細の「顧客情報」にも出るので reservations も無効化する
      // （useVisitNotesUpdate / useCustomerProfileUpdate と同じ理由。これが無いと
      // 開きっぱなしの予約詳細が staleTime の間だけ古いメモを出し続ける）。
      qc.invalidateQueries({ queryKey: ["reservations"] });
      toast.success("顧客メモを保存しました");
    },
    onError: (err) => showErrorToast(err, "顧客メモの保存に失敗しました"),
  });
}

export function useCustomerReferrerUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ customerId, ...body }: {
      customerId: string;
      referrerName: string | null;
      expectedReferrerName: string | null;
    }) => api.put(`/api/admin/customers/${customerId}/referrer`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      toast.success("紹介者を保存しました");
    },
    onError: (err) => showErrorToast(err, "紹介者の保存に失敗しました"),
  });
}

export function useCustomerProfileUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      customerId,
      ...fields
    }: {
      customerId: string;
      displayName?: string;
      displayNameKana?: string | null;
      phone?: string | null;
      birthDate?: string | null;
      gender?: string | null;
      allergyNotes?: string | null;
    }) => api.patch(`/api/admin/customers/${customerId}/profile`, fields),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      // 顧客名・電話はスケジュール／予約一覧の表示にも出るため reservations も無効化。
      qc.invalidateQueries({ queryKey: ["reservations"] });
      toast.success("顧客情報を更新しました");
    },
    onError: (err) => showErrorToast(err, "顧客情報の更新に失敗しました"),
  });
}

export function useCustomerBlockAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      customerId,
      action,
    }: {
      customerId: string;
      action: "block" | "unblock";
    }) =>
      api.post(`/api/admin/customers/${customerId}/${action}`, {
        idempotencyKey: crypto.randomUUID(),
        reason: "",
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      toast.success(vars.action === "block" ? "ブロックしました" : "ブロック解除しました");
    },
    onError: (err, vars) =>
      showErrorToast(
        err,
        vars.action === "block" ? "ブロックに失敗しました" : "ブロック解除に失敗しました",
      ),
  });
}

export function useCustomerMerge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sourceId, targetId }: { sourceId: string; targetId: string }) =>
      api.post<CustomerMergeResponse>(
        `/api/admin/customers/${sourceId}/merge`,
        { targetId },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      toast.success("顧客を統合しました");
    },
    onError: (err) => showErrorToast(err, "顧客の統合に失敗しました"),
  });
}

export function useVisitNotesUpdate() {
  const qc = useQueryClient();
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
      qc.invalidateQueries({ queryKey: ["customers"] });
      // 同じ施術メモはスケジュールの予約詳細でも表示されるため
      // ["reservations"] も無効化する（use-reservations の
      // useUpdateTreatmentNotes と対称。これが無いと予約詳細が
      // staleTime の間だけ古いメモを表示し続ける）。
      qc.invalidateQueries({ queryKey: ["reservations"] });
      toast.success("施術メモを保存しました");
    },
    onError: (err) => showErrorToast(err, "施術メモの保存に失敗しました"),
  });
}

export function useCustomerArchiveAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      customerId,
      action,
    }: {
      customerId: string;
      action: "archive" | "unarchive";
    }) =>
      api.post(`/api/admin/customers/${customerId}/${action}`, {
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      toast.success(vars.action === "archive" ? "アーカイブしました" : "復元しました");
    },
    onError: (err, vars) =>
      showErrorToast(
        err,
        vars.action === "archive" ? "アーカイブに失敗しました" : "復元に失敗しました",
      ),
  });
}

// Hard delete (owner+ only, irreversible). Surfaces the precise 409 reason
// (active reservation / live Google event / in-flight sync) via showErrorToast.
export function useCustomerDelete() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ customerId }: { customerId: string }) =>
      api.post<CustomerDeleteResponse>(`/api/admin/customers/${customerId}/delete`, {}),
    onSuccess: () => {
      // Deleting a customer also removes their reservations → the schedule /
      // reservations views must drop the now-deleted rows too.
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["reservations"] });
      toast.success("顧客を完全に削除しました");
    },
    onError: (err) => showErrorToast(err, "削除に失敗しました"),
  });
}

export function useAddCustomerVisit() {
  const qc = useQueryClient();
  return useMutation({
    // idempotencyKey is supplied by the caller (held in form state, stable across
    // retries) so a lost-response retry reuses the same key and does not append a
    // duplicate manual visit (which would inflate valid_visit_count). (codex advisory)
    mutationFn: ({
      customerId,
      ...rest
    }: { customerId: string } & AddCustomerVisitRequest) =>
      api.post(`/api/admin/customers/${customerId}/visits`, rest satisfies AddCustomerVisitRequest),
    onSuccess: () => {
      // 来店履歴は顧客一覧の visitCount / lastVisitAt とスケジュール側の
      // valid_visit_count（新規/既存判定）にも影響するため両方を無効化する。
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["reservations"] });
      toast.success("来店履歴を追加しました");
    },
    onError: (err) => showErrorToast(err, "来店履歴の追加に失敗しました"),
  });
}

// 来店履歴の来店日編集 (owner+, 手動 visit のみ)。idempotencyKey は編集フォームを
// 開いた時に採番して再試行間で保持する (二重送信で監査ログが重複しないように)。
export function useUpdateCustomerVisit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      customerId,
      visitId,
      ...rest
    }: { customerId: string; visitId: string } & UpdateCustomerVisitRequest) =>
      api.patch(
        `/api/admin/customers/${customerId}/visits/${visitId}`,
        rest satisfies UpdateCustomerVisitRequest,
      ),
    onSuccess: () => {
      // 来店日は顧客一覧の最終来店日／来店回数とスケジュール側の新規/既存判定に
      // 影響するため、useAddCustomerVisit と同様に両方を無効化する。
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["reservations"] });
      toast.success("来店日を更新しました");
    },
    onError: (err) => showErrorToast(err, "来店日の更新に失敗しました"),
  });
}

// 来店履歴の削除 (owner+, 手動 visit のみ)。予約由来の来店記録は削除できない
// (バックエンドが reservation_linked で 409 を返す)。
export function useDeleteCustomerVisit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ customerId, visitId }: { customerId: string; visitId: string }) =>
      api.delete(`/api/admin/customers/${customerId}/visits/${visitId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["reservations"] });
      toast.success("来店履歴を削除しました");
    },
    onError: (err) => showErrorToast(err, "来店履歴の削除に失敗しました"),
  });
}

// 顧客の手動追加 (owner+)。idempotencyKey はダイアログを開いた時に採番して
// 再試行間で保持する (二重送信で顧客が重複登録されないように)。
export function useCreateCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateCustomerRequest) =>
      api.post<CreateCustomerResponse>(
        "/api/admin/customers",
        body satisfies CreateCustomerRequest,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      toast.success("顧客を追加しました");
    },
    onError: (err) => showErrorToast(err, "顧客の追加に失敗しました"),
  });
}
