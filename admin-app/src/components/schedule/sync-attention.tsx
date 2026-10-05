import { useSyncStatus } from "@/hooks/use-sync-status";
import { Button } from "@/components/ui/button";
import { Link } from "react-router";
import { ApiError } from "@/lib/api-client";
import { ACCESS_LOGOUT_PATH } from "@/lib/auth-logout";
import { useAuth } from "@/hooks/use-auth";

export function ScheduleSyncAttention() {
  const { user } = useAuth();
  const enabled = user.role !== "system_admin";
  const { syncStatus, isPending, isError, error, refetch } = useSyncStatus(enabled);
  if (!enabled) return null;
  const authError = error instanceof ApiError && (error.status === 401 || error.status === 403);
  if (isPending) return <output className="mx-4 block py-2 text-sm">Google・LINEの連携状況を確認しています…</output>;
  if (isError) return (
    <div className="mx-4 flex flex-wrap items-center justify-between gap-2 py-2 text-sm" role="alert">
      <span>{authError ? "Google・LINEの連携状況を確認できません。ログインの有効期限、または権限を確認してください。" :
        <>Google・LINEの連携状況の{syncStatus ? "更新" : "読み込み"}に失敗しました。最新の状況を確認できません。</>}</span>
      <Button size="sm" variant="outline" onClick={() => { void refetch(); }}>再取得</Button>
      {authError && <Button asChild size="sm" variant="outline"><a href={ACCESS_LOGOUT_PATH}>再ログイン</a></Button>}
    </div>
  );
  if (!syncStatus || syncStatus.role === "system_admin") return null;
  const tasks = syncStatus.role === "staff" ? syncStatus.warnings : syncStatus.recoveryTasks;
  if (!tasks.length) return null;
  const count = tasks.reduce((total, item) => total + item.count, 0);
  return (
    <details className="mx-4 rounded-md border px-3 text-sm">
      <summary className="min-h-11 cursor-pointer py-3 font-medium">Google・LINEの確認が必要です（{count}件）</summary>
      <ul className="space-y-1 pb-2">{tasks.map((task) => <li key={task.kind}>{task.message}（{task.count}件）</li>)}</ul>
      {syncStatus.role === "owner" && <Link className="inline-flex min-h-11 items-center underline" to="/google-sync">連携状況を確認する</Link>}
    </details>
  );
}
