// 予約操作 (承認/却下など) の相互排他を module スコープで共有する。
//
// 単件操作 (useReservationAction) と一括承認 (pending-approvals-card) は別々の
// コンポーネントから発火し、SPA のページ遷移でコンポーネントの ref/state が破棄
// されても in-flight の POST は生き続ける。component-local な排他だけでは
// 「却下送信中にアンマウント → 再マウント → 同じ予約を一括承認」や
// 「一括実行中に予約管理ページの行内から却下」で同一予約へ approve/reject が
// 並行し、先着勝ちで操作意図が覆り得るため、真実をここに一元化する。
//
// 確認と状態変更は try/end の関数内に閉じる (生の Set や setter を公開すると、
// 同一予約を2画面から送った場合に Set 要素を共有し、先に完了した方の解放で
// もう一方の in-flight が見えなくなる)。
// ponytail: グローバル変数 + Set の最小構成。進捗の復元や AbortSignal は
// 必要になったら shared operation 化する。

const inFlightReservationIds = new Set<string>();

let bulkApproveRunning = false;

/** 単件操作の開始拒否理由 (error-messages.ts の ApiErrorCode と同じ文字列)。 */
export type ReservationActionRejection =
  | "bulk_in_progress"
  | "idempotency_in_progress";

/**
 * 単件操作の開始を試みる。開始できたら null (呼び出し側は finally で必ず
 * endReservationAction すること)、できなければ拒否理由を返す。
 */
export const tryBeginReservationAction = (
  reservationId: string,
): ReservationActionRejection | null => {
  if (bulkApproveRunning) return "bulk_in_progress";
  if (inFlightReservationIds.has(reservationId)) return "idempotency_in_progress";
  inFlightReservationIds.add(reservationId);
  return null;
};

export const endReservationAction = (reservationId: string): void => {
  inFlightReservationIds.delete(reservationId);
};

/**
 * 一括承認の開始を試みる。単件操作が1件でも in-flight なら開始しない (逆方向の
 * 排他。却下送信中の予約へ approve が並行し、先着勝ちで却下意図が覆るのを防ぐ)。
 * true を返したら呼び出し側は finally で必ず endBulkApprove すること。
 */
export const tryBeginBulkApprove = (): boolean => {
  if (bulkApproveRunning || inFlightReservationIds.size > 0) return false;
  bulkApproveRunning = true;
  return true;
};

export const endBulkApprove = (): void => {
  bulkApproveRunning = false;
};

/** 描画側の disabled 判定・単件入口の同期プリチェック用 (状態は変更しない)。 */
export const isBulkApproveRunning = (): boolean => bulkApproveRunning;
