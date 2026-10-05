import { adminWriteGuard, adminWriteWasRevoked } from "./write-authorization";
import type { AdminUser } from "./access";
import { RESERVATION_LINE_FRIEND_STATUS_SUBQUERY } from "./shared";
import type { WorkerBindings } from "../bindings";
import {
  buildCancelStatements,
  buildClosePendingChangeRequestsStatement
} from "../reservations/transitions";
import { trackEvent, type ReservationEventType } from "../analytics/metrics";
import { sha256Hex } from "../crypto-utils";
import { captureBatchWriteFailure } from "../sentry-helpers";
import { isNonEmptyString } from "./reservation-time-utils";

const ACTION_TO_EVENT: Record<AdminReservationAction, ReservationEventType> = {
  approve: "approved",
  reject: "rejected",
  cancel: "cancelled",
  complete: "completed",
  "no-show": "no_show",
  // 訂正は既存の completed / no_show イベントに相乗りさせない。往復するたびに
  // 運用メトリクスが水増しされるため。
  "correct-no-show": "corrected_no_show",
  "restore-completed": "restored_completed"
};

export type AdminReservationAction =
  | "approve"
  | "reject"
  | "cancel"
  | "complete"
  | "no-show"
  // 訂正 (2026-08-25): 終端の completed / no_show を相互に往復させる owner+ 専用アクション。
  // 既存 4 アクションと違い「終端状態は不変」という前提が成り立たないため、認可・
  // expectedVersion・冪等 replay の扱いが一部異なる (docs/SPEC.md の状態遷移表を参照)。
  | "correct-no-show"
  | "restore-completed";

export type AdminActionRequest = {
  idempotencyKey: string;
  reason?: string;
  // 一括承認の確認スナップショット鮮度ガード (楽観ロック)。指定時のみ検証し、
  // 現在の version と不一致なら stale_snapshot で拒否する。単件操作は従来通り省略可。
  expectedVersion?: number;
};

type AdminReservationSuccess = {
  ok: true;
  reservationId: string;
  status:
    | "confirmed"
    | "rejected"
    | "cancelled_by_admin"
    | "completed"
    | "no_show"
    | "checked_in";
  version: number;
  replayed: boolean;
};

type AdminReservationFailure = {
  ok: false;
  reason:
    | "invalid_request"
    | "forbidden"
    | "not_found"
    | "invalid_transition"
    | "stale_snapshot"
    | "idempotency_conflict"
    | "idempotency_in_progress"
    | "line_not_reachable"
    | "store_closed"
    | "write_failed";
};

export type AdminReservationActionResult = AdminReservationSuccess | AdminReservationFailure;

export type PendingReservationListItem = {
  id: string;
  status: "pending_approval";
  storeId: string;
  storeName: string;
  serviceNames: string;
  startAt: string;
  endAt: string;
  customerDisplayName: string;
  lineFriendStatus: string;
  createdAt: string | null;
  pendingExpiresAt: string | null;
  // 一括承認の楽観ロック (expectedVersion) 用。
  version: number;
};

export type UnpaidCancellationFeeListItem = {
  id: string;
  status: string;
  storeId: string;
  storeName: string;
  serviceNames: string;
  startAt: string;
  endAt: string;
  customerDisplayName: string;
  cancellationFeeUnpaidAt: string;
};

type ReservationActionRow = {
  id: string;
  store_id: string;
  customer_id: string;
  line_identity_id: string | null;
  source: "web_line" | "phone_admin" | "admin" | "system_import";
  status:
    | "pending_approval"
    | "confirmed"
    | "rejected"
    | "expired"
    | "cancelled_by_customer"
    | "cancelled_by_admin"
    | "completed"
    | "no_show";
  checked_in_at: string | null;
  version: number;
  start_at: string;
  end_at: string;
  pending_expires_at: string | null;
  line_user_id: string | null;
  official_friend_status: string | null;
};

type IdempotencyRow = {
  status: "started" | "succeeded" | "failed";
  target_id: string | null;
  request_hash: string | null;
};

type ReservationResultRow = {
  id: string;
  status: AdminReservationSuccess["status"];
  version: number;
  checked_in_at: string | null;
};

const ACTIVE_STATUSES = new Set(["pending_approval", "confirmed"]);
const ADMIN_RESERVATION_ACTIONS = [
  "approve",
  "reject",
  "cancel",
  "complete",
  "no-show",
  "correct-no-show",
  "restore-completed"
] as const;

// 訂正アクション: owner+ 限定、expectedVersion 必須、逆向き訂正後の replay を許す。
const CORRECTION_ACTIONS = new Set<AdminReservationAction>(["correct-no-show", "restore-completed"]);
const isCorrectionAction = (action: AdminReservationAction) => CORRECTION_ACTIONS.has(action);

const expectedStatusByAction: Record<AdminReservationAction, AdminReservationSuccess["status"]> = {
  approve: "confirmed",
  reject: "rejected",
  cancel: "cancelled_by_admin",
  complete: "completed",
  "no-show": "no_show",
  "correct-no-show": "no_show",
  "restore-completed": "completed"
};

const isAdminReservationAction = (value: unknown): value is AdminReservationAction => {
  return typeof value === "string" && ADMIN_RESERVATION_ACTIONS.includes(value as AdminReservationAction);
};

const createIdempotencyExpiresAt = (nowIso: string) => {
  return new Date(new Date(nowIso).getTime() + 24 * 60 * 60 * 1000).toISOString();
};

// 却下理由から不可視の制御文字 (C0・DEL・bidi 制御・ゼロ幅 U+200B-200D/U+2060・
// 行/段落区切り・BOM) を除去する。改行・タブは複数行入力として正当なので残し、
// CRLF・単独 CR は LF へ統一する (pii-normalize の
// CONTROL_CHARS_PATTERN は改行も落とすため使わない)。監査ログ表示の視覚的な偽装
// (bidi 上書きなど) を防ぐ。制御文字を含まない理由では trim のみと同じ結果になるため、
// 既存の idempotency requestHash は変わらない。
const REASON_CONTROL_CHARS_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\u061C\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;

// 空文字・未指定は null に正規化。hash と監査 metadata の双方でこの値を使い、
// 正規化の掛かり方が二経路で食い違わないようにする。
const normalizeRejectReason = (reason: string | undefined): string | null =>
  reason
    ?.replace(/\r\n?/g, "\n")
    .replace(REASON_CONTROL_CHARS_PATTERN, "")
    .trim() || null;

