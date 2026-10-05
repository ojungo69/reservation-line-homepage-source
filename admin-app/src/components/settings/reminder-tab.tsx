import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useReminderOffsets, useReminderUpdate } from "@/hooks/use-reminder";
import { LineQuotaCard } from "./line-quota-card";
import { ReservationCapCard } from "./reservation-cap-card";
import { BookingWindowCard } from "./booking-window-card";
import { CustomerNoticeCard } from "./customer-notice-card";

type StoreOption = { id: string; name: string };

type Props = {
  stores: StoreOption[];
};

const OFFSET_PRESETS = [
  { value: "null", label: "無効" },
  { value: "30", label: "30分前" },
  { value: "60", label: "1時間前" },
  { value: "120", label: "2時間前" },
  { value: "180", label: "3時間前" },
  { value: "1440", label: "24時間前" },
];

export function ReminderTab({ stores }: Readonly<Props>) {
  const { offsets, isPending } = useReminderOffsets();
  const updateMutation = useReminderUpdate();

  const handleChange = (storeId: string, value: string) => {
    const offsetMinutes = value === "null" ? null : Number(value);
    updateMutation.mutate({ storeId, offsetMinutes });
  };

  if (isPending) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 2 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <LineQuotaCard />
      <BookingWindowCard />
      <CustomerNoticeCard />
      <ReservationCapCard />
      <p className="text-sm text-muted-foreground">
        予約前にLINEでリマインダーを送信するタイミングを設定します。
      </p>
      <div className="grid gap-3">
        {stores.map((store) => {
          const offset = offsets.find((o) => o.storeId === store.id);
          const currentValue = offset?.offsetMinutes == null ? "null" : String(offset.offsetMinutes);
          // A stored offset set outside the SPA (migration / API) can be a non-preset
          // value; surface it as its own option so the Select shows the saved timing
          // instead of rendering blank.
          const isPreset = OFFSET_PRESETS.some((p) => p.value === currentValue);
          // Scope the busy state to the store actually being saved, so saving one
          // store doesn't lock every other store's Select in a multi-store salon.
          const savingThis = updateMutation.isPending && updateMutation.variables?.storeId === store.id;
          return (
            <Card key={store.id} className="flex items-center justify-between p-4">
              <span className="font-medium">{store.name}</span>
              <div className="flex items-center gap-2">
                <Select
                  value={currentValue}
                  onValueChange={(v) => handleChange(store.id, v)}
                  disabled={savingThis}
                >
                  <SelectTrigger className="w-[140px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {!isPreset && (
                      <SelectItem value={currentValue}>{currentValue}分前</SelectItem>
                    )}
                    {OFFSET_PRESETS.map((p) => (
                      <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {savingThis && (
                  <span className="text-xs text-muted-foreground">保存中...</span>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
