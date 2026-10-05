// LINE Messaging API の薄いラッパ（friend 一覧/プロフィール）。DB/サービス層から
// 隔離し、注入可能な fetcher でテストできるようにする。token は呼び出し元が
// env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN を渡す（サーバ側のみ）。
const LINE_FOLLOWERS_IDS_ENDPOINT = "https://api.line.me/v2/bot/followers/ids";
const LINE_PROFILE_ENDPOINT = "https://api.line.me/v2/bot/profile";

export type LineFollowerIdsPage = { userIds: string[]; next: string | null };

export const fetchLineFollowerIds = async (input: {
  token: string;
  start?: string;
  limit?: number;
  fetcher?: typeof fetch;
}): Promise<LineFollowerIdsPage> => {
  const fetcher = input.fetcher ?? fetch.bind(globalThis);
  const url = new URL(LINE_FOLLOWERS_IDS_ENDPOINT);
  // limit は最大 1000。基本は1ページで全友だちを取得できる（200人規模なら確実）。
  url.searchParams.set("limit", String(input.limit ?? 1000));
  if (input.start) url.searchParams.set("start", input.start);
  const res = await fetcher(url.toString(), { headers: { Authorization: `Bearer ${input.token}` } });
  if (!res.ok) throw new Error(`line_followers_ids_failed:${res.status}`);
  const body = await res.json<{ userIds?: unknown; next?: unknown }>();
  const userIds = Array.isArray(body.userIds)
    ? body.userIds.filter((v): v is string => typeof v === "string")
    : [];
  const next = typeof body.next === "string" && body.next.length > 0 ? body.next : null;
  return { userIds, next };
};

// Code-point-aware truncation so multi-byte characters / emoji / surrogate pairs
// (common in LINE display names) are never split at the boundary into a lone
// surrogate. Fast-path returns the original string when already within `max`.
const truncateCodePoints = (value: string, max: number): string => {
  const codePoints = Array.from(value);
  return codePoints.length <= max ? value : codePoints.slice(0, max).join("");
};

export type LineProfileResult =
  | { ok: true; displayName: string; pictureUrl: string | null }
  | { ok: false; unavailable: true };

export const fetchLineProfile = async (input: {
  token: string;
  lineUserId: string;
  fetcher?: typeof fetch;
}): Promise<LineProfileResult> => {
  const fetcher = input.fetcher ?? fetch.bind(globalThis);
  const res = await fetcher(`${LINE_PROFILE_ENDPOINT}/${encodeURIComponent(input.lineUserId)}`, {
    headers: { Authorization: `Bearer ${input.token}` }
  });
  // 恒久失敗は 404 のみ（無効 userId / 未友だち）。401/403/429/5xx は一時的
  // 失敗として throw し、呼び出し側で pending のまま残す（次回再試行）。
  if (res.status === 404) return { ok: false, unavailable: true };
  if (!res.ok) throw new Error(`line_profile_failed:${res.status}`);
  const body = await res.json<{ displayName?: unknown; pictureUrl?: unknown }>();
  const displayName = typeof body.displayName === "string" ? truncateCodePoints(body.displayName, 120) : "";
  const pictureUrl = typeof body.pictureUrl === "string" ? truncateCodePoints(body.pictureUrl, 2048) : null;
  return { ok: true, displayName, pictureUrl };
};
