import { useRef, useState } from "react";
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
import { useResourceList, useResourceCreate, useResourceUpdate, useResourceDelete } from "@/hooks/use-resources";
import type { Resource } from "@/types/api";

type Props = {
  selectedStoreId: string | null;
};

export function ResourcesTab({ selectedStoreId }: Readonly<Props>) {
  const { resourceList, isPending } = useResourceList(selectedStoreId);
  const createMutation = useResourceCreate();
  const updateMutation = useResourceUpdate();
  const deleteMutation = useResourceDelete();

  const [createOpen, setCreateOpen] = useState(false);
  const [editResource, setEditResource] = useState<Resource | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  // useResourceUpdate は dialog の編集と row toggle の active 切替で共有されるため、
  // dialog 経由の保存中かどうかを別途追跡して close guard を局所化する。
  // close guard (onOpenChange) 内でのみ参照し render では読まないため ref で保持する。
  const dialogSavingRef = useRef(false);

  const resetForm = () => {
    setName("");
    setIdempotencyKey(crypto.randomUUID());
  };

  // 保存不可の理由 (disabled 判定と表示を同じ導出から取る)
  const resourceInvalid: InvalidReason<"name"> = !name.trim()
    ? { field: "name", message: "名前を入力してください" }
    : null;

  const handleCreate = () => {
    if (!selectedStoreId || resourceInvalid !== null) return;
    createMutation.mutate(
      { storeId: selectedStoreId, name: name.trim(), resourceType: "staff_calendar", active: true, idempotencyKey },
      {
        onSuccess: () => {
          resetForm();
          setCreateOpen(false);
        },
      },
    );
  };

  const startEdit = (r: Resource) => {
    setEditResource(r);
    setName(r.name);
  };

  const handleUpdate = () => {
    if (!editResource || resourceInvalid !== null) return;
    dialogSavingRef.current = true;
    updateMutation.mutate(
      { id: editResource.id, storeId: editResource.storeId, name: name.trim(), resourceType: "staff_calendar", active: editResource.active },
      {
        onSuccess: () => {
          setEditResource(null);
          resetForm();
        },
        onSettled: () => {
          dialogSavingRef.current = false;
        },
      },
    );
  };

  const handleToggleActive = (r: Resource) => {
    updateMutation.mutate(
      { id: r.id, storeId: r.storeId, name: r.name, resourceType: "staff_calendar", active: !r.active },
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
              <TableHead>名前</TableHead>
              <TableHead>状態</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {resourceList.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3} className="text-center text-muted-foreground">
                  リソースがありません
                </TableCell>
              </TableRow>
            ) : (
              resourceList.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell>
                    <Badge variant={r.active ? "default" : "secondary"}>
                      {r.active ? "有効" : "無効"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" size="sm" onClick={() => startEdit(r)}>
                        編集
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => handleToggleActive(r)} disabled={updateMutation.isPending}>
                        {r.active ? "無効化" : "有効化"}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setDeleteId(r.id)}>
                        削除
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={createOpen || !!editResource} onOpenChange={(v) => {
        if (!v) {
          // dialog 経由の保存中だけ close を抑止する (row toggle の updateMutation は無関係)
          if (createMutation.isPending || dialogSavingRef.current) return;
          resetForm();
          setCreateOpen(false);
          setEditResource(null);
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editResource ? "リソースを編集" : "リソースを追加"}</DialogTitle>
          </DialogHeader>
          <div className="max-h-[60vh] space-y-4 overflow-y-auto px-1">
            <div className="space-y-2">
              <Label>名前</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例: スタッフA"
                autoFocus
                {...invalidFieldProps(resourceInvalid, "name", "resource-form-hint")}
              />
            </div>
            <FormHint id="resource-form-hint" reason={resourceInvalid} />
            <DialogFooter>
              <Button
                onClick={editResource ? handleUpdate : handleCreate}
                disabled={resourceInvalid !== null || createMutation.isPending || updateMutation.isPending}
                aria-describedby="resource-form-hint"
              >
                {(createMutation.isPending || updateMutation.isPending) ? "保存中..." : "保存"}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      <PendingConfirmDialog
        open={deleteId !== null}
        pending={deleteMutation.isPending}
        title="リソースを削除"
        description="このリソースを削除しますか？将来の予約がある場合は削除できません。"
        confirmLabel="削除する"
        onOpenChange={() => setDeleteId(null)}
        onConfirm={handleDelete}
      />
    </div>
  );
}
