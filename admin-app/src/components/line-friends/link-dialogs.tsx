import { useState } from "react";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useLineFriendLink, useCustomerSearch } from "@/hooks/use-line-friends";
import type { LineFriendListItem } from "@/types/api";

type Props = {
  friend: LineFriendListItem | null;
  storeId: string;
  onClose: () => void;
};

// 「新規登録して紐付け」: 名前（必須）/カナ/電話（任意）→ customers 新規作成 + 紐付け。
export function LinkNewDialog({ friend, storeId, onClose }: Readonly<Props>) {
  const link = useLineFriendLink();
  const [displayName, setDisplayName] = useState("");
  const [displayNameKana, setDisplayNameKana] = useState("");
  const [phone, setPhone] = useState("");

  const open = friend !== null;
  const canSave = displayName.trim().length > 0 && storeId.length > 0 && !link.isPending;

  const submit = () => {
    if (!friend || !canSave) return;
    link.mutate(
      {
        lineUserId: friend.lineUserId,
        body: {
          mode: "new",
          storeId,
          newCustomer: {
            displayName: displayName.trim(),
            displayNameKana: displayNameKana.trim() || undefined,
            phone: phone.trim() || undefined
          }
        }
      },
      {
        onSuccess: () => {
          setDisplayName("");
          setDisplayNameKana("");
          setPhone("");
          onClose();
        }
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新規登録して紐付け{friend?.displayName ? `（${friend.displayName}）` : ""}</DialogTitle>
          <DialogDescription>
            紙カルテのお客様を新しく登録し、このLINE友だちと紐付けます。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block text-sm">
            お名前（必須）
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={120} autoFocus />
          </label>
          <label className="block text-sm">
            フリガナ（任意）
            <Input value={displayNameKana} onChange={(e) => setDisplayNameKana(e.target.value)} maxLength={120} />
          </label>
          <label className="block text-sm">
            電話番号（任意）
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" />
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={link.isPending}>
            キャンセル
          </Button>
          <Button onClick={submit} disabled={!canSave}>
            {link.isPending ? "保存中..." : "登録して紐付け"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// 「既存客に紐付け」: 名前/電話で検索 → 選択 → 既存 customer に紐付け。
export function LinkExistingDialog({ friend, storeId, onClose }: Readonly<Props>) {
  const link = useLineFriendLink();
  const [q, setQ] = useState("");
  const [debouncedQ] = useDebouncedValue(q);
  const { results, isPending } = useCustomerSearch(debouncedQ);
  // During the 300ms debounce gap (q has changed but debouncedQ has not caught up)
  // the results still belong to the PREVIOUS query term. Treat that as loading so
  // stale rows are not shown or clickable (mirrors LinkLineFromCardDialog).
  const loadingResults = isPending || q.trim() !== debouncedQ;
  const open = friend !== null;

  const choose = (customerId: string) => {
    if (!friend) return;
    link.mutate(
      { lineUserId: friend.lineUserId, body: { mode: "existing", storeId, customerId } },
      {
        onSuccess: () => {
          setQ("");
          onClose();
        }
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>既存のお客様に紐付け{friend?.displayName ? `（${friend.displayName}）` : ""}</DialogTitle>
          <DialogDescription>
            管理画面に登録済みのお客様を検索して、このLINE友だちと紐付けます。
          </DialogDescription>
        </DialogHeader>
        <Input placeholder="お名前 または 電話番号で検索" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        <div className="mt-2 max-h-72 space-y-1 overflow-y-auto">
          {loadingResults && <p className="text-sm text-muted-foreground">検索中...</p>}
          {!loadingResults && debouncedQ.length > 0 && results.length === 0 && (
            <p className="text-sm text-muted-foreground">該当する顧客がいません</p>
          )}
          {!loadingResults &&
            results.map((cust) => {
            const variables = link.variables;
            const isLinkingThis =
              link.isPending &&
              !!variables &&
              variables.body.mode === "existing" &&
              variables.body.customerId === cust.id;
            return (
              <button
                key={cust.id}
                type="button"
                className="flex w-full items-center justify-between rounded px-2 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                disabled={link.isPending}
                onClick={() => choose(cust.id)}
              >
                <span>
                  {isLinkingThis ? (
                    "紐付け中..."
                  ) : (
                    <>
                      {cust.displayName}
                      {cust.displayNameKana ? `（${cust.displayNameKana}）` : ""}
                    </>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">
                  {isLinkingThis ? "" : (cust.phoneNormalized ?? "")}
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
