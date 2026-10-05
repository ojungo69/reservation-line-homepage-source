import { useState } from "react";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { RefreshCw, UserPlus, UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLineFriends, useLineFriendSync } from "@/hooks/use-line-friends";
import { useStores } from "@/hooks/use-stores";
import { LinkNewDialog, LinkExistingDialog } from "@/components/line-friends/link-dialogs";
import type { LineFriendListItem, LineFriendsFilter } from "@/types/api";

const FILTERS: Array<{ key: LineFriendsFilter; label: string }> = [
  { key: "unlinked", label: "未紐付け" },
  { key: "linked", label: "紐付け済み" },
  { key: "all", label: "すべて" }
];

export default function LineFriendsPage() {
  const [filter, setFilter] = useState<LineFriendsFilter>("unlinked");
  const [q, setQ] = useState("");
  const [debouncedQ] = useDebouncedValue(q);
  const [page, setPage] = useState(1);
  const [newFor, setNewFor] = useState<LineFriendListItem | null>(null);
  const [existingFor, setExistingFor] = useState<LineFriendListItem | null>(null);

  const { items, total, pageSize, isPending, isError } = useLineFriends({ filter, q: debouncedQ, page });
  const sync = useLineFriendSync();
  const { stores, isPending: isStoresPending } = useStores();

  // 店舗選択（複数店舗時は必須・単一は自動）。
  const [storeId, setStoreId] = useState("");
  const effectiveStoreId = storeId || (stores.length === 1 ? stores[0].id : "");
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">LINE友だち紐付け</h1>
          <p className="text-xs text-muted-foreground">
            LINE友だちを紙カルテのお客様に紐付けると、次回のLINE予約で既存のお客様として扱われます。
          </p>
        </div>
        <Button onClick={() => sync.mutate()} disabled={sync.isPending}>
          <RefreshCw className={`mr-2 h-4 w-4 ${sync.isPending ? "animate-spin" : ""}`} />
          {sync.isPending ? "同期中..." : "友だちを同期"}
        </Button>
      </div>

      {stores.length > 1 && (
        <div className="flex items-center gap-2 text-sm">
          <Label htmlFor="link-store-select">紐付け先の店舗</Label>
          <Select value={effectiveStoreId} onValueChange={setStoreId}>
            <SelectTrigger id="link-store-select" className="w-auto min-w-48">
              <SelectValue placeholder="店舗を選択してください" />
            </SelectTrigger>
            <SelectContent>
              {stores.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <Button
            key={f.key}
            size="sm"
            variant={filter === f.key ? "default" : "outline"}
            onClick={() => {
              setFilter(f.key);
              setPage(1);
            }}
          >
            {f.label}
          </Button>
        ))}
        <Input
          className="w-48"
          placeholder="名前で検索"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
        />
      </div>

      {effectiveStoreId === "" && !isStoresPending && (
        <p className="text-sm text-destructive">
          {stores.length > 1
            ? "紐付け先の店舗を選択してください。"
            : "店舗情報を読み込めませんでした。設定を確認してください。"}
        </p>
      )}

      <div className="divide-y rounded border">
        {isPending && <p className="p-4 text-sm text-muted-foreground">読み込み中...</p>}
        {isError && (
          <p className="p-4 text-sm text-destructive">
            一覧の読み込みに失敗しました。検索条件を短くするか、時間をおいて再度お試しください。
          </p>
        )}
        {!isPending && !isError && items.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">
            {filter === "unlinked"
              ? "未紐付けの友だちはいません。「友だちを同期」で最新化できます。"
              : "該当がありません。"}
          </p>
        )}
        {items.map((f) => (
          <div key={f.lineUserId} className="flex items-center justify-between gap-3 p-3">
            <div className="flex min-w-0 items-center gap-3">
              {f.pictureUrl ? (
                <img src={f.pictureUrl} alt="" className="h-10 w-10 shrink-0 rounded-full object-cover" />
              ) : (
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-muted text-xs text-muted-foreground">
                  ?
                </div>
              )}
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {f.displayName ?? (f.profileStatus === "unavailable" ? "（取得不可）" : "（未取得）")}
                </p>
                {f.linked && <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400">紐付け済み</p>}
              </div>
            </div>

            {!f.linked && (
              <div className="flex shrink-0 flex-wrap items-center gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={effectiveStoreId === "" || f.profileStatus !== "fetched"}
                  onClick={() => setExistingFor(f)}
                >
                  <UserCheck className="mr-1 h-4 w-4" />
                  既存客に紐付け
                </Button>
                <Button
                  size="sm"
                  disabled={effectiveStoreId === "" || f.profileStatus !== "fetched"}
                  onClick={() => setNewFor(f)}
                >
                  <UserPlus className="mr-1 h-4 w-4" />
                  新規登録して紐付け
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            前へ
          </Button>
          <span className="text-sm text-muted-foreground">
            {page} / {totalPages}
          </span>
          <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
            次へ
          </Button>
        </div>
      )}

      {/* key で友だち毎に remount → 前回の入力/検索語が次の友だちへ持ち越されない。 */}
      <LinkNewDialog
        key={`new-${newFor?.lineUserId ?? "closed"}`}
        friend={newFor}
        storeId={effectiveStoreId}
        onClose={() => setNewFor(null)}
      />
      <LinkExistingDialog
        key={`existing-${existingFor?.lineUserId ?? "closed"}`}
        friend={existingFor}
        storeId={effectiveStoreId}
        onClose={() => setExistingFor(null)}
      />
    </div>
  );
}
