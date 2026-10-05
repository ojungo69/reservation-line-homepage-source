import { useState, useMemo, useCallback, useEffect, useRef, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { useStores } from "@/hooks/use-stores";
import { useReservations, usePendingReservations } from "@/hooks/use-reservations";
import { useSettings } from "@/hooks/use-settings";
import { useExternalBlocks, useExternalBlockCancel } from "@/hooks/use-external-blocks";
import { formatJstDate, addDays, jstWeekday, toJstDate, statusColor, statusLabel, formatTime, formatDateTime, formatDateDisplay, formatFullJstDate, isScheduleVisibleReservationStatus } from "@/lib/timeline";
import { cn } from "@/lib/utils";
import { displayServiceName } from "@/lib/service-pricing";
import { ScheduleHeader } from "@/components/schedule/schedule-header";
import { ReservationListCard } from "@/components/schedule/reservation-list-card";
import { TimelineGrid } from "@/components/schedule/timeline-grid";
import { PendingApprovalsCard } from "@/components/schedule/pending-approvals-card";
import { ScheduleSyncAttention } from "@/components/schedule/sync-attention";
import { ReservationDetailPanel } from "@/components/schedule/reservation-detail-panel";
import { ReservationCreatePanel } from "@/components/schedule/reservation-create-panel";
import { ExternalBlockCreateDialog } from "@/components/schedule/external-block-create-dialog";
import { PendingConfirmDialog } from "@/components/ui/pending-confirm-dialog";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useMediaQuery, NARROW_QUERY } from "@/hooks/use-media-query";
import { useTimelineDensity } from "@/hooks/use-timeline-density";
import type { Reservation, Store } from "@/types/api";

