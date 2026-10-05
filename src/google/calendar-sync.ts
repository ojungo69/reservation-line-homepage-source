import { defaultGoogleCalendarAccessTokenProvider } from "./service-account";
import { INSTANCE_CONFIG } from "../instance-config";
import { calculateGoogleRetryDelayMs } from "./retry-backoff";
import { buildEventHistoryInsert } from "./event-history";
import { logGoogleEvent } from "../logging";
import { withOutboundTimeout } from "../outbound-timeout";
import { CONTROL_CHARS_PATTERN, sanitizeCustomerNameForCalendarSummary } from "../pii-normalize";
import { sha256Hex } from "../crypto-utils";
import { safeCaptureException } from "../sentry-helpers";
import {
  isReservationStillUpsertable,
  shouldDeleteReservationEventAfterWrite,
  persistStaleReservationGoogleEventCleanup,
  isExternalBlockStillUpsertable,
  shouldDeleteExternalBlockEventAfterWrite,
  persistStaleExternalBlockGoogleEventCleanup
} from "./calendar-sync-eligibility";

// Re-export so existing consumers (tests, etc.) importing from this module
// continue to work without import-path changes.
export { sanitizeCustomerNameForCalendarSummary } from "../pii-normalize";

import type { WorkerBindings } from "../bindings";
import type { GoogleErrorClass } from "../logging";

export type CalendarSyncResult = {
  processed: number;
  succeeded: number;
  failed: number;
};

type CalendarSyncEnv = Pick<
  WorkerBindings,
  "GOOGLE_SERVICE_ACCOUNT_EMAIL" | "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY"
>;

type CalendarSyncJobRow = {
  job_id: string;
  dedupe_key: string;
  owner_type: "reservation" | "external_block";
  owner_id: string;
  google_action: "insert" | "patch" | "delete" | "upsert";
  attempts: number;
  reservation_id: string | null;
  external_block_id: string | null;
  store_id: string;
  timezone: string;
  calendar_id: string;
  status: string;
  start_at: string;
  end_at: string;
  service_names: string | null;
  customer_name: string | null;
  // 予約客の「有効来店歴」件数 (この予約自身の完了 visit は除外)。0 件 = 初回(新規)客で、
  // タイトル先頭に「新規予約」を付けるかの判定に使う。external_block 行は
  // reservations.customer_id が NULL なのでこのサブクエリは 0 を返すが、その行は
  // buildExternalBlockCalendarEvent 側で処理され valid_visit_count は参照されない。
  valid_visit_count: number | null;
  // 1 when the reservation's customer was manually linked to a known (paper-chart)
  // customer by an owner/admin (line_identities.linked_by_admin). Such a customer is
  // "existing" even with 0 recorded visits, so the「新規予約」title prefix is suppressed
  // (mirrors public-submit's treatAsExisting). NULL when the customer has no LINE identity.
  linked_by_admin: number | null;
  google_event_id: string | null;
  google_event_etag: string | null;
  version: number | null;
};

type ReservationCalendarSyncJobRow = CalendarSyncJobRow & {
  owner_type: "reservation";
  reservation_id: string;
  external_block_id: null;
  version: number;
};

type ExternalBlockCalendarSyncJobRow = CalendarSyncJobRow & {
  owner_type: "external_block";
  reservation_id: null;
  external_block_id: string;
  status: "active" | "cancelled";
};

type GoogleEventResponse = {
  id: string;
  etag?: string;
  updated?: string;
};


type CalendarSyncJobClaim = {
  attempts: number;
  lockedUntil: string;
};

// Outbound snapshot mirrors import-sync.ts SafeGoogleSnapshot shape for
// google_calendar_event_history.  Read-only shadow data — never affects
// the outbound write flow.
type OutboundSnapshotJson = {
  google_event_id: string;
  status: string;
  start_at: string;
  end_at: string;
  owner_type: "reservation" | "external_block";
  owner_id: string;
  direction: "outbound";
};

const buildOutboundSnapshotJson = (
  row: CalendarSyncJobRow,
  googleEventId: string,
  status: string
): string =>
  JSON.stringify({
    google_event_id: googleEventId,
    status,
    start_at: row.start_at,
    end_at: row.end_at,
    owner_type: row.owner_type,
    owner_id: row.owner_id,
    direction: "outbound"
  } satisfies OutboundSnapshotJson);

const outboundHistoryInsert = (
  db: D1Database,
  row: CalendarSyncJobRow,
  event: { id: string; etag: string | null; updatedAt: string | null },
  status: "active" | "deleted",
  nowIso: string,
  guard: { sql: string; bindings: unknown[] }
): D1PreparedStatement =>
  buildEventHistoryInsert(db, {
    storeId: row.store_id,
    calendarId: row.calendar_id,
    googleEventId: event.id,
    googleEtag: event.etag,
    googleUpdatedAt: event.updatedAt,
    sourceType: row.owner_type === "reservation" ? "reservation" : "external_block",
    status,
    snapshotJson: buildOutboundSnapshotJson(row, event.id, status),
    nowIso,
  }, guard);

const deleteHistoryInsert = (
  db: D1Database,
  row: CalendarSyncJobRow,
  googleEventId: string,
  nowIso: string,
  claim: CalendarSyncJobClaim
): D1PreparedStatement =>
  outboundHistoryInsert(
    db, row,
    { id: googleEventId, etag: row.google_event_etag, updatedAt: null },
    "deleted", nowIso,
    { sql: calendarSyncJobClaimExistsSql, bindings: calendarSyncJobClaimBindings(row, claim) }
  );

type GoogleCalendarEventPayload = {
  summary: string;
  start: {
    dateTime: string;
    timeZone: string;
  };
  end: {
    dateTime: string;
    timeZone: string;
  };
  transparency: "opaque";
  visibility: "private";
  extendedProperties: {
    private: {
      app: "reservation-line-homepage";
      owner_type: "reservation" | "external_block";
      reservation_id?: string;
      external_block_id?: string;
      store_id: string;
    };
  };
};

const GOOGLE_CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3/calendars";
export const LOCK_TTL_MS = 5 * 60 * 1000;
const OUTBOUND_WRITE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;

const toIso = (ms: number) => new Date(ms).toISOString();

const isReservationSyncJob = (row: CalendarSyncJobRow): row is ReservationCalendarSyncJobRow => {
  return row.owner_type === "reservation" && row.reservation_id !== null && row.version !== null;
};

const isExternalBlockSyncJob = (row: CalendarSyncJobRow): row is ExternalBlockCalendarSyncJobRow => {
  return row.owner_type === "external_block" && row.external_block_id !== null;
};

/**
 * Service names are stored as "カテゴリ｜メニュー名" (fullwidth "｜"), and multi-menu
 * bookings join segments with " / ". Google Calendar titles get noisy when every
 * category repeats; strip the category prefix for display only.
 *
 * Contract (do not loosen without product sign-off):
 * - Drop text before the first fullwidth "｜" (category), keep the rest (incl. "60分").
 * - EXCEPTION: keep the "メンズ｜" prefix — men's menus are name-duplicates of women's
 *   and become unidentifiable without it.
 * - " / " multi-menu strings: split → strip each segment → rejoin with " / ".
 * - Names without "｜" are returned unchanged.
 * - Empty / control-only input still falls back to "メニュー未登録".
 *
 * Fixed cases:
 *   脱毛｜A 60分                         → A 60分
 *   メンズ｜A 60分                       → メンズ｜A 60分
 *   脱毛｜A 60分 / メンズ｜B 30分        → A 60分 / メンズ｜B 30分
 */
const FULLWIDTH_CATEGORY_SEP = "｜";
const MENS_CATEGORY_PREFIX = "メンズ｜";
const MULTI_MENU_JOIN = " / ";

const stripCategoryPrefixFromServiceSegment = (segment: string): string => {
  // Men's menus: keep the メンズ｜ marker so they stay distinguishable from
  // identically named non-men's menus after category stripping.
  if (segment.startsWith(MENS_CATEGORY_PREFIX)) {
    return segment;
  }
  const sepIndex = segment.indexOf(FULLWIDTH_CATEGORY_SEP);
  if (sepIndex === -1) {
    return segment;
  }
  return segment.slice(sepIndex + FULLWIDTH_CATEGORY_SEP.length);
};

export const sanitizeServiceNamesForCalendarSummary = (raw: string | null): string => {
  if (!raw) return "メニュー未登録";
  const normalized = raw.replace(CONTROL_CHARS_PATTERN, "").trim();
  if (normalized.length === 0) return "メニュー未登録";
  // Split multi-menu, strip each category prefix, rejoin. Do not touch duration
  // suffixes like "60分" — staff still need duration at a glance in GCal.
  const stripped = normalized
    .split(MULTI_MENU_JOIN)
    .map(stripCategoryPrefixFromServiceSegment)
    .join(MULTI_MENU_JOIN);
  return stripped.length > 0 ? stripped : "メニュー未登録";
};

function buildReservationCalendarEvent(row: ReservationCalendarSyncJobRow): GoogleCalendarEventPayload {
  // status は isReservationStillUpsertable で confirmed/completed/no_show/pending_approval に絞られる。
  // それ以外の status はこの builder に到達しない (delete flow に振られる)。
  const services = sanitizeServiceNamesForCalendarSummary(row.service_names);
  const customerName = sanitizeCustomerNameForCalendarSummary(row.customer_name);
  // タイトル先頭セグメント = 初回(新規)客なら「新規予約」、それ以外は空欄。
  // 「新規」の定義は public-submit の treatAsExisting と同じ: status='valid' の
  // customer_visits が 0 件 かつ admin による既存客紐付け (linked_by_admin) も無い。
  // complete / no_show は calendar 再 sync を発火しないため、completion で来店歴が
  // 増えてもタイトルが後から書き換わることはない (新規予約 のまま固定)。
  const isNewCustomer = (row.valid_visit_count ?? 0) === 0 && (row.linked_by_admin ?? 0) !== 1;
  const baseSummary = isNewCustomer
    ? `新規予約 | ${services} | ${customerName}`
    : `${services} | ${customerName}`;
  // String.prototype.slice は UTF-16 code unit ベースで動くため、240 番目が
  // surrogate pair の途中にあたるとサロゲート half が残り Google Calendar API が
  // 拒否する可能性がある。code point 単位で切り出して unpaired surrogate が
  // 残らないようにする。
  const summary = Array.from(baseSummary).slice(0, 240).join("");
  return {
    summary,
    start: {
      dateTime: row.start_at,
      timeZone: row.timezone
    },
    end: {
      dateTime: row.end_at,
      timeZone: row.timezone
    },
    transparency: "opaque",
    visibility: "private",
    extendedProperties: {
      private: {
        app: "reservation-line-homepage",
        owner_type: "reservation",
        reservation_id: row.reservation_id,
        store_id: row.store_id
      }
    }
  };
}

