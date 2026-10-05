import { useRef, useState, useMemo } from "react";
import { CheckCircle2, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useSettings } from "@/hooks/use-settings";
import { buildGoogleSyncViewModel } from "@/lib/google-sync-view-model";
import {
  useSyncStatus,
  useSyncJobRetry,
  useSyncJobAcknowledge,
  useGoogleEditMode,
} from "@/hooks/use-sync-status";
import { StatusCard } from "@/components/google-sync/status-card";
import { RecoveryTasks } from "@/components/google-sync/recovery-tasks";
import { ConflictList } from "@/components/google-sync/conflict-list";
import type {
  SyncDlqJob,
  SyncChannel,
  SyncStatusSystemAdmin,
  Store,
} from "@/types/api";
import { formatDateTime } from "@/lib/timeline";

const SOURCE_LABELS: Record<string, string> = {
  google_calendar_import_jobs: "Googleインポート",
  calendar_sync_jobs: "カレンダー同期",
  notification_jobs: "通知",
};

const NOTIFICATION_LABELS: Record<string, string> = {
  reservation_pending_received: "予約受付",
  reservation_confirmed: "予約確定",
  reservation_rejected: "予約見送り",
  reservation_time_changed: "予約時間変更",
  reservation_cancelled_by_admin: "店舗によるキャンセル",
  reservation_reminder: "来店前のご案内",
  reservation_new_customer: "新規のお客様の予約申込",
  pending_approval_created: "予約の承認待ち",
  daily_ops_summary: "営業日報",
  google_drift_alert: "Googleカレンダーの同期ずれ",
  google_conflict_burst_alert: "Googleカレンダーの競合増加",
};

const isAcknowledgeableJob = (job: SyncDlqJob) =>
  (job.source === "google_calendar_import_jobs" && job.status === "dead") ||
  (job.source === "notification_jobs" && (job.status === "dead" || job.status === "failed"));

const isNotificationRetryBlocked = (job: SyncDlqJob) =>
  job.source === "notification_jobs" &&
  job.lastError === "line-monthly-quota-exhausted";

const defaultAcknowledgeNote = (job: SyncDlqJob) => {
  if (job.source === "notification_jobs") return "";
  const reason = job.reason ? ` / ${job.reason}` : "";
  return `${SOURCE_LABELS[job.source] ?? job.source}${reason} は最新の同期状態で不要と判断。`;
};

