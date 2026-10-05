import { useEffect, useState } from "react";

/**
 * 検索入力を遅延させて API 呼び出しを間引く。値は trim して返す。
 *
 * setter を返すのは、遅延窓を同期的に閉じたい呼び出し側があるため。検索語を
 * クリアした直後の 300ms は、まだ前の語で取得した結果が画面に残っている
 * ——顧客一覧のアーカイブ切替 (通常顧客の結果をアーカイブとして表示し続ける)
 * と LINE 連携ダイアログ (もう一致しない行がクリック可能なまま) の両方で実害が
 * あった。呼び出し側が setter で即座に空にできないと、その窓が戻る。
 */
export function useDebouncedValue(value: string, delayMs = 300): [string, (next: string) => void] {
  // value.trim() であって "" ではない。今の呼び出し側は全部空文字から始まるので
  // 差は出ないが、`useDebouncedValue(searchParams.get("q") ?? "")` のように
  // 初期値付きで使われた瞬間、最初の 300ms だけ検索語が空になり、絞り込み前の
  // 一覧を1往復ぶん余計に取りに行く。
  const [debounced, setDebounced] = useState(value.trim());
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value.trim()), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return [debounced, setDebounced];
}
