import { toast } from "sonner";
import { ApiError, ApiOutcomeUnknownError } from "./api-client";

/**
 * Admin API が返し得る error code の union。
 * backend src/admin/*.ts の `reason` / `error` フィールド値と対応する。
 * admin-app が表示メッセージを持つ subset のみ列挙する。
 * 新規 code 追加時は ERROR_MESSAGES への追加と合わせて更新する。
 */
export type ApiErrorCode =
  | "invalid_request"
  | "forbidden"
  | "not_found"
  | "invalid_transition"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "line_not_reachable"
  | "write_failed"
  | "slot_unavailable"
  | "customer_time_conflict"
  | "customer_blocked"
  | "invalid_date"
  | "range_too_large"
  | "result_too_large"
  | "invalid_range"
  | "invalid_keyword"
  | "referrer_name_too_long"
  | "notes_too_long"
  | "missing_treatment_notes"
  | "checked_in_locked"
  | "store_not_found"
  | "has_future_reservations"
  | "already_resolved"
  | "overlapping_reservations"
  | "immutable_store"
  | "forbidden_role_escalation"
  | "forbidden_self_deactivation"
  | "duplicate_email"
  | "invalid_rrule"
  | "too_many_occurrences"
  | "missing_database"
  | "not_pending"
  | "stale_snapshot"
  | "outside_business_hours"
  | "store_closed"
  | "resource_not_available"
  | "service_not_available"
  | "invalid_time"
  | "same_customer"
  | "already_merged"
  | "target_already_merged"
  | "source_blocked"
  | "phone_hash_mismatch"
  | "already_linked"
  | "friend_not_found"
  | "friend_not_fetched"
  | "line_api_error"
  | "customer_not_found"
  | "email_in_use"
  | "has_active_reservations"
  | "has_active_google_events"
  | "has_pending_google_sync"
  | "has_open_google_conflicts"
  | "has_pending_notifications"
  | "integrity_conflict"
  | "invalid_display_name"
  | "invalid_display_name_kana"
  | "invalid_phone"
  | "rate_limited"
  | "customer_gate_required"
  | "gate_email_failed"
  | "owner_email_unset"
  | "invalid_code"
  | "conflict"
  | "bulk_in_progress";

/**
 * オブジェクトリテラルは `satisfies` で `ApiErrorCode` の subset であることを強制し、
 * typo や不要キーをコンパイル時に検出する。
 * 呼び出し側からは下の `ERROR_MESSAGE_LOOKUP` 経由で string 引数でアクセスする。
 */