const createRequestHash = async (input: {
  reservationId: string;
  action: AdminReservationAction;
  request: AdminActionRequest;
  admin: AdminUser;
}) => {
  return sha256Hex(
    JSON.stringify({
      reservationId: input.reservationId,
      action: input.action,
      reason: normalizeRejectReason(input.request.reason),
      adminId: input.admin.id,
      // 未指定時はキー自体を出さない: 既存リクエストの hash を変えない (idempotency
      // replay の後方互換)。
      ...(input.request.expectedVersion !== undefined
        ? { expectedVersion: input.request.expectedVersion }
        : {})
    })
  );
};

// allowStatusDrift: 成功済みキーの replay で「現在の status が期待どおりか」を
// 要求しない。訂正 2 アクション専用。既存 4 アクションは終端状態が不変なので
// 一致を要求してよいが、訂正は双方向なので correct-no-show(key K) 成功 →
// restore-completed 成功 → K 再送、が起こり得る。K の操作は実際に成功している
// ため write_failed を返すのは嘘になる (contracts/admin-api.md の replayed 意味論)。
const readReservationResult = async (
  db: D1Database,
  reservationId: string,
  replayed: boolean,
  expectedStatus: AdminReservationSuccess["status"],
  allowStatusDrift = false
): Promise<AdminReservationActionResult> => {
  const row = await db
    .prepare(
      `
        SELECT id, status, version, checked_in_at
        FROM reservations
        WHERE id = ?
        LIMIT 1
      `
    )
    .bind(reservationId)
    .first<ReservationResultRow>();

  if (!row || (row.status !== expectedStatus && !allowStatusDrift)) {
    return {
      ok: false,
      reason: "write_failed"
    };
  }

  const displayStatus: AdminReservationSuccess["status"] =
    row.status === "confirmed" && row.checked_in_at ? "checked_in" : row.status;

  return {
    ok: true,
    reservationId: row.id,
    status: displayStatus,
    version: row.version,
    replayed
  };
};

const fetchReservationForAction = async (db: D1Database, reservationId: string) => {
  return db
    .prepare(
      `
        SELECT
          reservations.id,
          reservations.store_id,
          reservations.customer_id,
          reservations.line_identity_id,
          reservations.source,
          reservations.status,
          reservations.checked_in_at,
          reservations.version,
          reservations.start_at,
          reservations.end_at,
          reservations.pending_expires_at,
          line_identities.line_user_id,
          line_identities.official_friend_status
        FROM reservations
        LEFT JOIN line_identities ON line_identities.id = reservations.line_identity_id
        WHERE reservations.id = ?
        LIMIT 1
      `
    )
    .bind(reservationId)
    .first<ReservationActionRow>();
};

