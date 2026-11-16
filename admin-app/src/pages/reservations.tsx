import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useNavigate, useLocation } from "react-router";
import { useMutationState } from "@tanstack/react-query";
import { CalendarX } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { RejectReasonDialog } from "@/components/schedule/reject-reason-dialog";
import { SortableHead, type SortDir } from "@/components/ui/sortable-head";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StoreSelect } from "@/components/ui/store-select";
import { ReservationDetailPanel } from "@/components/schedule/reservation-detail-panel";
import { PendingApprovalsCard } from "@/components/schedule/pending-approvals-card";
import {
  reservationPresetRange,
  readReservationSearchState,
  type ReservationSearchState,
  type ReservationSortKey,
  type ReservationViewMode,
} from "@/lib/reservation-search-state";
import { ReservationListCard } from "@/components/schedule/reservation-list-card";
import { useSettings } from "@/hooks/use-settings";
import { useStores } from "@/hooks/use-stores";
import { useAuth } from "@/hooks/use-auth";
import {
  useReservationSearch,
  buildCsvExportUrl,
  type ReservationSearchFilter,
} from "@/hooks/use-reservation-search";
import { useReservationAction } from "@/hooks/use-reservations";
import type { ReservationSearchItem } from "@/types/api";
import {
  statusLabel,
  statusColor,
  formatTime,
  formatDateDisplay,
} from "@/lib/timeline";
import { errorMessage } from "@/lib/error-messages";
import { ApiError } from "@/lib/api-client";
import { displayServiceName } from "@/lib/service-pricing";
import { useMediaQuery } from "@/hooks/use-media-query";
import {
  collectPendingMutationIds,
  RESERVATION_ACTION_MUTATION_KEY,
} from "@/lib/pending-mutation-ids";

const ALL_STATUSES = [
  "pending_approval",
  "confirmed",
  "checked_in",
  "completed",
  "cancelled_by_admin",
  "cancelled_by_customer",
  "rejected",
  "no_show",
  "expired",
] as const;

const ALL_SENTINEL = "__all__";
const MAX_SEARCH_DAYS = 92;

type SortKey = ReservationSortKey;

// 文字列の既定比較(sortKey ソートのフォールバック)。
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function reservationQueryErrorMessage(error: unknown): string {
  const queryReason = error instanceof ApiError ? (error.body as { reason?: string } | null)?.reason : undefined;
  const translatedQueryReason = queryReason ? errorMessage(queryReason) : null;
  return translatedQueryReason && translatedQueryReason !== queryReason
    ? translatedQueryReason
    : "予約データの取得に失敗しました。";
}

// 空状態。フィルタが既定値から変更されているときだけ絞り込みのヒントを添える
function ReservationsEmptyState({ hasActiveFilters }: Readonly<{ hasActiveFilters: boolean }>) {
  return (
    <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground motion-safe:animate-[empty-state-in_200ms_ease-out]">
      <CalendarX className="size-8" aria-hidden="true" />
      <p className="text-sm">該当する予約はありません</p>
      {hasActiveFilters && (
        <p className="text-xs">絞り込み条件を変更すると見つかる場合があります</p>
      )}
    </div>
  );
}

// カード表示には列ヘッダが無いため、テーブルの SortableHead 相当を明示コントロールで提供する
const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: "startAt", label: "日時" },
  { value: "customerDisplayName", label: "顧客" },
  { value: "serviceName", label: "メニュー" },
  { value: "storeName", label: "店舗" },
  { value: "status", label: "ステータス" },
];