function buildExternalBlockCalendarEvent(row: ExternalBlockCalendarSyncJobRow): GoogleCalendarEventPayload {
  return {
    summary: `${INSTANCE_CONFIG.displayName} ブロック`,
    start: {
      dateTime: row.start_at,
      timeZone: row.timezone
    },
    end: {
      dateTime: row.end_at,
      timeZone: row.timezone
    },
    transparency: "opaque",
    visibility: "private",
    extendedProperties: {
      private: {
        app: "reservation-line-homepage",
        owner_type: "external_block",
        external_block_id: row.external_block_id,
        store_id: row.store_id
      }
    }
  };
}

// Bulk-backfill jobs carry this marker in dedupe_key. The one-shot generator
// (scripts/backfill-reservation-title-sync-jobs.mjs) ran in production on
// 2026-07-31 and has since been deleted — recover it from git history if another
// bulk backfill is ever needed. The claim loop still caps marked jobs per run so
// a backfill can never crowd regular sync jobs out of the maxJobs window —
// regardless of producer-side available_at spacing (delayed cron firings,
// overlapping run-ids).
export const BULK_BACKFILL_DEDUPE_MARKER = ":title-backfill-";
export const MAX_BULK_BACKFILL_JOBS_PER_RUN = 3;

const fetchNextCalendarSyncJob = async (
  db: D1Database,
  nowIso: string,
  jobIdsFilter?: string[],
  excludeBulkBackfill = false
) => {
  const idFilterClause = jobIdsFilter && jobIdsFilter.length > 0
    ? ` AND calendar_sync_jobs.id IN (${jobIdsFilter.map(() => "?").join(",")})`
    : "";
  // Marker is a code constant (no user input, no LIKE wildcards) — safe to inline.
  const bulkBackfillClause = excludeBulkBackfill
    ? ` AND calendar_sync_jobs.dedupe_key NOT LIKE '%${BULK_BACKFILL_DEDUPE_MARKER}%'`
    : "";
  const sql = `
        SELECT
          calendar_sync_jobs.id AS job_id,
          calendar_sync_jobs.dedupe_key AS dedupe_key,
          calendar_sync_jobs.owner_type AS owner_type,
          calendar_sync_jobs.owner_id AS owner_id,
          calendar_sync_jobs.google_action AS google_action,
          calendar_sync_jobs.attempts AS attempts,
          reservations.id AS reservation_id,
          external_blocks.id AS external_block_id,
          COALESCE(reservations.store_id, external_blocks.store_id) AS store_id,
          stores.timezone AS timezone,
          stores.google_calendar_id AS calendar_id,
          COALESCE(reservations.status, external_blocks.status) AS status,
          COALESCE(reservations.start_at, external_blocks.start_at) AS start_at,
          COALESCE(reservations.end_at, external_blocks.end_at) AS end_at,
          (
            SELECT GROUP_CONCAT(name_snapshot, ' / ')
            FROM (
              SELECT name_snapshot
              FROM reservation_services
              WHERE reservation_id = reservations.id
              ORDER BY display_order ASC
            )
          ) AS service_names,
          customers.display_name AS customer_name,
          (
            SELECT COUNT(*)
            FROM customer_visits cv
            WHERE cv.customer_id = reservations.customer_id
              AND cv.status = 'valid'
              -- この予約自身の完了 visit は除外する。承認/再試行の upsert が
              -- complete 後に処理されても、初回客の「新規予約」prefix が
              -- 自分の完了 visit のせいで消えないようにする (public-submit の
              -- getValidVisitCount が「予約作成前」の来店歴を数えるのと整合)。
              AND (cv.reservation_id IS NULL OR cv.reservation_id <> reservations.id)
          ) AS valid_visit_count,
          (
            -- 1 if any LINE identity of this customer was admin-linked as an existing
            -- (paper-chart) customer. MAX over 0/1 → 1 when present, 0 otherwise, NULL
            -- when the customer has no identity. Keeps the「新規予約」prefix off a
            -- vouched-for customer's first online booking (consistent with
            -- public-submit's treatAsExisting).
            SELECT MAX(li.linked_by_admin)
            FROM line_identities li
            WHERE li.customer_id = reservations.customer_id
          ) AS linked_by_admin,
          COALESCE(reservations.google_event_id, external_blocks.google_event_id) AS google_event_id,
          COALESCE(reservations.google_event_etag, external_blocks.google_event_etag) AS google_event_etag,
          reservations.version AS version
        FROM calendar_sync_jobs
        LEFT JOIN reservations
          ON calendar_sync_jobs.owner_type = 'reservation'
          AND reservations.id = calendar_sync_jobs.owner_id
        LEFT JOIN external_blocks
          ON calendar_sync_jobs.owner_type = 'external_block'
          AND external_blocks.id = calendar_sync_jobs.owner_id
        LEFT JOIN customers
          ON customers.id = reservations.customer_id
        JOIN stores ON stores.id = COALESCE(reservations.store_id, external_blocks.store_id)
        WHERE calendar_sync_jobs.google_action IN ('upsert', 'delete')
          AND (
            (calendar_sync_jobs.status IN ('queued', 'retryable')
              AND calendar_sync_jobs.available_at <= ?)
            OR
            (calendar_sync_jobs.status = 'processing'
              AND calendar_sync_jobs.locked_until < ?
              AND calendar_sync_jobs.attempts < ?)
          )
          AND stores.google_calendar_id IS NOT NULL
          AND (
            (
              calendar_sync_jobs.owner_type = 'reservation'
              AND reservations.id IS NOT NULL
              AND
              calendar_sync_jobs.google_action = 'upsert'
              AND reservations.status IN (
                'pending_approval',
                'confirmed',
                'completed',
                'no_show',
                'rejected',
                'expired',
                'cancelled_by_customer',
                'cancelled_by_admin'
              )
            )
            OR (
              calendar_sync_jobs.owner_type = 'reservation'
              AND reservations.id IS NOT NULL
              AND
              calendar_sync_jobs.google_action = 'delete'
              AND reservations.status IN (
                'rejected',
                'expired',
                'cancelled_by_customer',
                'cancelled_by_admin'
              )
            )
            OR (
              calendar_sync_jobs.owner_type = 'external_block'
              AND external_blocks.id IS NOT NULL
              AND calendar_sync_jobs.google_action = 'upsert'
              -- Mirror reservation upsert: include both active and
              -- cancelled rows so the dequeued job can hit
              -- isExternalBlockStillUpsertable and be explicitly marked
              -- superseded_by_external_block_cancellation instead of
              -- staying queued/retryable indefinitely. The actual Google
              -- write is still skipped because the pre-write guard
              -- returns false. Issue #121 symmetric redesign.
              AND external_blocks.status IN ('active', 'cancelled')
            )
            OR (
              calendar_sync_jobs.owner_type = 'external_block'
              AND external_blocks.id IS NOT NULL
              AND calendar_sync_jobs.google_action = 'delete'
              AND external_blocks.status = 'cancelled'
            )
          )
      ${idFilterClause}
      ${bulkBackfillClause}
        ORDER BY calendar_sync_jobs.available_at ASC, calendar_sync_jobs.created_at ASC
        LIMIT 1
      `;
  const filterIds = jobIdsFilter && jobIdsFilter.length > 0 ? jobIdsFilter : [];
  return db
    .prepare(sql)
    .bind(nowIso, nowIso, MAX_ATTEMPTS, ...filterIds)
    .first<CalendarSyncJobRow>();
};

/** Build the calendar_sync_jobs failure UPDATE (retryable or dead). Used alone by
 *  markJobFailure and as the final statement of a ledger batch when moreRemaining. */
const buildJobFailureUpdate = (
  db: D1Database,
  row: CalendarSyncJobRow,
  reason: string,
  claim: CalendarSyncJobClaim,
  nowMs: number
): D1PreparedStatement => {
  const nextAttempts = claim.attempts;
  const status = nextAttempts >= MAX_ATTEMPTS ? "dead" : "retryable";
  const retryDelayMs = calculateGoogleRetryDelayMs(nextAttempts, row.job_id);
  const availableAt = status === "dead" ? toIso(nowMs) : toIso(nowMs + retryDelayMs);

  return db
    .prepare(
      `
        UPDATE calendar_sync_jobs
        SET status = ?,
            attempts = ?,
            available_at = ?,
            locked_until = NULL,
            last_error = ?,
            updated_at = ?
        WHERE id = ?
          AND EXISTS (${calendarSyncJobClaimExistsSql})
      `
    )
    .bind(status, nextAttempts, availableAt, reason, toIso(nowMs), row.job_id, ...calendarSyncJobClaimBindings(row, claim));
};

const markJobFailure = async (
  db: D1Database,
  row: CalendarSyncJobRow,
  reason: string,
  claim: CalendarSyncJobClaim,
  nowMs: number
) => {
  const result = await buildJobFailureUpdate(db, row, reason, claim, nowMs).run();
  return hasChangedRows(result);
};

/** Capture once on the attempt whose CAS write performed the dead transition. */
const captureCalendarSyncJobDeadIfNeeded = (
  changed: boolean,
  claim: CalendarSyncJobClaim,
  row: CalendarSyncJobRow,
  reason: string
) => {
  if (changed && claim.attempts >= MAX_ATTEMPTS) {
    safeCaptureException(new Error(`calendar sync job failed permanently: ${reason}`), {
      tags: { dispatcher: "google_calendar_sync", reason },
      contexts: {
        job: { job_id: row.job_id, google_action: row.google_action, owner_type: row.owner_type }
      }
    });
  }
};

const hasChangedRows = (result: D1Result) => {
  return Number(result.meta?.changes ?? 0) > 0;
};

