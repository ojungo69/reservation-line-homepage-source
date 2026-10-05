import { useState, useEffect } from "react";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormHint, invalidFieldProps, type InvalidReason } from "@/components/ui/form-hint";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PendingConfirmDialog } from "@/components/ui/pending-confirm-dialog";
import { useStaffUpdate, useStaffDelete } from "@/hooks/use-staff";
import { useAuth } from "@/hooks/use-auth";
import type { StaffMember } from "@/types/api";
import { DetailRow } from "@/components/ui/detail-row";

type StoreOption = { id: string; name: string };

type Props = {
  staff: StaffMember | null;
  stores: StoreOption[];
  onClose: () => void;
};

const ROLE_LABELS: Record<string, string> = {
  owner: "オーナー",
  staff: "スタッフ",
  system_admin: "システム管理者",
};

const ALL_ROLE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "owner", label: "オーナー" },
  { value: "staff", label: "スタッフ" },
  { value: "system_admin", label: "システム管理者" },
];

function StaffActions({
  active,
  canEdit,
  isSelf,
  pending,
  onEdit,
  onDeactivate,
  onReactivate,
}: Readonly<{
  active: boolean;
  canEdit: boolean;
  isSelf: boolean;
  pending: boolean;
  onEdit: () => void;
  onDeactivate: () => void;
  onReactivate: () => void;
}>) {
  if (!canEdit) return null;
  return (
    <div className="flex gap-2">
      <Button variant="outline" onClick={onEdit}>
        編集
      </Button>
      {active && !isSelf && (
        <Button variant="destructive" onClick={onDeactivate}>
          無効化
        </Button>
      )}
      {!active && (
        <Button variant="outline" onClick={onReactivate} disabled={pending}>
          {pending ? "処理中..." : "有効化"}
        </Button>
      )}
    </div>
  );
}

export function StaffDetailPanel({ staff, stores, onClose }: Readonly<Props>) {
  const { user } = useAuth();
  const updateMutation = useStaffUpdate();
  const deleteMutation = useStaffDelete();

  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState("staff");
  // 楽観ロックの version は編集開始時のスナップショット。displayName/role と同じ
  // 時点で固定しておかないと、編集中に裏でこの行が更新された場合、古いフィールドを
  // 新しい version で送って他者の変更を上書きしてしまう (stale_snapshot を返せない)。
  const [editVersion, setEditVersion] = useState(0);
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  useEffect(() => {
    setEditing(false);
    setDeleteConfirm(false);
  }, [staff?.id]);

  const startEdit = () => {
    if (!staff) return;
    setDisplayName(staff.displayName);
    setRole(staff.role);
    setEditVersion(staff.version);
    setEditing(true);
  };

  // 保存不可の理由 (disabled 判定・submit guard・表示を同じ導出から取る)
  const staffEditInvalid: InvalidReason<"displayName"> = !displayName.trim()
    ? { field: "displayName", message: "表示名を入力してください" }
    : null;

  const saveEdit = () => {
    if (!staff || staffEditInvalid !== null) return;
    updateMutation.mutate(
      {
        id: staff.id,
        storeId: staff.storeId,
        displayName: displayName.trim(),
        role: role as "owner" | "staff" | "system_admin",
        active: staff.active,
        expectedVersion: editVersion,
      },
      {
        onSuccess: () => {
          setEditing(false);
        },
      },
    );
  };

  const handleDelete = () => {
    if (!staff) return;
    deleteMutation.mutate(staff.id, {
      onSuccess: () => {
        setDeleteConfirm(false);
        onClose();
      },
      onSettled: () => {
        setDeleteConfirm(false);
      },
    });
  };

  const handleReactivate = () => {
    if (!staff) return;
    updateMutation.mutate(
      {
        id: staff.id,
        storeId: staff.storeId,
        displayName: staff.displayName,
        role: staff.role as "owner" | "staff" | "system_admin",
        active: true,
        expectedVersion: staff.version,
      },
    );
  };

  const storeName =
    stores.find((s) => s.id === staff?.storeId)?.name ?? staff?.storeId ?? "";
  const isSelf = user?.staffMemberId === staff?.id;
  const isSystemAdmin = user.role === "system_admin";
  const canEditTarget = isSystemAdmin || staff?.role !== "system_admin";
  const roleOptions = isSystemAdmin
    ? ALL_ROLE_OPTIONS
    : ALL_ROLE_OPTIONS.filter((r) => r.value !== "system_admin");

  return (
    <>
      <Sheet open={!!staff} onOpenChange={(open) => !open && onClose()}>
        <SheetContent side="right" className="w-full sm:max-w-lg">
          {!staff ? (
            <div className="space-y-4 pt-6">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-6 w-full" />
              ))}
            </div>
          ) : (
            <div className="space-y-6 pt-6">
              {/* pr-8: 44px Close (右端 52px 占有) に長い氏名が潜らないため。 */}
              <div className="pr-8">
                <h2 className="text-lg font-semibold">{staff.displayName}</h2>
                <div className="mt-1 flex items-center gap-2">
                  <Badge variant={staff.active ? "default" : "secondary"}>
                    {staff.active ? "有効" : "無効"}
                  </Badge>
                  <Badge variant="outline">{ROLE_LABELS[staff.role] ?? staff.role}</Badge>
                  {isSelf && <Badge variant="outline">自分</Badge>}
                </div>
              </div>

              <Separator />

              {editing ? (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="staff-name">表示名</Label>
                    <Input
                      id="staff-name"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder="表示名を入力"
                      {...invalidFieldProps(staffEditInvalid, "displayName", "staff-edit-hint")}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="staff-role">ロール</Label>
                    <Select value={role} onValueChange={setRole}>
                      <SelectTrigger id="staff-role">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {roleOptions.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <FormHint id="staff-edit-hint" reason={staffEditInvalid} />
                  <div className="flex gap-2">
                    <Button
                      onClick={saveEdit}
                      disabled={staffEditInvalid !== null || updateMutation.isPending}
                      aria-describedby="staff-edit-hint"
                    >
                      {updateMutation.isPending ? "保存中..." : "保存"}
                    </Button>
                    <Button variant="outline" onClick={() => setEditing(false)}>
                      キャンセル
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <Row label="表示名" value={staff.displayName} />
                  <Row label="ロール" value={ROLE_LABELS[staff.role] ?? staff.role} />
                  <Row label="店舗" value={storeName} />
                  <Row label="状態" value={staff.active ? "有効" : "無効"} />
                </div>
              )}

              {!editing && (
                <StaffActions
                  active={staff.active}
                  canEdit={canEditTarget}
                  isSelf={isSelf}
                  pending={updateMutation.isPending}
                  onEdit={startEdit}
                  onDeactivate={() => setDeleteConfirm(true)}
                  onReactivate={handleReactivate}
                />
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>

      <PendingConfirmDialog
        open={deleteConfirm}
        pending={deleteMutation.isPending}
        title="スタッフを無効化"
        description={`${staff?.displayName ?? ""} を無効化しますか？この操作は元に戻せます。`}
        confirmLabel="無効化する"
        onOpenChange={setDeleteConfirm}
        onConfirm={handleDelete}
      />
    </>
  );
}

export function Row({ label, value }: Readonly<{ label: string; value: string }>) {
  return <DetailRow label={label} value={value} className="flex items-center justify-between text-sm" />;
}
