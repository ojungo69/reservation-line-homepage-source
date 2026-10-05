import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { SyncSummary } from "@/types/api";

type Props = {
  summary: SyncSummary;
};

function statusBadge(count: number, okLabel: string, ngLabel: string) {
  return count === 0 ? (
    <Badge variant="secondary">{okLabel}</Badge>
  ) : (
    <Badge variant="destructive">
      {ngLabel} ({count})
    </Badge>
  );
}

export function StatusCard({ summary }: Readonly<Props>) {
  const totalAttention =
    summary.openGoogleConflicts +
    summary.googleSyncJobsNeedingAttention +
    summary.lineNotificationJobsNeedingAttention +
    summary.channelsNeedingAttention;

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-lg">同期ステータス</h2>
        {totalAttention === 0 ? (
          <Badge variant="secondary">正常</Badge>
        ) : (
          <Badge variant="destructive">要対応 ({totalAttention})</Badge>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Google競合</p>
          {statusBadge(summary.openGoogleConflicts, "なし", "未解決")}
        </div>
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">同期ジョブ</p>
          {statusBadge(summary.googleSyncJobsNeedingAttention, "正常", "要確認")}
        </div>
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">LINE通知</p>
          {statusBadge(summary.lineNotificationJobsNeedingAttention, "正常", "未達")}
        </div>
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">チャンネル</p>
          {statusBadge(summary.channelsNeedingAttention, "正常", "要確認")}
        </div>
      </div>
    </Card>
  );
}
