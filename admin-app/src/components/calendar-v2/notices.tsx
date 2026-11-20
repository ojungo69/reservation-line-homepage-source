import { ScheduleSyncAttention } from "@/components/schedule/sync-attention";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/timeline";
import type { DayData } from "./use-calendar-days";

const ALERT = "mx-4 my-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-cal-alert/40 px-3 py-2 text-sm text-cal-alert";
const NOTE = "mx-4 my-2 block text-sm";

function lastFetch(updatedAt: number) {
  return updatedAt > 0 ? <span className="ml-1">前回の取得: {formatDateTime(new Date(updatedAt).toISOString())}</span> : null;
}

/**
 * The opaque strip under the bar. A failed or capped day is said in words and
 * never shown as free time (UX-21); Google and LINE notices stay as on the
 * current calendar (UX-26). Loading is not said here but in the day header:
 * a line that comes and goes on every page of days would shift the grid under
 * the user's finger.
 */
export function CalendarNotices({
  days,
  dayName,
  noResourceStores,
  noHoursStores,
  closuresUnknownStores,
  settings,
  weekNeedsStore,
  onRetried,
}: Readonly<{
  days: readonly DayData[];
  dayName: (dateKey: string) => string;
  // Stores whose columns offer no slots, and why (UX-21).
  noResourceStores: readonly string[];
  noHoursStores: readonly string[];
  closuresUnknownStores: readonly string[];
  settings: Readonly<{ failed: boolean; hadData: boolean; updatedAt: number; refetch: () => void }>;
  weekNeedsStore: boolean;
  // The retry button goes away once its alert clears, so focus moves elsewhere first.
  onRetried: () => void;
}>) {
  const failed = days.filter((day) => day.failed.length > 0);
  const capped = days.filter((day) => day.capped && day.failed.length === 0);
  // One sentence per kind of failure, so a booking refresh failing on one day and
  // a first block load on another are not merged into one claim (UX-21).
  const kinds = new Map<string, string[]>();
  for (const day of failed) {
    const kind = day.failed.join("・");
    kinds.set(kind, [...(kinds.get(kind) ?? []), dayName(day.dateKey)]);
  }
  const failedUpdatedAt = failed.reduce((oldest, day) => (day.updatedAt > 0 ? Math.min(oldest, day.updatedAt) : oldest), Number.POSITIVE_INFINITY);
  return (
    // Capped and scrollable: on a short screen several alerts must not cover the
    // grid or push their own retry buttons out of reach.
    <div data-calendar-notices="" className="pointer-events-auto max-h-[40dvh] overflow-y-auto overscroll-contain bg-cal-surface">
      <ScheduleSyncAttention />
      {settings.failed && (
        <div role="alert" className={ALERT}>
          <span>
            店舗設定の{settings.hadData ? "更新" : "読み込み"}に失敗しました。空き状況を表示できません。
            {lastFetch(settings.updatedAt)}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              settings.refetch();
              onRetried();
            }}
          >
            再読み込み
          </Button>
        </div>
      )}
      {failed.length > 0 && (
        <div role="alert" className={ALERT}>
          <span>
            {[...kinds].map(([kind, names]) => (
              <span key={kind} className="block">
                {names.join("・")}の{kind}に失敗しました。
              </span>
            ))}
            空き状況を表示できません。
            {lastFetch(Number.isFinite(failedUpdatedAt) ? failedUpdatedAt : 0)}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              for (const day of failed) day.refetch();
              onRetried();
            }}
          >
            再読み込み
          </Button>
        </div>
      )}
      {/* One polite region, always there: a live region announces changes to its
          content, not its own arrival (ARIA22), and these must not cut into what a
          screen reader is reading. The failures above are alerts. */}
      <output className="block">
        {weekNeedsStore && <span className={NOTE}>週表示は店舗を1つ選ぶと使えます。上部の店舗の切り替えで選んでください。</span>}
        {noResourceStores.length > 0 && (
          <span className={NOTE}>
            {noResourceStores.join("・")}には予約を受ける枠（リソース）がありません。設定で追加すると、空いた時間から予約を作れます。
          </span>
        )}
        {noHoursStores.length > 0 && (
          <span className={NOTE}>
            {noHoursStores.join("・")}は営業時間が未設定のため、予約を受け付けていません。店舗設定で営業する曜日と時間を保存してください。
          </span>
        )}
        {closuresUnknownStores.length > 0 && (
          <span className={ALERT}>
            {closuresUnknownStores.join("・")}の休業が読み込める上限の件数に達しました。読み込めていない休業がある可能性があるため、空いた時間は表示していません。
          </span>
        )}
        {capped.length > 0 && (
          <span className={ALERT}>
            {capped.map((day) => dayName(day.dateKey)).join("・")}
            の予定が表示できる上限の件数に達しました。表示されていない予定がある可能性があるため、空いた時間は表示していません。
          </span>
        )}
      </output>
    </div>
  );
}
