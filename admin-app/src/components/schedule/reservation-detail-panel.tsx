import { ChartConflictNotice } from "@/components/customers/chart-conflict-notice";
import { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
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
import { useReservationDetail, useReservationAction, useUpdateTreatmentNotes, useReservationCancellationFee } from "@/hooks/use-reservations";
import { ReservationRescheduleDialog, type RescheduleTarget } from "./reservation-reschedule-dialog";
import { ReservationDurationDialog, type DurationTarget } from "./reservation-duration-dialog";
import { statusLabel, visitStatusLabel, statusColor, formatTime, formatDateDisplay, formatFullJstDate, isRebookableStatus } from "@/lib/timeline";
import { lineFriendStatusLabel } from "@/lib/line-friend-label";
import { useAuth } from "@/hooks/use-auth";
import { displayServiceName } from "@/lib/service-pricing";
import { reservationOriginLabel, reservationSourceLabel } from "@/lib/reservation-origin";
import type { ReservationAction } from "@/types/api";
import { DetailRow as Row } from "@/components/ui/detail-row";
import { PendingConfirmDialog } from "@/components/ui/pending-confirm-dialog";
import { CustomerGateCard } from "@/components/customers/customer-gate-card";
import { useCustomerDetail } from "@/hooks/use-customers";
import { ApiError } from "@/lib/api-client";

type ReservationDetailPanelProps = {
  reservationId: string | null;
  onClose: () => void;
  onOpenChart?: (customerId: string, reservationId: string) => void;
  suspended?: boolean;
  onRebook?: (info: { customerId?: string | null; customerName: string; customerKana?: string | null; phone?: string | null; serviceIds: string[]; resourceId?: string; storeId?: string }) => void;
};

type ConfirmState = {
  action: ReservationAction;
  label: string;
  description: string;
} | null;

// 全予約承認制: 承認/却下は staff も操作できる (backend が自店舗 scope を強制する)
// ため、これらは role による表示ゲートを持たない。例外は privilegedOnly を立てた
// 完了への復元で、こちらは owner+ 限定 (backend も ownerOnly で 403 を返す)。
const ACTION_CONFIG: Array<{
  action: ReservationAction;
  label: string;
  description: string;
  variant: "default" | "destructive" | "outline";
  fromStatuses: string[];
  privilegedOnly?: boolean;
}> = [
  {
    action: "approve",
    label: "承認",
    description: "この予約を承認して確定しますか？",
    variant: "default",
    fromStatuses: ["pending_approval"],
  },
  {
    action: "reject",
    label: "却下",
    description: "この予約を却下しますか？お客様に通知され、この操作は取り消せません。",
    variant: "destructive",
    fromStatuses: ["pending_approval"],
  },
  {
    action: "complete",
    label: "完了",
    description: "この予約を完了にしますか？",
    variant: "outline",
    fromStatuses: ["confirmed", "checked_in"],
  },
  {
    action: "no-show",
    label: "来店なし",
    description: "この予約を来店なしにしますか？",
    variant: "destructive",
    fromStatuses: ["confirmed", "checked_in"],
  },
  {
    // 承認待ちの予約は「却下」で対応する運用のため、キャンセルは確定後のみ提示する
    // (承認前に取り消したい場合は却下ボタンを使う)。
    action: "cancel",
    label: "キャンセル",
    description: "この予約をキャンセルしますか？取り消しできません。",
    variant: "destructive",
    fromStatuses: ["confirmed", "checked_in"],
  },
  {
    // 終端状態の訂正。fromStatuses が終端そのものなので、通常の操作ボタンとは
    // 排他になる (完了中の予約にだけ「来店なしに訂正」が出る)。
    action: "correct-no-show",
    label: "来店なしに訂正",
    description:
      "この予約を「来店なし」に訂正しますか？来店履歴の1件が無効になり、来店回数と最終来店日から外れます。キャンセル料未納も記録されます。",
    variant: "destructive",
    fromStatuses: ["completed"],
  },
  {
    action: "restore-completed",
    label: "完了に戻す",
    description: "この予約を「完了」に戻しますか？来店履歴の1件が有効に戻り、キャンセル料未納は解除されます。",
    variant: "outline",
    fromStatuses: ["no_show"],
    privilegedOnly: true,
  },
];

// 施術メモの保存ボタン表示文言(保存中/読込中/保存)を決める。
function getNotesSaveLabel(isSavingNotes: boolean, isFetching: boolean, hasVisit: boolean): string {
  if (isSavingNotes) return "保存中...";
  if (isFetching || !hasVisit) return "読込中...";
  return "保存";
}

// キャンセル料未納の記録はスタッフも行える (来店なしを付けるのも現場のスタッフ、
// 回収するのも現場のため)。バックエンドが自店舗の予約だけを許可するので、ここでは
// role ゲートを持たない — 「キャンセル料未納」専用ページのボタンと挙動を揃える。
function CancellationFeeAction({
  unpaidAt,
  status,
  pending,
  onChange,
}: Readonly<{
  unpaidAt: string | null;
  status: string;
  pending: boolean;
  onChange: (unpaid: boolean) => void;
}>) {
  if (unpaidAt) {
    return (
      <Button size="sm" variant="outline" disabled={pending} onClick={() => onChange(false)}>
        {pending ? "処理中..." : "入金済みにする"}
      </Button>
    );
  }
  if (status !== "no_show") return null;
  return (
    <Button size="sm" variant="outline" disabled={pending} onClick={() => onChange(true)}>
      {pending ? "処理中..." : "キャンセル料未納にする"}
    </Button>
  );
}

export function ReservationDetailPanel({
  reservationId,
  onClose,
  onRebook,
  onOpenChart,
  suspended = false,
}: Readonly<ReservationDetailPanelProps>) {
  const reservationQuery = useReservationDetail(reservationId);
  const { data, isPending, isFetching } = reservationQuery;
  const { isPrivileged } = useAuth();
  const { mutate: runAction, isPending: isActioning } = useReservationAction();
  const { mutate: saveNotes, isPending: isSavingNotes } = useUpdateTreatmentNotes();
  const { mutate: updateCancellationFee, isPending: isUpdatingFee } = useReservationCancellationFee();
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [rescheduleTarget, setRescheduleTarget] = useState<RescheduleTarget | null>(null);
  const [durationTarget, setDurationTarget] = useState<DurationTarget | null>(null);
  // 却下のみ任意の理由を添えられる (監査ログに記録し、入力時はお客様への却下通知にも本文として届く)。
  const [rejectReason, setRejectReason] = useState("");
  const [showNotesPrompt, setShowNotesPrompt] = useState(false);
  const [notesText, setNotesText] = useState("");
  const [notesBaseline, setNotesBaseline] = useState<string | null>(null);
  const [notesConflict, setNotesConflict] = useState(false);
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesGateRequired, setNotesGateRequired] = useState(false);
  // 保存済みの施術メモを空にして上書きしようとしたとき。カルテが消える操作なので
  // 一度確認する (新規入力側は空だと保存ボタン自体が無効なので、この確認は要らない)。
  const [clearNotesVisitId, setClearNotesVisitId] = useState<string | null>(null);
  // 下書きを持ったまま Esc / 外側クリック / × でシートを閉じようとしたとき。
  // Radix はこの 3 つを同じ onOpenChange(false) で通知するので、1 箇所で受けられる。
  // ただし「次回予約」は onClose() を直接呼ぶので Radix を通らない。破棄後の行き先が
  // 2 通りになるため、真偽値ではなくどちらへ進むかを持つ。
  const [discardDraftNext, setDiscardDraftNext] = useState<"close" | "rebook" | "chart" | null>(null);
  // 別予約への切替・パネル閉鎖で、予約単位の編集 state をまとめて破棄する。
  // rescheduleTarget は表示ガードだけだと同じ予約に戻ったときにダイアログが再オープンし、
  // メモ・却下理由の下書きや確認ダイアログは残すと切替先の予約へ誤保存・誤操作される。
  useEffect(() => {
    setRescheduleTarget(null);
    setDurationTarget(null);
    setConfirm(null);
    setRejectReason("");
    setShowNotesPrompt(false);
    setNotesText("");
    setEditingNotes(false);
    setNotesGateRequired(false);
    setNotesConflict(false);
    setNotesBaseline(null);
    setClearNotesVisitId(null);
    setDiscardDraftNext(null);
  }, [reservationId]);

  const reservation = data?.ok ? data.reservation : null;
  const checkNotesGate = !isPrivileged && (editingNotes || showNotesPrompt);
  const notesGate = useCustomerDetail(checkNotesGate ? reservation?.customerId ?? null : null);
  const gateDenied = notesGateRequired || [notesGate.error, notesGate.failureReason].some((error) =>
    error instanceof ApiError && error.status === 403 &&
    (error.body as { reason?: string } | null)?.reason === "customer_gate_required"
  );
  const notesBlocked = notesConflict || (checkNotesGate && (gateDenied || notesGate.isFetching || notesGate.isError || !notesGate.data?.ok));
  let notesGateContent = <output className="block text-xs text-muted-foreground">
    {notesGate.isFetching || !notesGate.data?.ok ? "保存に必要な承認を確認しています..." : "オーナーの確認済みです。承認は12時間有効です。"}
  </output>;
  if (gateDenied) {
    notesGateContent = <CustomerGateCard purpose="notes" onVerified={() => {
      setNotesGateRequired(false);
      void notesGate.refetch();
    }} />;
  } else if (notesGate.isError) {
    notesGateContent = <div role="alert" className="space-y-2 text-sm">
      <p>保存に必要な承認を確認できません。下書きを保持したまま再確認できます。</p>
      <Button size="sm" variant="outline" disabled={notesGate.isFetching} onClick={() => { void notesGate.refetch(); }}>承認を再確認</Button>
    </div>;
  }
  const notesGateNotice = checkNotesGate ? <div className="space-y-2">{notesGateContent}</div> : null;
  // 施術メモの編集対象は有効な来店記録だけ。reservation_id は UNIQUE なので
  // 有効な行は高々1件で、無効化された行へ fallback してはいけない
  // (訂正で取り消した来店のメモを編集できてしまう)。
  const latestVisit = reservation?.visits.find((v) => v.status === "valid") ?? null;

  // 「編集画面が開いている」ではなく「保存済みの値と違う」を下書きの条件にする。
  // 編集ボタンを押しただけで閉じられなくなると、確認が邪魔になるだけで何も守れない。
  const hasUnsavedNotes = (editingNotes || showNotesPrompt) && notesText !== (notesBaseline ?? "");

  const closePanel = () => {
    setShowNotesPrompt(false);
    setEditingNotes(false);
    setNotesText("");
    setClearNotesVisitId(null);
    setDiscardDraftNext(null);
    onClose();
  };

  // 「次回予約」の本体。破棄確認を挟むかどうかで呼び出し元が 2 つあるので切り出す。
  const rebookAndClose = () => {
    if (!reservation || !onRebook) return;
    onRebook({
      customerId: reservation.customerId,
      customerName: reservation.customerDisplayName,
      customerKana: reservation.customerDisplayNameKana,
      phone: reservation.phoneNormalized,
      // detail 応答に serviceIds が無い過渡期（旧 backend キャッシュ等）は
      // primary serviceId にフォールバックする。
      serviceIds: reservation.serviceIds?.length
        ? reservation.serviceIds
        : [reservation.serviceId],
      storeId: reservation.storeId,
      resourceId: reservation.resourceId,
    });
    closePanel();
  };

  const handleAction = () => {
    if (!confirm || !reservationId) return;
    // 施術メモの記録を促すのは新規の完了時だけ。訂正 (restore-completed) は
    // 過去の記録を戻す操作なので促さない。
    const isCompleting = confirm.action === "complete";
    // 訂正後はパネルを閉じない。no_show はスケジュール表示から外れるため、
    // 閉じると「同じ画面から戻す」導線が消える。再取得後に fromStatuses が
    // 切り替わる。staff は訂正結果を確認でき、owner+ には復元ボタンも出る。
    const keepOpen = confirm.action === "correct-no-show" || confirm.action === "restore-completed";
    runAction(
      {
        reservationId,
        action: confirm.action,
        reason: confirm.action === "reject" ? rejectReason.trim() || undefined : undefined,
        // 訂正は backend が expectedVersion を必須にしている。
        expectedVersion: keepOpen ? reservation?.version : undefined,
      },
      {
        onSuccess: () => {
          setConfirm(null);
          setRejectReason("");
          if (keepOpen) {
            return;
          }
          if (isCompleting) {
            // 既存メモのインライン編集中に完了すると、共有 notesText を空で
            // 上書きして入力中テキストを失う。編集中はその内容を保持し、
            // インラインエディタだけ閉じてから記録プロンプトを開く。
            if (!editingNotes) { setNotesText(""); setNotesBaseline(latestVisit?.treatmentNotes ?? null); setNotesConflict(false); }
            setEditingNotes(false);
            setShowNotesPrompt(true);
          } else {
            onClose();
          }
        },
      },
    );
  };

  const handleSaveNotes = (visitId: string) => {
    if (!reservation || notesBlocked) return;
    saveNotes(
      {
        customerId: reservation.customerId,
        visitId,
        treatmentNotes: notesText.trim() || null,
        expectedTreatmentNotes: notesBaseline,
      },
      {
        onSuccess: () => {
          setEditingNotes(false);
          setShowNotesPrompt(false);
          // 消去の確認も畳む。PendingConfirmDialog は onConfirm の間 close を止めるので、
          // ここで畳まないと、サーバー側が消し終わったあとも確認が開いたままになり、
          // 同じ削除を何度でも押せる (顧客詳細パネルは既にこうしている)。
          setClearNotesVisitId(null);
        },
        onError: (error) => {
          if (error instanceof ApiError && error.status === 409 &&
            (error.body as { reason?: string } | null)?.reason === "stale_snapshot") {
            setNotesConflict(true);
            setClearNotesVisitId(null);
          }
          if (error instanceof ApiError && error.status === 403 &&
            (error.body as { reason?: string } | null)?.reason === "customer_gate_required") {
            setNotesGateRequired(true);
            setClearNotesVisitId(null);
          }
        },
      },
    );
  };

  const openChart = () => {
    if (reservation && onOpenChart) onOpenChart(reservation.customerId, reservation.id);
  };
  const conflictNotice = notesConflict && <ChartConflictNotice onReload={async () => {
    const result = await reservationQuery.refetch();
    if (result.error || !result.data?.ok) throw new Error("reservation_refresh_failed");
    const visit = result.data.reservation.visits.find((row) => row.id === latestVisit?.id && row.status === "valid");
    if (!visit) throw new Error("visit_missing");
    return visit.treatmentNotes;
  }} onResume={(latest) => { setNotesBaseline(latest); setNotesConflict(false); }} />;

  return (
    <>
      <Sheet
        open={!!reservationId && !suspended}
        onOpenChange={(open) => {
          if (open) return;
          if (hasUnsavedNotes) {
            setDiscardDraftNext("close");
            return;
          }
          closePanel();
        }}
      >
        <SheetContent side="right" className="w-full sm:max-w-md" aria-describedby={undefined}>
          <SheetTitle className="sr-only">予約詳細</SheetTitle>
          {isPending && <DetailSkeleton />}
          {!isPending && !reservation && (
            <p className="p-4 text-sm text-destructive" role="alert">予約情報の取得に失敗しました。時間をおいて再度お試しください。</p>
          )}
          {reservation && (
            <div className="space-y-4 pt-4">
              {/* pr-8: 44px Close (右端 52px 占有) に折返した Badge が潜らないため。 */}
              <div className="flex flex-wrap items-center gap-2 pr-8">
                <Badge className={statusColor(reservation.status)} variant="outline">
                  {statusLabel(reservation.status)}
                </Badge>
                {reservation.cancellationFeeUnpaidAt && (
                  <Badge variant="destructive">キャンセル料未納</Badge>
                )}
                {reservation.duplicateConsent && (
                  <Badge variant={reservation.duplicateConsent.stage === "hard" ? "destructive" : "outline"}>
                    既存予約あり・同意済み
                  </Badge>
                )}
                <span className="text-xs text-muted-foreground">{reservationSourceLabel(reservation.source)}</span>
              </div>

              <div>
                <h3 className="text-lg font-semibold">{reservation.customerDisplayName}</h3>
                {reservation.customerDisplayNameKana && (
                  <p className="text-sm text-muted-foreground">{reservation.customerDisplayNameKana}</p>
                )}
              </div>

              <Separator />

              <Section title="予約情報">
                <Row label="メニュー" value={displayServiceName(reservation.serviceName)} />
                <Row label="リソース" value={reservation.resourceName} />
                <Row label="日時" value={`${formatDateDisplay(new Date(reservation.startAt))} ${formatTime(reservation.startAt)}–${formatTime(reservation.endAt)}`} />
                <Row label="店舗" value={reservation.storeName} />
                {reservationOriginLabel(reservation.reservationOrigin) && (
                  <Row label="予約経路" value={reservationOriginLabel(reservation.reservationOrigin)!} />
                )}
              </Section>

              <Separator />

              <Section title="顧客情報">
                {onOpenChart && <Button variant="outline" className="w-full" onClick={() => {
                  if (hasUnsavedNotes) setDiscardDraftNext("chart"); else openChart();
                }}>カルテを開く</Button>}
                {reservation.phoneNormalized && (
                  <Row label="電話" value={reservation.phoneNormalized} />
                )}
                <Row label="LINE" value={lineFriendStatusLabel(reservation.lineFriendStatus)} />
                {/* 顧客単位メモ（表示専用・編集は顧客タブ）。改行保持のため Row ではなく
                    customer-detail-panel と同じ whitespace-pre-wrap ブロックで出す。
                    空でも見出しごと消さない — 消すと「メモが無い」と「機能が壊れている」を
                    現場が区別できず、実際にバグとして報告された。 */}
                <div className="pt-1">
                  <p className="text-xs text-muted-foreground">顧客メモ</p>
                  <p className="whitespace-pre-wrap text-sm">{reservation.customerMemo || "メモなし"}</p>
                </div>
                {reservation.customerAllergyNotes && (
                  <div className="pt-1">
                    <p className="text-xs text-muted-foreground">アレルギー・注意事項</p>
                    <p className="whitespace-pre-wrap text-sm">{reservation.customerAllergyNotes}</p>
                  </div>
                )}
              </Section>

              {reservation.duplicateConsent && (
                <>
                  <Separator />
                  <Section title="重複予約の同意">
                    <p className="text-sm text-muted-foreground">
                      予約時に他のご予約があることを案内し、お客様が
                      {reservation.duplicateConsent.stage === "hard"
                        ? "「変更・キャンセル不可」の警告"
                        : "警告"}
                      に同意済みです。
                    </p>
                    <Row
                      label="同意日時"
                      value={`${formatDateDisplay(new Date(reservation.duplicateConsent.consentedAt))} ${formatTime(reservation.duplicateConsent.consentedAt)}`}
                    />
                    {reservation.duplicateConsent.existingReservations.length > 0 && (
                      <div className="space-y-1 pt-1">
                        <p className="text-xs text-muted-foreground">当時の他のご予約</p>
                        <ul className="list-disc space-y-0.5 pl-5 text-sm">
                          {reservation.duplicateConsent.existingReservations.map((r) => (
                            <li key={r.reservationId}>
                              {formatDateDisplay(new Date(r.startAt))} {formatTime(r.startAt)}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </Section>
                </>
              )}

              {latestVisit && (
                <>
                  <Separator />
                  <Section title="施術メモ">
                    {editingNotes && notesGateNotice}
                    {editingNotes && conflictNotice}
                    {editingNotes ? (
                      <NotesEditor
                        value={notesText}
                        onChange={setNotesText}
                        saving={isSavingNotes}
                        saveDisabled={isSavingNotes || notesBlocked}
                        saveLabel={isSavingNotes ? "保存中..." : "保存"}
                        onSave={() => {
                          // 保存済みのメモを空で上書きしようとしている場合だけ確認を挟む。
                          if (notesBaseline?.trim() && !notesText.trim()) {
                            setClearNotesVisitId(latestVisit.id);
                            return;
                          }
                          handleSaveNotes(latestVisit.id);
                        }}
                        onCancel={() => setEditingNotes(false)}
                        cancelLabel="キャンセル"
                      />
                    ) : (
                      <div className="space-y-1">
                        <p className="text-sm whitespace-pre-wrap">
                          {latestVisit.treatmentNotes || "メモなし"}
                        </p>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            // 完了後の入力欄と同じ下書きを使い、編集への切替で上書きしない。
                            if (!showNotesPrompt) {
                              setNotesText(latestVisit.treatmentNotes ?? "");
                              setNotesBaseline(latestVisit.treatmentNotes);
                              setNotesConflict(false);
                            }
                            setShowNotesPrompt(false);
                            setEditingNotes(true);
                          }}
                        >
                          編集
                        </Button>
                      </div>
                    )}
                  </Section>
                </>
              )}

              {/* 同じ顧客の直近の施術メモ。上の「施術メモ」はこの予約の来店行だけなので、
                  未完了の予約を開くと1件も出ない — 施術前に前回のカルテを読みたい場面が
                  まさにそれなので、過去ぶんは別セクションで出す（表示専用）。
                  0件のときは顧客メモと違ってセクションごと出さない: 顧客メモは常に1つある
                  はずの欄なので空でも見出しを残すが、こちらは「まだ来ていない顧客」で
                  空なのが普通で、毎回「なし」を出すと読む場所が増えるだけになる。 */}
              {reservation.customerPastNotes?.length ? (
                <>
                  <Separator />
                  <Section title="過去の施術メモ">
                    {/* 1件ぶんは日付と本文を密に、件と件のあいだは広く。メモは複数行に
                        なるので、間隔が同じだと前の回の末尾と次の回の日付が地続きに
                        見えて、どこで区切れるのか読み取れなくなる。 */}
                    <div className="space-y-3">
                      {reservation.customerPastNotes.map((note, index) => (
                        <div key={`${note.visitedAt}-${index}`} className="space-y-0.5">
                          {/* 年入りの表記。何年も前のカルテが並びうるので、年が無いと
                              去年の同じ日と見分けが付かない。 */}
                          <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                            {formatFullJstDate(new Date(note.visitedAt))}
                            {/* 他店舗で受けた施術のときだけ店舗名を出す。owner 以上には全店舗
                                ぶんが並ぶので、どこで受けたか分からないと別店舗の内容を
                                自店舗の履歴として読んでしまう。同じ店舗のぶんに毎回名前を
                                付けると、ほとんどの行が同じ文字で埋まって差が見えなくなる。 */}
                            {note.storeId && note.storeId !== reservation.storeId ? (
                              <Badge variant="outline" className="font-normal">
                                {note.storeName}
                              </Badge>
                            ) : null}
                          </p>
                          <p className="whitespace-pre-wrap text-sm">{note.treatmentNotes}</p>
                        </div>
                      ))}
                    </div>
                    {/* 実際に打ち切られたときだけ出す。件数では判定しない — ちょうど3件しか
                        無い顧客にも出てしまい、無い過去を見に行かせることになる。判定は
                        worker が4件目の有無で行い、この項目で伝えてくる。 */}
                    {reservation.customerPastNotesTruncated ? (
                      <p className="text-xs text-muted-foreground">
                        これより前のぶんは顧客タブの来店履歴でご確認いただけます。
                      </p>
                    ) : null}
                  </Section>
                </>
              ) : null}

              {reservation.visits.length > 0 && (
                <>
                  <Separator />
                  <Section title="来店履歴">
                    {reservation.visits.slice(0, 5).map((v) => (
                      <div key={v.id} className="flex justify-between text-sm">
                        <span>{formatDateDisplay(new Date(v.visitedAt))}</span>
                        <span className="text-muted-foreground">{visitStatusLabel(v.status)}</span>
                      </div>
                    ))}
                  </Section>
                </>
              )}

              <Separator />

              <div className="flex flex-wrap gap-2">
                {ACTION_CONFIG.filter(
                  (cfg) =>
                    cfg.fromStatuses.includes(reservation.status) &&
                    (!cfg.privilegedOnly || isPrivileged),
                ).map((cfg) => (
                  <Button
                    key={cfg.action}
                    variant={cfg.variant}
                    size="sm"
                    disabled={isActioning}
                    onClick={() => setConfirm(cfg)}
                  >
                    {cfg.label}
                  </Button>
                ))}
                {(reservation.status === "pending_approval" || reservation.status === "confirmed") && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isActioning}
                    onClick={() =>
                      setRescheduleTarget({
                        id: reservation.id,
                        storeId: reservation.storeId,
                        resourceId: reservation.resourceId,
                        resourceName: reservation.resourceName,
                        startAt: reservation.startAt,
                        endAt: reservation.endAt,
                      })
                    }
                  >
                    時間変更
                  </Button>
                )}
                {(reservation.status === "pending_approval" || reservation.status === "confirmed") && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isActioning}
                    onClick={() =>
                      setDurationTarget({
                        id: reservation.id,
                        startAt: reservation.startAt,
                        endAt: reservation.endAt,
                        resourceName: reservation.resourceName,
                      })
                    }
                  >
                    施術時間変更
                  </Button>
                )}
                {onRebook && isRebookableStatus(reservation.status) && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      // 閉じる経路と同じ確認を挟む。ここを素通りさせると、書きかけの
                      // 施術メモが reservationId の切り替えで無確認に消える。
                      if (hasUnsavedNotes) {
                        setDiscardDraftNext("rebook");
                        return;
                      }
                      rebookAndClose();
                    }}
                  >
                    次回予約
                  </Button>
                )}
              </div>

              <CancellationFeeAction
                unpaidAt={reservation.cancellationFeeUnpaidAt}
                status={reservation.status}
                pending={isUpdatingFee}
                onChange={(unpaid) => updateCancellationFee({ reservationId: reservation.id, unpaid })}
              />

              {showNotesPrompt && (
                <>
                  <Separator />
                  <Section title="施術メモを記録">
                    {notesGateNotice}
                    {conflictNotice}
                    <NotesEditor
                      value={notesText}
                      onChange={setNotesText}
                      saving={isSavingNotes}
                      saveDisabled={isSavingNotes || notesBlocked || !notesText.trim() || !latestVisit || isFetching}
                      saveLabel={getNotesSaveLabel(isSavingNotes, isFetching, !!latestVisit)}
                      onSave={() => {
                        const visit = latestVisit;
                        if (visit) handleSaveNotes(visit.id);
                      }}
                      onCancel={closePanel}
                      cancelLabel="スキップ"
                      autoFocus
                    />
                  </Section>
                </>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog open={!!confirm && !suspended} onOpenChange={(open) => {
        if (!open && isActioning) return;
        if (!open) {
          setConfirm(null);
          setRejectReason("");
        }
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.label}</AlertDialogTitle>
            <AlertDialogDescription>{confirm?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          {confirm?.action === "reject" && (
            <div className="space-y-1.5">
              <Label htmlFor="detail-reject-reason">却下理由（任意・お客様に通知されます）</Label>
              <Textarea
                id="detail-reject-reason"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                maxLength={500}
                rows={3}
                placeholder="例: 同時間帯に別のご予約が重なったため"
                disabled={isActioning}
              />
              <p className="text-xs text-muted-foreground">
                入力した理由は操作記録に保存され、お客様への却下通知にもそのまま届きます。社内メモは書かないでください。
              </p>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isActioning}>キャンセル</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); handleAction(); }} disabled={isActioning}>
              {isActioning ? "処理中..." : "実行"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <PendingConfirmDialog
        open={!!clearNotesVisitId && !suspended}
        pending={isSavingNotes}
        title="施術メモを消しますか？"
        description="この予約に記録されている施術メモが消えます。この操作は取り消せません。"
        confirmLabel="消して保存"
        pendingLabel="保存中..."
        cancelLabel="やめる"
        destructive
        onOpenChange={() => setClearNotesVisitId(null)}
        onConfirm={() => { if (clearNotesVisitId) handleSaveNotes(clearNotesVisitId); }}
      />

      <PendingConfirmDialog
        open={discardDraftNext !== null && !suspended}
        pending={false}
        title="書きかけの施術メモがあります"
        description="保存していない内容は失われます。閉じてよろしいですか？"
        confirmLabel="破棄して閉じる"
        cancelLabel="編集に戻る"
        destructive
        onOpenChange={() => setDiscardDraftNext(null)}
        onConfirm={{ rebook: rebookAndClose, chart: openChart, close: closePanel }[discardDraftNext ?? "close"]}
      />

      {/* パネル(Sheet)は常時マウントで reservationId 切替のみ。時間変更ダイアログを詳細パネルの
          対象に同期させ、別予約へ切替・パネルを閉じた後に前回対象で開いたままにならないようにする。 */}
      <ReservationRescheduleDialog
        reservation={!suspended && rescheduleTarget?.id === reservationId ? rescheduleTarget : null}
        onClose={() => setRescheduleTarget(null)}
      />
      <ReservationDurationDialog
        reservation={!suspended && durationTarget?.id === reservationId ? durationTarget : null}
        onClose={() => setDurationTarget(null)}
      />
    </>
  );
}

function Section({ title, children }: Readonly<{ title: string; children: React.ReactNode }>) {
  return (
    <div className="space-y-1">
      <h4 className="text-sm font-medium text-muted-foreground">{title}</h4>
      {children}
    </div>
  );
}

function NotesEditor({
  value,
  onChange,
  saving,
  saveDisabled,
  saveLabel,
  onSave,
  onCancel,
  cancelLabel,
  autoFocus,
}: Readonly<{
  value: string;
  onChange: (v: string) => void;
  saving: boolean;
  saveDisabled: boolean;
  saveLabel: string;
  onSave: () => void;
  onCancel: () => void;
  cancelLabel: string;
  autoFocus?: boolean;
}>) {
  return (
    <div className="space-y-2">
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={2000}
        rows={4}
        placeholder="施術内容やメモを入力..."
        aria-label="施術メモ"
        autoFocus={autoFocus}
      />
      <p className="text-xs text-muted-foreground text-right">{value.length}/2000</p>
      <div className="flex gap-2">
        <Button size="sm" disabled={saveDisabled} onClick={onSave}>
          {saveLabel}
        </Button>
        <Button size="sm" variant="outline" disabled={saving} onClick={onCancel}>
          {cancelLabel}
        </Button>
      </div>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-4 pt-4">
      <Skeleton className="h-6 w-20" />
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-px w-full" />
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-5 w-full" />
        ))}
      </div>
    </div>
  );
}
