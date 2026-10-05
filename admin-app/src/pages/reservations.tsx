import { useState, useMemo, useCallback } from "react";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useNavigate } from "react-router";
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
  formatJstDate,
  formatDateDisplay,
  toJstDate,
} from "@/lib/timeline";
import { errorMessage } from "@/lib/error-messages";
import { displayServiceName } from "@/lib/service-pricing";
import { useMediaQuery, NARROW_QUERY } from "@/hooks/use-media-query";
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

function getToday(): string {
  return formatJstDate(new Date());
}

function getOneMonthLater(): string {
  // Derive the +1-month default end from JST calendar parts (matching getToday), not the
  // browser-local calendar, so the window stays a full JST month even for non-JST admins.
  const jst = toJstDate(new Date());
  const day = jst.getUTCDate();
  const next = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth() + 1, day));
  // setMonth overflows on short months (Jan 31 -> Mar 3); clamp back to the intended month's last day.
  if (next.getUTCDate() < day) next.setUTCDate(0);
  return next.toISOString().slice(0, 10);
}

type SortKey = "startAt" | "customerDisplayName" | "serviceName" | "storeName" | "status";

// 文字列の既定比較(sortKey ソートのフォールバック)。
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
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

  // Default to the upcoming month (today → one month ahead) so the list opens on
  // actionable future reservations instead of only past ones (was: month-start → today).
  const [from, setFrom] = useState(getToday);
  const [to, setTo] = useState(getOneMonthLater);
  // mount 時の既定値を固定 (hasActiveFilters 用)。毎レンダー再計算すると
  // 深夜0時 (JST) 跨ぎで from/to とズレて未操作なのに「絞り込み中」扱いになる。
  // 初期レンダー時の from/to をそのまま捕捉する (日付関数の再計算をしない)
  const [defaultRange] = useState(() => ({ from, to }));
  const { selectedStoreId: storeId, selectStore: setStoreId, isStoreFixed } = useStores();
  const [serviceId, setServiceId] = useState(ALL_SENTINEL);
  const [statusFilter, setStatusFilter] = useState(ALL_SENTINEL);
  const [keyword, setKeyword] = useState("");
  const [debouncedKeyword] = useDebouncedValue(keyword);
  const [selectedReservationId, setSelectedReservationId] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("startAt");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
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
  // スマホ幅では横スクロールテーブルの代わりにカードを積む。CSS 切替 (sm:hidden)
  // だと両レイアウトが常時マウントされ最大200行が二重レンダーされるため、
  // matchMedia で片方だけ描画する。
  const isNarrow = useMediaQuery(NARROW_QUERY);

  const filter: ReservationSearchFilter | null = useMemo(() => {
    if (!from || !to) return null;
    return {
      from,
      to,
      storeId: storeId ?? undefined,
      serviceId: serviceId === ALL_SENTINEL ? undefined : serviceId,
      statuses: statusFilter === ALL_SENTINEL ? undefined : [statusFilter],
      keyword: debouncedKeyword || undefined,
    };
  }, [from, to, storeId, serviceId, statusFilter, debouncedKeyword]);

  const { data, isPending, isError } = useReservationSearch(filter);

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
    <div className="space-y-4 p-4 sm:p-6">
      <h1 className="text-2xl font-bold">予約管理</h1>
      {/* スマホは縦積み・入力は幅いっぱい (日付の開始/終了ペアだけ横並び維持) */}
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
        <div className="flex gap-3">
          <div className="min-w-0 flex-1 space-y-1 sm:flex-none">
            <Label htmlFor="from">開始日</Label>
            <Input
              id="from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="w-full sm:w-36"
            />
          </div>
          <div className="min-w-0 flex-1 space-y-1 sm:flex-none">
            <Label htmlFor="to">終了日</Label>
            <Input
              id="to"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="w-full sm:w-36"
            />
          </div>
        </div>

        {!isStoreFixed && settings && settings.stores.length > 1 && (
          <div className="space-y-1">
            <Label htmlFor="filter-store">店舗</Label>
            <StoreSelect
              stores={settings.stores}
              value={storeId}
              onChange={setStoreId}
              id="filter-store"
              className="w-full sm:w-40"
            />
          </div>
        )}

        {settings && settings.services.length > 0 && (
          <div className="space-y-1">
            <Label htmlFor="filter-service">メニュー</Label>
            <Select value={serviceId} onValueChange={setServiceId}>
              <SelectTrigger id="filter-service" className="w-full sm:w-40">
                <SelectValue placeholder="全メニュー" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_SENTINEL}>全メニュー</SelectItem>
                {settings.services.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {displayServiceName(s.name)}{!s.active ? " (停止中)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="space-y-1">
          <Label htmlFor="filter-status">ステータス</Label>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger id="filter-status" className="w-full sm:w-36">
              <SelectValue placeholder="全ステータス" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_SENTINEL}>全ステータス</SelectItem>
              {ALL_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {statusLabel(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="keyword">キーワード</Label>
          <Input
            id="keyword"
            type="text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="顧客名・電話番号"
            className="w-full sm:w-44"
          />
        </div>

        <div className="flex gap-2">
          <Button
            variant={statusFilter === "pending_approval" ? "default" : "outline"}
            size="sm"
            aria-pressed={statusFilter === "pending_approval"}
            onClick={() =>
              setStatusFilter(statusFilter === "pending_approval" ? ALL_SENTINEL : "pending_approval")
            }
          >
            承認待ちのみ
          </Button>

          <Button variant="outline" size="sm" onClick={handleCsvDownload} disabled={!filter || isDownloading}>
            {isDownloading ? "出力中..." : "CSV"}
          </Button>
        </div>
      </div>

      {csvError && (
        <p role="alert" className="text-sm text-destructive">{csvError}</p>
      )}

      {data?.ok && data.truncated && (
        <p className="text-sm text-amber-600 dark:text-amber-400">
          表示件数が上限に達しました。期間を短くするかフィルタを追加してください。
        </p>
      )}

      {isPending &&
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

      {isError && (
        <p role="alert" className="text-sm text-destructive">
          予約データの取得に失敗しました。
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

      {data?.ok && !data.truncated && data.totalCount !== null && (
        <p className="text-sm text-muted-foreground">
          {data.totalCount}件
        </p>
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
