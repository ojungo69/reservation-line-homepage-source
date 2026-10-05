import { statusColor, statusLabel, formatTime } from "@/lib/timeline";
import { displayServiceName } from "@/lib/service-pricing";
import type { Reservation } from "@/types/api";

type ReservationCardProps = {
  reservation: Reservation;
  // minutes は getCardStyle が返す「表示窓で clip 済み」の分数 — 営業時間外へ
  // はみ出す予約は総施術時間より短く描画されるため、行出し分けはこちらを使う。
  style: { top: string; height: string; minutes: number };
  // 15分スロット1行の高さ(px)。カード実高 = style.minutes/15 × slotPx。
  // style.height は % 文字列のため px はここから導出する。
  slotPx: number;
  onClick: (id: string) => void;
};

export function ReservationCard({ reservation, style, slotPx, onClick }: Readonly<ReservationCardProps>) {
  const isPending = reservation.status === "pending_approval";
  const feeUnpaid = !!reservation.cancellationFeeUnpaidAt;
  // 高さ=施術時間 (FR-008 例外) のため、compact 密度の短時間予約では全行が
  // 収まらない (30分 compact = 48px、text-xs 3行は leading-tight でも 51px)。
  // overflow-hidden で途中まで見える切れ方をさせず、収まる行だけ描画する
  // (codex P2)。行高 15px (leading-tight) + py 4px + border 2px で閾値を計算。
  const heightPx = (style.minutes / 15) * slotPx;
  const showService = heightPx >= 36;
  const showTime = heightPx >= 51;

  return (
    <button
      type="button"
      className={`absolute left-0.5 right-0.5 overflow-hidden rounded border px-1.5 py-0.5 text-left text-xs leading-tight transition-opacity hover:opacity-80 ${statusColor(reservation.status)}`}
      // minHeight 22px = text-xs 1 行 16px + py 4px + border 2px。20px だと
      // スロット未満の高さで氏名行そのものが clip される (ExternalBlockCard と同値)。
      style={{ top: style.top, height: style.height, minHeight: "22px", zIndex: 10 }}
      // 高さ=施術時間そのもの (WCAG 2.5.8 essential 候補)。巡回ゲートはこの
      // 属性を持つ要素だけを durationExceptions へ分類する。
      data-duration-geometry=""
      // 巡回ゲートが「予約 status カードが実描画された」ことを外部予定ブロックと
      // 区別して数えるためのマーカー (週表示 WeekView と同じ流儀)。
      data-reservation-status={reservation.status}
      onClick={() => onClick(reservation.id)}
      // 時間帯は showTime が false のとき視覚行から消えるため、常に読み上げ名へ
      // 含める (PR#350「title= 依存はタッチだと情報が読めない」と同じ理由で、
      // 隠した情報の到達手段を残す)。視覚的にはタイムライン上の位置が示す。
      aria-label={`${statusLabel(reservation.status)} ${reservation.customerDisplayName} ${displayServiceName(reservation.serviceName)} ${formatTime(reservation.startAt)}–${formatTime(reservation.endAt)}${feeUnpaid ? " キャンセル料未納" : ""}`}
    >
      <div className="flex items-center gap-1 truncate font-medium">
        {!showService && <span className="max-w-[2em] shrink-0 truncate font-normal">{isPending ? "待ち" : statusLabel(reservation.status)}</span>}
        <span className="min-w-[3em] flex-1 truncate">{reservation.customerDisplayName}</span>
        {isPending && showService && <span aria-hidden>⚠️</span>}
        {feeUnpaid && (
          <span
            aria-hidden
            title="キャンセル料未納"
            className="shrink-0 rounded-sm bg-destructive px-1 text-xs font-bold leading-tight text-destructive-foreground"
          >
            料未
          </span>
        )}
      </div>
      {/* opacity-60/80 は status 色によって実効 2.76〜4.4:1 まで落ちて WCAG AA
          未達 (opacity 合成対応の contrast ゲートで検出)。弱調は text-xs のみ。 */}
      {showService && (
        <div className="flex items-center gap-1 text-xs">
          <span className="shrink-0">{statusLabel(reservation.status)}</span>
          <span className="min-w-0 flex-1 truncate">{displayServiceName(reservation.serviceName)}</span>
        </div>
      )}
      {showTime && (
        <div className="text-xs">
          {formatTime(reservation.startAt)}–{formatTime(reservation.endAt)}
        </div>
      )}
    </button>
  );
}
