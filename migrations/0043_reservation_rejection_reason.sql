-- 予約却下理由を予約行に保存する。
--
-- これまで却下理由は audit_logs の metadata にのみ記録され、顧客への却下通知
-- (reservation_rejected の LINE push / fallback email) には含まれていなかった。
-- 顧客にも理由を伝えられるよう、却下時に理由をこの列へ保存し、通知ディスパッチャ
-- (src/line/notifications.ts の BRANCH_A / src/notifications/email-fallback.ts)
-- が reservations JOIN 経由で読み取る。
--
-- Nullable: 却下以外の予約・却下理由未入力の却下・既存行はすべて NULL。理由入力は
-- 任意のため、NULL は「理由なし」を意味し通知に理由行を出さない。
--
-- No BEGIN/COMMIT: D1 は migration 内の明示トランザクション制御を拒否する。

ALTER TABLE reservations
  ADD COLUMN rejection_reason TEXT;
