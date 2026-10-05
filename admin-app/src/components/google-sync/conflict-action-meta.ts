// Pure display metadata for Google-sync conflict actions.
// Single source of truth shared by the action buttons and the confirm dialog.
// NOTE: this module is display-only. It must NOT influence the request path or
// body in conflict-list.tsx — backend behavior is unchanged.

export type ActionType =
  | "ignore"
  | "manual-resolve"
  | "manual-resolve-cancel-block"
  | "approve-cancel"
  | "reject-delete"
  | "all-day-approve"
  | "all-day-reject";

export const ACTION_LABELS: Record<ActionType, string> = {
  ignore: "無視",
  "manual-resolve": "手動解決",
  "manual-resolve-cancel-block": "解決（ブロック取消）",
  "approve-cancel": "キャンセル承認",
  "reject-delete": "削除却下",
  "all-day-approve": "休業日承認",
  "all-day-reject": "却下",
};

// One-line button help text shown under each action.
export const ACTION_HELP: Record<ActionType, string> = {
  ignore: "対応不要として閉じます。データは変更しません。",
  "manual-resolve":
    "Googleや予約画面で既に対応済みのものを「確認済み」にします。データは変更しません。",
  "manual-resolve-cancel-block": "外部ブロックを取消し、枠を解放します。",
  "approve-cancel": "予約をキャンセルし、枠を解放します。",
  "reject-delete": "Google側の削除を却下し、予約を維持します。",
  "all-day-approve": "終日イベントを休業日として登録します。",
  "all-day-reject": "終日イベント候補を却下します。",
};

// Actions that move slots or mutate data (vs. pure status-marking no-ops).
// Drives the visual distinction and the confirm-dialog copy.
const SIDE_EFFECT_ACTIONS: ReadonlySet<ActionType> = new Set<ActionType>([
  "manual-resolve-cancel-block",
  "approve-cancel",
  "reject-delete",
  "all-day-approve",
  "all-day-reject",
]);

export function actionHasSideEffect(action: ActionType): boolean {
  return SIDE_EFFECT_ACTIONS.has(action);
}

// Per-action confirm-dialog body copy. Preserves the existing destructive copy
// for slot-moving actions; replaces the old generic "この操作を実行しますか？"
// for the no-op actions with an explicit "data unchanged" message.
const CONFIRM_COPY: Record<ActionType, string> = {
  ignore: "この競合を「対応不要」として閉じます。データは変更しません。",
  "manual-resolve": "この競合を「確認済み」にします。データは変更しません。",
  "manual-resolve-cancel-block":
    "D1の外部ブロックをキャンセルし、枠ロックも解放します。この操作は取り消せません。",
  "approve-cancel":
    "D1の予約をキャンセルし、枠を解放します。顧客への通知が送信される場合があります。この操作は取り消せません。",
  "reject-delete": "Google側の削除を却下し、D1の予約を維持します。",
  "all-day-approve": "この終日イベントを休業日として登録します。",
  "all-day-reject": "この終日イベント候補を却下します。",
};

export function confirmCopyForAction(action: ActionType): string {
  return CONFIRM_COPY[action];
}