const checkLineReachability = async (input: {
  env: Partial<WorkerBindings>;
  lineUserId: string | null;
  fetcher?: typeof fetch;
}) => {
  if (!isNonEmptyString(input.lineUserId, 128)) {
    return false;
  }
  const token = input.env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN;
  if (!isNonEmptyString(token, 4096)) {
    return false;
  }

  try {
    const fetcher = input.fetcher ?? fetch.bind(globalThis);
    const response = await fetcher(
      `https://api.line.me/v2/bot/profile/${encodeURIComponent(input.lineUserId)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );
    return response.ok;
  } catch {
    return false;
  }
};

const createIdempotencyStarted = (input: {
  db: D1Database;
  id: string;
  key: string;
  requestHash: string;
  nowIso: string;
}) => {
  return input.db
    .prepare(
      `
        INSERT INTO idempotency_keys (
          id,
          scope,
          idempotency_key,
          status,
          request_hash,
          expires_at,
          updated_at
        ) VALUES (?, 'admin_action', ?, 'started', ?, ?, ?)
      `
    )
    .bind(
      input.id,
      input.key,
      input.requestHash,
      createIdempotencyExpiresAt(input.nowIso),
      input.nowIso
    );
};

const guardReservationTransitionApplied = (input: {
  db: D1Database;
  idempotencyId: string;
  idempotencyKey: string;
  requestHash: string;
  reservationId: string;
  expectedStatus: AdminReservationSuccess["status"];
  nextVersion: number;
  adminId: string;
  nowIso: string;
}) => [
  input.db
    .prepare(
      `
        UPDATE idempotency_keys
        SET target_type = 'reservation_transition',
            target_id = ?,
            updated_at = ?
        WHERE id = ?
          AND changes() > 0
          AND EXISTS (
            SELECT 1
            FROM reservations
            WHERE id = ?
              AND status = ?
              AND version = ?
              AND updated_by = ?
              AND updated_at = ?
          )
      `
    )
    .bind(
      input.reservationId,
      input.nowIso,
      input.idempotencyId,
      input.reservationId,
      input.expectedStatus,
      input.nextVersion,
      input.adminId,
      input.nowIso
    ),
  input.db
    .prepare(
      `
        INSERT INTO idempotency_keys (
          id,
          scope,
          idempotency_key,
          status,
          request_hash,
          expires_at,
          updated_at
        )
        SELECT ?, 'admin_action', ?, 'started', ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1
          FROM idempotency_keys
          WHERE id = ?
            AND target_type = 'reservation_transition'
        )
      `
    )
    .bind(
      crypto.randomUUID(),
      input.idempotencyKey,
      input.requestHash,
      createIdempotencyExpiresAt(input.nowIso),
      input.nowIso,
      input.idempotencyId
    )
];

const releaseSlotLocks = (input: {
  db: D1Database;
  reservation: ReservationActionRow;
  admin: AdminUser;
  reason: string;
}) => {
  return [
    input.db
      .prepare(
        `
          INSERT INTO slot_lock_history (
            id,
            slot_lock_id,
            store_id,
            resource_id,
            old_slot_at,
            old_owner_id,
            action,
            actor_type,
            actor_id,
            reason
          )
          SELECT
            lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6))),
            id,
            store_id,
            resource_id,
            slot_at,
            owner_id,
            'released',
            'staff',
            ?,
            ?
          FROM slot_locks
          WHERE owner_type = 'reservation'
            AND owner_id = ?
        `
      )
      .bind(input.admin.id, input.reason, input.reservation.id),
    input.db
      .prepare(
        `
          DELETE FROM slot_locks
          WHERE owner_type = 'reservation'
            AND owner_id = ?
        `
      )
      .bind(input.reservation.id),
    input.db
      .prepare(
        `
          DELETE FROM customer_time_locks
          WHERE owner_type = 'reservation'
            AND owner_id = ?
        `
      )
      .bind(input.reservation.id)
  ];
};

const insertNotificationJob = (input: {
  db: D1Database;
  reservationId: string;
  recipientId: string;
  templateKey: string;
  revision: number;
}) => {
  return input.db
    .prepare(
      `
        INSERT OR IGNORE INTO notification_jobs (
          id,
          dedupe_key,
          template_key,
          recipient_type,
          recipient_id,
          reservation_id,
          status
        ) VALUES (?, ?, ?, 'customer', ?, ?, 'queued')
      `
    )
    .bind(
      crypto.randomUUID(),
      `reservation:${input.reservationId}:template:${input.templateKey}:revision:${input.revision}`,
      input.templateKey,
      input.recipientId,
      input.reservationId
    );
};

const canQueueCustomerLineNotification = (reservation: ReservationActionRow) => {
  return reservation.line_identity_id !== null;
};

const insertCalendarJob = (input: {
  db: D1Database;
  reservationId: string;
  action: "upsert" | "delete";
  revision: number;
  nowIso: string;
}) => {
  return input.db
    .prepare(
      `
        INSERT OR IGNORE INTO calendar_sync_jobs (
          id,
          dedupe_key,
          owner_type,
          owner_id,
          google_action,
          status,
          available_at
        ) VALUES (?, ?, 'reservation', ?, ?, 'queued', ?)
      `
    )
    .bind(
      crypto.randomUUID(),
      `reservation:${input.reservationId}:google:${input.action}:revision:${input.revision}`,
      input.reservationId,
      input.action,
      input.nowIso
    );
};

const insertAuditLog = (input: {
  db: D1Database;
  admin: AdminUser;
  reservationId: string;
  action: string;
  metadata: Record<string, unknown>;
}) => {
  return input.db
    .prepare(
      `
        INSERT INTO audit_logs (
          id,
          actor_type,
          actor_id,
          action,
          target_type,
          target_id,
          metadata_json
        ) VALUES (?, 'staff', ?, ?, 'reservation', ?, ?)
      `
    )
    .bind(
      crypto.randomUUID(),
      input.admin.id,
      input.action,
      input.reservationId,
      JSON.stringify(input.metadata)
    );
};

const updateIdempotencySucceeded = (input: {
  db: D1Database;
  idempotencyId: string;
  reservationId: string;
  nowIso: string;
}) => {
  return input.db
    .prepare(
      `
        UPDATE idempotency_keys
        SET status = 'succeeded',
            target_type = 'reservation',
            target_id = ?,
            updated_at = ?
        WHERE id = ?
      `
    )
    .bind(input.reservationId, input.nowIso, input.idempotencyId);
};

const validateAdminActionInput = (input: {
  reservationId: string;
  action: AdminReservationAction;
  request: AdminActionRequest;
}): AdminReservationFailure | undefined => {
  if (
    !isAdminReservationAction(input.action) ||
    !isNonEmptyString(input.reservationId, 128) ||
    !isNonEmptyString(input.request.idempotencyKey, 256) ||
    (input.request.reason !== undefined && !isNonEmptyString(input.request.reason, 500)) ||
    (input.request.expectedVersion !== undefined &&
      (!Number.isInteger(input.request.expectedVersion) || input.request.expectedVersion < 1)) ||
    // 訂正では expectedVersion を必須にする。任意のままだと、事前チェック後〜batch 開始
    // までに version が進んだ競合が stale_snapshot ではなく汎用 write_failed になり、
    // 「今どうなっているか」を利用者に返せない (classifyLateStaleSnapshot 参照)。
    (isCorrectionAction(input.action) && input.request.expectedVersion === undefined)
  ) {
    return {
      ok: false,
      reason: "invalid_request"
    };
  }
  return undefined;
};

// staff は自店舗 scope のみで認可する。2026-07-14 に当日ガードを撤廃 — 承認/却下
// (全期間可) と同様に、確定予約の cancel/complete/no-show/reschedule も
// staff が自店舗であれば日付を問わず操作できる。日付制限はスケジュール画面の閲覧
// 範囲と合わせて廃止した (旧: staff は当日のみ)。owner/system_admin は従来どおり無制限。
// 完了への復元は owner+ 限定。ルート層の ownerOnly ゲートに加えてドメイン層でも弾き、
// 単一防壁にしない (ドメイン関数を直接呼ぶ経路が増えても権限が漏れない)。
// 予約を読む前に判定できるので、runAdminReservationAction の入口でも呼ぶ
// (冪等 replay と not_found を権限の無い呼び出し元に返さないため)。
const validateCorrectionRole = (
  admin: AdminUser,
  action: AdminReservationAction
): AdminReservationFailure | undefined =>
  action === "restore-completed" && admin.role !== "owner" && admin.role !== "system_admin"
    ? { ok: false, reason: "forbidden" }
    : undefined;

const validateAdminActionAuthorization = (input: {
  admin: AdminUser;
  reservation: ReservationActionRow;
  action: AdminReservationAction;
}): AdminReservationFailure | undefined => {
  const correctionError = validateCorrectionRole(input.admin, input.action);
  if (correctionError) {
    return correctionError;
  }
  if (input.admin.role === "staff") {
    if (!input.admin.store_id || input.reservation.store_id !== input.admin.store_id) {
      return { ok: false, reason: "forbidden" };
    }
  }
  return undefined;
};

const resolveAdminActionIdempotency = async (input: {
  db: D1Database;
  key: string;
  requestHash: string;
  expectedStatus: AdminReservationSuccess["status"];
  nowIso: string;
  allowStatusDrift?: boolean;
}): Promise<AdminReservationActionResult | undefined> => {
  // Filter on expires_at so a "started" row left behind by a crashed request
  // stops blocking the same idempotency_key once its TTL window has elapsed,
  // matching the audited settings-flow resolver (fetchAdminActionIdempotency,
  // docs/SECURITY-AUDIT-2026-05-27.md F-6.1).
  //
  // The threshold is the caller-supplied nowIso (the same clock used to stamp
  // expires_at on insert) rather than SQLite's datetime('now'): a single
  // injected clock keeps read and write deterministic under time-travel tests.
  // Both sides are wrapped in datetime(...) because expires_at is an ISO string
  // (`YYYY-MM-DDTHH:mm:ss.sssZ`) — a lexical `>` would order the `T` separator
  // after a space and mis-rank an expired same-UTC-day row as still valid.
  const idempotency = await input.db
    .prepare(
      `
        SELECT status, target_id, request_hash
        FROM idempotency_keys
        WHERE scope = 'admin_action'
          AND idempotency_key = ?
          AND (expires_at IS NULL OR datetime(expires_at) > datetime(?))
        LIMIT 1
      `
    )
    .bind(input.key, input.nowIso)
    .first<IdempotencyRow>();

  if (!idempotency) {
    return undefined;
  }
  if (idempotency.request_hash !== input.requestHash) {
    return {
      ok: false,
      reason: "idempotency_conflict"
    };
  }
  if (idempotency.status === "succeeded" && idempotency.target_id) {
    return readReservationResult(
      input.db,
      idempotency.target_id,
      true,
      input.expectedStatus,
      input.allowStatusDrift ?? false
    );
  }
  return {
    ok: false,
    reason: "idempotency_in_progress"
  };
};

// Recovery for a failed reservation-action db.batch(): a concurrent in-flight
// request replays its cached/in-progress result; otherwise the swallowed batch
// failure is captured and the terminal write_failed returned.
const recoverReservationActionBatchFailure = async (input: {
  db: D1Database;
  key: string;
  requestHash: string;
  expectedStatus: AdminReservationSuccess["status"];
  nowIso: string;
  action: AdminReservationAction;
  error: unknown;
}): Promise<AdminReservationActionResult> => {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  if (message.includes("store_closed")) {
    return { ok: false, reason: "store_closed" };
  }
  try {
    const concurrent = await resolveAdminActionIdempotency({
      db: input.db,
      key: input.key,
      requestHash: input.requestHash,
      expectedStatus: input.expectedStatus,
      nowIso: input.nowIso,
      allowStatusDrift: isCorrectionAction(input.action)
    });
    if (concurrent) return concurrent;
  } catch (lookupError) {
    captureBatchWriteFailure(lookupError, { component: "admin-reservations", op: "idempotency_lookup_failed", helper: input.action });
  }
  captureBatchWriteFailure(input.error, { component: "admin-reservations", op: "batch_write_failed", helper: input.action });
  return { ok: false, reason: "write_failed" };
};

// 楽観ロック指定時、事前チェック後〜batch 開始までに version が進んだ競合も guard が
// batch ごと巻き戻す。その場合は汎用 write_failed でなく、事前チェックと同じ
// 「再確認してください」(stale_snapshot) に分類する (transient D1 障害の巻き戻しは
// version 不変なので write_failed のまま)。
const classifyLateStaleSnapshot = async (input: {
  db: D1Database;
  reservationId: string;
  expectedVersion: number | undefined;
  recovered: AdminReservationActionResult;
}): Promise<AdminReservationActionResult> => {
  if (
    input.recovered.ok ||
    input.recovered.reason !== "write_failed" ||
    input.expectedVersion === undefined
  ) {
    return input.recovered;
  }
  const current = await fetchReservationForAction(input.db, input.reservationId).catch(() => null);
  if (current && current.version !== input.expectedVersion) {
    return { ok: false, reason: "stale_snapshot" };
  }
  return input.recovered;
};

const validateReservationTransition = (
  action: AdminReservationAction,
  reservation: ReservationActionRow,
  nowIso: string
): AdminReservationFailure | undefined => {
  if (action === "approve") {
    // The deadline check mirrors the expiry sweep, fail-closed: past
    // pending_expires_at the pending slot_locks may already be reclaimed by
    // another writer (public submit self-heal, external-block creation), so
    // approving would confirm a reservation whose slots are no longer held.
    // The sweep will (or already did) expire it; the owner re-books instead.
    return reservation.status === "pending_approval" &&
      reservation.official_friend_status === "friend" &&
      !(reservation.pending_expires_at && reservation.pending_expires_at <= nowIso)
      ? undefined
      : {
          ok: false,
          reason: "invalid_transition"
        };
  }
  if (action === "reject" && reservation.status !== "pending_approval") {
    return {
      ok: false,
      reason: "invalid_transition"
    };
  }
  if ((action === "complete" || action === "no-show") && reservation.status !== "confirmed") {
    return {
      ok: false,
      reason: "invalid_transition"
    };
  }
  // 訂正は終端状態からの往復。逆向きの現在状態からしか許さない。
  if (action === "correct-no-show" && reservation.status !== "completed") {
    return {
      ok: false,
      reason: "invalid_transition"
    };
  }
  if (action === "restore-completed" && reservation.status !== "no_show") {
    return {
      ok: false,
      reason: "invalid_transition"
    };
  }
  if (action === "cancel" && !ACTIVE_STATUSES.has(reservation.status)) {
    return {
      ok: false,
      reason: "invalid_transition"
    };
  }
  return undefined;
};

const verifyApprovalLineReachability = async (input: {
  env: Partial<WorkerBindings>;
  action: AdminReservationAction;
  reservation: ReservationActionRow;
  fetcher?: typeof fetch;
}): Promise<AdminReservationFailure | undefined> => {
  if (input.action !== "approve") {
    return undefined;
  }

  const reachable = await checkLineReachability({
    env: input.env,
    lineUserId: input.reservation.line_user_id,
    fetcher: input.fetcher
  });
  if (reachable) {
    return undefined;
  }

  return {
    ok: false,
    reason: "line_not_reachable"
  };
};

const buildApproveStatements = (input: {
  db: D1Database;
  admin: AdminUser;
  reservation: ReservationActionRow;
  nowIso: string;
  nextVersion: number;
}) => {
  const statements = [
    input.db
      .prepare(
        `
          UPDATE reservations
          SET status = 'confirmed',
              pending_expires_at = NULL,
              updated_by = ?,
              version = version + 1,
              updated_at = ?
          WHERE id = ?
            AND status = 'pending_approval'
        `
      )
      .bind(input.admin.id, input.nowIso, input.reservation.id),
    input.db
      .prepare(
        `
          UPDATE slot_locks
          SET lock_status = 'confirmed',
              expires_at = NULL
          WHERE owner_type = 'reservation'
            AND owner_id = ?
        `
      )
      .bind(input.reservation.id),
    input.db
      .prepare(
        `
          UPDATE customer_time_locks
          SET lock_status = 'confirmed',
              expires_at = NULL
          WHERE owner_type = 'reservation'
            AND owner_id = ?
        `
      )
      .bind(input.reservation.id),
    input.db
      .prepare(
        `
          UPDATE line_identities
          SET friend_flag = 1,
              official_friend_status = 'friend',
              last_friend_checked_at = ?,
              updated_at = ?
          WHERE id = ?
        `
      )
      .bind(input.nowIso, input.nowIso, input.reservation.line_identity_id)
  ];

  if (canQueueCustomerLineNotification(input.reservation)) {
    statements.push(
      insertNotificationJob({
        db: input.db,
        reservationId: input.reservation.id,
        recipientId: input.reservation.customer_id,
        templateKey: "reservation_confirmed",
        revision: input.nextVersion
      })
    );
  }

  statements.push(
    insertCalendarJob({
      db: input.db,
      reservationId: input.reservation.id,
      action: "upsert",
      revision: input.nextVersion,
      nowIso: input.nowIso
    }),
    insertAuditLog({
      db: input.db,
      admin: input.admin,
      reservationId: input.reservation.id,
      action: "admin_reservation_approved",
      metadata: {
        previousStatus: input.reservation.status,
        nextStatus: "confirmed"
      }
    })
  );

  return statements;
};

// "cancel" routes through buildCancelStatements (PR #1) and never reaches the
// buildStatusUpdate helpers below; "approve" has its own buildApproveStatements.
type LegacyNonApproveAction = "reject" | "complete" | "no-show" | "correct-no-show" | "restore-completed";

const updateColumnsForAction = (action: LegacyNonApproveAction) => {
  switch (action) {
    case "complete":
      return "status = 'completed', completed_at = ?, pending_expires_at = NULL, updated_by = ?, version = version + 1, updated_at = ?";
    case "no-show":
      // no_show は「キャンセル料未納」フラグも同時に立てる (owner 依頼: no_show のみ対象)。
      return "status = 'no_show', no_show_at = ?, cancellation_fee_unpaid_at = ?, pending_expires_at = NULL, updated_by = ?, version = version + 1, updated_at = ?";
    case "correct-no-show":
      // completed -> no_show の訂正。completed_at を消して no_show の形に揃える。
      // キャンセル料未納は既存の no-show と同じく同時に立てる。訂正の入口は必ず
      // completed で、completed の予約が未納日時を持つことはない (restore-completed が
      // 必ず NULL にし、complete はこの列に触れない) ので、既存値を残す COALESCE は
      // 効き目がなく紛らわしいだけ。往復訂正すると発生日は最後に訂正した日になる
      // (回収済みだったことはどこにも残らない)。未納一覧は課金ではなくメモであり、
      // オーナーが既存の操作で消せるので、この振る舞いを許容する。
      return "status = 'no_show', no_show_at = ?, cancellation_fee_unpaid_at = ?, completed_at = NULL, pending_expires_at = NULL, updated_by = ?, version = version + 1, updated_at = ?";
    case "restore-completed":
      // no_show -> completed の復元。cancellation_fee_unpaid_at を必ず消す —
      // 未納一覧のクエリ (admin-api.ts の unpaid-cancellation-fees) は
      // cancellation_fee_unpaid_at IS NOT NULL だけで絞り status を見ないため、
      // 残すと完了済みの予約が未納一覧に居座る。
      // completed_at は「最後に完了とした時刻」であって初回完了の証跡ではない。
      // 往復訂正すると元の完了時刻は失われる (audit_logs 側に両方のイベントが残る)。
      // 顧客に見える来店日 (customer_visits.visited_at) は予約の start_at 由来なので
      // 訂正では動かない。
      return "status = 'completed', completed_at = ?, no_show_at = NULL, cancellation_fee_unpaid_at = NULL, pending_expires_at = NULL, updated_by = ?, version = version + 1, updated_at = ?";
    case "reject":
      // rejection_reason = ? は先頭バインド。updateBindingsForAction の reject 分岐と
      // 列/バインド順を厳密に一致させること。
      return "status = 'rejected', rejection_reason = ?, pending_expires_at = NULL, updated_by = ?, version = version + 1, updated_at = ?";
  }
};

const allowedPreviousStatusesForAction = (action: LegacyNonApproveAction): string[] => {
  if (action === "reject") return ["pending_approval"];
  if (action === "correct-no-show") return ["completed"];
  if (action === "restore-completed") return ["no_show"];
  return ["confirmed"];
};

const updateBindingsForAction = (input: {
  action: LegacyNonApproveAction;
  admin: AdminUser;
  reservation: ReservationActionRow;
  nowIso: string;
  rejectionReason: string | null;
}) => {
  if (input.action === "no-show" || input.action === "correct-no-show") {
    // 列順: no_show_at, cancellation_fee_unpaid_at, updated_by, updated_at, (WHERE) id
    return [input.nowIso, input.nowIso, input.admin.id, input.nowIso, input.reservation.id];
  }
  if (input.action === "complete" || input.action === "restore-completed") {
    return [input.nowIso, input.admin.id, input.nowIso, input.reservation.id];
  }
  // reject: 先頭に rejection_reason を bind (updateColumnsForAction の reject 分岐と一致)。
  return [input.rejectionReason, input.admin.id, input.nowIso, input.reservation.id];
};

const buildStatusUpdate = (input: {
  action: LegacyNonApproveAction;
  admin: AdminUser;
  reservation: ReservationActionRow;
  nowIso: string;
  rejectionReason: string | null;
}) => {
  const updateColumns = updateColumnsForAction(input.action);
  const allowedStatuses = allowedPreviousStatusesForAction(input.action);
  const statusPlaceholders = allowedStatuses.map(() => "?").join(", ");
  const updateSql = `
    UPDATE reservations
    SET ${updateColumns}
    WHERE id = ?
      AND status IN (${statusPlaceholders})
  `;
  const updateBindings = updateBindingsForAction(input);
  updateBindings.push(...allowedStatuses);
  return {
    sql: updateSql,
    bindings: updateBindings
  };
};

const buildCompleteVisitStatement = (input: {
  db: D1Database;
  admin: AdminUser;
  reservation: ReservationActionRow;
}) => {
  return input.db
    .prepare(
      `
        INSERT INTO customer_visits (
          id,
          customer_id,
          reservation_id,
          store_id,
          visited_at,
          visit_source,
          recorded_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `
    )
    .bind(
      crypto.randomUUID(),
      input.reservation.customer_id,
      input.reservation.id,
      input.reservation.store_id,
      // visited_at = the appointment time (start_at), NOT the admin "complete"-
      // click time. Owners often complete reservations in batches days later;
      // binding nowIso here would record the bookkeeping moment as the visit
      // date and drift the customer's last-visit date. The action timestamp is
      // separately preserved in reservations.completed_at.
      input.reservation.start_at,
      input.reservation.source === "phone_admin" ? "phone_admin_completed" : "reservation_completed",
      input.admin.id
    );
};

// completed -> no_show の訂正で、その予約の来店実績を無効化する。
// customer_visits の CHECK 制約は「status='valid' か、voided_by/voided_at/void_reason が
// 3 列そろって NOT NULL か」なので、3 列を必ず同時に埋める。
// 行が無いケース (過去の不整合データ) は 0 行更新で素通りさせ、訂正自体は成功させる。
const buildVoidVisitStatement = (input: {
  db: D1Database;
  admin: AdminUser;
  reservation: ReservationActionRow;
  nowIso: string;
}) => {
  return input.db
    .prepare(
      `
        UPDATE customer_visits
        SET status = 'voided',
            voided_by = ?,
            voided_at = ?,
            void_reason = 'reservation_corrected_to_no_show'
        WHERE reservation_id = ?
          AND status = 'valid'
      `
    )
    .bind(input.admin.id, input.nowIso, input.reservation.id);
};

// no_show -> completed の復元で、その予約の来店実績を「有効ちょうど 1 件」に戻す。
// reservation_id は UNIQUE (migrations/0001_initial.sql) なので upsert 1 文で済む。
// DO UPDATE で status と void 3 列だけを書き、visited_at / visit_source / recorded_by は
// 触らない (無効化前の来店日時と記録経路をそのまま残す)。
const buildRestoreVisitStatement = (input: {
  db: D1Database;
  admin: AdminUser;
  reservation: ReservationActionRow;
}) => {
  return input.db
    .prepare(
      `
        INSERT INTO customer_visits (
          id,
          customer_id,
          reservation_id,
          store_id,
          visited_at,
          visit_source,
          recorded_by
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(reservation_id) DO UPDATE SET
          status = 'valid',
          voided_by = NULL,
          voided_at = NULL,
          void_reason = NULL
      `
    )
    .bind(
      crypto.randomUUID(),
      input.reservation.customer_id,
      input.reservation.id,
      input.reservation.store_id,
      // buildCompleteVisitStatement と同じ理由で、訂正を操作した時刻ではなく
      // 予約の開始時刻を来店日にする。
      input.reservation.start_at,
      input.reservation.source === "phone_admin" ? "phone_admin_completed" : "reservation_completed",
      input.admin.id
    );
};

const buildNonApproveStatements = (input: {
  db: D1Database;
  admin: AdminUser;
  action: Exclude<AdminReservationAction, "approve">;
  reservation: ReservationActionRow;
  nowIso: string;
  nextVersion: number;
  expectedStatus: AdminReservationSuccess["status"];
  rejectionReason: string | null;
}) => {
  const action = input.action;
  let statements: D1PreparedStatement[];
  if (action === "cancel") {
    statements = buildCancelStatements({
      db: input.db,
      reservationId: input.reservation.id,
      customerId: input.reservation.customer_id,
      expectedStatusList: ["pending_approval", "confirmed"],
      nowIso: input.nowIso,
      actor: { kind: "admin", adminId: input.admin.id, reason: "admin_cancel" }
    });
  } else {
    const statusUpdate = buildStatusUpdate({
      action,
      admin: input.admin,
      reservation: input.reservation,
      nowIso: input.nowIso,
      rejectionReason: input.rejectionReason
    });
    statements = [
      input.db.prepare(statusUpdate.sql).bind(...statusUpdate.bindings),
      ...releaseSlotLocks({
        db: input.db,
        reservation: input.reservation,
        admin: input.admin,
        reason: `admin_${action}`
      })
    ];
  }

  // terminal 遷移 (reject / cancel / complete / no-show) では、この予約に対する
  // pending の変更申請 (申請機能廃止後に残る歴史行) も閉じる。本 batch の予約
  // UPDATE が実際にコミットした場合のみ発火する。
  statements.push(
    buildClosePendingChangeRequestsStatement({
      db: input.db,
      reservationId: input.reservation.id,
      nowIso: input.nowIso,
      terminalGuardSql: `EXISTS (
             SELECT 1 FROM reservations
             WHERE id = ?
               AND status IN ('rejected', 'cancelled_by_admin', 'completed', 'no_show')
           )`,
      terminalGuardBinds: [input.reservation.id]
    })
  );

  if (input.action === "reject" || input.action === "cancel") {
    if (canQueueCustomerLineNotification(input.reservation)) {
      statements.push(
        insertNotificationJob({
          db: input.db,
          reservationId: input.reservation.id,
          recipientId: input.reservation.customer_id,
          templateKey: input.action === "reject" ? "reservation_rejected" : "reservation_cancelled_by_admin",
          revision: input.nextVersion
        })
      );
    }
    statements.push(
      insertCalendarJob({
        db: input.db,
        reservationId: input.reservation.id,
        action: "delete",
        revision: input.nextVersion,
        nowIso: input.nowIso
      })
    );
  }

  if (input.action === "complete") {
    statements.push(buildCompleteVisitStatement(input));
  }

  if (input.action === "correct-no-show") {
    statements.push(buildVoidVisitStatement(input));
  }

  if (input.action === "restore-completed") {
    statements.push(buildRestoreVisitStatement(input));
  }

  // checked_in への読み替えは confirmed 起点のアクションだけに適用する。訂正は
  // completed / no_show 起点なので、過去に来店中を経由していても遷移元はその
  // 終端状態そのもの。読み替えると監査が遷移元を偽る。
  const previousStatus =
    !isCorrectionAction(input.action) && input.reservation.checked_in_at
      ? "checked_in"
      : input.reservation.status;

  statements.push(
    insertAuditLog({
      db: input.db,
      admin: input.admin,
      reservationId: input.reservation.id,
      // replaceAll: String.replace はハイフンを 1 個しか変換しないため、
      // correct-no-show のような 2 個以上のアクション名が壊れる。
      action: `admin_reservation_${input.action.replaceAll("-", "_")}`,
      metadata: {
        previousStatus,
        nextStatus: input.expectedStatus,
        // 却下のみ理由を記録する (listAdminAuditLogs が rejectionReason として
        // owner にも projection する)。他 action の metadata は従来形のまま。
        ...(input.action === "reject" ? { reason: input.rejectionReason } : {})
      }
    })
  );

  return statements;
};

const buildAdminActionStatements = (input: {
  db: D1Database;
  admin: AdminUser;
  action: AdminReservationAction;
  reservation: ReservationActionRow;
  nowIso: string;
  nextVersion: number;
  expectedStatus: AdminReservationSuccess["status"];
  rejectionReason: string | null;
}) => {
  if (input.action === "approve") {
    return buildApproveStatements(input);
  }
  return buildNonApproveStatements({
    ...input,
    action: input.action
  });
};

/**
 * 期間指定なしの管理一覧 (承認待ち / キャンセル料未納) が共有する store scope。
 * ここが staff とオーナーの認可境界そのものなので、一覧を増やすときも必ず
 * これを通す (同じ判定を各関数に複製すると片方だけ直す事故が起きる)。
 *
 * - owner / system_admin: 明示された storeId のときだけ絞る (未指定は全店舗)
 * - staff: 自店舗に固定。店舗紐付けが無ければ `blocked` (fail-closed: 呼び出し側は空を返す)
 * - それ以外: `blocked`。「staff でなければ特権」という書き方にすると、将来 role が
 *   増えたときや不整合データで全店舗が見えてしまうため、明示的な allowlist にする
 *
 * `admin` は必須。optional にすると渡し忘れが「全店舗が見える」方向に倒れる。
 */
type ListStoreScope = { blocked: true } | { blocked: false; storeId: string | null };

const resolveListStoreScope = (admin: AdminUser, storeId?: string | null): ListStoreScope => {
  if (admin.role === "owner" || admin.role === "system_admin") {
    return { blocked: false, storeId: storeId ?? null };
  }
  if (admin.role === "staff") {
    return admin.store_id ? { blocked: false, storeId: admin.store_id } : { blocked: true };
  }
  return { blocked: true };
};

export async function listPendingReservations(input: {
  db: D1Database;
  limit?: number;
  admin: AdminUser;
  storeId?: string | null;
}): Promise<PendingReservationListItem[]> {
  // 全予約承認制でこの一覧は承認業務のキューになった。pending は 24h TTL で自動
  // 失効するため件数は「直近24hの受付数」で有界 — サロン規模では 200 で十分に
  // 全件収まる (旧 50 はカード表示前提で、超過分が静かに消え承認漏れを招く)。
  // ponytail: 固定上限。ページング/総件数表示は 200 到達が現実化したら。
  const limit = input.limit ?? 200;
  // staff は自店舗 scope のみで日付制限なし: 承認待ち一覧は承認業務のキューであり、
  // 将来日の pending が見えないと staff が承認/却下を担えない (2026-07-04 全予約承認制。
  // 旧実装の staff 当日 clamp は GET /reservations 系の当日 scope に合わせたものだった)。
  const scope = resolveListStoreScope(input.admin, input.storeId);
  if (scope.blocked) {
    return [];
  }
  const storeId = scope.storeId;
  const storeFilter = storeId ? `AND reservations.store_id = ?` : "";
  const baseSelect = `
        SELECT
          reservations.id,
          reservations.status,
          reservations.store_id AS storeId,
          stores.name AS storeName,
          COALESCE(
            (
              SELECT GROUP_CONCAT(name_snapshot, ' / ')
              FROM (
                SELECT name_snapshot
                FROM reservation_services
                WHERE reservation_id = reservations.id
                ORDER BY display_order ASC
              )
            ),
            services.name
          ) AS serviceNames,
          reservations.start_at AS startAt,
          reservations.end_at AS endAt,
          customers.display_name AS customerDisplayName,
          COALESCE(${RESERVATION_LINE_FRIEND_STATUS_SUBQUERY}, 'unknown') AS lineFriendStatus,
          reservations.version AS version,
          strftime('%Y-%m-%dT%H:%M:%fZ', reservations.created_at) AS createdAt,
          strftime('%Y-%m-%dT%H:%M:%fZ', reservations.pending_expires_at) AS pendingExpiresAt
        FROM reservations
        JOIN customers ON customers.id = reservations.customer_id
        JOIN stores ON stores.id = reservations.store_id
        JOIN services ON services.id = reservations.service_id
        WHERE reservations.status = 'pending_approval'
          ${storeFilter}`;

  const binds: (string | number)[] = [];
  if (storeId) binds.push(storeId);
  binds.push(limit);
  const rows = await input.db
    .prepare(
      `${baseSelect}
        ORDER BY julianday(reservations.pending_expires_at) IS NULL,
          julianday(reservations.pending_expires_at) ASC,
          julianday(reservations.created_at) ASC,
          reservations.start_at ASC,
          reservations.id ASC
        LIMIT ?
      `
    )
    .bind(...binds)
    .all<PendingReservationListItem>();

  return rows.results ?? [];
}

export async function listUnpaidCancellationFees(input: {
  db: D1Database;
  limit?: number;
  admin: AdminUser;
  storeId?: string | null;
}): Promise<{ reservations: UnpaidCancellationFeeListItem[]; truncated: boolean }> {
  // この一覧は未納回収業務のキュー。承認待ちと違って未納フラグには TTL が無く
  // 無期限に積み上がるため、上限に当たったことを黙って隠さず truncated で返す
  // (古い順に並べるので、溢れて消えるのは「まだ回収できる可能性が高い新しい未納」)。
  // ponytail: ページングは truncated が実際に立ってから。上限+1件だけ余分に読む。
  const limit = input.limit ?? 200;
  // staff は自店舗 scope のみで日付制限なし: 未納一覧は回収業務のキューであり、
  // 古い未納が見えないと回収漏れを招く。owner / system_admin は storeId 指定時だけ絞る。
  const scope = resolveListStoreScope(input.admin, input.storeId);
  if (scope.blocked) {
    return { reservations: [], truncated: false };
  }
  const storeId = scope.storeId;
  const storeFilter = storeId ? `AND reservations.store_id = ?` : "";
  const baseSelect = `
        SELECT
          reservations.id,
          reservations.status,
          reservations.store_id AS storeId,
          stores.name AS storeName,
          COALESCE(
            (
              SELECT GROUP_CONCAT(name_snapshot, ' / ')
              FROM (
                SELECT name_snapshot
                FROM reservation_services
                WHERE reservation_id = reservations.id
                ORDER BY display_order ASC
              )
            ),
            services.name
          ) AS serviceNames,
          reservations.start_at AS startAt,
          reservations.end_at AS endAt,
          customers.display_name AS customerDisplayName,
          reservations.cancellation_fee_unpaid_at AS cancellationFeeUnpaidAt
        FROM reservations
        JOIN customers ON customers.id = reservations.customer_id
        JOIN stores ON stores.id = reservations.store_id
        JOIN services ON services.id = reservations.service_id
        WHERE reservations.cancellation_fee_unpaid_at IS NOT NULL
          ${storeFilter}`;

  const binds: (string | number)[] = [];
  if (storeId) binds.push(storeId);
  binds.push(limit + 1);
  const rows = await input.db
    .prepare(
      `${baseSelect}
        ORDER BY reservations.cancellation_fee_unpaid_at ASC, reservations.id ASC
        LIMIT ?
      `
    )
    .bind(...binds)
    .all<UnpaidCancellationFeeListItem>();

  const results = rows.results ?? [];
  return { reservations: results.slice(0, limit), truncated: results.length > limit };
}

export async function runAdminReservationAction(input: {
  db: D1Database;
  env: Partial<WorkerBindings>;
  admin: AdminUser;
  reservationId: string;
  action: AdminReservationAction;
  request: AdminActionRequest;
  fetcher?: typeof fetch;
  now?: () => number;
}): Promise<AdminReservationActionResult> {
  const now = input.now ?? Date.now;
  const nowMs = now();
  // Single clock for the whole action: the idempotency TTL read, the
  // started/succeeded rows, and expires_at all use this nowIso.
  const nowIso = new Date(nowMs).toISOString();
  const validationError = validateAdminActionInput(input);
  if (validationError) {
    return validationError;
  }

  if (input.admin.role === "staff" && !input.admin.store_id) {
    return { ok: false, reason: "forbidden" };
  }

  // 権限判定のうち予約を読まずに済む分はここで済ませる。後段の
  // validateAdminActionAuthorization でも再判定するので防壁は二重のまま。
  const correctionRoleError = validateCorrectionRole(input.admin, input.action);
  if (correctionRoleError) {
    return correctionRoleError;
  }

  // 成功済みキーでも現在の店舗権限を確認する。所属変更後に以前のキーを
  // 再送しても、権限を失った店舗の予約状態を返さない。
  const reservation = await fetchReservationForAction(input.db, input.reservationId);
  const authorizationError = reservation && validateAdminActionAuthorization({
    admin: input.admin,
    reservation,
    action: input.action
  });
  if (authorizationError) {
    return authorizationError;
  }

  const requestHash = await createRequestHash({
    reservationId: input.reservationId,
    action: input.action,
    request: input.request,
    admin: input.admin
  });
  const expectedStatus = expectedStatusByAction[input.action];
  const idempotencyResult = await resolveAdminActionIdempotency({
    db: input.db,
    key: input.request.idempotencyKey,
    requestHash,
    expectedStatus,
    nowIso,
    allowStatusDrift: isCorrectionAction(input.action)
  });
  if (idempotencyResult) {
    return idempotencyResult;
  }

  if (!reservation) {
    return {
      ok: false,
      reason: "not_found"
    };
  }

  const transitionError = validateReservationTransition(input.action, reservation, nowIso);
  if (transitionError) {
    return transitionError;
  }

  // 楽観ロック: 確認スナップショット取得後に別管理者が予約を変更 (version 加算) して
  // いたら、確認していない内容を確定させず再確認を求める。一括承認 (最大200件の
  // スナップショット) が主な利用者。認可・遷移チェック後に判定し、権限外の呼び出し
  // に version の存在を漏らさない。
  if (
    input.request.expectedVersion !== undefined &&
    reservation.version !== input.request.expectedVersion
  ) {
    return {
      ok: false,
      reason: "stale_snapshot"
    };
  }

  const idempotencyId = crypto.randomUUID();
  const reachabilityError = await verifyApprovalLineReachability({
    env: input.env,
    action: input.action,
    reservation,
    fetcher: input.fetcher
  });
  if (reachabilityError) {
    return reachabilityError;
  }

  const nextVersion = reservation.version + 1;
  const actionStatements = buildAdminActionStatements({
    db: input.db,
    admin: input.admin,
    action: input.action,
    reservation,
    nowIso,
    nextVersion,
    expectedStatus,
    // 制御文字除去 + 空文字・未指定は null (validateAdminActionInput が 500 字上限を保証済み)。
    rejectionReason: normalizeRejectReason(input.request.reason)
  });
  const statements: D1PreparedStatement[] = [
    adminWriteGuard(input.db, input.admin),
    createIdempotencyStarted({
      db: input.db,
      id: idempotencyId,
      key: input.request.idempotencyKey,
      requestHash,
      nowIso
    }),
    actionStatements[0],
    ...guardReservationTransitionApplied({
      db: input.db,
      idempotencyId,
      idempotencyKey: input.request.idempotencyKey,
      requestHash,
      reservationId: reservation.id,
      expectedStatus,
      nextVersion,
      adminId: input.admin.id,
      nowIso,
    }),
    ...actionStatements.slice(1),
    updateIdempotencySucceeded({
      db: input.db,
      idempotencyId,
      reservationId: reservation.id,
      nowIso
    })
  ];

  try {
    await input.db.batch(statements);
  } catch (error) {
    if (await adminWriteWasRevoked(input.db, input.admin, error)) {
      return { ok: false, reason: "forbidden" };
    }
    const recovered = await recoverReservationActionBatchFailure({
      db: input.db,
      key: input.request.idempotencyKey,
      requestHash,
      expectedStatus,
      nowIso,
      action: input.action,
      error
    });
    return classifyLateStaleSnapshot({
      db: input.db,
      reservationId: input.reservationId,
      expectedVersion: input.request.expectedVersion,
      recovered
    });
  }

  trackEvent(input.env, {
    type: ACTION_TO_EVENT[input.action],
    storeId: reservation.store_id,
    source: "admin",
    environment: input.env.ENVIRONMENT ?? "local"
  });

  // 訂正だけは status drift を許す。batch は guardReservationTransitionApplied で
  // コミット済みが確定しているので、この読み取りまでの間に別のオーナーが逆向きの
  // 訂正を成功させても write_failed (500) にはしない。応答の status / version は
  // replay と同じく「その時点の現在値」(docs/SPEC.md の訂正 replay 意味論)。
  return readReservationResult(
    input.db,
    reservation.id,
    false,
    expectedStatus,
    isCorrectionAction(input.action)
  );
}
