import type { WorkerBindings } from "../bindings";
import type { LineRateLimiter } from "./rate-limiter-do";
import type { DailyOpsPayload, DailyOpsStats } from "../notifications/daily-ops-summary";
import { safeCaptureException } from "../sentry-helpers";
import { withOutboundTimeout } from "../outbound-timeout";
import { trackEvent } from "../analytics/metrics";
import { JST_OFFSET_MS } from "../time-utils";
import {
  LINE_MONTHLY_QUOTA_EXHAUSTED,
  jstYearMonth,
  LINE_SHARED_CHANNEL_ENVIRONMENTS,
  countLineSendsSince,
  readLineQuotaStatus,
  optionalPushHeadroom
} from "./quota";
import { sendOperationsNotificationEmail } from "../notifications/operations-email";

export type LineNotificationResult = {
  processed: number;
  succeeded: number;
  failed: number;
};

type LineNotificationEnv = Pick<WorkerBindings, "LINE_MESSAGING_CHANNEL_ACCESS_TOKEN"> & {
  // Optional in this local type so existing test fixtures (which only stub
  // LINE_MESSAGING_CHANNEL_ACCESS_TOKEN) still satisfy it. Production callers
  // pass the full WorkerBindings env which always carries the flag; an
  // undefined value here is treated as 'false' by the strict equality check
  // in fetchNextLineNotificationJob.
  GOOGLE_DRIFT_ALERT_LIVE?: string;
  GOOGLE_CONFLICT_BURST_ALERT_LIVE?: string;
  DAILY_OPS_SUMMARY_DISPATCH_ENABLED?: string;
  // Durable Object rate limiter. Optional so unit tests that do not need
  // cross-handler rate limiting can omit it; when absent the dispatcher
  // falls back to chunk-level throttle only (pre-PR#131 behaviour).
  LINE_RATE_LIMITER?: DurableObjectNamespace<LineRateLimiter>;
  METRICS?: AnalyticsEngineDataset;
  ENVIRONMENT?: string;
  PENDING_APPROVAL_OWNER_EMAIL?: string;
  OPERATIONS_NOTIFICATION_EMAIL?: string;
  EMAIL?: SendEmail;
  // Soft cap below the free-plan 200/month at which optional pushes pause.
  LINE_MONTHLY_PUSH_SOFT_CAP?: string;
  // Reservation LIFF id used to deep-link the confirmation Flex card's
  // self-service button. Optional so test fixtures may omit it; when absent
  // the card is rendered without the button.
  LINE_LIFF_ID?: string;
};

// Optional LINE templates. New owner rows use email and bypass this set; the
// owner entries remain for queued pre-deploy rows that still carry LINE IDs.
const LINE_OPTIONAL_TEMPLATES = new Set([
  "reservation_reminder",
  "daily_ops_summary",
  "google_drift_alert",
  "google_conflict_burst_alert"
]);

type LineNotificationJobRow = {
  job_id: string;
  template_key: string;
  recipient_type: "customer" | "owner";
  recipient_id: string;
  // Step 3 (drift alert) — reservation-non-dependent rows have null here.
  reservation_id: string | null;
  attempts: number;
  line_user_id: string;
  store_name: string | null;
  store_timezone: string | null;
  start_at: string | null;
  status: string | null;
  // 顧客向け reservation_rejected 通知に含める却下理由 (BRANCH_A のみ実値、他は NULL)。
  rejection_reason: string | null;
  customer_display_name: string | null;
  // Set just before an owner email send starts. A claimed row that
  // already carries it had a send whose outcome is unknown — see migration 0048.
  email_inflight_at: string | null;
  // Step 3 — system-level payload (e.g. google_drift_alert counts). NULL for
  // reservation-backed rows.
  payload_json: string | null;
};

type DriftAlertPayload = {
  store_id: string;
  google_count: number;
  d1_count: number;
  drift: number;
  threshold: number;
};

type ReservationNotificationEligibilityRow = {
  status: string;
  pending_expires_at: string | null;
  start_at: string | null;
};

type LineNotificationJobClaim = {
  attempts: number;
  lockedUntil: string;
};

type LinePushResponse = {
  sentMessages?: {
    id?: string | number;
  }[];
};

const LINE_PUSH_ENDPOINT = "https://api.line.me/v2/bot/message/push";
export const LOCK_TTL_MS = 5 * 60 * 1000;
const RETRY_DELAY_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

// Existing queued fan-out rows still carry LINE user IDs. Keep those on the
// legacy transport during rollout; only email-sentinel owner rows use email.
const isOwnerEmailJob = (row: Pick<LineNotificationJobRow, "recipient_type" | "recipient_id">): boolean =>
  row.recipient_type === "owner" && row.recipient_id.startsWith("email:");

const OPS_EMAIL_SUBJECT_LABELS: Record<string, string> = {
  reservation_new_customer: "新規のご予約申込",
  pending_approval_created: "ご予約の申込があります",
  daily_ops_summary: "日次サマリー",
  google_drift_alert: "カレンダー同期ずれ検出",
  google_conflict_burst_alert: "カレンダー競合検出"
};

const buildOpsEmailSubject = (templateKey: string, environment?: string): string => {
  const envPrefix = environment && environment !== "production" ? `[${environment}] ` : "";
  const label = OPS_EMAIL_SUBJECT_LABELS[templateKey] ?? `通知 (${templateKey})`;
  return `${envPrefix}【予約通知】${label}`;
};

// ── Rate-limiter DO acquire ─────────────────────────────────────────
// Maximum retry attempts when the DO returns ok:false. With capacity=50
// and chunk size=5 the worst-case wait is ~150ms; 5 retries with
// exponential back-off covers transient bursts without infinite looping.
const RATE_ACQUIRE_MAX_RETRIES = 5;

// Upper bound for a single DO acquire() RPC. A healthy acquire returns in
// single-digit ms; a hung DO call would otherwise stall the scheduled /
// queue dispatcher just like a bare fetch. On timeout we fail closed (the
// existing catch path) so the shared budget is never silently bypassed.
const RATE_ACQUIRE_RPC_TIMEOUT_MS = 10_000;

/**
 * Race a single `stub.acquire(count)` RPC against a timeout. The timer is
 * always cleared in `finally` so a fast RPC never leaves a 10s timer tail.
 * A timeout rejects with a tagged error so the caller's catch can mark it
 * `rpc_timeout` while still failing closed.
 *
 * Accounting note: when the timeout wins, the loser `stub.acquire(count)`
 * RPC may still complete inside the DO and persist a token decrement — there
 * is no compensating `release()` call. This means up to one chunk's worth of
 * the 2000 req/min budget can drain without a corresponding send until the
 * per-minute window refills. The leak is bounded (at most one chunk per
 * timeout event), self-healing (refill restores the budget automatically),
 * and safe — the caller fails closed so no over-send can occur.
 */
