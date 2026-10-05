import { adminWriteGuard, adminWriteWasRevoked, assertAdminWriteCurrent } from "./write-authorization";
import type { AdminUser } from "./access";
import { isActorTypeBatchError, isAdminPrivileged, storeExists, sha256Hex, trimAndCap, MAX_ID_LENGTH } from "./settings-common";
import { escapeLikePattern, exceedsLikePatternBudget, normalizePhone } from "./shared";
import { fetchLineFollowerIds, fetchLineProfile } from "../line/friends-api";

// U + 32 hex（LINE user id）。紐付け対象を厳格に検証する。
export const LINE_USER_ID_RE = /^U[0-9a-f]{32}$/;

// --- subrequest 予算（本番は Workers Paid: DO+Queues 使用 ⇒ 1000/request）---
// 1 sync の最悪 subrequest ≈ followers/ids 1〜数回 + profile 最大50 fetch
// + D1(ids upsert batch ×ページ数 / select / updates batch / count) 数回 ≈ 60 未満。
const FOLLOWER_IDS_PAGE_LIMIT = 1000; // 基本1ページで全件
const MAX_FOLLOWER_PAGES_PER_SYNC = 5; // 安全弁（最大 5000 id）
const MAX_PROFILE_FETCH_PER_SYNC = 50; // 残りは再押下で続行（resumable）
const LIST_PAGE_SIZE = 50;
// 1ページ最大1000件の followers/ids を1回の db.batch に積むと、batch 全体の
// 30秒/リクエストサイズ上限に近づく。Cloudflare の大量書込みチャンク化推奨に従い
// 100件ずつに分割して batch する（各文は3バインドで per-query 100バインド上限も余裕）。
const DIRECTORY_UPSERT_BATCH_SIZE = 100;
export type LinkLineFriendRequest =
  | { mode: "new"; storeId: string; newCustomer: { displayName: string; displayNameKana?: string; phone?: string } }
  | { mode: "existing"; storeId: string; customerId: string };

export const parseLinkLineFriendRequest = (body: unknown): LinkLineFriendRequest | null => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const raw = body as Record<string, unknown>;
  const storeId = trimAndCap(raw.storeId, MAX_ID_LENGTH);
  if (!storeId) return null;

  if (raw.mode === "existing") {
    const customerId = trimAndCap(raw.customerId, MAX_ID_LENGTH);
    if (!customerId) return null;
    return { mode: "existing", storeId, customerId };
  }
  if (raw.mode === "new") {
    if (typeof raw.newCustomer !== "object" || raw.newCustomer === null) return null;
    const nc = raw.newCustomer as Record<string, unknown>;
    const displayName = trimAndCap(nc.displayName, 120);
    if (!displayName) return null;
    const displayNameKana =
      nc.displayNameKana == null ? undefined : trimAndCap(nc.displayNameKana, 120) ?? undefined;
    // phone は service 側で normalize 検証する（無効なら invalid_request）。
    const phone = typeof nc.phone === "string" && nc.phone.trim().length > 0 ? nc.phone : undefined;
    return { mode: "new", storeId, newCustomer: { displayName, displayNameKana, phone } };
  }
  return null;
};

// ── 同期 ───────────────────────────────────────────────────────────
// followers/ids（limit=1000・基本1ページ全件）→ directory に UPSERT し、
// pending のプロフィールを最大 N 件取得してキャッシュ（resumable）。
// profile の恒久失敗は 404 のみ（friends-api 参照）。401/403/429/5xx は throw され
// catch で failed を集計しつつ pending を維持する（次回再試行）。

export type SyncLineFriendsResult =
  | { ok: true; totalFriends: number; fetched: number; pending: number; unavailable: number; failed: number }
  | { ok: false; error: "forbidden" | "line_api_error" };

type SyncLineFriendsInput = {
  db: D1Database;
  admin: AdminUser;
  channelId: string; // env.LINE_CHANNEL_ID
  token: string; // env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN
  now?: () => number;
  fetcher?: typeof fetch;
};

