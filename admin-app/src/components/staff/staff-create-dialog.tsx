import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormHint, invalidFieldProps, type InvalidReason } from "@/components/ui/form-hint";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useStaffCreate } from "@/hooks/use-staff";
import { useAuth } from "@/hooks/use-auth";

type StoreOption = { id: string; name: string };

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stores: StoreOption[];
  defaultStoreId: string | null;
};

const ALL_ROLE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "staff", label: "スタッフ" },
  { value: "owner", label: "オーナー" },
  { value: "system_admin", label: "システム管理者" },
];

// 保存不可の理由を判定する(disabled 判定と表示を同じ導出から取る)。
function getStaffInvalidReason(
  displayName: string,
  storeId: string,
): InvalidReason<"displayName" | "storeId"> {
  if (!displayName.trim()) return { field: "displayName", message: "表示名を入力してください" };
  if (!storeId) return { field: "storeId", message: "店舗を選択してください" };
  return null;
}

export function StaffCreateDialog({ open, onOpenChange, stores, defaultStoreId }: Readonly<Props>) {
  const { user } = useAuth();
  const createMutation = useStaffCreate();
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState("staff");
  const [storeId, setStoreId] = useState(defaultStoreId ?? stores[0]?.id ?? "");
  const idempotencyKeyRef = useRef<string>("");
  if (!idempotencyKeyRef.current) {
    idempotencyKeyRef.current = crypto.randomUUID();
  }

  const roleOptions = user.role === "system_admin"
    ? ALL_ROLE_OPTIONS
    : ALL_ROLE_OPTIONS.filter((r) => r.value !== "system_admin");

  const reset = () => {
    setDisplayName("");
    setRole("staff");
    setStoreId(defaultStoreId ?? stores[0]?.id ?? "");
    idempotencyKeyRef.current = crypto.randomUUID();
  };

  const staffInvalid = getStaffInvalidReason(displayName, storeId);

  const handleSubmit = () => {
    if (staffInvalid !== null) return;
    createMutation.mutate(
      {
        storeId,
        displayName: displayName.trim(),
        role: role as "owner" | "staff" | "system_admin",
        active: true,
        idempotencyKey: idempotencyKeyRef.current,
      },
      {
        onSuccess: () => {
          reset();
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          if (createMutation.isPending) return;
          reset();
        }
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>スタッフ追加</DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-4 overflow-y-auto px-1">
          <div className="space-y-2">
            <Label htmlFor="create-staff-name">表示名</Label>
            <Input
              id="create-staff-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="例: 山田 花子"
              autoFocus
              {...invalidFieldProps(staffInvalid, "displayName", "staff-create-hint")}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="create-staff-store">店舗</Label>
            <Select value={storeId} onValueChange={setStoreId}>
              <SelectTrigger
                id="create-staff-store"
                {...invalidFieldProps(staffInvalid, "storeId", "staff-create-hint")}
              >
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
          <div className="space-y-2">
            <Label htmlFor="create-staff-role">ロール</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger id="create-staff-role">
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
          <FormHint id="staff-create-hint" reason={staffInvalid} />
          <DialogFooter>
            <Button
              onClick={handleSubmit}
              disabled={staffInvalid !== null || createMutation.isPending}
              aria-describedby="staff-create-hint"
            >
              {createMutation.isPending ? "追加中..." : "追加"}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
