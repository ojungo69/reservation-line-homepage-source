import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { CalendarColumns, DayHeaderCells, DayList, columnState, openingMinute, previousDayKey } from "@/components/calendar-v2/body";
import { buildColumns, effectiveView, slotResource, visibleStoreId, type CalendarColumn, type CalendarView } from "@/components/calendar-v2/columns";
import { PX_PER_MINUTE, mondayWeek } from "@/components/calendar-v2/geometry";
import { CalendarGrid } from "@/components/calendar-v2/grid";
import { dayLabel, shortDayLabel, weekHeading } from "@/components/calendar-v2/labels";
import { CalendarNotices } from "@/components/calendar-v2/notices";
import { CalendarTopBar, DayHeader } from "@/components/calendar-v2/top-bar";
import { useCalendarDate, useCalendarDays } from "@/components/calendar-v2/use-calendar-days";
import { useCalendarLayout } from "@/components/calendar-v2/use-calendar-layout";
import { PendingApprovalsCard } from "@/components/schedule/pending-approvals-card";
import { ReservationCreatePanel } from "@/components/schedule/reservation-create-panel";
import { ReservationDetailPanel } from "@/components/schedule/reservation-detail-panel";
import { useShellV2 } from "@/components/shell-v2/shell-context";
import { PendingConfirmDialog } from "@/components/ui/pending-confirm-dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useAuth } from "@/hooks/use-auth";
import { useExternalBlockCancel } from "@/hooks/use-external-blocks";
import { NARROW_QUERY, useMediaQuery } from "@/hooks/use-media-query";
import { usePendingReservations } from "@/hooks/use-reservations";
import { useSettings } from "@/hooks/use-settings";
import { useStores } from "@/hooks/use-stores";
import { addDays, formatJstDate, formatTime, toJstDate } from "@/lib/timeline";
import type { ExternalBlock } from "@/types/api";

type CreateDefaults = Readonly<{
  storeId: string | null;
  resourceId: string | null;
  minutes: number | null;
  date?: Date;
  serviceIds?: string[];
  customer?: { id?: string | null; displayName: string; displayNameKana?: string | null; phone?: string | null } | null;
}>;

const NO_DEFAULTS: CreateDefaults = { storeId: null, resourceId: null, minutes: null };

/**
 * The calendar on the switch's on side (spec 008 T005): a week of one store or a
 * day with a column per store on one 24-hour axis, under a floating glass bar.
 */