// Dead-letter any stale `processing` rows whose attempt counter already reached
// the retry cap (codex #9 follow-up). Without this sweep, repeated worker crashes
// after markJobProcessing but before markJobFailure could bypass MAX_ATTEMPTS.
const markStaleCalendarSyncClaimsExhausted = async (db: D1Database, nowMs: number) => {
  const nowIso = toIso(nowMs);
  const result = await db
    .prepare(
      `
        UPDATE calendar_sync_jobs
        SET status = 'dead',
            locked_until = NULL,
            last_error = 'exhausted_after_repeated_crash',
            updated_at = ?
        WHERE status = 'processing'
          AND locked_until < ?
          AND attempts >= ?
      `
    )
    .bind(nowIso, nowIso, MAX_ATTEMPTS)
    .run();
  // Crash-loop dead-lettering has no per-job catch on its path (the worker died
  // before markJobFailure ran), so capture it here — otherwise these jobs die
  // silently for both cron and workflow callers.
  const deadCount = result.meta?.changes ?? 0;
  if (deadCount > 0) {
    safeCaptureException(
      new Error(`calendar sync jobs dead-lettered after repeated crash: ${deadCount}`),
      { tags: { dispatcher: "google_calendar_sync", reason: "exhausted_after_repeated_crash" } }
    );
  }
};

const markJobProcessing = async (db: D1Database, row: CalendarSyncJobRow, nowMs: number) => {
  const nowIso = toIso(nowMs);
  const lockedUntil = toIso(nowMs + LOCK_TTL_MS);
  const result = await db
    .prepare(
      `
        UPDATE calendar_sync_jobs
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

const calendarSyncJobClaimExistsSql = `
  SELECT 1
  FROM calendar_sync_jobs
  WHERE id = ?
    AND status = 'processing'
    AND attempts = ?
    AND locked_until = ?
`;

const calendarSyncJobClaimBindings = (row: CalendarSyncJobRow, claim: CalendarSyncJobClaim) => [
  row.job_id,
  claim.attempts,
  claim.lockedUntil
];

const calendarSyncJobClaimOrExpirySupersededSql = `
  SELECT 1
  FROM calendar_sync_jobs
  WHERE id = ?
    AND (
      (
        status = 'processing'
        AND attempts = ?
        AND locked_until = ?
      )
      OR (
        status = 'succeeded'
        AND last_error = 'superseded_by_reservation_expiry'
      )
    )
`;

const markCalendarSyncJobSuperseded = async (
  db: D1Database,
  row: CalendarSyncJobRow,
  reason: string,
  claim: CalendarSyncJobClaim,
  nowMs: number
): Promise<CalendarSyncJobOutcome> => {
  const result = await db
    .prepare(
      `
        UPDATE calendar_sync_jobs
        SET status = 'succeeded',
            locked_until = NULL,
            last_error = ?,
            updated_at = ?
        WHERE id = ?
          AND EXISTS (${calendarSyncJobClaimExistsSql})
      `
    )
    .bind(reason, toIso(nowMs), row.job_id, ...calendarSyncJobClaimBindings(row, claim))
    .run();
  if (hasChangedRows(result)) {
    return "succeeded";
  }
  const alreadySuperseded = await db
    .prepare(
      `
        SELECT id
        FROM calendar_sync_jobs
        WHERE id = ?
          AND status = 'succeeded'
          AND last_error = ?
        LIMIT 1
      `
    )
    .bind(row.job_id, reason)
    .first<{ id: string }>();
  return alreadySuperseded ? "succeeded" : "skipped";
};

// isReservationStillUpsertable, shouldDeleteReservationEventAfterWrite,
// persistStaleReservationGoogleEventCleanup, and their external_block
// counterparts are now in calendar-sync-eligibility.ts (issue #121).

// One deadline for the WHOLE marker lookup, pages included — not per request.
// withOutboundTimeout passes any request that carries its own signal straight
// through (outbound-timeout.ts:132), so without this the lookup would inherit
// the 30s default and push calendar_sync's worst case to 30 + 5×(30+30) = 330s,
// over the 270s CLAIM_TASK_TIMEOUT_MS budget that cron-watchdog.ts sizes as
// "calendar ≤5 × (10s owner-marker lookup + 30s write|delete)". Write and
// delete each do at most one lookup + one mutation, so the per-job ceiling
// stays 40s and the batch worst case stays 30 + 5×(10+30) = 230s (#563).
const OWNER_MARKER_LOOKUP_TIMEOUT_MS = 10_000;
// Runaway guard only. The shared deadline above is what actually bounds this;
// a calendar would need thousands of matching events to reach it.
const OWNER_MARKER_LOOKUP_MAX_PAGES = 10;
// Each remembered tombstone becomes one UPDATE in the delete job's D1 batch, so
// the scan refuses to build an unbounded one. Exceeding this fails closed rather
// than truncating: a silently dropped id whose ledger row is the 'active' one
// would leave exactly the false conflict this search exists to prevent, and
// re-running would drop the same id again. One owner marker matching more than
// 50 events is already a broken state that should surface, not retry quietly.
const OWNER_MARKER_TOMBSTONE_LIMIT = 50;

/**
 * The `privateExtendedProperty` filter identifying the one event this job owns.
 * Returns null when the row carries no owner id — the caller must then fail
 * closed rather than search, because a query without the owner filter would
 * match somebody else's event.
 *
 * `includeDeleted` is delete-path only. Write keeps showDeleted off so a
 * cancelled tombstone never matches and gets PATCHed back into life.
 */
const buildOwnerMarkerQuery = (
  row: CalendarSyncJobRow,
  includeDeleted: boolean
): URLSearchParams | null => {
  const params = new URLSearchParams();
  params.append("privateExtendedProperty", "app=reservation-line-homepage");
  if (row.owner_type === "reservation" && row.reservation_id) {
    params.append("privateExtendedProperty", "owner_type=reservation");
    params.append("privateExtendedProperty", `reservation_id=${row.reservation_id}`);
  } else if (row.owner_type === "external_block" && row.external_block_id) {
    params.append("privateExtendedProperty", "owner_type=external_block");
    params.append("privateExtendedProperty", `external_block_id=${row.external_block_id}`);
  } else {
    return null;
  }
  // showDeleted intentionally omitted by default (defaults to false) so
  // deleted-event tombstones never match and get PATCHed back into life.
  // Delete path sets includeDeleted: true so it can find a cancelled tombstone
  // when D1 lost google_event_id after a prior DELETE (or a human deleted in
  // the Google UI) and still flip the ledger to status='deleted' (#589-1).
  if (includeDeleted) {
    params.set("showDeleted", "true");
  }
  return params;
};

/**
 * One page of the marker search, with only the items validated. Takes the page
 * token rather than a finished URL so the caller's loop holds paging policy and
 * nothing else.
 */
const fetchOwnerMarkerPage = async (
  calendarPath: string,
  params: URLSearchParams,
  pageToken: string | undefined,
  accessToken: string,
  fetcher: typeof fetch,
  signal: AbortSignal
): Promise<
  | { ok: true; items: unknown[]; nextPageToken: unknown }
  | { ok: false; reason: string }
> => {
  const pageParams = new URLSearchParams(params);
  if (pageToken) {
    pageParams.set("pageToken", pageToken);
  }
  const url = `${calendarPath}?${pageParams.toString()}`;

  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      signal
    });
  } catch {
    return { ok: false, reason: "google-fetch-failed" };
  }

  if (!response.ok) {
    return { ok: false, reason: `google-http-${response.status}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "invalid-google-response" };
  }

  if (typeof body !== "object" || body === null) {
    return { ok: false, reason: "invalid-google-response" };
  }

  const { items, nextPageToken } = body as Record<string, unknown>;
  // An ABSENT items field is an empty page, not a broken response — Google
  // omits empty optional arrays, and import-sync.ts models the same endpoint
  // the same way (`items?: unknown` + `Array.isArray(...) ? ... : []`).
  // Rejecting it here would fail every FIRST-TIME upsert closed: the marker
  // lookup legitimately finds nothing, and the job would retry to the dead
  // letter without ever reaching the POST it was supposed to guard.
  // A PRESENT non-array is still a broken response.
  if (items !== undefined && !Array.isArray(items)) {
    return { ok: false, reason: "invalid-google-response" };
  }

  return { ok: true, items: items ?? [], nextPageToken };
};

/** Valid id = object with non-empty string `id`. */
const isValidGoogleEventIdItem = (item: unknown): item is { id: string } =>
  typeof item === "object" &&
  item !== null &&
  typeof (item as Record<string, unknown>).id === "string" &&
  // An empty id is type-valid but useless: if accepted, filter still keeps it and
  // valid[0].id becomes "", which the call site reads as "no event found" and
  // hides later real ids on the same page.
  (item as Record<string, unknown>).id !== "";

/**
 * Look up an existing Google Calendar event by the private extended-property
 * owner markers we write on create (see buildReservationCalendarEvent /
 * buildExternalBlockCalendarEvent). Used when D1 lost google_event_id after a
 * successful POST (e.g. D1 export freeze) so a retry PATCHes instead of
 * creating a second orphan event. Never falls back to POST on lookup failure.
 *
 * `hasMore` counts LIVE matches only (second live id on the scanned pages, or
 * a nextPageToken of any shape after a live hit). Tombstones alone never set
 * hasMore. A nextPageToken after a live hit may continue into tombstone-only
 * pages; that can leave moreRemaining true after DELETE, but the next attempt
 * re-searches, returns alreadyDeleted with hasMore:false, and the job
 * succeeds — so the retry converges rather than looping forever (#589-1 / #570).
 *
 * `alreadyDeleted` is true only when includeDeleted was set, every page was
 * scanned (or absence proven by missing nextPageToken), no live event remained,
 * and at least one cancelled tombstone was seen. Write path never sets this.
 *
 * `tombstoneIds` is every cancelled id seen so far, in scan order — including
 * the ones on the page where a live event won. The caller flips the matching
 * google_calendar_events rows to 'deleted': one delete job records only the id
 * it deleted, so a second tombstone whose ledger row is still 'active' would
 * otherwise keep raising the false reservation_event_deleted (#589-1).
 */
