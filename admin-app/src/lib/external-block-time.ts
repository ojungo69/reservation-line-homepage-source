/**
 * 外部ブロック作成フォーム用の日時変換ヘルパー。
 *
 * backend `createAdminExternalBlock` (src/admin/external-blocks.ts) は startAt/endAt が
 * 5分境界の ISO 文字列 (秒・ミリ秒 = 0、分 % 5 = 0) であることを要求する。`parseSlotBoundary`
 * を満たさない値は `invalid_time` で reject されるため、フロント側で同じ制約を検証してから
 * POST する。SSR 版 `buildExternalBlockCreateRequest` (public/admin/shared.js) と同等の責務。
 *
 * 入力は `<input type="datetime-local">` の値 (`YYYY-MM-DDTHH:mm`、JST ローカル時刻) を想定する。
 */

const SLOT_INTERVAL_MINUTES = 5;

export type ExternalBlockTimeResult =
  | { ok: true; startAt: string; endAt: string }
  | {
      ok: false;
      reason:
        | "missing_start"
        | "missing_end"
        | "invalid_start"
        | "invalid_end"
        | "not_slot_boundary"
        | "invalid_range";
    };

/**
 * `YYYY-MM-DDTHH:mm` (JST ローカル) を UTC ISO 文字列に変換する。
 * 不正フォーマットや存在しない日時は undefined を返す。
 */
function localToIso(local: string): string | undefined {
  // datetime-local は分単位（YYYY-MM-DDTHH:mm）。秒付きは黙って切り捨てず拒否する。
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match) return undefined;
  const [, y, mo, d, h, mi] = match;
  // JST (+09:00) として解釈し、UTC ISO に正規化する。
  const iso = `${y}-${mo}-${d}T${h}:${mi}:00+09:00`;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return undefined;
  const date = new Date(ms);
  if (date.getUTCSeconds() !== 0 || date.getUTCMilliseconds() !== 0) return undefined;
  // Date.parse は範囲外を黙って巻き戻す: 時刻 (25:00) は NaN になり上の Number.isFinite で
  // 弾けるが、存在しない暦日 (2/30 → 3/2、平年 2/29 → 3/1、4/31 → 5/1) は finite な別日に
  // wrap してしまう。JST 壁時計を再構成して入力要素と一致するか検証し、wrap を拒否する。
  const jst = new Date(ms + 9 * 60 * 60 * 1000);
  if (
    jst.getUTCFullYear() !== Number(y) ||
    jst.getUTCMonth() + 1 !== Number(mo) ||
    jst.getUTCDate() !== Number(d) ||
    jst.getUTCHours() !== Number(h) ||
    jst.getUTCMinutes() !== Number(mi)
  ) {
    return undefined;
  }
  return date.toISOString();
}

/** ISO 文字列が backend の 5分スロット境界制約を満たすか。 */
function isSlotBoundary(iso: string): boolean {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return false;
  if (date.getUTCSeconds() !== 0 || date.getUTCMilliseconds() !== 0) return false;
  return date.getUTCMinutes() % SLOT_INTERVAL_MINUTES === 0;
}

/**
 * フォームの開始/終了ローカル日時を検証し、backend POST 用の ISO ペアを返す。
 * 端末バリデーションは backend を信頼の境界とした上での UX 補助 (二重防御)。
 */
export function buildExternalBlockTimes(
  startLocal: string,
  endLocal: string,
): ExternalBlockTimeResult {
  if (!startLocal) return { ok: false, reason: "missing_start" };
  if (!endLocal) return { ok: false, reason: "missing_end" };

  const startAt = localToIso(startLocal);
  if (!startAt) return { ok: false, reason: "invalid_start" };
  const endAt = localToIso(endLocal);
  if (!endAt) return { ok: false, reason: "invalid_end" };

  if (!isSlotBoundary(startAt) || !isSlotBoundary(endAt)) {
    return { ok: false, reason: "not_slot_boundary" };
  }

  if (Date.parse(endAt) <= Date.parse(startAt)) {
    return { ok: false, reason: "invalid_range" };
  }

  return { ok: true, startAt, endAt };
}

export const EXTERNAL_BLOCK_TIME_MESSAGES: Record<
  Exclude<ExternalBlockTimeResult, { ok: true }>["reason"],
  string
> = {
  missing_start: "開始日時を入力してください",
  missing_end: "終了日時を入力してください",
  invalid_start: "開始日時が正しくありません",
  invalid_end: "終了日時が正しくありません",
  not_slot_boundary: "時刻は5分単位で指定してください",
  invalid_range: "終了日時は開始日時より後にしてください",
};