const acquireWithTimeout = async (
  stub: DurableObjectStub<LineRateLimiter>,
  count: number,
  timeoutMs: number = RATE_ACQUIRE_RPC_TIMEOUT_MS
): Promise<{ ok: true } | { ok: false; retryAfterMs: number }> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`line_rate_limiter_rpc_timeout:${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([stub.acquire(count), timeout]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Acquire `count` tokens from the LINE rate-limiter Durable Object.
 *
 * Bypass (returns true) only when the binding is unset — unit tests
 * and local dev before the DO is deployed. With the binding present,
 * runtime failures fail closed (return false) so production cannot
 * silently bypass the only cross-handler rate ceiling.
 *
 * @returns `true` if tokens were acquired or binding is intentionally
 *          absent; `false` if budget is exhausted or the DO RPC failed.
 */
export async function acquireLineRateBudget(
  env: LineNotificationEnv,
  count: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise<void>((r) => setTimeout(r, ms))
): Promise<boolean> {
  // Explicit bypass: binding absent OR caller requested zero tokens.
  // Binding absence is a build-time / deploy-time signal, not a runtime
  // failure mode — it's safe to pass through.
  if (!env.LINE_RATE_LIMITER || count <= 0) {
    return true;
  }

  const id = env.LINE_RATE_LIMITER.idFromName("LINE_RATE_LIMITER");
  const stub = env.LINE_RATE_LIMITER.get(id);

  for (let attempt = 0; attempt <= RATE_ACQUIRE_MAX_RETRIES; attempt++) {
    try {
      const result = await acquireWithTimeout(stub, count);
      if (result.ok) {
        return true;
      }
      // Back off for the suggested duration (or at least 10ms).
      if (attempt < RATE_ACQUIRE_MAX_RETRIES) {
        await sleep(Math.max(result.retryAfterMs, 10));
      }
    } catch (error) {
      // DO communication failure (or RPC timeout) with binding present —
      // fail closed. The shared 2000 req/min LINE budget MUST be enforced
      // when the binding is configured; silently degrading to per-handler
      // throttle would let concurrent scheduled() + queue() invocations
      // exceed the cap, which is exactly what this DO prevents.
      // The dispatcher's outer loop will break and re-attempt on the
      // next invocation when the DO may have recovered.
      const isTimeout =
        error instanceof Error &&
        error.message.startsWith("line_rate_limiter_rpc_timeout:");
      safeCaptureException(error, {
        tags: {
          component: "line_rate_limiter_do",
          action: isTimeout ? "rpc_timeout" : "acquire_failed_closed"
        },
        contexts: { acquire: { count, attempt } }
      });
      return false;
    }
  }

  // Budget exhausted after retries.
  return false;
}

const toIso = (ms: number) => new Date(ms).toISOString();
const hasChangedRows = (result: D1Result) => {
  return Number(result.meta?.changes ?? 0) > 0;
};

const formatReservationStart = (startAt: string, timezone: string) => {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(new Date(startAt));
};

const lineMessageLeads: Record<string, string> = {
  reservation_pending_received: "予約を受け付けました。",
  reservation_confirmed: "予約が確定しました。",
  reservation_rejected: "予約をお取りできませんでした。",
  reservation_time_changed: "予約日時が変更されました。",
  reservation_cancelled_by_admin: "予約がキャンセルされました。",
  reservation_reminder: "ご予約のリマインダーです。",
  reservation_new_customer: "新規のお客様の予約です。",
  pending_approval_created: "ご予約の申込があります。"
};

const truncateReservationId = (id: string): string => (id.length > 8 ? `${id.slice(0, 8)}…` : id);

const buildPendingApprovalOwnerMessage = (row: LineNotificationJobRow): string => {
  // Owner-facing reservation alert: PII minimised. Surface only the store,
  // datetime, the customer's display name, and a prompt to approve.
  const lines = [
    lineMessageLeads[row.template_key] ?? "予約のお知らせです。",
    `予約: ${truncateReservationId(row.reservation_id ?? "")}`,
    `店舗: ${row.store_name ?? ""}`,
    `日時: ${row.start_at && row.store_timezone ? formatReservationStart(row.start_at, row.store_timezone) : ""}`
  ];
  if (row.customer_display_name) {
    lines.push(`顧客: ${row.customer_display_name}`);
  }
  lines.push("管理画面で承認してください。");
  return lines.join("\n");
};

const isPositiveFiniteInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;

const parseDriftPayload = (payload_json: string | null): DriftAlertPayload | null => {
  if (!payload_json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload_json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  if (typeof p.store_id !== "string" || p.store_id.length === 0) return null;
  if (!isPositiveFiniteInt(p.google_count)) return null;
  if (!isPositiveFiniteInt(p.d1_count)) return null;
  if (!isPositiveFiniteInt(p.drift)) return null;
  if (!isPositiveFiniteInt(p.threshold)) return null;
  return {
    store_id: p.store_id,
    google_count: p.google_count,
    d1_count: p.d1_count,
    drift: p.drift,
    threshold: p.threshold
  };
};

const renderDriftAlertMessage = async (
  db: D1Database,
  row: LineNotificationJobRow
): Promise<string> => {
  const payload = parseDriftPayload(row.payload_json);
  if (!payload) {
    return "⚠️ Calendar drift detected (details unavailable, payload malformed)";
  }
  // Renderer fetches store metadata from D1 instead of letting the SQL JOIN
  // on json_extract(payload_json,...) bring the dispatcher down on a
  // malformed row. Failure here is a fallback name only, not a hard error.
  let storeName = payload.store_id;
  try {
    const store = await db
      .prepare("SELECT name FROM stores WHERE id = ? LIMIT 1")
      .bind(payload.store_id)
      .first<{ name: string }>();
    if (store?.name) {
      storeName = store.name;
    }
  } catch {
    /* fallback to store_id */
  }
  return [
    "⚠️ Calendar sync drift detected",
    `店舗: ${storeName} (${payload.store_id})`,
    `Google: ${payload.google_count} events`,
    `D1: ${payload.d1_count} events`,
    `Drift: ${payload.drift} (threshold ${payload.threshold})`,
    "確認: sync dashboard"
  ].join("\n");
};

type ConflictBurstAlertPayload = {
  store_id: string;
  calendar_id: string;
  conflict_count: number;
  threshold: number;
  window_minutes: number;
};

const parseConflictBurstPayload = (
  payload_json: string | null
): ConflictBurstAlertPayload | null => {
  if (!payload_json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload_json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  if (typeof p.store_id !== "string" || p.store_id.length === 0) return null;
  if (typeof p.calendar_id !== "string" || p.calendar_id.length === 0) return null;
  if (!isPositiveFiniteInt(p.conflict_count)) return null;
  if (!isPositiveFiniteInt(p.threshold)) return null;
  if (!isPositiveFiniteInt(p.window_minutes)) return null;
  return {
    store_id: p.store_id,
    calendar_id: p.calendar_id,
    conflict_count: p.conflict_count,
    threshold: p.threshold,
    window_minutes: p.window_minutes
  };
};

const renderConflictBurstAlertMessage = async (
  db: D1Database,
  row: LineNotificationJobRow
): Promise<string> => {
  const payload = parseConflictBurstPayload(row.payload_json);
  if (!payload) {
    return "⚠️ Conflict burst detected (details unavailable, payload malformed)";
  }
  let storeName = payload.store_id;
  try {
    const store = await db
      .prepare("SELECT name FROM stores WHERE id = ? LIMIT 1")
      .bind(payload.store_id)
      .first<{ name: string }>();
    if (store?.name) {
      storeName = store.name;
    }
  } catch {
    /* fallback to store_id */
  }
  return [
    "🚨 Calendar conflict burst detected",
    `店舗: ${storeName} (${payload.store_id})`,
    `Conflicts: ${payload.conflict_count} (threshold ${payload.threshold} / ${payload.window_minutes} min)`,
    "確認: sync dashboard"
  ].join("\n");
};

/**
 * Parse daily_ops_summary payload with defensive validation.
 *
 * Returns a normalised DailyOpsPayload where missing/malformed array and
 * number fields are replaced with safe defaults (empty array / 0) so the
 * renderer never dereferences undefined.
 */
const parseDailyOpsPayload = (payload_json: string | null): DailyOpsPayload | null => {
  if (!payload_json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload_json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  if (typeof p.date_jst !== "string" || p.date_jst.length === 0) return null;
  if (!p.stats || typeof p.stats !== "object") return null;
  const s = p.stats as Record<string, unknown>;
  // Hand-written whitelist: DailyOpsStats is a type, so a new field that is
  // not copied here vanishes from the email with no compile error.
  const safeStats: DailyOpsStats = {
    today_reservations: Array.isArray(s.today_reservations) ? s.today_reservations : [],
    tomorrow_reservations: Array.isArray(s.tomorrow_reservations) ? s.tomorrow_reservations : [],
    open_conflicts: typeof s.open_conflicts === "number" ? s.open_conflicts : 0,
    dead_notification_jobs_24h: typeof s.dead_notification_jobs_24h === "number" ? s.dead_notification_jobs_24h : 0,
    dead_calendar_sync_jobs_24h: typeof s.dead_calendar_sync_jobs_24h === "number" ? s.dead_calendar_sync_jobs_24h : 0,
    past_end_still_confirmed: Array.isArray(s.past_end_still_confirmed) ? s.past_end_still_confirmed : [],
    unswept_past_grace: Array.isArray(s.unswept_past_grace) ? s.unswept_past_grace : [],
    auto_completed_today: typeof s.auto_completed_today === "number" ? s.auto_completed_today : 0,
    daily_cleanup_last_run_at: typeof s.daily_cleanup_last_run_at === "string" ? s.daily_cleanup_last_run_at : null
  };
  return { stats: safeStats, date_jst: p.date_jst };
};

/** Safely render a store-reservation-count entry; skip malformed items. */
const safeStoreEntry = (item: unknown): string | null => {
  if (!item || typeof item !== "object") return null;
  const s = item as Record<string, unknown>;
  const name = typeof s.store_name === "string" ? s.store_name : "?";
  const count = typeof s.count === "number" ? s.count : 0;
  return `  ${name}: ${count}件`;
};

const renderReservationSection = (
  label: string,
  items: unknown[]
): string[] => {
  const rendered = items.map(safeStoreEntry).filter((x): x is string => x !== null);
  if (rendered.length > 0) {
    return ["", label, ...rendered];
  }
  return ["", `${label}なし`];
};

// daily-cleanup fires at 01:05 JST, so last night's run falls inside the JST
// day this report is *for* — the report's own `date_jst` is the reference, not
// a wall clock. A retried job therefore still describes the morning it was
// generated for, and there is no window constant to keep in sync with the cron.
const dailyCleanupRunLabel = (lastRunAt: string | null, dateJst: string): string | null => {
  if (typeof lastRunAt !== "string") return null;
  const lastRunMs = Date.parse(lastRunAt);
  const jstDayStartMs = Date.parse(`${dateJst}T00:00:00+09:00`);
  if (!Number.isFinite(lastRunMs) || !Number.isFinite(jstDayStartMs) || lastRunMs < jstDayStartMs) {
    return null;
  }
  const jst = new Date(lastRunMs + JST_OFFSET_MS);
  return `${String(jst.getUTCHours()).padStart(2, "0")}:${String(jst.getUTCMinutes()).padStart(2, "0")}`;
};

const renderDailyOpsSummaryMessage = (row: LineNotificationJobRow): string => {
  const payload = parseDailyOpsPayload(row.payload_json);
  if (!payload) {
    return "📊 Daily operations summary (details unavailable, payload malformed)";
  }
  const { stats, date_jst } = payload;
  const lines: string[] = [
    `📊 ${date_jst} 営業日報`
  ];
  const cleanupHm = dailyCleanupRunLabel(stats.daily_cleanup_last_run_at, date_jst);

  lines.push(
    ...renderReservationSection("【本日の予約】", stats.today_reservations),
    ...renderReservationSection("【明日の予約】", stats.tomorrow_reservations),
    ...renderReservationSection("【終了済み・完了待ちの予約】", stats.past_end_still_confirmed),
    ...renderReservationSection("【猶予期限切れで未処理の予約】", stats.unswept_past_grace),
    "",
    // Always emit K as a number. Hiding `0` behind `if (x > 0)` (the
    // 【注意事項】 pattern) makes "sweep ran, completed nothing" look like
    // "this field was never implemented".
    `自動完了（手動補完を含む）: ${stats.auto_completed_today} 件`,
    cleanupHm
      ? `日次クリーンアップ（01:05 JST）: 実行済み ${cleanupHm}`
      : "日次クリーンアップ（01:05 JST）: 記録なし"
  );

  // Attention items
  const attentionItems: string[] = [];
  if (stats.open_conflicts > 0) {
    attentionItems.push(`未解決コンフリクト: ${stats.open_conflicts}件`);
  }
  if (stats.dead_notification_jobs_24h > 0) {
    attentionItems.push(`通知失敗 (24h): ${stats.dead_notification_jobs_24h}件`);
  }
  if (stats.dead_calendar_sync_jobs_24h > 0) {
    attentionItems.push(`同期失敗 (24h): ${stats.dead_calendar_sync_jobs_24h}件`);
  }
  if (!cleanupHm) {
    attentionItems.push("日次クリーンアップが前夜に実行された記録がありません");
  }
  if (attentionItems.length > 0) {
    lines.push("", "【注意事項】");
    for (const item of attentionItems) {
      lines.push(`  ⚠️ ${item}`);
    }
  }

  return lines.join("\n");
};

const formatOptionalReservationStart = (row: LineNotificationJobRow): string =>
  row.start_at && row.store_timezone ? formatReservationStart(row.start_at, row.store_timezone) : "";

// 予約系 LINE 文面の共通ボディ (lead + 日時 + 店舗)。却下通知・既定文面で共用する。
const buildReservationBodyLines = (row: LineNotificationJobRow, lead: string): string[] => [
  lead,
  `日時: ${formatOptionalReservationStart(row)}`,
  `店舗: ${row.store_name ?? ""}`,
];

const buildLineMessageText = async (db: D1Database, row: LineNotificationJobRow): Promise<string> => {
  // System-level owner alerts dispatch first; they depend on D1 store
  // lookup, not on reservation/store columns of the row.
  if (row.template_key === "google_drift_alert") {
    return renderDriftAlertMessage(db, row);
  }
  if (row.template_key === "google_conflict_burst_alert") {
    return renderConflictBurstAlertMessage(db, row);
  }
  if (row.template_key === "daily_ops_summary") {
    return renderDailyOpsSummaryMessage(row);
  }
  if (
    row.recipient_type === "owner" &&
    (row.template_key === "reservation_new_customer" || row.template_key === "pending_approval_created")
  ) {
    return buildPendingApprovalOwnerMessage(row);
  }
  if (row.template_key === "reservation_rejected") {
    // 顧客向け却下通知。既定文面 (lead + 日時 + 店舗) に、却下理由が入力されていれば
    // 末尾に理由行を添える。理由は admin 側で制御文字除去済み (normalizeRejectReason)。
    const lines = buildReservationBodyLines(row, lineMessageLeads.reservation_rejected);
    const reason = row.rejection_reason?.trim();
    if (reason) {
      lines.push(`理由: ${truncateForLine(reason, 300)}`);
    }
    return lines.join("\n");
  }
  const lead = lineMessageLeads[row.template_key] ?? "予約のお知らせです。";
  return buildReservationBodyLines(row, lead).join("\n");
};

// Branch A: existing reservation-backed templates. Always-on. payload_json is
// projected as `NULL` so this branch never references the 0013 migration
// column — the dispatcher remains operable on a worker rolled forward before
// `npm run d1:migrations:apply:<env>` adds notification_jobs.payload_json.
const BRANCH_A_SQL = `
  SELECT
    notification_jobs.id AS job_id,
    notification_jobs.template_key AS template_key,
    notification_jobs.recipient_type AS recipient_type,
    notification_jobs.recipient_id AS recipient_id,
    notification_jobs.reservation_id AS reservation_id,
    notification_jobs.attempts AS attempts,
    CASE WHEN notification_jobs.recipient_type = 'owner'
           THEN notification_jobs.recipient_id
         ELSE line_identities.line_user_id
    END AS line_user_id,
    stores.name AS store_name,
    stores.timezone AS store_timezone,
    reservations.start_at AS start_at,
    reservations.status AS status,
    reservations.rejection_reason AS rejection_reason,
    resv_customer.display_name AS customer_display_name,
    notification_jobs.email_inflight_at AS email_inflight_at,
    NULL AS payload_json,
    notification_jobs.available_at AS sort_available_at,
    notification_jobs.created_at AS sort_created_at
  FROM notification_jobs
  JOIN reservations ON reservations.id = notification_jobs.reservation_id
  JOIN stores ON stores.id = reservations.store_id
  LEFT JOIN line_identities ON line_identities.id = reservations.line_identity_id
  LEFT JOIN customers resv_customer ON resv_customer.id = reservations.customer_id
  WHERE notification_jobs.recipient_type IN ('customer', 'owner')
    AND (
      (notification_jobs.status IN ('queued', 'retryable')
        AND notification_jobs.available_at <= ?)
      OR
      (notification_jobs.status = 'processing'
        AND notification_jobs.locked_until < ?
        AND notification_jobs.attempts < ?)
    )
    AND notification_jobs.template_key IN (
      'reservation_pending_received',
      'reservation_confirmed',
      'reservation_rejected',
      'reservation_time_changed',
      'reservation_cancelled_by_admin',
      'reservation_reminder',
      'reservation_new_customer',
      'pending_approval_created'
    )
