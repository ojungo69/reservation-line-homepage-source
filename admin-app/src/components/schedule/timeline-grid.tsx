import { useMemo, useEffect, useState, useRef } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import type { Reservation, ExternalBlock, Resource, BusinessHour, Store } from "@/types/api";
import { getTimeSlots, getInitialScrollMinutes, jstWeekday, currentTimePosition, formatJstDate, isSameDay, type TimeSlot } from "@/lib/timeline";
import { TimelineColumn } from "./timeline-column";

const HEADER_PX = 30; // sticky column-header row height

type TimelineGridProps = {
  date: Date;
  resources: Resource[];
  stores: Store[];
  reservations: Reservation[];
  externalBlocks: ExternalBlock[];
  businessHours: BusinessHour[];
  storeId: string | null;
  isLoading: boolean;
  // 15分スロット1行の高さ(px)。use-timeline-density の standard=40 / compact=24。
  slotPx: number;
  onReservationClick: (id: string) => void;
  onSlotClick: (resourceId: string, minutes: number) => void;
  onBlockClick?: (blockId: string) => void;
};

export function TimelineGrid({
  date,
  resources,
  stores,
  reservations,
  externalBlocks,
  businessHours,
  storeId,
  isLoading,
  slotPx,
  onReservationClick,
  onSlotClick,
  onBlockClick,
}: Readonly<TimelineGridProps>) {
  const weekday = jstWeekday(date);
  const dateKey = formatJstDate(date);
  const slots = useMemo(
    () => getTimeSlots(businessHours, weekday, storeId),
    [businessHours, weekday, storeId],
  );

  // Render the full day; out-of-hours bookings are reachable by scrolling.
  const dayStartMinutes = 0;
  const dayEndMinutes = 24 * 60;

  const activeResources = useMemo(
    () => resources.filter((r) => r.active && (!storeId || r.storeId === storeId)),
    [resources, storeId],
  );

  const reservationsByResource = useMemo(() => {
    const map = new Map<string, Reservation[]>();
    for (const r of reservations) {
      const list = map.get(r.resourceId) ?? [];
      list.push(r);
      map.set(r.resourceId, list);
    }
    return map;
  }, [reservations]);

  const blocksByResource = useMemo(() => {
    const map = new Map<string, ExternalBlock[]>();
    for (const b of externalBlocks) {
      const list = map.get(b.resourceId) ?? [];
      list.push(b);
      map.set(b.resourceId, list);
    }
    return map;
  }, [externalBlocks]);

  const isToday = useMemo(() => isSameDay(date, new Date()), [date]);

  const [nowPosition, setNowPosition] = useState<number | null>(() =>
    isToday ? currentTimePosition(dayStartMinutes, dayEndMinutes) : null,
  );

  useEffect(() => {
    if (!isToday) {
      setNowPosition(null);
      return;
    }
    setNowPosition(currentTimePosition(dayStartMinutes, dayEndMinutes));
    const interval = setInterval(() => {
      setNowPosition(currentTimePosition(dayStartMinutes, dayEndMinutes));
    }, 60_000);
    return () => clearInterval(interval);
  }, [isToday, dayStartMinutes, dayEndMinutes]);

  // Auto-scroll the timeline to the business open time on mount and whenever the
  // viewed day / store / hours / density change, so the view does not start on
  // empty pre-dawn rows. slotPx per 15-min slot + 30px sticky header offset.
  // The Radix ScrollArea viewport (the scrollable node) carries
  // data-radix-scroll-area-viewport; the ref lands on the Root, so we query down.
  const scrollRootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // While loading, the component returns <TimelineSkeleton> (below) and the
    // ScrollArea (which holds scrollRootRef) is not mounted. isLoading MUST stay
    // in the dep array so the effect re-runs on the loading→loaded transition
    // that first mounts the ScrollArea — otherwise the auto-scroll never fires
    // and the view is stuck at 00:00. slotPx is in the deps so a density switch
    // re-anchors the scroll position to the same opening time.
    if (isLoading) return;
    const root = scrollRootRef.current;
    if (!root) return;
    const viewport = root.querySelector<HTMLElement>(
      "[data-radix-scroll-area-viewport]",
    );
    if (!viewport) return;
    const openMinutes = getInitialScrollMinutes(businessHours, weekday, storeId);
    // 開店スロットの上に1スロット分の余白を置くが、sticky ヘッダー (HEADER_PX) より
    // 小さい slotPx (compact=24px) だと開店スロット先頭がヘッダー裏に隠れるため、
    // 余白は最低でも HEADER_PX を確保する。
    viewport.scrollTop = Math.max(
      0,
      (openMinutes / 15) * slotPx + HEADER_PX - Math.max(slotPx, HEADER_PX),
    );
  }, [businessHours, weekday, storeId, dateKey, isLoading, slotPx]);

  if (isLoading) {
    return <TimelineSkeleton columns={3} rows={8} />;
  }

  if (activeResources.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-muted-foreground">
        リソースが見つかりません。店舗設定でリソースを追加してください。
      </div>
    );
  }

  return (
    <ScrollArea className="flex-1" ref={scrollRootRef}>
      <div className="flex min-w-max">
        <TimeLabels slots={slots} slotPx={slotPx} />
        <div className="relative flex flex-1">
          {nowPosition !== null && (
            // nowPosition% is a fraction of the day. The containing flex box
            // includes the 30px column-header row, so a flat `calc(% + 30px)`
            // over-shoots by up to a full header height near day-end. Instead
            // pin an inner box to exactly the grid region (top: HEADER_PX,
            // bottom: 0) and resolve the percentage against THAT box.
            <div
              className="pointer-events-none absolute left-0 right-0 bottom-0 z-30"
              style={{ top: `${HEADER_PX}px` }}
            >
              <div
                className="absolute left-0 right-0 border-t-2 border-red-500"
                style={{ top: `${nowPosition}%` }}
              >
                <div className="absolute -left-1 -top-1.5 size-3 rounded-full bg-red-500" />
              </div>
            </div>
          )}
          {activeResources.map((resource) => (
            <TimelineColumn
              key={resource.id}
              resourceId={resource.id}
              resourceName={storeId ? resource.name : `${stores.find((store) => store.id === resource.storeId)?.name ?? "店舗不明"} · ${resource.name}`}
              reservations={reservationsByResource.get(resource.id) ?? []}
              externalBlocks={blocksByResource.get(resource.id) ?? []}
              slots={slots}
              initialFocusMinutes={getInitialScrollMinutes(businessHours, weekday, resource.storeId)}
              slotPx={slotPx}
              dayStartMinutes={dayStartMinutes}
              dayEndMinutes={dayEndMinutes}
              dayDateKey={formatJstDate(date)}
              onReservationClick={onReservationClick}
              onSlotClick={onSlotClick}
              onBlockClick={onBlockClick}
            />
          ))}
        </div>
      </div>
    </ScrollArea>
  );
}

function TimeLabels({ slots, slotPx }: Readonly<{ slots: TimeSlot[]; slotPx: number }>) {
  return (
    <div className="sticky left-0 z-10 w-14 shrink-0 border-r bg-background">
      <div className="sticky top-0 z-20 h-[30px] border-b bg-muted/80" />
      {slots.map((slot) => (
        <div
          key={slot.time}
          className="flex items-start justify-end pr-2"
          style={{ height: slotPx }}
        >
          {slot.label && (
            <span className="relative -top-2 text-xs text-muted-foreground">
              {slot.label}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function TimelineSkeleton({ columns, rows }: Readonly<{ columns: number; rows: number }>) {
  return (
    <div className="flex flex-1 p-4">
      <output aria-label="予定を読み込み中" className="sr-only">予定を読み込み中</output>
      <div className="w-14" />
      <div className="flex flex-1 gap-2">
        {Array.from({ length: columns }).map((_, c) => (
          <div key={c} className="flex flex-1 flex-col gap-1">
            <Skeleton className="h-6 w-full" />
            {Array.from({ length: rows }).map((_, r) => (
              <Skeleton key={r} className="h-4 w-full" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
