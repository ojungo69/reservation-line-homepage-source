import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { SyncWarningItem } from "@/types/api";

type Props = {
  tasks: SyncWarningItem[];
};

const KIND_LABELS: Record<string, string> = {
  google_edit_conflict: "Google編集",
  google_edit_error: "Google編集",
  google_sync_attention: "同期",
  google_sync_attention_jobs: "同期ジョブ",
  line_notification_error: "LINE通知",
  line_notification_attention_jobs: "LINE通知",
};

export function RecoveryTasks({ tasks }: Readonly<Props>) {
  if (tasks.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">対処が必要な項目はありません。</p>
    );
  }

  return (
    <div className="space-y-2">
      <h2 className="font-semibold text-lg">対処が必要な項目</h2>
      <div className="grid gap-2">
        {tasks.map((task) => (
          <Card key={task.kind} className="flex items-center justify-between p-3">
            <div className="flex items-center gap-2">
              <Badge variant="outline">{KIND_LABELS[task.kind] ?? task.kind}</Badge>
              <span className="text-sm">{task.message}</span>
            </div>
            <Badge variant="destructive">{task.count}</Badge>
          </Card>
        ))}
      </div>
    </div>
  );
}