`;

// Branch B: system-level owner notifications (no reservation_id). Only
// included when at least one producer-side flag is on. References
// notification_jobs.payload_json directly, which requires the 0013 migration
// (additive ALTER TABLE) to be applied first.
// Branch B handles system-level owner notification templates:
//   google_drift_alert (PR #54) — daily full_reconcile drift signal
//   google_conflict_burst_alert (PR #59) — rolling 5-min conflict burst
//   daily_ops_summary — 20:00 JST daily operations summary
// All share the same shape (owner recipient, payload_json carries the
// structured context, no reservation_id). Producer-side feature flags
// (GOOGLE_DRIFT_ALERT_LIVE / GOOGLE_CONFLICT_BURST_ALERT_LIVE /
// DAILY_OPS_SUMMARY_DISPATCH_ENABLED) gate enqueue, so when a flag is
// off no rows of that template exist to dispatch. Branch B itself is
// only included in the SQL when at least one of the consumer-side flags
// is set, so the dispatcher stays column-safe on a worker rolled forward
// before the 0013 migration is applied.
const BRANCH_B_SQL = `
  SELECT
    notification_jobs.id AS job_id,
    notification_jobs.template_key AS template_key,
    'owner' AS recipient_type,
    notification_jobs.recipient_id AS recipient_id,
    NULL AS reservation_id,
    notification_jobs.attempts AS attempts,
    notification_jobs.recipient_id AS line_user_id,
    NULL AS store_name,
    NULL AS store_timezone,
    NULL AS start_at,
    NULL AS status,
    NULL AS rejection_reason,
    NULL AS customer_display_name,
    notification_jobs.email_inflight_at AS email_inflight_at,
    notification_jobs.payload_json AS payload_json,
    notification_jobs.available_at AS sort_available_at,
    notification_jobs.created_at AS sort_created_at
  FROM notification_jobs
  WHERE notification_jobs.template_key IN ('google_drift_alert', 'google_conflict_burst_alert', 'daily_ops_summary')
    AND notification_jobs.recipient_type = 'owner'
    AND (
      (notification_jobs.status IN ('queued', 'retryable')
        AND notification_jobs.available_at <= ?)
      OR
      (notification_jobs.status = 'processing'
        AND notification_jobs.locked_until < ?
        AND notification_jobs.attempts < ?)
    )
`;

const fetchNextLineNotificationJob = async (
  db: D1Database,
  nowIso: string,
  branchBEnabled: boolean,
  jobIdsFilter?: string[]
) => {
  // Step 3 — split into two UNION ALL branches:
  //   Branch A: existing reservation-backed templates (unchanged semantics,
  //             always-on, column-safe).
  //   Branch B: google_drift_alert. Gated by GOOGLE_DRIFT_ALERT_LIVE so that
  //             worker code rolled forward before the 0013 migration is
  //             applied does not crash on the unknown payload_json column —
  //             the flag stays at its 'false' default until the migration
  //             plus runtime:apply are paired on each env.
  // Both branches expose `sort_available_at` + `sort_created_at` aliases so
  // the outer ORDER BY can reference them (SQLite compound SELECT semantics).
  //
  // Flag rollback semantics: turning the flag back to 'false' after rows have
  // been enqueued strands any queued/retryable/processing google_drift_alert
  // rows because Branch B is dropped from the SELECT. If you re-flip to
  // 'true' later, those stale snapshots will start dispatching with the
  // original (now possibly stale) drift counts. The supported recovery
  // procedure is to run
  //   UPDATE notification_jobs
  //   SET status='dead', last_error='drift_alert_flag_rolled_back', updated_at=?
  //   WHERE template_key='google_drift_alert'
  //     AND status IN ('queued','retryable','processing');
  // on each affected env's D1 before re-enabling the flag, so the next
  // full_reconcile re-enqueues fresh rows from current drift counts rather
  // than dispatching the stale backlog.
  const idFilterClause = jobIdsFilter && jobIdsFilter.length > 0
    ? ` AND notification_jobs.id IN (${jobIdsFilter.map(() => "?").join(",")})`
    : "";
  const branchASql = BRANCH_A_SQL + idFilterClause;
  const branchBSql = BRANCH_B_SQL + idFilterClause;
  const sqlBody = branchBEnabled
    ? `${branchASql} UNION ALL ${branchBSql}`
    : branchASql;
  const sql = `
    SELECT * FROM (${sqlBody})
    ORDER BY sort_available_at ASC, sort_created_at ASC
    LIMIT 1
  `;
  const filterIds = jobIdsFilter && jobIdsFilter.length > 0 ? jobIdsFilter : [];
  const binds = branchBEnabled
    ? [nowIso, nowIso, MAX_ATTEMPTS, ...filterIds, nowIso, nowIso, MAX_ATTEMPTS, ...filterIds]
    : [nowIso, nowIso, MAX_ATTEMPTS, ...filterIds];
  return db
    .prepare(sql)
    .bind(...binds)
    .first<LineNotificationJobRow>();
};


// Dead-letter any stale `processing` rows whose attempt counter is already at the
// retry cap (codex #9 follow-up). Without this sweep, repeated worker crashes
// after markJobProcessing but before markJobFailure could bypass MAX_ATTEMPTS.
const markStaleNotificationClaimsExhausted = async (db: D1Database, nowMs: number) => {
  const nowIso = toIso(nowMs);
  const result = await db
    .prepare(
      `
        UPDATE notification_jobs
        SET status = 'dead',
            locked_until = NULL,
            last_error = 'exhausted_after_repeated_crash',
            -- email_inflight_at is deliberately NOT cleared here, unlike in
            -- markJobFailure: there the send definitively did not deliver, but
            -- this sweep exists precisely for workers that died with the
            -- outcome UNKNOWN. The marker is non-NULL only for email-only
            -- rows, where it is the one record that a send may have reached
            -- the provider — clearing it would erase that discriminator.
            updated_at = ?
        WHERE status = 'processing'
          AND locked_until < ?
          AND attempts >= ?
      `
    )
    .bind(nowIso, nowIso, MAX_ATTEMPTS)
    .run();
  // Crash-loop dead-lettering: a worker that died mid-claim never reached
  // markJobFailure, so capture here — otherwise these jobs die silently for
  // both cron and workflow callers. Known accepted overlap: a final-attempt
  // job whose unhandled throw WAS captured (chunk_job_unexpected_throw) also
  // lands here after lock expiry — the sweep cannot distinguish a dead worker
  // from a caught throw, and one extra aggregate event on that rare path
  // beats losing the true-crash signal.
  const deadCount = Number(result.meta?.changes ?? 0);
  if (deadCount > 0) {
    safeCaptureException(
      new Error(`line notification jobs dead-lettered after repeated crash: ${deadCount}`),
      { tags: { dispatcher: "line_push", reason: "exhausted_after_repeated_crash" } }
    );
  }
};

// Rollback a markJobProcessing claim without burning the attempt counter.
// Used when the dispatcher cannot proceed for reasons orthogonal to delivery
// outcome (e.g. cross-handler rate-limiter denial / DO RPC failure). CAS guards
// against racing workers that may have re-claimed the row in the meantime.
const RELEASE_CLAIM_SQL = `
  UPDATE notification_jobs
  SET status = 'queued',
      attempts = attempts - 1,
      locked_until = NULL,
      updated_at = ?
  WHERE id = ?
    AND status = 'processing'
    AND attempts = ?
    AND locked_until = ?