type OwnerMarkerLookup =
  | {
      ok: true;
      eventId: string | null;
      hasMore: boolean;
      alreadyDeleted: boolean;
      tombstoneIds: string[];
    }
  | { ok: false; reason: string };

/**
 * Split one page into live ids and cancelled tombstone ids. Classification
 * only — which of the two wins is the caller's ordering rule, and that rule
 * stays in the loop.
 *
 * Live = status !== "cancelled". Missing/unknown status is live: worst case we
 * DELETE an already-gone event and the 404/410 branch absorbs it. A positive
 * status==="confirmed" check would reintroduce this bug for tentative /
 * status-omitted items (#589-1).
 */
const splitOwnerMarkerItems = (items: unknown[]) => {
  const valid = items.filter(isValidGoogleEventIdItem);
  const isCancelled = (item: { id: string }) =>
    (item as Record<string, unknown>).status === "cancelled";
  return {
    live: valid.filter((item) => !isCancelled(item)),
    tombstones: valid.filter(isCancelled).map((item) => item.id)
  };
};

/**
 * What a page's nextPageToken means. An absent token is the ONLY proof that the
 * scan saw everything; a present-but-wrong-shaped one is a broken response, not
 * an end marker.
 */
type OwnerMarkerNextPage =
  | { kind: "end" }
  | { kind: "broken" }
  | { kind: "more"; token: string };

const classifyOwnerMarkerNextPage = (token: unknown): OwnerMarkerNextPage => {
  if (token === undefined || token === null) {
    return { kind: "end" };
  }
  if (typeof token !== "string" || token === "") {
    return { kind: "broken" };
  }
  return { kind: "more", token };
};

/**
 * Full scan finished with no live event left. On the delete path a remembered
 * tombstone is still a usable id — same end state as a 410 Gone.
 */
const ownerMarkerScanExhausted = (
  includeDeleted: boolean,
  tombstoneIds: string[]
): OwnerMarkerLookup => {
  const firstTombstoneId = includeDeleted ? tombstoneIds[0] : undefined;
  return {
    ok: true,
    eventId: firstTombstoneId ?? null,
    // Live absence is proven; no further live DELETEs remain.
    hasMore: false,
    alreadyDeleted: firstTombstoneId !== undefined,
    tombstoneIds
  };
};

const findGoogleEventByOwnerMarker = async (
  row: CalendarSyncJobRow,
  accessToken: string,
  fetcher: typeof fetch,
  options: { includeDeleted: boolean }
): Promise<OwnerMarkerLookup> => {
  const params = buildOwnerMarkerQuery(row, options.includeDeleted);
  if (!params) {
    // Missing owner id: cannot safely search. Fail closed (no POST).
    return { ok: false, reason: "google-lookup-failed" };
  }

  const calendarPath = `${GOOGLE_CALENDAR_API_BASE}/${encodeURIComponent(row.calendar_id)}/events`;
  const signal = AbortSignal.timeout(OWNER_MARKER_LOOKUP_TIMEOUT_MS);
  let pageToken: string | undefined;
  // Cancelled tombstone ids in scan order. eventId is only set from the first
  // one, and only when includeDeleted and the full scan proves no live event
  // remains — early-returning on the first tombstone page would miss a live
  // duplicate on a later page (#570). See OWNER_MARKER_TOMBSTONE_LIMIT for why
  // an over-long list fails closed instead of being trimmed.
  const tombstoneIds: string[] = [];

  for (let page = 0; page < OWNER_MARKER_LOOKUP_MAX_PAGES; page += 1) {
    const result = await fetchOwnerMarkerPage(
      calendarPath,
      params,
      pageToken,
      accessToken,
      fetcher,
      signal
    );
    if (!result.ok) {
      return result;
    }

    const { live, tombstones } = splitOwnerMarkerItems(result.items);
    tombstoneIds.push(...tombstones);
    if (tombstoneIds.length > OWNER_MARKER_TOMBSTONE_LIMIT) {
      return { ok: false, reason: "google-lookup-incomplete" };
    }

    // Live wins immediately — same as the pre-#589-1 path for write/delete.
    // hasMore uses live count only; a trailing nextPageToken is enough to set
    // it (I3: prefer an extra retry over orphan silence) even if later pages
    // hold only tombstones — see JSDoc convergence note above.
    if (live.length > 0) {
      return {
        ok: true,
        eventId: live[0]!.id,
        hasMore:
          live.length > 1 ||
          (result.nextPageToken !== undefined && result.nextPageToken !== null),
        alreadyDeleted: false,
        tombstoneIds
      };
    }

    // No live on this page. Do NOT stop on tombstones alone — keep paging so a
    // live duplicate further on is not missed. Empty/tombstone-only pages still
    // need nextPageToken to prove absence (same rule as the pre-#589-1 empty
    // page: an absent token is the only proof; a wrong-shaped token is broken).
    const nextPage = classifyOwnerMarkerNextPage(result.nextPageToken);
    if (nextPage.kind === "end") {
      return ownerMarkerScanExhausted(options.includeDeleted, tombstoneIds);
    }
    if (nextPage.kind === "broken") {
      return { ok: false, reason: "invalid-google-response" };
    }
    pageToken = nextPage.token;
  }

  // Ran out of pages without proving absence (even with a remembered
  // tombstone). Fail closed — same as write path.
  return { ok: false, reason: "google-lookup-incomplete" };
};

// The event id an outbound mutation should target: D1's when it has one, else
// the owner-marker search. Both callers must fail closed when the search proves
// neither presence nor absence — writing (#560) would create a second orphan,
// deleting (#563) would abandon the first — so the reason is propagated
// unchanged to stay aligned with mapSyncErrorToClass and last_error.
// D1 short-circuit never searched, so hasMore/alreadyDeleted are false and
// tombstoneIds is empty there (#570 / #589-1).
const resolveGoogleEventId = async (
  row: CalendarSyncJobRow,
  accessToken: string,
  fetcher: typeof fetch,
  options: { includeDeleted: boolean }
): Promise<OwnerMarkerLookup> =>
  row.google_event_id
    ? {
        ok: true,
        eventId: row.google_event_id,
        hasMore: false,
        alreadyDeleted: false,
        tombstoneIds: []
      }
    : findGoogleEventByOwnerMarker(row, accessToken, fetcher, options);

const writeGoogleEvent = async (
  row: CalendarSyncJobRow,
  payload: GoogleCalendarEventPayload,
  accessToken: string,
  fetcher: typeof fetch
) => {
  const calendarPath = `${GOOGLE_CALENDAR_API_BASE}/${encodeURIComponent(row.calendar_id)}/events`;

  // A resolved id means PATCH, a null one means POST a new event.
  // includeDeleted: false — never match cancelled tombstones or we would
  // PATCH them back into life (see buildOwnerMarkerQuery).
  const resolved = await resolveGoogleEventId(row, accessToken, fetcher, {
    includeDeleted: false
  });
  if (!resolved.ok) {
    return {
      ok: false as const,
      reason: resolved.reason
    };
  }
  const targetEventId = resolved.eventId;

  const url = targetEventId
    ? `${calendarPath}/${encodeURIComponent(targetEventId)}`
    : calendarPath;
  const method = targetEventId ? "PATCH" : "POST";
  let response: Response;
  try {
    response = await fetcher(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
  } catch {
    // Outbound timeout / transport error: surface as a retryable failure so
    // the claim is released and attempts is incremented (instead of the
    // throw bubbling out of the batch and leaving the claim hung on its
    // locked_until TTL).
    return {
      ok: false as const,
      reason: "google-fetch-failed"
    };
  }

  if (!response.ok) {
    return {
      ok: false as const,
      reason: `google-http-${response.status}`
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      ok: false as const,
      reason: "invalid-google-response"
    };
  }

  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as Record<string, unknown>).id !== "string"
  ) {
    return {
      ok: false as const,
      reason: "invalid-google-response"
    };
  }

  return {
    ok: true as const,
    event: body as GoogleEventResponse
  };
};

const deleteGoogleEvent = async (
  row: CalendarSyncJobRow,
  accessToken: string,
  fetcher: typeof fetch
) => {
  // A resolved id is the orphan we must reclaim even when D1 lost it (#563).
  // One DELETE per attempt (I1/I4 budget: 1 lookup + 1 mutation). If the marker
  // search already saw further live matches (`hasMore`), we still DELETE this
  // one first, then surface moreRemaining so the job is marked retryable for
  // another attempt (issue #570). Prior failures + remaining duplicates can
  // still exhaust MAX_ATTEMPTS (5) and dead-letter with orphans left — requeue
  // via sync-recovery (#589). Never abort before DELETE on a live id: that
  // would burn the cap with zero progress.
  // includeDeleted: true so a cancelled tombstone is not misread as "proven
  // absence" — that left google_calendar_events status='active' and import
  // raised a false reservation_event_deleted conflict (#589-1).
  const resolved = await resolveGoogleEventId(row, accessToken, fetcher, {
    includeDeleted: true
  });
  if (!resolved.ok) {
    return {
      ok: false as const,
      reason: resolved.reason
    };
  }
  const targetEventId = resolved.eventId;

  // Proven absence (markers matched nothing, not even a tombstone): the delete
  // goal is already met, so skip the API call entirely. The caller records a
  // local-only success (delete_skipped).
  if (!targetEventId) {
    return {
      ok: true as const,
      deletedEventId: null,
      mutationIssued: false,
      staleTombstoneIds: resolved.tombstoneIds,
      moreRemaining: false
    };
  }

  // Tombstone already present: same end state as 410 Gone. Do not DELETE again;
  // return the id so persist flips google_calendar_events to 'deleted' and
  // mirrors it into history. That ledger row is what stops the import walk from
  // reading the cancelled event as a surprise deletion (#589-1). The audit row
  // records a skip, not a delete, and no outbound row is written — see
  // persistGoogleDeleteSuccess.
  if (resolved.alreadyDeleted) {
    return {
      ok: true as const,
      deletedEventId: targetEventId,
      // No DELETE request went out — the tombstone was already there.
      mutationIssued: false,
      staleTombstoneIds: resolved.tombstoneIds,
      moreRemaining: false
    };
  }

  const calendarPath = `${GOOGLE_CALENDAR_API_BASE}/${encodeURIComponent(row.calendar_id)}/events`;
  const url = `${calendarPath}/${encodeURIComponent(targetEventId)}?sendUpdates=none`;
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });
  } catch {
    // Outbound timeout / transport error: retryable failure (see writeGoogleEvent).
    // I2: HTTP/transport failure wins over moreRemaining.
    return {
      ok: false as const,
      reason: "google-fetch-failed"
    };
  }

  // 404 Not Found and 410 Gone both mean the event is already absent — the
  // delete goal is met. Google Calendar returns 410 for already-deleted events
  // ("Resource has been deleted"); this is unrelated to import-sync's 410,
  // which signals sync-token invalidation.
  if (!response.ok && response.status !== 404 && response.status !== 410) {
    // I2: DELETE failure reason beats duplicates-remaining.
    return {
      ok: false as const,
      reason: `google-http-${response.status}`
    };
  }

  return {
    ok: true as const,
    deletedEventId: targetEventId,
    mutationIssued: true,
    // Tombstones seen while scanning for this live id. Their ledger rows are
    // stale the same way, and no later attempt is guaranteed to revisit them
    // once this job succeeds.
    staleTombstoneIds: resolved.tombstoneIds,
    // Only after a successful DELETE (I1): one event advanced; caller may keep
    // the job retryable when more live marker matches remain.
    moreRemaining: resolved.hasMore
  };
};

