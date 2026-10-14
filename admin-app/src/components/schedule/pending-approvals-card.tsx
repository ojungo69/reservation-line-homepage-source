import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronDown, ChevronUp } from "lucide-react";
import { usePendingReservations, useReservationAction } from "@/hooks/use-reservations";
import { api, ApiError } from "@/lib/api-client";
import { runBulkApprove, type BulkApproveResult } from "@/lib/bulk-approve";
import { displayServiceName } from "@/lib/service-pricing";
import {
  endBulkApprove,
  isBulkApproveRunning,
  tryBeginBulkApprove,
} from "@/lib/reservation-action-lock";
import { actionErrorMessage } from "@/lib/error-messages";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
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
import { RejectReasonDialog } from "@/components/schedule/reject-reason-dialog";
import { toJstDate, formatTime, formatDateTime, WEEKDAYS } from "@/lib/timeline";
import type { PendingReservationsResponse } from "@/types/api";

function formatWhen(startAt: string): string {
  const d = toJstDate(startAt);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WEEKDAYS[d.getUTCDay()]}) ${formatTime(startAt)}`;
}

type PendingReservation = PendingReservationsResponse["reservations"][number];

function approvalUnavailableReason(reservation: PendingReservation, now = Date.now()): string {
  // lineFriendStatus は顧客の最新identityの表示値。承認先の予約自身identityと
  // 異なるため、承認可否には使わない。予約自身の友だち状態は承認APIが判定する。
  if (reservation.pendingExpiresAt && Date.parse(reservation.pendingExpiresAt) <= now) {
    return "承認期限が過ぎています。却下をご利用ください。";
  }
  return "";
}

function approvalErrorMessage(error: unknown): string {
  if (error instanceof ApiError && typeof error.body === "object" && error.body !== null &&
    "reason" in error.body && error.body.reason === "invalid_transition") {
    return "承認できません。LINEの友だち状態・承認期限・予約状態を再確認してください。";
  }
  return actionErrorMessage(error);
}

// 一括承認は「確認 → 実行 → 結果」を1つのダイアログで進める。confirming の時点で
// 対象をスナップショット固定し、30秒ポーリングで pending が入れ替わっても対象と
// 結果表示がぶれないようにする (bulkState が非 null の間はカード自体も消えない)。
type BulkState =
  | { phase: "confirming"; items: PendingReservation[] }
  | { phase: "running"; items: PendingReservation[]; done: number }
  | { phase: "result"; items: PendingReservation[]; result: BulkApproveResult }
  | null;

/**
 * ホーム(スケジュール)上部に承認待ち予約を一覧表示し、その場で承認/却下できる
 * ウィジェット。新規予約の承認待ちには専用ナビが無く毎回フィルタが必要だったため、
 * 開いてすぐ対応できる入口を用意する。0件かつ一括承認の途中経過も無いときは
 * 何も描画しない。
 */
export function PendingApprovalsCard({
  selectedStoreId,
  onSelect,
}: Readonly<{
  selectedStoreId: string | null;
  onSelect: (id: string) => void;
}>) {
  const { data, isPending, isError, refetch } = usePendingReservations();
  const action = useReservationAction();
  const queryClient = useQueryClient();
  const [collapsed, setCollapsed] = useState(false);
  // 操作中の予約 id を集合で保持し、その行のボタンだけ無効化する(共有 mutation の
  // isPending では全行が無効化されるため使わない)。ref を同期的な真実とし(連打
  // レース防止)、描画用に state へミラーする。
  const operatingRef = useRef<Set<string>>(new Set());
  const [operatingIds, setOperatingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [approvalFailures, setApprovalFailures] = useState<ReadonlyMap<string, { reservation: PendingReservation; message: string }>>(() => new Map());
  const [rejectTarget, setRejectTarget] = useState<PendingReservation | null>(null);
  const [approveTarget, setApproveTarget] = useState<PendingReservation | null>(null);
  const [bulkState, setBulkState] = useState<BulkState>(null);
  const [deadlineTick, setDeadlineTick] = useState(0);
  const latestData = useRef(data);

  const pending = useMemo<PendingReservation[]>(() => {
    const list = data?.ok ? data.reservations : [];
    const scoped = selectedStoreId ? list.filter((r) => r.storeId === selectedStoreId) : list;
    return [...scoped].sort((a, b) => {
      const aDeadline = a.pendingExpiresAt ? Date.parse(a.pendingExpiresAt) : Infinity;
      const bDeadline = b.pendingExpiresAt ? Date.parse(b.pendingExpiresAt) : Infinity;
      if (aDeadline !== bDeadline) return aDeadline - bDeadline;
      const aCreated = a.createdAt ? Date.parse(a.createdAt) : -Infinity;
      const bCreated = b.createdAt ? Date.parse(b.createdAt) : -Infinity;
      if (aCreated !== bCreated) return aCreated - bCreated;
      return Date.parse(a.startAt) - Date.parse(b.startAt) || a.id.localeCompare(b.id);
    });
  }, [data, selectedStoreId]);

  // 30秒ポーリングを待つと、確認を開いたまま期限を過ぎても承認が有効に見える。
  // 次の期限だけで再描画し、送信入口でも現在時刻を確認する。サーバーが最終判定する。
  useEffect(() => {
    latestData.current = data;
    const now = Date.now();
    const rows = data?.ok ? data.reservations : [];
    const snapshots = [
      ...(approveTarget ? [approveTarget] : []),
      ...(bulkState?.phase === "confirming" ? bulkState.items : []),
    ];
    const nextDeadline = Math.min(...[
      ...rows,
      ...snapshots.map((snapshot) => rows.find((r) => r.id === snapshot.id) ?? snapshot),
    ]
      .map((r) => r.pendingExpiresAt ? Date.parse(r.pendingExpiresAt) : Infinity)
      .filter((deadline) => Number.isFinite(deadline) && deadline > now));
    if (!Number.isFinite(nextDeadline)) return;
    const timer = window.setTimeout(() => setDeadlineTick((value) => value + 1), Math.min(nextDeadline - now, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [data, deadlineTick, approveTarget, bulkState]);

  if (pending.length === 0 && bulkState === null && approveTarget === null && approvalFailures.size === 0 && !isPending && !isError) return null;

  const bulkBusy = bulkState !== null && bulkState.phase === "running";
  const readUnavailable = isError || isPending;
  const readStatus = readUnavailable ? "承認待ち一覧を確認できないため、再取得が完了するまで操作できません。" : "";
  const now = Date.now();
  const eligible = pending.filter((r) => !approvalUnavailableReason(r, now));
  const currentApprovalReason = (snapshot: PendingReservation, currentData = data, checkedAt = Date.now()): string => {
    const current = currentData?.ok ? currentData.reservations.find((r) => r.id === snapshot.id) : undefined;
    // 一覧は最大200件。欠落だけでは処理済みと判断できないので、確認済みの期限に
    // 戻して判定する。予約状態・予約自身のLINE状態は承認APIが最終確認する。
    return approvalUnavailableReason(current ?? snapshot, checkedAt);
  };
  // 確認した一覧の予約だけを、最新の期限で対象／対象外へ振り分ける。
  const confirmingItems: PendingReservation[] = [];
  const confirmingExcluded: Array<{ reservation: PendingReservation; reason: string }> = [];
  if (bulkState?.phase === "confirming") {
    for (const reservation of bulkState.items) {
      const reason = currentApprovalReason(reservation, data, now);
      if (reason) confirmingExcluded.push({ reservation, reason });
      else confirmingItems.push(reservation);
    }
  }
  const approveReason = approveTarget ? currentApprovalReason(approveTarget, data, now) : "";

  const run = (target: PendingReservation, act: "approve" | "reject", reason?: string) => {
    const id = target.id;
    // 一括承認の実行中は単件操作を開始しない(同一予約への approve/reject 並行送信を
    // 防ぐ。useReservationAction 内の共有ガードに加えて、描画側の disabled より先に
    // 同期判定してエラートーストの手前で静かに弾く)。
    if (readUnavailable || isBulkApproveRunning()) return;
    if (act === "approve" && currentApprovalReason(target)) return;
    // 同一予約が既に処理中なら二重送信しない(ref で同期判定し連打レースを防ぐ)。
    if (operatingRef.current.has(id)) return;
    operatingRef.current.add(id);
    setOperatingIds(new Set(operatingRef.current));
    setApprovalFailures((previous) => {
      if (!previous.has(id)) return previous;
      const next = new Map(previous);
      next.delete(id);
      return next;
    });
    // cleanup は呼び出しごとの Promise に直接ぶら下げる。共有 useMutation の per-call
    // onSettled は並行 mutate 時に最後の呼び出し分しか発火しない(MutationObserver が
    // 前の observer を外す)ため、先行行の解除が漏れる。mutateAsync().finally で確実に
    // 対象 id だけ解除する。エラー表示は hook の onError(showErrorToast)が担う。
    void action
      .mutateAsync({ reservationId: id, action: act, reason })
      .catch((error: unknown) => {
        // 一覧の欠落は処理済みを意味しない。確認済みの予約と案内を結果に保持し、
        // 再試行または明示的に閉じるまで消さない（単件の並行送信はそのまま許可）。
        if (act === "approve") {
          setApprovalFailures((previous) => new Map(previous).set(id, { reservation: target, message: approvalErrorMessage(error) }));
        }
      })
      .finally(() => {
        operatingRef.current.delete(id);
        setOperatingIds(new Set(operatingRef.current));
      });
  };

  const runBulk = async () => {
    if (readUnavailable || bulkState?.phase !== "confirming") return;
    const items = bulkState.items.filter((r) => !currentApprovalReason(r));
    if (items.length === 0) return;
    // 同一マウント内で mutateAsync 直後・mutationFn 実行前の単件は module 側の
    // in-flight 集合にまだ載らないため、operatingRef で先に同期判定する。
    if (operatingRef.current.size > 0) return;
    // アンマウントを跨いで生き残る単件 POST と一括の二重起動は
    // tryBeginBulkApprove が module スコープで原子的に確認・取得する。取得できない
    // のは別画面の操作が通信中の稀なケースで、無反応に見せず理由を伝える。
    if (!tryBeginBulkApprove()) {
      toast.error("他の操作を実行中です。完了を待ってから再度お試しください");
      return;
    }
    // module スコープの mutex なので、途中で例外が起きても必ず解放する (解放漏れは
    // セッション中の一括承認を永久に殺す)。
    try {
      setBulkState({ phase: "running", items, done: 0 });
      const snapshotOf = new Map(items.map((r) => [r.id, r]));
      setApprovalFailures((previous) => {
        const next = new Map([...previous].filter(([id]) => !snapshotOf.has(id)));
        return next.size === previous.size ? previous : next;
      });
      const result = await runBulkApprove(
        items.map((r) => r.id),
        (id) => {
          // 直列送信の待機中にも期限や承認待ち一覧が変わりうる。既知の承認不可は
          // POSTせず失敗一覧に出し、以後の予約は引き続き処理する。
          const snapshot = snapshotOf.get(id);
          if (snapshot && currentApprovalReason(snapshot, latestData.current)) {
            throw new ApiError(409, { reason: "invalid_transition" });
          }
          return api.post(`/api/admin/reservations/${id}/approve`, {
            idempotencyKey: crypto.randomUUID(),
            reason: "",
            // 確認スナップショット時点の version。以後に別管理者が変更していたら
            // バックエンドが stale_snapshot (409) で拒否し、失敗一覧に出る。
            expectedVersion: snapshot?.version,
          });
        },
        approvalErrorMessage,
        (done) => setBulkState({ phase: "running", items, done }),
      );
      // invalidate は全件 settle 後にこの1箇所だけで行う (件ごとの invalidate は
      // ポーリングと合わさり refetch が暴発するため useReservationAction を使わない)。
      // refetch 完了を待ってから結果表示 = 排他解除する。待たないと、結果を即閉じた
      // 直後に古い pending 一覧から同じ予約を再度一括承認できてしまう。
      await queryClient.invalidateQueries({ queryKey: ["reservations"] }).catch(() => {});
      setBulkState({ phase: "result", items, result });
    } finally {
      endBulkApprove();
    }
  };

  const customerNameOf = (id: string): string =>
    bulkState?.items.find((r) => r.id === id)?.customerDisplayName ?? id;

  return (
    <section aria-label="承認待ちの予約" className="border-b bg-amber-50/40 px-3 py-2 dark:bg-amber-950/20">
      {/* flex-wrap: 390px で一括承認ボタン+リンクが非折返しのまま溢れて
          #main-content が横スクロールになるのを防ぐ (codex P2)。 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="flex min-h-11 items-center gap-2 text-sm font-semibold text-amber-900 dark:text-amber-100"
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
          承認待ちの予約
          {!isPending && !isError && <Badge variant="secondary" className="bg-amber-200 text-amber-900 dark:bg-amber-800 dark:text-amber-50">
            {pending.length}
          </Badge>}
        </button>
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
          {pending.length > 1 && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setBulkState({ phase: "confirming", items: pending });
              }}
              disabled={readUnavailable || bulkState !== null || operatingIds.size > 0 || eligible.length === 0}
            >
              表示中の{eligible.length}件をまとめて承認
            </Button>
          )}
          <Link to="/reservations" className="inline-flex min-h-11 shrink-0 items-center whitespace-nowrap text-xs text-muted-foreground underline-offset-2 hover:underline">
            予約管理で全件表示
          </Link>
        </div>
      </div>

      {isPending && <output className="block text-sm">承認待ちを読み込み中…</output>}
      {isError && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 text-sm text-destructive">
          <span>承認待ちの{data ? "更新" : "読み込み"}に失敗しました。{data ? "前回取得した一覧を表示しています。" : "件数を確認できません。"}</span>
          <Button variant="outline" size="sm" onClick={() => void refetch()}>承認待ちを再読み込み</Button>
        </div>
      )}

      {!collapsed && (
        <ul className="mt-2 max-h-64 space-y-1.5 overflow-auto">
          {pending.map((r) => {
            const busy = readUnavailable || operatingIds.has(r.id) || bulkBusy;
            const approvalReason = approvalUnavailableReason(r, now);
            const reasonId = approvalReason ? `approve-disabled-${r.id}` : undefined;
            return (
              <li key={r.id}>
                <Card className="flex flex-wrap items-center gap-x-3 gap-y-1.5 p-2">
                  <button
                    type="button"
                    onClick={() => onSelect(r.id)}
                    className="min-h-11 min-w-0 flex-1 text-left"
                  >
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <span className="tabular-nums">{formatWhen(r.startAt)}</span>
                      <span className="truncate">{r.customerDisplayName}</span>
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {displayServiceName(r.serviceNames)}
                      {!selectedStoreId && <span className="ml-1">· {r.storeName}</span>}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      受付: {formatDateTime(r.createdAt ?? null)} · 承認期限: {r.pendingExpiresAt === null ? "期限なし" : formatDateTime(r.pendingExpiresAt ?? null)}
                    </div>
                  </button>
                  {/* 全予約承認制: staff も自店舗の承認/却下を担う (backend が store scope を強制) */}
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                      size="sm"
                      onClick={() => setApproveTarget(r)}
                      disabled={busy || !!approvalReason}
                      aria-describedby={reasonId}
                    >
                      {operatingIds.has(r.id) ? "処理中…" : "承認"}
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => setRejectTarget(r)}
                      disabled={busy}
                    >
                      却下
                    </Button>
                  </div>
                  {approvalReason && <p id={reasonId} className="w-full text-xs text-muted-foreground">{approvalReason}</p>}
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {approvalFailures.size > 0 && (
        <ul aria-label="承認できなかった予約" className="mt-2 space-y-1.5">
          {[...approvalFailures].map(([id, { reservation: r, message }]) => (
            <li key={id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <div>
                <p>{formatWhen(r.startAt)} {r.customerDisplayName} 様 · {r.storeName}</p>
                <p role="alert" className="text-xs text-destructive">{message}</p>
              </div>
              <Button size="sm" variant="outline" aria-label={`${r.customerDisplayName}様の承認エラーを閉じる`} onClick={() => setApprovalFailures((previous) => {
                const next = new Map(previous);
                next.delete(id);
                return next;
              })}>閉じる</Button>
            </li>
          ))}
        </ul>
      )}

      <AlertDialog
        open={approveTarget !== null}
        onOpenChange={(open) => {
          if (!open) setApproveTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>予約を承認しますか?</AlertDialogTitle>
            <AlertDialogDescription aria-live="polite">
              {approveTarget
                ? `${formatWhen(approveTarget.startAt)} ${approveTarget.customerDisplayName} 様の予約を承認して確定します。顧客に通知されます。`
                : ""}
              {readStatus}
              {approveReason && <span className="block">{approveReason}</span>}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              disabled={readUnavailable || !!approveReason}
              onClick={(e) => {
                e.preventDefault();
                if (!approveTarget || readUnavailable) return;
                const target = approveTarget;
                setApproveTarget(null);
                run(target, "approve");
              }}
            >
              承認する
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <RejectReasonDialog
        open={rejectTarget !== null}
        description={
          rejectTarget
            ? `${formatWhen(rejectTarget.startAt)} ${rejectTarget.customerDisplayName} 様の予約を却下します。顧客に通知されます。${readStatus}`
            : ""
        }
        confirmDisabled={readUnavailable}
        onOpenChange={(open) => {
          if (!open) setRejectTarget(null);
        }}
        onConfirm={(reason) => {
          if (!rejectTarget || readUnavailable) return;
          const target = rejectTarget;
          // ダイアログを閉じてから却下を実行する。二重送信は run() 入口の
          // operatingRef ガードが防ぐ。
          setRejectTarget(null);
          run(target, "reject", reason || undefined);
        }}
      />

      <AlertDialog
        open={bulkState !== null}
        onOpenChange={(open) => {
          // 実行中は閉じさせない。結果/確認は閉じる = state 破棄のみ (invalidate しない)。
          if (!open && bulkState?.phase !== "running") setBulkState(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {bulkState?.phase === "result" ? "一括承認の結果" : "まとめて承認しますか?"}
            </AlertDialogTitle>
            {/* 実行中の進捗と結果は動的に差し替わるため、live region としてスクリーン
                リーダーに通知する (modal が背景操作を遮断している間の唯一の手掛かり)。 */}
            <AlertDialogDescription aria-live="polite">
              {bulkState?.phase === "confirming" &&
                `表示中の承認待ち ${confirmingItems.length} 件をすべて承認して確定します。顧客に通知されます。${readStatus}`}
              {bulkState?.phase === "running" &&
                `処理中… (${bulkState.done}/${bulkState.items.length} 件完了)`}
              {bulkState?.phase === "result" &&
                `成功 ${bulkState.result.succeeded.length} 件 / 失敗 ${bulkState.result.failed.length} 件`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {/* 何を承認するのか件数だけでは判断できないため、確認段階で対象を列挙する。 */}
          {bulkState?.phase === "confirming" && (
            <ul aria-label="承認対象" className="max-h-40 space-y-1 overflow-auto text-sm">
              {confirmingItems.map((r) => (
                <li key={r.id}>
                  <span className="tabular-nums">{formatWhen(r.startAt)}</span>{" "}
                  <span className="font-medium">{r.customerDisplayName} 様</span>
                  <div className="truncate text-xs text-muted-foreground">
                    {displayServiceName(r.serviceNames)}
                    {!selectedStoreId && <span className="ml-1">· {r.storeName}</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {bulkState?.phase === "confirming" && confirmingExcluded.length > 0 && (
            <div className="space-y-1 text-sm">
              <p>次の予約は承認対象外です。</p>
              <ul aria-label="承認対象外" className="max-h-40 space-y-1 overflow-auto">
                {confirmingExcluded.map(({ reservation: r, reason }) => (
                  <li key={r.id}>
                    <span>{r.customerDisplayName} 様</span>
                    <p className="text-xs text-muted-foreground">{reason}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {bulkState?.phase === "result" && bulkState.result.failed.length > 0 && (
            <ul className="max-h-40 space-y-1 overflow-auto text-sm">
              {bulkState.result.failed.map((f) => (
                <li key={f.id}>
                  <span className="font-medium">{customerNameOf(f.id)} 様</span>
                  <span className="text-muted-foreground">: {f.message}</span>
                </li>
              ))}
            </ul>
          )}
          <AlertDialogFooter>
            {bulkState?.phase === "confirming" && (
              <>
                <AlertDialogCancel>キャンセル</AlertDialogCancel>
                <AlertDialogAction
                  disabled={readUnavailable || confirmingItems.length === 0}
                  onClick={(e) => {
                    e.preventDefault();
                    void runBulk();
                  }}
                >
                  {confirmingItems.length} 件を承認する
                </AlertDialogAction>
              </>
            )}
            {bulkState?.phase === "running" && (
              <Button disabled variant="outline">
                処理中…
              </Button>
            )}
            {bulkState?.phase === "result" && (
              <AlertDialogAction onClick={() => setBulkState(null)}>閉じる</AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
