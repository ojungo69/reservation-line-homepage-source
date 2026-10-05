import { useEffect, useId, useRef, useState } from "react";
import type { Reservation, ExternalBlock } from "@/types/api";
import type { TimeSlot } from "@/lib/timeline";
import { getCardStyle } from "@/lib/timeline";
import { ReservationCard } from "./reservation-card";
import { ExternalBlockCard } from "./external-block-card";

type TimelineColumnProps = {
  resourceId: string;
  resourceName: string;
  reservations: Reservation[];
  externalBlocks: ExternalBlock[];
  slots: TimeSlot[];
  // 15分スロット1行の高さ(px)。TimelineGrid から伝播 (standard=40 / compact=24)。
  slotPx: number;
  dayStartMinutes: number;
  dayEndMinutes: number;
  dayDateKey: string;
  initialFocusMinutes?: number;
  onReservationClick: (id: string) => void;
  onSlotClick: (resourceId: string, minutes: number) => void;
  onBlockClick?: (blockId: string) => void;
};

export function TimelineColumn({
  resourceId,
  resourceName,
  reservations,
  externalBlocks,
  slots,
  slotPx,
  dayStartMinutes,
  dayEndMinutes,
  dayDateKey,
  initialFocusMinutes = 9 * 60,
  onReservationClick,
  onSlotClick,
  onBlockClick,
}: Readonly<TimelineColumnProps>) {
  const keyboardHintId = useId();
  const openingIndex = slots.findIndex((slot) => slot.minutes >= initialFocusMinutes);
  const initialIndex = openingIndex < 0 ? Math.max(0, slots.length - 1) : openingIndex;
  const [activeIndex, setActiveIndex] = useState(initialIndex);
  const slotRefs = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => {
    setActiveIndex(initialIndex);
  }, [dayDateKey, resourceId, resourceName, initialFocusMinutes, initialIndex]);
  return (
    <div data-timeline-resource="" className="relative flex min-w-[120px] flex-1 flex-col border-r last:border-r-0">
      <div className="sticky top-0 z-20 h-[30px] whitespace-nowrap border-b bg-muted/80 px-2 py-1.5 text-center text-xs font-medium backdrop-blur-sm">
        {resourceName}
      </div>
      <p id={keyboardHintId} className="sr-only">上下矢印で時刻、左右矢印で担当者を移動します。Home/Endで一日の端へ、Enter/Spaceで予約作成へ進みます。</p>
      <div className="relative flex-1">
        {slots.map((slot, index) => (
          <button
            key={slot.time}
            type="button"
            ref={(element) => { slotRefs.current[index] = element; }}
            className="block w-full border-b border-dashed border-muted-foreground/10 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            style={{ height: slotPx }}
            tabIndex={index === Math.min(activeIndex, slots.length - 1) ? 0 : -1}
            data-slot-minutes={slot.minutes}
            // 高さ=グリッド密度 (15分刻み) そのもの。巡回ゲートの
            // durationExceptions 分類マーカー (reservation-card と同じ)。
            data-duration-geometry=""
            aria-label={`${resourceName} ${slot.time} に予約作成`}
            aria-describedby={keyboardHintId}
            onFocus={() => setActiveIndex(index)}
            onClick={() => onSlotClick(resourceId, slot.minutes)}
            onKeyDown={(e) => {
              let targetIndex: number | null = null;
              if (e.key === "ArrowUp") targetIndex = Math.max(0, index - 1);
              else if (e.key === "ArrowDown") targetIndex = Math.min(slots.length - 1, index + 1);
              else if (e.key === "Home") targetIndex = 0;
              else if (e.key === "End") targetIndex = slots.length - 1;
              if (targetIndex !== null) {
                e.preventDefault();
                slotRefs.current[targetIndex]?.focus();
                return;
              }
              if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                e.preventDefault();
                const column = e.currentTarget.closest("[data-timeline-resource]");
                const adjacent = e.key === "ArrowLeft" ? column?.previousElementSibling : column?.nextElementSibling;
                adjacent?.querySelector<HTMLButtonElement>(`[data-slot-minutes="${slot.minutes}"]`)?.focus();
                return;
              }
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSlotClick(resourceId, slot.minutes);
              }
            }}
          />
        ))}

        {reservations.map((r) => {
          const style = getCardStyle(r.startAt, r.endAt, dayStartMinutes, dayEndMinutes, dayDateKey);
          if (!style) return null;
          return (
            <ReservationCard
              key={r.id}
              reservation={r}
              style={style}
              slotPx={slotPx}
              onClick={onReservationClick}
            />
          );
        })}

        {externalBlocks.map((b) => {
          const style = getCardStyle(b.startAt, b.endAt, dayStartMinutes, dayEndMinutes, dayDateKey);
          if (!style) return null;
          return (
            <ExternalBlockCard
              key={b.id}
              block={b}
              style={style}
              slotPx={slotPx}
              onBlockClick={onBlockClick}
            />
          );
        })}
      </div>
    </div>
  );
}