export default function SchedulePage() {
  const { selectedStoreId } = useStores();
  // One-off external blocks are owner/system_admin only (the backend rejects
  // staff), so only privileged users get the create action.
  const { isPrivileged } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [date, setDate] = useState(() => new Date());
  const [viewMode, setViewMode] = useState<"day" | "week">("day");
  const [mobileView, setMobileView] = useState<"agenda" | "timeline">("agenda");
  // スマホ幅 (Tailwind sm 未満) では週表示が横7分割で読めないため日表示に固定する。
  const isNarrow = useMediaQuery(NARROW_QUERY);
  // 狭幅では選択値に関わらず日表示へ強制 (state は保持し、広幅へ戻れば週表示が復元される)
  const effectiveViewMode = isNarrow ? "day" : viewMode;
  const showAgenda = isNarrow && mobileView === "agenda";
  // タイムラインの表示密度 (標準 40px / コンパクト 24px)。localStorage 永続。
  // 週表示はスロットグリッドを持たないためトグルは日表示のみに配線する。
  const { density, setDensity, slotPx } = useTimelineDensity();
  const [selectedReservationId, setSelectedReservationId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [blockCreateOpen, setBlockCreateOpen] = useState(false);
  const [cancelBlockId, setCancelBlockId] = useState<string | null>(null);
  const [createDefaults, setCreateDefaults] = useState<{
    resourceId: string | null;
    minutes: number | null;
    storeId?: string | null;
    serviceIds?: string[] | null;
    customer?: { id?: string | null; displayName: string; displayNameKana?: string | null; phone?: string | null } | null;
  }>({ resourceId: null, minutes: null });

  const dateKey = formatJstDate(date);
  const {
    data: reservationsData,
    isPending: reservationsLoading,
    isError: reservationsError,
    dataUpdatedAt: reservationsUpdatedAt,
    refetch: refetchReservations,
  } = useReservations(dateKey);
  const { data: pendingData, isPending: pendingLoading, isError: pendingError } = usePendingReservations();
  const { data: settingsData, isPending: settingsLoading, isError: settingsError, dataUpdatedAt: settingsUpdatedAt, refetch: refetchSettings } = useSettings({ live: true });
  const { data: blocksData, isPending: blocksLoading, isError: blocksError, dataUpdatedAt: blocksUpdatedAt, refetch: refetchBlocks } = useExternalBlocks();
  const cancelBlockMutation = useExternalBlockCancel();

  const settings = settingsData?.ok ? settingsData.settings : null;
  const scheduleError = reservationsError || settingsError || blocksError;
  const scheduleLoading = reservationsLoading || settingsLoading || blocksLoading;
  const lastUpdatedAt = Math.min(reservationsUpdatedAt ?? 0, blocksUpdatedAt ?? 0, settingsUpdatedAt ?? 0);
  const renderDataStatus = () => {
    const failedSources = [reservationsError && "予約", blocksError && "ブロック", settingsError && "店舗設定"].filter(Boolean).join("・");
    const hasPreviousData = reservationsData?.ok && settingsData?.ok && blocksData?.ok;
    if (scheduleError) {
      return (
    <div role="alert" className="mx-4 mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <span>
        {failedSources}の{hasPreviousData ? "更新" : "読み込み"}に失敗しました。空き状況を表示できません。
        {lastUpdatedAt > 0 && <span className="ml-1">前回の取得: {formatDateTime(new Date(lastUpdatedAt).toISOString())}</span>}
      </span>
      <Button variant="outline" size="sm" onClick={() => {
        void refetchReservations();
        void refetchBlocks();
        void refetchSettings();
      }}>再読み込み</Button>
    </div>
      );
    }
    if (lastUpdatedAt <= 0) return null;
    return (
    <p className="px-4 py-1 text-xs text-muted-foreground">予定の最終更新: {formatDateTime(new Date(lastUpdatedAt).toISOString())}</p>
    );
  };

  const filteredReservations = useMemo(() => {
    const reservations = reservationsData?.ok ? reservationsData.reservations : [];
    return reservations.filter(
      (r) =>
        isScheduleVisibleReservationStatus(r.status) &&
        (!selectedStoreId || r.storeId === selectedStoreId),
    );
  }, [reservationsData, selectedStoreId]);

  const filteredBlocks = useMemo(() => {
    const externalBlocks = blocksData?.ok ? blocksData.externalBlocks : [];
    const dayStartMs = Date.parse(`${dateKey}T00:00:00+09:00`);
    const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000;
    return externalBlocks.filter((b) => {
      if (b.status !== "active") return false;
      if (selectedStoreId && b.storeId !== selectedStoreId) return false;
      const blockStartMs = Date.parse(b.startAt);
      const blockEndMs = Date.parse(b.endAt);
      return blockStartMs < dayEndMs && blockEndMs > dayStartMs;
    });
  }, [blocksData, selectedStoreId, dateKey]);

  const counts = useMemo(() => {
    const pendingList = pendingData?.ok ? pendingData.reservations : [];
    let confirmed = 0;
    let completed = 0;
    for (const r of filteredReservations) {
      if (r.status === "confirmed") confirmed++;
      else if (r.status === "completed") completed++;
    }
    const pending = selectedStoreId
      ? pendingList.filter((p) => p.storeId === selectedStoreId).length
      : pendingList.length;
    return { pending: pendingLoading || pendingError ? null : pending, confirmed, completed };
  }, [filteredReservations, pendingData, selectedStoreId, pendingLoading, pendingError]);

  const handleSlotClick = useCallback((resourceId: string, minutes: number) => {
    setCreateDefaults({ resourceId, minutes });
    setCreateOpen(true);
  }, []);

  const handleReservationClick = useCallback((id: string) => {
    setSelectedReservationId(id);
  }, []);

  const handleRebook = useCallback((info: { customerId?: string | null; customerName: string; customerKana?: string | null; phone?: string | null; serviceIds: string[]; storeId?: string; resourceId?: string }) => {
    setCreateDefaults({
      resourceId: info.resourceId ?? null,
      minutes: null,
      storeId: info.storeId ?? null,
      serviceIds: info.serviceIds,
      // Pass the existing customer's id so the create panel pre-selects them in
      // existing-customer mode (all roles book rebooks by customerId — staff only
      // see masked phones); name/kana/phone stay for the new-customer fallback
      // when no customerId is available.
      customer: { id: info.customerId ?? null, displayName: info.customerName, displayNameKana: info.customerKana, phone: info.phone },
    });
    setCreateOpen(true);
  }, []);

  // 顧客カルテの「次回予約」から遷移してきた場合、router state に積まれた
  // 顧客情報で予約作成パネルを開く。一度消費したら state を消し、リロード・戻る
  // で再発火しないようにする（StrictMode の二重実行は ref で抑止）。
  const rebookConsumed = useRef(false);
  useEffect(() => {
    const state = location.state as
      | { rebook?: { id?: string | null; displayName: string; displayNameKana?: string | null; phone?: string | null } }
      | null;
    const rebook = state?.rebook;
    // Reset the guard once the state is cleared so a later 次回予約 (e.g. without a
    // remount) is processed again, rather than being permanently swallowed.
    if (!rebook) {
      rebookConsumed.current = false;
      return;
    }
    if (rebookConsumed.current) return;
    rebookConsumed.current = true;
    setCreateDefaults({
      resourceId: null,
      minutes: null,
      storeId: null,
      serviceIds: undefined,
      customer: {
        id: rebook.id ?? null,
        displayName: rebook.displayName,
        displayNameKana: rebook.displayNameKana,
        phone: rebook.phone,
      },
    });
    setCreateOpen(true);
    // React Router API で state を消す（window.history を直接触らない）。
    navigate(".", { replace: true, state: null });
  }, [location.state, navigate]);

  // タイムライン上のブロックをクリックしたら解除確認ダイアログを開く。
  // 解除は owner/system_admin 限定（バックエンドが staff を拒否するため、
  // 作成アクションと同じく privileged にのみ通知を配線する）。
  const handleBlockClick = useCallback((blockId: string) => {
    setCancelBlockId(blockId);
  }, []);
  const handleCreateBlockClick = useCallback(() => setBlockCreateOpen(true), []);
  const privilegedCreateBlockClick = isPrivileged ? handleCreateBlockClick : undefined;
  const privilegedBlockClick = isPrivileged ? handleBlockClick : undefined;

  // ダイアログ表示用に、選択中ブロックの実体を読み込み済み配列から引く。
  const cancelBlock = useMemo(
    () => filteredBlocks.find((b) => b.id === cancelBlockId) ?? null,
    [filteredBlocks, cancelBlockId],
  );
  const cancelBlockDescription = cancelBlock
    ? `${cancelBlock.titleSnapshot ?? "ブロック"}（${formatTime(cancelBlock.startAt)}–${formatTime(cancelBlock.endAt)}）を取消します。この操作は元に戻せません。`
    : "";

  const confirmCancelBlock = () => {
    if (!cancelBlockId) return;
    cancelBlockMutation.mutate(
      { externalBlockId: cancelBlockId },
      { onSuccess: () => setCancelBlockId(null) },
    );
  };

  // ブロック解除ダイアログは day-view にしか描画されない。開いたまま
  // week-view へ切り替えると state が取り残され、day-view に戻った時に
  // 取消済みかもしれないブロックのダイアログが再表示される。週表示へ移る
  // 際にリセットして取り残しを防ぐ。
  useEffect(() => {
    if (effectiveViewMode === "week" && cancelBlockId !== null) {
      setCancelBlockId(null);
    }
  }, [effectiveViewMode, cancelBlockId]);

  // 週表示/日表示の両方の末尾に出るオーバーレイ。同じ render scope なので prop 配線は不要。
  const overlays = (
    <>
      <ReservationDetailPanel
        onOpenChart={(customerId, reservationId) => navigate(`/customers?customerId=${encodeURIComponent(customerId)}&reservationId=${encodeURIComponent(reservationId)}`)}
        reservationId={selectedReservationId}
        onClose={() => setSelectedReservationId(null)}
        onRebook={handleRebook}
      />
      {createOpen && (
        <ReservationCreatePanel
          key={JSON.stringify(createDefaults)}
          open
          onClose={() => setCreateOpen(false)}
          defaultStoreId={createDefaults.storeId ?? selectedStoreId}
          defaultResourceId={createDefaults.resourceId}
          defaultDate={date}
          defaultMinutes={createDefaults.minutes}
          defaultServiceIds={createDefaults.serviceIds}
          defaultCustomer={createDefaults.customer}
        />
      )}
      <ExternalBlockCreateDialog
        open={blockCreateOpen}
        onOpenChange={setBlockCreateOpen}
        defaultStoreId={selectedStoreId}
      />
    </>
  );

  const header = (
    <ScheduleHeader
        date={date}
        onDateChange={setDate}
        viewMode={effectiveViewMode}
        onViewModeChange={setViewMode}
        pendingCount={counts.pending}
        confirmedCount={reservationsLoading || reservationsError ? null : counts.confirmed}
        completedCount={reservationsLoading || reservationsError ? null : counts.completed}
        onCreateClick={() => { setCreateDefaults({ resourceId: null, minutes: null }); setCreateOpen(true); }}
        onCreateBlockClick={privilegedCreateBlockClick}
        isNarrow={isNarrow}
        {...(effectiveViewMode === "week" ? { countsLabel: "選択日" } : {
          mobileView, onMobileViewChange: setMobileView, density, onDensityChange: setDensity,
        })}
      />
  );

  if (effectiveViewMode === "week") {
    return (
      <div className="flex h-full flex-col">
        {header}
        <ScheduleSyncAttention />
        <PendingApprovalsCard
          selectedStoreId={selectedStoreId}
          onSelect={handleReservationClick}
        />
        {/* 週の各日の予約失敗は WeekView 内で表示する。 */}
        {(settingsError || blocksError) && renderDataStatus()}
        <WeekView
          date={date}
          storeId={selectedStoreId}
          onReservationClick={handleReservationClick}
          onDayClick={(d) => { setDate(d); setViewMode("day"); }}
        />
        {overlays}
      </div>
    );
  }

  return (
    <div className={showAgenda ? "flex min-h-full flex-col" : "flex h-full flex-col"}>
      {header}
      <ScheduleSyncAttention />
      <PendingApprovalsCard
        selectedStoreId={selectedStoreId}
        onSelect={handleReservationClick}
      />
      {/* 取得失敗を「予約ゼロの日」と区別し、空き枠クリックも止める (issue #467)。 */}
      {renderDataStatus()}
      {showAgenda ? (
        <DayAgenda
          date={date}
          storeId={selectedStoreId}
          stores={settings?.stores}
          reservations={filteredReservations}
          isLoading={scheduleLoading}
          isError={scheduleError}
          onReservationClick={handleReservationClick}
        />
      ) : !scheduleError && (
        <TimelineGrid
          date={date}
          resources={settings?.resources ?? []}
          stores={settings?.stores ?? []}
          reservations={filteredReservations}
          externalBlocks={filteredBlocks}
          businessHours={settings?.businessHours ?? []}
          storeId={selectedStoreId}
          isLoading={scheduleLoading}
          slotPx={slotPx}
          onReservationClick={handleReservationClick}
          onSlotClick={handleSlotClick}
          onBlockClick={privilegedBlockClick}
        />
      )}
      {overlays}
      <PendingConfirmDialog
        open={cancelBlockId !== null}
        pending={cancelBlockMutation.isPending}
        title="ブロックを取消しますか?"
        description={cancelBlockDescription}
        confirmLabel="ブロックを取消す"
        pendingLabel="取消中..."
        destructive
        onOpenChange={() => setCancelBlockId(null)}
        onConfirm={confirmCancelBlock}
      />
    </div>
  );
}

function DayAgenda({ date, storeId, stores, reservations, isLoading, isError, onReservationClick }: Readonly<{
  date: Date;
  storeId: string | null;
  stores?: Store[];
  reservations: Reservation[];
  isLoading: boolean;
  isError: boolean;
  onReservationClick: (id: string) => void;
}>) {
  const storeName = storeId
    ? stores?.find((store) => store.id === storeId)?.name ?? "選択中の店舗"
    : "全店舗";
  let body: ReactNode = null;
  if (!isError) {
    if (isLoading) {
      body = <output aria-label="予定を読み込み中" className="block text-sm text-muted-foreground">予定を読み込み中…</output>;
    } else if (reservations.length === 0) {
      body = <p className="rounded-md border p-6 text-center text-sm text-muted-foreground">この日の予約はありません</p>;
    } else {
      body = (
        <ul className="space-y-2">
          {reservations.map((reservation) => (
            <li key={reservation.id}>
              <ReservationListCard reservation={reservation} onDetails={onReservationClick} />
            </li>
          ))}
        </ul>
      );
    }
  }

  return (
    <section aria-label="選択日の予約" className="min-w-0 space-y-3 px-4 py-3">
      <h2 className="text-sm font-semibold">{formatDateDisplay(date)} · {storeName}</h2>
      {body}
    </section>
  );
}

const weekdays = ["日", "月", "火", "水", "木", "金", "土"];

function WeekView({
  date,
  storeId,
  onReservationClick,
  onDayClick,
}: Readonly<{
  date: Date;
  storeId: string | null;
  onReservationClick: (id: string) => void;
  onDayClick: (date: Date) => void;
}>) {
  const weekStart = useMemo(() => {
    const d = new Date(date);
    // JST 基準の曜日で週頭(日曜)を求める。ブラウザのローカルTZ依存だと
    // 非JST環境で週の境界が1日ずれる。
    const day = jstWeekday(d);
    return addDays(d, -day);
  }, [date]);

  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );

  const dayKeys = useMemo(() => days.map((d) => formatJstDate(d)), [days]);

  const day0 = useReservations(dayKeys[0]);
  const day1 = useReservations(dayKeys[1]);
  const day2 = useReservations(dayKeys[2]);
  const day3 = useReservations(dayKeys[3]);
  const day4 = useReservations(dayKeys[4]);
  const day5 = useReservations(dayKeys[5]);
  const day6 = useReservations(dayKeys[6]);

  const dayQueries = [day0, day1, day2, day3, day4, day5, day6];

  return (
    <div className="flex flex-1 overflow-auto">
      {days.map((d, i) => {
        const dayKey = dayKeys[i];
        const query = dayQueries[i];
        const dayReservations = query.data?.ok ? query.data.reservations : [];
        const filtered = dayReservations.filter(
          (r) =>
            isScheduleVisibleReservationStatus(r.status) &&
            (!storeId || r.storeId === storeId),
        );
        const isToday = formatJstDate(new Date()) === dayKey;

        return (
          <div key={dayKey} className="flex min-w-[120px] flex-1 flex-col border-r last:border-r-0">
            <button
              type="button"
              onClick={() => onDayClick(d)}
              aria-label={`${formatFullJstDate(d)}の日表示を開く`}
              aria-current={isToday ? "date" : undefined}
              className={`sticky top-0 z-10 w-full border-b px-2 py-1.5 text-center text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ${isToday ? "bg-blue-50 dark:bg-blue-950" : "bg-muted/50"}`}
            >
              <div>{weekdays[i]}</div>
              <div className={isToday ? "font-bold text-blue-600 dark:text-blue-400" : ""}>
                {toJstDate(d).getUTCDate()}
              </div>
            </button>
            <div className={cn("flex-1 space-y-0.5 p-1", isToday && "bg-blue-50/40 dark:bg-blue-950/30")}>
              {query.isPending && (
                <output aria-label="読み込み中" className="block py-4 text-center text-xs text-muted-foreground">...</output>
              )}
              {/* 取得失敗を空日「—」と区別する (day 表示のエラーバナーと同趣旨、issue #467)。 */}
              {!query.isPending && query.isError && (
                <div role="alert" className="py-4 text-center text-xs text-destructive">
                  <div>{query.dataUpdatedAt > 0 ? "更新に失敗しました" : "読み込みに失敗しました"}</div>
                  {query.dataUpdatedAt > 0 && <p>前回の取得: {formatDateTime(new Date(query.dataUpdatedAt).toISOString())}</p>}
                  <button
                    type="button"
                    className="inline-flex min-h-11 min-w-11 items-center justify-center underline"
                    onClick={() => query.refetch()}
                  >
                    再試行
                  </button>
                </div>
              )}
              {!query.isPending && !query.isError && query.dataUpdatedAt > 0 && (
                <p className="pb-1 text-xs text-muted-foreground">最終更新: {formatDateTime(new Date(query.dataUpdatedAt).toISOString())}</p>
              )}
              {!query.isPending && !query.isError && filtered.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className={`w-full rounded border px-1.5 py-0.5 text-left text-xs transition-opacity hover:opacity-80 ${statusColor(r.status)}`}
                  // 巡回ゲートが「fixture 由来の表示対象 status が全て実描画された」
                  // ことを照合するためのマーカー。
                  data-reservation-status={r.status}
                  onClick={() => onReservationClick(r.id)}
                >
                  <div className="truncate font-medium">{formatTime(r.startAt)} · {statusLabel(r.status)}</div>
                  <div className="truncate">{r.customerDisplayName}</div>
                  {/* opacity-60 は status 色で実効 3.08〜3.35:1 と AA 未達 (週表示
                      走査で検出)。弱調は text-xs のみで表現する。 */}
                  <div className="truncate">{displayServiceName(r.serviceName)}</div>
                </button>
              ))}
              {!query.isPending && !query.isError && filtered.length === 0 && (
                <div className="py-4 text-center text-xs text-muted-foreground">—</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
