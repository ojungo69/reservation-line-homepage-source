import { useMemo, useState } from "react";
import { useMutationState } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useReservationCaps, useReservationCapUpdate } from "@/hooks/use-reservation-cap";
import {
  collectPendingMutationIds,
  RESERVATION_CAP_MUTATION_KEY,
} from "@/lib/pending-mutation-ids";
import { dropStoreDraft } from "@/lib/store-drafts";

const MIN_CAP = 1;
const MAX_CAP = 50;

export function ReservationCapCard() {
  const { stores, isPending } = useReservationCaps();
  const update = useReservationCapUpdate();
  const pendingVariables = useMutationState({
    filters: { mutationKey: RESERVATION_CAP_MUTATION_KEY, status: "pending" },
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
        <h3 className="text-sm font-medium">1人あたりの予約上限</h3>
        <p className="text-xs text-muted-foreground">
          この店舗でWeb予約を受け付ける際、その顧客の<strong>全店舗合計</strong>の未来予約数に適用する上限です（1〜50件）。
          スタッフが管理画面で作成する予約は、この上限を超えても作成できます。ただしスタッフ作成分も、お客様のWeb予約受付時の件数には含まれます。
        </p>
      </div>
      <div className="grid gap-2">
        {stores.map((store) => {
          const draft = drafts[store.id] ?? String(store.maxActiveReservationsPerCustomer);
          const parsed = Number(draft);
          const valid = Number.isInteger(parsed) && parsed >= MIN_CAP && parsed <= MAX_CAP;
          const changed = valid && parsed !== store.maxActiveReservationsPerCustomer;
          const savingThis = pendingStoreIds.has(store.id);
          return (
            <div key={store.id} className="flex items-center justify-between gap-2">
              <span className="text-sm">{store.name}</span>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={MIN_CAP}
                  max={MAX_CAP}
                  inputMode="numeric"
                  className="w-20"
                  value={draft}
                  aria-label={`${store.name} の1人あたり予約上限（件）`}
                  aria-invalid={!valid}
                  disabled={savingThis}
                  onChange={(e) => setDrafts((d) => ({ ...d, [store.id]: e.target.value }))}
                />
                <span className="text-xs text-muted-foreground">件</span>
                <Button
                  size="sm"
                  disabled={!changed || savingThis}
                  onClick={() => {
                    void update.mutateAsync(
                      { storeId: store.id, maxActiveReservationsPerCustomer: parsed },
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
