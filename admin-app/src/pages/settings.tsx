import { useCallback, useState } from "react";
import { StoreSelect } from "@/components/ui/store-select";
import { PendingConfirmDialog } from "@/components/ui/pending-confirm-dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/hooks/use-auth";
import { useStores } from "@/hooks/use-stores";
import { useSettings } from "@/hooks/use-settings";
import { SettingsLoadError } from "@/components/settings/settings-tab-status";
import { BusinessHoursTab } from "@/components/settings/business-hours-tab";
import { ClosuresTab } from "@/components/settings/closures-tab";
import { ResourcesTab } from "@/components/settings/resources-tab";
import { ReminderTab } from "@/components/settings/reminder-tab";
import { RecurringBlocksTab } from "@/components/settings/recurring-blocks-tab";

export default function SettingsPage() {
  const { isPrivileged } = useAuth();
  const { stores, selectedStoreId, selectStore } = useStores();
  const { isError, refetch } = useSettings();
  const effectiveStoreId = selectedStoreId ?? (stores.length === 1 ? stores[0].id : null);
  const [activeTab, setActiveTab] = useState("hours");
  const [hoursEdit, setHoursEdit] = useState<{ storeId: string; pending: boolean } | null>(null);
  const hoursStoreId = hoursEdit?.storeId ?? effectiveStoreId;
  const switchingStore = hoursEdit !== null && hoursEdit.storeId !== effectiveStoreId;
  const handleHoursEditingChange = useCallback((storeId: string | null, editing: boolean, pending: boolean) => {
    setHoursEdit(editing && storeId ? { storeId, pending } : null);
  }, []);

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">店舗設定</h1>
        <StoreSelect stores={stores} value={selectedStoreId} onChange={selectStore} />
      </div>

      {isError && <SettingsLoadError onRetry={() => { void refetch(); }} />}
      {/* 再取得の失敗でも各タブの下書きを保持するため、アンマウントせず隠す。 */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full" hidden={isError}>
        <TabsList className="w-full justify-start overflow-x-auto">
          <TabsTrigger value="hours">営業時間</TabsTrigger>
          <TabsTrigger value="closures">休業日</TabsTrigger>
          {/* リソース/予約ルール・通知/繰り返しブロックは owner+ 限定のまま:
              リソース削除は slot_locks / external_blocks へ CASCADE し、
              予約ルール・通知は各店舗の受付ルール、繰り返しブロックは予約枠に触るため。
              バックエンド側も isAdminPrivileged のまま (二重ゲート)。 */}
          {isPrivileged && (
            <>
              <TabsTrigger value="resources">リソース</TabsTrigger>
              <TabsTrigger value="reminder">予約ルール・通知</TabsTrigger>
              <TabsTrigger value="recurring">繰り返しブロック</TabsTrigger>
            </>
          )}
        </TabsList>

        {/* タブ移動は下書きを保持し、共有の店舗選択が変わっても破棄確認までは元の店舗で編集する。 */}
        <TabsContent value="hours" className="mt-4" forceMount hidden={activeTab !== "hours"}>
          <BusinessHoursTab
            key={hoursStoreId ? `store:${hoursStoreId}` : "scope:none"}
            stores={stores}
            selectedStoreId={hoursStoreId}
            onEditingChange={handleHoursEditingChange}
          />
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

      <PendingConfirmDialog
        open={switchingStore}
        pending={hoursEdit?.pending ?? false}
        title="営業時間の変更を破棄しますか？"
        description="編集中の営業時間は保存されません。店舗を切り替えてもよろしいですか？"
        confirmLabel="破棄して切り替える"
        onOpenChange={(open) => {
          if (!open && hoursEdit) selectStore(hoursEdit.storeId);
        }}
        onConfirm={() => setHoursEdit(null)}
      />
    </div>
  );
}
