import { useRef, useState, useMemo } from "react";
import { Field } from "@/components/ui/field";
import {
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { PendingDialog } from "@/components/ui/pending-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { badgeVariants } from "@/components/ui/badge-variants";
import { useRescheduleReservation, useAvailableSlots } from "@/hooks/use-reservations";
import { formatJstDate, formatTime, formatDateDisplay } from "@/lib/timeline";
import { resolveRescheduleKey, type RescheduleKeyState } from "@/lib/reschedule-idempotency";
import { cn } from "@/lib/utils";
import type { AvailableSlot } from "@/types/api";

export type RescheduleTarget = {
  id: string;
  storeId: string;
  resourceId: string;
  resourceName: string;
  startAt: string;
  endAt: string;
};

type Props = {
  reservation: RescheduleTarget | null;
  onClose: () => void;
};

export function ReservationRescheduleDialog({ reservation, onClose }: Readonly<Props>) {
  // mutation は Dialog 側で持つ。送信中は Escape・外側クリック・×による dismiss を止めて、
  // in-flight のまま form が unmount されて idempotency キーを失うのを防ぐ。
  const { mutate: reschedule, isPending } = useRescheduleReservation();
  // idempotency キー状態は「開閉をまたいで生き残る」このダイアログ本体で保持する。form 側に
  // 置くと、応答喪失（サーバは成功・クライアントは失敗扱い）後にダイアログを閉じるとキーを失い、
  // 開き直して同じ時刻を再送したときに新キーで重複した副作用（顧客通知）が起きうる。
  // 予約IDごとに保持することで、別予約を挟んで送信しても各予約の未確定キーが上書きされない。
  const keyStatesRef = useRef<Map<string, RescheduleKeyState>>(new Map());
  return (
    <PendingDialog
      open={reservation !== null}
      pending={isPending}
      onClose={onClose}
    >
      {reservation && (
        // reservation が変わるたびに form を作り直すため key を付けてマウントし直す。
        <RescheduleForm
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

// 空き枠フィールドの表示分岐（取得中/取得失敗/日付未選択/0件/一覧）をネスト三項演算子から関数化。
function renderRescheduleSlotsField({
  fetching,
  failed,
  date,
  slots,
  time,
  onSelectTime,
}: {
  fetching: boolean;
  failed: boolean;
  date: string;
  slots: AvailableSlot[];
  time: string;
  onSelectTime: (time: string) => void;
}) {
  if (fetching) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-3/4" />
      </div>
    );
  }
  if (failed) {
    return (
      <p className="text-sm text-destructive" role="alert">
        空き枠を取得できませんでした。時間を直接入力してください。
      </p>
    );
  }
  if (!date) {
    return <p className="text-sm text-muted-foreground">日付を選択してください</p>;
  }
  if (slots.length === 0) {
    return <p className="text-sm text-muted-foreground">空き枠なし</p>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {slots.map((slot) => {
        const selected = time === formatTime(slot.startAt);
        return (
          <button
            key={slot.startAt}
            type="button"
            className={cn(
              badgeVariants({ variant: selected ? "default" : "outline" }),
              "min-h-11 min-w-11 cursor-pointer justify-center text-xs",
            )}
            onClick={() => onSelectTime(formatTime(slot.startAt))}
          >
            {formatTime(slot.startAt)}
          </button>
        );
      })}
    </div>
  );
}

function RescheduleForm({
  reservation,
  reschedule,
  isPending,
  keyStatesRef,
  onClose,
}: Readonly<{
  reservation: RescheduleTarget;
  reschedule: ReturnType<typeof useRescheduleReservation>["mutate"];
  isPending: boolean;
  keyStatesRef: React.RefObject<Map<string, RescheduleKeyState>>;
  onClose: () => void;
}>) {

  const [date, setDate] = useState(() => formatJstDate(new Date(reservation.startAt)));
  const [time, setTime] = useState(() => formatTime(reservation.startAt));
  const [error, setError] = useState<string | null>(null);

  // reschedule 照会は excludeReservationId だけを渡す。施術時間・担当リソース・顧客は
  // サーバが予約行から導出する（クライアント計算の keep-in-sync 定数を持たない）ため、
  // picker と書込側の判定条件が常に一致する。自予約のロックは除外されるので、現枠に
  // 重なる小移動候補もチップに出る。顧客の他予約と重なる枠は候補から消える。
  const { data: slotsData, isFetching, isError } = useAvailableSlots(
    reservation.storeId,
    date || null,
    { excludeReservationId: reservation.id },
  );
  // 取得失敗（通信/サーバエラー、または API が ok:false）は「空き枠なし」と区別する。
  const slotsFailed = isError || (slotsData !== undefined && !slotsData.ok);

  const slots = useMemo(() => {
    const list = slotsData?.ok ? slotsData.slots : [];
    // 過去時刻の枠は除外する。available-slots は営業時間内の全枠を返すが、backend の
    // reschedule は現在時刻以前の startAt を拒否するため、今日の過ぎた枠を出すと選んでも必ず失敗する。
    // ponytail: render 時評価で数分の陳腐化は許容（backend が最終検証）。
    // 現在の開始時刻ちょうどの枠も除外する。自己ロック除外で available になるが、
    // 選んで送信しても「現在と同じ時刻」エラーで必ず弾かれるため候補に出さない。
    const nowMs = Date.now();
    const currentStartMs = new Date(reservation.startAt).getTime();
    return list.filter(
      (s) =>
        s.resourceId === reservation.resourceId &&
        s.available &&
        new Date(s.startAt).getTime() > nowMs &&
        new Date(s.startAt).getTime() !== currentStartMs,
    );
  }, [slotsData, reservation.resourceId, reservation.startAt]);

  const currentLabel = `${formatDateDisplay(new Date(reservation.startAt))} ${formatTime(reservation.startAt)}–${formatTime(reservation.endAt)}`;

  const handleSubmit = () => {
    setError(null);
    if (!date || !time) {
      setError("日付と時間を入力してください");
      return;
    }
    // <input type="time"> は step 次第で HH:MM:SS を返すことがあるため HH:MM に正規化する
    // （そのまま :00 を足すと ISO が壊れる）。
    const startAt = `${date}T${time.slice(0, 5)}:00+09:00`;
    // 現在と同じ時刻での送信は弾く。バックエンドは同一開始でも遷移を実行し、確定予約なら
    // 「予約時間が変更されました」の顧客通知まで送ってしまう（実際は無変更なのに誤解を招く）。
    if (new Date(startAt).getTime() === new Date(reservation.startAt).getTime()) {
      setError("変更後の時間が現在と同じです。別の時間を選択してください。");
      return;
    }
    const keyState = resolveRescheduleKey(
      keyStatesRef.current.get(reservation.id) ?? null,
      reservation.id,
      startAt,
      () => crypto.randomUUID(),
    );
    keyStatesRef.current.set(reservation.id, keyState);
    reschedule(
      { reservationId: reservation.id, startAt, idempotencyKey: keyState.key },
      {
        onSuccess: () => {
          // 成功が確定したらキーを破棄する。保持し続けると、その予約が後で別経路で移動した後に
          // 同じ startAt へ戻そうとしたとき成功済みキーが再利用され、過去結果が replay されて
          // 実際の変更が行われない。応答喪失は onError 側なのでキーは残り、再送で replay される。
          keyStatesRef.current.delete(reservation.id);
          onClose();
        },
      },
    );
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>予約時間の変更</DialogTitle>
        <DialogDescription>
          担当（{reservation.resourceName}）と施術時間はそのままに、開始時刻を移動します。確定済みの予約はお客様に変更が通知されます。
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        <div className="rounded-md border bg-muted/30 p-3 text-sm">
          <span className="text-muted-foreground">変更前：</span>
          {currentLabel}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Field id="reschedule-date" label="日付">
            <Input
              id="reschedule-date"
              type="date"
              value={date}
              min={formatJstDate(new Date())}
              onChange={(e) => setDate(e.target.value)}
            />
          </Field>
          <Field id="reschedule-time" label="時間">
            <Input
              id="reschedule-time"
              type="time"
              value={time}
              step="300"
              onChange={(e) => setTime(e.target.value)}
            />
          </Field>
        </div>

        <Separator />

        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">空き枠（{reservation.resourceName}）</p>
          {renderRescheduleSlotsField({
            fetching: isFetching,
            failed: slotsFailed,
            date,
            slots,
            time,
            onSelectTime: setTime,
          })}
        </div>

        {error && (
          <p className="text-sm text-destructive" role="alert">{error}</p>
        )}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={isPending}>
          キャンセル
        </Button>
        <Button onClick={handleSubmit} disabled={isPending}>
          {isPending ? "変更中..." : "この時間に変更"}
        </Button>
      </DialogFooter>
    </>
  );
}
