import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";

export function SettingsLoadError({ onRetry }: Readonly<{ onRetry: () => void }>) {
  return (
    <div role="alert" className="space-y-2">
      <p className="text-sm text-destructive">設定を読み込めませんでした</p>
      <Button type="button" variant="outline" onClick={onRetry}>再読み込み</Button>
    </div>
  );
}

export function SettingsTabStatus({
  selectedStoreId,
}: Readonly<{ selectedStoreId: string | null }>) {
  if (!selectedStoreId) {
    return <p className="text-sm text-muted-foreground">店舗を選択してください</p>;
  }

  return (
    <div className="space-y-2">
      {Array.from({ length: 4 }).map((_, index) => (
        <Skeleton key={index} className="h-12 w-full" />
      ))}
    </div>
  );
}
