import { StoreSelect } from "@/components/ui/store-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/hooks/use-auth";
import { useStores } from "@/hooks/use-stores";
import { BusinessHoursTab } from "@/components/settings/business-hours-tab";
import { ClosuresTab } from "@/components/settings/closures-tab";
import { ResourcesTab } from "@/components/settings/resources-tab";
import { ReminderTab } from "@/components/settings/reminder-tab";
import { RecurringBlocksTab } from "@/components/settings/recurring-blocks-tab";

export default function SettingsPage() {
  const { isPrivileged } = useAuth();
  const { stores, selectedStoreId, selectStore } = useStores();
  const effectiveStoreId = selectedStoreId ?? (stores.length === 1 ? stores[0].id : null);

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">店舗設定</h1>
        <StoreSelect stores={stores} value={selectedStoreId} onChange={selectStore} />
      </div>

      <Tabs defaultValue="hours" className="w-full">
        <TabsList className="w-full justify-start overflow-x-auto">
          <TabsTrigger value="hours">営業時間</TabsTrigger>
          <TabsTrigger value="closures">休業日</TabsTrigger>
          {/* リソース/リマインダー/繰り返しブロックは owner+ 限定のまま:
              リソース削除は slot_locks / external_blocks へ CASCADE し、
              リマインダー・繰り返しブロックは全店共通の予約ルールに触るため。
              バックエンド側も isAdminPrivileged のまま (二重ゲート)。 */}
          {isPrivileged && (
            <>
              <TabsTrigger value="resources">リソース</TabsTrigger>
              <TabsTrigger value="reminder">リマインダー</TabsTrigger>
              <TabsTrigger value="recurring">繰り返しブロック</TabsTrigger>
            </>
          )}
        </TabsList>

        <TabsContent value="hours" className="mt-4">
          <BusinessHoursTab key={effectiveStoreId ? `store:${effectiveStoreId}` : "scope:none"} stores={stores} selectedStoreId={effectiveStoreId} />
        </TabsContent>

        <TabsContent value="closures" className="mt-4">
          <ClosuresTab selectedStoreId={effectiveStoreId} />
        </TabsContent>

        {isPrivileged && (
          <>
            <TabsContent value="resources" className="mt-4">
              <ResourcesTab selectedStoreId={effectiveStoreId} />
            </TabsContent>

            <TabsContent value="reminder" className="mt-4">
              <ReminderTab stores={stores} />
            </TabsContent>

            <TabsContent value="recurring" className="mt-4">
              <RecurringBlocksTab selectedStoreId={effectiveStoreId} />
            </TabsContent>
          </>
        )}
      </Tabs>
    </div>
  );
}
