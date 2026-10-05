import { useState } from "react";
import { Wallet } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useUnpaidCancellationFees } from "@/hooks/use-cancellation-fees";
import { useReservationCancellationFee } from "@/hooks/use-reservations";
import { formatFullJstDate, formatTime, statusColor, statusLabel } from "@/lib/timeline";
import { displayServiceName } from "@/lib/service-pricing";
import type { UnpaidCancellationFeesResponse } from "@/types/api";

type UnpaidReservation = UnpaidCancellationFeesResponse["reservations"][number];

// 未納は年をまたいで残るので、スケジュール画面の formatDateDisplay ("7月20日 (月)") ではなく
// 年入りの formatFullJstDate を使う。同じ月日の別年の予約と取り違えないため。
const formatJstDay = (iso: string) => formatFullJstDate(new Date(iso));

export default function CancellationFeesPage() {
  const { data, isPending, isError } = useUnpaidCancellationFees();
  const { mutate: updateCancellationFee, isPending: isUpdating } =
    useReservationCancellationFee();
  const [paidTarget, setPaidTarget] = useState<UnpaidReservation | null>(null);

  const reservations = data?.ok ? data.reservations : [];

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-semibold">キャンセル料未納</h1>
        <p className="text-sm text-muted-foreground">
          来店なし（無断キャンセル）でキャンセル料が未回収のお客様の一覧です。お支払いを確認したら「入金済みにする」を押してください。
        </p>
      </div>

      {isPending && (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      )}

      {isError && (
        <div
          role="alert"
          className="rounded-md border border-destructive/50 p-12 text-center text-destructive"
        >
          未納一覧の取得に失敗しました。再読み込みしてください。
        </div>
      )}

      {data?.ok && reservations.length === 0 && (
        <div className="rounded-md border border-dashed p-12 text-center text-muted-foreground">
          <Wallet className="mx-auto mb-2 size-8 opacity-50" aria-hidden="true" />
          未納のキャンセル料はありません
        </div>
      )}

      {/* 上限に当たったことを黙って隠さない (見えている分が全件だと誤解すると回収漏れになる)。
          role="status" ではなく <output> の暗黙ロールを使う (支援技術の対応が広い)。 */}
      {data?.ok && data.truncated && (
        <output className="block rounded-md border border-amber-500/50 bg-amber-50 p-3 text-sm text-amber-900">
          未納が多いため、古い順に {reservations.length} 件のみ表示しています。回収して「入金済みにする」を押すと続きが表示されます。
        </output>
      )}

      {/* ponytail: 列が少ないので予約管理ページのようなカード/テーブル二重描画はせず、
          横スクロールする単一テーブルにする。 */}
      {data?.ok && reservations.length > 0 && (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>予約日時</TableHead>
                <TableHead>顧客</TableHead>
                <TableHead>メニュー</TableHead>
                <TableHead>店舗</TableHead>
                <TableHead>未納になった日</TableHead>
                <TableHead>
                  <span className="sr-only">操作</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reservations.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap text-sm">
                    {formatJstDay(r.startAt)} {formatTime(r.startAt)}–
                    {formatTime(r.endAt)}
                  </TableCell>
                  <TableCell className="text-sm">{r.customerDisplayName}</TableCell>
                  <TableCell className="text-sm">{displayServiceName(r.serviceNames)}</TableCell>
                  <TableCell className="text-sm">{r.storeName}</TableCell>
                  <TableCell className="whitespace-nowrap text-sm">
                    <div className="flex flex-wrap items-center gap-1">
                      {formatJstDay(r.cancellationFeeUnpaidAt)}
                      {/* 未納フラグは no_show 以外の予約にも残りうるので、来店なし以外は
                          状態を併記して取り違えを防ぐ。 */}
                      {r.status !== "no_show" && (
                        <Badge className={statusColor(r.status)} variant="outline">
                          {statusLabel(r.status)}
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isUpdating}
                      onClick={() => setPaidTarget(r)}
                    >
                      入金済みにする
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <AlertDialog open={!!paidTarget} onOpenChange={(open) => !open && setPaidTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>入金済みにしますか？</AlertDialogTitle>
            <AlertDialogDescription>
              {paidTarget &&
                `${paidTarget.customerDisplayName}様（${formatJstDay(paidTarget.startAt)} ${formatTime(paidTarget.startAt)}）のキャンセル料を入金済みにします。一覧から消えます。`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>やめる</AlertDialogCancel>
            <AlertDialogAction
              disabled={isUpdating}
              onClick={() => {
                if (!paidTarget) return;
                updateCancellationFee({ reservationId: paidTarget.id, unpaid: false });
                setPaidTarget(null);
              }}
            >
              入金済みにする
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