`;

// Batched rollback for a whole chunk of claims — single D1 round-trip
// instead of one per job. Used by the rate-limiter denial path where
// up to PARALLEL_CHUNK_SIZE rows need to release at once.
const releaseLineNotificationClaimsBatch = async (
  db: D1Database,
  jobs: ReadonlyArray<{ row: LineNotificationJobRow; claim: LineNotificationJobClaim }>,
  nowMs: number
): Promise<void> => {
  if (jobs.length === 0) return;
  const nowIso = toIso(nowMs);
  await db.batch(
    jobs.map((job) =>
      db
        .prepare(RELEASE_CLAIM_SQL)
        .bind(nowIso, job.row.job_id, job.claim.attempts, job.claim.lockedUntil)
    )
  );
};

const markJobProcessing = async (db: D1Database, row: LineNotificationJobRow, nowMs: number) => {
  const nowIso = toIso(nowMs);
  const lockedUntil = toIso(nowMs + LOCK_TTL_MS);
  const result = await db
    .prepare(
      `
        UPDATE notification_jobs
        SET status = 'processing',
            attempts = attempts + 1,
            locked_until = ?,
            updated_at = ?
        WHERE id = ?
          AND (
            (status IN ('queued', 'retryable') AND available_at <= ?)
            OR
            (status = 'processing' AND locked_until < ? AND attempts < ?)
          )
      `
    )
    .bind(lockedUntil, nowIso, row.job_id, nowIso, nowIso, MAX_ATTEMPTS)
    .run();
  return hasChangedRows(result)
    ? {
        attempts: row.attempts + 1,
        lockedUntil
      }
    : undefined;
};

const lineNotificationClaimExistsSql = `
  SELECT 1
  FROM notification_jobs
  WHERE id = ?
    AND status = 'processing'
    AND attempts = ?
    AND locked_until = ?
`;

const lineNotificationClaimBindings = (row: LineNotificationJobRow, claim: LineNotificationJobClaim) => [
  row.job_id,
  claim.attempts,
  claim.lockedUntil
];

const markJobSuperseded = async (
  db: D1Database,
  row: LineNotificationJobRow,
  reason: string,
  claim: LineNotificationJobClaim,
  nowMs: number
) => {
  const result = await db
    .prepare(
      `
        UPDATE notification_jobs
        SET status = 'succeeded',
            locked_until = NULL,
            last_error = ?,
            updated_at = ?
        WHERE id = ?
          AND EXISTS (${lineNotificationClaimExistsSql})
      `
    )
    .bind(reason, toIso(nowMs), row.job_id, ...lineNotificationClaimBindings(row, claim))
    .run();
  return hasChangedRows(result);
};

// Lifecycle supersedence: newer templates that make older ones irrelevant.
// Key = older template; value = set of templates that supersede it.
const SUPERSEDING_TEMPLATES: Record<string, readonly string[]> = {
  reservation_confirmed: [
    "reservation_time_changed",
    "reservation_cancelled_by_admin",
    "reservation_rejected"
  ],
  reservation_time_changed: [
    "reservation_cancelled_by_admin",
    "reservation_rejected"
  ],
  reservation_reminder: [
    "reservation_cancelled_by_admin",
    "reservation_rejected"
  ]
};

/**
 * Returns true when a newer notification job exists for the same reservation
 * with a template_key that supersedes the current row's template. "Newer" is
 * determined by created_at > row's created_at (with rowid as tiebreaker for
 * rows created within the same second).
 *
 * The tiebreaker uses SQLite's implicit `rowid` which is a monotonically
 * increasing integer assigned at INSERT time. This guarantees deterministic
 * ordering that matches true enqueue order, unlike the previous UUIDv4 `id`
 * comparison which produced nondeterministic results for same-second inserts.
 *
 * Safety: D1 is single-writer and does not expose user-callable VACUUM, so
 * rowid values for co-existing rows are stable and correctly ordered.
 * See: https://www.sqlite.org/rowidtable.html
 */
const hasSupersedingJob = async (
  db: D1Database,
  row: LineNotificationJobRow
): Promise<boolean> => {
  const supersedingKeys = SUPERSEDING_TEMPLATES[row.template_key];
  if (!supersedingKeys || supersedingKeys.length === 0) return false;
  if (!row.reservation_id) return false;

  const placeholders = supersedingKeys.map(() => "?").join(",");
  const result = await db
    .prepare(
      `
        SELECT 1
        FROM notification_jobs
        WHERE reservation_id = ?
          AND template_key IN (${placeholders})
          AND status != 'dead'
          AND (created_at > (SELECT created_at FROM notification_jobs WHERE id = ?)
               OR (created_at = (SELECT created_at FROM notification_jobs WHERE id = ?)
                   AND rowid > (SELECT rowid FROM notification_jobs WHERE id = ?)))
        LIMIT 1
      `
    )
    .bind(row.reservation_id, ...supersedingKeys, row.job_id, row.job_id, row.job_id)
    .first();
  return result !== null;
};

const isLineNotificationStillEligible = async (
  db: D1Database,
  row: LineNotificationJobRow,
  nowIso: string
) => {
  // System-level events (drift alert, conflict burst, daily ops summary)
  // carry a snapshot payload captured at enqueue time. There is no
  // reservation to re-check; sending the stale snapshot is acceptable
  // (the threshold-crossing fact / daily stats are what matters), so
  // short-circuit before the reservation lookup.
  if (
    row.template_key === "google_drift_alert" ||
    row.template_key === "google_conflict_burst_alert" ||
    row.template_key === "daily_ops_summary"
  ) {
    return true;
  }

  // Supersedence check: skip this job if a newer job with a later-lifecycle
  // template exists for the same reservation (e.g. a confirmed retry is
  // irrelevant when a time_changed or cancelled job has been enqueued since).
  if (await hasSupersedingJob(db, row)) {
    return false;
  }

  const reservation = await db
    .prepare(
      `
        SELECT status, pending_expires_at, start_at
        FROM reservations
        WHERE id = ?
        LIMIT 1
      `
    )
    .bind(row.reservation_id)
    .first<ReservationNotificationEligibilityRow>();

  switch (row.template_key) {
    case "reservation_pending_received":
      return reservation?.status === "pending_approval" &&
        (reservation.pending_expires_at === null || reservation.pending_expires_at > nowIso);
    case "reservation_confirmed":
      return reservation?.status === "confirmed";
    case "reservation_rejected":
      return reservation?.status === "rejected";
    case "reservation_time_changed":
      return reservation?.status === "pending_approval" || reservation?.status === "confirmed";
    case "reservation_cancelled_by_admin":
      return reservation?.status === "cancelled_by_admin";
    case "reservation_new_customer":
    case "pending_approval_created":
      // Owner approval prompt — only useful while the booking is still awaiting
      // approval and within its pending window. If the owner already approved
      // (confirmed) or it was rejected/cancelled/expired before dispatch, the
      // "管理画面で承認してください" message would be stale, so skip it. Mirrors
      // reservation_pending_received's expiry check.
      return (
        reservation?.status === "pending_approval" &&
        (reservation.pending_expires_at === null || reservation.pending_expires_at > nowIso)
      );
    case "reservation_reminder":
      return reservation?.status === "confirmed" &&
        reservation.start_at !== null &&
        reservation.start_at > nowIso;
    default:
      // Includes the retired change_request_* templates: any legacy row that
      // re-enters the queue is skipped, never re-sent.
      return false;
  }
};

const markJobFailure = async (
  db: D1Database,
  row: LineNotificationJobRow,
  reason: string,
  claim: LineNotificationJobClaim,
  nowMs: number
): Promise<"failed" | "skipped"> => {
  const nextAttempts = claim.attempts;
  const status = reason === LINE_MONTHLY_QUOTA_EXHAUSTED || nextAttempts >= MAX_ATTEMPTS ? "dead" : "retryable";
  const availableAt = status === "dead" ? toIso(nowMs) : toIso(nowMs + RETRY_DELAY_MS);

  const results = await db.batch([
    db
      .prepare(
        `
          INSERT INTO notification_logs (
            id,
            notification_job_id,
            template_key,
            recipient_type,
            recipient_id,
            reservation_id,
            attempt,
            status,
            error,
            sent_count
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, 'failed', ?, 0
          WHERE EXISTS (${lineNotificationClaimExistsSql})
        `
      )
      .bind(
        crypto.randomUUID(),
        row.job_id,
        row.template_key,
        row.recipient_type,
        row.recipient_id,
        row.reservation_id,
        nextAttempts,
        reason,
        ...lineNotificationClaimBindings(row, claim)
      ),
    db
      .prepare(
        `
          UPDATE notification_jobs
          SET status = ?,
              attempts = ?,
              available_at = ?,
              locked_until = NULL,
              last_error = ?,
              -- Cleared in the SAME statement that records the failure: the send
              -- definitively did not deliver, so the retry must be allowed to send.
              -- A separate clear could throw and leave the marker behind, which the
              -- next claim would read as "outcome unknown" and terminally skip
              -- (migration 0048). Always NULL for LINE rows, so this is a no-op there.
              email_inflight_at = NULL,
              updated_at = ?
          WHERE id = ?
            AND EXISTS (${lineNotificationClaimExistsSql})
        `
      )
      .bind(status, nextAttempts, availableAt, reason, toIso(nowMs), row.job_id, ...lineNotificationClaimBindings(row, claim))
  ]);
  return hasChangedRows(results[1]) ? "failed" : "skipped";
};

// ── LINE message payloads ───────────────────────────────────────────
// A reservation confirmation is upgraded from a plain text push to a Flex
// "bubble" card (organised rows + a self-service button). Every other
// template stays text-only. The card's altText reuses the exact plain text
// we already build, so it doubles as the notification-preview / unsupported-
// client fallback and no information is lost. A Flex push carries the SAME
// quota weight as a text push (1 message = 1 unit), so this does not change
// LINE monthly usage. Scope is intentionally limited to the customer-facing
// `reservation_confirmed` template for now; other templates are unaffected.
type LineTextMessage = { type: "text"; text: string };
type LineFlexMessage = { type: "flex"; altText: string; contents: Record<string, unknown> };
type LineMessage = LineTextMessage | LineFlexMessage;

// Conservative altText cap, comfortably inside LINE's documented Flex altText
// limit. In practice the source text is the short 3-line confirmation message
// (~60 chars), so this never triggers; it is purely a defensive guard so an
// unexpectedly long value can never push the altText past the API limit.
const LINE_ALT_TEXT_MAX = 400;
export const truncateForLine = (value: string, max: number): string => {
  // Fast path: already within the cap (UTF-16 length <= max ⇒ code-point count
  // <= max), so return as-is without allocating.
  if (value.length <= max) {
    return value;
  }
  // Slice by Unicode code points rather than UTF-16 units so a multi-byte
  // character / emoji at the boundary is never split into a malformed
  // surrogate half.
  const chars = Array.from(value);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : value;
};

const flexDetailRow = (label: string, value: string): Record<string, unknown> => ({
  type: "box",
  layout: "baseline",
  spacing: "sm",
  contents: [
    { type: "text", text: label, size: "sm", color: "#767676", flex: 2 },
    { type: "text", text: value, size: "sm", color: "#111111", weight: "bold", wrap: true, flex: 5 }
  ]
});

const buildConfirmationFlexMessage = (
  row: LineNotificationJobRow,
  env: { LINE_LIFF_ID?: string },
  altText: string
): LineFlexMessage | null => {
  // Only the customer-facing reservation-confirmed push is carded for now.
  if (row.recipient_type !== "customer" || row.template_key !== "reservation_confirmed") {
    return null;
  }
  // The card renders these three fields; if any core datum is missing, fall
  // back to the plain text message rather than render a half-empty card.
  if (!row.start_at || !row.store_timezone || !row.store_name) {
    return null;
  }

  const detailRows: Record<string, unknown>[] = [
    flexDetailRow("日時", formatReservationStart(row.start_at, row.store_timezone)),
    flexDetailRow("店舗", truncateForLine(row.store_name, 60))
  ];
  if (row.customer_display_name) {
    detailRows.push(flexDetailRow("お名前", `${truncateForLine(row.customer_display_name, 40)} 様`));
  }

  const bubble: Record<string, unknown> = {
    type: "bubble",
    header: {
      type: "box",
      layout: "vertical",
      backgroundColor: "#111111",
      paddingAll: "16px",
      contents: [
        { type: "text", text: "RESERVATION CONFIRMED", size: "xxs", weight: "bold", color: "#BDBDBD" },
        { type: "text", text: "ご予約が確定しました", size: "lg", weight: "bold", color: "#FFFFFF", wrap: true, margin: "xs" }
      ]
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      paddingAll: "16px",
      contents: detailRows
    }
  };

  // The self-service button deep-links into the reservation LIFF. When the
  // LIFF id is not configured (e.g. unstubbed test env) we simply omit the
  // footer rather than emit a broken URL.
  const liffId = env.LINE_LIFF_ID;
  if (liffId) {
    bubble.footer = {
      type: "box",
      layout: "vertical",
      paddingAll: "12px",
      contents: [
        {
          type: "button",
          style: "primary",
          color: "#111111",
          height: "sm",
          // Deep-link straight to the customer's reservation page (view-only
          // since the change-request retirement). LIFF resolves
          // `liff.line.me/<id>/customer/reservations` via liff.state and our
          // server-side 302 (src/index.ts) lands them there, instead of
          // dropping them on the booking root.
          action: {
            type: "uri",
            label: "予約を確認する",
            uri: `https://liff.line.me/${encodeURIComponent(liffId)}/customer/reservations`
          }
        }
      ]
    };
  }

  return { type: "flex", altText: truncateForLine(altText, LINE_ALT_TEXT_MAX), contents: bubble };
};

