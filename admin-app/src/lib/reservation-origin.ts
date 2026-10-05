// 予約の「出所(origin)」と技術的 source の表示ラベル（純粋関数・DRY）。
// origin は手入力予約の minimo/店頭/その他。過去の電話受付は表示のみ残す。
// source は不変の技術キー（phone_admin/admin/web_line）で、UI には生値ではなく
// 日本語ラベルを出す。
//
// 単一の真実: 作成パネル(Task 7)と詳細パネル(Task 8)が両方このモジュールを使う。

// Single source of truth lives in @/types/api; import locally for the type
// annotations below.
import type { CreateReservationOrigin, ReservationOrigin } from "@/types/api";

const ORIGIN_LABELS: Record<ReservationOrigin, string> = {
  minimo: "minimo",
  phone: "電話",
  walk_in: "店頭",
  other: "その他",
};

export const RESERVATION_ORIGIN_OPTIONS: ReadonlyArray<{
  value: CreateReservationOrigin;
  label: string;
}> = [
  { value: "minimo", label: ORIGIN_LABELS.minimo },
  { value: "walk_in", label: ORIGIN_LABELS.walk_in },
  { value: "other", label: ORIGIN_LABELS.other },
];

export function reservationOriginLabel(origin: string | null): string | null {
  // hasOwnProperty.call (not `in`) so prototype keys ("toString"/"constructor")
  // never match and return undefined / a function. (gemini hardening)
  if (origin && Object.hasOwn(ORIGIN_LABELS, origin)) {
    return ORIGIN_LABELS[origin as ReservationOrigin];
  }
  return null;
}

const SOURCE_LABELS: Record<string, string> = {
  phone_admin: "手動予約",
  admin: "手動予約",
  web_line: "LINE予約",
  system_import: "システム取込",
};

export function reservationSourceLabel(source: string): string {
  // hasOwnProperty.call guards against prototype keys ("toString") returning a
  // function instead of a label. (gemini hardening)
  return Object.hasOwn(SOURCE_LABELS, source)
    ? SOURCE_LABELS[source]
    : source;
}
