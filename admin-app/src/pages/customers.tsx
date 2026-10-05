import { useState, useMemo, useEffect, type KeyboardEvent } from "react";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useSearchParams } from "react-router";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SortableHead, type SortDir } from "@/components/ui/sortable-head";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { CustomerDetailPanel } from "@/components/customers/customer-detail-panel";
import { AddCustomerDialog } from "@/components/customers/add-customer-dialog";
import { CustomerGateCard } from "@/components/customers/customer-gate-card";
import { ApiError } from "@/lib/api-client";
import {
  useCustomerList,
  useCustomerSearch,
  useMergeCandidates,
  useCustomerMerge,
} from "@/hooks/use-customers";
import { useAuth } from "@/hooks/use-auth";
import { useStores } from "@/hooks/use-stores";
import { formatDateDisplay } from "@/lib/timeline";
import type {
  CustomerListItem,
  CustomerSearchItem,
  MergeCandidateCustomer,
  MergeCandidateGroup,
} from "@/types/api";

const isCustomerGateRequired = (error: unknown): boolean =>
  error instanceof ApiError &&
  error.status === 403 &&
  (error.body as { reason?: string } | null)?.reason === "customer_gate_required";

function pickBestMergeTarget(
  customers: MergeCandidateCustomer[],
): MergeCandidateCustomer | null {
  let best: MergeCandidateCustomer | null = null;
  for (const c of customers) {
    if (c.blockStatus === "blocked") continue;
    if (best === null) {
      best = c;
      continue;
    }
    if (c.lastReservationAt !== null && best.lastReservationAt !== null) {
      if (c.lastReservationAt > best.lastReservationAt) best = c;
    } else if (c.lastReservationAt !== null) {
      best = c;
    }
  }
  return best;
}

const PAGE_SIZE = 200;

