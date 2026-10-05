/**
 * 承認待ち予約の一括承認を直列実行する純粋ロジック。
 * React / TanStack Query / トーストに依存しない (unit テスト対象)。
 *
 * - 直列 (同時1件): 承認 API は LINE 通知 + Google カレンダー連携ジョブを伴うため
 *   並列送信でレート制限や slot 競合を誘発しない。
 * - 途中失敗しても継続し、全件の成否を集計して返す。
 * - invalidate / 再取得は呼び出し側が settle 後に1回だけ行う契約。
 */
export type BulkApproveResult = {
  succeeded: string[];
  failed: Array<{ id: string; message: string }>;
};

export async function runBulkApprove(
  ids: readonly string[],
  execute: (id: string) => Promise<unknown>,
  toMessage: (error: unknown) => string,
  onProgress?: (done: number, total: number) => void,
): Promise<BulkApproveResult> {
  const succeeded: string[] = [];
  const failed: Array<{ id: string; message: string }> = [];
  let done = 0;
  for (const id of ids) {
    try {
      await execute(id);
      succeeded.push(id);
    } catch (error) {
      failed.push({ id, message: toMessage(error) });
    }
    done += 1;
    onProgress?.(done, ids.length);
  }
  return { succeeded, failed };
}
