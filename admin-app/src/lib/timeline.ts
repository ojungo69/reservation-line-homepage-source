import type { BusinessHour } from "@/types/api";

export type TimeSlot = {
  time: string;
  label: string;
  minutes: number;
};

export const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

// 曜日インデックス (0=日 … 6=土) の選択トグル。数値昇順を保つ。
// sort() の既定は文字列比較なので、数値配列では comparator が必須。
export function toggleWeekday(selected: number[], day: number): number[] {
  return selected.includes(day)
    ? selected.filter((d) => d !== day)
    : [...selected, day].sort((a, b) => a - b);
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function toJstDate(date: Date | string): Date {
  const d = typeof date === "string" ? new Date(date) : date;
  return new Date(d.getTime() + JST_OFFSET_MS);
}

export function formatJstDate(date: Date): string {
  const jst = toJstDate(date);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jst.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function jstWeekday(date: Date): number {
  return toJstDate(date).getUTCDay();
}

export function formatTime(iso: string): string {
  const jst = toJstDate(iso);
  const h = String(jst.getUTCHours()).padStart(2, "0");
  const m = String(jst.getUTCMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

// 「M/D HH:MM」の JST 表示。null は "—" に落とすので、呼び出し側で
// nullable な同期タイムスタンプ (lastSeenAt / expiresAt など) をそのまま渡せる。
export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDateDisplay(date: Date): string {
  const jst = toJstDate(date);
  const weekdays = WEEKDAYS;
  const m = jst.getUTCMonth() + 1;
  const d = jst.getUTCDate();
  const w = weekdays[jst.getUTCDay()];
  return `${m}月${d}日 (${w})`;
}

// Render a fixed full-day window (00:00–24:00). The grid no longer narrows to
// business hours; instead `getInitialScrollMinutes` scrolls the view to the
// open time on mount/day-change. `businessHours`/`weekday`/`storeId` are kept
// in the signature for the (unchanged) call site and for future highlighting.
export function getTimeSlots(
  _businessHours: BusinessHour[],
  _weekday: number,
  _storeId: string | null,
): TimeSlot[] {
  return buildSlots(0, 24 * 60);
}

function parseHHMM(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

// Minute-of-day the schedule view should scroll to on mount/day-change:
// the earliest active open time for the weekday/store, else 09:00 (540).
export function getInitialScrollMinutes(
  businessHours: BusinessHour[],
  weekday: number,
  storeId: string | null,
): number {
  const matching = businessHours.filter(
    (b) => b.active && b.weekday === weekday && (!storeId || b.storeId === storeId),
  );
  if (matching.length === 0) return 9 * 60;
  let earliest = 24 * 60;
  for (const b of matching) {
    const open = parseHHMM(b.opensAt);
    if (open < earliest) earliest = open;
  }
  return earliest;
}

function buildSlots(startMinutes: number, endMinutes: number): TimeSlot[] {
  const slots: TimeSlot[] = [];
  for (let m = startMinutes; m < endMinutes; m += 15) {
    const h = Math.floor(m / 60);
    const min = m % 60;
    slots.push({
      time: `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`,
      label: min === 0 ? `${h}:00` : "",
      minutes: m,
    });
  }
  return slots;
}

export function getCardStyle(
  startAt: string,
  endAt: string,
  dayStartMinutes: number,
  dayEndMinutes: number,
  dayDateKey?: string,
): { top: string; height: string; minutes: number } | null {
  let startMin: number;
  let endMin: number;

  if (dayDateKey) {
    const dayStartMs = Date.parse(`${dayDateKey}T00:00:00+09:00`);
    const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000;
    const clippedStartMs = Math.max(Date.parse(startAt), dayStartMs);
    const clippedEndMs = Math.min(Date.parse(endAt), dayEndMs);
    const clippedStartJst = toJstDate(new Date(clippedStartMs));
    const clippedEndJst = toJstDate(new Date(clippedEndMs));
    const rawStartMin = clippedStartJst.getUTCHours() * 60 + clippedStartJst.getUTCMinutes();
    const rawEndMin = clippedEndJst.getUTCHours() * 60 + clippedEndJst.getUTCMinutes();
    const adjustedEndMin = rawEndMin === 0 && clippedEndMs > dayStartMs ? 24 * 60 : rawEndMin;
    startMin = Math.max(rawStartMin, dayStartMinutes);
    endMin = Math.min(adjustedEndMin, dayEndMinutes);
  } else {
    const startJst = toJstDate(startAt);
    const endJst = toJstDate(endAt);
    startMin = Math.max(startJst.getUTCHours() * 60 + startJst.getUTCMinutes(), dayStartMinutes);
    // 終了が深夜0:00 (= 0分) のときは「閉店」ではなく翌日0:00 (24*60) として扱う。
    // `|| dayEndMinutes` だと 0 が falsy になり、誤って閉店時刻に置き換わる。
    const rawEnd = endJst.getUTCHours() * 60 + endJst.getUTCMinutes();
    endMin = Math.min(rawEnd === 0 ? 24 * 60 : rawEnd, dayEndMinutes);
  }

  if (endMin <= startMin) return null;

  const totalMinutes = dayEndMinutes - dayStartMinutes;
  const topPct = ((startMin - dayStartMinutes) / totalMinutes) * 100;
  const heightPct = ((endMin - startMin) / totalMinutes) * 100;

  return {
    top: `${Math.max(0, topPct)}%`,
    height: `${Math.max(1, heightPct)}%`,
    // 表示窓で clip 済みの分数。カードの行出し分けは予約の総施術時間ではなく
    // 実際に描画される高さ (= この分数 × slotPx/15) を基準にする — 営業時間
    // 短縮などで clip された予約が全行を描画して溢れないため (codex P2)。
    minutes: endMin - startMin,
  };
}

const STATUS_COLORS: Record<string, string> = {
  pending_approval: "bg-amber-100 border-amber-400 text-amber-900 dark:bg-amber-950 dark:border-amber-600 dark:text-amber-100",
  confirmed: "bg-blue-100 border-blue-400 text-blue-900 dark:bg-blue-950 dark:border-blue-600 dark:text-blue-100",
  completed: "bg-green-100 border-green-400 text-green-900 dark:bg-green-950 dark:border-green-600 dark:text-green-100",
  // text-gray-500 on bg-gray-100 is 4.39:1 — just below WCAG AA 4.5 (caught by
  // the OKLCH-aware contrast gate). gray-600 keeps the muted look and passes.
  cancelled_by_admin: "bg-gray-100 border-gray-300 text-gray-600 line-through dark:bg-gray-900 dark:border-gray-600 dark:text-gray-400",
  cancelled_by_customer: "bg-gray-100 border-gray-300 text-gray-600 line-through dark:bg-gray-900 dark:border-gray-600 dark:text-gray-400",
  // 却下はキャンセル系の灰色と区別する (店側の意思決定を要したステータスのため一覧で目立たせる)
  rejected: "bg-orange-100 border-orange-400 text-orange-900 dark:bg-orange-950 dark:border-orange-600 dark:text-orange-100",
  no_show: "bg-red-100 border-red-400 text-red-900 dark:bg-red-950 dark:border-red-600 dark:text-red-100",
  // text-gray-400 on bg-gray-100 is ~2.3:1 — below WCAG AA. Keep expired no lighter
  // than the cancelled pair above so the visual hierarchy holds.
  expired: "bg-gray-100 border-gray-300 text-gray-600 dark:bg-gray-900 dark:border-gray-600 dark:text-gray-300",
  checked_in: "bg-indigo-100 border-indigo-400 text-indigo-900 dark:bg-indigo-950 dark:border-indigo-600 dark:text-indigo-100",
};

export function statusColor(status: string): string {
  return STATUS_COLORS[status] ?? "bg-muted border-border text-foreground";
}

export function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending_approval: "承認待ち",
    confirmed: "確定",
    completed: "完了",
    cancelled_by_admin: "管理者キャンセル",
    cancelled_by_customer: "顧客キャンセル",
    rejected: "却下",
    no_show: "来店なし",
    expired: "期限切れ",
    checked_in: "来店中",
  };
  return labels[status] ?? status;
}

// 来店実績のステータスは予約とは別の語彙 (valid / voided)。予約用の statusLabel に
// 相乗りさせると未知の値が英語のまま素通りする (実際に "valid" が画面に出ていた)。
export function visitStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    valid: "有効",
    voided: "無効",
  };
  return labels[status] ?? status;
}

// スケジュール(カレンダー)で非表示にする終了状態。キャンセル/却下/来店なし/
// 期限切れは枠を占有せず、残し続けると視認性を損なうため一覧から除外する。
// 履歴は予約管理ページのステータス絞り込みで確認できる。
const SCHEDULE_HIDDEN_STATUSES = new Set([
  "cancelled_by_admin",
  "cancelled_by_customer",
  "rejected",
  "no_show",
  "expired",
]);

// スケジュールの日表示・週表示で予約カードを描画してよいか。day/week 両方が
// この単一ヘルパーを参照し、片方だけ条件が漏れるのを防ぐ。
export function isScheduleVisibleReservationStatus(status: string): boolean {
  return !SCHEDULE_HIDDEN_STATUSES.has(status);
}

// 「次回予約」ショートカットは来店が"終わってから"のみ案内する。completed /
// no_show だけが対象で、checked_in(来店中=complete/no_show 未確定)や
// confirmed / pending_approval / cancelled では出さない。inline 条件が
// checked_in を含む形にドリフトしていた(B14)ため、純粋ヘルパーに切り出して
// ユニットテストで回帰を防ぐ。
export function isRebookableStatus(status: string): boolean {
  return status === "completed" || status === "no_show";
}

// epoch + 固定 24h 加算。local `setDate` 加算は DST のあるブラウザ TZ で
// DST 境界を跨ぐと実加算が 23h/25h になり JST 日付がずれる (JST 自体は
// DST 無しなので epoch 加算で常に正しい)。回帰は timeline.test.ts 参照。
export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

export function isSameDay(a: Date, b: Date): boolean {
  return formatJstDate(a) === formatJstDate(b);
}

// 完全表記の JST 日付文字列 (例: "2026年7月21日 (火)")。formatDateDisplay
// (年なしの短縮表記) と違い、ミニカレンダーや週表示の aria-label など
// 「どの年月日か」を単独で特定する必要がある文脈で使う。
export function formatFullJstDate(date: Date): string {
  const jst = toJstDate(date);
  const y = jst.getUTCFullYear();
  const m = jst.getUTCMonth() + 1;
  const d = jst.getUTCDate();
  const w = WEEKDAYS[jst.getUTCDay()];
  return `${y}年${m}月${d}日 (${w})`;
}

// anchor の JST 月 (+ monthOffset ヶ月) の 1日 00:00 JST を表す Date。
// Date.UTC の月インデックス正規化に任せるため年またぎも local getter 無しで正しい。
export function firstOfJstMonth(anchor: Date, monthOffset = 0): Date {
  const jst = toJstDate(anchor);
  return new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth() + monthOffset, 1) - JST_OFFSET_MS);
}

// ミニカレンダー用の月グリッド: anchor の月を含む、日曜始まり・前後月を含む
// 42 セル (6週) 固定の Date 配列。local getter (getDate 等) を使わず
// toJstDate/addDays/jstWeekday 経由で JST に固定する (ブラウザ TZ 非依存)。
export function getMonthGrid(anchor: Date): Date[] {
  const firstOfMonth = firstOfJstMonth(anchor);
  const gridStart = addDays(firstOfMonth, -jstWeekday(firstOfMonth));
  return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
}

export function currentTimePosition(
  dayStartMinutes: number,
  dayEndMinutes: number,
): number | null {
  const now = toJstDate(new Date());
  const currentMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (currentMin < dayStartMinutes || currentMin > dayEndMinutes) return null;
  return ((currentMin - dayStartMinutes) / (dayEndMinutes - dayStartMinutes)) * 100;
}
