import { useMemo, useSyncExternalStore } from "react";

// Tailwind の sm ブレークポイント (min-width: 640px) 未満 = スマホ幅。
// 639px だと分数ピクセル幅 (OS スケーリング/ズーム時) に 0.02px の隙間ができて
// どちらのレイアウトも出ない帯が生まれるため、Tailwind の max-width 実装と同じ
// .98px 補正で補集合にする。range 構文 (width < 640px) は旧 iOS Safari が
// 解釈できず常に不一致になるので使わない。
export const NARROW_QUERY = "(max-width: 639.98px)";

// フックが MediaQueryList に依存する面だけの最小型。node 環境のテストで
// fake がこの3メンバーだけ実装すれば済むようにする。
export type MediaQueryLike = {
  readonly matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
};

// MediaQueryList を useSyncExternalStore の store 形に変換する。React に依存
// しない純関数として切り出し、node 環境の unit テストで fake MQL を使って
// 購読・解除・snapshot の挙動を検証できるようにする。
export function createMediaQueryStore(mql: MediaQueryLike) {
  return {
    subscribe: (onChange: () => void) => {
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    getSnapshot: () => mql.matches,
  };
}

// matchMedia を useSyncExternalStore で購読する共有フック。初期値・リサイズ・
// 画面回転のすべてで一貫した判定になる (resize イベント + state だと初期値がずれる)。
// MediaQueryList は query ごとに 1 度だけ生成し、snapshot は毎レンダー呼ばれても
// 生成済みの .matches を読むだけにする。
export function useMediaQuery(query: string): boolean {
  const store = useMemo(() => createMediaQueryStore(window.matchMedia(query)), [query]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
