import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { useCreateCustomer } from "@/hooks/use-customers";

type Props = {
  open: boolean;
  onClose: () => void;
  // 作成成功時に新規顧客の詳細を開くためのコールバック (任意)。
  onCreated?: (customerId: string) => void;
};

// 顧客の手動追加ダイアログ。名前(必須)/フリガナ・電話(任意)。紙カルテのお客様を
// 予約前に登録しておくと、LINE友だち紐付けの「既存客に紐付け」で検索・選択できる。
export function AddCustomerDialog({ open, onClose, onCreated }: Readonly<Props>) {
  const create = useCreateCustomer();
  const [displayName, setDisplayName] = useState("");
  const [displayNameKana, setDisplayNameKana] = useState("");
  const [phone, setPhone] = useState("");
  // idempotencyKey はダイアログを開いた時に採番し、再試行間で保持する
  // (二重送信で顧客が重複登録されないように)。閉じる時にクリア。
  const [idempotencyKey, setIdempotencyKey] = useState("");

  useEffect(() => {
    if (open) {
      setIdempotencyKey(crypto.randomUUID());
    } else {
      setDisplayName("");
      setDisplayNameKana("");
      setPhone("");
      setIdempotencyKey("");
    }
  }, [open]);

  const canSave = displayName.trim().length > 0 && !create.isPending;

  const submit = () => {
    if (!canSave) return;
    create.mutate(
      {
        idempotencyKey,
        displayName: displayName.trim(),
        displayNameKana: displayNameKana.trim() || null,
        phone: phone.trim() || null,
      },
      {
        onSuccess: (res) => {
          onClose();
          if (res?.ok) onCreated?.(res.customerId);
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !create.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>顧客を追加</DialogTitle>
          <DialogDescription>
            紙カルテのお客様などを手動で登録します。後からLINE友だちと紐付けできます。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="add-customer-name" className="text-sm">
              お名前（必須）
            </Label>
            <Input
              id="add-customer-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={120}
              autoFocus
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="add-customer-kana" className="text-sm">
              フリガナ（任意）
            </Label>
            <Input
              id="add-customer-kana"
              value={displayNameKana}
              onChange={(e) => setDisplayNameKana(e.target.value)}
              maxLength={120}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="add-customer-phone" className="text-sm">
              電話番号（任意）
            </Label>
            <Input
              id="add-customer-phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              inputMode="tel"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={create.isPending}>
            キャンセル
          </Button>
          <Button onClick={submit} disabled={!canSave}>
            {create.isPending ? "追加中..." : "追加する"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
