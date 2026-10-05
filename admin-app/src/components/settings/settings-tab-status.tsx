import { Skeleton } from "@/components/ui/skeleton";

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