// Build the LINE push `messages` payload for a job: a Flex card for the
// reservation-confirmed customer push, plain text for everything else.
export const buildLineMessages = (
  row: LineNotificationJobRow,
  env: { LINE_LIFF_ID?: string },
  messageText: string
): LineMessage[] => {
  const flex = buildConfirmationFlexMessage(row, env, messageText);
  return flex ? [flex] : [{ type: "text", text: messageText }];
};

const sendLinePush = async (
  row: LineNotificationJobRow,
  accessToken: string,
  fetcher: typeof fetch,
  messages: LineMessage[]
) => {
  const response = await fetcher(LINE_PUSH_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "X-Line-Retry-Key": row.job_id
    },
    body: JSON.stringify({
      to: row.line_user_id,
      messages,
      notificationDisabled: false
    })
  });

  // 409 Conflict with X-Line-Retry-Key means the FIRST request with this
  // retry key was already accepted — the push was delivered and must be
  // treated as success, not failure. This matters with the 30s outbound
  // timeout: LINE can accept the push while the Worker aborts the response,
  // and the retry then sees 409. Treating it as a failure would dead-letter
  // (or re-send) an already-delivered notification.
  // https://developers.line.biz/en/docs/messaging-api/retrying-api-request/
  if (response.status === 409) {
    const acceptedRequestId = response.headers.get("x-line-accepted-request-id");
    // Drop the unread body so the runtime can release the connection cleanly
    // (Workers warns about unconsumed response bodies). Best-effort.
    await response.body?.cancel().catch(() => {});
    return {
      ok: true as const,
      providerMessageId: acceptedRequestId ? `accepted:${acceptedRequestId}` : null
    };
  }

  if (!response.ok) {
    // 429 also covers per-second rate limits. Only LINE's documented monthly
    // quota response is terminal; never persist the provider's raw body.
    const error = response.status === 429
      ? await response.json().catch(() => null) as { message?: unknown } | null
      : null;
    return {
      ok: false as const,
      reason: error?.message === "You have reached your monthly limit."
        ? LINE_MONTHLY_QUOTA_EXHAUSTED
        : `line-http-${response.status}`
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false as const,
      reason: "line-invalid-json"
    };
  }

  const sentMessages = (payload as LinePushResponse | null)?.sentMessages;
  const providerMessageId = Array.isArray(sentMessages) && sentMessages[0]?.id !== undefined
    ? String(sentMessages[0].id)
    : null;

  return {
    ok: true as const,
    providerMessageId
  };
};

const markJobSuccess = async (
  db: D1Database,
  row: LineNotificationJobRow,
  providerMessageId: string | null,
  claim: LineNotificationJobClaim,
  nowMs: number,
  sentCount = 1
) => {
  const results = await db.batch([
    db
      .prepare(
        `
          INSERT INTO notification_logs (
            id,
            notification_job_id,
            template_key,
            recipient_type,
            recipient_id,
            reservation_id,
            attempt,
            status,
            provider_message_id,
            sent_count,
            created_at
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, 'succeeded', ?, ?, ?
          WHERE EXISTS (${lineNotificationClaimExistsSql})
        `
      )
      .bind(
        crypto.randomUUID(),
        row.job_id,
        row.template_key,
        row.recipient_type,
        row.recipient_id,
        row.reservation_id,
        claim.attempts,
        providerMessageId,
        sentCount,
        toIso(nowMs),
        ...lineNotificationClaimBindings(row, claim)
      ),
    db
      .prepare(
        `
          UPDATE notification_jobs
          SET status = 'succeeded',
              locked_until = NULL,
              last_error = NULL,
              updated_at = ?
          WHERE id = ?
            AND EXISTS (${lineNotificationClaimExistsSql})
        `
      )
      .bind(toIso(nowMs), row.job_id, ...lineNotificationClaimBindings(row, claim))
  ]);
  return hasChangedRows(results[1]);
};

type LineNotificationJobOutcome = "succeeded" | "failed" | "skipped";

/**
 * Recipients for an owner notification email, or `undefined`
 * when nothing is configured. Resolved BEFORE the in-flight marker is stamped so a
 * config error never looks like an interrupted send.
 *
 * - `primary` — `PENDING_APPROVAL_OWNER_EMAIL` (trimmed); empty falls back to
 *   `OPERATIONS_NOTIFICATION_EMAIL`. Job success/failure is judged on this send only.
 * - `mirror` — `OPERATIONS_NOTIFICATION_EMAIL` when set and different from primary.
 *   Always-on copy on the first delivery attempt only (see
 *   `processOwnerEmailJob`); best-effort and never affects job outcome.
 *   When primary IS the operations address there is no second destination.
 */
const resolveOwnerEmailRecipients = (env: LineNotificationEnv) => {
  const operationsEmail = env.OPERATIONS_NOTIFICATION_EMAIL?.trim() ?? "";
  const primary = env.PENDING_APPROVAL_OWNER_EMAIL?.trim() || operationsEmail;
  if (!primary) {
    return undefined;
  }
  return {
    primary,
    mirror: operationsEmail && operationsEmail !== primary ? operationsEmail : undefined
  };
};

/**
 * Stamp the in-flight marker (migration 0048), guarded by the caller's claim so a
 * job another invocation already owns is never stamped. Clearing is not done here —
 * `markJobFailure` clears it in the same statement that records the failure.
 */
const stampEmailInflight = async (
  db: D1Database,
  row: LineNotificationJobRow,
  claim: LineNotificationJobClaim,
  nowIso: string
): Promise<boolean> => {
  const result = await db
    .prepare(
      `UPDATE notification_jobs
          SET email_inflight_at = ?
        WHERE id = ?
          AND status = 'processing'
          AND attempts = ?
          AND locked_until = ?`
    )
    .bind(nowIso, ...lineNotificationClaimBindings(row, claim))
    .run();
  return hasChangedRows(result);
};

