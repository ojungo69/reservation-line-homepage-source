import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router";
import { Plus } from "lucide-react";
import {
  CalendarColumns,
  DayHeaderCells,
  DayList,
  FALLBACK_OPENING_MINUTE,
  columnState,
  openingOf,
} from "@/components/calendar-v2/body";
import { STORE_COLUMN_MIN_WIDTH_PX, activeResourceIds, buildColumns, effectiveView, visibleStoreId, type CalendarColumn, type CalendarView } from "@/components/calendar-v2/columns";
import { PX_PER_MINUTE, mondayWeek } from "@/components/calendar-v2/geometry";
import { CalendarGrid } from "@/components/calendar-v2/grid";
import { dayLabel, shortDayLabel, spanLabel, weekHeading } from "@/components/calendar-v2/labels";
import { CalendarNotices } from "@/components/calendar-v2/notices";
import { PeriodStrip } from "@/components/calendar-v2/period-strip";
import { CalendarLayers, CreateReservationButton } from "@/components/calendar-v2/sidebar-parts";
import { CalendarTopBar, DayHeader, DayHeaderRow } from "@/components/calendar-v2/top-bar";
import { useCalendarDate, useCalendarDays } from "@/components/calendar-v2/use-calendar-days";
import { useCalendarLayout } from "@/components/calendar-v2/use-calendar-layout";
import { stableAnchor } from "@/components/calendar-v2/stable-anchor";
import { useCalendarLayers } from "@/components/calendar-v2/use-calendar-layers";
import { useCalendarView } from "@/components/calendar-v2/use-calendar-view";
import { usePeriodSwipe } from "@/components/calendar-v2/use-period-swipe";
import { useReturnFocus } from "@/components/calendar-v2/use-return-focus";
import { PendingApprovalsCard } from "@/components/schedule/pending-approvals-card";
import { ReservationCreatePanel } from "@/components/schedule/reservation-create-panel";
import { ReservationDetailPanel } from "@/components/schedule/reservation-detail-panel";
import { PRESSABLE } from "@/components/shell-v2/pressable";
import { useShellV2 } from "@/components/shell-v2/shell-context";
import { PendingConfirmDialog } from "@/components/ui/pending-confirm-dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useAuth } from "@/hooks/use-auth";
import { useExternalBlockCancel } from "@/hooks/use-external-blocks";
import { DOCKED_QUERY, NARROW_QUERY, useMediaQuery } from "@/hooks/use-media-query";
import { usePendingReservations } from "@/hooks/use-reservations";
import { useSettings } from "@/hooks/use-settings";
import { useStores } from "@/hooks/use-stores";
import { addDays, formatFullJstDate, formatJstDate, toJstDate } from "@/lib/timeline";
import { cn } from "@/lib/utils";
import type { ExternalBlock } from "@/types/api";

// The pending list's row limit (listPendingReservations in src/admin/reservations.ts).
const PENDING_ROW_CAP = 200;

/** The bar's heading, the period read out when it changes (with its year), and the step of 前/次 for the view. */
function barText(week: boolean, narrow: boolean, date: Date, dayDates: readonly Date[]) {
  if (week) return { heading: weekHeading(dayDates), spoken: `${formatFullJstDate(dayDates[0])}から${formatFullJstDate(dayDates[6])}`, stepUnit: "週" as const, stepDays: 7 };
  return { heading: narrow ? shortDayLabel(date) : dayLabel(date), spoken: formatFullJstDate(date), stepUnit: "日" as const, stepDays: 1 };
}

/** The pending count for the store shown; null until the list is read. */
function pendingSummary(query: ReturnType<typeof usePendingReservations>, storeId: string | null) {
  const list = query.data?.ok ? query.data.reservations : [];
  const ready = !query.isPending && !query.isError;
  return {
    list,
    count: ready ? list.filter((item) => !storeId || item.storeId === storeId).length : null,
    // The list holds the 200 with the nearest deadlines across the stores you can
    // see (the shared card says so), so a full one may miss this store's.
    capped: list.length >= PENDING_ROW_CAP,
  };
}

