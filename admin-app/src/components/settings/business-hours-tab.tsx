import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useBusinessHours, useBusinessHoursUpdate } from "@/hooks/use-business-hours";
import { WEEKDAYS } from "@/lib/timeline";
import type { BusinessHourRow } from "@/types/api";

type StoreOption = { id: string; name: string };

type Props = {
  stores: StoreOption[];
  selectedStoreId: string | null;
};

const TIME_OPTIONS = Array.from({ length: 48 }, (_, i) => {
  const h = String(Math.floor(i / 2)).padStart(2, "0");
  const m = i % 2 === 0 ? "00" : "30";
  return `${h}:${m}`;
});

// The backend accepts any HH:MM (not just the 30-min grid). If a stored open/close
// time is off-grid (migration / non-SPA write), include it as its own option so the
// Select shows the saved value instead of rendering blank. Sort by parsed minutes (not
// lexically) so a non-zero-padded value like "9:00" still slots in chronologically.
const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(":");
  return (Number(h) || 0) * 60 + (Number(m) || 0);
};
const timeOptionsWith = (current: string): readonly string[] =>
  !current || TIME_OPTIONS.includes(current)
    ? TIME_OPTIONS
    : [...TIME_OPTIONS, current].sort((a, b) => toMinutes(a) - toMinutes(b));

export function BusinessHoursTab({ stores, selectedStoreId }: Readonly<Props>) {
  const storeId = selectedStoreId;
  const { data, isPending } = useBusinessHours(storeId);
  const updateMutation = useBusinessHoursUpdate();

  const [editHours, setEditHours] = useState<BusinessHourRow[] | null>(null);
  const [editing, setEditing] = useState(false);

  // Edit drafts reset when the store changes via the key prop in settings.tsx
  // (<BusinessHoursTab key={effectiveStoreId} />), which remounts this tab —
  // no reset effect needed.

  const hours = editHours ?? (data?.ok ? data.businessHours : null);

  const startEdit = () => {
    if (!data?.ok) return;
    setEditHours(data.businessHours.map((h) => ({ ...h })));
    setEditing(true);
  };

  const updateRow = (weekday: number, field: keyof BusinessHourRow, value: string | boolean) => {
    if (!editHours) return;
    setEditHours(editHours.map((h) =>
      h.weekday === weekday ? { ...h, [field]: value } : h,
    ));
  };

  const handleSave = () => {
    if (!storeId || !editHours) return;
    updateMutation.mutate(
      { storeId, hours: editHours },
      {
        onSuccess: () => {
          setEditing(false);
          setEditHours(null);
        },
      },
    );
  };

  if (!storeId) {
    return <p className="text-sm text-muted-foreground">店舗を選択してください</p>;
  }

  if (isPending) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  if (!hours) {
    return <p className="text-sm text-destructive">営業時間の取得に失敗しました</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {stores.find((s) => s.id === storeId)?.name ?? storeId}
        </p>
        {!editing ? (
          <Button variant="outline" onClick={startEdit}>編集</Button>
        ) : (
          <div className="flex gap-2">
            <Button onClick={handleSave} disabled={updateMutation.isPending}>
              {updateMutation.isPending ? "保存中..." : "保存"}
            </Button>
            <Button variant="outline" onClick={() => { setEditing(false); setEditHours(null); }} disabled={updateMutation.isPending}>
              キャンセル
            </Button>
          </div>
        )}
      </div>

      <div className="grid gap-3">
        {hours.map((h) => (
          <Card key={h.weekday} className="flex items-center justify-between p-4">
            <div className="flex items-center gap-3">
              <span className="w-8 text-center font-medium">{WEEKDAYS[h.weekday]}</span>
              {editing ? (
                <Badge
                  variant={h.closed ? "secondary" : "default"}
                  className="cursor-pointer px-4 py-2 hover:opacity-90"
                  onClick={() => updateRow(h.weekday, "closed", !h.closed)}
                >
                  {h.closed ? "休業" : "営業"}
                </Badge>
              ) : (
                <Badge variant={h.closed ? "secondary" : "default"}>
                  {h.closed ? "休業" : "営業"}
                </Badge>
              )}
            </div>
            {!h.closed && (
              <div className="flex items-center gap-2">
                {editing ? (
                  <>
                    <Select value={h.opensAt} onValueChange={(v) => updateRow(h.weekday, "opensAt", v)}>
                      <SelectTrigger className="w-[100px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {timeOptionsWith(h.opensAt).map((t) => (
                          <SelectItem key={t} value={t}>{t}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <span className="text-muted-foreground">〜</span>
                    <Select value={h.closesAt} onValueChange={(v) => updateRow(h.weekday, "closesAt", v)}>
                      <SelectTrigger className="w-[100px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {timeOptionsWith(h.closesAt).map((t) => (
                          <SelectItem key={t} value={t}>{t}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </>
                ) : (
                  <span className="text-sm">{h.opensAt} 〜 {h.closesAt}</span>
                )}
              </div>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
