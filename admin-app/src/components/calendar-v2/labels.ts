import { WEEKDAYS, toJstDate } from "@/lib/timeline";

function parts(date: Date) {
  const jst = toJstDate(date);
  return { year: jst.getUTCFullYear(), month: jst.getUTCMonth() + 1, day: jst.getUTCDate(), weekday: WEEKDAYS[jst.getUTCDay()] };
}

/** 11月20日（金） */
export function dayLabel(date: Date): string {
  const { month, day, weekday } = parts(date);
  return `${month}月${day}日（${weekday}）`;
}

/** 11/20（金）, for the phone's bar. */
export function shortDayLabel(date: Date): string {
  const { month, day, weekday } = parts(date);
  return `${month}/${day}（${weekday}）`;
}

/** 2026年11月, or 2026年11月 – 12月 and 2026年12月 – 2027年1月 when the week crosses. */
export function weekHeading(days: readonly Date[]): string {
  const first = parts(days[0]);
  const last = parts(days.at(-1) ?? days[0]);
  if (first.year !== last.year) return `${first.year}年${first.month}月 – ${last.year}年${last.month}月`;
  if (first.month !== last.month) return `${first.year}年${first.month}月 – ${last.month}月`;
  return `${first.year}年${first.month}月`;
}

export function weekdayOf(date: Date): string {
  return parts(date).weekday;
}

export function dayOfMonth(date: Date): number {
  return parts(date).day;
}