const persistGoogleEventSuccess = async (
  db: D1Database,
  row: ReservationCalendarSyncJobRow,
  event: GoogleEventResponse,
  payloadFingerprint: string,
  claim: CalendarSyncJobClaim,
  nowMs: number
): Promise<CalendarSyncJobOutcome> => {
  const nowIso = toIso(nowMs);
  const outboundExpiresAt = toIso(nowMs + OUTBOUND_WRITE_TTL_MS);
  const etag = event.etag ?? null;
  const updated = event.updated ?? null;

  const results = await db.batch([
    db
      .prepare(
        `
          UPDATE reservations
          SET google_event_id = ?,
              google_event_etag = ?,
              google_sync_state = 'synced',
              updated_at = ?
          WHERE id = ?
            AND (
              status IN ('confirmed', 'completed', 'no_show')
              OR (
                status = 'pending_approval'
                AND (pending_expires_at IS NULL OR pending_expires_at > ?)
              )
            )
            AND EXISTS (${calendarSyncJobClaimExistsSql})
        `
      )
      .bind(event.id, etag, nowIso, row.reservation_id, nowIso, ...calendarSyncJobClaimBindings(row, claim)),
    db
      .prepare(
        `
          INSERT INTO google_calendar_events (
            id,
            store_id,
            calendar_id,
            google_event_id,
            reservation_id,
            google_etag,
            google_updated_at,
            last_seen_at,
            last_imported_at,
            source_type,
            status,
            google_safe_snapshot_json
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reservation', 'active', ?
          WHERE EXISTS (
            SELECT 1
            FROM reservations
            WHERE id = ?
              AND (
                status IN ('confirmed', 'completed', 'no_show')
                OR (
                  status = 'pending_approval'
                  AND (pending_expires_at IS NULL OR pending_expires_at > ?)
                )
              )
          )
          AND EXISTS (${calendarSyncJobClaimExistsSql})
          ON CONFLICT(calendar_id, google_event_id) DO UPDATE SET
            reservation_id = excluded.reservation_id,
            google_etag = excluded.google_etag,
            google_updated_at = excluded.google_updated_at,
            last_seen_at = excluded.last_seen_at,
            last_imported_at = excluded.last_imported_at,
            source_type = 'reservation',
            status = 'active',
            google_safe_snapshot_json = excluded.google_safe_snapshot_json
        `
      )
      .bind(
        crypto.randomUUID(),
        row.store_id,
        row.calendar_id,
        event.id,
        row.reservation_id,
        etag,
        updated,
        nowIso,
        nowIso,
        JSON.stringify({
          owner_type: "reservation",
          reservation_id: row.reservation_id,
          store_id: row.store_id,
          service_names: row.service_names,
          start_at: row.start_at,
          end_at: row.end_at
        }),
        row.reservation_id,
        nowIso,
        ...calendarSyncJobClaimBindings(row, claim)
      ),
    db
      .prepare(
        `
          INSERT OR IGNORE INTO google_calendar_outbound_writes (
            id,
            calendar_sync_job_id,
            dedupe_key,
            calendar_id,
            google_event_id,
            owner_type,
            owner_id,
            action,
            expected_fingerprint,
            google_etag_after,
            expires_at
          )
          SELECT ?, ?, ?, ?, ?, 'reservation', ?, 'upsert', ?, ?, ?
          WHERE EXISTS (
            SELECT 1
            FROM reservations
            WHERE id = ?
              AND (
                status IN ('confirmed', 'completed', 'no_show')
                OR (
                  status = 'pending_approval'
                  AND (pending_expires_at IS NULL OR pending_expires_at > ?)
                )
              )
          )
          AND EXISTS (${calendarSyncJobClaimExistsSql})
        `
      )
      .bind(
        crypto.randomUUID(),
        row.job_id,
        `calendar_sync_job:${row.job_id}:fingerprint:${payloadFingerprint}`,
        row.calendar_id,
        event.id,
        row.reservation_id,
        payloadFingerprint,
        etag,
        outboundExpiresAt,
        row.reservation_id,
        nowIso,
        ...calendarSyncJobClaimBindings(row, claim)
      ),
    db
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
          )
          SELECT ?, 'system', 'calendar_sync', 'google_calendar_event_upserted', 'reservation', ?, ?
          WHERE EXISTS (
            SELECT 1
            FROM reservations
            WHERE id = ?
              AND (
                status IN ('confirmed', 'completed', 'no_show')
                OR (
                  status = 'pending_approval'
                  AND (pending_expires_at IS NULL OR pending_expires_at > ?)
                )
              )
          )
          AND EXISTS (${calendarSyncJobClaimExistsSql})
        `
      )
      .bind(
        crypto.randomUUID(),
        row.reservation_id,
        JSON.stringify({
          calendar_id: row.calendar_id,
          google_event_id: event.id,
          calendar_sync_job_id: row.job_id
        }),
        row.reservation_id,
        nowIso,
        ...calendarSyncJobClaimBindings(row, claim)
      ),
    // Outbound snapshot history — read-only shadow, never affects write flow.
    outboundHistoryInsert(
      db, row,
      { id: event.id, etag, updatedAt: updated },
      "active", nowIso,
      { sql: calendarSyncJobClaimExistsSql, bindings: calendarSyncJobClaimBindings(row, claim) }
    ),
    db
      .prepare(
        `
          UPDATE calendar_sync_jobs
          SET status = 'succeeded',
              locked_until = NULL,
              last_error = NULL,
              updated_at = ?
          WHERE id = ?
            AND EXISTS (
              SELECT 1
              FROM reservations
              WHERE id = ?
                AND (
                  status IN ('confirmed', 'completed', 'no_show')
                  OR (
                    status = 'pending_approval'
                    AND (pending_expires_at IS NULL OR pending_expires_at > ?)
                  )
                )
            )
            AND EXISTS (${calendarSyncJobClaimOrExpirySupersededSql})
        `
      )
      .bind(nowIso, row.job_id, row.reservation_id, nowIso, ...calendarSyncJobClaimBindings(row, claim))
  ]);
  return hasChangedRows(results[5]) ? "succeeded" : "skipped";
};


const DUPLICATE_MARKERS_REMAINING_REASON = "google-owner-marker-duplicates-remaining";

/**
 * Append the job-status flip to `statements`, run one batch, and map the CAS
 * result. Claim CAS must cover ledger writes and the job-status flip together —
 * never split into a second batch.
 */
const finalizeDeleteBatch = async (
  db: D1Database,
  row: CalendarSyncJobRow,
  claim: CalendarSyncJobClaim,
  nowMs: number,
  moreRemaining: boolean,
  statements: D1PreparedStatement[]
): Promise<CalendarSyncJobOutcome> => {
  if (moreRemaining) {
    statements.push(
      buildJobFailureUpdate(db, row, DUPLICATE_MARKERS_REMAINING_REASON, claim, nowMs)
    );
  } else {
    statements.push(
      db
        .prepare(
          `
            UPDATE calendar_sync_jobs
            SET status = 'succeeded',
                locked_until = NULL,
                last_error = NULL,
                updated_at = ?
            WHERE id = ?
              AND EXISTS (${calendarSyncJobClaimExistsSql})
          `
        )
        .bind(toIso(nowMs), row.job_id, ...calendarSyncJobClaimBindings(row, claim))
    );
  }

  const results = await db.batch(statements);
  const finalResult = results.at(-1);
  if (!finalResult || !hasChangedRows(finalResult)) {
    return "skipped";
  }
  if (moreRemaining) {
    captureCalendarSyncJobDeadIfNeeded(true, claim, row, DUPLICATE_MARKERS_REMAINING_REASON);
    return "failed";
  }
  return "succeeded";
};

/**
 * Ledger rows for tombstones the marker scan saw but this job did not delete.
 * A delete job records only the id it deleted, so a duplicate that Google
 * already has as cancelled would keep its google_calendar_events row 'active'
 * and the import walk would keep raising the false reservation_event_deleted
 * this fix exists to stop (#589-1). Only rows still 'active' are touched, so
 * repeats and the id this job did delete are no-ops.
 */
const staleTombstoneLedgerUpdates = (
  db: D1Database,
  row: CalendarSyncJobRow,
  claim: CalendarSyncJobClaim,
  nowIso: string,
  tombstoneIds: string[],
  ownerColumn: "reservation_id" | "external_block_id",
  ownerId: string
) =>
  tombstoneIds.map((tombstoneId) =>
    db
      .prepare(
        `
          UPDATE google_calendar_events
          SET status = 'deleted',
              last_seen_at = ?,
              last_imported_at = ?
          WHERE calendar_id = ?
            AND google_event_id = ?
            AND ${ownerColumn} = ?
            AND status = 'active'
            AND EXISTS (${calendarSyncJobClaimExistsSql})
        `
      )
      .bind(
        nowIso,
        nowIso,
        row.calendar_id,
        tombstoneId,
        ownerId,
        ...calendarSyncJobClaimBindings(row, claim)
      )
  );

// The three delete-success persisters take the same nine values, so they share
// one input object. Each destructures it immediately: the bodies keep using the
// bare names, and the parameter count stays at one.
type DeleteSuccessPersistInput = {
  db: D1Database;
  deletedEventId: string | null;
  payloadFingerprint: string;
  claim: CalendarSyncJobClaim;
  nowMs: number;
  moreRemaining: boolean;
  staleTombstoneIds: string[];
  mutationIssued: boolean;
};

const persistGoogleDeleteSuccess = async (
  input: DeleteSuccessPersistInput & { row: ReservationCalendarSyncJobRow }
): Promise<CalendarSyncJobOutcome> => {
  const {
    db,
    row,
    deletedEventId,
    payloadFingerprint,
    claim,
    nowMs,
    moreRemaining,
    staleTombstoneIds,
    mutationIssued
  } = input;
  const nowIso = toIso(nowMs);
  const outboundExpiresAt = toIso(nowMs + OUTBOUND_WRITE_TTL_MS);
  const statements: D1PreparedStatement[] = staleTombstoneLedgerUpdates(
    db,
    row,
    claim,
    nowIso,
    staleTombstoneIds,
    "reservation_id",
    row.reservation_id
  );

  // Owner clear (+ google_sync_state='synced') only on the final attempt.
  // Intermediate moreRemaining deletes still have orphans; writing 'synced' would lie.
  if (!moreRemaining) {
    // Codex #10: only clear reservations.google_event_id when the stored value still
    // matches what this delete job thought it was deleting. The previous
    // UPDATE was unconditional and clobbered a freshly-written google_event_id
    // produced by a concurrent upsert, leaving the new Google event orphaned in
    // Google Calendar (the follow-up delete then saw NULL and skipped the call).
    //
    // CAS uses row.google_event_id (the D1 value at claim time), NOT the id
    // actually deleted via marker lookup. Marker-path deletes claim with NULL,
    // so the predicate only runs the idempotent NULL-set when D1 is still NULL —
    // a concurrent upsert's newly stored value is left alone.
    //
    // - row.google_event_id IS NULL: only NULL-set if still NULL.
    // - row.google_event_id IS NOT NULL: only clear if it still equals that id.
    statements.push(
      db
        .prepare(
          `
            UPDATE reservations
            SET google_event_id = NULL,
                google_event_etag = NULL,
                google_sync_state = 'synced',
                updated_at = ?
            WHERE id = ?
              AND (
                (? IS NULL AND google_event_id IS NULL)
                OR
                google_event_id = ?
              )
              AND EXISTS (${calendarSyncJobClaimExistsSql})
          `
        )
        .bind(
          nowIso,
          row.reservation_id,
          row.google_event_id,
          row.google_event_id,
          ...calendarSyncJobClaimBindings(row, claim)
        )
    );
  }

  statements.push(
    db
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
          )
          SELECT ?, 'system', 'calendar_sync', ?, 'reservation', ?, ?
          WHERE EXISTS (${calendarSyncJobClaimExistsSql})
        `
      )
      .bind(
        crypto.randomUUID(),
        // Keyed on the request, not the end state: an already-present tombstone
        // is reconciled without a DELETE, so claiming we deleted it would put a
        // call that never happened into the audit trail (#589-1). Its
        // google_event_id in metadata is what separates it from a true
        // proven-absence skip, where the id is null.
        mutationIssued
          ? "google_calendar_event_deleted"
          : "google_calendar_event_delete_skipped",
        row.reservation_id,
        JSON.stringify({
          calendar_id: row.calendar_id,
          google_event_id: deletedEventId,
          calendar_sync_job_id: row.job_id
        }),
        ...calendarSyncJobClaimBindings(row, claim)
      )
  );

  // Audit / ledger paths use the id actually deleted (may come from marker
  // lookup when D1 had NULL). Gate on deletedEventId so a successful marker
  // delete still records history/outbound_writes/event status.
  // moreRemaining is only set after a successful DELETE, so deletedEventId is non-null then.
  if (deletedEventId) {
    statements.push(
      db
        .prepare(
          `
            UPDATE google_calendar_events
            SET status = 'deleted',
                last_seen_at = ?,
                last_imported_at = ?
            WHERE calendar_id = ?
              AND google_event_id = ?
              AND reservation_id = ?
              AND EXISTS (${calendarSyncJobClaimExistsSql})
          `
        )
        .bind(nowIso, nowIso, row.calendar_id, deletedEventId, row.reservation_id, ...calendarSyncJobClaimBindings(row, claim)),
      deleteHistoryInsert(db, row, deletedEventId, nowIso, claim)
    );
  }

  // The outbound ledger is the record of mutations WE sent (echo suppression,
  // retry dedupe). The tombstone path sent none, so it gets no row.
  if (deletedEventId && mutationIssued) {
    statements.push(
      db
        .prepare(
          `
            INSERT OR IGNORE INTO google_calendar_outbound_writes (
              id,
              calendar_sync_job_id,
              dedupe_key,
              calendar_id,
              google_event_id,
              owner_type,
              owner_id,
              action,
              expected_fingerprint,
              google_etag_after,
              expires_at
            )
            SELECT ?, ?, ?, ?, ?, 'reservation', ?, 'delete', ?, NULL, ?
            WHERE EXISTS (${calendarSyncJobClaimExistsSql})
          `
        )
        .bind(
          crypto.randomUUID(),
          row.job_id,
          // The delete fingerprint includes the id actually deleted, so each
          // duplicate reclaimed under moreRemaining gets its own row; INSERT OR
          // IGNORE only collapses a genuine retry of the same delete.
          `calendar_sync_job:${row.job_id}:delete:${payloadFingerprint}`,
          row.calendar_id,
          deletedEventId,
          row.reservation_id,
          payloadFingerprint,
          outboundExpiresAt,
          ...calendarSyncJobClaimBindings(row, claim)
        )
    );
  }

  return finalizeDeleteBatch(db, row, claim, nowMs, moreRemaining, statements);
};

