import { useMemo, useState } from "react";
import { useMutationState } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useBookingWindows, useBookingWindowUpdate } from "@/hooks/use-booking-window";
import {
  BOOKING_WINDOW_MUTATION_KEY,
  collectPendingMutationIds,
} from "@/lib/pending-mutation-ids";
import { dropStoreDraft } from "@/lib/store-drafts";

const MIN_WINDOW_DAYS = 1;
const MAX_WINDOW_DAYS = 90;

export function BookingWindowCard() {
  const { stores, isPending } = useBookingWindows();
  const update = useBookingWindowUpdate();
  const pendingVariables = useMutationState({
    filters: { mutationKey: BOOKING_WINDOW_MUTATION_KEY, status: "pending" },
    select: (mutation) => mutation.state.variables,
  });
  const pendingStoreIds = useMemo(
    () => collectPendingMutationIds(pendingVariables, "storeId"),
    [pendingVariables],
  );
  // Per-store draft input value; absent → show the saved value.
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  // The parent ReminderTab already renders loading skeletons for the shared
  // ["settings"] query, so render nothing while it is still pending.
  if (isPending) return null;

  return (
    <Card className="space-y-3 p-4">
      <div>
        <h3 className="text-sm font-medium">予約受付期間（何日先まで）</h3>
        <p className="text-xs text-muted-foreground">
          お客様が予約ページで予約できるのは、本日から<strong>何日先まで</strong>かを設定します（1〜90日）。
          例: 30日に設定すると、本日から約1か月先まで予約できます。短くすると直近の予約だけ受け付けます。
        </p>
      </div>
      <div className="grid gap-2">
        {stores.map((store) => {
          const draft = drafts[store.id] ?? String(store.bookingWindowDays);
          const parsed = Number(draft);
          const valid = Number.isInteger(parsed) && parsed >= MIN_WINDOW_DAYS && parsed <= MAX_WINDOW_DAYS;
          const changed = valid && parsed !== store.bookingWindowDays;
          const savingThis = pendingStoreIds.has(store.id);
          return (
            <div key={store.id} className="flex items-center justify-between gap-2">
              <span className="text-sm">{store.name}</span>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={MIN_WINDOW_DAYS}
                  max={MAX_WINDOW_DAYS}
                  inputMode="numeric"
                  className="w-20"
                  value={draft}
                  aria-label={`${store.name} の予約受付期間（日先まで）`}
                  aria-invalid={!valid}
                  disabled={savingThis}
                  onChange={(e) => setDrafts((d) => ({ ...d, [store.id]: e.target.value }))}
                />
                <span className="text-xs text-muted-foreground">日先まで</span>
                <Button
                  size="sm"
                  disabled={!changed || savingThis}
                  onClick={() => {
                    void update.mutateAsync(
                      { storeId: store.id, bookingWindowDays: parsed },
                    ).then(
                      () => setDrafts(dropStoreDraft(store.id)),
                      () => undefined,
                    );
                  }}
                >
                  {savingThis ? "保存中..." : "保存"}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
