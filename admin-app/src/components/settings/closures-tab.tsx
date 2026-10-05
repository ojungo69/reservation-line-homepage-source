import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormHint, invalidFieldProps, type InvalidReason } from "@/components/ui/form-hint";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { PendingConfirmDialog } from "@/components/ui/pending-confirm-dialog";
import { SettingsTabStatus } from "@/components/settings/settings-tab-status";
import { useClosureList, useClosureCreate, useClosureUpdate, useClosureDelete } from "@/hooks/use-closures";
import type { Closure } from "@/types/api";

const JST_DATE_FMT = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const jstToIso = (date: string, endOfDay = false): string => {
  const time = endOfDay ? "23:59:59" : "00:00:00";
  return new Date(`${date}T${time}+09:00`).toISOString();
};

const isoToJstDate = (iso: string): string =>
  JST_DATE_FMT.format(new Date(iso));

type Props = {
  selectedStoreId: string | null;
};

// 保存不可の理由を導出。disabled 判定と表示を同じ関数から取り、乖離を防ぐ。
// 最初に満たされていない条件のみ、対象フィールドと合わせて返す。
function computeClosureInvalid(
  startsAt: string,
  endsAt: string,
): InvalidReason<"startsAt" | "endsAt"> {
  if (!startsAt) return { field: "startsAt", message: "開始日を入力してください" };
  if (!endsAt) return { field: "endsAt", message: "終了日を入力してください" };
  if (endsAt < startsAt) return { field: "endsAt", message: "終了日は開始日以降にしてください" };
  return null;
}

export function ClosuresTab({ selectedStoreId }: Readonly<Props>) {
  const { closureList, isPending } = useClosureList(selectedStoreId);
  const createMutation = useClosureCreate();
  const updateMutation = useClosureUpdate();
  const deleteMutation = useClosureDelete();

  const [createOpen, setCreateOpen] = useState(false);
  const [editClosure, setEditClosure] = useState<Closure | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [reason, setReason] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  const resetForm = () => {
    setStartsAt("");
    setEndsAt("");
    setReason("");
    setIdempotencyKey(crypto.randomUUID());
  };

  const closureInvalid = computeClosureInvalid(startsAt, endsAt);
  // 削除確認に対象期間を出す (日付ミスによる誤削除防止)。
  const deleteTarget = deleteId ? closureList.find((c) => c.id === deleteId) ?? null : null;

  const handleCreate = () => {
    if (!selectedStoreId || closureInvalid !== null) return;
    createMutation.mutate(
      { storeId: selectedStoreId, startsAt: jstToIso(startsAt), endsAt: jstToIso(endsAt, true), reason: reason.trim() || null, idempotencyKey },
      {
        onSuccess: () => {
          resetForm();
          setCreateOpen(false);
        },
      },
    );
  };

  const startEdit = (c: Closure) => {
    setEditClosure(c);
    setStartsAt(isoToJstDate(c.startsAt));
    setEndsAt(isoToJstDate(c.endsAt));
    setReason(c.reason ?? "");
  };

  const handleUpdate = () => {
    if (!editClosure || closureInvalid !== null) return;
    updateMutation.mutate(
      { id: editClosure.id, storeId: editClosure.storeId, startsAt: jstToIso(startsAt), endsAt: jstToIso(endsAt, true), reason: reason.trim() || null },
      {
        onSuccess: () => {
          setEditClosure(null);
          resetForm();
        },
      },
    );
  };

  const handleDelete = () => {
    if (!deleteId) return;
    deleteMutation.mutate(deleteId, {
      // 成功時のみ確認ダイアログを閉じる。エラー時は開いたままにして
      // 再試行できるようにする（onSettled だと失敗でも閉じてしまう）。
      onSuccess: () => {
        setDeleteId(null);
      },
    });
  };

  if (!selectedStoreId || isPending) {
    return <SettingsTabStatus selectedStoreId={selectedStoreId} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setCreateOpen(true)}>+ 追加</Button>
      </div>

      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>開始日</TableHead>
              <TableHead>終了日</TableHead>
              <TableHead>理由</TableHead>
              <TableHead>ソース</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {closureList.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground">
                  休業日がありません
                </TableCell>
              </TableRow>
            ) : (
              closureList.map((c) => {
                const isEditable = c.source === "admin";
                return (
                  <TableRow key={c.id}>
                    <TableCell>{isoToJstDate(c.startsAt)}</TableCell>
                    <TableCell>{isoToJstDate(c.endsAt)}</TableCell>
                    <TableCell>{c.reason ?? "—"}</TableCell>
                    <TableCell>
                      {isEditable ? (
                        <Badge variant="secondary">手動</Badge>
                      ) : (
                        <Badge variant="outline">Google Calendar</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {isEditable && (
                        <div className="flex justify-end gap-2">
                          <Button variant="ghost" size="sm" onClick={() => startEdit(c)}>
                            編集
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setDeleteId(c.id)}>
                            削除
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={createOpen || !!editClosure} onOpenChange={(v) => {
        if (!v) {
          if (createMutation.isPending || updateMutation.isPending) return;
          resetForm();
          setCreateOpen(false);
          setEditClosure(null);
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editClosure ? "休業日を編集" : "休業日を追加"}</DialogTitle>
          </DialogHeader>
          <div className="max-h-[60vh] space-y-4 overflow-y-auto px-1">
            <div className="space-y-2">
              <Label>開始日</Label>
              <Input
                type="date"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
                {...invalidFieldProps(closureInvalid, "startsAt", "closure-form-hint")}
              />
            </div>
            <div className="space-y-2">
              <Label>終了日</Label>
              <Input
                type="date"
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
                {...invalidFieldProps(closureInvalid, "endsAt", "closure-form-hint")}
              />
            </div>
            <div className="space-y-2">
              <Label>理由</Label>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例: 年末年始休業" />
            </div>
            <FormHint id="closure-form-hint" reason={closureInvalid} />
            <DialogFooter>
              <Button
                onClick={editClosure ? handleUpdate : handleCreate}
                disabled={closureInvalid !== null || createMutation.isPending || updateMutation.isPending}
                aria-describedby="closure-form-hint"
              >
                {(createMutation.isPending || updateMutation.isPending) ? "保存中..." : "保存"}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      <PendingConfirmDialog
        // deleteId ではなく deleteTarget で開閉する。削除失敗後の refetch で対象行が
        // 一覧から消えた場合 (別端末で削除済み等)、存在しない ID への再試行を促す
        // ダイアログが開いたまま残るのを防ぐ。
        open={deleteTarget !== null}
        pending={deleteMutation.isPending}
        title="休業日を削除"
        description={
          deleteTarget
            ? `${isoToJstDate(deleteTarget.startsAt)} 〜 ${isoToJstDate(deleteTarget.endsAt)} の休業日を削除しますか？この期間の休業設定が解除されます。`
            : ""
        }
        confirmLabel="削除する"
        onOpenChange={() => setDeleteId(null)}
        onConfirm={handleDelete}
      />
    </div>
  );
}