const persistExternalBlockGoogleEventSuccess = async (
  db: D1Database,
  row: ExternalBlockCalendarSyncJobRow,
  event: GoogleEventResponse,
  payloadFingerprint: string,
  claim: CalendarSyncJobClaim,
  nowMs: number
): Promise<CalendarSyncJobOutcome> => {
  const nowIso = toIso(nowMs);
  const outboundExpiresAt = toIso(nowMs + OUTBOUND_WRITE_TTL_MS);
  const etag = event.etag ?? null;
  const updated = event.updated ?? null;

  // Mirror reservation pattern (persistGoogleEventSuccess): every statement is
  // guarded by `external_blocks.status = 'active'` so that if the block was
  // cancelled mid-write, this success path is a no-op (changes = 0). The
  // post-write check (shouldDeleteExternalBlockEventAfterWrite) + cleanup
  // (persistStaleExternalBlockGoogleEventCleanup) then take over to record
  // the orphan event_id + enqueue a follow-up delete. Issue #121.
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `
          UPDATE external_blocks
          SET google_event_id = ?,
              google_event_etag = ?,
              updated_at = ?
          WHERE id = ?
            AND status = 'active'
            AND EXISTS (${calendarSyncJobClaimExistsSql})
        `
      )
      .bind(event.id, etag, nowIso, row.external_block_id, ...calendarSyncJobClaimBindings(row, claim)),
    db
      .prepare(
        `
          INSERT INTO google_calendar_events (
            id,
            store_id,
            calendar_id,
            google_event_id,
            external_block_id,
            google_etag,
            google_updated_at,
            last_seen_at,
            last_imported_at,
            source_type,
            status,
            google_safe_snapshot_json
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'external_block', 'active', ?
          WHERE EXISTS (
            SELECT 1 FROM external_blocks
            WHERE id = ? AND status = 'active'
          )
          AND EXISTS (${calendarSyncJobClaimExistsSql})
          ON CONFLICT(calendar_id, google_event_id) DO UPDATE SET
            reservation_id = NULL,
            external_block_id = excluded.external_block_id,
            google_etag = excluded.google_etag,
            google_updated_at = excluded.google_updated_at,
            last_seen_at = excluded.last_seen_at,
            last_imported_at = excluded.last_imported_at,
            source_type = 'external_block',
            status = 'active',
            google_safe_snapshot_json = excluded.google_safe_snapshot_json
        `
      )
      .bind(
        crypto.randomUUID(),
        row.store_id,
        row.calendar_id,
        event.id,
        row.external_block_id,
        etag,
        updated,
        nowIso,
        nowIso,
        JSON.stringify({
          owner_type: "external_block",
          external_block_id: row.external_block_id,
          store_id: row.store_id,
          start_at: row.start_at,
          end_at: row.end_at
        }),
        row.external_block_id,
        ...calendarSyncJobClaimBindings(row, claim)
      ),
    db
      .prepare(
        `
          INSERT OR IGNORE INTO google_calendar_outbound_writes (
            id,
            calendar_sync_job_id,
            dedupe_key,
            calendar_id,
            google_event_id,
            owner_type,
            owner_id,
            action,
            expected_fingerprint,
            google_etag_after,
            expires_at
          )
          SELECT ?, ?, ?, ?, ?, 'external_block', ?, 'upsert', ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM external_blocks
            WHERE id = ? AND status = 'active'
          )
          AND EXISTS (${calendarSyncJobClaimExistsSql})
        `
      )
      .bind(
        crypto.randomUUID(),
        row.job_id,
        `calendar_sync_job:${row.job_id}:fingerprint:${payloadFingerprint}`,
        row.calendar_id,
        event.id,
        row.external_block_id,
        payloadFingerprint,
        etag,
        outboundExpiresAt,
        row.external_block_id,
        ...calendarSyncJobClaimBindings(row, claim)
      ),
    db
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
          )
          SELECT ?, 'system', 'calendar_sync', 'google_calendar_external_block_upserted', 'external_block', ?, ?
          WHERE EXISTS (
            SELECT 1 FROM external_blocks
            WHERE id = ? AND status = 'active'
          )
          AND EXISTS (${calendarSyncJobClaimExistsSql})
        `
      )
      .bind(
        crypto.randomUUID(),
        row.external_block_id,
        JSON.stringify({
          calendar_id: row.calendar_id,
          google_event_id: event.id,
          calendar_sync_job_id: row.job_id
        }),
        row.external_block_id,
        ...calendarSyncJobClaimBindings(row, claim)
      )
  ];

  // Outbound snapshot history for external_block upsert — read-only shadow.
  statements.push(
    db
      .prepare(
        `
          INSERT INTO google_calendar_event_history (
            id, store_id, calendar_id, google_event_id,
            google_etag, google_updated_at, source_type,
            status, reason, snapshot_json, captured_at
          )
          SELECT ?, ?, ?, ?, ?, ?, 'external_block', 'active', 'upsert', ?, ?
          WHERE EXISTS (
            SELECT 1 FROM external_blocks WHERE id = ? AND status = 'active'
          )
          AND EXISTS (${calendarSyncJobClaimExistsSql})
        `
      )
      .bind(
        crypto.randomUUID(),
        row.store_id,
        row.calendar_id,
        event.id,
        etag,
        updated,
        buildOutboundSnapshotJson(row, event.id, "active"),
        nowIso,
        row.external_block_id,
        ...calendarSyncJobClaimBindings(row, claim)
      ),
    db
      .prepare(
        `
          UPDATE calendar_sync_jobs
          SET status = 'succeeded',
              locked_until = NULL,
              last_error = NULL,
              updated_at = ?
          WHERE id = ?
            AND EXISTS (
              SELECT 1 FROM external_blocks
              WHERE id = ? AND status = 'active'
            )
            AND EXISTS (${calendarSyncJobClaimExistsSql})
        `
      )
      .bind(nowIso, row.job_id, row.external_block_id, ...calendarSyncJobClaimBindings(row, claim))
  );

  const results = await db.batch(statements);
  const finalResult = results.at(-1);
  return finalResult && hasChangedRows(finalResult) ? "succeeded" : "skipped";
};

const persistExternalBlockGoogleDeleteSuccess = async (
  input: DeleteSuccessPersistInput & { row: ExternalBlockCalendarSyncJobRow }
): Promise<CalendarSyncJobOutcome> => {
  const {
    db,
    row,
    deletedEventId,
    payloadFingerprint,
    claim,
    nowMs,
    moreRemaining,
    staleTombstoneIds,
    mutationIssued
  } = input;
  const nowIso = toIso(nowMs);
  const outboundExpiresAt = toIso(nowMs + OUTBOUND_WRITE_TTL_MS);
  const statements: D1PreparedStatement[] = staleTombstoneLedgerUpdates(
    db,
    row,
    claim,
    nowIso,
    staleTombstoneIds,
    "external_block_id",
    row.external_block_id
  );

  // Owner clear only on the final attempt (mirror reservation moreRemaining path).
  if (!moreRemaining) {
    // Codex #10 (parallel race window for external_blocks): only clear
    // external_blocks.google_event_id when the stored value still matches what
    // this delete job thought it was deleting. See persistGoogleDeleteSuccess
    // for the full rationale; the predicate is identical and still keys off
    // row.google_event_id (claim-time D1 value), not the marker-resolved id.
    //
    // The orphan risk from predicate failure is now mitigated by the upsert
    // path's symmetric cleanup: isExternalBlockStillUpsertable pre-flight +
    // shouldDeleteExternalBlockEventAfterWrite + persistStaleExternalBlock-
    // GoogleEventCleanup (issue #121).
    statements.push(
      db
        .prepare(
          `
            UPDATE external_blocks
            SET google_event_id = NULL,
                google_event_etag = NULL,
                updated_at = ?
            WHERE id = ?
              AND (
                (? IS NULL AND google_event_id IS NULL)
                OR
                google_event_id = ?
              )
              AND EXISTS (${calendarSyncJobClaimExistsSql})
          `
        )
        .bind(
          nowIso,
          row.external_block_id,
          row.google_event_id,
          row.google_event_id,
          ...calendarSyncJobClaimBindings(row, claim)
        )
    );
  }

  statements.push(
    db
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
          )
          SELECT ?, 'system', 'calendar_sync', ?, 'external_block', ?, ?
          WHERE EXISTS (${calendarSyncJobClaimExistsSql})
        `
      )
      .bind(
        crypto.randomUUID(),
        // Request-keyed like the reservation path: no DELETE sent, no
        // "deleted" claim in the audit trail.
        mutationIssued
          ? "google_calendar_external_block_deleted"
          : "google_calendar_external_block_delete_skipped",
        row.external_block_id,
        JSON.stringify({
          calendar_id: row.calendar_id,
          google_event_id: deletedEventId,
          calendar_sync_job_id: row.job_id
        }),
        ...calendarSyncJobClaimBindings(row, claim)
      )
  );

  // Audit / ledger: use the id actually deleted (marker path may differ from
  // row.google_event_id). See persistGoogleDeleteSuccess.
  // moreRemaining is only set after a successful DELETE, so deletedEventId is non-null then.
  if (deletedEventId) {
    statements.push(
      db
        .prepare(
          `
            UPDATE google_calendar_events
            SET status = 'deleted',
                last_seen_at = ?,
                last_imported_at = ?
            WHERE calendar_id = ?
              AND google_event_id = ?
              AND external_block_id = ?
              AND EXISTS (${calendarSyncJobClaimExistsSql})
          `
        )
        .bind(nowIso, nowIso, row.calendar_id, deletedEventId, row.external_block_id, ...calendarSyncJobClaimBindings(row, claim)),
      deleteHistoryInsert(db, row, deletedEventId, nowIso, claim)
    );
  }

  // Mutations we sent only — see persistGoogleDeleteSuccess.
  if (deletedEventId && mutationIssued) {
    statements.push(
      db
        .prepare(
          `
            INSERT OR IGNORE INTO google_calendar_outbound_writes (
              id,
              calendar_sync_job_id,
              dedupe_key,
              calendar_id,
              google_event_id,
              owner_type,
              owner_id,
              action,
              expected_fingerprint,
              google_etag_after,
              expires_at
            )
            SELECT ?, ?, ?, ?, ?, 'external_block', ?, 'delete', ?, NULL, ?
            WHERE EXISTS (${calendarSyncJobClaimExistsSql})
          `
        )
        .bind(
          crypto.randomUUID(),
          row.job_id,
          // The delete fingerprint includes the id actually deleted, so each
          // duplicate reclaimed under moreRemaining gets its own row; INSERT OR
          // IGNORE only collapses a genuine retry of the same delete.
          `calendar_sync_job:${row.job_id}:delete:${payloadFingerprint}`,
          row.calendar_id,
          deletedEventId,
          row.external_block_id,
          payloadFingerprint,
          outboundExpiresAt,
          ...calendarSyncJobClaimBindings(row, claim)
        )
    );
  }

  return finalizeDeleteBatch(db, row, claim, nowMs, moreRemaining, statements);
};

