import type { AuditLogItem } from "@/types/api";

const ACTION_LABELS: Record<string, string> = {
  approve: "予約を承認",
  reject: "予約を却下",
  block: "顧客をブロック",
  unblock: "顧客のブロック解除",
  upsert: "レコードを更新",
  delete: "レコードを削除",
  admin_customer_blocked: "顧客をブロック",
  admin_customer_unblocked: "顧客のブロック解除",
  admin_reservation_created: "予約を作成",
  admin_reservation_rescheduled: "予約をリスケジュール",
  public_reservation_duplicate_consent: "重複予約に同意",
  admin_external_block_created: "ブロック枠を作成",
  admin_external_block_cancelled: "ブロック枠をキャンセル",
  system_reservation_expired: "予約が期限切れ",
  // 顧客タブのオーナー承認 (spec 008)。ここが未登録だと、オーナーの活動ログに
  // customer_gate_verify_failed のような英語のコードがそのまま並ぶ。この活動ログは
  // 「誰かがコードを何度も間違えている」にオーナーが気付ける唯一の経路。
  customer_gate_code_requested: "顧客タブの確認コードを申請",
  customer_gate_verified: "顧客タブの確認コードを照合",
  customer_gate_verify_failed: "顧客タブの確認コードが不一致",
  "customer.memo_update": "顧客メモを更新",
  "customer.profile_update": "顧客プロフィールを更新",
  "customer.visit_notes_update": "施術メモを更新",
  "customer.merge": "顧客を統合",
  "settings.services.create": "メニューを追加",
  "settings.resources.create": "リソースを追加",
  "settings.staff.create": "スタッフを追加",
  "settings.staff.forbidden_role_escalation": "ロール昇格を拒否",
  "settings.closures.create": "休業日を追加",
  "settings.reminder.update": "リマインダー設定を更新",
  "settings.recurring.commit": "繰り返しブロックを確定",
  "settings.google_edit_mode.update": "Google編集モードを変更",
  "business_hours.update": "営業時間を更新",
  admin_reservation_approved: "予約を承認",
  admin_reservation_correct_no_show: "予約を来店なしに訂正",
  admin_reservation_restore_completed: "予約を完了に戻す",
  admin_google_conflict_resolution: "Google同期競合を解決",
  admin_sync_job_retry: "同期ジョブをリトライ",
  resolve_conflict: "競合を解決",
  retry_job: "ジョブをリトライ",
  all_day_approve_as_closure: "終日予定を休業日として承認",
  all_day_reject: "終日予定を却下",
  all_day_conflict_approved_as_closure: "終日競合を休業日として承認",
  all_day_conflict_rejected: "終日競合を却下",
  reservation_delete_approve_as_cancel: "予約削除をキャンセルとして承認",
  reservation_delete_reject: "予約削除を却下",
  reservation_event_deleted_approved_as_cancel: "イベント削除をキャンセルとして承認",
  reservation_event_deleted_rejected: "イベント削除を却下",
  approve_customer_change_request: "顧客変更申請を承認",
  reject_customer_change_request: "顧客変更申請を却下",
  submit_change_request: "変更申請を提出",
  withdraw_change_request: "変更申請を取り下げ",
};

const ACTOR_TYPE_LABELS: Record<string, string> = {
  staff: "スタッフ",
  customer: "顧客",
  system: "システム",
  google_calendar: "Google Calendar",
};

const TARGET_TYPE_LABELS: Record<string, string> = {
  reservation: "予約",
  customer: "顧客",
  customer_visit: "来店記録",
  service: "メニュー",
  resource: "リソース",
  staff_member: "スタッフ",
  store_closure: "休業日",
  store_resource: "リソース",
  store: "店舗",
  google_calendar_conflict: "Google同期競合",
  reservation_change_request: "変更申請",
  recurring_batch: "繰り返しバッチ",
  external_block: "ブロック枠",
  admin_user: "管理ユーザー",
};

function formatActionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

function formatActorName(
  log: AuditLogItem,
  staffMap: Map<string, string>,
): string {
  if (log.actorType === "staff" && log.actorId) {
    return staffMap.get(log.actorId) ?? "スタッフ";
  }
  return ACTOR_TYPE_LABELS[log.actorType] ?? log.actorType;
}

export function formatTargetLabel(targetType: string): string {
  return TARGET_TYPE_LABELS[targetType] ?? targetType;
}

const SQLITE_TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export function normalizeTimestamp(raw: string): string {
  if (SQLITE_TS_RE.test(raw)) {
    return `${raw.replace(" ", "T")}Z`;
  }
  return raw;
}

export function formatAuditSummary(
  log: AuditLogItem,
  staffMap: Map<string, string>,
): string {
  const actor = formatActorName(log, staffMap);
  const action = formatActionLabel(log.action);
  return `${actor} が ${action}`;
}

export function safeParseJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
