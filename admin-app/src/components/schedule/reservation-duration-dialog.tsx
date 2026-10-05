import { useRef, useState } from "react";
import {
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { PendingDialog } from "@/components/ui/pending-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRescheduleReservation } from "@/hooks/use-reservations";
import { formatTime, formatDateDisplay } from "@/lib/timeline";
import { resolveRescheduleKey, type RescheduleKeyState } from "@/lib/reschedule-idempotency";

// worker src/reservations/slot-times.ts と keep-in-sync。
// 予約の占有時間 = 施術時間 + 清掃バッファ。管理画面では施術時間（バッファ除く）で扱う。
const INTERVAL_MINUTES = 5; // RESERVATION_INTERVAL_MINUTES（清掃バッファ）
const STEP_MINUTES = 5; // SLOT_LOCK_INTERVAL_MINUTES（入力の刻み）
const MAX_TREATMENT_MINUTES = 235; // MAX_TOTAL_SERVICE_DURATION_MINUTES
const MIN_TREATMENT_MINUTES = 5;

export type DurationTarget = {
  id: string;
  startAt: string;
  endAt: string;
  resourceName: string;
};

// 占有時間（end - start, 分）から施術時間（バッファ除く）を逆算する。下限で丸める。
export const occupancyToTreatment = (startAt: string, endAt: string): number => {
  const occ = Math.round((new Date(endAt).getTime() - new Date(startAt).getTime()) / 60000);
  return Math.max(MIN_TREATMENT_MINUTES, occ - INTERVAL_MINUTES);
};

export function ReservationDurationDialog({
  reservation,
  onClose,
}: Readonly<{
  reservation: DurationTarget | null;
  onClose: () => void;
}>) {
  // mutation は Dialog 側で持ち、送信中は Escape・外側クリック・× による dismiss を止める。
  // in-flight のまま form が unmount されて idempotency キーを失うのを防ぐ（reschedule dialog と同方針）。
  const { mutate: reschedule, isPending } = useRescheduleReservation();
  // idempotency キー状態は開閉をまたいで生き残るこのダイアログ本体で保持する。
  const keyStatesRef = useRef<Map<string, RescheduleKeyState>>(new Map());
  return (
    <PendingDialog
      open={reservation !== null}
      pending={isPending}
      onClose={onClose}
    >
      {reservation && (
        // reservation が変わるたびに form を作り直すため key を付けてマウントし直す。
        <DurationForm
          key={reservation.id}
          reservation={reservation}
          reschedule={reschedule}
          isPending={isPending}
          keyStatesRef={keyStatesRef}
          onClose={onClose}
        />
      )}
    </PendingDialog>
  );
}

function DurationForm({
  reservation,
  reschedule,
  isPending,
  keyStatesRef,
  onClose,
}: Readonly<{
  reservation: DurationTarget;
  reschedule: ReturnType<typeof useRescheduleReservation>["mutate"];
  isPending: boolean;
  keyStatesRef: React.RefObject<Map<string, RescheduleKeyState>>;
  onClose: () => void;
}>) {
  const currentTreatment = occupancyToTreatment(reservation.startAt, reservation.endAt);
  const [minutes, setMinutes] = useState<number>(currentTreatment);
  const [error, setError] = useState<string | null>(null);

  const validMinutes =
    Number.isInteger(minutes) &&
    minutes % STEP_MINUTES === 0 &&
    minutes >= MIN_TREATMENT_MINUTES &&
    minutes <= MAX_TREATMENT_MINUTES;

  // プレビュー終了 = 開始 + 施術時間 + バッファ。無効入力時は現状維持でプレビューだけ止める。
  const previewEndIso = validMinutes
    ? new Date(new Date(reservation.startAt).getTime() + (minutes + INTERVAL_MINUTES) * 60000).toISOString()
    : null;

  const currentLabel = `${formatDateDisplay(new Date(reservation.startAt))} ${formatTime(
    reservation.startAt,
  )}（現在の施術時間 ${currentTreatment}分）`;

  const handleSubmit = () => {
    setError(null);
    if (!validMinutes) {
      setError(
        `施術時間は${MIN_TREATMENT_MINUTES}〜${MAX_TREATMENT_MINUTES}分の${STEP_MINUTES}分刻みで入力してください`,
      );
      return;
    }
    if (minutes === currentTreatment) {
      setError("施術時間が現在と同じです。別の長さを入力してください。");
      return;
    }
    // 開始時刻は変更しない。キーは（予約, 施術時間）で識別する — 同じ長さの再送は replay され、
    // 別の長さは新しいキーになる。応答喪失後の手動リトライで副作用が二重に起きないようにする。
    const discriminator = `${reservation.startAt}|dur:${minutes}`;
    const keyState = resolveRescheduleKey(
      keyStatesRef.current.get(reservation.id) ?? null,
      reservation.id,
      discriminator,
      () => crypto.randomUUID(),
    );
    keyStatesRef.current.set(reservation.id, keyState);
    reschedule(
      {
        reservationId: reservation.id,
        startAt: reservation.startAt,
        treatmentMinutes: minutes,
        idempotencyKey: keyState.key,
      },
      {
        onSuccess: () => {
          keyStatesRef.current.delete(reservation.id);
          onClose();
        },
      },
    );
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>施術時間の変更</DialogTitle>
        <DialogDescription>
          開始時刻（{formatTime(reservation.startAt)}）と担当（{reservation.resourceName}
          ）はそのままに、施術時間の長さだけを変更します。
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        <div className="rounded-md border bg-muted/30 p-3 text-sm">
          <span className="text-muted-foreground">変更前：</span>
          {currentLabel}
        </div>

        <div className="space-y-1">
          <label htmlFor="duration-minutes" className="text-xs font-medium text-muted-foreground">
            新しい施術時間（分）
          </label>
          <Input
            id="duration-minutes"
            type="number"
            inputMode="numeric"
            min={MIN_TREATMENT_MINUTES}
            max={MAX_TREATMENT_MINUTES}
            step={STEP_MINUTES}
            value={Number.isNaN(minutes) ? "" : minutes}
            onChange={(e) => setMinutes(e.target.valueAsNumber)}
          />
          <p className="text-xs text-muted-foreground">
            {previewEndIso
              ? `終了予定 ${formatTime(reservation.startAt)} → ${formatTime(previewEndIso)}`
              : `${MIN_TREATMENT_MINUTES}〜${MAX_TREATMENT_MINUTES}分の${STEP_MINUTES}分刻みで入力してください`}
          </p>
        </div>

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={isPending}>
          キャンセル
        </Button>
        <Button onClick={handleSubmit} disabled={isPending}>
          {isPending ? "変更中..." : "施術時間を変更"}
        </Button>
      </DialogFooter>
    </>
  );
}