const attemptLinePush = async (
  row: LineNotificationJobRow,
  env: LineNotificationEnv,
  fetcher: typeof fetch,
  messageText: string
): Promise<
  | Awaited<ReturnType<typeof sendLinePush>>
  | { ok: false; reason: "line-push-unhandled"; alreadyCaptured: true }
> => {
  try {
    // Build inside the try so a (practically impossible) throw here still routes
    // through the caller's failure path, releasing the soft-cap quota slot
    // instead of leaking it for the rest of the sweep.
    const messages = buildLineMessages(row, env, messageText);
    return await sendLinePush(row, env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN, fetcher, messages);
  } catch (error) {
    // B7: line-push-unhandled — capture with non-PII job context only
    safeCaptureException(error, {
      tags: { dispatcher: "line_push", reason: "line-push-unhandled" },
      contexts: {
        job: { job_id: row.job_id, template_key: row.template_key }
      }
    });
    return {
      ok: false,
      reason: "line-push-unhandled",
      // Typed marker consumed by the dead-transition capture below: this
      // failure's ORIGINAL exception is already in Sentry, so the synthetic
      // dead-transition event must not double-send.
      alreadyCaptured: true
    };
  }
};

// Sole capture point for value-based push failures (line-http-<status>,
// line-invalid-json) — they never throw, so no catch upstream sees them.
// Capture exactly once per job lifetime: only when THIS worker's CAS write
// performed the dead transition (`failed` guards against a raced claim
// double-capturing); retryable attempts are expected retry traffic. Pre-
// captured (`alreadyCaptured`) failures are excluded — their ORIGINAL
// exception is already in Sentry, so a synthetic re-capture would double-send.
// Monthly quota exhaustion is an intentional no-resend outcome. Sync status
// and Ops Monitor retain its attention until acknowledged; the daily report
// counts only unacknowledged failures from the last 24 hours.
const captureDeadLinePushFailure = (
  push: Extract<Awaited<ReturnType<typeof attemptLinePush>>, { ok: false }>,
  row: LineNotificationJobRow,
  claim: LineNotificationJobClaim,
  failed: boolean
): void => {
  if (!failed || claim.attempts < MAX_ATTEMPTS || "alreadyCaptured" in push || push.reason === LINE_MONTHLY_QUOTA_EXHAUSTED) {
    return;
  }
  safeCaptureException(new Error(`line push failed permanently: ${push.reason}`), {
    tags: { dispatcher: "line_push", reason: push.reason },
    contexts: {
      job: { job_id: row.job_id, template_key: row.template_key }
    }
  });
};

// Only the retryable failure path reaches here — a timeout terminates the job
// before this (unknown delivery, retrying would duplicate the owner's email).
const captureDeadOwnerEmailFailure = (
  reason: string,
  row: LineNotificationJobRow,
  claim: LineNotificationJobClaim,
  failed: boolean
): void => {
  if (!failed || claim.attempts < MAX_ATTEMPTS) {
    return;
  }
  safeCaptureException(new Error(`owner notification email failed permanently: ${reason}`), {
    tags: { dispatcher: "owner_notification_email", reason: "send_failed" },
    contexts: {
      job: { job_id: row.job_id, template_key: row.template_key }
    }
  });
};

// The mirror is awaited only after the primary job status is settled, so a slow
// mirror never delays the terminal D1 write. It is still awaited before the
// invocation returns so the Workers runtime cannot cancel it.
const settleOwnerEmailOutcome = async (
  opsEmailMirror: Promise<void> | undefined,
  outcome: LineNotificationJobOutcome
): Promise<LineNotificationJobOutcome> => {
  if (opsEmailMirror !== undefined) await opsEmailMirror;
  return outcome;
};

const processOwnerEmailJob = async (input: {
  db: D1Database;
  env: LineNotificationEnv;
  row: LineNotificationJobRow;
  claim: LineNotificationJobClaim;
  startedAtMs: number;
  now: () => number;
  eligibilityMs: number;
  messageText: string;
}): Promise<LineNotificationJobOutcome> => {
  // A marker left by an earlier attempt means that attempt's send was already
  // handed to the provider and the outcome was never recorded (Worker died, or
  // the D1 write failed). Email has no retry key, so sending again would very
  // likely duplicate the owner's mail — terminate with a greppable last_error
  // instead. (顧客向けのメール予備連絡先も同じ扱いをしていたが、2026-08-31 に
  // 機構ごと撤去したので、この規則が残っているのはオーナー宛の経路だけ。)
  if (input.row.email_inflight_at) {
    await markJobSuperseded(
      input.db,
      input.row,
      "email_send_outcome_unknown_inflight",
      input.claim,
      input.eligibilityMs
    );
    safeCaptureException(new Error("owner notification email outcome unknown (in-flight on reclaim)"), {
      tags: { dispatcher: "owner_notification_email", reason: "outcome_unknown" },
      contexts: { job: { job_id: input.row.job_id, template_key: input.row.template_key } }
    });
    return "skipped";
  }

  const recipients = resolveOwnerEmailRecipients(input.env);
  // No recipient: record a job FAILURE, not a supersede. A missing address is a
  // config error the owner can still fix — a retry then delivers — and until it
  // is fixed the job dead-letters, which the admin sync-status page and the
  // daily ops summary's dead-job count both surface. Recording it as succeeded
  // would hide a notification that never went anywhere.
  if (!recipients) {
    const reason = "owner_notification_email_unconfigured";
    const outcome = await markJobFailure(
      input.db,
      input.row,
      reason,
      input.claim,
      input.startedAtMs
    );
    captureDeadOwnerEmailFailure(reason, input.row, input.claim, outcome === "failed");
    return outcome;
  }

  // Stamp BEFORE the send. Losing the claim here means another invocation owns
  // the job, so return without sending rather than racing it.
  if (!(await stampEmailInflight(input.db, input.row, input.claim, toIso(input.now())))) {
    return "skipped";
  }

  // The PRIMARY send promise MUST be created before the mirror's: promise
  // creation reaches env.EMAIL.send() synchronously (sendWithTimeout builds the
  // race array inline), and the in-flight marker's reclaim path above terminates
  // the job as outcome-unknown. Starting the mirror first would widen the
  // crash window in which the marker exists but the primary was never handed to
  // the provider — best-effort work must not put the guaranteed send at risk.
  const primarySend = sendOperationsNotificationEmail(input.env, {
    to: recipients.primary,
    subject: buildOpsEmailSubject(input.row.template_key, input.env.ENVIRONMENT),
    text: input.messageText
  });

  // Ops mirror is first-attempt only and never controls the primary outcome.
  // - Only on first attempt (claim.attempts === 1) so a retry never double-mails ops.
  // - Started after the in-flight stamp confirms we own the claim and after the
  //   primary handoff (see above).
  // - Promise runs concurrent with the primary send; awaited only at each
  //   terminal return (via settleOwnerEmailOutcome) so a slow mirror never delays
  //   the primary's D1 success/failure write. sendOperationsNotificationEmail
  //   never rejects — mirror failure/timeout is best-effort and must not change
  //   job outcome (Sentry reporting stays inside the helper).
  const opsEmailMirror =
    input.claim.attempts === 1 && recipients.mirror
      ? sendOperationsNotificationEmail(input.env, {
          to: recipients.mirror,
          subject: buildOpsEmailSubject(input.row.template_key, input.env.ENVIRONMENT),
          text: input.messageText
        }).then(() => undefined)
      : undefined;

  // A definitive failure clears the marker as part of `markJobFailure` below, so
  // the retry is free to send. Success and timeout are both terminal and keep it.
  // Job outcome is judged on the primary send only.
  const emailResult = await primarySend;
  if (emailResult.sent) {
    const outcome = (await markJobSuccess(
      input.db,
      input.row,
      emailResult.messageId,
      input.claim,
      input.now(),
      // sent_count = 0: this delivery was an email, and the monthly LINE
      // headroom correction sums sent_count over notification_logs. Logging 1
      // here would burn LINE quota the send never used.
      0
    ))
      ? "succeeded"
      : "skipped";
    return settleOwnerEmailOutcome(opsEmailMirror, outcome);
  }
  if (emailResult.timedOut) {
    await markJobSuperseded(
      input.db,
      input.row,
      emailResult.reason,
      input.claim,
      input.eligibilityMs
    );
    return settleOwnerEmailOutcome(opsEmailMirror, "skipped");
  }
  const outcome = await markJobFailure(
    input.db,
    input.row,
    emailResult.reason,
    input.claim,
    input.startedAtMs
  );
  captureDeadOwnerEmailFailure(emailResult.reason, input.row, input.claim, outcome === "failed");
  return settleOwnerEmailOutcome(opsEmailMirror, outcome);
};