// Columns need the store list, which comes with the store settings.
function NoColumns({ loading }: Readonly<{ loading: boolean }>) {
  return <p className="px-4 py-3 text-sm">{loading ? "予定を読み込み中…" : "表示できる店舗がありません。"}</p>;
}

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
  // The sidebar stays on screen: the detail opens beside what was pressed (DESIGN.md §5).
  const docked = useMediaQuery(DOCKED_QUERY);
  const { requested, choose: chooseView, openDay: showDay } = useCalendarView(narrow, storeId);
  // The 週 button was pressed while all stores are shown: say why the day stays.
  const [weekAsked, setWeekAsked] = useState(false);
  const view = effectiveView(requested, { narrow, storeId });
  const week = view === "week";
  const { date, setDate, now } = useCalendarDate();
  const location = useLocation();
  const navigate = useNavigate();
  const shell = useShellV2();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const dateBandRef = useRef<HTMLFieldSetElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const periodOf = (at: Date) => (week ? mondayWeek(at) : [at]);
  const dayDates = periodOf(date);
  const dayKeys = dayDates.map(formatJstDate);
  const bar = barText(week, narrow, date, dayDates);
  // The periods a swipe brings in from the sides (PeriodStrip).
  const prevDate = addDays(date, -bar.stepDays);
  const nextDate = addDays(date, bar.stepDays);
  const days = useCalendarDays(dayKeys);
  const neighbourDays = useCalendarDays([prevDate, nextDate].flatMap(periodOf).map(formatJstDate), { preview: true });
  const dayByKey = new Map([...days, ...neighbourDays].map((day) => [day.dateKey, day]));
  const settingsQuery = useSettings({ live: true });
  const settings = settingsQuery.data?.ok ? settingsQuery.data.settings : null;
  const pendingQuery = usePendingReservations();
  const cancelBlockMutation = useExternalBlockCancel();

  const [selectedReservationId, setSelectedReservationId] = useState<string | null>(null);
  const [createDefaults, setCreateDefaults] = useState<CreateDefaults | null>(null);
  const [pendingOpen, setPendingOpen] = useState(false);
  const [cancelBlock, setCancelBlock] = useState<ExternalBlock | null>(null);
  const [layers, setLayers] = useCalendarLayers();

  const columnsAt = (at: Date) => (view === "list" ? [] : buildColumns(view, at, storeId, stores));
  const columns = columnsAt(date);
  const allStoresDay = view === "day" && storeId === null;
  const minColumnsWidth = allStoresDay ? columns.length * STORE_COLUMN_MIN_WIDTH_PX : undefined;
  const periodKey = `${view}|${dayKeys[0]}|${storeId ?? "all"}`;
  const settingsUsable = settings !== null && !settingsQuery.isError;
  const states = columns.map((column) => columnState(column, dayByKey, settings, settingsUsable));
  const storesWhere = (test: (state: (typeof states)[number]) => boolean) =>
    [...new Set(states.filter(test).map((state) => state.column.storeName))];
  const { overlayRef, scrollerRef, layout, columnsOverflow } = useCalendarLayout(columns.length, periodKey);

  // Page move stays shut while a sheet of this page is open (see ShellV2).
  const sheetOpen = selectedReservationId !== null || createDefaults !== null || pendingOpen || cancelBlock !== null;
  useEffect(() => {
    if (!shell) return;
    shell.setPaletteBlocked(sheetOpen);
    return () => shell.setPaletteBlocked(false);
  }, [shell, sheetOpen]);

  const opener = useReturnFocus(sheetOpen, scrollerRef);
  // Made when a detail opens, so one opened from <body> does not take the last one's place.
  const detailAnchor = useRef<ReturnType<typeof stableAnchor> | null>(null);
  // Chosen when it opens and kept while open: a switch across 64rem would mount a
  // second modal over an open confirmation (the discard check) and take its focus.
  const [detailLayout, setDetailLayout] = useState<"popover" | "bottom">("popover");
  const openDetail = (id: string, from: HTMLElement) => {
    opener.current = from;
    detailAnchor.current = stableAnchor(from);
    setDetailLayout(docked ? "popover" : "bottom");
    setSelectedReservationId(id);
  };

  // Open at the store's opening time (DESIGN.md §5) when the shown days, the store
  // or the view change; scrollKey names every input read here, so a refresh does
  // not move the grid. A step to the next or previous period keeps the hours in
  // view, so days compare at the same time (INT-01-05).
  const scrollKey = `${periodKey}|${String(settings !== null)}`;
  const keepHours = useRef(false);
  // Whether the grid was open at a time, so a step has hours to keep.
  const gridOpen = useRef(false);
  useLayoutEffect(() => {
    const keep = keepHours.current && gridOpen.current;
    keepHours.current = false;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    if (view === "list" || !settings || columns.length === 0) {
      gridOpen.current = false;
      scroller.scrollTop = 0;
      return;
    }
    gridOpen.current = true;
    if (keep) return;
    // A closed day has no opening, so it does not pull the start back to 09:00.
    const opens = columns.map((column) => openingOf(settings, column)).filter((minute) => minute !== null);
    const open = opens.length > 0 ? Math.min(...opens) : FALLBACK_OPENING_MINUTE;
    scroller.scrollTop = Math.max(0, (open - 30) * PX_PER_MINUTE);
  }, [scrollKey]);
  // A move that stayed in the shown period (a day picked in the week) changed no
  // key; its flag must not carry over to a later change of view or store.
  useLayoutEffect(() => {
    keepHours.current = false;
  });

  // 次回予約 from a customer's chart lands here with the customer in the history
  // state; it opens the booking form once, as on the current calendar.
  const rebookConsumed = useRef(false);
  useEffect(() => {
    const rebook = (location.state as { rebook?: NonNullable<CreateDefaults["customer"]> } | null)?.rebook;
    if (!rebook) {
      rebookConsumed.current = false;
      return;
    }
    if (rebookConsumed.current) return;
    rebookConsumed.current = true;
    // Nothing on this page opened the form: closing it goes to the grid.
    opener.current = document.body;
    setCreateDefaults({ ...NO_DEFAULTS, customer: rebook });
    navigate(".", { replace: true, state: null });
  }, [location.state, navigate]);

  const onSlot = (column: CalendarColumn, minutes: number, from: HTMLElement) => {
    if (!settings) return;
    // Slots exist only where the store has an active resource (columnState).
    const ids = activeResourceIds(column.storeId, settings.resources);
    opener.current = from;
    setCreateDefaults({ storeId: column.storeId, resourceId: ids.length === 1 ? ids[0] : null, minutes, date: column.date });
  };
  // The sidebar's 予約を追加 and the ＋ button: the shown store and day, no time,
  // as the current calendar's create button.
  const openCreate = (from: HTMLElement) => {
    shell?.closeMenu();
    opener.current = from;
    setCreateDefaults(NO_DEFAULTS);
  };
  const onBlock = (block: ExternalBlock, from: HTMLElement) => {
    opener.current = from;
    setCancelBlock(block);
  };
  // The pressed day header goes away with the week, so focus moves to the heading,
  // which names the day just opened.
  const focusHeading = useRef(false);
  useEffect(() => {
    if (!focusHeading.current) return;
    focusHeading.current = false;
    headingRef.current?.focus();
  });
  const openDay = (day: Date) => {
    setDate(day);
    showDay();
    focusHeading.current = true;
  };
  const onView = (next: CalendarView) => {
    chooseView(next);
    setWeekAsked(next === "week");
  };

  const { list: pendingList, count: pendingCount, capped: pendingCapped } = pendingSummary(pendingQuery, storeId);

  const todayKey = formatJstDate(now);
  const nowJst = toJstDate(now);
  const nowMinute = nowJst.getUTCHours() * 60 + nowJst.getUTCMinutes();
  // The bar's 前/次, its date picker and the body's swipe and wheel move here (T006).
  const goTo = (next: Date) => {
    keepHours.current = true;
    setDate(next);
  };
  const step = (direction: -1 | 1) => goTo(addDays(date, direction * bar.stepDays));
  usePeriodSwipe({ scrollerRef, rootRef, dateBandRef, onStep: step, periodKey, columnsOverflow });

  const blockHandler = isPrivileged ? onBlock : undefined;
  const headerAt = (at: Date) => (
    <DayHeaderRow minColumnsWidth={minColumnsWidth}>
      <DayHeaderCells
        columns={columnsAt(at)}
        dayByKey={dayByKey}
        week={week}
        allStores={storeId === null}
        todayKey={todayKey}
        onOpenDay={openDay}
      />
    </DayHeaderRow>
  );
  const bodyAt = (at: Date) => {
    if (view === "list") {
      return <DayList day={dayByKey.get(formatJstDate(at))} storeId={storeId} layers={layers} onDetails={openDetail} />;
    }
    const atColumns = columnsAt(at);
    if (atColumns.length === 0) return <NoColumns loading={settingsQuery.isPending} />;
    return (
      <CalendarGrid
        minColumnsWidth={minColumnsWidth}
        columnsOverflow={layout.columnsOverflow}
        gutterNowMinute={allStoresDay && atColumns[0].dateKey === todayKey ? nowMinute : null}
      >
        <CalendarColumns
          states={atColumns.map((column) => columnState(column, dayByKey, settings, settingsUsable))}
          week={week}
          nowDotInGutter={allStoresDay}
          todayKey={todayKey}
          nowMinute={nowMinute}
          columnPx={layout.columnPx}
          selectedId={selectedReservationId}
          layers={layers}
          onSlot={onSlot}
          onReservation={openDetail}
          onBlock={blockHandler}
        />
      </CalendarGrid>
    );
  };
  // The bar's names and the body each sit in a strip of three periods.
  const strip = (paneAt: (at: Date) => ReactNode, className?: string) => (
    <PeriodStrip
      className={className}
      fromTop={view === "list"}
      prev={{ key: formatJstDate(periodOf(prevDate)[0]), content: paneAt(prevDate) }}
      current={{ key: dayKeys[0], content: paneAt(date) }}
      next={{ key: formatJstDate(periodOf(nextDate)[0]), content: paneAt(nextDate) }}
    />
  );
  const dayHeader = <DayHeader scrollbarPx={layout.scrollbarPx}>{strip(headerAt)}</DayHeader>;

  return (
    <div ref={rootRef} className="relative h-full overflow-hidden bg-cal-surface text-cal-text">
      {/* First in the DOM, so Tab after 本文へスキップ reaches the bar before the grid. */}
      <div ref={overlayRef} className="pointer-events-none absolute inset-x-0 top-0 z-40">
        <CalendarTopBar
          heading={bar.heading}
          spoken={bar.spoken}
          headingRef={headingRef}
          dateBandRef={dateBandRef}
          date={date}
          onPickDate={goTo}
          view={view}
          weekShown={!narrow}
          onView={onView}
          onToday={() => setDate(new Date())}
          onStep={step}
          stepUnit={bar.stepUnit}
          pendingCount={pendingCount}
          pendingCapped={pendingCapped}
          onOpenPending={(from) => {
            opener.current = from;
            setPendingOpen(true);
          }}
          dayHeader={view === "list" ? null : dayHeader}
        />
        <CalendarNotices
          days={days}
          dayName={(dateKey) => dayLabel(new Date(`${dateKey}T00:00:00+09:00`))}
          noResourceStores={storesWhere((state) => state.noResource)}
          noHoursStores={storesWhere((state) => state.noHours)}
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
        // Keep the grid's layers under the bar and the neighbouring panes out of sight.
        // With overflowing columns the browser handles both scroll axes and zoom.
        className={cn(
          "isolate h-full overflow-x-hidden overflow-y-auto overscroll-contain outline-hidden",
          !layout.columnsOverflow && "touch-pan-y touch-pinch-zoom",
        )}
        style={{ paddingTop: layout.barPx, scrollPaddingTop: layout.barPx }}
      >
        {/* At least a screen tall, so a short day's neighbours show a screen of theirs.
            Room below for the ＋ button while the sidebar is a drawer: the grid's last
            hour and the list's last card scroll clear of it. It is the strip's, so the
            neighbours' previews, clipped to the strip, take it too. */}
        {strip(bodyAt, cn("min-h-full", !docked && "pb-[calc(6rem+env(safe-area-inset-bottom))]"))}
      </div>

      {/* The sidebar's parts for this page, before and after its page links (DESIGN.md §5). */}
      {shell?.sidebarSlots.top && createPortal(<CreateReservationButton onCreate={openCreate} />, shell.sidebarSlots.top)}
      {shell?.sidebarSlots.end && createPortal(<CalendarLayers layers={layers} onChange={setLayers} />, shell.sidebarSlots.end)}
      {/* Without the docked sidebar its create button is in the drawer: this one stays on screen. */}
      {!docked && (
        <button
          type="button"
          aria-label="予約を追加"
          onClick={(event) => openCreate(event.currentTarget)}
          className={cn(
            "glass-thick absolute bottom-[calc(1rem+env(safe-area-inset-bottom))] right-4 z-40 grid size-14 place-items-center rounded-full",
            PRESSABLE,
          )}
        >
          <Plus className="size-6 text-cal-primary" aria-hidden="true" />
        </button>
      )}

      <ReservationDetailPanel
        reservationId={selectedReservationId}
        layout={detailLayout}
        anchor={detailAnchor}
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
          <div className="mt-4">
            <PendingApprovalsCard
              selectedStoreId={storeId}
              fullList
              listCapped={pendingCapped}
              onSelect={(id) => {
                const reservation = pendingList.find((item) => item.id === id);
                if (reservation) setDate(new Date(reservation.startAt));
                setPendingOpen(false);
                // Beside the bar's 承認待ち button, which opened the list.
                openDetail(id, opener.current ?? document.body);
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
            ? `${cancelBlock.titleSnapshot ?? "ブロック"}（${spanLabel(cancelBlock.startAt, cancelBlock.endAt)}）を取消します。この操作は元に戻せません。`
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
