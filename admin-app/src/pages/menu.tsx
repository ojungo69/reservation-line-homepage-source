import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { StoreSelect } from "@/components/ui/store-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useServiceList } from "@/hooks/use-services";
import { useStores } from "@/hooks/use-stores";
import { useAuth } from "@/hooks/use-auth";
import { ServiceDetailPanel } from "@/components/menu/service-detail-panel";
import { ServiceCreateDialog } from "@/components/menu/service-create-dialog";

export default function MenuPage() {
  const { isPrivileged, user } = useAuth();
  const { stores, selectedStoreId, selectStore } = useStores();
  const { serviceList, storeNames, isPending } = useServiceList(selectedStoreId);
  // 組み合わせ割引のカテゴリ候補用に全店舗のメニュー名が要る (同じ queryKey なので追加フェッチなし)。
  const { serviceList: allServices } = useServiceList(null);

  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const selectedService = serviceList.find((s) => s.id === selectedServiceId) ?? null;

  // staff は自店舗のメニューを追加・編集できる。サーバ側は settings-services.ts の
  // isAdminAllowedForStoreSettings で既に自店舗 staff を許可済みで、/api/admin/settings も
  // staff には自店舗の services / stores しか返さないため、ここは同じ境界の表示ゲート。
  const isStoreScopedStaff = user.role === "staff" && user.storeId !== null;
  const canManageMenus = isPrivileged || isStoreScopedStaff;
  const canEditSelected =
    isPrivileged ||
    (isStoreScopedStaff && selectedService !== null && selectedService.storeId === user.storeId);

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">メニュー</h1>
        <div className="flex items-center gap-3">
          <StoreSelect stores={stores} value={selectedStoreId} onChange={selectStore} />
          {canManageMenus && (
            <Button onClick={() => setCreateOpen(true)}>+ 追加</Button>
          )}
        </div>
      </div>

      {isPending ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>メニュー名</TableHead>
                <TableHead>所要時間</TableHead>
                <TableHead>料金</TableHead>
                <TableHead>店舗</TableHead>
                <TableHead>状態</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {serviceList.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    メニューがありません
                  </TableCell>
                </TableRow>
              ) : (
                serviceList.map((s) => (
                  <TableRow
                    key={s.id}
                    tabIndex={0}
                    aria-label={`${s.name}の詳細を開く`}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => setSelectedServiceId(s.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedServiceId(s.id);
                      }
                    }}
                  >
                    <TableCell className="font-medium">{s.name}</TableCell>
                    <TableCell>{s.durationMinutes}分</TableCell>
                    <TableCell>
                      {s.priceLabel ?? <span className="text-muted-foreground">未設定</span>}
                      {s.priceAmount != null && (
                        <div className="text-xs text-muted-foreground">
                          {s.priceAmount.toLocaleString("ja-JP")}円
                          {s.comboPriceAmount != null && s.comboWithPrefix != null &&
                            `（${s.comboWithPrefix}と同時 ${s.comboPriceAmount.toLocaleString("ja-JP")}円）`}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      {storeNames.get(s.storeId) ?? s.storeId}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge variant={s.active ? "default" : "secondary"}>
                          {s.active ? "有効" : "無効"}
                        </Badge>
                        {s.mensMenu && <Badge variant="outline">メンズ</Badge>}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <ServiceDetailPanel
        service={selectedService}
        stores={stores}
        services={allServices}
        canEdit={canEditSelected}
        onClose={() => setSelectedServiceId(null)}
      />

      {canManageMenus && (
        <ServiceCreateDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          stores={stores}
          defaultStoreId={selectedStoreId}
          services={allServices}
        />
      )}
    </div>
  );
}