export default function ReservationsPage() {
  const { user } = useAuth();
  const { data: settingsData } = useSettings();
  const settings = settingsData?.ok ? settingsData.settings : null;

  const location = useLocation();
  const navigationScope = `${user.email}:${user.role}:${user.storeId ?? ""}`;
  const [restored] = useState(() => readReservationSearchState(location.state, navigationScope));
  const [defaultRange] = useState(() => reservationPresetRange("upcoming"));
  const [viewMode, setViewMode] = useState<ReservationViewMode>(() =>
    location.state?.reservationView === "pending" ? "pending" : restored?.viewMode ?? "upcoming",
  );
  const [from, setFrom] = useState(restored?.from ?? defaultRange.from);
  const [to, setTo] = useState(restored?.to ?? defaultRange.to);
  const { selectedStoreId: storeId, selectStore: setStoreId, isStoreFixed } = useStores();
  const [serviceId, setServiceId] = useState(restored?.serviceId ?? ALL_SENTINEL);
  const [statusFilter, setStatusFilter] = useState(restored?.statusFilter ?? ALL_SENTINEL);
  const [keyword, setKeyword] = useState(restored?.keyword ?? "");
  const [debouncedKeyword, setDebouncedKeyword] = useDebouncedValue(keyword);
  const isDebouncing = keyword.trim() !== debouncedKeyword;
  const [selectedReservationId, setSelectedReservationId] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>(restored?.sortKey ?? "startAt");
  const [sortDir, setSortDir] = useState<SortDir>(restored?.sortDir ?? "asc");
  const [csvError, setCsvError] = useState<string | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [approveTarget, setApproveTarget] = useState<ReservationSearchItem | null>(null);
  const [rejectTarget, setRejectTarget] = useState<ReservationSearchItem | null>(null);
  const rowAction = useReservationAction();
  const pendingReservationVariables = useMutationState({
    filters: { mutationKey: RESERVATION_ACTION_MUTATION_KEY, status: "pending" },
    select: (mutation) => mutation.state.variables,
  });
  const pendingReservationIds = useMemo(
    () => collectPendingMutationIds(pendingReservationVariables, "reservationId"),
    [pendingReservationVariables],
  );
  const navigate = useNavigate();
  const pageRef = useRef<HTMLDivElement>(null);
  const narrowViewport = useMediaQuery("(max-width: 1023.98px)");
  const [narrowContainer, setNarrowContainer] = useState<boolean | null>(null);
  const isNarrow = narrowContainer ?? narrowViewport;
  useEffect(() => {
    if (!pageRef.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setNarrowContainer(entry.contentRect.width < 900));
    observer.observe(pageRef.current);
    return () => observer.disconnect();
  }, []);

  const previousScope = useRef(navigationScope);
  useEffect(() => {
    if (previousScope.current !== navigationScope) {
      previousScope.current = navigationScope;
      const range = reservationPresetRange("upcoming");
      setFrom(range.from);
      setTo(range.to);
      setViewMode("upcoming");
      setKeyword("");
      setDebouncedKeyword("");
      setServiceId(ALL_SENTINEL);
      setStatusFilter(ALL_SENTINEL);
      setSortKey("startAt");
      setSortDir("asc");
      return;
    }
    const value: ReservationSearchState = { from, to, serviceId, statusFilter, keyword, sortKey, sortDir, viewMode };
    const saved = location.state?.reservationSearch;
    if (saved?.scope === navigationScope && Object.entries(value).every(([key, expected]) => saved.value?.[key] === expected)) return;
    // Keep search PII in this history entry, never in the URL or localStorage.
    navigate(".", { replace: true, state: { reservationSearch: { scope: navigationScope, value } } });
  }, [from, to, keyword, serviceId, statusFilter, sortKey, sortDir, viewMode, navigationScope, location.state, navigate, setDebouncedKeyword]);

  const selectView = (mode: Exclude<ReservationViewMode, "custom">) => {
    setViewMode(mode);
    if (mode === "pending") {
      setServiceId(ALL_SENTINEL);
      setStatusFilter(ALL_SENTINEL);
    } else {
      const range = reservationPresetRange(mode);
      setFrom(range.from);
      setTo(range.to);
      setSortKey("startAt");
      setSortDir(mode === "history" ? "desc" : "asc");
    }
  };
  const resetFilters = () => {
    setKeyword("");
    setDebouncedKeyword("");
    setServiceId(ALL_SENTINEL);
    setStatusFilter(ALL_SENTINEL);
    setCsvError(null);
  };

  const dateValidationMessage = useMemo(() => {
    if (!from || !to) return "日付を入力してください";
    if (from > to) return errorMessage("invalid_range");
    // 検索APIと同じく両端を含む日数で判定する。日付文字列のUTC差分ならブラウザの夏時間にも左右されない。
    const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
    if (days > MAX_SEARCH_DAYS) return `期間は最大${MAX_SEARCH_DAYS}日までです。開始日と終了日を見直してください。`;
    return null;
  }, [from, to]);

  const filter: ReservationSearchFilter | null = useMemo(() => {
    if (viewMode === "pending" || dateValidationMessage) return null;
    return {
      from,
      to,
      storeId: storeId ?? undefined,
      serviceId: serviceId === ALL_SENTINEL ? undefined : serviceId,
      statuses: statusFilter === ALL_SENTINEL ? undefined : [statusFilter],
      keyword: debouncedKeyword || undefined,
    };
  }, [from, to, viewMode, dateValidationMessage, storeId, serviceId, statusFilter, debouncedKeyword]);

  const { data: searchData, isPending, isError, error, isPlaceholderData, isFetching } = useReservationSearch(filter);
  // placeholder は前の条件の結果なので、件数や承認操作も含めて新しい結果として表示しない。
  // 無効な条件では query が止まっても placeholder が残るため、filter も確認する。
  const data = filter && !isDebouncing && !isPlaceholderData && !isError ? searchData : undefined;
  const isSearching = viewMode !== "pending" && !!filter && (isDebouncing || isPending || isPlaceholderData || isFetching);
  const queryErrorMessage = reservationQueryErrorMessage(error);

  const reservations = useMemo(() => {
    if (!data?.ok) return [];
    const items = [...data.reservations];
    items.sort((a, b) => {
      const av = a[sortKey] ?? "";
      const bv = b[sortKey] ?? "";
      let cmp: number;
      if (sortKey === "customerDisplayName") {
        // 五十音順: フリガナ優先 + localeCompare("ja")（customers.tsx と同方式）。
        // 漢字名は localeCompare 単体では読み順にならないため、検索応答に含まれる
        // customerDisplayNameKana を第一キーにし、無ければ表示名にフォールバック。
        const ak = a.customerDisplayNameKana || a.customerDisplayName || "";
        const bk = b.customerDisplayNameKana || b.customerDisplayName || "";
        cmp = ak.localeCompare(bk, "ja");
      } else if (sortKey === "serviceName") {
        // 行の表示はカテゴリ prefix を除去しているため、並べ替えも表示名基準で行う
        // （生値のままだと見えている名前の順序と一致しない）。
        cmp = displayServiceName(String(av)).localeCompare(displayServiceName(String(bv)), "ja");
      } else if (sortKey === "storeName") {
        cmp = String(av).localeCompare(String(bv), "ja");
      } else {
        cmp = compareStrings(av, bv);
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return items;
  }, [data, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  // 空状態ヒント用。from/to は常に既定値を持つため「既定値からの変更」で判定する。
  // keyword は表示中の結果を生んだ debouncedKeyword と比較する (入力直後の300ms窓で
  // 結果とヒントが食い違わないように)
  const hasActiveFilters =
    from !== defaultRange.from ||
    to !== defaultRange.to ||
    storeId !== user.storeId ||
    serviceId !== ALL_SENTINEL ||
    statusFilter !== ALL_SENTINEL ||
    debouncedKeyword !== "";

  const handleCsvDownload = useCallback(async () => {
    if (!filter || isDownloading) return;
    setCsvError(null);
    setIsDownloading(true);
    try {
      const res = await fetch(buildCsvExportUrl(filter), { credentials: "same-origin" });
      const contentType = res.headers.get("content-type") ?? "";
      if (!res.ok || !contentType.includes("text/csv")) {
        const body = await res.json().catch(() => null);
        const reasonCode = body && typeof body === "object" && "reason" in body
          ? String((body as { reason: string }).reason)
          : null;
        // errorMessage は未登録コードを素通しするため、訳が無い場合は生コードや
        // "HTTP {status}" を露出させず汎用日本語にフォールバックする。
        const reasonText = reasonCode ? errorMessage(reasonCode) : null;
        setCsvError(reasonText && reasonText !== reasonCode
          ? `CSV出力に失敗しました: ${reasonText}`
          : "CSV出力に失敗しました。時間をおいて再度お試しください。");
        return;
      }
      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") ?? "";
      const filenameMatch = /filename="?([^"]+)"?/.exec(disposition);
      const filename = filenameMatch?.[1] ?? "reservations.csv";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setCsvError("CSV出力に失敗しました。ネットワークを確認してください。");
    } finally {
      setIsDownloading(false);
    }
  }, [filter, isDownloading]);

  return (
    <div ref={pageRef} className="space-y-4 p-4 sm:p-6">
      <h1 className="text-2xl font-bold">予約管理</h1>
      <div className="flex flex-wrap gap-2" role="group" aria-label="表示する予約">
        {([
          ["today", "今日"],
          ["upcoming", "今後30日"],
          ["history", "過去30日"],
          ["pending", "承認待ち"],
        ] as const).map(([mode, label]) => (
          <Button
            key={mode}
            variant={viewMode === mode ? "default" : "outline"}
            size="sm"
            aria-pressed={viewMode === mode}
            onClick={() => selectView(mode)}
          >
            {label}
          </Button>
        ))}
      </div>
      <section className="space-y-3 rounded-lg border bg-card p-3 sm:p-4" aria-label="予約を検索">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <Label htmlFor="keyword">{viewMode === "pending" ? "顧客名" : "顧客名・カナ・電話番号"}</Label>
            <Input
              id="keyword"
              type="search"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder={viewMode === "pending" ? "承認待ちの顧客名" : "顧客名・カナ・電話番号"}
              aria-describedby="reservation-search-hint"
            />
          </div>
          {!isStoreFixed && settings && settings.stores.length > 1 && (
            <div className="hidden space-y-1 sm:block">
              <Label htmlFor="filter-store">店舗</Label>
              <StoreSelect
                stores={settings.stores}
                value={storeId}
                onChange={setStoreId}
                id="filter-store"
                className="w-40"
              />
            </div>
          )}
          <Button variant="outline" size="sm" onClick={resetFilters}>絞り込みを解除</Button>
        </div>
        <p id="reservation-search-hint" className="text-xs text-muted-foreground">
          {viewMode === "pending"
            ? "予約日に関係なく、選択中の店舗の承認待ちを顧客名で絞り込みます。"
            : "名前は1文字から検索できます。検索期間は最大92日です。"}
        </p>
        {(viewMode !== "pending" || (!isStoreFixed && settings && settings.stores.length > 1)) && (
          <details className={`border-t pt-1 ${viewMode === "pending" ? "sm:hidden" : ""}`}>
            <summary className="flex min-h-11 cursor-pointer items-center text-sm text-muted-foreground">
              {viewMode === "pending" ? "店舗の条件を変更" : "期間・条件を変更"}
            </summary>
            <div className="grid grid-cols-2 gap-3 pt-2 lg:grid-cols-4">
              {!isStoreFixed && settings && settings.stores.length > 1 && (
                <div className="col-span-2 space-y-1 sm:hidden">
                  <Label htmlFor="filter-store-mobile">店舗</Label>
                  <StoreSelect
                    stores={settings.stores}
                    value={storeId}
                    onChange={setStoreId}
                    id="filter-store-mobile"
                    className="w-full"
                  />
                </div>
              )}
              {viewMode !== "pending" && (
                <>
                  <div className="min-w-0 space-y-1">
                    <Label htmlFor="from">開始日</Label>
                    <Input
                      id="from"
                      type="date"
                      value={from}
                      aria-invalid={!!dateValidationMessage}
                      aria-describedby={dateValidationMessage ? "reservation-date-error" : undefined}
                      onChange={(e) => { setFrom(e.target.value); setViewMode("custom"); }}
                    />
                  </div>
                  <div className="min-w-0 space-y-1">
                    <Label htmlFor="to">終了日</Label>
                    <Input
                      id="to"
                      type="date"
                      value={to}
                      aria-invalid={!!dateValidationMessage}
                      aria-describedby={dateValidationMessage ? "reservation-date-error" : undefined}
                      onChange={(e) => { setTo(e.target.value); setViewMode("custom"); }}
                    />
                  </div>
                  {settings && settings.services.length > 0 && (
                    <div className="space-y-1">
                      <Label htmlFor="filter-service">メニュー</Label>
                      <Select value={serviceId} onValueChange={setServiceId}>
                        <SelectTrigger id="filter-service" className="w-full">
                          <SelectValue placeholder="全メニュー" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={ALL_SENTINEL}>全メニュー</SelectItem>
                          {settings.services.map((service) => (
                            <SelectItem key={service.id} value={service.id}>
                              {displayServiceName(service.name)}{!service.active ? " (停止中)" : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  <div className="space-y-1">
                    <Label htmlFor="filter-status">ステータス</Label>
                    <Select value={statusFilter} onValueChange={setStatusFilter}>
                      <SelectTrigger id="filter-status" className="w-full">
                        <SelectValue placeholder="全ステータス" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={ALL_SENTINEL}>全ステータス</SelectItem>
                        {ALL_STATUSES.map((status) => (
                          <SelectItem key={status} value={status}>{statusLabel(status)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </>
              )}
            </div>
          </details>
        )}
        {viewMode !== "pending" && dateValidationMessage && (
          <p id="reservation-date-error" role="alert" className="text-sm text-destructive">
            {dateValidationMessage}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="適用中の検索条件">
          <Badge variant="secondary">
            {viewMode === "pending" ? "予約日の指定なし・承認期限順" : `${from || "開始日未指定"} 〜 ${to || "終了日未指定"}`}
          </Badge>
          <Badge variant="outline">
            {storeId ? settings?.stores.find((store) => store.id === storeId)?.name ?? "選択中の店舗" : "全店舗"}
          </Badge>
          {keyword.trim() && <Badge variant="outline">検索: {keyword.trim()}</Badge>}
          {viewMode !== "pending" && serviceId !== ALL_SENTINEL && (
            <Badge variant="outline">
              {displayServiceName(settings?.services.find((service) => service.id === serviceId)?.name ?? "選択中のメニュー")}
            </Badge>
          )}
          {viewMode !== "pending" && statusFilter !== ALL_SENTINEL && (
            <Badge variant="outline">{statusLabel(statusFilter)}</Badge>
          )}
        </div>
      </section>
      {viewMode === "pending" ? (
        <PendingApprovalsCard
          selectedStoreId={storeId}
          onSelect={setSelectedReservationId}
          fullList
          nameFilter={keyword}
        />
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            {data?.ok && !data.truncated && data.totalCount !== null ? `${data.totalCount}件` : "予約の検索結果"}
          </p>
          <Button variant="outline" size="sm" onClick={handleCsvDownload} disabled={!filter || isDebouncing || isDownloading}>
            {isDownloading ? "出力中..." : "CSV"}
          </Button>
        </div>
      )}

      {csvError && (
        <p role="alert" className="text-sm text-destructive">{csvError}</p>
      )}

      {data?.ok && data.truncated && (
        <p className="text-sm text-amber-600 dark:text-amber-400">
          表示件数が上限に達しました。期間を短くするかフィルタを追加してください。
        </p>
      )}

      {isSearching && (
        <output className="block text-sm text-muted-foreground">検索中です…</output>
      )}

      {filter && isPending &&
        (isNarrow ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-28 w-full rounded-md" />
            ))}
          </div>
        ) : (
          <div className="space-y-3 rounded-md border p-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="grid grid-cols-6 gap-3">
                {Array.from({ length: 6 }).map((_, j) => (
                  <Skeleton key={j} className="h-4" />
                ))}
              </div>
            ))}
          </div>
        ))}

      {filter && isError && (
        <p role="alert" className="text-sm text-destructive">
          {queryErrorMessage}
        </p>
      )}

      {data?.ok && isNarrow && (
        /* カード外枠は非インタラクティブにして、行クリック相当は明示的な
           「詳細」ボタンにする (誤タップ防止)。 */
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Label htmlFor="mobile-sort-key" className="shrink-0 text-xs text-muted-foreground">
              並べ替え
            </Label>
            <Select value={sortKey} onValueChange={(v) => setSortKey(v as SortKey)}>
              <SelectTrigger id="mobile-sort-key" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORT_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
            >
              {sortDir === "asc" ? "昇順 ↑" : "降順 ↓"}
            </Button>
          </div>
          {reservations.length === 0 && (
            <div className="rounded-md border">
              <ReservationsEmptyState hasActiveFilters={hasActiveFilters} />
            </div>
          )}
          {reservations.map((r) => (
            <ReservationListCard
              key={r.id}
              reservation={r}
              showDate
              onDetails={setSelectedReservationId}
              onCustomerClick={() => {
                // 不透明な顧客IDのみ URL に載せる (名前・電話は入れない)。
                navigate(`/customers?${new URLSearchParams({ customerId: r.customerId })}`);
              }}
              actions={r.status === "pending_approval" ? (
                <>
                  <Button
                    size="sm"
                    disabled={pendingReservationIds.has(r.id)}
                    onClick={() => setApproveTarget(r)}
                  >
                    承認
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={pendingReservationIds.has(r.id)}
                    onClick={() => setRejectTarget(r)}
                  >
                    却下
                  </Button>
                </>
              ) : undefined}
            />
          ))}
        </div>
      )}
      {data?.ok && !isNarrow && (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableHead sortKeyName="startAt" activeKey={sortKey} sortDir={sortDir} onToggle={toggleSort}>
                  日時
                </SortableHead>
                <SortableHead
                  sortKeyName="customerDisplayName"
                  activeKey={sortKey}
                  sortDir={sortDir}
                  onToggle={toggleSort}
                >
                  顧客
                </SortableHead>
                <SortableHead sortKeyName="serviceName" activeKey={sortKey} sortDir={sortDir} onToggle={toggleSort}>
                  メニュー
                </SortableHead>
                <SortableHead sortKeyName="storeName" activeKey={sortKey} sortDir={sortDir} onToggle={toggleSort}>
                  店舗
                </SortableHead>
                <SortableHead sortKeyName="status" activeKey={sortKey} sortDir={sortDir} onToggle={toggleSort}>
                  ステータス
                </SortableHead>
                <TableHead>
                  <span className="sr-only">操作</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reservations.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6}>
                    <ReservationsEmptyState hasActiveFilters={hasActiveFilters} />
                  </TableCell>
                </TableRow>
              )}
              {reservations.map((r) => (
                <TableRow
                  key={r.id}
                  className="cursor-pointer hover:bg-muted/50"
                  tabIndex={0}
                  aria-label={`${r.customerDisplayName}の予約詳細を開く`}
                  onClick={() => setSelectedReservationId(r.id)}
                  onKeyDown={(e) => {
                    // 行内のボタン(顧客リンク・承認/却下)上での Enter/Space は
                    // そのボタンの操作。行の詳細オープンは行自身にフォーカスが
                    // あるときだけ反応させる。
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedReservationId(r.id);
                    }
                  }}
                >
                  <TableCell className="whitespace-nowrap text-sm">
                    {formatDateDisplay(new Date(r.startAt))}{" "}
                    {formatTime(r.startAt)}–{formatTime(r.endAt)}
                  </TableCell>
                  <TableCell className="text-sm">
                    <button
                      type="button"
                      className="inline-flex min-h-11 items-center underline-offset-2 hover:underline"
                      aria-label={`${r.customerDisplayName}の顧客情報を開く`}
                      onClick={(e) => {
                        e.stopPropagation();
                        // 不透明な顧客IDのみ URL に載せる (名前・電話は入れない)。
                        navigate(`/customers?${new URLSearchParams({ customerId: r.customerId })}`);
                      }}
                    >
                      {r.customerDisplayName}
                    </button>
                  </TableCell>
                  <TableCell className="text-sm">{displayServiceName(r.serviceName)}</TableCell>
                  <TableCell className="text-sm">{r.storeName}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1">
                      <Badge className={statusColor(r.status)} variant="outline">
                        {statusLabel(r.status)}
                      </Badge>
                      {r.cancellationFeeUnpaidAt && (
                        <Badge variant="destructive">キャンセル料未納</Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    {r.status === "pending_approval" && (
                      <div className="flex items-center gap-1.5">
                        <Button
                          size="sm"
                          disabled={pendingReservationIds.has(r.id)}
                          onClick={(e) => {
                            e.stopPropagation();
                            setApproveTarget(r);
                          }}
                        >
                          承認
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={pendingReservationIds.has(r.id)}
                          onClick={(e) => {
                            e.stopPropagation();
                            setRejectTarget(r);
                          }}
                        >
                          却下
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <AlertDialog
        open={approveTarget !== null}
        onOpenChange={(open) => {
          if (!open) setApproveTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>予約を承認しますか?</AlertDialogTitle>
            <AlertDialogDescription>
              {approveTarget
                ? `${formatDateDisplay(new Date(approveTarget.startAt))} ${formatTime(approveTarget.startAt)} ${approveTarget.customerDisplayName} 様の予約を承認して確定します。顧客に通知されます。`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (!approveTarget) return;
                const target = approveTarget;
                setApproveTarget(null);
                rowAction.mutate({ reservationId: target.id, action: "approve" });
              }}
            >
              承認する
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <RejectReasonDialog
        open={rejectTarget !== null}
        description={
          rejectTarget
            ? `${formatDateDisplay(new Date(rejectTarget.startAt))} ${formatTime(rejectTarget.startAt)} ${rejectTarget.customerDisplayName} 様の予約を却下します。顧客に通知されます。`
            : ""
        }
        onOpenChange={(open) => {
          if (!open) setRejectTarget(null);
        }}
        onConfirm={(reason) => {
          if (!rejectTarget) return;
          const target = rejectTarget;
          setRejectTarget(null);
          rowAction.mutate({ reservationId: target.id, action: "reject", reason: reason || undefined });
        }}
      />

      <ReservationDetailPanel
        onOpenChart={(customerId, reservationId) => navigate(`/customers?customerId=${encodeURIComponent(customerId)}&reservationId=${encodeURIComponent(reservationId)}`)}
        reservationId={selectedReservationId}
        onClose={() => setSelectedReservationId(null)}
      />
    </div>
  );
}
