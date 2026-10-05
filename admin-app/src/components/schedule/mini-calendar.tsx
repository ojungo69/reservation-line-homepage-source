import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  WEEKDAYS,
  firstOfJstMonth,
  formatFullJstDate,
  getMonthGrid,
  isSameDay,
  toJstDate,
} from "@/lib/timeline";

type MiniCalendarProps = {
  selected: Date;
  onSelect: (date: Date) => void;
};

// 自作の月グリッド (外部カレンダーライブラリなし)。表示月 state はマウント時に
// selected の月から導出し、以後の月ナビはローカルで完結する。呼び出し側
// (ScheduleHeader) が Popover close でこのコンポーネントを unmount する構成に
// しているため、次に開いたときは常に selected の最新月へ戻る。
export function MiniCalendar({ selected, onSelect }: Readonly<MiniCalendarProps>) {
  const [monthAnchor, setMonthAnchor] = useState(() => firstOfJstMonth(selected));
  const grid = useMemo(() => getMonthGrid(monthAnchor), [monthAnchor]);
  const jstMonthAnchor = toJstDate(monthAnchor);
  const displayYear = jstMonthAnchor.getUTCFullYear();
  const displayMonth = jstMonthAnchor.getUTCMonth();
  // render ごとに評価する(useMemo で mount 時固定すると、開いたまま JST 日付が
  // 変わったとき今日ハイライトが陳腐化する。生成コストは無視できる)。
  const today = new Date();

  return (
    // 7列 × 44px (size-11) が収まる幅が必要 (w-64=256px だと日付ボタンが隣列へ
    // 約10px 重なり、後描画のボタンが隣のタップを奪う)。p-1 + calc(100vw-4px)
    // は 320px 端末対策 — PopoverContent (glass-mid) の border 2px を含めて
    // wrapper 318px が viewport 内に収まり、内容幅はちょうど 308px (=7×44px)
    // で 44px セルを縮小も重なりもなしで維持する。320px で開く walk 検査が固定。
    // max-h + overflow-y: グリッドは 6行×44px + ヘッダで約 350px あり、短い
    // landscape や高倍率 zoom では下段が viewport 外で到達不能になる。上限は
    // viewport 全高ではなく Radix の available-height (popover の開始位置と
    // collision を織り込んだ実利用可能高。-2px は PopoverContent の上下 border)
    // に基づける — 100vh 基準だと開始 Y 分だけ下へはみ出し、最大までスクロール
    // しても最終行が到達不能だった。filter を持つ PopoverContent 側ではなく
    // この内側 div がスクロールする (R1 準拠)。
    // scrollbar-width:none (+webkit hidden は旧 Safari 向け fallback):
    // スクロールバー幅に依存しないレイアウトにする — thin でもエンジンごとに
    // 幅が違い (Chrome ~11px / Firefox ~8px)、320px では 7×44px=308px の
    // グリッドがどの幅でも割れるため、非表示化で侵食ゼロに固定する。横 padding
    // は 336px 未満で 0 (px-0 min-[336px]:px-1)。tabIndex/aria-label/focus ring:
    // focusable な子を持つ scroll container は自動 focus 対象にならないため、
    // スクロールバー非表示でもキーボード (PageDown/矢印) でスクロールできる
    // 経路を明示的に確保する — walk の実キー入力検査が scrollTop 変化を固定。
    // 320×240 の複合 walk 検査がセル寸法・非重複・最終行到達を固定。
    <div
      className="max-h-[calc(var(--radix-popover-content-available-height)-2px)] w-[21rem] max-w-[calc(100vw-4px)] overflow-y-auto px-0 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring min-[336px]:px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      data-mini-calendar=""
      tabIndex={0}
      role="group"
      aria-label="日付選択カレンダー"
    >
      <div className="flex items-center justify-between px-1 pb-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => setMonthAnchor((prev) => firstOfJstMonth(prev, -1))}
          aria-label="前の月"
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
        </Button>
        <span className="text-sm font-medium">
          {displayYear}年{displayMonth + 1}月
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => setMonthAnchor((prev) => firstOfJstMonth(prev, 1))}
          aria-label="次の月"
        >
          <ChevronRight className="size-4" aria-hidden="true" />
        </Button>
      </div>
      {/* キーボードは Tab 移動 + ラベル付きボタンのみ (矢印キーでの roving grid
          は見送り)。運用がタッチ/マウス中心のため、フォーカス可能・aria-label
          付きのベースラインで足りると判断した。 */}
      <div className="grid grid-cols-7 gap-y-1 text-center">
        {WEEKDAYS.map((w) => (
          <div key={w} className="text-xs font-medium text-muted-foreground">
            {w}
          </div>
        ))}
        {grid.map((cell) => {
          const cellJst = toJstDate(cell);
          const inCurrentMonth =
            cellJst.getUTCFullYear() === displayYear && cellJst.getUTCMonth() === displayMonth;
          const isToday = isSameDay(cell, today);
          const isSelected = isSameDay(cell, selected);
          return (
            <button
              key={cell.toISOString()}
              type="button"
              onClick={() => onSelect(cell)}
              aria-label={formatFullJstDate(cell)}
              aria-current={isToday ? "date" : undefined}
              aria-pressed={isSelected}
              className={cn(
                "mx-auto flex size-11 max-w-full items-center justify-center rounded-full text-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                // /50 (2.01:1) は WCAG AA 未達 — 前後月もタップ可能な実ボタン。
                !inCurrentMonth && "text-muted-foreground",
                isToday && !isSelected && "font-semibold text-blue-600 dark:text-blue-400",
                isSelected && "bg-primary text-primary-foreground hover:bg-primary/90",
              )}
            >
              {cellJst.getUTCDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}