const processClaimedLineNotificationJob = async (input: {
  db: D1Database;
  env: LineNotificationEnv;
  fetcher: typeof fetch;
  row: LineNotificationJobRow;
  claim: LineNotificationJobClaim;
  startedAtMs: number;
  now: () => number;
  stopForMonthlyQuota: boolean;
  /** Reserve one soft-cap slot for this send. Critical sends consume the budget
   *  but are never denied; an optional send returns false (→ suppress) when the
   *  per-sweep budget is exhausted. */
  reserveQuotaSlot: (isOptional: boolean) => boolean;
  /** Return a reserved slot when the send failed (no LINE quota was consumed). */
  releaseQuotaSlot: () => void;
}): Promise<LineNotificationJobOutcome> => {
  const eligibilityMs = input.now();
  if (!(await isLineNotificationStillEligible(input.db, input.row, toIso(eligibilityMs)))) {
    return (await markJobSuperseded(
      input.db,
      input.row,
      "superseded_by_reservation_state",
      input.claim,
      eligibilityMs
    ))
      ? "succeeded"
      : "skipped";
  }

  if (input.stopForMonthlyQuota && !isOwnerEmailJob(input.row)) {
    return markJobFailure(input.db, input.row, LINE_MONTHLY_QUOTA_EXHAUSTED, input.claim, eligibilityMs);
  }

  // Step 3 — buildLineMessageText is now async (drift_alert renderer does a
  // D1 store-name lookup). Pre-build the messageText here so sendLinePush
  // stays string-only and a future regression that drops the await would
  // surface as a TypeScript error rather than serialising [object Promise].
  let messageText: string;
  try {
    messageText = await buildLineMessageText(input.db, input.row);
  } catch (error) {
    // B6: line-render-failed — capture with non-PII job context only
    safeCaptureException(error, {
      tags: { dispatcher: "line_push", reason: "line-render-failed" },
      contexts: {
        job: { job_id: input.row.job_id, template_key: input.row.template_key }
      }
    });
    return markJobFailure(input.db, input.row, "line-render-failed", input.claim, input.startedAtMs);
  }

  if (isOwnerEmailJob(input.row)) {
    return processOwnerEmailJob({
      db: input.db,
      env: input.env,
      row: input.row,
      claim: input.claim,
      startedAtMs: input.startedAtMs,
      now: input.now,
      eligibilityMs,
      messageText
    });
  }

  // Cross-environment send guard: outside production this token addresses the
  // PRODUCTION channel, so the push would reach real customers (see
  // LINE_SHARED_CHANNEL_ENVIRONMENTS). Email-sentinel owner rows returned
  // above; this guard also covers legacy owner rows that still carry LINE IDs.
  // D1 row goes terminal, NOT retryable: the job would never become sendable in
  // this environment, and a retryable row would spin the reservation-confirm
  // Workflow's assertJobTerminal step until it exhausts its retries. The returned
  // outcome is "skipped" rather than "succeeded" so nothing that never left the
  // Worker is counted as delivered — `result.succeeded` stays honest and no
  // `notification_sent` metric is emitted. (src/admin/staging-drift-sweep.ts reads
  // D1 directly, so it filters on `last_error` instead.)
  //
  // This sits AFTER the chunk's rate-limiter acquire, so a staging sweep spends
  // its own DO budget before suppressing — a staging-only cost, deliberately
  // preferred over restructuring the dispatch loop.
  if (LINE_SHARED_CHANNEL_ENVIRONMENTS.has(input.env.ENVIRONMENT ?? "")) {
    await markJobSuperseded(
      input.db,
      input.row,
      "suppressed_non_production_line_channel",
      input.claim,
      eligibilityMs
    );
    return "skipped";
  }

  // Monthly budget guard: reserve a soft-cap slot for this send. Critical sends
  // consume the budget (real LINE quota) but are never denied; once the budget is
  // exhausted, optional (non-transactional) pushes are suppressed — so a single
  // sweep cannot overshoot the cap and critical sends are accounted for too.
  // Suppressed jobs terminate (no retry) — an optional push is time-sensitive and
  // irrelevant by next month's quota reset.
  if (!input.reserveQuotaSlot(LINE_OPTIONAL_TEMPLATES.has(input.row.template_key))) {
    return (await markJobSuperseded(
      input.db,
      input.row,
      "suppressed_line_monthly_soft_cap",
      input.claim,
      eligibilityMs
    ))
      ? "succeeded"
      : "skipped";
  }

  const push = await attemptLinePush(input.row, input.env, input.fetcher, messageText);
  if (!push.ok) {
    input.releaseQuotaSlot();
    const outcome = await markJobFailure(input.db, input.row, push.reason, input.claim, input.startedAtMs);
    captureDeadLinePushFailure(push, input.row, input.claim, outcome === "failed");
    return outcome;
  }

  // Completion time, not claim time (`startedAtMs`): the success log's
  // created_at feeds the cross-invocation quota correction, and a snapshot
  // refreshed mid-send would otherwise hide this send until the next refresh.
  return (await markJobSuccess(input.db, input.row, push.providerMessageId, input.claim, input.now()))
    ? "succeeded"
    : "skipped";
};

const applyLineNotificationOutcome = (
  result: LineNotificationResult,
  outcome: LineNotificationJobOutcome
) => {
  if (outcome === "succeeded") {
    result.succeeded += 1;
    return;
  }
  if (outcome === "failed") {
    result.failed += 1;
  }
};

/**
 * Processes due LINE notification jobs from the queue.
 *
 * @param input.jobIdsFilter — Three-state contract:
 *   - `undefined` (omitted): existing global FIFO behaviour, processes any
 *     due job regardless of id.
 *   - `[]` (empty array): short-circuit, returns `{ processed: 0, succeeded: 0, failed: 0 }`
 *     immediately without issuing any SQL.
 *   - Non-empty array: scopes the fetch SQL to only match jobs whose id is
 *     in the provided list, leaving all other queued jobs untouched.
 */
// Chunk size for parallel LINE push dispatch. Jobs within a chunk are
// dispatched via Promise.all, reducing wall-clock time for large batches
// (e.g. the 04:00 JST reminder cron dispatching ~500 pushes).
//
// Rate budget reasoning (LINE Messaging API: 2000 req/min):
//   chunk=5 → max 5 concurrent LINE API calls per chunk round.
//   500 jobs / 5 per chunk = 100 rounds.
//   Throttle floor per chunk: (5 / 2000) * 60_000 = 150 ms.
//   100 rounds * 150 ms = 15 s minimum wall-clock for 500 jobs.
//   Peak burst rate: 5 / 0.15 s ≈ 33 req/s = 2000 req/min (at limit).
//   In practice each LINE push takes ~100-300 ms, so real throughput
//   stays well under the 2000 req/min ceiling.
//
// A larger chunk (e.g. 10) would increase burst risk; a smaller chunk
// (e.g. 2-3) would underutilize the budget. 5 balances throughput gains
// with conservative rate headroom.
export const PARALLEL_CHUNK_SIZE = 5;

// Minimum milliseconds between chunk dispatches to stay within
// LINE Messaging API's 2000 req/min rate limit.
// Formula: (PARALLEL_CHUNK_SIZE / 2000) * 60_000
export const CHUNK_THROTTLE_FLOOR_MS = (PARALLEL_CHUNK_SIZE / 2000) * 60_000;

