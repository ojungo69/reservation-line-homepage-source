import { useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useConflictAction } from "@/hooks/use-sync-status";
import type { SyncConflict } from "@/types/api";
import {
  ACTION_LABELS,
  ACTION_HELP,
  actionHasSideEffect,
  confirmCopyForAction,
  type ActionType,
} from "./conflict-action-meta";
import { formatDateTime } from "@/lib/timeline";

type ConflictDisplay = Pick<SyncConflict, "id" | "conflictType" | "summary" | "createdAt" | "overlappingReservations"> & {
  startAt?: string | null;
  endAt?: string | null;
  storeName?: string;
  customerDisplayName?: string | null;
};
type Props = { conflicts: ConflictDisplay[]; ownerOnly?: boolean };

const CONFLICT_TYPE_LABELS: Record<string, string> = {
  external_block_slot_conflict: "外部ブロック競合",
  external_block_event_deleted: "外部ブロック削除",
  external_block_non_google_edit: "外部ブロック編集",
  reservation_event_deleted: "Google側で予約削除",
  google_all_day_event: "終日イベント候補",
  google_recurring_event: "繰り返しイベント",
};

const needsReason = (action: ActionType) =>
  action === "approve-cancel" || action === "reject-delete";

// Module scope (not defined inside ConflictList) so it is a stable component type
// across renders — an in-component definition remounts every render, losing focus
// and any future internal state. Depends only on pure module imports + props.
const ActionButton = ({
  action,
  onClick,
}: {
  action: ActionType;
  onClick: () => void;
}) => {
  const sideEffect = actionHasSideEffect(action);
  return (
    <div className="flex flex-col items-end gap-0.5">
      <Button
        size="sm"
        variant={sideEffect ? "destructive" : "outline"}
        onClick={onClick}
      >
        {ACTION_LABELS[action]}
      </Button>
      <span
        className={
          sideEffect
            ? "max-w-[16rem] text-right text-xs text-destructive"
            : "max-w-[16rem] text-right text-xs text-muted-foreground"
        }
      >
        {ACTION_HELP[action]}
      </span>
    </div>
  );
};

