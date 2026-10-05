import { useMemo, useState } from "react";
import { useMutationState } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { useCustomerNotices, useCustomerNoticeUpdate } from "@/hooks/use-customer-notice";
import {
  collectPendingMutationIds,
  CUSTOMER_NOTICE_MUTATION_KEY,
} from "@/lib/pending-mutation-ids";
import { dropStoreDraft } from "@/lib/store-drafts";

const MAX_NOTICE_LENGTH = 500;

export function CustomerNoticeCard() {
  const { stores, isPending } = useCustomerNotices();
  const update = useCustomerNoticeUpdate();
  const pendingVariables = useMutationState({
    filters: { mutationKey: CUSTOMER_NOTICE_MUTATION_KEY, status: "pending" },
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
        <h3 className="text-sm font-medium">予約ページのお知らせ</h3>
        <p className="text-xs text-muted-foreground">
          お客様の予約ページで、店舗を選んだ時に表示されるお知らせ文です。空欄にすると表示されません。（例: 年末年始は12月30日から1月3日までお休みをいただきます。）
        </p>
      </div>
      <div className="grid gap-3">
        {stores.map((store) => {
          const saved = store.customerNotice ?? "";
          const draft = drafts[store.id] ?? saved;
          // Empty (after trim) clears the notice; otherwise send the trimmed text.
          const trimmed = draft.trim();
          const changed = trimmed !== saved.trim() && draft.length <= MAX_NOTICE_LENGTH;
          const savingThis = pendingStoreIds.has(store.id);
          return (
            <div key={store.id} className="grid gap-1.5">
              <span className="text-sm">{store.name}</span>
              <Textarea
                rows={2}
                maxLength={MAX_NOTICE_LENGTH}
                className="min-h-0 text-sm"
                value={draft}
                aria-label={`${store.name} の予約ページのお知らせ`}
                disabled={savingThis}
                onChange={(e) => setDrafts((d) => ({ ...d, [store.id]: e.target.value }))}
              />
              <div className="flex justify-end">
                <Button
                  size="sm"
                  disabled={!changed || savingThis}
                  onClick={() => {
                    void update.mutateAsync(
                      { storeId: store.id, customerNotice: trimmed === "" ? null : trimmed },
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
