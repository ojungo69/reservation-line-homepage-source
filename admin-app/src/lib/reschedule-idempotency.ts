export type RescheduleKeyState = { reservationId: string; startAt: string; key: string };

/**
 * reschedule 送信用の idempotency キーを解決する。
 *
 * - 同じ予約・同じ startAt への再送（応答喪失後の手動リトライ）は前回のキーを保ち、
 *   サーバ側で replay されて副作用が二重に起きないようにする。ダイアログを閉じて開き直しても
 *   同じキーになるよう、この状態は開閉をまたいで生き残る場所（ダイアログ本体）で保持する。
 * - 予約または startAt が変わった送信は「別の操作」として新しいキーを発行する。前回の startAt に
 *   紐づくキーを使い回すと、直前の送信が成功して応答だけ失われていた場合に別時刻への
 *   変更が idempotency_conflict で弾かれる／前の時刻の結果が replay される。
 */
export function resolveRescheduleKey(
  prev: RescheduleKeyState | null,
  reservationId: string,
  startAt: string,
  mintKey: () => string,
): RescheduleKeyState {
  if (prev?.reservationId === reservationId && prev.startAt === startAt) return prev;
  return { reservationId, startAt, key: mintKey() };
}