export default function CustomersPage() {
  const { isPrivileged, user } = useAuth();
  // 店舗に紐付いていない staff アカウントはサーバー側で全部 403 になる
  // (createAdminCustomer / staffMayActOnCustomer とも store_id 無しで fail-closed)。
  // 押せば必ず失敗するボタンは出さない。owner/system_admin は店舗を持たない。
  const canManageCustomers = isPrivileged || user.storeId != null;
  const { stores, selectedStoreId, selectStore, isStoreFixed } = useStores();
  // Staff are hard-scoped to their own store server-side; the store filter only applies
  // to owner / system_admin (isStoreFixed === false). null = all stores.
  const storeFilter = isStoreFixed ? null : selectedStoreId;
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useDebouncedValue(searchQuery);
  const [offset, setOffset] = useState(0);
  const [showArchived, setShowArchived] = useState(false);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const [originReservationId, setOriginReservationId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  // 予約管理の顧客名リンクから `/customers?customerId=<id>` で遷移してきたとき、
  // 詳細パネルを直接開く。パラメータは replace で消費し、戻る操作で再度開かない。
  // URL 由来の値は API パス (/api/admin/customers/{id}) に連結されるため、ID 形式を
  // 検証してから使う (`../settings` のようなパストラバーサル値で別 API へ到達させない)。
  // 不正値でもパラメータ自体は消費して URL から消す。
  useEffect(() => {
    const customerId = searchParams.get("customerId");
    if (customerId === null) return;
    if (/^[A-Za-z0-9_-]{1,128}$/.test(customerId)) {
      setSelectedCustomerId(customerId);
      const reservationId = searchParams.get("reservationId");
      setOriginReservationId(reservationId && /^[A-Za-z0-9_-]{1,128}$/.test(reservationId) ? reservationId : null);
    }
    const next = new URLSearchParams(searchParams);
    next.delete("customerId");
    next.delete("reservationId");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  // Reset to the first page whenever the store filter changes — whether from this
  // page's Select OR an external change via the shared StoreProvider (header switcher,
  // another page). A stale offset past the new store's total would show an empty page. (devin)
  useEffect(() => {
    setOffset(0);
  }, [storeFilter]);

  // `debouncedQuery` は `useDebouncedValue` が trim 済みの値を返すので、ここで trim し直さない
  // (`isQueryTooShort` 側と同じ trim 後の長さで比べていることになる)。ここに `.trim()` を
  // 足すのは無害だが、trim がどちらの層の責務か曖昧になる。`検 ` のように見える文字 1 つ +
  // 空白で「絞り込んでいない」と書いてある表の中身が絞り込まれないことは、
  // 「見える文字が1つで後ろに空白があっても検索に出さない」で固定してある。
  // 1 文字だけ入れた状態は「検索したのに全員出ている」ように見える。絞り込みの結果と
  // 誤読されると、居ない顧客を居ると判断する。何も言わずに一覧へ戻さない。
  const isQueryTooShort = !showArchived && searchQuery.trim().length === 1;
  // `isQueryTooShort` も併せて見る。debounce は 300ms 遅れるので、2 文字から 1 文字へ
  // 消した直後は「短すぎる」が先に true になり、`debouncedQuery` はまだ前の 2 文字のまま
  // = 「下の一覧は絞り込み前の顧客一覧です」と書いてある下に前の語の検索結果が出る。
  // このリポジトリは同じ害を既に知っていて、アーカイブ切替では `useDebouncedValue` の
  // setter で窓を閉じている。ここは表示の切り替えだけなので条件で閉じる。
  const isSearchMode = !isQueryTooShort && debouncedQuery.length >= 2;
  const listQuery = useCustomerList(offset, showArchived, storeFilter);
  const searchResult = useCustomerSearch(debouncedQuery, storeFilter);

  const listData = listQuery.data;
  const searchData = searchResult.data;

  const totalPages = listData ? Math.ceil(listData.total / PAGE_SIZE) : 0;
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  const isPending = isSearchMode ? searchResult.isPending : listQuery.isPending;
  const isError = isSearchMode ? searchResult.isError : listQuery.isError;

  const listRows: CustomerListItem[] = useMemo(
    () => listData?.customers ?? [],
    [listData],
  );

  const searchRows: CustomerSearchItem[] = useMemo(
    () => (searchData?.ok ? searchData.customers : []),
    [searchData],
  );

  // 承認を持たない staff には顧客データを一切描画せず、コード入力の案内だけを出す
  // (FR-011)。承認の有無を /me ではなく一覧の 403 から取るのは、/me が起動時に 1 回しか
  // 引かれないため: そこに載せると 12 時間の承認がセッション中に切れても画面が気付けない。
  // すべての hook を呼び終えたあとの早期 return なので hooks 規則は満たしている。
  // `failureReason` も見る。QueryClient は `retry: 1` なので、403 は 1 回目の失敗では
  // `error` に入らず `failureReason` にしか入らない。`error` だけを見ると、リトライが
  // 済むまでスタッフには理由の無いスケルトンが出る。さらに React Query は
  // networkMode の既定 (`online`) でリトライを `fetchStatus: "paused"` にして待つので、
  // オンライン判定が false のあいだは `error` が永久に埋まらず、カードが一度も
  // 出ないまま固まる (staging の実機で観測)。承認の要否は 1 回目の 403 で確定する
  // 情報なので、リトライの都合とは切り離す。
  const gateRequired = isCustomerGateRequired(listQuery.error) || isCustomerGateRequired(listQuery.failureReason);

  return (
    <div className="space-y-4 p-4 sm:p-6">
      {gateRequired && <CustomerGateCard />}
      <div className="space-y-4">
      {!gateRequired && selectedCustomerId === null && <>
      {isPrivileged && <MergeCandidatesSection />}

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">顧客</h1>
        {!isStoreFixed && (
          <Select
            value={selectedStoreId ?? "all"}
            onValueChange={(v) => selectStore(v === "all" ? null : v)}
          >
            <SelectTrigger className="w-36" aria-label="店舗で絞り込み">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全店舗</SelectItem>
              {stores.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Input
          type="text"
          value={searchQuery}
          onChange={(e) => { setSearchQuery(e.target.value); setOffset(0); }}
          placeholder={showArchived ? "アーカイブ一覧では検索できません" : "名前・カナ・電話番号で検索..."}
          className="max-w-xs"
          // 検索 API はアーカイブ済みを返さないため、アーカイブ表示中は検索を無効化
          // (検索を始めると通常顧客が出る混乱を防ぐ)。(gemini)
          disabled={showArchived}
        />
        {/* アーカイブ済み一覧はスタッフにも開いている: 自分でアーカイブした顧客を
            自分で戻すための唯一の導線。行はサーバー側で自店舗に絞られる。 */}
        <Button
          variant={showArchived ? "default" : "outline"}
          size="sm"
          onClick={() => {
            // アーカイブ表示へ切替時、既存の検索語が残ると isSearchMode が真の
            // まま通常顧客の検索結果を表示し続ける (UIはアーカイブと表示)。
            // debouncedQuery も同期クリアして 300ms の残留窓を無くす。(devin/codex)
            setShowArchived((v) => !v);
            setOffset(0);
            setSearchQuery("");
            setDebouncedQuery("");
          }}
          aria-pressed={showArchived}
        >
          {showArchived ? "通常の顧客を表示" : "アーカイブ済みを表示"}
        </Button>
        {!showArchived && canManageCustomers && (
          <Button size="sm" onClick={() => setAddOpen(true)}>
            顧客を追加
          </Button>
        )}
      </div>

      {isQueryTooShort && (
        <p className="text-sm text-muted-foreground">
          検索するには 2 文字以上入力してください。下の一覧は絞り込み前の顧客一覧です。
        </p>
      )}

      {isError && (
        <p className="text-sm text-destructive">顧客データの取得に失敗しました。</p>
      )}

      {isPending && (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      )}

      {!isPending && isSearchMode && (
        <SearchResultTable
          rows={searchRows}
          onSelect={setSelectedCustomerId}
        />
      )}

      {!isPending && !isSearchMode && (
        <>
          <CustomerListTable
            rows={listRows}
            onSelect={setSelectedCustomerId}
            showArchived={showArchived}
            isStoreFiltered={storeFilter !== null || isStoreFixed}
          />

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={offset === 0}
                onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
              >
                前へ
              </Button>
              <span className="text-sm text-muted-foreground">
                {currentPage} / {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={currentPage >= totalPages}
                onClick={() => setOffset((o) => o + PAGE_SIZE)}
              >
                次へ
              </Button>
            </div>
          )}

          {listData && (
            <p className="text-sm text-muted-foreground">
              {showArchived ? "アーカイブ済み" : "全"}{listData.total}件
            </p>
          )}
        </>
      )}

      </>}
      </div>
      <CustomerDetailPanel
        key={`${user.email}:${user.storeId ?? ""}:${user.role}:${selectedCustomerId ?? ""}`}
        customerId={selectedCustomerId}
        suspended={gateRequired}
        originReservationId={originReservationId}
        onClose={() => { setSelectedCustomerId(null); setOriginReservationId(null); }}
      />

      {/* 顧客の手動追加は全 role。スタッフが登録した顧客は自店舗の顧客として
          記録されるので、追加直後に詳細を開いても 403 にならない。 */}
      <AddCustomerDialog
        open={addOpen && !gateRequired}
        onClose={() => setAddOpen(false)}
        // 追加後は新規顧客の詳細パネルを開く (一覧/検索は invalidate 済み)。
        onCreated={(id) => setSelectedCustomerId(id)}
      />
    </div>
  );
}

type CustomerSortKey = "displayName" | "visitCount" | "lastVisitAt";

// クリック/キーボード(Enter・Space)で開ける行の共通 props。メイン一覧と検索結果テーブルで
// 列構成が異なるため <TableRow> だけ共通化する（列は各テーブル側で個別に描く）。
export function customerRowProps(c: { id: string; displayName: string }, onSelect: (id: string) => void) {
  return {
    tabIndex: 0,
    "aria-label": `${c.displayName}の顧客詳細を開く`,
    className: "cursor-pointer hover:bg-muted/50 active:bg-muted/70",
    onClick: () => onSelect(c.id),
    onKeyDown: (e: KeyboardEvent<HTMLTableRowElement>) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSelect(c.id);
      }
    },
  };
}

// 昇順の三方比較。null は呼び出し側で除外済み前提。
function compareAsc(av: string, bv: string): number {
  if (av < bv) return -1;
  if (av > bv) return 1;
  return 0;
}

// 空状態メッセージ導出。表示分岐と一致させるため一元化。
function emptyStateMessage(showArchived: boolean, isStoreFiltered: boolean): string {
  if (showArchived && isStoreFiltered) return "この店舗にアーカイブ済みの顧客はいません";
  if (showArchived) return "アーカイブ済みの顧客はいません";
  if (isStoreFiltered) return "この店舗に登録されている顧客はいません";
  return "顧客がまだ登録されていません";
}

export function CustomerListTable({
  rows,
  onSelect,
  showArchived,
  isStoreFiltered,
}: Readonly<{
  rows: CustomerListItem[];
  onSelect: (id: string) => void;
  showArchived: boolean;
  isStoreFiltered: boolean;
}>) {
  const [sortKey, setSortKey] = useState<CustomerSortKey>("displayName");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const toggleSort = (key: CustomerSortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const sortedRows = useMemo(() => {
    const items = [...rows];
    items.sort((a, b) => {
      let cmp: number;
      if (sortKey === "visitCount") {
        cmp = a.visitCount - b.visitCount;
      } else if (sortKey === "lastVisitAt") {
        // null は常に末尾（昇順・降順に関わらず）。
        const av = a.lastVisitAt;
        const bv = b.lastVisitAt;
        if (av === bv) cmp = 0;
        else if (av == null) return 1;
        else if (bv == null) return -1;
        else cmp = compareAsc(av, bv);
      } else {
        // 五十音順: フリガナ優先 + localeCompare("ja")。`<`/`>` のコードポイント
        // 比較だと漢字名が辞書順にならないため。
        const av = a.displayNameKana || a.displayName || "";
        const bv = b.displayNameKana || b.displayName || "";
        cmp = av.localeCompare(bv, "ja");
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return items;
  }, [rows, sortKey, sortDir]);

  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <SortableHead sortKeyName="displayName" activeKey={sortKey} sortDir={sortDir} onToggle={toggleSort}>名前</SortableHead>
            <TableHead>カナ</TableHead>
            <TableHead>電話</TableHead>
            <TableHead>状態</TableHead>
            <SortableHead sortKeyName="visitCount" activeKey={sortKey} sortDir={sortDir} onToggle={toggleSort}>来店</SortableHead>
            <SortableHead sortKeyName="lastVisitAt" activeKey={sortKey} sortDir={sortDir} onToggle={toggleSort}>最終来店</SortableHead>
            <TableHead>メモ</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortedRows.length === 0 && (
            <TableRow>
              <TableCell colSpan={7} className="text-center text-muted-foreground">
                {emptyStateMessage(showArchived, isStoreFiltered)}
              </TableCell>
            </TableRow>
          )}
          {sortedRows.map((c) => (
            <TableRow key={c.id} {...customerRowProps(c, onSelect)}>
              <TableCell className="text-sm font-medium">{c.displayName}</TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {c.displayNameKana ?? ""}
              </TableCell>
              <TableCell className="text-sm">{c.phoneNormalizedMasked}</TableCell>
              <TableCell>
                <Badge variant={c.blockStatus === "blocked" ? "destructive" : "secondary"}>
                  {c.blockStatus === "blocked" ? "ブロック" : "有効"}
                </Badge>
              </TableCell>
              <TableCell className="text-sm">{c.visitCount}回</TableCell>
              <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                {c.lastVisitAt ? formatDateDisplay(new Date(c.lastVisitAt)) : "—"}
              </TableCell>
              <TableCell
                className="max-w-[160px] text-xs text-muted-foreground"
                title={c.memo ?? undefined}
              >
                <span className="line-clamp-2">{c.memo ?? ""}</span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function SearchResultTable({
  rows,
  onSelect,
}: Readonly<{
  rows: CustomerSearchItem[];
  onSelect: (id: string) => void;
}>) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>名前</TableHead>
            <TableHead>カナ</TableHead>
            <TableHead>状態</TableHead>
            <TableHead>メモ</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={4} className="text-center text-muted-foreground">
                該当する顧客が見つかりません
              </TableCell>
            </TableRow>
          )}
          {rows.map((c) => (
            <TableRow key={c.id} {...customerRowProps(c, onSelect)}>
              <TableCell className="text-sm font-medium">{c.displayName}</TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {c.displayNameKana ?? ""}
              </TableCell>
              <TableCell>
                <Badge variant={c.blockStatus === "blocked" ? "destructive" : "secondary"}>
                  {c.blockStatus === "blocked" ? "ブロック" : "有効"}
                </Badge>
              </TableCell>
              <TableCell
                className="max-w-[160px] text-xs text-muted-foreground"
                title={c.memo ?? undefined}
              >
                <span className="line-clamp-2">{c.memo ?? ""}</span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

type MergePair = { source: MergeCandidateCustomer; target: MergeCandidateCustomer };

function MergeCandidatesSection() {
  const { data, isPending, isError } = useMergeCandidates();
  const merge = useCustomerMerge();
  const [pending, setPending] = useState<MergePair | null>(null);

  const groups = data?.groups ?? [];
  // 読み込み中・エラーで黙って消えると、重複が無いのか取得に失敗したのか
  // 判別できない。状態を明示してから空の場合のみ非表示にする。
  if (isPending) {
    return (
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">統合候補（重複の可能性）</h2>
        <Skeleton className="h-24 w-full" />
      </section>
    );
  }
  if (isError) {
    return (
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">統合候補（重複の可能性）</h2>
        <p className="text-sm text-destructive">
          統合候補の取得に失敗しました。再読み込みしてください。
        </p>
      </section>
    );
  }
  if (groups.length === 0) return null;

  const confirmMerge = () => {
    if (!pending) return;
    merge.mutate(
      { sourceId: pending.source.id, targetId: pending.target.id },
      { onSuccess: () => setPending(null) },
    );
  };

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold">統合候補（重複の可能性）</h2>
        <p className="text-sm text-muted-foreground">
          電話番号が同じ顧客レコードをまとめました。重複の場合は統合してください。
        </p>
      </div>

      {groups.map((group) => (
        <MergeCandidateGroupCard
          key={group.groupId}
          group={group}
          onMerge={(source, target) => setPending({ source, target })}
        />
      ))}

      {data?.truncated && (
        <p className="text-sm text-muted-foreground">
          重複候補が多数あります。統合を進めると残りが表示されます。
        </p>
      )}

      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && merge.isPending) return;
          if (!open) setPending(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>顧客統合の確認</AlertDialogTitle>
            <AlertDialogDescription>
              {pending
                ? `${pending.source.displayName} を ${pending.target.displayName} に統合します。`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p className="text-sm text-muted-foreground">
            元の顧客レコードは無効化され、予約は統合先に再紐付されます。この操作は取り消せません。
          </p>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={merge.isPending}>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); confirmMerge(); }}
              disabled={merge.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {merge.isPending ? "統合中..." : "統合する"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function MergeCandidateGroupCard({
  group,
  onMerge,
}: Readonly<{
  group: MergeCandidateGroup;
  onMerge: (source: MergeCandidateCustomer, target: MergeCandidateCustomer) => void;
}>) {
  const target = pickBestMergeTarget(group.customers);

  return (
    <Card className="overflow-x-auto p-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>氏名</TableHead>
            <TableHead>フリガナ</TableHead>
            <TableHead>電話末尾</TableHead>
            <TableHead>最終予約</TableHead>
            <TableHead>状態</TableHead>
            <TableHead>操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {group.customers.map((c) => (
            <TableRow key={c.id}>
              <TableCell className="text-sm font-medium">{c.displayName}</TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {c.displayNameKana ?? ""}
              </TableCell>
              <TableCell className="text-sm">{c.phoneNormalizedMasked}</TableCell>
              <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                {c.lastReservationAt ? formatDateDisplay(new Date(c.lastReservationAt)) : "—"}
              </TableCell>
              <TableCell>
                <Badge variant={c.blockStatus === "blocked" ? "destructive" : "secondary"}>
                  {c.blockStatus === "blocked" ? "ブロック中" : "有効"}
                </Badge>
              </TableCell>
              <TableCell>
                <MergeActionCell customer={c} target={target} onMerge={onMerge} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

function MergeActionCell({
  customer,
  target,
  onMerge,
}: Readonly<{
  customer: MergeCandidateCustomer;
  target: MergeCandidateCustomer | null;
  onMerge: (source: MergeCandidateCustomer, target: MergeCandidateCustomer) => void;
}>) {
  if (target === null) {
    return <span className="text-sm text-muted-foreground">—</span>;
  }
  if (customer.id === target.id) {
    return <span className="text-sm text-muted-foreground">(統合先)</span>;
  }
  if (customer.blockStatus === "blocked") {
    return <span className="text-sm text-muted-foreground">ブロック中</span>;
  }
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => onMerge(customer, target)}
      aria-label={`${customer.displayName} を ${target.displayName} に統合`}
    >
      統合
    </Button>
  );
}
