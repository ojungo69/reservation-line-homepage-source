import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { MiniCalendar } from "@/components/schedule/mini-calendar";
import { formatDateDisplay, addDays, isSameDay } from "@/lib/timeline";
import type { TimelineDensity } from "@/hooks/use-timeline-density";

type ScheduleHeaderProps = {
  date: Date;
  onDateChange: (date: Date) => void;
  viewMode: "day" | "week";
  onViewModeChange: (mode: "day" | "week") => void;
  pendingCount: number | null;
  // null = 件数の元データ取得に失敗 (0件と区別してチップ自体を出さない)
  confirmedCount: number | null;
  completedCount: number | null;
  onCreateClick: () => void;
  onCreateBlockClick?: () => void;
  countsLabel?: string;
  // スマホ幅では週表示を提供しない (SchedulePage が day に強制するため、
  // トグルを出すと押しても切り替わらないボタンになる)。
  isNarrow?: boolean;
  mobileView?: "agenda" | "timeline";
  onMobileViewChange?: (view: "agenda" | "timeline") => void;
  // タイムライン密度トグル。日表示のみ配線される (週表示はスロットグリッドが
  // 無いので SchedulePage が渡さない = 非表示)。
  density?: TimelineDensity;
  onDensityChange?: (density: TimelineDensity) => void;
};

export function ScheduleHeader({
  date,
  onDateChange,
  viewMode,
  onViewModeChange,
  pendingCount,
  confirmedCount,
  completedCount,
  onCreateClick,
  onCreateBlockClick,
  countsLabel,
  isNarrow = false,
  mobileView,
  onMobileViewChange,
  density,
  onDensityChange,
}: Readonly<ScheduleHeaderProps>) {
  const isToday = isSameDay(date, new Date());
  const [calendarOpen, setCalendarOpen] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-2 border-b bg-background px-4 py-2">
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="icon"
          onClick={() => onDateChange(addDays(date, viewMode === "week" ? -7 : -1))}
          aria-label={viewMode === "week" ? "前週" : "前日"}
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
        </Button>
        <Button
          variant={isToday ? "default" : "outline"}
          size="sm"
          onClick={() => onDateChange(new Date())}
        >
          今日
        </Button>
        <Button
          variant="outline"
          size="icon"
          onClick={() => onDateChange(addDays(date, viewMode === "week" ? 7 : 1))}
          aria-label={viewMode === "week" ? "翌週" : "翌日"}
        >
          <ChevronRight className="size-4" aria-hidden="true" />
        </Button>
        <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-2 gap-1 px-2 text-sm font-medium"
              // 巡回ゲートが日付ピッカーを開くためのマーカー (可視名は日付文字列
              // で毎日変わるため、セレクタをここに固定する)。
              data-date-picker-trigger=""
            >
              {formatDateDisplay(date)}
              <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden="true" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start">
            <MiniCalendar
              selected={date}
              onSelect={(d) => {
                onDateChange(d);
                setCalendarOpen(false);
              }}
            />
          </PopoverContent>
        </Popover>
      </div>

      {!isNarrow && (
        <ToggleGroup
          type="single"
          value={viewMode}
          onValueChange={(v) => { if (v) onViewModeChange(v as "day" | "week"); }}
          className="ml-2"
        >
          <ToggleGroupItem value="day" className="px-3 text-xs">日</ToggleGroupItem>
          <ToggleGroupItem value="week" className="px-3 text-xs">週</ToggleGroupItem>
        </ToggleGroup>
      )}

      {isNarrow && mobileView && onMobileViewChange && (
        <ToggleGroup
          type="single"
          value={mobileView}
          onValueChange={(value) => {
            if (value === "agenda" || value === "timeline") onMobileViewChange(value);
          }}
          aria-label="スマホの予定表示"
        >
          <ToggleGroupItem value="agenda" className="px-3 text-xs">予定一覧</ToggleGroupItem>
          <ToggleGroupItem value="timeline" className="px-3 text-xs">時間軸</ToggleGroupItem>
        </ToggleGroup>
      )}

      {(!isNarrow || mobileView === "timeline") && density && onDensityChange && (
        <ToggleGroup
          type="single"
          value={density}
          onValueChange={(v) => { if (v) onDensityChange(v as TimelineDensity); }}
          aria-label="タイムラインの表示密度"
        >
          <ToggleGroupItem value="standard" className="px-3 text-xs">標準</ToggleGroupItem>
          <ToggleGroupItem value="compact" className="px-3 text-xs">コンパクト</ToggleGroupItem>
        </ToggleGroup>
      )}

      {/* 承認待ちは当日運用で最重要なのでモバイルでも常に表示する。確定/完了は
          画面が狭いときだけ隠す。 */}
      {pendingCount !== null && pendingCount > 0 && (
        <Badge variant="outline" className="border-amber-400 bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-200">
          承認待ち {pendingCount}
        </Badge>
      )}
      {/* 取得失敗時 (null) は「確定 0」と誤読させないためチップを出さない。 */}
      {confirmedCount !== null && completedCount !== null && (
        <div className="hidden items-center gap-2 sm:flex">
          {countsLabel && <span className="text-xs text-muted-foreground">{countsLabel}</span>}
          <Badge variant="outline" className="border-blue-400 bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-200">
            確定 {confirmedCount}
          </Badge>
          <Badge variant="outline" className="border-green-400 bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-200">
            完了 {completedCount}
          </Badge>
        </div>
      )}

      <div className="ml-auto flex items-center gap-2">
        {onCreateBlockClick && (
          <Button
            size="sm"
            variant="outline"
            onClick={onCreateBlockClick}
          >
            + ブロック
          </Button>
        )}
        <Button size="sm" onClick={onCreateClick}>
          + 予約
        </Button>
      </div>
    </div>
  );
}