export default function ScheduleV2Page() {
  const { isPrivileged } = useAuth();
  const { stores, selectedStoreId } = useStores();
  const storeId = visibleStoreId(selectedStoreId, stores);
  const narrow = useMediaQuery(NARROW_QUERY);
  // T006 remembers the choice per device; until then a phone starts on the list
  // and a wider screen on the week, as DESIGN.md §5 sets for the first visit.
  const [requested, setRequested] = useState<CalendarView>(() => (narrow ? "list" : "week"));
  // The 週 button was pressed while all stores are shown: say why the day stays.
  const [weekAsked, setWeekAsked] = useState(false);
  const view = effectiveView(requested, { narrow, storeId });
  const week = view === "week";
  const { date, setDate, now } = useCalendarDate();
  const location = useLocation();
  const navigate = useNavigate();
  const shell = useShellV2();
  const headingRef = useRef<HTMLHeadingElement>(null);

  const dayDates = week ? mondayWeek(date) : [date];
  const dayKeys = dayDates.map(formatJstDate);
  // The day before the first one too: its bookings can run past midnight.
  const days = useCalendarDays([previousDayKey(dayDates[0]), ...dayKeys]);
  const dayByKey = new Map(days.map((day) => [day.dateKey, day]));
  const settingsQuery = useSettings({ live: true });
  const settings = settingsQuery.data?.ok ? settingsQuery.data.settings : null;
  const pendingQuery = usePendingReservations();
  const cancelBlockMutation = useExternalBlockCancel();

  const [selectedReservationId, setSelectedReservationId] = useState<string | null>(null);
  const [createDefaults, setCreateDefaults] = useState<CreateDefaults | null>(null);
  const [pendingOpen, setPendingOpen] = useState(false);
  const [cancelBlock, setCancelBlock] = useState<ExternalBlock | null>(null);

  const columns = view === "list" ? [] : buildColumns(view, date, storeId, stores);
  const settingsUsable = settings !== null && !settingsQuery.isError;
  const states = columns.map((column) => columnState(column, dayByKey, settings, settingsUsable));
  const storesWhere = (test: (state: (typeof states)[number]) => boolean) =>
    [...new Set(states.filter(test).map((state) => state.column.storeName))];
  const { overlayRef, scrollerRef, layout } = useCalendarLayout(columns.length, narrow ? 48 : 56);

  // Page move stays shut while a sheet of this page is open (see ShellV2).
  const sheetOpen = selectedReservationId !== null || createDefaults !== null || pendingOpen || cancelBlock !== null;
  useEffect(() => {
    if (!shell) return;
    shell.setPaletteBlocked(sheetOpen);
    return () => shell.setPaletteBlocked(false);
  }, [shell, sheetOpen]);

  // The sheets open without a Radix trigger, so Radix has nowhere to return focus
  // when they close. Remember what opened one and go back there, else to the grid.
  const opener = useRef<HTMLElement | null>(null);
  const remember = (element: HTMLElement) => {
    opener.current = element;
  };
  useEffect(() => {
    if (sheetOpen || !opener.current) return;
    const target = opener.current;
    opener.current = null;
    if (target !== document.body && target.isConnected) target.focus();
    if (document.activeElement !== target) scrollerRef.current?.focus();
  }, [sheetOpen, scrollerRef]);

  // Open at the store's opening time (DESIGN.md §5) when the shown days, the store
  // or the view change; scrollKey names every input read here, so a refresh does
  // not move the grid.
  const scrollKey = `${view}|${dayKeys[0]}|${storeId ?? "all"}|${String(settings !== null)}`;
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    if (view === "list" || !settings || columns.length === 0) {
      scroller.scrollTop = 0;
      return;
    }
    const open = Math.min(...columns.map((column) => openingMinute(settings, column)));
    scroller.scrollTop = Math.max(0, (open - 30) * PX_PER_MINUTE);
  }, [scrollKey]);

  // 次回予約 from a customer's chart lands here with the customer in the history
  // state; it opens the booking form once, as on the current calendar.
  const rebookConsumed = useRef(false);
  useEffect(() => {
    const rebook = (location.state as { rebook?: CreateDefaults["customer"] } | null)?.rebook;
    if (!rebook) {
      rebookConsumed.current = false;
      return;
    }
    if (rebookConsumed.current) return;
    rebookConsumed.current = true;
    setCreateDefaults({ ...NO_DEFAULTS, customer: rebook });
    navigate(".", { replace: true, state: null });
  }, [location.state, navigate]);

  const onSlot = useCallback(
    (column: CalendarColumn, minutes: number, from: HTMLElement) => {
      if (!settings) return;
      // A store without an active resource offers no slots (the notice says why).
      const resource = slotResource(column.storeId, settings.resources);
      opener.current = from;
      const resourceId = resource.kind === "one" ? resource.resourceId : null;
      setCreateDefaults({ storeId: column.storeId, resourceId, minutes, date: column.date });
    },
    [settings],
  );
  const onReservation = useCallback((id: string, from: HTMLElement) => {
    opener.current = from;
    setSelectedReservationId(id);
  }, []);
  const onBlock = useCallback((block: ExternalBlock, from: HTMLElement) => {
    opener.current = from;
    setCancelBlock(block);
  }, []);
  // The pressed day header goes away with the week, so focus moves to the heading,
  // which names the day just opened.
  const focusHeading = useRef(false);
  useEffect(() => {
    if (!focusHeading.current) return;
    focusHeading.current = false;
    headingRef.current?.focus();
  });
  const openDay = useCallback(
    (day: Date) => {
      setDate(day);
      setRequested("day");
      focusHeading.current = true;
    },
    [setDate],
  );
  const onView = (next: CalendarView) => {
    setRequested(next);
    setWeekAsked(next === "week");
  };

  const pendingList = pendingQuery.data?.ok ? pendingQuery.data.reservations : [];
  const pendingReady = !pendingQuery.isPending && !pendingQuery.isError;
  const pendingCount = pendingReady ? pendingList.filter((item) => !storeId || item.storeId === storeId).length : null;

  const todayKey = formatJstDate(now);
  const nowJst = toJstDate(now);
  const dayTitle = narrow ? shortDayLabel(date) : dayLabel(date);
  const dayHeader = (
    <DayHeader scrollbarPx={layout.scrollbarPx}>
      <DayHeaderCells
        columns={columns}
        dayByKey={dayByKey}
        week={week}
        allStores={storeId === null}
        todayKey={todayKey}
        onOpenDay={openDay}
      />
    </DayHeader>
  );

  let body = <DayList day={dayByKey.get(formatJstDate(date))} storeId={storeId} onDetails={onReservation} />;
  if (view !== "list") {
    body =
      columns.length === 0 ? (
        // Columns need the store list, which comes with the store settings.
        <p className="px-4 py-3 text-sm">{settingsQuery.isPending ? "予定を読み込み中…" : "表示できる店舗がありません。"}</p>
      ) : (
        <CalendarGrid>
          <CalendarColumns
            states={states}
            settings={settings}
            week={week}
            todayKey={todayKey}
            nowMinute={nowJst.getUTCHours() * 60 + nowJst.getUTCMinutes()}
            columnPx={layout.columnPx}
            selectedId={selectedReservationId}
            onSlot={onSlot}
            onReservation={onReservation}
            onBlock={isPrivileged ? onBlock : undefined}
          />
        </CalendarGrid>
      );
  }

  return (
    <div className="relative h-full overflow-hidden bg-cal-surface text-cal-text">
      {/* First in the DOM, so Tab after 本文へスキップ reaches the bar before the grid. */}
      <div ref={overlayRef} className="pointer-events-none absolute inset-x-0 top-0 z-40">
        <CalendarTopBar
          heading={week ? weekHeading(dayDates) : dayTitle}
          headingRef={headingRef}
          view={view}
          weekShown={!narrow}
          onView={onView}
          onToday={() => setDate(new Date())}
          onStep={(direction) => setDate(addDays(date, direction * (week ? 7 : 1)))}
          stepUnit={week ? "週" : "日"}
          pendingCount={pendingCount}
          onOpenPending={(from) => {
            remember(from);
            setPendingOpen(true);
          }}
          dayHeader={view === "list" ? null : dayHeader}
        />
        <CalendarNotices
          days={days}
          dayName={(dateKey) => dayLabel(new Date(`${dateKey}T00:00:00+09:00`))}
          noResourceStores={storesWhere((state) => state.noResource)}
          closuresUnknownStores={storesWhere((state) => state.closuresUnknown)}
          settings={{
            failed: settingsQuery.isError,
            hadData: settings !== null,
            updatedAt: settingsQuery.dataUpdatedAt,
            refetch: () => void settingsQuery.refetch(),
          }}
          weekNeedsStore={weekAsked && requested === "week" && !narrow && storeId === null && stores.length > 1}
          onRetried={() => headingRef.current?.focus()}
        />
      </div>

      <div
        ref={scrollerRef}
        data-calendar-scroll=""
        // Focus falls back here when what opened a sheet is gone.
        tabIndex={-1}
        className="h-full overflow-y-auto overscroll-contain outline-hidden"
        style={{ paddingTop: layout.barPx, scrollPaddingTop: layout.barPx }}
      >
        {body}
      </div>

      <ReservationDetailPanel
        reservationId={selectedReservationId}
        onClose={() => setSelectedReservationId(null)}
        onOpenChart={(customerId, reservationId) =>
          navigate(`/customers?customerId=${encodeURIComponent(customerId)}&reservationId=${encodeURIComponent(reservationId)}`, {
            state: { fromSchedule: true },
          })
        }
        onRebook={(info) =>
          setCreateDefaults({
            storeId: info.storeId ?? null,
            resourceId: info.resourceId ?? null,
            minutes: null,
            serviceIds: info.serviceIds,
            customer: { id: info.customerId ?? null, displayName: info.customerName, displayNameKana: info.customerKana, phone: info.phone },
          })
        }
      />
      {createDefaults && (
        <ReservationCreatePanel
          key={JSON.stringify(createDefaults)}
          open
          onClose={() => setCreateDefaults(null)}
          defaultStoreId={createDefaults.storeId ?? storeId}
          defaultResourceId={createDefaults.resourceId}
          defaultDate={createDefaults.date ?? date}
          defaultMinutes={createDefaults.minutes}
          defaultServiceIds={createDefaults.serviceIds}
          defaultCustomer={createDefaults.customer}
        />
      )}
      <Sheet open={pendingOpen} onOpenChange={setPendingOpen}>
        <SheetContent side="right" className="w-full sm:max-w-md" aria-describedby={undefined}>
          <SheetTitle>承認待ち</SheetTitle>
          {pendingCount === 0 && <p className="mt-4 text-sm">承認待ちの予約はありません。</p>}
          <div className="mt-4">
            <PendingApprovalsCard
              selectedStoreId={storeId}
              fullList
              onSelect={(id) => {
                const reservation = pendingList.find((item) => item.id === id);
                if (reservation) setDate(new Date(reservation.startAt));
                setPendingOpen(false);
                setSelectedReservationId(id);
              }}
            />
          </div>
        </SheetContent>
      </Sheet>
      <PendingConfirmDialog
        open={cancelBlock !== null}
        pending={cancelBlockMutation.isPending}
        title="ブロックを取消しますか?"
        description={
          cancelBlock
            ? `${cancelBlock.titleSnapshot ?? "ブロック"}（${formatTime(cancelBlock.startAt)}–${formatTime(cancelBlock.endAt)}）を取消します。この操作は元に戻せません。`
            : ""
        }
        confirmLabel="ブロックを取消す"
        pendingLabel="取消中..."
        destructive
        onOpenChange={() => setCancelBlock(null)}
        onConfirm={() => {
          if (!cancelBlock) return;
          cancelBlockMutation.mutate({ externalBlockId: cancelBlock.id }, { onSuccess: () => setCancelBlock(null) });
        }}
      />
    </div>
  );
}
