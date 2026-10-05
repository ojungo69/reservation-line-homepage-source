import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { PendingConfirmDialog } from "@/components/ui/pending-confirm-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useStoreLogins,
  useStoreLoginRevoke,
} from "@/hooks/use-store-logins";
import { StoreLoginDialog } from "@/components/store-logins/store-login-dialog";
import { normalizeTimestamp } from "@/lib/audit-format";
import type { StoreLogin, StoreLoginStatus } from "@/types/api";

const AMBIGUOUS_HELP =
  "この店舗は複数のログイン候補があるため自動設定できません";

const STATUS_META: Record<
  StoreLoginStatus,
  { label: string; variant: "default" | "secondary" | "outline" }
> = {
  unset: { label: "未設定", variant: "secondary" },
  pending: { label: "初回ログイン待ち", variant: "outline" },
  active: { label: "有効", variant: "default" },
  disabled: { label: "無効", variant: "secondary" },
};

function formatLastSeen(raw: string): string {
  const parsed = new Date(normalizeTimestamp(raw));
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toLocaleString("ja-JP");
}

// 役割ラベル導出。owner/staff 以外(null)は "—" 表示。
function roleLabel(role: StoreLogin["role"]): string {
  if (role === "owner") return "オーナー";
  if (role === "staff") return "スタッフ";
  return "—";
}

export default function StoreLoginsPage() {
  const { storeLogins, isPending, isError } = useStoreLogins();
  const revokeMutation = useStoreLoginRevoke();

  const [dialogStore, setDialogStore] = useState<StoreLogin | null>(null);
  const [revokeStore, setRevokeStore] = useState<StoreLogin | null>(null);

  const handleRevoke = () => {
    if (!revokeStore) return;
    // Close the confirm only on success; on error keep it open so the error
    // toast (from the hook) is actionable and the operator can retry/cancel
    // (devin PR #308 review: onSettled closed the dialog even on failure).
    revokeMutation.mutate(revokeStore.storeId, {
      onSuccess: () => setRevokeStore(null),
    });
  };

  let content: ReactNode;
  if (isPending) {
    content = (
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  } else if (isError) {
    content = (
      <p className="text-sm text-destructive">
        店舗ログインの取得に失敗しました。
      </p>
    );
  } else {
    content = (
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>店舗</TableHead>
              <TableHead>ログインメール</TableHead>
              <TableHead>役割</TableHead>
              <TableHead>状態</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {storeLogins.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground">
                  店舗がありません
                </TableCell>
              </TableRow>
            ) : (
              storeLogins.map((row) => {
                const meta = STATUS_META[row.status];
                const isAmbiguous = row.attention === "ambiguous_login";
                const canConfigure = row.canConfigure;
                const canRevoke =
                  canConfigure &&
                  (row.status === "active" || row.status === "pending");
                return (
                  <TableRow key={row.storeId}>
                    <TableCell className="font-medium">{row.storeName}</TableCell>
                    <TableCell>
                      {row.email ?? (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>{roleLabel(row.role)}</TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant={meta.variant}>{meta.label}</Badge>
                          {isAmbiguous && (
                            <Badge
                              className="border-orange-300 bg-orange-100 text-orange-800 hover:bg-orange-100"
                            >
                              要手動対応
                            </Badge>
                          )}
                        </div>
                        {row.status === "active" && row.lastSeenAt && (
                          <span className="text-xs text-muted-foreground">
                            最終ログイン: {formatLastSeen(row.lastSeenAt)}
                          </span>
                        )}
                        {isAmbiguous && (
                          <span className="text-xs text-muted-foreground">
                            {AMBIGUOUS_HELP}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-3">
                        <Button
                          variant="outline"
                          size="default"
                          disabled={!canConfigure}
                          title={!canConfigure ? AMBIGUOUS_HELP : undefined}
                          onClick={() => setDialogStore(row)}
                        >
                          {row.status === "unset" ? "設定" : "再設定"}
                        </Button>
                        {canRevoke && (
                          <Button
                            variant="destructive"
                            size="default"
                            disabled={!canConfigure}
                            onClick={() => setRevokeStore(row)}
                          >
                            無効化
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-bold">店舗ログイン</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          各店舗の共有ログイン用メールアドレスを設定します。設定後、スタッフがそのメールアドレスで初回ログインすると、その店舗のログインが自動で有効になります。
        </p>
      </div>

      {content}

      {dialogStore && (
        <StoreLoginDialog
          open={!!dialogStore}
          onOpenChange={(open) => {
            if (!open) setDialogStore(null);
          }}
          store={dialogStore}
        />
      )}

      <PendingConfirmDialog
        open={!!revokeStore}
        pending={revokeMutation.isPending}
        title="店舗ログインを無効化"
        description={`${revokeStore?.storeName ?? ""} のログインを無効化しますか？このメールアドレスでのログインはできなくなります。`}
        confirmLabel="無効化する"
        onOpenChange={() => setRevokeStore(null)}
        onConfirm={handleRevoke}
      />
    </div>
  );
}