type CalendarSyncJobOutcome = "succeeded" | "failed" | "skipped";

const markCalendarSyncJobFailed = async (
  db: D1Database,
  row: CalendarSyncJobRow,
  reason: string,
  claim: CalendarSyncJobClaim,
  nowMs: number
): Promise<CalendarSyncJobOutcome> => {
  if (
    isReservationSyncJob(row) &&
    row.google_action === "upsert" &&
    !(await isReservationStillUpsertable(db, row, toIso(nowMs)))
  ) {
    return markCalendarSyncJobSuperseded(db, row, "superseded_by_reservation_expiry", claim, nowMs);
  }
  // Issue #121: symmetric external_block check — if the block was cancelled
  // while the upsert was in flight and the Google write failed, supersede
  // instead of retrying a write for a cancelled block.
  if (
    isExternalBlockSyncJob(row) &&
    row.google_action === "upsert" &&
    !(await isExternalBlockStillUpsertable(db, row))
  ) {
    return markCalendarSyncJobSuperseded(db, row, "superseded_by_external_block_cancellation", claim, nowMs);
  }
  const changed = await markJobFailure(db, row, reason, claim, nowMs);
  // captureCalendarSyncJobDeadIfNeeded is the sole Sentry owner for calendar job
  // failures (cron AND workflow callers — the workflow captures nothing, see
  // reservation-confirm.ts). Its other caller is the moreRemaining ledger batch,
  // which reaches dead through the same buildJobFailureUpdate statement, so the
  // "once per job lifetime, on the attempt whose CAS write performed the dead
  // transition" rule still holds; retryable attempts are expected retry traffic.
  captureCalendarSyncJobDeadIfNeeded(changed, claim, row, reason);
  return changed ? "failed" : "skipped";
};

const persistDeleteSuccessForOwner = async (
  input: DeleteSuccessPersistInput & { row: CalendarSyncJobRow }
): Promise<CalendarSyncJobOutcome> => {
  const { db, row, claim, nowMs } = input;
  if (isReservationSyncJob(row)) {
    return persistGoogleDeleteSuccess({ ...input, row });
  }
  if (isExternalBlockSyncJob(row)) {
    return persistExternalBlockGoogleDeleteSuccess({ ...input, row });
  }
  return markCalendarSyncJobFailed(db, row, "invalid-calendar-sync-owner", claim, nowMs);
};

const buildDeletePayloadFingerprint = async (
  row: CalendarSyncJobRow,
  googleEventId: string | null
) => {
  return sha256Hex(
    JSON.stringify({
      action: "delete",
      owner_type: row.owner_type,
      owner_id: row.owner_id,
      store_id: row.store_id,
      google_event_id: googleEventId
    })
  );
};

const resolveCalendarAccessToken = async (input: {
  env: CalendarSyncEnv;
  fetcher: typeof fetch;
  accessTokenProvider?: () => Promise<string | undefined>;
  now: () => number;
}) => {
  return input.accessTokenProvider
    ? input.accessTokenProvider()
    : defaultGoogleCalendarAccessTokenProvider(input.env, input.fetcher, input.now);
};

const mapSyncErrorToClass = (reason: string): GoogleErrorClass => {
  if (reason.includes("401") || reason.includes("403")) {
    return "google_auth_failure";
  }
  if (reason.includes("429")) {
    return "google_quota_exceeded";
  }
  if (reason.startsWith("google-http-5")) {
    return "google_api_unavailable";
  }
  return "unexpected";
};

