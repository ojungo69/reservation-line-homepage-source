import { useState } from "react";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useLineFriends, useLineFriendLink } from "@/hooks/use-line-friends";
import { useStores } from "@/hooks/use-stores";
import type { LineFriendListItem } from "@/types/api";

type Props = {
  // null のときダイアログは閉じている。値があるとその顧客にLINE友だちを紐付けるダイアログを開く。
  customer: { id: string; displayName: string } | null;
  onClose: () => void;
};

// 候補行に表示する友だちラベル(紐付け処理中/表示名/未取得・取得不可)を決める。
function getFriendRowLabel(isLinkingThisFriend: boolean, friend: LineFriendListItem): string {
  if (isLinkingThisFriend) return "紐付け中...";
  if (friend.displayName !== null) return friend.displayName;
  return friend.profileStatus === "unavailable" ? "（取得不可）" : "（未取得）";
}

// 顧客カルテ起点の逆方向導線: 固定の既存顧客(customer)に、名前検索で選んだ LINE 友だちを
// linkLineFriend(mode='existing') で紐付ける。候補は未紐付け(filter='unlinked')の友だちのみ。
export function LinkLineFromCardDialog({ customer, onClose }: Readonly<Props>) {
  const link = useLineFriendLink();
  const { stores } = useStores();
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useDebouncedValue(q);
  // 複数店舗時のみ店舗選択が必要(seed visit の store_id 用)。単一店舗は自動選択。
  const [storeId, setStoreId] = useState("");

  const open = customer !== null;
  const effectiveStoreId = storeId || (stores.length === 1 ? stores[0].id : "");

  // 検索語が空のときは一覧取得しない(空文字 = 全件取得を避ける)。enabled で
  // ダイアログを開いただけ・検索語が空の間は GET /line-friends を発行しない。
  const showResults = debouncedQ.length > 0;
  const { items, isPending, isFetching } = useLineFriends({
    filter: "unlinked",
    q: debouncedQ,
    page: 1,
    enabled: open && showResults,
  });
  // keepPreviousData keeps the previous term's items during a refetch; treat any
  // in-flight fetch AND the debounce gap (input edited but debouncedQ not yet caught
  // up, so no refetch has started) as "loading" so stale (no-longer-matching) rows
  // are never clickable. (codex P2 — closes both the refetch and debounce windows)
  const loadingResults = isPending || isFetching || q.trim() !== debouncedQ;

  const choose = (friend: LineFriendListItem) => {
    if (!customer || effectiveStoreId === "") return;
    link.mutate(
      {
        lineUserId: friend.lineUserId,
        body: { mode: "existing", storeId: effectiveStoreId, customerId: customer.id },
      },
      {
        onSuccess: () => {
          setQ("");
          setDebouncedQ("");
          onClose();
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !link.isPending) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>LINEと紐付け{customer ? `（${customer.displayName} 様）` : ""}</DialogTitle>
          <DialogDescription>
            このお客様のLINE友だちを名前で検索して選ぶと、次回のLINE予約で既存のお客様として扱われます。
          </DialogDescription>
        </DialogHeader>

        {stores.length > 1 && (
          <label className="block text-sm">
            紐付け先の店舗
            {/* ラベル文と select の間に空白を入れない（Sonar S6772: 意図の明示） */}
            <select
              className="mt-1 w-full rounded border bg-background px-2 py-1 text-sm"
              value={effectiveStoreId}
              onChange={(e) => setStoreId(e.target.value)}
              disabled={link.isPending}
            >
              <option value="">店舗を選択してください</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <Input
          placeholder="LINE友だちの名前で検索"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          disabled={link.isPending}
          autoFocus
        />

        {effectiveStoreId === "" && stores.length > 1 && (
          <p className="text-sm text-destructive">紐付け先の店舗を選択してください。</p>
        )}

        <div className="mt-2 max-h-72 space-y-1 overflow-y-auto">
          {showResults && loadingResults && <p className="text-sm text-muted-foreground">検索中...</p>}
          {showResults && !loadingResults && items.length === 0 && (
            <p className="text-sm text-muted-foreground">
              該当する未紐付けのLINE友だちがいません。先に「LINE友だち紐付け」画面で「友だちを同期」してください。
            </p>
          )}
          {showResults &&
            !loadingResults &&
            items.map((friend) => {
              // Scope the "紐付け中..." label to the row actually being linked; all rows
              // are disabled during the mutation to prevent double-submit.
              const isLinkingThisFriend = link.isPending && link.variables?.lineUserId === friend.lineUserId;
              return (
                <button
                  key={friend.lineUserId}
                  type="button"
                  className="flex w-full items-center gap-3 rounded px-2 py-2 text-left text-sm hover:bg-muted disabled:opacity-50"
                  disabled={link.isPending || effectiveStoreId === "" || friend.profileStatus !== "fetched"}
                  onClick={() => choose(friend)}
                >
                  {friend.pictureUrl ? (
                    <img src={friend.pictureUrl} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover" />
                  ) : (
                    <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-muted text-xs text-muted-foreground">
                      ?
                    </div>
                  )}
                  <span className="truncate">
                    {getFriendRowLabel(isLinkingThisFriend, friend)}
                  </span>
                </button>
              );
            })}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={link.isPending}>
            閉じる
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