const ERROR_MESSAGES = {
  invalid_request: "入力内容に誤りがあります",
  customer_gate_required: "顧客情報を開くには、オーナーに届く確認コードの入力が必要です",
  gate_email_failed: "確認コードのメールを送信できませんでした。時間をおいてもう一度お試しください",
  owner_email_unset: "オーナーの通知先メールアドレスが設定されていないため、確認コードを発行できません",
  invalid_code: "確認コードが正しくないか、有効期限が切れています",
  forbidden: "権限がありません",
  not_found: "対象が見つかりません",
  invalid_transition: "この操作は現在の状態では実行できません",
  idempotency_conflict: "同じ操作が既に実行されています",
  idempotency_in_progress: "同じ操作を処理中です",
  line_not_reachable: "LINEに到達できません",
  write_failed: "保存に失敗しました",
  slot_unavailable: "選択した時間帯は既に埋まっています",
  customer_time_conflict: "同じ時間帯に既に予約があります",
  customer_blocked: "ブロック中の顧客です",
  invalid_date: "日付が正しくありません",
  range_too_large: "期間が大きすぎます",
  result_too_large: "対象件数が多すぎます。期間や絞り込み条件を狭めてください",
  invalid_range: "開始日と終了日の指定が正しくありません",
  invalid_keyword: "検索キーワードが正しくありません",
  referrer_name_too_long: "紹介者名は120文字以内で入力してください",
  notes_too_long: "メモは2000文字以内で入力してください",
  missing_treatment_notes: "施術メモを入力してください",
  checked_in_locked: "来店済みの予約は時刻変更できません",
  store_not_found: "店舗が見つかりません",
  has_future_reservations: "将来の予約があるため削除できません",
  already_resolved: "既に解決済みです",
  overlapping_reservations: "対象の時間帯に予約が入っているため実行できません。先に予約を移動またはキャンセルしてください",
  immutable_store: "店舗の変更はできません",
  forbidden_role_escalation: "この権限変更は許可されていません",
  forbidden_self_deactivation: "自分自身を無効化することはできません",
  duplicate_email: "このメールアドレスは既に使用されています",
  invalid_rrule: "繰り返しルールが正しくありません",
  too_many_occurrences: "生成される件数が多すぎます",
  missing_database: "システムエラーが発生しました",
  not_pending: "この申請は既に処理済みです",
  stale_snapshot: "情報が更新されたため処理できません。再読み込みしてください",
  outside_business_hours: "営業時間外の時間帯です",
  store_closed: "休業日のため処理できません",
  resource_not_available: "選択したリソースは利用できません",
  service_not_available: "選択されたメニューは現在ご利用いただけません。メニューを選び直してください",
  invalid_time: "日時が正しくありません",
  same_customer: "同じ顧客同士は統合できません",
  already_merged: "この顧客は既に統合済みです",
  target_already_merged: "統合先の顧客が既に統合済みです。最新の候補で再度お試しください",
  source_blocked: "ブロック中の顧客は統合元にできません。先にブロックを解除してください",
  phone_hash_mismatch: "電話番号が一致しないため統合できません",
  already_linked: "この友だちは既に紐付け済みです",
  friend_not_found: "対象の友だちが見つかりません。先に「友だちを同期」してください",
  friend_not_fetched: "プロフィール未取得の友だちは紐付けできません。先に「友だちを同期」してください",
  line_api_error: "LINEとの通信に失敗しました。時間をおいて再度お試しください",
  customer_not_found: "対象の顧客が見つかりません",
  email_in_use: "このメールアドレスは別のログインで使用中です",
  has_active_reservations: "確定済み・未来の予約があるため完全削除できません。先に予約を取り消すか、アーカイブをご利用ください",
  has_active_google_events: "Googleカレンダーに連携中の予約があるため完全削除できません。アーカイブをご利用ください",
  has_pending_google_sync: "Googleカレンダー連携の処理中です。少し時間をおいて再度お試しください",
  has_open_google_conflicts: "未解決のGoogleカレンダー競合があるため完全削除できません。先に競合を解決してください",
  has_pending_notifications: "LINE通知の送信処理中です。少し時間をおいて再度お試しください",
  integrity_conflict: "この顧客のデータに不整合があり、安全に削除できません。サポートにご連絡ください",
  invalid_display_name: "名前を入力してください",
  invalid_display_name_kana: "フリガナが正しくありません",
  invalid_phone: "電話番号の形式が正しくありません",
  rate_limited: "操作が集中しています。少し時間をおいて再度お試しください",
  conflict: "他の操作と競合しました。少し時間をおいて再度お試しください",
  bulk_in_progress: "一括承認を実行中です。完了までお待ちください",
} satisfies Partial<Record<ApiErrorCode, string>>;

/**
 * 任意 string キーでルックアップするための widened ビュー。
 * `ERROR_MESSAGES` 自身は `satisfies` で typo 検出を維持し、
 * このエイリアスは index access 時の型キャストを不要にするためだけに使う。
 */
const ERROR_MESSAGE_LOOKUP: Record<string, string | undefined> = ERROR_MESSAGES;
const UNKNOWN_OUTCOME_MESSAGE = "処理結果を確認できません。重複操作を避けるため、最新の状態を確認してから操作してください";

export function errorMessage(code: string): string {
  return ERROR_MESSAGE_LOOKUP[code] ?? code;
}

/**
 * toast を出さずにエラーの日本語メッセージだけ得る (一括承認の結果一覧用)。
 * ApiError 以外 (通信断など) は英語の "Failed to fetch" を露出させず固定文言にする。
 */
export function actionErrorMessage(err: unknown): string {
  if (err instanceof ApiOutcomeUnknownError) return UNKNOWN_OUTCOME_MESSAGE;
  if (err instanceof ApiError) {
    const body = err.body as { reason?: string; error?: string } | null;
    const code = body?.reason ?? body?.error ?? "";
    return ERROR_MESSAGE_LOOKUP[code] ?? "操作に失敗しました";
  }
  return "通信に失敗しました";
}

export function showErrorToast(err: unknown, fallback = "操作に失敗しました") {
  if (err instanceof ApiOutcomeUnknownError) {
    toast.error(UNKNOWN_OUTCOME_MESSAGE);
  } else if (err instanceof ApiError) {
    const body = err.body as { reason?: string; error?: string } | null;
    const code = body?.reason ?? body?.error ?? "";
    toast.error(ERROR_MESSAGE_LOOKUP[code] ?? fallback);
  } else {
    toast.error(fallback);
  }
}