// 1) followers/ids を取り込み（基本1ページ・最大 MAX_FOLLOWER_PAGES_PER_SYNC）→ UPSERT。
const importLineFollowerIds = async (
  input: SyncLineFriendsInput,
  nowIso: string
): Promise<{ ok: true } | { ok: false; error: "line_api_error" | "forbidden" }> => {
  try {
    let start: string | undefined;
    for (let page = 0; page < MAX_FOLLOWER_PAGES_PER_SYNC; page++) {
      await assertAdminWriteCurrent(input.db, input.admin);
      const { userIds, next } = await fetchLineFollowerIds({
        token: input.token,
        start,
        limit: FOLLOWER_IDS_PAGE_LIMIT,
        fetcher: input.fetcher
      });
      const stmts = userIds
        .filter((id) => LINE_USER_ID_RE.test(id))
        .map((id) =>
          input.db
            .prepare(
              `INSERT INTO line_friend_directory (channel_id, line_user_id, last_synced_at)
               VALUES (?, ?, ?)
               ON CONFLICT(channel_id, line_user_id) DO UPDATE SET last_synced_at = excluded.last_synced_at`
            )
            .bind(input.channelId, id, nowIso)
        );
      // 100件ずつ分割して batch（1000件/ページでも 30s/サイズ上限に収める）。
      for (let i = 0; i < stmts.length; i += DIRECTORY_UPSERT_BATCH_SIZE) {
        await input.db.batch([adminWriteGuard(input.db, input.admin), ...stmts.slice(i, i + DIRECTORY_UPSERT_BATCH_SIZE)]);
      }
      if (!next) break;
      start = next;
    }
    return { ok: true };
  } catch (error) {
    if (await adminWriteWasRevoked(input.db, input.admin, error)) return { ok: false, error: "forbidden" };
    console.error("syncLineFriendDirectory: followers/ids failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    // best-effort 失敗監査（誰が実行したか追跡可能に・PII本体なし）。先行ページの
    // upsert が部分的に済んだ失敗 sync でも actor を audit_logs から追える。
    try {
      await input.db.batch([adminWriteGuard(input.db, input.admin), input.db.prepare(
          `INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, metadata_json)
           VALUES (?, 'staff', ?, 'line_friend.sync_failed', 'line_friend_directory', ?, ?)`
        )
        .bind(
          crypto.randomUUID(),
          input.admin.id,
          input.channelId,
          JSON.stringify({ stage: "followers_ids", adminRole: input.admin.role })
        )]);
    } catch (auditError) {
      if (await adminWriteWasRevoked(input.db, input.admin, auditError)) return { ok: false, error: "forbidden" };
      // 監査は best-effort（D1 障害中でも line_api_error を返す）。
    }
    return { ok: false, error: "line_api_error" };
  }
};

// 2) profile_status='pending' を最大 N 件だけ取得（再押下で続行）。fetch は逐次、
//    UPDATE 文をまとめて返し、呼び出し側が最後に1回 db.batch で適用（D1 subrequest 削減）。
const fetchPendingProfileUpdates = async (
  input: SyncLineFriendsInput,
  nowIso: string
): Promise<{ updates: D1PreparedStatement[]; failed: number }> => {
  const pending = await input.db
    .prepare(
      `SELECT line_user_id FROM line_friend_directory
       WHERE channel_id = ? AND profile_status = 'pending'
       ORDER BY first_seen_at ASC LIMIT ?`
    )
    .bind(input.channelId, MAX_PROFILE_FETCH_PER_SYNC)
    .all<{ line_user_id: string }>();

  const updates: D1PreparedStatement[] = [];
  let failed = 0; // この回の一時失敗件数（401/403/429/5xx）。UI で運用者に警告する。
  for (const r of pending.results ?? []) {
    await assertAdminWriteCurrent(input.db, input.admin);
    let profile;
    try {
      profile = await fetchLineProfile({ token: input.token, lineUserId: r.line_user_id, fetcher: input.fetcher });
    } catch (error) {
      // 401/403/429/5xx → pending のまま（次回再試行）。失敗件数を集計。
      failed++;
      console.error("syncLineFriendDirectory: profile fetch failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      continue;
    }
    if (profile.ok) {
      updates.push(
        input.db
          .prepare(
            `UPDATE line_friend_directory
             SET display_name = ?, picture_url = ?, profile_status = 'fetched', profile_fetched_at = ?
             WHERE channel_id = ? AND line_user_id = ?`
          )
          .bind(profile.displayName, profile.pictureUrl, nowIso, input.channelId, r.line_user_id)
      );
    } else {
      updates.push(
        input.db
          .prepare(
            `UPDATE line_friend_directory
             SET profile_status = 'unavailable', profile_fetched_at = ?
             WHERE channel_id = ? AND line_user_id = ?`
          )
          .bind(nowIso, input.channelId, r.line_user_id)
      );
    }
  }
  return { updates, failed };
};

export const syncLineFriendDirectory = async (input: SyncLineFriendsInput): Promise<SyncLineFriendsResult> => {
  if (!isAdminPrivileged(input.admin.role)) return { ok: false, error: "forbidden" };
  if (!input.channelId || !input.token) return { ok: false, error: "line_api_error" };
  try {
    const nowIso = new Date((input.now ?? Date.now)()).toISOString();

    const imported = await importLineFollowerIds(input, nowIso);
    if (!imported.ok) return imported;

    const { updates, failed } = await fetchPendingProfileUpdates(input, nowIso);
    if (updates.length > 0) await input.db.batch([adminWriteGuard(input.db, input.admin), ...updates]);

    // 3) カウント集計。
    const counts = await input.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN profile_status = 'fetched' THEN 1 ELSE 0 END) AS fetched,
           SUM(CASE WHEN profile_status = 'pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN profile_status = 'unavailable' THEN 1 ELSE 0 END) AS unavailable
         FROM line_friend_directory WHERE channel_id = ?`
      )
      .bind(input.channelId)
      .first<{ total: number; fetched: number; pending: number; unavailable: number }>();

    const totalFriends = Number(counts?.total ?? 0);
    const fetchedCount = Number(counts?.fetched ?? 0);
    const pendingCount = Number(counts?.pending ?? 0);
    const unavailableCount = Number(counts?.unavailable ?? 0);

    // 監査: 誰が・いつ directory を同期し LINE プロフィール PII をキャッシュしたかを記録。
    // PII 本体（表示名・アイコンURL）は載せず、件数サマリと channelId のみ。
    await input.db.batch([adminWriteGuard(input.db, input.admin), input.db.prepare(
        `INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, metadata_json)
         VALUES (?, 'staff', ?, 'line_friend.sync', 'line_friend_directory', ?, ?)`
      )
      .bind(
        crypto.randomUUID(),
        input.admin.id,
        input.channelId,
        JSON.stringify({
          totalFriends,
          fetched: fetchedCount,
          pending: pendingCount,
          unavailable: unavailableCount,
          failed,
          adminRole: input.admin.role
        })
      )]);

    return {
      ok: true,
      totalFriends,
      fetched: fetchedCount,
      pending: pendingCount,
      unavailable: unavailableCount,
      failed
    };
  } catch (error) {
    if (await adminWriteWasRevoked(input.db, input.admin, error)) return { ok: false, error: "forbidden" };
    throw error;
  }
};

// ── 一覧 ───────────────────────────────────────────────────────────
// 紐付け済み判定は line_identities との JOIN で導出（directory に重複保存しない）。

export type LineFriendListItem = {
  lineUserId: string;
  displayName: string | null;
  pictureUrl: string | null;
  profileStatus: "pending" | "fetched" | "unavailable";
  linked: boolean;
  linkedCustomerId: string | null;
};

export type ListLineFriendsResult =
  | { ok: true; items: LineFriendListItem[]; total: number; page: number; pageSize: number }
  | { ok: false; error: "forbidden" | "invalid_request" };

type FriendListRow = {
  line_user_id: string;
  display_name: string | null;
  picture_url: string | null;
  profile_status: LineFriendListItem["profileStatus"];
  identity_id: string | null;
  customer_id: string | null;
};

export const listLineFriends = async (input: {
  db: D1Database;
  admin: AdminUser;
  channelId: string;
  filter?: "unlinked" | "linked" | "all";
  query?: string;
  page?: number;
}): Promise<ListLineFriendsResult> => {
  if (!isAdminPrivileged(input.admin.role)) return { ok: false, error: "forbidden" };
  const filter = input.filter ?? "unlinked";
  const page = Number.isInteger(input.page) && (input.page as number) > 0 ? (input.page as number) : 1;
  const q = (input.query ?? "").trim();

  // SQLite/D1 では ESCAPE 式は単一文字でなければならない。String.raw で
  // `ESCAPE '\'`（バックスラッシュ1文字）を渡す（src/admin/customers.ts と同方式）。
  let likeClause = "";
  let likeBind: string[] = [];
  if (q) {
    const pattern = `%${escapeLikePattern(q)}%`;
    // D1 の LIKE パターン 50 bytes 上限を超える検索語は本番でエラーになるため拒否。
    if (exceedsLikePatternBudget(pattern)) {
      return { ok: false, error: "invalid_request" };
    }
    likeClause = String.raw`AND d.display_name LIKE ? ESCAPE '\'`;
    likeBind = [pattern];
  }

  const linkJoin = `LEFT JOIN line_identities li
       ON li.provider = 'line' AND li.channel_id = d.channel_id AND li.line_user_id = d.line_user_id`;

  // 「新規客として除外」機能は廃止。未紐付け = LINE identity が無い友だち全件
  // （旧 review_state での絞り込みは行わない → 過去に除外された友だちも再表示される）。
  let filterClause = "";
  if (filter === "unlinked") filterClause = "AND li.id IS NULL";
  else if (filter === "linked") filterClause = "AND li.id IS NOT NULL";

  const where = `WHERE d.channel_id = ? ${filterClause} ${likeClause}`;
  const baseBind = [input.channelId, ...likeBind];

  const rows = await input.db
    .prepare(
      `SELECT d.line_user_id, d.display_name, d.picture_url, d.profile_status,
              li.id AS identity_id, li.customer_id
       FROM line_friend_directory d
       ${linkJoin}
       ${where}
       ORDER BY (d.profile_status = 'fetched') DESC, d.display_name ASC, d.first_seen_at ASC
       LIMIT ? OFFSET ?`
    )
    .bind(...baseBind, LIST_PAGE_SIZE, (page - 1) * LIST_PAGE_SIZE)
    .all<FriendListRow>();

  const countRow = await input.db
    .prepare(`SELECT COUNT(*) AS n FROM line_friend_directory d ${linkJoin} ${where}`)
    .bind(...baseBind)
    .first<{ n: number }>();

  return {
    ok: true,
    items: (rows.results ?? []).map((r) => ({
      lineUserId: r.line_user_id,
      displayName: r.display_name,
      pictureUrl: r.picture_url,
      profileStatus: r.profile_status,
      linked: r.identity_id != null,
      linkedCustomerId: r.customer_id ?? null
    })),
    total: countRow?.n ?? 0,
    page,
    pageSize: LIST_PAGE_SIZE
  };
};

// ── 紐付け ─────────────────────────────────────────────────────────
// customers(+inline create) + line_identities を単一 db.batch で原子的に作成。
// line_identities.channel_id は必ず env.LINE_CHANNEL_ID（予約照合の不変条件）、
// linked_by_admin=1（オーナーが「既存客」と目視照合した証跡）。これにより次回の
// LINE予約で getExistingLineIdentity が当たり既存顧客として再利用される。
// treatAsExisting は新規客オーナー通知の抑止と Google「新規予約」prefix 判定にのみ
// 使われ、確定ステータスには影響しない（全予約承認制: 常に pending_approval）。
// ※以前は来店履歴に paper_chart_import の偽 visit（登録日付）を seed して
//   valid_visit_count>0 で「既存客」を表現していたが、実際には来店していない日付が
//   来店履歴を汚染するため廃止。代わりに linked_by_admin フラグで表現する。

export type LinkLineFriendResult =
  | { ok: true; customerId: string; lineIdentityId: string }
  | {
      ok: false;
      error:
        | "forbidden"
        | "invalid_request"
        | "store_not_found"
        | "customer_not_found"
        | "customer_blocked"
        | "friend_not_found"
        | "friend_not_fetched"
        | "already_linked"
        | "write_failed";
    };

// 顧客の解決（new = 新規 customers 行を作る INSERT を返す / existing = 既存行を検証）。
// new モードでは customers INSERT 文を返すだけで実行はしない（呼び出し側が batch で原子適用）。
const resolveLinkCustomer = async (
  input: { db: D1Database; request: LinkLineFriendRequest },
  nowIso: string
): Promise<
  | { ok: true; customerId: string; insert?: D1PreparedStatement }
  | { ok: false; error: "invalid_request" | "customer_not_found" | "customer_blocked" }
> => {
  if (input.request.mode === "new") {
    const customerId = crypto.randomUUID();
    let normalized: string | undefined;
    if (input.request.newCustomer.phone) {
      normalized = normalizePhone(input.request.newCustomer.phone);
      if (!normalized) return { ok: false, error: "invalid_request" }; // 非空だが正規化不能
    }
    const phoneHash = normalized ? await sha256Hex(normalized) : null;
    const insert = input.db
      .prepare(
        `INSERT INTO customers (id, display_name, display_name_kana, phone_normalized, phone_hash, block_status, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?)`
      )
      .bind(
        customerId,
        input.request.newCustomer.displayName.trim(),
        input.request.newCustomer.displayNameKana?.trim() ?? null,
        normalized ?? null,
        phoneHash,
        nowIso
      );
    return { ok: true, customerId, insert };
  }
  const customerId = input.request.customerId;
  const customer = await input.db
    .prepare(`SELECT id, block_status FROM customers WHERE id = ? AND merged_into_id IS NULL AND archived_at IS NULL`)
    .bind(customerId)
    .first<{ id: string; block_status: string }>();
  if (!customer) return { ok: false, error: "customer_not_found" };
  if (customer.block_status === "blocked") return { ok: false, error: "customer_blocked" };
  return { ok: true, customerId };
};

const recoverLinkBatchFailure = async (
  input: Parameters<typeof linkLineFriend>[0], error: unknown, nowIso: string
): Promise<LinkLineFriendResult> => {
  if (await adminWriteWasRevoked(input.db, input.admin, error)) return { ok: false, error: "forbidden" };
  if (isActorTypeBatchError(error)) {
    const current = await resolveLinkCustomer(input, nowIso);
    if (!current.ok) return current;
    const friend = await input.db.prepare(`SELECT profile_status FROM line_friend_directory
      WHERE channel_id = ? AND line_user_id = ?`)
      .bind(input.channelId, input.lineUserId).first<{ profile_status: string }>();
    if (!friend) return { ok: false, error: "friend_not_found" };
    if (friend.profile_status !== "fetched") return { ok: false, error: "friend_not_fetched" };
  }
  const msg = error instanceof Error ? error.message : String(error);
  // UNIQUE(provider, channel_id, line_user_id) → 競合（同時紐付け）。
  if (msg.toUpperCase().includes("UNIQUE")) return { ok: false, error: "already_linked" };
  console.error("linkLineFriend batch failed", { error: msg });
  return { ok: false, error: "write_failed" };
};

export const linkLineFriend = async (input: {
  db: D1Database;
  admin: AdminUser;
  channelId: string; // env.LINE_CHANNEL_ID
  lineUserId: string;
  request: LinkLineFriendRequest;
  now?: () => number;
}): Promise<LinkLineFriendResult> => {
  if (!isAdminPrivileged(input.admin.role)) return { ok: false, error: "forbidden" };
  if (!LINE_USER_ID_RE.test(input.lineUserId)) return { ok: false, error: "invalid_request" };
  if (!(await storeExists(input.db, input.request.storeId))) return { ok: false, error: "store_not_found" };

  // 友だちが名簿に存在（同期済み）であること。プロフィールを identity にコピーする。
  const friend = await input.db
    .prepare(
      `SELECT display_name, picture_url, profile_status FROM line_friend_directory WHERE channel_id = ? AND line_user_id = ?`
    )
    .bind(input.channelId, input.lineUserId)
    .first<{ display_name: string | null; picture_url: string | null; profile_status: string }>();
  if (!friend) return { ok: false, error: "friend_not_found" };
  // 目視照合の前提: 表示名+アイコンが取得済み(fetched)の友だちのみ紐付け可能。
  // pending(未取得=見て確認できない) / unavailable(退会・ブロック=非友だち) は不可。
  if (friend.profile_status !== "fetched") return { ok: false, error: "friend_not_fetched" };

  // 既に紐付け済み（authoritative = line_identities）なら拒否。
  const existing = await input.db
    .prepare(`SELECT id FROM line_identities WHERE provider = 'line' AND channel_id = ? AND line_user_id = ? LIMIT 1`)
    .bind(input.channelId, input.lineUserId)
    .first<{ id: string }>();
  if (existing) return { ok: false, error: "already_linked" };

  const nowIso = new Date((input.now ?? Date.now)()).toISOString();
  const lineIdentityId = crypto.randomUUID();

  const resolved = await resolveLinkCustomer(input, nowIso);
  if (!resolved.ok) return resolved;
  const { customerId } = resolved;

  // line_identities — channel_id は必ず env.LINE_CHANNEL_ID。将来予約の
  // getExistingLineIdentity (channel_id = booking channelId で照合) が当たるため。
  // friend_flag=1 / official_friend_status='friend' / linked_by_admin=1 はリテラル。
  // linked_by_admin=1 は「owner+ が目視で既存客として紐付けた」証跡で、public-submit の
  // treatAsExisting（新規客オーナー通知の抑止 / Google「新規予約」prefix 判定）が参照する。
  // 単調 0→1（unlink 無し）。
  const identityStmt = input.db
    .prepare(
      `INSERT INTO line_identities (
         id, customer_id, provider, channel_id, line_user_id,
         display_name, picture_url, friend_flag, official_friend_status, last_friend_checked_at,
         linked_by_admin, updated_at
       ) VALUES (?, ?, 'line', ?, ?, ?, ?, 1, 'friend', ?, 1, ?)`
    )
    .bind(
      lineIdentityId,
      customerId,
      input.channelId,
      input.lineUserId,
      friend.display_name,
      friend.picture_url,
      nowIso,
      nowIso
    );

  const auditStmt = input.db
    .prepare(
      `INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, metadata_json)
       VALUES (?, 'staff', ?, ?, 'customer', ?, ?)`
    )
    .bind(
      crypto.randomUUID(),
      input.admin.id,
      input.request.mode === "new" ? "line_friend.link.new" : "line_friend.link.existing",
      customerId,
      JSON.stringify({
        lineUserId: input.lineUserId,
        channelId: input.channelId,
        storeId: input.request.storeId,
        mode: input.request.mode,
        adminRole: input.admin.role
      })
    );

  // Recheck the customer and directory in the identity transaction. A stale
  // target aborts the audit and an inline customer INSERT together.
  const targetGuard = input.db.prepare(`
    INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id)
    SELECT ?, 'line_link_target_invalid', ?, 'line.link.guard', 'customer', ?
    WHERE NOT EXISTS (SELECT 1 FROM customers WHERE id = ? AND merged_into_id IS NULL
      AND archived_at IS NULL AND block_status = 'active')
      OR NOT EXISTS (SELECT 1 FROM line_friend_directory WHERE channel_id = ?
        AND line_user_id = ? AND profile_status = 'fetched')
  `).bind(crypto.randomUUID(), input.admin.id, customerId, customerId, input.channelId, input.lineUserId);
  const statements = [adminWriteGuard(input.db, input.admin),
    ...(resolved.insert ? [resolved.insert] : []), targetGuard, identityStmt, auditStmt];

  try {
    await input.db.batch(statements);
  } catch (error) {
    return recoverLinkBatchFailure(input, error, nowIso);
  }

  return { ok: true, customerId, lineIdentityId };
};

// ── 除外/復帰 ──────────────────────────────────────────────────────
// 「新規客として除外」機能は廃止（ユーザー要望: 用途が分かりにくいボタンを削除）。
// review_state カラムは互換のため残置するが、書き込み/読み出しは行わない。未紐付け
// 一覧は LINE identity の有無のみで判定する（listLineFriends 参照）。
