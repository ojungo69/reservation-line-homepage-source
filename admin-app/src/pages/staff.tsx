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
import { useStaffList } from "@/hooks/use-staff";
import { useStores } from "@/hooks/use-stores";
import { useAuth } from "@/hooks/use-auth";
import { StaffDetailPanel } from "@/components/staff/staff-detail-panel";
import { StaffCreateDialog } from "@/components/staff/staff-create-dialog";
import type { StaffMember, Store } from "@/types/api";

const ROLE_LABELS: Record<string, string> = {
  owner: "オーナー",
  staff: "スタッフ",
  system_admin: "システム管理者",
};

function StaffTableSection({
  isPending,
  isError,
  staffList,
  stores,
  onSelect,
}: Readonly<{
  isPending: boolean;
  isError: boolean;
  staffList: StaffMember[];
  stores: Store[];
  onSelect: (id: string) => void;
}>) {
  if (isPending) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }
  if (isError) {
    return (
      <p className="text-sm text-destructive">
        スタッフデータの取得に失敗しました。
      </p>
    );
  }
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>表示名</TableHead>
            <TableHead>店舗</TableHead>
            <TableHead>ロール</TableHead>
            <TableHead>状態</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {staffList.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4} className="text-center text-muted-foreground">
                スタッフがいません
              </TableCell>
            </TableRow>
          ) : (
            staffList.map((s) => (
              <TableRow
                key={s.id}
                tabIndex={0}
                aria-label={`${s.displayName}の詳細を開く`}
                className="cursor-pointer hover:bg-muted/50"
                onClick={() => onSelect(s.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(s.id);
                  }
                }}
              >
                <TableCell className="font-medium">{s.displayName}</TableCell>
                <TableCell>
                  {stores.find((st) => st.id === s.storeId)?.name ?? s.storeId}
                </TableCell>
                <TableCell>{ROLE_LABELS[s.role] ?? s.role}</TableCell>
                <TableCell>
                  <Badge variant={s.active ? "default" : "secondary"}>
                    {s.active ? "有効" : "無効"}
                  </Badge>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

export default function StaffPage() {
  const { isPrivileged } = useAuth();
  const { stores, selectedStoreId, selectStore } = useStores();
  const { staffList, isPending, isError } = useStaffList(selectedStoreId);

  const [selectedStaffId, setSelectedStaffId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const selectedStaff = staffList.find((s) => s.id === selectedStaffId) ?? null;

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">スタッフ</h1>
        <div className="flex items-center gap-3">
          <StoreSelect stores={stores} value={selectedStoreId} onChange={selectStore} />
          {isPrivileged && (
            <Button onClick={() => setCreateOpen(true)}>+ 追加</Button>
          )}
        </div>
      </div>

      <StaffTableSection
        isPending={isPending}
        isError={isError}
        staffList={staffList}
        stores={stores}
        onSelect={setSelectedStaffId}
      />

      <StaffDetailPanel
        staff={selectedStaff}
        stores={stores}
        onClose={() => setSelectedStaffId(null)}
      />

      <StaffCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        stores={stores}
        defaultStoreId={selectedStoreId}
      />
    </div>
  );
}
