import { useState, useCallback } from "react";

export type TimelineDensity = "standard" | "compact";

const STORAGE_KEY = "admin-schedule-density";

// 15分スロット1行の高さ(px)。standard は従来の h-10 相当 (40px)。compact は
// 1日全体を見渡す用途 (スタッフ・1店舗表示のスクロール過多対策) の縮小表示。
export const DENSITY_SLOT_PX: Record<TimelineDensity, number> = {
  standard: 40,
  compact: 24,
};

// localStorage はストレージ遮断環境 (Safari プライベートモード等) で getItem/setItem が
// 例外を投げる。表示密度は好みの永続化にすぎないので、読めなければ standard、書けなければ
// その場限りの切替として黙って続行する (スケジュール画面自体を壊さない)。
const readStoredDensity = (): TimelineDensity => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "standard" || stored === "compact" ? stored : "standard";
  } catch {
    return "standard";
  }
};

// use-theme.ts と同じ localStorage 永続パターン。端末ごとの表示好みなので
// サーバー設定にはしない。
export function useTimelineDensity() {
  const [density, setDensity] = useState<TimelineDensity>(readStoredDensity);

  // 公開する setter は state 更新に加えて localStorage へ永続化する。
  const persistDensity = useCallback((next: TimelineDensity) => {
    setDensity(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // 永続化できなくても切替自体は有効にする。
    }
  }, []);

  return { density, setDensity: persistDensity, slotPx: DENSITY_SLOT_PX[density] };
}
