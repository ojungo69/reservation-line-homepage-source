import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useStores } from "@/hooks/use-stores";
import { useResourceList } from "@/hooks/use-resources";
import { useExternalBlockCreate } from "@/hooks/use-external-blocks";
import {
  buildExternalBlockTimes,
  EXTERNAL_BLOCK_TIME_MESSAGES,
} from "@/lib/external-block-time";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultStoreId: string | null;
};

const TITLE_MAX = 120;

export function ExternalBlockCreateDialog({
  open,
  onOpenChange,
  defaultStoreId,
}: Readonly<Props>) {
  const { stores } = useStores();
  const create = useExternalBlockCreate();

  const [storeId, setStoreId] = useState<string>(defaultStoreId ?? "");
  const [resourceId, setResourceId] = useState("");
  const [startLocal, setStartLocal] = useState("");
  const [endLocal, setEndLocal] = useState("");
  const [title, setTitle] = useState("");
  // One idempotency key per dialog session: a manual retry after a lost response
  // reuses it so the server replays the original create instead of duplicating.
  const idempotencyKeyRef = useRef<string>("");
  if (!idempotencyKeyRef.current) {
    idempotencyKeyRef.current = crypto.randomUUID();
  }

  const { resourceList } = useResourceList(storeId || null);
  const activeResources = resourceList.filter((r) => r.active);

  // ダイアログを開くたびに defaultStoreId を反映し、入力をリセットする。
  // 作成リクエスト送信中はリセットしない（idempotencyKey を保持して再試行を安全にする）。
  useEffect(() => {
    if (open && !create.isPending) {
      setStoreId(defaultStoreId ?? "");
      setResourceId("");
      setStartLocal("");
      setEndLocal("");
      setTitle("");
      idempotencyKeyRef.current = crypto.randomUUID();
    }
    // create.isPending は再リセットを抑止するガードのみ（依存に入れると解決時に再リセットされる）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultStoreId]);

  // 店舗が1つだけでセレクタが隠れる場合（owner/system_admin は defaultStoreId が
  // null）、その店舗を自動選択してフォームを送信可能にする。
  useEffect(() => {
    if (open && !storeId && stores.length === 1) {
      setStoreId(stores[0].id);
    }
  }, [open, storeId, stores]);

  // 店舗を切り替えたらリソース選択をクリアする。
  const handleStoreChange = (value: string) => {
    setStoreId(value);
    setResourceId("");
  };

  const canSubmit =
    !!storeId && !!resourceId && !!startLocal && !!endLocal && !create.isPending;

  const handleSubmit = () => {
    if (!storeId || !resourceId) return;
    const times = buildExternalBlockTimes(startLocal, endLocal);
    if (!times.ok) {
      toast.error(EXTERNAL_BLOCK_TIME_MESSAGES[times.reason]);
      return;
    }
    create.mutate(
      {
        idempotencyKey: idempotencyKeyRef.current,
        storeId,
        resourceId,
        startAt: times.startAt,
        endAt: times.endAt,
        ...(title.trim() ? { title: title.trim() } : {}),
      },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // 作成リクエスト送信中は閉じさせない（誤操作で送信状態を失わないため）。
        if (!next && create.isPending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>ブロックを作成</DialogTitle>
          <DialogDescription>
            指定したリソース・時間帯を予約不可にします。時刻は5分単位で指定してください。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {stores.length > 1 && (
            <div className="space-y-2">
              <Label htmlFor="block-store">店舗</Label>
              <Select value={storeId} onValueChange={handleStoreChange}>
                <SelectTrigger id="block-store">
                  <SelectValue placeholder="店舗を選択" />
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

          <div className="space-y-2">
            <Label htmlFor="block-resource">リソース</Label>
            <Select
              value={resourceId}
              onValueChange={setResourceId}
              disabled={!storeId}
            >
              <SelectTrigger id="block-resource">
                <SelectValue
                  placeholder={storeId ? "リソースを選択" : "先に店舗を選択"}
                />
              </SelectTrigger>
              <SelectContent>
                {activeResources.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="block-start">開始日時</Label>
              <Input
                id="block-start"
                type="datetime-local"
                step={300}
                value={startLocal}
                onChange={(e) => setStartLocal(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="block-end">終了日時</Label>
              <Input
                id="block-end"
                type="datetime-local"
                step={300}
                value={endLocal}
                onChange={(e) => setEndLocal(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="block-title">タイトル（任意）</Label>
            <Input
              id="block-title"
              value={title}
              maxLength={TITLE_MAX}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例: 設備メンテナンス"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={create.isPending}
          >
            キャンセル
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {create.isPending ? "作成中..." : "作成"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
