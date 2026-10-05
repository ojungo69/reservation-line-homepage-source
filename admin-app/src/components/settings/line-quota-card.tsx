import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useLineQuota } from "@/hooks/use-line-quota";

// 上限超過/ソフトキャップ超過/通常時でバーと件数表示の色をまとめて決める
// (2つの派生が同じ条件を共有するため1つのヘルパーに統合)。
function quotaBarColors(overLimit: boolean, overSoftCap: boolean): { bar: string; count: string } {
  if (overLimit) return { bar: "bg-red-500", count: "text-red-600" };
  if (overSoftCap) return { bar: "bg-amber-500", count: "text-amber-600" };
  return { bar: "bg-green-500", count: "text-foreground" };
}

// 上限に応じた説明文を導出する。
function quotaMessage(
  hasLimit: boolean,
  overLimit: boolean,
  overSoftCap: boolean,
  remaining: number | null,
  softCap: number,
): string {
  if (!hasLimit) return "現在のプランに月間上限はありません。";
  if (overLimit) return "月間上限に達しました。LINE通知は停止中です。送れなかった通知は、翌月も再送しません。";
  if (overSoftCap) return `残り ${remaining} 通。補助通知（リマインダー等）は一時停止中です。`;
  return `残り ${remaining} 通（${softCap} 通で補助通知を自動停止）。`;
}

/**
 * Owner-facing LINE monthly push-usage card. LINE's free plan allows 200 push
 * messages/month; this surfaces how close the salon is so optional notifications
 * can be managed before the cap is hit.
 */
export function LineQuotaCard() {
  const { quota, isPending, isError } = useLineQuota();

  if (isPending) {
    return <Skeleton className="h-24 w-full" />;
  }

  if (isError || !quota) {
    return (
      <Card className="p-4">
        <p className="text-sm font-medium">今月のLINE送信数</p>
        <p className="mt-1 text-xs text-muted-foreground">
          まだ取得できていません（数分後に自動取得されます）。
        </p>
      </Card>
    );
  }

  const { used, limit, remaining, softCap } = quota;
  const hasLimit = typeof limit === "number" && limit > 0;
  const ratio = hasLimit ? Math.min(1, used / limit) : 0;
  const overSoftCap = hasLimit && used >= softCap;
  const overLimit = hasLimit && remaining !== null && remaining <= 0;

  const { bar: barColor, count: countColor } = quotaBarColors(overLimit, overSoftCap);

  return (
    <Card className="space-y-2 p-4">
      <div className="flex items-baseline justify-between">
        <p className="text-sm font-medium">今月のLINE送信数</p>
        <p className={`text-sm font-semibold tabular-nums ${countColor}`}>
          {used}
          {hasLimit ? ` / ${limit}` : ""}
          <span className="ml-1 text-xs font-normal text-muted-foreground">通</span>
        </p>
      </div>
      {hasLimit && (
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={used} aria-valuemin={0} aria-valuemax={limit}>
          <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${ratio * 100}%` }} />
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {quotaMessage(hasLimit, overLimit, overSoftCap, remaining, softCap)}
      </p>
    </Card>
  );
}
