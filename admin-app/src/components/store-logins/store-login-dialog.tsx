import { useEffect, useRef, useState } from "react";
import { INSTANCE_CONFIG } from "../../../../src/instance-config";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { useStoreLoginUpsert } from "@/hooks/use-store-logins";
import type { StoreLogin } from "@/types/api";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  store: StoreLogin;
};

const ROLE_OPTIONS: Array<{ value: "owner" | "staff"; label: string }> = [
  { value: "staff", label: "スタッフ" },
  { value: "owner", label: "オーナー" },
];

const defaultEmailFor = (store: StoreLogin): string =>
  store.email ?? `${store.storeId}@${INSTANCE_CONFIG.staffEmailDomain}`;

export function StoreLoginDialog({ open, onOpenChange, store }: Readonly<Props>) {
  const upsertMutation = useStoreLoginUpsert();
  const [email, setEmail] = useState(() => defaultEmailFor(store));
  const [role, setRole] = useState<"owner" | "staff">(store.role ?? "staff");
  const idempotencyKeyRef = useRef<string>("");
  if (!idempotencyKeyRef.current) {
    idempotencyKeyRef.current = crypto.randomUUID();
  }

  // Re-seed the form whenever the dialog is (re)opened for a store so the
  // fields reflect the current row rather than a stale previous selection.
  useEffect(() => {
    if (open) {
      setEmail(defaultEmailFor(store));
      setRole(store.role ?? "staff");
      idempotencyKeyRef.current = crypto.randomUUID();
    }
    // store.email / store.role change identify a fresh row; depend on the
    // primitive fields rather than the object reference.
  }, [open, store.storeId, store.email, store.role]);

  const handleSubmit = () => {
    const trimmed = email.trim();
    if (!trimmed) return;
    upsertMutation.mutate(
      {
        storeId: store.storeId,
        email: trimmed,
        role,
        idempotencyKey: idempotencyKeyRef.current,
      },
      {
        onSuccess: () => {
          idempotencyKeyRef.current = crypto.randomUUID();
          onOpenChange(false);
        },
        onError: () => {
          // Rotate the key so a corrected retry (e.g. after email_in_use) is a
          // fresh request rather than an idempotency_conflict (409) replay of the
          // failed payload's hash. (PR #308 gemini review.)
          idempotencyKeyRef.current = crypto.randomUUID();
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && upsertMutation.isPending) return;
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {store.status === "unset" ? "店舗ログインを設定" : "店舗ログインを再設定"}
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              {store.storeName}
            </span>
          </DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-4 overflow-y-auto px-1">
          <div className="space-y-2">
            <Label htmlFor="store-login-email">ログインメール</Label>
            <Input
              id="store-login-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={`例: store@${INSTANCE_CONFIG.staffEmailDomain}`}
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="store-login-role">役割</Label>
            <Select value={role} onValueChange={(v) => setRole(v as "owner" | "staff")}>
              <SelectTrigger id="store-login-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="text-sm text-muted-foreground">
            設定後、スタッフがこのメールアドレスで初回ログインすると自動で有効になります。
          </p>
          <DialogFooter>
            <Button
              onClick={handleSubmit}
              disabled={!email.trim() || upsertMutation.isPending}
            >
              {upsertMutation.isPending ? "設定中..." : "設定する"}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