export function ConflictList({ conflicts, ownerOnly = false }: Readonly<Props>) {
  const actionMutation = useConflictAction();
  const [confirmAction, setConfirmAction] = useState<{
    conflict: ConflictDisplay;
    action: ActionType;
  } | null>(null);
  const [reason, setReason] = useState("");
  // One idempotency key per dialog session. Since the dialog now stays open on
  // failure (onSuccess-close), a retry within the same dialog reuses this key so
  // a lost-response retry replays the original request instead of diverging.
  // Re-minted on every open (handleAction), including when a different action is
  // chosen, so distinct actions never share a key.
  const idempotencyKeyRef = useRef<string>("");

  if (conflicts.length === 0) {
    return <p className="text-sm text-muted-foreground">未解決の競合はありません。</p>;
  }

  const handleAction = (conflict: ConflictDisplay, action: ActionType) => {
    setConfirmAction({ conflict, action });
    setReason("");
    idempotencyKeyRef.current = crypto.randomUUID();
  };

  const executeAction = () => {
    if (!confirmAction) return;
    const { conflict, action } = confirmAction;
    const idempotencyKey = idempotencyKeyRef.current;

    type PathType = Parameters<typeof actionMutation.mutate>[0]["path"];
    let path: PathType;
    let body: Record<string, unknown> = { idempotencyKey };

    switch (action) {
      case "ignore":
        path = `conflicts/${conflict.id}/ignore`;
        if (reason.trim()) body.note = reason.trim();
        break;
      case "manual-resolve":
        path = `conflicts/${conflict.id}/manual-resolve`;
        if (reason.trim()) body.note = reason.trim();
        break;
      case "manual-resolve-cancel-block":
        path = `conflicts/${conflict.id}/manual-resolve`;
        body.cancelExternalBlock = true;
        if (reason.trim()) body.note = reason.trim();
        break;
      case "approve-cancel":
        path = `conflicts/${conflict.id}/approve-cancel`;
        body.reason = reason.trim() || null;
        break;
      case "reject-delete":
        path = `conflicts/${conflict.id}/reject-delete`;
        body.reason = reason.trim() || null;
        break;
      case "all-day-approve":
        path = `all-day-candidates/${conflict.id}/approve`;
        if (reason.trim()) body.closureScope = { reason: reason.trim() };
        break;
      case "all-day-reject":
        path = `all-day-candidates/${conflict.id}/reject`;
        if (reason.trim()) body.reason = reason.trim();
        break;
    }

    actionMutation.mutate(
      { path, body },
      {
        // 成功時のみ確認ダイアログを閉じる。エラー時は開いたままにして
        // 入力済みの reason を保持し、再試行できるようにする
        // (onSettled だと失敗でも閉じてしまい reason が失われる)。
        onSuccess: () => setConfirmAction(null),
      },
    );
  };

  const actionButtons = (conflict: ConflictDisplay) => {
    if (ownerOnly && !["reservation_event_deleted", "google_all_day_event"].includes(conflict.conflictType)) return null;
    if (ownerOnly && (!conflict.startAt || !conflict.endAt)) return <p className="text-sm">対象日時を確認できません。管理者に確認してください。</p>;
    switch (conflict.conflictType) {
      case "reservation_event_deleted":
        return (
          <>
            <ActionButton action="approve-cancel" onClick={() => handleAction(conflict, "approve-cancel")} />
            <ActionButton action="reject-delete" onClick={() => handleAction(conflict, "reject-delete")} />
          </>
        );
      case "google_all_day_event":
        return (
          <>
            <ActionButton action="all-day-approve" onClick={() => handleAction(conflict, "all-day-approve")} />
            <ActionButton action="all-day-reject" onClick={() => handleAction(conflict, "all-day-reject")} />
          </>
        );
      case "external_block_event_deleted":
        return (
          <>
            <ActionButton action="manual-resolve-cancel-block" onClick={() => handleAction(conflict, "manual-resolve-cancel-block")} />
            <ActionButton action="ignore" onClick={() => handleAction(conflict, "ignore")} />
          </>
        );
      default:
        return (
          <>
            <ActionButton action="manual-resolve" onClick={() => handleAction(conflict, "manual-resolve")} />
            <ActionButton action="ignore" onClick={() => handleAction(conflict, "ignore")} />
          </>
        );
    }
  };

  return (
    <div className="space-y-2">
      <h2 className="font-semibold text-lg">競合一覧 ({conflicts.length})</h2>
      <div className="grid gap-2">
        {conflicts.map((conflict) => (
          <Card key={conflict.id} className="p-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">
                {CONFLICT_TYPE_LABELS[conflict.conflictType] ?? conflict.conflictType}
              </Badge>
              {conflict.summary && (
                <span className="text-sm font-medium">{conflict.summary}</span>
              )}
              <span className="text-xs text-muted-foreground ml-auto">
                {formatDateTime(conflict.createdAt)}
              </span>
            </div>

            {conflict.startAt && conflict.endAt && (
              <p className="text-sm">対象日時: {formatDateTime(conflict.startAt)}〜{formatDateTime(conflict.endAt)}（終了時刻を含みません）</p>
            )}
            {(conflict.storeName || conflict.customerDisplayName) && (
              <p className="text-sm">{conflict.storeName}{conflict.customerDisplayName && `${conflict.storeName ? " · " : ""}${conflict.customerDisplayName}様`}</p>
            )}
            {conflict.overlappingReservations.length > 0 && (
              <div className="text-xs text-muted-foreground space-y-0.5">
                <p className="font-medium">重複する予約:</p>
                {conflict.overlappingReservations.map((r) => (
                  <p key={r.id}>
                    {r.customerDisplayName}: {formatDateTime(r.startAt)}〜{formatDateTime(r.endAt)}{" "}
                    <Badge variant="secondary" className="text-xs py-0">
                      {r.status}
                    </Badge>
                  </p>
                ))}
              </div>
            )}

            <div className="flex flex-wrap justify-end gap-2">
              {actionButtons(conflict)}
            </div>
          </Card>
        ))}
      </div>

      <AlertDialog
        open={!!confirmAction}
        onOpenChange={(v) => {
          if (!v && !actionMutation.isPending) setConfirmAction(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction ? ACTION_LABELS[confirmAction.action] : ""}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction ? confirmCopyForAction(confirmAction.action) : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirmAction && (
            <div className="space-y-2">
              <Label>{needsReason(confirmAction.action) ? "理由" : "メモ（任意）"}</Label>
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={needsReason(confirmAction.action) ? "理由を入力" : "メモを入力（任意）"}
              />
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionMutation.isPending}>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                executeAction();
              }}
              disabled={actionMutation.isPending || (!!confirmAction && needsReason(confirmAction.action) && !reason.trim())}
            >
              {actionMutation.isPending ? "処理中..." : "実行"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