const processGoogleDeleteJob = async (input: {
  db: D1Database;
  row: CalendarSyncJobRow;
  claim: CalendarSyncJobClaim;
  accessToken: string;
  fetcher: typeof fetch;
  now: () => number;
}): Promise<CalendarSyncJobOutcome> => {
  // Fail-closed on lookup failure: the staff cancel is already committed
  // locally, so retry until the marker search can prove presence or absence.
  const googleDelete = await deleteGoogleEvent(input.row, input.accessToken, input.fetcher);
  // Re-read the clock like processGoogleWriteJob does: the marker lookup plus
  // the DELETE can burn ~40s, and a stale timestamp back-dates audit rows and
  // shortens the retry backoff computed from it.
  const afterDeleteMs = input.now();
  if (!googleDelete.ok) {
    logGoogleEvent({
      event_type: "outbound_write_failure",
      outcome: "failure",
      calendar_id: input.row.calendar_id,
      store_id: input.row.store_id,
      error_class: mapSyncErrorToClass(googleDelete.reason)
    });
    return markCalendarSyncJobFailed(input.db, input.row, googleDelete.reason, input.claim, afterDeleteMs);
  }

  // The success log counts outbound DELETE requests, so the two paths that
  // issue none log nothing: proven absence (markers matched nothing) and an
  // already-present tombstone (#589-1). Both still persist the ledger below —
  // only the request counter is gated. A 404/410 answer does log: the request
  // was made, it just found the event already gone. When moreRemaining, we
  // still log success for the one DELETE that advanced (I1), then persist
  // ledger + mark retryable (or dead if prior failures + remaining duplicates
  // exhaust MAX_ATTEMPTS=5; requeue via sync-recovery, issue #589).
  if (googleDelete.mutationIssued) {
    logGoogleEvent({
      event_type: "outbound_write_success",
      outcome: "success",
      calendar_id: input.row.calendar_id,
      store_id: input.row.store_id
    });
  }

  // Fingerprint from the id actually deleted so marker-resolved ids enter the
  // dedupe key.
  const payloadFingerprint = await buildDeletePayloadFingerprint(
    input.row,
    googleDelete.deletedEventId
  );

  // moreRemaining: write ledger for this DELETE in the same batch as the
  // retryable/dead job flip (DUPLICATE_MARKERS_REMAINING_REASON). Do not skip
  // persist — that lost successful deletes from audit/history/events.
  return persistDeleteSuccessForOwner({
    db: input.db,
    row: input.row,
    deletedEventId: googleDelete.deletedEventId,
    payloadFingerprint,
    claim: input.claim,
    nowMs: afterDeleteMs,
    moreRemaining: googleDelete.moreRemaining,
    staleTombstoneIds: googleDelete.staleTombstoneIds,
    mutationIssued: googleDelete.mutationIssued
  });
};

const processGoogleWriteJob = async (input: {
  db: D1Database;
  row: ReservationCalendarSyncJobRow | ExternalBlockCalendarSyncJobRow;
  claim: CalendarSyncJobClaim;
  accessToken: string;
  fetcher: typeof fetch;
  now: () => number;
  nowMs: number;
}): Promise<CalendarSyncJobOutcome> => {
  const beforeWriteMs = input.now();

  // Pre-write eligibility: reservation side
  if (
    isReservationSyncJob(input.row) &&
    !(await isReservationStillUpsertable(input.db, input.row, toIso(beforeWriteMs)))
  ) {
    logGoogleEvent({
      event_type: "outbound_write_superseded",
      outcome: "failure",
      calendar_id: input.row.calendar_id,
      store_id: input.row.store_id,
      error_class: "fingerprint_mismatch"
    });
    return markCalendarSyncJobSuperseded(
      input.db,
      input.row,
      "superseded_by_reservation_expiry",
      input.claim,
      beforeWriteMs
    );
  }

  // Pre-write eligibility: external_block side (issue #121 — symmetric)
  if (
    isExternalBlockSyncJob(input.row) &&
    !(await isExternalBlockStillUpsertable(input.db, input.row))
  ) {
    logGoogleEvent({
      event_type: "outbound_write_superseded",
      outcome: "failure",
      calendar_id: input.row.calendar_id,
      store_id: input.row.store_id,
      error_class: "fingerprint_mismatch"
    });
    return markCalendarSyncJobSuperseded(
      input.db,
      input.row,
      "superseded_by_external_block_cancellation",
      input.claim,
      beforeWriteMs
    );
  }

  const payload = isReservationSyncJob(input.row)
    ? buildReservationCalendarEvent(input.row)
    : buildExternalBlockCalendarEvent(input.row);
  const payloadFingerprint = await sha256Hex(JSON.stringify(payload));
  const googleWrite = await writeGoogleEvent(input.row, payload, input.accessToken, input.fetcher);
  const afterWriteMs = input.now();
  if (!googleWrite.ok) {
    logGoogleEvent({
      event_type: "outbound_write_failure",
      outcome: "failure",
      calendar_id: input.row.calendar_id,
      store_id: input.row.store_id,
      error_class: mapSyncErrorToClass(googleWrite.reason)
    });
    return markCalendarSyncJobFailed(input.db, input.row, googleWrite.reason, input.claim, afterWriteMs);
  }

  logGoogleEvent({
    event_type: "outbound_write_success",
    outcome: "success",
    calendar_id: input.row.calendar_id,
    store_id: input.row.store_id
  });

  // Post-write persistence + stale cleanup: reservation side
  if (isReservationSyncJob(input.row)) {
    let outcome = await persistGoogleEventSuccess(input.db, input.row, googleWrite.event, payloadFingerprint, input.claim, afterWriteMs);
    if (await shouldDeleteReservationEventAfterWrite(input.db, input.row, toIso(afterWriteMs))) {
      outcome = await persistStaleReservationGoogleEventCleanup(
        input.db,
        input.row,
        googleWrite.event,
        payloadFingerprint,
        input.claim,
        afterWriteMs
      );
    }
    return outcome;
  }

  // Post-write persistence + stale cleanup: external_block side (issue #121)
  let outcome = await persistExternalBlockGoogleEventSuccess(input.db, input.row, googleWrite.event, payloadFingerprint, input.claim, afterWriteMs);
  if (await shouldDeleteExternalBlockEventAfterWrite(input.db, input.row)) {
    outcome = await persistStaleExternalBlockGoogleEventCleanup(
      input.db,
      input.row,
      googleWrite.event,
      payloadFingerprint,
      input.claim,
      afterWriteMs
    );
  }
  return outcome;
};

const processCalendarSyncJob = async (input: {
  db: D1Database;
  env: CalendarSyncEnv;
  row: CalendarSyncJobRow;
  claim: CalendarSyncJobClaim;
  fetcher: typeof fetch;
  accessTokenProvider?: () => Promise<string | undefined>;
  now: () => number;
  nowMs: number;
}): Promise<CalendarSyncJobOutcome> => {
  // Delete always needs a token: even when D1 has no google_event_id we may
  // still own an orphan on Google and must look it up by owner markers (#563).
  const accessToken = await resolveCalendarAccessToken(input);
  if (!accessToken) {
    return markCalendarSyncJobFailed(input.db, input.row, "google-token-failed", input.claim, input.nowMs);
  }

  if (input.row.google_action === "delete") {
    return processGoogleDeleteJob({
      db: input.db,
      row: input.row,
      claim: input.claim,
      accessToken,
      fetcher: input.fetcher,
      now: input.now
    });
  }

  if (!isReservationSyncJob(input.row) && !isExternalBlockSyncJob(input.row)) {
    return markCalendarSyncJobFailed(input.db, input.row, "invalid-calendar-sync-owner", input.claim, input.nowMs);
  }

  return processGoogleWriteJob({
    db: input.db,
    row: input.row,
    claim: input.claim,
    accessToken,
    fetcher: input.fetcher,
    now: input.now,
    nowMs: input.nowMs
  });
};

export async function processDueCalendarSyncJobs(input: {
  db: D1Database;
  env: CalendarSyncEnv;
  fetcher?: typeof fetch;
  accessTokenProvider?: () => Promise<string | undefined>;
  now?: () => number;
  maxJobs?: number;
  jobIdsFilter?: string[];
}): Promise<CalendarSyncResult> {
  if (input.jobIdsFilter?.length === 0) {
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  const fetcher = input.fetcher ?? withOutboundTimeout(fetch.bind(globalThis));
  const now = input.now ?? Date.now;
  const maxJobs = input.maxJobs ?? 5;
  const result: CalendarSyncResult = {
    processed: 0,
    succeeded: 0,
    failed: 0
  };

  // Sweep dead-letter candidates once per batch; subsequent iterations don't
  // add new MAX_ATTEMPTS hits because the claim path enforces attempts < cap.
  await markStaleCalendarSyncClaimsExhausted(input.db, now());

  // Reserve at least two slots per run for regular sync jobs: the backfill quota
  // shrinks before regular capacity does when the caller passes a small maxJobs
  // (queue kicks pass batch sizes as low as 1). Backfill jobs are only enqueued by
  // the wrangler script (no queue kick), so they drain via the cron's maxJobs=5
  // runs — a zero quota here never strands them.
  const bulkBackfillQuota = Math.min(
    MAX_BULK_BACKFILL_JOBS_PER_RUN,
    Math.max(0, maxJobs - 2)
  );
  let bulkBackfillClaimed = 0;
  for (let index = 0; index < maxJobs; index += 1) {
    const nowMs = now();
    // Once the per-run backfill quota is spent, exclude backfill jobs from the
    // claim query so regular sync jobs behind them still get the remaining slots.
    const row = await fetchNextCalendarSyncJob(
      input.db,
      toIso(nowMs),
      input.jobIdsFilter,
      bulkBackfillClaimed >= bulkBackfillQuota
    );
    if (!row) {
      break;
    }

    const claim = await markJobProcessing(input.db, row, nowMs);
    if (!claim) {
      continue;
    }

    if (row.dedupe_key.includes(BULK_BACKFILL_DEDUPE_MARKER)) {
      bulkBackfillClaimed += 1;
    }
    result.processed += 1;
    const outcome = await processCalendarSyncJob({
      db: input.db,
      env: input.env,
      row,
      claim,
      fetcher,
      accessTokenProvider: input.accessTokenProvider,
      now,
      nowMs
    });
    if (outcome !== "skipped") {
      result[outcome] += 1;
    }
  }

  return result;
}