export async function processDueLineNotificationJobs(input: {
  db: D1Database;
  env: LineNotificationEnv;
  fetcher?: typeof fetch;
  now?: () => number;
  maxJobs?: number;
  jobIdsFilter?: string[];
  /** Override for testing: injected sleep function. @internal */
  _sleep?: (ms: number) => Promise<void>;
}): Promise<LineNotificationResult> {
  if (input.jobIdsFilter?.length === 0) {
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  const fetcher = input.fetcher ?? withOutboundTimeout(fetch.bind(globalThis));
  const now = input.now ?? Date.now;
  const maxJobs = input.maxJobs ?? 5;
  const sleep = input._sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const result: LineNotificationResult = {
    processed: 0,
    succeeded: 0,
    failed: 0
  };
  // Subset of `result` delivered by owner email. Kept out of the
  // returned shape — callers and tests assert on the three counters above — and
  // used only to split the batch metric between the line and email channels.
  const emailOutcomes = { succeeded: 0, failed: 0 };
  // Set when the LINE rate-limiter denies a chunk. The sweep finishes the email
  // jobs it already claimed, then stops.
  let lineBudgetExhausted = false;

  // Sweep dead-letter candidates once per batch; subsequent iterations don't
  // add new MAX_ATTEMPTS hits because the claim path enforces attempts < cap.
  await markStaleNotificationClaimsExhausted(input.db, now());

  // Branch B (system-level owner notifications) is included when ANY
  // producer-side flag is on. Each flag controls its own enqueue path;
  // the dispatcher just decides whether to look for those rows at all.
  // With all flags off the dispatcher SQL stays column-safe
  // (no payload_json reference) for workers rolled forward before 0013
  // is applied.
  //
  // Note: enabling any single flag exposes the Branch B SELECT which
  // covers ALL system-level templates. If stale queued rows exist for
  // a template whose flag was previously on then off, those rows will
  // be dispatched when a different flag turns Branch B back on. The
  // supported recovery is to UPDATE those rows to 'dead' before
  // re-enabling any Branch B flag (see flag rollback comment above).
  const branchBEnabled =
    input.env.GOOGLE_DRIFT_ALERT_LIVE === "true" ||
    input.env.GOOGLE_CONFLICT_BURST_ALERT_LIVE === "true" ||
    input.env.DAILY_OPS_SUMMARY_DISPATCH_ENABLED === "true";

  // Read the persisted monthly quota snapshot once per sweep (no LINE API call).
  // Missing snapshot / unknown limit → Infinity headroom = no suppression
  // (availability over accuracy). The headroom is consumed per optional send so a
  // single large batch cannot overshoot the soft cap (e.g. usage 179/180 must not
  // let an entire reminder sweep through).
  const quotaStatus = await readLineQuotaStatus({ db: input.db, env: input.env, now });
  const quotaSnapshotMs = Date.parse(quotaStatus?.asOf ?? "");
  const exhaustedQuotaMonth = quotaStatus?.remaining === 0 && Number.isFinite(quotaSnapshotMs)
    ? jstYearMonth(quotaSnapshotMs)
    : null;
  let quotaHeadroom = optionalPushHeadroom(quotaStatus);
  // Cross-invocation accounting: the snapshot's `used` only advances on the
  // 10-minute maintenance cron, so pushes sent by earlier sweeps / queue
  // invocations since the snapshot was fetched are not reflected in it yet.
  // Subtract them from the headroom (sent_count=1 log rows since asOf) so
  // back-to-back invocations at e.g. 179/180 cannot each spend the same last
  // optional slot. datetime() normalizes ISO 'T' timestamps against SQLite's
  // space-separated CURRENT_TIMESTAMP rows. Boundary imprecision (a send the
  // snapshot already counted being re-subtracted) errs toward suppressing
  // early — never toward overshooting the cap — and the ops email mirror
  // still covers suppressed sends. Degrades like the snapshot read:
  // on query failure, skip the correction rather than break dispatch.
  if (quotaStatus && Number.isFinite(quotaHeadroom)) {
    try {
      const sentSince = await countLineSendsSince(input.db, quotaStatus.asOf);
      quotaHeadroom = Math.max(0, quotaHeadroom - sentSince);
    } catch (err: unknown) {
      safeCaptureException(err instanceof Error ? err : new Error(String(err)), {
        tags: { dispatcher: "line_push", reason: "quota-sent-since-read-failed" }
      });
    }
  }
  // Reserve one soft-cap slot for a job about to send. Transactional/critical
  // sends ALSO consume the shared budget (they spend real LINE quota too), but
  // are never denied; optional sends are denied once the budget is exhausted —
  // so an optional push cannot slip through after critical sends in the same
  // sweep already consumed the last slot. Synchronous check+decrement is atomic
  // across the parallel partition dispatch (JS is single-threaded between awaits).
  const reserveQuotaSlot = (isOptional: boolean): boolean => {
    if (isOptional && quotaHeadroom <= 0) return false;
    quotaHeadroom -= 1;
    return true;
  };
  // Restore a reserved slot when the send did not actually consume LINE quota
  // (render/push failure), so a failed send does not needlessly suppress later
  // optional pushes in the same sweep.
  const releaseQuotaSlot = (): void => {
    quotaHeadroom += 1;
  };

  let claimed = 0;
  let exhausted = false;

  while (claimed < maxJobs && !exhausted) {
    // Phase 1: Fetch + claim up to PARALLEL_CHUNK_SIZE jobs sequentially.
    // D1 is single-writer, so fetch/claim must be serial; the parallelism
    // gain comes from dispatching the claimed jobs concurrently in Phase 2.
    let chunkJobs: Array<{
      row: LineNotificationJobRow;
      claim: LineNotificationJobClaim;
      startedAtMs: number;
    }> = [];
    const remaining = maxJobs - claimed;
    const chunkTarget = Math.min(PARALLEL_CHUNK_SIZE, remaining);

    for (let i = 0; i < chunkTarget; i += 1) {
      const nowMs = now();
      const row = await fetchNextLineNotificationJob(
        input.db,
        toIso(nowMs),
        branchBEnabled,
        input.jobIdsFilter
      );
      if (!row) {
        exhausted = true;
        break;
      }

      const claim = await markJobProcessing(input.db, row, nowMs);
      if (!claim) {
        // CAS failed (concurrent claim) — skip, try next
        continue;
      }

      chunkJobs.push({ row, claim, startedAtMs: nowMs });
    }

    if (chunkJobs.length === 0) {
      break;
    }

    claimed += chunkJobs.length;

    // Phase 1.5: Acquire tokens from the cross-handler rate-limiter DO.
    // Coordinates the 2000 req/min LINE budget across scheduled + queue
    // dispatchers. Binding-absent (tests / local dev before deploy) = bypass.
    // Runtime DO failure or genuine budget exhaustion = fail closed.
    //
    // Only LINE-delivered jobs take tokens. Email-sentinel owner jobs issue no
    // LINE request; legacy owner rows with LINE IDs remain in this set until drained.
    // Bind the no-send decision and token exemption at the same instant. A
    // sweep crossing the month boundary before here uses the new month; one
    // crossing afterwards cannot send a token-exempt job. Quota stops must not
    // wait on a rate-limiter outage or roll back into next month's queue.
    const stopForMonthlyQuota = exhaustedQuotaMonth !== null &&
      exhaustedQuotaMonth === jstYearMonth(now()) &&
      !LINE_SHARED_CHANNEL_ENVIRONMENTS.has(input.env.ENVIRONMENT ?? "");
    const lineJobs = stopForMonthlyQuota ? [] : chunkJobs.filter((job) => !isOwnerEmailJob(job.row));
    const acquired =
      lineJobs.length === 0 || (await acquireLineRateBudget(input.env, lineJobs.length, sleep));
    if (!acquired) {
      // Roll back each claim's attempt counter — rate-limit denial / DO RPC
      // failure is not a delivery failure and must not consume retry budget,
      // otherwise repeated denials would dead-letter notifications without a
      // single provider send attempt. Lock is released too so a subsequent
      // invocation can claim immediately when budget is restored.
      // Batched via D1 to keep the rollback to one round-trip.
      await releaseLineNotificationClaimsBatch(input.db, lineJobs, now());
      claimed -= lineJobs.length;
      console.warn("line_rate_budget_exhausted", {
        chunkSize: lineJobs.length,
        claimedAfterRollback: claimed,
        maxJobs
      });
      safeCaptureException(new Error("LINE rate budget exhausted after retries"), {
        tags: { component: "line_rate_limiter_do", action: "budget_exhausted" }
      });
      // The email jobs in this chunk hold valid claims and need no budget, so
      // dispatch them instead of rolling the whole chunk back. The sweep still
      // ends after this chunk (see `lineBudgetExhausted` below) — retrying the
      // acquire on every remaining chunk would just burn DO round-trips.
      lineBudgetExhausted = true;
      chunkJobs = chunkJobs.filter((job) => isOwnerEmailJob(job.row));
      if (chunkJobs.length === 0) {
        break;
      }
    }

    // Phase 2: Partition-aware dispatch. Group claimed jobs by ordering key
    // (recipient_id, reservation_id) so the same recipient+reservation is
    // dispatched sequentially in FIFO order, while independent partitions
    // run in parallel via Promise.allSettled. This preserves delivery
    // ordering for lifecycle notifications (e.g. confirmed → time_changed)
    // without sacrificing throughput for unrelated recipients/reservations.
    // Aggregate LINE rate is bounded by max_concurrency:1 in wrangler.jsonc
    // AND the cross-handler rate-limiter DO (PR #131).
    const chunkStartMs = now();
    const partitions = new Map<string, typeof chunkJobs>();
    for (const job of chunkJobs) {
      const key = `${job.row.recipient_id}\0${job.row.reservation_id ?? ""}`;
      let partition = partitions.get(key);
      if (!partition) {
        partition = [];
        partitions.set(key, partition);
      }
      partition.push(job);
    }

    // Each partition dispatches its jobs sequentially (FIFO); all partitions
    // run in parallel via Promise.allSettled. Keep `partitionValues` as an
    // array (not iterator) so we can index back to partition size if the
    // partition promise rejects — needed for accurate stat accounting.
    const partitionValues = [...partitions.values()];
    const partitionResults = await Promise.allSettled(
      partitionValues.map(async (partition) => {
        const outcomes: Array<{ status: "fulfilled"; value: LineNotificationJobOutcome } | { status: "rejected"; reason: unknown }> = [];
        for (const job of partition) {
          try {
            const outcome = await processClaimedLineNotificationJob({
              db: input.db,
              env: input.env,
              fetcher,
              row: job.row,
              claim: job.claim,
              startedAtMs: job.startedAtMs,
              now,
              stopForMonthlyQuota,
              reserveQuotaSlot,
              releaseQuotaSlot
            });
            if (isOwnerEmailJob(job.row)) {
              // Counted apart from `result` so the batch metric below is not
              // filed under channel "line" for a sweep that only sent email.
              if (outcome === "succeeded") emailOutcomes.succeeded += 1;
              else if (outcome === "failed") emailOutcomes.failed += 1;
            }
            outcomes.push({ status: "fulfilled", value: outcome });
          } catch (error) {
            // A throw (e.g. a D1 error around the send) counts as failed in the
            // caller, so attribute it here too — otherwise an email fault would be
            // reported as a failed LINE notification.
            if (isOwnerEmailJob(job.row)) {
              emailOutcomes.failed += 1;
            }
            outcomes.push({ status: "rejected", reason: error });
          }
        }
        return outcomes;
      })
    );

    for (let i = 0; i < partitionResults.length; i += 1) {
      const partitionEntry = partitionResults[i];
      if (partitionEntry.status === "rejected") {
        // Entire partition promise rejected — should not happen since we
        // catch per-job, but count all jobs in this partition as failed
        // so stat accounting matches partition size, not 1.
        const partitionSize = partitionValues[i].length;
        emailOutcomes.failed += partitionValues[i].filter(
          (job) => isOwnerEmailJob(job.row)
        ).length;
        safeCaptureException(partitionEntry.reason, {
          tags: { dispatcher: "line_push", reason: "partition_unexpected_throw" },
          contexts: { partition: { size: partitionSize } }
        });
        result.failed += partitionSize;
        result.processed += partitionSize;
        continue;
      }
      for (const entry of partitionEntry.value) {
        result.processed += 1;
        if (entry.status === "fulfilled") {
          applyLineNotificationOutcome(result, entry.value);
          continue;
        }
        safeCaptureException(entry.reason, {
          tags: { dispatcher: "line_push", reason: "chunk_job_unexpected_throw" },
          contexts: { chunk: { size: chunkJobs.length } }
        });
        result.failed += 1;
      }
    }

    // Phase 3: Rate-limit throttle. Sleep until CHUNK_THROTTLE_FLOOR_MS
    // has elapsed since the chunk started. The throttle runs even on the
    // final chunk of an invocation when `claimed >= maxJobs` because the
    // queue may still have more jobs waiting — without the trailing
    // sleep, the next invocation (under max_concurrency: 1) could start
    // its first chunk immediately and effectively double the per-second
    // dispatch rate at batch boundaries. Skip only when the queue is
    // genuinely exhausted (no more jobs to claim).
    if (!exhausted) {
      const elapsed = now() - chunkStartMs;
      const sleepMs = CHUNK_THROTTLE_FLOOR_MS - elapsed;
      if (sleepMs > 0) {
        await sleep(sleepMs);
      }
    }

    if (lineBudgetExhausted) {
      break;
    }
  }

  // Anything not attributed to email is a LINE outcome. The unattributed paths
  // (partition-level throw, per-job throw) add to `result.failed` only, and
  // counting those as LINE is right: they are LINE dispatcher faults.
  const lineSucceeded = result.succeeded - emailOutcomes.succeeded;
  const lineFailed = result.failed - emailOutcomes.failed;
  for (const [channel, succeeded, failed] of [
    ["line", lineSucceeded, lineFailed],
    ["email", emailOutcomes.succeeded, emailOutcomes.failed]
  ] as const) {
    if (succeeded > 0) {
      trackEvent(input.env, {
        type: "notification_sent",
        storeId: "_batch",
        jobCount: succeeded,
        channel,
        environment: input.env.ENVIRONMENT ?? "local"
      });
    }
    if (failed > 0) {
      trackEvent(input.env, {
        type: "notification_failed",
        storeId: "_batch",
        jobCount: failed,
        channel,
        environment: input.env.ENVIRONMENT ?? "local"
      });
    }
  }

  return result;
}