function DlqTable({ jobs }: Readonly<{ jobs: SyncDlqJob[] }>) {
  const retryMutation = useSyncJobRetry();
  const acknowledgeMutation = useSyncJobAcknowledge();
  const retryKeysRef = useRef<Record<string, string>>({});
  const acknowledgeKeysRef = useRef<Record<string, string>>({});
  const actionPending = retryMutation.isPending || acknowledgeMutation.isPending;
  const [acknowledgeDraft, setAcknowledgeDraft] = useState<{
    job: SyncDlqJob;
    note: string;
  } | null>(null);

  if (jobs.length === 0) {
    return <p className="text-sm text-muted-foreground">注意が必要なジョブはありません。</p>;
  }

  const getRetryKey = (jobId: string) => {
    if (!retryKeysRef.current[jobId]) {
      const key = crypto.randomUUID();
      retryKeysRef.current = { ...retryKeysRef.current, [jobId]: key };
      return key;
    }
    return retryKeysRef.current[jobId];
  };

  const getAcknowledgeKey = (jobId: string) => {
    if (!acknowledgeKeysRef.current[jobId]) {
      const key = crypto.randomUUID();
      acknowledgeKeysRef.current = { ...acknowledgeKeysRef.current, [jobId]: key };
      return key;
    }
    return acknowledgeKeysRef.current[jobId];
  };

  const handleRetry = (job: SyncDlqJob) => {
    retryMutation.mutate(
      { jobId: job.id, source: job.source, idempotencyKey: getRetryKey(job.id) },
      {
        onSuccess: () => {
          const next = { ...retryKeysRef.current };
          delete next[job.id];
          retryKeysRef.current = next;
        },
      },
    );
  };

  const openAcknowledgeDialog = (job: SyncDlqJob) => {
    setAcknowledgeDraft({
      job,
      note: defaultAcknowledgeNote(job),
    });
  };

  const handleAcknowledge = () => {
    if (!acknowledgeDraft) return;
    const note = acknowledgeDraft.note.trim();
    if (!note) return;
    const { job } = acknowledgeDraft;
    acknowledgeMutation.mutate(
      {
        jobId: job.id,
        source: job.source,
        idempotencyKey: getAcknowledgeKey(job.id),
        note,
      },
      {
        onSuccess: () => {
          const next = { ...acknowledgeKeysRef.current };
          delete next[job.id];
          acknowledgeKeysRef.current = next;
          setAcknowledgeDraft(null);
        },
      },
    );
  };

  const acknowledgeNote = acknowledgeDraft?.note.trim() ?? "";
  const canSubmitAcknowledge = acknowledgeNote.length > 0 && acknowledgeNote.length <= 500;

  return (
    <>
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ソース</TableHead>
              <TableHead>ステータス</TableHead>
              <TableHead>試行回数</TableHead>
              <TableHead>最終エラー</TableHead>
              <TableHead>更新日時</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.map((job) => (
              <TableRow key={job.id}>
                <TableCell>
                  <Badge variant="outline">{SOURCE_LABELS[job.source] ?? job.source}</Badge>
                </TableCell>
                <TableCell>
                  <Badge variant={job.status === "dead" ? "destructive" : "secondary"}>
                    {job.status}
                  </Badge>
                </TableCell>
                <TableCell>{job.attemptCount}</TableCell>
                <TableCell className="max-w-[200px] truncate text-xs" title={job.lastError ?? undefined}>
                  {job.lastError === "line-monthly-quota-exhausted"
                    ? "LINE月間上限・再送なし"
                    : job.lastError ?? "—"}
                </TableCell>
                <TableCell className="text-xs">{formatDateTime(job.updatedAt)}</TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    {isAcknowledgeableJob(job) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={actionPending}
                        onClick={() => openAcknowledgeDialog(job)}
                      >
                        <CheckCircle2 className="mr-1 h-4 w-4" aria-hidden="true" />
                        確認済み
                      </Button>
                    )}
                    {!isNotificationRetryBlocked(job) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={actionPending}
                        onClick={() => handleRetry(job)}
                      >
                        <RefreshCw className="mr-1 h-4 w-4" aria-hidden="true" />
                        {retryMutation.isPending && retryMutation.variables?.jobId === job.id
                          ? "リトライ中..."
                          : "リトライ"}
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog
        open={acknowledgeDraft !== null}
        onOpenChange={(open) => {
          if (!open && !acknowledgeMutation.isPending) {
            setAcknowledgeDraft(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{acknowledgeDraft?.job.source === "notification_jobs" ? "通知を確認済みにする" : "注意ジョブを確認済みにする"}</DialogTitle>
            <DialogDescription>
              再送せずに一覧から外し、監査ログへ確認メモを残します。
              {acknowledgeDraft?.job.source === "notification_jobs" && "送信結果と失敗履歴は保持され、この通知は再送できなくなります。"}
            </DialogDescription>
          </DialogHeader>
          {acknowledgeDraft && (
            <div className="space-y-3">
              <div className="grid gap-1 text-xs text-muted-foreground">
                <div>
                  {SOURCE_LABELS[acknowledgeDraft.job.source] ?? acknowledgeDraft.job.source}
                  {acknowledgeDraft.job.reason ? ` / ${acknowledgeDraft.job.reason}` : ""}
                </div>
                <div className="font-mono">{acknowledgeDraft.job.id}</div>
                {acknowledgeDraft.job.source === "notification_jobs" && (
                  <>
                    <div>通知: {NOTIFICATION_LABELS[acknowledgeDraft.job.templateKey ?? ""] ?? acknowledgeDraft.job.templateKey}</div>
                    <div>予約: {acknowledgeDraft.job.reservationId ?? "予約に紐づかない通知"}</div>
                    <div>失敗日時: {formatDateTime(acknowledgeDraft.job.updatedAt)}</div>
                  </>
                )}
              </div>
              <Textarea
                value={acknowledgeDraft.note}
                maxLength={500}
                rows={4}
                aria-label="確認メモ"
                onChange={(event) =>
                  setAcknowledgeDraft({
                    job: acknowledgeDraft.job,
                    note: event.target.value,
                  })
                }
              />
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={acknowledgeMutation.isPending}
              onClick={() => setAcknowledgeDraft(null)}
            >
              キャンセル
            </Button>
            <Button
              type="button"
              disabled={!canSubmitAcknowledge || actionPending}
              onClick={handleAcknowledge}
            >
              <CheckCircle2 className="mr-1 h-4 w-4" aria-hidden="true" />
              {acknowledgeMutation.isPending &&
              acknowledgeMutation.variables?.jobId === acknowledgeDraft?.job.id
                ? "確認中..."
                : "確認済み"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// チャンネルステータスに応じたバッジ色を決める。
function getSyncChannelStatusVariant(status: string): "secondary" | "destructive" | "outline" {
  if (status === "active") return "secondary";
  if (status === "expired" || status === "failed") return "destructive";
  return "outline";
}

function ChannelTable({ channels }: Readonly<{ channels: SyncChannel[] }>) {
  if (channels.length === 0) {
    return <p className="text-sm text-muted-foreground">チャンネルがありません。</p>;
  }

  return (
    <div className="rounded-md border overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>ストアID</TableHead>
            <TableHead>ステータス</TableHead>
            <TableHead>Syncトークン</TableHead>
            <TableHead>有効期限</TableHead>
            <TableHead>最終通知</TableHead>
            <TableHead>最終増分同期</TableHead>
            <TableHead>最終完全照合</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {channels.map((ch) => (
            <TableRow key={ch.id}>
              <TableCell className="text-xs font-mono">{ch.storeId.slice(0, 8)}</TableCell>
              <TableCell>
                <Badge variant={getSyncChannelStatusVariant(ch.status)}>
                  {ch.status}
                </Badge>
              </TableCell>
              <TableCell>{ch.syncTokenPresent ? "あり" : "なし"}</TableCell>
              <TableCell className="text-xs">{formatDateTime(ch.expirationAt)}</TableCell>
              <TableCell className="text-xs">{formatDateTime(ch.lastNotificationAt)}</TableCell>
              <TableCell className="text-xs">{formatDateTime(ch.lastIncrementalSyncAt)}</TableCell>
              <TableCell className="text-xs">{formatDateTime(ch.lastFullReconcileAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// トグルボタンの表示文言を決める(処理中/有効/無効の3状態)。
function getGoogleEditModeToggleLabel(isPending: boolean, googleControlledEditMode: boolean): string {
  if (isPending) return "変更中...";
  if (googleControlledEditMode) return "無効にする";
  return "有効にする";
}

function GoogleEditModeToggle() {
  const { data: settingsData } = useSettings();
  const editModeMutation = useGoogleEditMode();

  const settingsStores = settingsData?.ok ? settingsData.settings.stores : [];

  const handleToggle = (storeId: string, currentEnabled: boolean) => {
    editModeMutation.mutate({ storeId, enabled: !currentEnabled });
  };

  return (
    <div className="space-y-2">
      <h2 className="font-semibold text-lg">Google編集モード</h2>
      <p className="text-sm text-muted-foreground">
        有効にすると、Googleカレンダーからの編集が予約システムに反映されます。
      </p>
      <div className="grid gap-2">
        {settingsStores.map((store) => (
          <Card key={store.id} className="flex items-center justify-between p-3">
            <div className="flex items-center gap-2">
              <span className="font-medium">{store.name}</span>
              <Badge variant={store.googleControlledEditMode ? "default" : "secondary"}>
                {store.googleControlledEditMode ? "有効" : "無効"}
              </Badge>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={editModeMutation.isPending}
              onClick={() => handleToggle(store.id, store.googleControlledEditMode)}
            >
              {getGoogleEditModeToggleLabel(editModeMutation.isPending, store.googleControlledEditMode)}
            </Button>
          </Card>
        ))}
      </div>
    </div>
  );
}

const ALL_STORES = "__all__";

export default function GoogleSyncPage() {
  const { syncStatus, isPending, isError } = useSyncStatus();
  const { data: settingsData } = useSettings();

  const settingsStores: Store[] = settingsData?.ok ? settingsData.settings.stores : [];

  if (isPending) {
    return (
      <div className="space-y-4 p-4 sm:p-6">
        <h1 className="text-2xl font-bold">Google連携</h1>
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      </div>
    );
  }

  if (isError || !syncStatus) {
    return (
      <div className="space-y-4 p-4 sm:p-6">
        <h1 className="text-2xl font-bold">Google連携</h1>
        <p className="text-sm text-destructive">同期ステータスの取得に失敗しました。</p>
      </div>
    );
  }

  if (syncStatus.role === "staff") {
    return (
      <div className="space-y-4 p-4 sm:p-6">
        <h1 className="text-2xl font-bold">Google連携</h1>
        {syncStatus.warnings.length === 0 ? (
          <p className="text-sm text-muted-foreground">現在、確認が必要な項目はありません。</p>
        ) : (
          <RecoveryTasks tasks={syncStatus.warnings} />
        )}
      </div>
    );
  }

  if (syncStatus.role === "owner") {
    return (
      <div className="space-y-6 p-4 sm:p-6">
        <h1 className="text-2xl font-bold">Google連携</h1>
        <StatusCard summary={syncStatus.summary} />
        <RecoveryTasks tasks={syncStatus.recoveryTasks} />
        {!!syncStatus.actionableConflicts?.length && <ConflictList conflicts={syncStatus.actionableConflicts} ownerOnly />}
        {syncStatus.conflictAggregate.totalConflicts > 0 && (
          <Card className="p-4 space-y-2">
            <h2 className="font-semibold text-lg">競合サマリ</h2>
            <p className="text-sm">
              合計: {syncStatus.conflictAggregate.totalConflicts}件
              （要対応: {syncStatus.conflictAggregate.totalRequiringAction}件）
            </p>
            {syncStatus.conflictAggregate.perStore.map((ps) => (
              <p key={ps.storeId} className="text-xs text-muted-foreground">
                店舗 {ps.storeId.slice(0, 8)}… — 合計 {ps.total}件 / 要対応 {ps.actionRequired}件
              </p>
            ))}
          </Card>
        )}
        <GoogleEditModeToggle />
      </div>
    );
  }

  // system_admin: full detail
  return <SystemAdminSyncView syncStatus={syncStatus} settingsStores={settingsStores} />;
}

function SystemAdminSyncView({
  syncStatus,
  settingsStores,
}: Readonly<{
  syncStatus: SyncStatusSystemAdmin;
  settingsStores: Store[];
}>) {
  const [techOpen, setTechOpen] = useState(false);
  // null = 全店舗。
  const [selectedStoreId, setSelectedStoreId] = useState<string | null>(null);

  const { storeOptions, channels, dlqJobs, googleEvents, outboundWrites, conflicts } = useMemo(
    () => buildGoogleSyncViewModel(syncStatus, settingsStores, selectedStoreId),
    [syncStatus, settingsStores, selectedStoreId],
  );

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Google連携</h1>
        <Select
          value={selectedStoreId ?? ALL_STORES}
          onValueChange={(v) => setSelectedStoreId(v === ALL_STORES ? null : v)}
        >
          <SelectTrigger className="w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_STORES}>全体表示</SelectItem>
            {storeOptions.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <StatusCard summary={syncStatus.summary} />
      <ConflictList conflicts={conflicts} />
      <GoogleEditModeToggle />

      <div className="space-y-2">
        <Button variant="outline" onClick={() => setTechOpen(!techOpen)}>
          {techOpen ? "技術詳細を閉じる" : "技術詳細を表示"}
        </Button>

        {techOpen && (
          <div className="space-y-4">
            <div className="space-y-2">
              <h3 className="font-semibold">チャンネル ({channels.length})</h3>
              <ChannelTable channels={channels} />
            </div>

            <div className="space-y-2">
              <h3 className="font-semibold">注意ジョブ (DLQ) ({dlqJobs.length})</h3>
              <DlqTable jobs={dlqJobs} />
            </div>

            <div className="space-y-2">
              <h3 className="font-semibold">Googleイベント ({googleEvents.length})</h3>
              {googleEvents.length === 0 ? (
                <p className="text-sm text-muted-foreground">イベントがありません。</p>
              ) : (
                <div className="rounded-md border overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>イベントID</TableHead>
                        <TableHead>ソース</TableHead>
                        <TableHead>ステータス</TableHead>
                        <TableHead>最終確認</TableHead>
                        <TableHead>予約/ブロック</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {googleEvents.map((ev) => (
                        <TableRow key={ev.id}>
                          <TableCell className="text-xs font-mono">{ev.googleEventId.slice(0, 16)}</TableCell>
                          <TableCell><Badge variant="outline">{ev.sourceType}</Badge></TableCell>
                          <TableCell><Badge variant="secondary">{ev.status}</Badge></TableCell>
                          <TableCell className="text-xs">{formatDateTime(ev.lastSeenAt)}</TableCell>
                          <TableCell className="text-xs">
                            {ev.reservationId ? `R:${ev.reservationId.slice(0, 8)}` : ""}
                            {ev.externalBlockId ? `B:${ev.externalBlockId.slice(0, 8)}` : ""}
                            {!ev.reservationId && !ev.externalBlockId ? "—" : ""}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <h3 className="font-semibold">送信書き込み ({outboundWrites.length})</h3>
              {outboundWrites.length === 0 ? (
                <p className="text-sm text-muted-foreground">送信書き込みがありません。</p>
              ) : (
                <div className="rounded-md border overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>アクション</TableHead>
                        <TableHead>イベントID</TableHead>
                        <TableHead>オーナー</TableHead>
                        <TableHead>有効期限</TableHead>
                        <TableHead>作成日</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {outboundWrites.map((w) => (
                        <TableRow key={w.id}>
                          <TableCell><Badge variant="outline">{w.action}</Badge></TableCell>
                          <TableCell className="text-xs font-mono">{w.googleEventId.slice(0, 16)}</TableCell>
                          <TableCell className="text-xs">{w.ownerType}:{w.ownerId.slice(0, 8)}</TableCell>
                          <TableCell className="text-xs">{formatDateTime(w.expiresAt)}</TableCell>
                          <TableCell className="text-xs">{formatDateTime(w.createdAt)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
