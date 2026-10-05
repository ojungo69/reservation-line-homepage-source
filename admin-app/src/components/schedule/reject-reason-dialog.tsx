import { useEffect, useState } from "react";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * 予約却下の確認 + 理由入力ダイアログ。承認待ちカード・予約管理の行内却下で共用する。
 * 理由は任意 (500字まで)。監査ログに記録し、入力時はお客様への却下通知にも本文として届く。
 */
export function RejectReasonDialog({
  open,
  description,
  onOpenChange,
  onConfirm,
  confirmDisabled = false,
}: Readonly<{
  open: boolean;
  description: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: (reason: string) => void;
  confirmDisabled?: boolean;
}>) {
  const [reason, setReason] = useState("");

  // 開くたびに前回の入力を引き継がない。
  useEffect(() => {
    if (open) setReason("");
  }, [open]);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>予約を却下しますか?</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="reject-reason">却下理由（任意・お客様に通知されます）</Label>
          <Textarea
            id="reject-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            rows={3}
            placeholder="例: 同時間帯に別のご予約が重なったため"
          />
          <p className="text-xs text-muted-foreground">
            入力した理由は操作記録に保存され、お客様への却下通知にもそのまま届きます。
            社内メモや、氏名・電話番号などの個人情報は記入しないでください。
          </p>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>キャンセル</AlertDialogCancel>
          <AlertDialogAction
            disabled={confirmDisabled}
            onClick={(e) => {
              e.preventDefault();
              if (confirmDisabled) return;
              onConfirm(reason.trim());
            }}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            却下する
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
