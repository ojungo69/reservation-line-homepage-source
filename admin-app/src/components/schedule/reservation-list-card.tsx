import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { displayServiceName } from "@/lib/service-pricing";
import { addDays, formatDateDisplay, formatJstDate, formatTime, statusColor, statusLabel } from "@/lib/timeline";
import type { Reservation } from "@/types/api";

type ReservationListCardProps = {
  reservation: Pick<Reservation, "id" | "status" | "startAt" | "endAt" | "customerDisplayName" | "serviceName" | "storeName" | "cancellationFeeUnpaidAt"> & { resourceName?: string };
  onDetails: (id: string) => void;
  onCustomerClick?: () => void;
  actions?: ReactNode;
  showDate?: boolean;
};

export function ReservationListCard({ reservation, onDetails, onCustomerClick, actions, showDate = false }: Readonly<ReservationListCardProps>) {
  const start = new Date(reservation.startAt);
  const end = new Date(reservation.endAt);
  const endDay = formatJstDate(end);
  let endDate = "";
  if (endDay !== formatJstDate(start)) {
    endDate = endDay === formatJstDate(addDays(start, 1)) ? "翌日 " : `${formatDateDisplay(end)} `;
  }

  return (
    <article data-reservation-status={reservation.status} className="min-w-0 space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium tabular-nums">
            {showDate && <>{formatDateDisplay(start)} </>}
            {formatTime(reservation.startAt)}–{endDate}{formatTime(reservation.endAt)}
          </p>
          {onCustomerClick ? (
            <button
              type="button"
              className="inline-flex min-h-11 max-w-full items-center break-all text-left text-sm underline-offset-2 hover:underline"
              aria-label={`${reservation.customerDisplayName}の顧客情報を開く`}
              onClick={onCustomerClick}
            >
              {reservation.customerDisplayName}
            </button>
          ) : (
            <p className="break-all text-sm">{reservation.customerDisplayName}</p>
          )}
          <p className="break-all text-xs text-muted-foreground">{displayServiceName(reservation.serviceName)}</p>
          <p className="break-all text-xs text-muted-foreground">
            {reservation.storeName}{reservation.resourceName && ` · ${reservation.resourceName}`}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge className={statusColor(reservation.status)} variant="outline">{statusLabel(reservation.status)}</Badge>
          {reservation.cancellationFeeUnpaidAt && <Badge variant="destructive">キャンセル料未納</Badge>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="outline" onClick={() => onDetails(reservation.id)}>詳細</Button>
        {actions}
      </div>
    </article>
  );
}
