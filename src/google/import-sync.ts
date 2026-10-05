import { defaultGoogleCalendarAccessTokenProvider } from "./service-account";
import { fetchStoreCalendars } from "./store-calendars";
import { calculateGoogleRetryDelayMs } from "./retry-backoff";
import { logGoogleEvent } from "../logging";
import type { GoogleErrorClass } from "../logging";
import { parseDateJstToUtcIso } from "../date-parse";
import { safeCaptureException } from "../sentry-helpers";
import { isTransientAbortError, isTransientD1Error, withOutboundTimeout } from "../outbound-timeout";
import { generateSlotTimesForRange } from "../reservations/slot-times";
import { CUSTOMER_TIME_LOCK_PHONE_HASH_SQL } from "../reservations/transitions";
import { WEEKDAY_MAP } from "../time-utils";
import { mapConcurrent } from "../concurrency";
import {
  MAX_DEDUPE_KEY_LENGTH as _MAX_DEDUPE_KEY_LENGTH,
  stableHash as _stableHash,
  compactDedupeKey as _compactDedupeKey
} from "./dedupe-key";
import {
  evaluateDriftThreshold,
  DRIFT_ALERT_THRESHOLD as _DRIFT_ALERT_THRESHOLD,
  type DriftAlertEnqueueResult
} from "./drift-threshold-alert";

import type { WorkerBindings } from "../bindings";

export type GoogleCalendarImportResult = {
  processed: number;
  succeeded: number;
  failed: number;
  fullSyncQueued: number;
  // Jobs parked via the cooperative soft deadline this batch (attempt-free,
  // resumable). Counted in `processed` but in neither succeeded nor failed.
  yielded: number;
};

export type GoogleCalendarMaintenanceResult = {
  checked: number;
  cronIncrementalQueued: number;
  fullReconcileQueued: number;
};

type GoogleCalendarImportEnv = Pick<
  WorkerBindings,
  | "GOOGLE_SERVICE_ACCOUNT_EMAIL"
  | "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY"
  | "LINE_OPERATIONS_USER_IDS"
  | "GOOGLE_DRIFT_ALERT_LIVE"
>;

type ImportJobRow = {
  job_id: string;
  store_id: string;
  calendar_id: string;
  reason: "push" | "cron_incremental" | "full_reconcile" | "manual";
  attempt_count: number;
  // full_reconcile resume checkpoint (NULL/0 = start from the first page).
  // Persisted per completed page so a retried/yielded attempt continues the
  // walk instead of re-processing the whole calendar from page 1.
  resume_page_token: string | null;
  resume_processed_count: number;
  resume_sweep_start_seconds: number | null;
  resume_time_min: string | null;
  resume_yield_count: number;
};

type ImportJobClaim = {
  lockedUntil: string;
  attemptCount: number;
};

type GoogleCalendarChannelRow = {
  id: string;
  sync_token: string | null;
};

type StoreResourceRow = {
  id: string;
};

type GoogleEventDate = {
  date?: unknown;
  dateTime?: unknown;
};

type GoogleEvent = {
  id?: unknown;
  etag?: unknown;
  status?: unknown;
  summary?: unknown;
  updated?: unknown;
  transparency?: unknown;
  start?: GoogleEventDate;
  end?: GoogleEventDate;
  recurrence?: unknown;
  recurringEventId?: unknown;
  extendedProperties?: {
    private?: Record<string, unknown>;
  };
};

type GoogleEventsListResponse = {
  items?: unknown;
  nextPageToken?: unknown;
  nextSyncToken?: unknown;
};

type ExternalBlockRow = {
  id: string;
  source: "google_calendar" | "admin_block" | "system_revert";
};

type ReservationMarkerRow = {
  id: string;
};

type ReservationForGoogleMoveRow = {
  id: string;
  store_id: string;
  customer_id: string;
  resource_id: string;
  line_identity_id: string | null;
  status: string;
  start_at: string;
  end_at: string;
  duration_minutes: number;
  pending_expires_at: string | null;
  version: number;
  timezone: string;
  checked_in_at: string | null;
};

type SafeGoogleSnapshot = {
  google_event_id: string;
  status: string;
  start_at: string | null;
  end_at: string | null;
  transparency: "opaque" | "transparent";
  all_day: boolean;
  recurring: boolean;
  /** Raw YYYY-MM-DD from Google `start.date` (all-day events only) */
  start_date?: string;
  /** Raw YYYY-MM-DD from Google `end.date` (all-day events only; exclusive) */
  end_date?: string;
};

type EventsListPage =
  | {
      ok: true;
      items: GoogleEvent[];
      nextPageToken: string | null;
      nextSyncToken: string | null;
    }
  | {
      ok: false;
      reason: string;
      syncTokenExpired: boolean;
      // True when a syncToken-LESS walk failed because its pageToken was
      // rejected (400/410). Kept separate from syncTokenExpired on purpose:
      // routing this through the sync-token path would wrongly NULL the
      // channel sync_token and enqueue a recovery full_reconcile. The right
      // response is to clear the resume checkpoint and burn the attempt.
      pageTokenInvalid?: boolean;
    };

type ImportJobRunResult =
  | {
      ok: true;
      fullSyncQueued: boolean;
      nextSyncToken: string | null;
      processedEventCount?: number;
    }
  | {
      ok: false;
      reason: string;
      fullSyncQueued: false;
      // True when the job was parked via markJobYielded (checkpoint saved,
      // attempt NOT consumed). The processDue loop must break on this — the
      // job is immediately due again, and re-claiming it in the same
      // invocation would eat the post-deadline slack and hit the 270s axe.
      yielded?: true;
    };

const GOOGLE_CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";
export const LOCK_TTL_MS = 5 * 60 * 1000;
const FULL_RECONCILE_DELAY_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const SLOT_INTERVAL_MINUTES = 5;
const MAX_EVENTS_LIST_PAGES = 10;
// Page size for the RESUMABLE full_reconcile walk. Deliberately small: the
// resume checkpoint and the cooperative soft deadline below both operate at
// PAGE granularity, so a single page must always fit comfortably inside one
// claim budget. At Google's 2500 max, an 826-event calendar is ONE page and
// neither mechanism can ever engage.
const FULL_WALK_PAGE_SIZE = 150;
// Page size for NON-resumable syncToken-less walks (initial sync of a fresh
// channel via push/cron_incremental/manual). These cannot checkpoint across
// the MAX_EVENTS_LIST_PAGES cap, so the small reconcile page size would
// shrink their reachable calendar size from 25 000 to 1 500 events; keep
// Google's maximum here.
const INITIAL_WALK_PAGE_SIZE = 2500;
// Cooperative deadline for full_reconcile: once an attempt has spent this much
// wall time, it checkpoints and yields instead of running into the 270s
// CLAIM_TASK_TIMEOUT_MS axe (which kills the whole import task and starves the
// queue). The ~70s gap is slack for the in-flight page + checkpoint write.
export const IMPORT_SOFT_DEADLINE_MS = 200 * 1000;
// Hard cap on attempt-free yields per job. The progress guard (a yield needs
// ≥1 page completed) bounds yields by page count, but a pathological calendar
// with endless pagination would otherwise never consume attempts and could
// bypass the MAX_ATTEMPTS dead-letter guarantee.
const MAX_RECONCILE_YIELDS = 30;
// D1 caps bound parameters at 100 per statement
// (developers.cloudflare.com/d1/platform/limits/), so slot probes batch their
// IN (...) lists in chunks of 80, leaving headroom for each query's fixed binds.
const SLOT_QUERY_CHUNK_SIZE = 80;

// Quiet UTC window for the SCHEDULED daily full_reconcile. It is heavy
// (paginated events.list walk + drift + orphan sweep), and when it became due
// at 00:00 UTC (= 09:00 JST) it landed on the busiest */10 tick and was the
// chronic cron-hang amplifier. Scheduling its next_run_at into a quiet UTC
// window lets the EXISTING */10 processor claim it off-spike — no new cron, no
// added concurrency. The window STARTS at 16:20 UTC (= 01:20 JST), AFTER the
// daily-cleanup cron's window (5 16 * * *, budget ≤10 min ⇒ done by ~16:15) so
// the heavy reconcile and the heavy prune/retention DELETEs never share a D1
// window. Each calendar is STAGGERED to a deterministic minute within
// [16:20, 17:00) by a hash of its id, so multiple stores' daily reconciles do
// NOT all become due on the same */10 tick — that would force one tick's import
// task to process several heavy full_reconciles past its budget. (The 410
// sync-token-expired RECOVERY full_reconcile in queueFullReconcile keeps its
// prompt FULL_RECONCILE_DELAY_MS; it has a different dedupe key and must repair
// a broken sync quickly.)
const FULL_RECONCILE_QUIET_HOUR_UTC = 16;
const FULL_RECONCILE_QUIET_MINUTE_UTC = 20;
const FULL_RECONCILE_QUIET_SPREAD_MINUTES = 40; // window = [16:20, 17:00) UTC
const DRIFT_ALERT_THRESHOLD = _DRIFT_ALERT_THRESHOLD;

// Orphan sweep cutoff: a row last seen >ORPHAN_GRACE_SECONDS ago is treated
// as deleted from Google's perspective (the row fell out of the events.list
// 90-day window). 60 minutes is wide enough that an in-flight push-import
// path with a stale last_seen_at value will either complete (writing a
// current timestamp) or fail before the orphan sweep evaluates its WHERE.
const ORPHAN_GRACE_SECONDS = 60 * 60;
const DRIFT_SWEEP_SLACK_SECONDS = 5;
const MAX_EXTERNAL_BLOCK_MINUTES = 24 * 60;
const MAX_EXTERNAL_BLOCK_SLOTS = MAX_EXTERNAL_BLOCK_MINUTES / SLOT_INTERVAL_MINUTES;
const toIso = (ms: number) => new Date(ms).toISOString();

// Deterministic, stable hash of a calendar id → an integer in [0, mod). Used
// only to spread daily reconcile due-times across the quiet window; it is not
// security-sensitive (djb2 is fine and synchronous, unlike crypto.subtle).
const stableHashMod = (value: string, mod: number): number => {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    // codePointAt === charCodeAt for every BMP unit (calendar ids are ASCII),
    // so the hash — and the resulting per-calendar stagger — is unchanged; this
    // just uses the Unicode-correct accessor SonarCloud prefers (S7758).
    hash = ((hash << 5) + hash + (value.codePointAt(i) ?? 0)) >>> 0;
  }
  return hash % mod;
};

// Compute the next_run_at ISO for the scheduled daily full_reconcile: today's
// quiet UTC window (staggered per calendar within [16:20, 17:00)) if it is
// still ahead of `nowMs`, otherwise `nowMs` (do not push a whole day forward —
// being due now still keeps it off the 09:00 window because we are already past
// the window). See FULL_RECONCILE_QUIET_HOUR_UTC.
const quietWindowNextRunAtIso = (nowMs: number, calendarId: string): string => {
  const d = new Date(nowMs);
  const minuteOffset = stableHashMod(calendarId, FULL_RECONCILE_QUIET_SPREAD_MINUTES);
  const quietMs = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    FULL_RECONCILE_QUIET_HOUR_UTC,
    FULL_RECONCILE_QUIET_MINUTE_UTC + minuteOffset,
    0,
    0
  );
  return toIso(Math.max(quietMs, nowMs));
};

const createEmptyResult = (): GoogleCalendarImportResult => ({
  processed: 0,
  succeeded: 0,
  failed: 0,
  fullSyncQueued: 0,
  yielded: 0
});

const createEmptyMaintenanceResult = (): GoogleCalendarMaintenanceResult => ({
  checked: 0,
  cronIncrementalQueued: 0,
  fullReconcileQueued: 0
});

const isNonEmptyString = (value: unknown, maxLength: number): value is string => {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
};

type GoogleEventLike = { id?: unknown };

const isValidGoogleEventId = (event: GoogleEventLike): boolean =>
  isNonEmptyString(event.id, 1024);

export type GoogleDriftCounts = {
  googleSweepCount: number;
  d1SweepCount: number;
  drift: number;
};

/** @internal exported for unit tests only */
export const captureSweepStartSeconds = async (db: D1Database): Promise<number> => {
  const row = await db
    .prepare(`SELECT CAST(strftime('%s', 'now') AS INTEGER) AS now`)
    .first<{ now: number }>();
  return Number(row?.now ?? Math.floor(Date.now() / 1000));
};

/** @internal exported for unit tests only */
export const computeCalendarDrift = async (input: {
  db: D1Database;
  storeId: string;
  calendarId: string;
  googleSweepCount: number;
  sweepStartSeconds: number;
}): Promise<GoogleDriftCounts> => {
  const thresholdSeconds = input.sweepStartSeconds - DRIFT_SWEEP_SLACK_SECONDS;
  const row = await input.db
    .prepare(
      `SELECT COUNT(*) AS c FROM google_calendar_events
       WHERE store_id = ?
         AND calendar_id = ?
         AND last_seen_at >= datetime(?, 'unixepoch')`
    )
    .bind(input.storeId, input.calendarId, thresholdSeconds)
    .first<{ c: number }>();
  const d1SweepCount = Number(row?.c ?? 0);
  const drift = Math.abs(input.googleSweepCount - d1SweepCount);
  return { googleSweepCount: input.googleSweepCount, d1SweepCount, drift };
};

export type DriftDeps = {
  computeDrift?: typeof computeCalendarDrift;
  captureSweepStart?: typeof captureSweepStartSeconds;
};

// Re-export from shared module; local aliases for backward compat + __testing__
const MAX_DEDUPE_KEY_LENGTH = _MAX_DEDUPE_KEY_LENGTH;
const stableHash = _stableHash;
const compactDedupeKey = _compactDedupeKey;

const hasChangedRows = (result: D1Result) => {
  return Number(result.meta?.changes ?? 0) > 0;
};

const importJobClaimExistsSql = `
  SELECT 1
  FROM google_calendar_import_jobs
  WHERE id = ?
    AND status = 'processing'
    AND locked_until = ?
    AND attempt_count = ?
`;

const importJobClaimBindings = (job: ImportJobRow, claim: ImportJobClaim): BoundValue[] => [
  job.job_id,
  claim.lockedUntil,
  claim.attemptCount
];

const importJobClaimExists = async (db: D1Database, job: ImportJobRow, claim: ImportJobClaim) => {
  const row = await db
    .prepare(`${importJobClaimExistsSql} LIMIT 1`)
    .bind(...importJobClaimBindings(job, claim))
    .first<{ 1: number }>();
  return Boolean(row);
};

const fetchNextImportJob = async (db: D1Database, nowIso: string) => {
  return db
    .prepare(
      `
        SELECT
          id AS job_id,
          store_id,
          calendar_id,
          reason,
          attempt_count,
          resume_page_token,
          resume_processed_count,
          resume_sweep_start_seconds,
          resume_time_min,
          resume_yield_count
        FROM google_calendar_import_jobs
        WHERE (
          (status IN ('queued', 'retryable') AND next_run_at <= ?)
          OR
          (status = 'processing' AND locked_until < ? AND attempt_count < ?)
        )
        ORDER BY
          CASE WHEN reason = 'full_reconcile' THEN 1 ELSE 0 END ASC,
          next_run_at ASC,
          created_at ASC
        LIMIT 1
      `
    )
    .bind(nowIso, nowIso, MAX_ATTEMPTS)
    .first<ImportJobRow>();
};

const insertImportJob = (input: {
  db: D1Database;
  storeId: string;
  calendarId: string;
  reason: "cron_incremental" | "full_reconcile";
  dedupeKey: string;
  nowIso: string;
  // Optional override for when the job first becomes due. Defaults to nowIso
  // (immediately due). Used to schedule the heavy daily full_reconcile into a
  // quiet window instead of the 09:00 JST */10 spike (see
  // quietWindowNextRunAtIso). updated_at always stays nowIso.
  nextRunAtIso?: string;
}) => {
  return input.db
    .prepare(
      `
        INSERT OR IGNORE INTO google_calendar_import_jobs (
          id,
          store_id,
          calendar_id,
          reason,
          status,
          next_run_at,
          dedupe_key,
          updated_at
        ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)
      `
    )
    .bind(
      crypto.randomUUID(),
      input.storeId,
      input.calendarId,
      input.reason,
      input.nextRunAtIso ?? input.nowIso,
      input.dedupeKey,
      input.nowIso
    );
};

const fetchLatestChannel = async (db: D1Database, job: ImportJobRow) => {
  return db
    .prepare(
      `
        SELECT id, sync_token
        FROM google_calendar_channels
        WHERE store_id = ?
          AND calendar_id = ?
          AND status IN ('active', 'renewing')
        ORDER BY
          CASE WHEN last_incremental_sync_at IS NULL THEN 1 ELSE 0 END ASC,
          last_incremental_sync_at DESC,
          created_at DESC
        LIMIT 1
      `
    )
    .bind(job.store_id, job.calendar_id)
    .first<GoogleCalendarChannelRow>();
};

const fetchStoreResource = async (db: D1Database, storeId: string) => {
  return db
    .prepare(
      `
        SELECT id
        FROM store_resources
        WHERE store_id = ?
          AND resource_type = 'staff_calendar'
          AND active = 1
        ORDER BY id ASC
        LIMIT 1
      `
    )
    .bind(storeId)
    .first<StoreResourceRow>();
};

// Dead-letter any stale `processing` rows whose attempt counter already reached
// the retry cap (codex #9 follow-up). Without this sweep, repeated worker crashes
// after markJobProcessing but before markJobFailure could bypass MAX_ATTEMPTS.
const markStaleImportClaimsExhausted = async (db: D1Database, nowMs: number) => {
  const nowIso = toIso(nowMs);
  await db
    .prepare(
      `
        UPDATE google_calendar_import_jobs
        SET status = 'dead',
            locked_until = NULL,
            last_error = 'exhausted_after_repeated_crash',
            resume_page_token = NULL,
            resume_processed_count = 0,
            resume_sweep_start_seconds = NULL,
            resume_time_min = NULL,
            resume_yield_count = 0,
            updated_at = ?
        WHERE status = 'processing'
          AND locked_until < ?
          AND attempt_count >= ?
      `
    )
    .bind(nowIso, nowIso, MAX_ATTEMPTS)
    .run();
};

const markJobProcessing = async (db: D1Database, row: ImportJobRow, nowMs: number) => {
  const nowIso = toIso(nowMs);
  const lockedUntil = toIso(nowMs + LOCK_TTL_MS);
  const result = await db
    .prepare(
      `
        UPDATE google_calendar_import_jobs
        SET status = 'processing',
            attempt_count = attempt_count + 1,
            locked_until = ?,
            updated_at = ?
        WHERE id = ?
          AND (
            (status IN ('queued', 'retryable') AND next_run_at <= ?)
            OR
            (status = 'processing' AND locked_until < ? AND attempt_count < ?)
          )
      `
    )
    .bind(lockedUntil, nowIso, row.job_id, nowIso, nowIso, MAX_ATTEMPTS)
    .run();
  if (!hasChangedRows(result)) {
    return undefined;
  }
  return {
    lockedUntil,
    attemptCount: row.attempt_count + 1
  };
};

const markJobSuccess = async (
  db: D1Database,
  row: ImportJobRow,
  claim: ImportJobClaim,
  nowMs: number
) => {
  const result = await db
    .prepare(
      `
        UPDATE google_calendar_import_jobs
        SET status = 'succeeded',
            locked_until = NULL,
            last_error = NULL,
            resume_page_token = NULL,
            resume_processed_count = 0,
            resume_sweep_start_seconds = NULL,
            resume_time_min = NULL,
            resume_yield_count = 0,
            updated_at = ?
        WHERE id = ?
          AND status = 'processing'
          AND locked_until = ?
          AND attempt_count = ?
      `
    )
    .bind(toIso(nowMs), row.job_id, claim.lockedUntil, claim.attemptCount)
    .run();
  return hasChangedRows(result);
};

const markJobFailure = async (
  db: D1Database,
  row: ImportJobRow,
  claim: ImportJobClaim,
  reason: string,
  nowMs: number
) => {
  const nextAttempts = row.attempt_count + 1;
  const status = nextAttempts >= MAX_ATTEMPTS ? "dead" : "retryable";
  const retryDelayMs = calculateGoogleRetryDelayMs(nextAttempts, row.job_id);
  const nextRunAt = status === "dead" ? toIso(nowMs) : toIso(nowMs + retryDelayMs);
  // The resume checkpoint belongs to ONE walk. A retryable failure keeps it
  // (completed pages are committed work the retry continues after), but a
  // dead-letter ends the walk — wipe it so any later resurrection of this row
  // (queueFullReconcile / admin retry) starts a genuinely fresh walk.
  const clearResume = status === "dead" ? 1 : 0;

  const result = await db
    .prepare(
      `
        UPDATE google_calendar_import_jobs
        SET status = ?,
            attempt_count = ?,
            next_run_at = ?,
            locked_until = NULL,
            last_error = ?,
            resume_page_token = CASE WHEN ? = 1 THEN NULL ELSE resume_page_token END,
            resume_processed_count = CASE WHEN ? = 1 THEN 0 ELSE resume_processed_count END,
            resume_sweep_start_seconds = CASE WHEN ? = 1 THEN NULL ELSE resume_sweep_start_seconds END,
            resume_time_min = CASE WHEN ? = 1 THEN NULL ELSE resume_time_min END,
            resume_yield_count = CASE WHEN ? = 1 THEN 0 ELSE resume_yield_count END,
            updated_at = ?
        WHERE id = ?
          AND status = 'processing'
          AND locked_until = ?
          AND attempt_count = ?
      `
    )
    .bind(
      status,
      nextAttempts,
      nextRunAt,
      reason,
      clearResume,
      clearResume,
      clearResume,
      clearResume,
      clearResume,
      toIso(nowMs),
      row.job_id,
      claim.lockedUntil,
      claim.attemptCount
    )
    .run();
  return hasChangedRows(result);
};

// Persist the full_reconcile resume checkpoint after a completed page.
// Claim-gated with the same WHERE shape as markJobSuccess so a checkpoint can
// never be written by an attempt whose claim was already lost. A failure later
// in the same attempt intentionally KEEPS the checkpoint: completed pages are
// committed work, and the next attempt resumes after them.
const persistImportResumeCheckpoint = async (input: {
  db: D1Database;
  row: ImportJobRow;
  claim: ImportJobClaim;
  pageToken: string;
  processedCount: number;
  sweepStartSeconds: number | null;
  timeMinIso: string | null;
  nowMs: number;
}) => {
  const result = await input.db
    .prepare(
      `
        UPDATE google_calendar_import_jobs
        SET resume_page_token = ?,
            resume_processed_count = ?,
            resume_sweep_start_seconds = ?,
            resume_time_min = ?,
            updated_at = ?
        WHERE id = ?
          AND status = 'processing'
          AND locked_until = ?
          AND attempt_count = ?
      `
    )
    .bind(
      input.pageToken,
      input.processedCount,
      input.sweepStartSeconds,
      input.timeMinIso,
      toIso(input.nowMs),
      input.row.job_id,
      input.claim.lockedUntil,
      input.claim.attemptCount
    )
    .run();
  return hasChangedRows(result);
};

// Drop the checkpoint when Google rejects the resume pageToken (400/410): the
// token chain is dead, so the next attempt must restart from page 1 with a
// freshly computed timeMin window. resume_yield_count resets too — the yield
// budget belongs to the walk being abandoned, and a fresh walk must not
// inherit a nearly-exhausted budget.
const clearImportResumeCheckpoint = async (
  db: D1Database,
  row: ImportJobRow,
  claim: ImportJobClaim,
  nowMs: number
) => {
  await db
    .prepare(
      `
        UPDATE google_calendar_import_jobs
        SET resume_page_token = NULL,
            resume_processed_count = 0,
            resume_sweep_start_seconds = NULL,
            resume_time_min = NULL,
            resume_yield_count = 0,
            updated_at = ?
        WHERE id = ?
          AND status = 'processing'
          AND locked_until = ?
          AND attempt_count = ?
      `
    )
    .bind(toIso(nowMs), row.job_id, claim.lockedUntil, claim.attemptCount)
    .run();
};

// Park a full_reconcile attempt that hit IMPORT_SOFT_DEADLINE_MS: requeue it
// immediately due WITHOUT consuming the attempt (the claim's pre-increment is
// reversed in SQL). Callers enforce the progress guard (≥1 page completed this
// attempt) and the MAX_RECONCILE_YIELDS budget before reaching this, so a
// non-advancing job cannot ride free yields past the MAX_ATTEMPTS guarantee.
const markJobYielded = async (
  db: D1Database,
  row: ImportJobRow,
  claim: ImportJobClaim,
  nowMs: number
) => {
  const result = await db
    .prepare(
      `
        UPDATE google_calendar_import_jobs
        SET status = 'retryable',
            attempt_count = attempt_count - 1,
            locked_until = NULL,
            next_run_at = ?,
            resume_yield_count = resume_yield_count + 1,
            updated_at = ?
        WHERE id = ?
          AND status = 'processing'
          AND locked_until = ?
          AND attempt_count = ?
      `
    )
    .bind(toIso(nowMs), toIso(nowMs), row.job_id, claim.lockedUntil, claim.attemptCount)
    .run();
  return hasChangedRows(result);
};

// Window start for a syncToken-less walk. Computed ONCE at walk start and then
// pinned (persisted in the resume checkpoint): Google pagination requires every
// pageToken request to repeat the exact query parameters of the first page, so
// recomputing timeMin from a later attempt's clock would invalidate the token.
const fullWalkTimeMinIso = (nowMs: number) => toIso(nowMs - 30 * 24 * 60 * 60 * 1000);

const buildEventsListUrl = (input: {
  calendarId: string;
  syncToken: string | null;
  pageToken: string | null;
  timeMinIso: string | null;
  // Page size for syncToken-less walks: FULL_WALK_PAGE_SIZE for the resumable
  // full_reconcile, INITIAL_WALK_PAGE_SIZE for non-resumable initial syncs.
  pageSize: number | null;
}) => {
  const url = new URL(`${GOOGLE_CALENDAR_API_BASE}/calendars/${encodeURIComponent(input.calendarId)}/events`);
  if (input.syncToken) {
    url.searchParams.set("syncToken", input.syncToken);
  } else {
    url.searchParams.set("showDeleted", "true");
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("maxResults", String(input.pageSize ?? INITIAL_WALK_PAGE_SIZE));
    if (input.timeMinIso) {
      url.searchParams.set("timeMin", input.timeMinIso);
    }
  }
  if (input.pageToken) {
    url.searchParams.set("pageToken", input.pageToken);
  }
  return url.toString();
};

const fetchEventsListPage = async (input: {
  calendarId: string;
  syncToken: string | null;
  pageToken: string | null;
  timeMinIso: string | null;
  pageSize: number | null;
  accessToken: string;
  fetcher: typeof fetch;
}): Promise<EventsListPage> => {
  try {
    const response = await input.fetcher(
      buildEventsListUrl({
        calendarId: input.calendarId,
        syncToken: input.syncToken,
        pageToken: input.pageToken,
        timeMinIso: input.timeMinIso,
        pageSize: input.pageSize
      }),
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${input.accessToken}`
        }
      }
    );

    if (response.status === 410 && input.syncToken) {
      return {
        ok: false,
        reason: "google-sync-token-expired",
        syncTokenExpired: true
      };
    }
    if ((response.status === 410 || response.status === 400) && !input.syncToken && input.pageToken) {
      return {
        ok: false,
        reason: "google-page-token-invalid",
        syncTokenExpired: false,
        pageTokenInvalid: true
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        reason: `google-events-list-http-${response.status}`,
        syncTokenExpired: false
      };
    }

    // `response.json()` is INSIDE the try on purpose: `withOutboundTimeout` keeps the
    // 30s AbortSignal armed through the body read, so an upstream that returns headers
    // then stalls while streaming the body aborts here, not at the fetch await above.
    const body: GoogleEventsListResponse = await response.json();
    const items = Array.isArray(body.items)
      ? body.items.filter((item): item is GoogleEvent => typeof item === "object" && item !== null)
      : [];
    return {
      ok: true,
      items,
      nextPageToken: typeof body.nextPageToken === "string" ? body.nextPageToken : null,
      nextSyncToken: typeof body.nextSyncToken === "string" ? body.nextSyncToken : null
    };
  } catch (err) {
    // A transient outbound abort (30s `withOutboundTimeout` firing → name "TimeoutError",
    // or a cancelled "AbortError"), whether from the fetch or the body read, is an upstream
    // stall, not a code fault. Degrade to the same soft failure the HTTP-error branch
    // returns so the job is retried on the next sweep instead of throwing up to the queue
    // handler's safeCaptureException (Sentry RESERVATION-LINE-HOMEPAGE-A/B). Genuine errors
    // (network TypeError, JSON SyntaxError, etc.) re-throw so real failures still surface.
    if (isTransientAbortError(err)) {
      return {
        ok: false,
        reason: "google-events-list-timeout",
        syncTokenExpired: false
      };
    }
    throw err;
  }
};

const normalizeEventStatus = (event: GoogleEvent) => {
  return isNonEmptyString(event.status, 64) ? event.status : "confirmed";
};

const normalizeTransparency = (event: GoogleEvent): "opaque" | "transparent" => {
  return event.transparency === "transparent" ? "transparent" : "opaque";
};

const readDateTime = (value: GoogleEventDate | undefined) => {
  if (!isNonEmptyString(value?.dateTime, 64)) {
    return null;
  }
  const date = new Date(value.dateTime);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
const readDateAsUtcIso = parseDateJstToUtcIso;

/** Read the raw YYYY-MM-DD date string from a Google all-day event field. */
const readDateString = (value: GoogleEventDate | undefined): string | null => {
  if (typeof value?.date !== "string") return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value.date) ? value.date : null;
};

const isAllDayEvent = (event: GoogleEvent) => {
  return typeof event.start?.date === "string" || typeof event.end?.date === "string";
};

const isRecurringEvent = (event: GoogleEvent) => {
  return Array.isArray(event.recurrence) || typeof event.recurringEventId === "string";
};

const createSafeSnapshot = (event: GoogleEvent): SafeGoogleSnapshot | undefined => {
  if (!isNonEmptyString(event.id, 1024)) {
    return undefined;
  }
  const allDay = isAllDayEvent(event);

  // For all-day events, Google returns start.date / end.date (YYYY-MM-DD)
  // instead of start.dateTime / end.dateTime. Convert to UTC ISO Z via JST.
  let startAt = readDateTime(event.start);
  let endAt = readDateTime(event.end);
  let startDate: string | undefined;
  let endDate: string | undefined;

  if (allDay) {
    startDate = readDateString(event.start) ?? undefined;
    endDate = readDateString(event.end) ?? undefined;
    if (!startAt && startDate) {
      startAt = readDateAsUtcIso(startDate);
    }
    if (!endAt && endDate) {
      endAt = readDateAsUtcIso(endDate);
    }
  }

  return {
    google_event_id: event.id,
    status: normalizeEventStatus(event),
    start_at: startAt,
    end_at: endAt,
    transparency: normalizeTransparency(event),
    all_day: allDay,
    recurring: isRecurringEvent(event),
    ...(startDate === undefined ? {} : { start_date: startDate }),
    ...(endDate === undefined ? {} : { end_date: endDate })
  };
};

const extractEventSummary = (event: GoogleEvent): string | null => {
  if (typeof event.summary !== "string") return null;
  const trimmed = event.summary.trim();
  return trimmed.length > 0 ? trimmed : null;
};

type ConflictSnapshot = SafeGoogleSnapshot & { summary: string | null };

const buildConflictSnapshot = (
  safe: SafeGoogleSnapshot,
  event: GoogleEvent
): ConflictSnapshot => {
  const base: ConflictSnapshot = {
    ...safe,
    summary: extractEventSummary(event)
  };
  // Ensure date-only fields are included when present
  if (safe.start_date !== undefined) base.start_date = safe.start_date;
  if (safe.end_date !== undefined) base.end_date = safe.end_date;
  return base;
};

const getReservationMarker = (event: GoogleEvent) => {
  const privateProperties = event.extendedProperties?.private;
  if (
    privateProperties?.owner_type === "reservation" &&
    isNonEmptyString(privateProperties.reservation_id, 128)
  ) {
    return privateProperties.reservation_id;
  }
  return undefined;
};

const fetchReservationMarker = async (db: D1Database, reservationId: string) => {
  return db
    .prepare(
      `
        SELECT id
        FROM reservations
        WHERE id = ?
        LIMIT 1
      `
    )
    .bind(reservationId)
    .first<ReservationMarkerRow>();
};

const fetchReservationByGoogleEvent = async (input: {
  db: D1Database;
  job: ImportJobRow;
  googleEventId: string;
}) => {
  return input.db
    .prepare(
      `
        SELECT reservations.id
        FROM reservations
        WHERE reservations.store_id = ?
          AND (
            EXISTS (
              SELECT 1
              FROM google_calendar_events
              WHERE google_calendar_events.calendar_id = ?
                AND google_calendar_events.google_event_id = ?
                AND google_calendar_events.source_type = 'reservation'
                AND google_calendar_events.status = 'active'
                AND google_calendar_events.reservation_id = reservations.id
            )
            OR (
              reservations.google_event_id = ?
              AND NOT EXISTS (
                SELECT 1
                FROM google_calendar_events
                WHERE google_calendar_events.calendar_id = ?
                  AND google_calendar_events.google_event_id = ?
              )
            )
          )
        LIMIT 1
      `
    )
    .bind(
      input.job.store_id,
      input.job.calendar_id,
      input.googleEventId,
      input.googleEventId,
      input.job.calendar_id,
      input.googleEventId
    )
    .first<ReservationMarkerRow>();
};

const fetchReservationForGoogleMove = async (input: {
  db: D1Database;
  job: ImportJobRow;
  reservationId: string;
  googleEventId: string;
}) => {
  return input.db
    .prepare(
      `
        SELECT
          reservations.id,
          reservations.store_id,
          reservations.customer_id,
          reservations.resource_id,
          reservations.line_identity_id,
          reservations.status,
          reservations.start_at,
          reservations.end_at,
          reservations.duration_minutes,
          reservations.pending_expires_at,
          reservations.version,
          reservations.checked_in_at,
          stores.timezone
        FROM reservations
        JOIN stores ON stores.id = reservations.store_id
        WHERE reservations.id = ?
          AND reservations.store_id = ?
          AND (
            EXISTS (
              SELECT 1
              FROM google_calendar_events
              WHERE google_calendar_events.calendar_id = ?
                AND google_calendar_events.google_event_id = ?
                AND google_calendar_events.source_type = 'reservation'
                AND google_calendar_events.status = 'active'
                AND google_calendar_events.reservation_id = reservations.id
            )
            OR (
              reservations.google_event_id = ?
              AND NOT EXISTS (
                SELECT 1
                FROM google_calendar_events
                WHERE google_calendar_events.calendar_id = ?
                  AND google_calendar_events.google_event_id = ?
              )
            )
          )
        LIMIT 1
      `
    )
    .bind(
      input.reservationId,
      input.job.store_id,
      input.job.calendar_id,
      input.googleEventId,
      input.googleEventId,
      input.job.calendar_id,
      input.googleEventId
    )
    .first<ReservationForGoogleMoveRow>();
};

const getLocalParts = (date: Date, timezone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";

  return {
    dateKey: `${value("year")}-${value("month")}-${value("day")}`,
    weekday: WEEKDAY_MAP[value("weekday")],
    time: `${value("hour")}:${value("minute")}`
  };
};

const ensureBusinessTime = async (input: {
  db: D1Database;
  reservation: ReservationForGoogleMoveRow;
  startAt: Date;
  endAt: Date;
}) => {
  const startParts = getLocalParts(input.startAt, input.reservation.timezone);
  const endParts = getLocalParts(input.endAt, input.reservation.timezone);
  if (startParts.weekday === undefined || startParts.dateKey !== endParts.dateKey) {
    return false;
  }

  const businessHour = await input.db
    .prepare(
      `
        SELECT id
        FROM store_business_hours
        WHERE store_id = ?
          AND weekday = ?
          AND active = 1
          AND opens_at <= ?
          AND closes_at >= ?
        LIMIT 1
      `
    )
    .bind(input.reservation.store_id, startParts.weekday, startParts.time, endParts.time)
    .first<{ id: string }>();
  if (!businessHour) {
    return false;
  }

  const closure = await input.db
    .prepare(
      `
        SELECT id
        FROM store_closures
        WHERE store_id = ?
          AND starts_at < ?
          AND ends_at > ?
        LIMIT 1
      `
    )
    .bind(input.reservation.store_id, input.endAt.toISOString(), input.startAt.toISOString())
    .first<{ id: string }>();
  return !closure;
};

// One sequential D1 query PER 5-MINUTE SLOT was the root cause of the chronic
// full_reconcile timeout (an all-day block = 288 probes before any write, so a
// block-heavy calendar ran at seconds per event). Both conflict probes below
// batch the slot list into IN (...) chunks instead — same row-level predicate,
// ~80x fewer round trips.
const chunkBindValues = <T>(values: T[], size: number = SLOT_QUERY_CHUNK_SIZE): T[][] => {
  if (size <= 0) {
    // A non-positive size would make the loop below spin forever — fatal in a
    // Worker where an infinite loop burns the whole invocation's CPU budget.
    throw new RangeError("chunk size must be a positive integer");
  }
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
};

const hasReservationMoveConflict = async (input: {
  db: D1Database;
  reservation: ReservationForGoogleMoveRow;
  slots: string[];
}) => {
  for (const chunk of chunkBindValues(input.slots)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const slotConflict = await input.db
      .prepare(
        `
          SELECT id
          FROM slot_locks
          WHERE store_id = ?
            AND resource_id = ?
            AND slot_at IN (${placeholders})
            AND NOT (owner_type = 'reservation' AND owner_id = ?)
          LIMIT 1
        `
      )
      .bind(input.reservation.store_id, input.reservation.resource_id, ...chunk, input.reservation.id)
      .first<{ id: string }>();
    if (slotConflict) {
      return true;
    }

    const customerConflict = await input.db
      .prepare(
        `
          SELECT id
          FROM customer_time_locks
          WHERE customer_id = ?
            AND slot_at IN (${placeholders})
            AND owner_id != ?
          LIMIT 1
        `
      )
      .bind(input.reservation.customer_id, ...chunk, input.reservation.id)
      .first<{ id: string }>();
    if (customerConflict) {
      return true;
    }
  }

  return false;
};

type GoogleEventUpsertStatements = readonly [D1PreparedStatement, D1PreparedStatement];
type GoogleEventSourceType = "reservation" | "external_block" | "unknown";

const buildGoogleEventHistoryInsert = (input: {
  db: D1Database;
  storeId: string;
  calendarId: string;
  googleEventId: string;
  googleEtag: string | null;
  googleUpdatedAt: string | null;
  sourceType: GoogleEventSourceType;
  status: "active" | "cancelled" | "deleted" | "conflict" | "ignored";
  safeSnapshot: SafeGoogleSnapshot;
  capturedAt: string;
}): D1PreparedStatement =>
  input.db
    .prepare(
      `
        INSERT INTO google_calendar_event_history (
          id,
          store_id,
          calendar_id,
          google_event_id,
          google_etag,
          google_updated_at,
          source_type,
          status,
          reason,
          snapshot_json,
          captured_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'upsert', ?, ?)
      `
    )
    .bind(
      crypto.randomUUID(),
      input.storeId,
      input.calendarId,
      input.googleEventId,
      input.googleEtag,
      input.googleUpdatedAt,
      input.sourceType,
      input.status,
      JSON.stringify(input.safeSnapshot),
      input.capturedAt
    );

const upsertGoogleEvent = (input: {
  db: D1Database;
  storeId: string;
  calendarId: string;
  googleEventId: string;
  googleEtag: string | null;
  googleUpdatedAt: string | null;
  sourceType: "reservation" | "external_block" | "unknown";
  status: "active" | "cancelled" | "deleted" | "conflict" | "ignored";
  reservationId?: string | null;
  externalBlockId?: string | null;
  safeSnapshot: SafeGoogleSnapshot;
  nowIso?: string;
}): GoogleEventUpsertStatements => {
  const capturedAt = input.nowIso ?? toIso(Date.now());
  const upsert = input.db
    .prepare(
      `
        INSERT INTO google_calendar_events (
          id,
          store_id,
          calendar_id,
          google_event_id,
          reservation_id,
          external_block_id,
          google_etag,
          google_updated_at,
          last_seen_at,
          last_imported_at,
          source_type,
          status,
          google_safe_snapshot_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, ?)
        ON CONFLICT(calendar_id, google_event_id) DO UPDATE SET
          reservation_id = excluded.reservation_id,
          external_block_id = excluded.external_block_id,
          google_etag = excluded.google_etag,
          google_updated_at = excluded.google_updated_at,
          last_seen_at = excluded.last_seen_at,
          last_imported_at = excluded.last_imported_at,
          source_type = excluded.source_type,
          status = excluded.status,
          google_safe_snapshot_json = excluded.google_safe_snapshot_json
      `
    )
    .bind(
      crypto.randomUUID(),
      input.storeId,
      input.calendarId,
      input.googleEventId,
      input.reservationId ?? null,
      input.externalBlockId ?? null,
      input.googleEtag,
      input.googleUpdatedAt,
      input.sourceType,
      input.status,
      JSON.stringify(input.safeSnapshot)
    );
  const history = buildGoogleEventHistoryInsert({
    db: input.db,
    storeId: input.storeId,
    calendarId: input.calendarId,
    googleEventId: input.googleEventId,
    googleEtag: input.googleEtag,
    googleUpdatedAt: input.googleUpdatedAt,
    sourceType: input.sourceType,
    status: input.status,
    safeSnapshot: input.safeSnapshot,
    capturedAt
  });
  return [upsert, history];
};

const fetchExternalBlock = async (db: D1Database, googleEventId: string) => {
  return db
    .prepare(
      `
        SELECT id, source
        FROM external_blocks
        WHERE google_event_id = ?
        LIMIT 1
      `
    )
    .bind(googleEventId)
    .first<ExternalBlockRow>();
};

const queueExternalBlockCanonicalRevert = (input: {
  db: D1Database;
  externalBlockId: string;
  googleEventId: string;
  nowIso: string;
}) => {
  logGoogleEvent({
    event_type: "import_outbound_revert",
    outcome: "success"
  });
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
        ) VALUES (?, ?, 'external_block', ?, 'upsert', 'queued', ?)
      `
    )
    .bind(
      crypto.randomUUID(),
      compactDedupeKey(
        `external_block:${input.externalBlockId}:google:upsert:restore:${input.googleEventId}`,
        "calendar-sync:external-block-restore"
      ),
      input.externalBlockId,
      input.nowIso
    );
};

const insertExternalBlockDeletionConflict = (input: {
  db: D1Database;
  job: ImportJobRow;
  externalBlockId: string;
  googleEventId: string;
  event: GoogleEvent;
  safeSnapshot: SafeGoogleSnapshot;
}) => {
  logGoogleEvent({
    event_type: "import_conflict_detected",
    outcome: "failure",
    calendar_id: input.job.calendar_id,
    store_id: input.job.store_id,
    conflict_type: "external_block_event_deleted",
    error_class: "conflict_detected"
  });
  return input.db
    .prepare(
      `
        INSERT INTO google_calendar_conflicts (
          id,
          store_id,
          calendar_id,
          google_event_id,
          external_block_id,
          conflict_type,
          google_safe_snapshot_json,
          resolution_status
        )
        SELECT ?, ?, ?, ?, ?, 'external_block_event_deleted', ?, 'open'
        WHERE NOT EXISTS (
          SELECT 1
          FROM google_calendar_conflicts
          WHERE calendar_id = ?
            AND google_event_id = ?
            AND external_block_id = ?
            AND conflict_type = 'external_block_event_deleted'
            AND resolution_status = 'open'
        )
      `
    )
    .bind(
      crypto.randomUUID(),
      input.job.store_id,
      input.job.calendar_id,
      input.googleEventId,
      input.externalBlockId,
      JSON.stringify(buildConflictSnapshot(input.safeSnapshot, input.event)),
      input.job.calendar_id,
      input.googleEventId,
      input.externalBlockId
    );
};

// Staff routinely put housekeeping events (掃除/休憩/勤怠/施術メモ) on the synced
// Google calendar that overlap reservation slots. When the event is NEW (no existing
// D1 external_block — external_block_id IS NULL) the import simply can't place a block
// on the occupied slot: recurring noise, not an actionable conflict. Those are recorded
// pre-resolved ("ignored") with this marker so they stay out of every reader (each
// filters resolution_status='open'): the system_admin 要対応 list, the owner sync
// summary, the daily ops summary, and the burst alert. Owner-approved 2026-06-15.
//
// A conflict on an ALREADY-IMPORTED block being MOVED into a now-occupied time
// (existing truthy / external_block_id NOT NULL) is different: D1 keeps the block at
// its old time while Google has it at the conflicting time — a real divergence the
// operator should reconcile. Those stay 'open' (actionable). external_block_id thus
// separates noise (NULL) from real divergence (NOT NULL); migration 0035 backfills the
// same predicate for rows accumulated before this change.
const EXTERNAL_BLOCK_OVERLAP_AUTO_RESOLVED_BY = "system:auto_external_block_overlap";

const recordGoogleEventConflict = async (input: {
  db: D1Database;
  job: ImportJobRow;
  event: GoogleEvent;
  safeSnapshot: SafeGoogleSnapshot;
  conflictType: string;
  sourceType?: "external_block" | "reservation" | "unknown";
  reservationId?: string | null;
  externalBlockId?: string | null;
  // "ignored" records the conflict pre-resolved (terminal) so it never surfaces as
  // actionable. Defaults to "open" for every other conflict type. resolvedBy stamps a
  // machine marker for forensic queries; resolved_at is set from the wall clock.
  resolutionStatus?: "open" | "ignored";
  resolvedBy?: string | null;
}) => {
  const googleEventId = input.safeSnapshot.google_event_id;
  const googleEtag = isNonEmptyString(input.event.etag, 512) ? input.event.etag : null;
  const googleUpdatedAt = isNonEmptyString(input.event.updated, 64) ? input.event.updated : null;
  const sourceType = input.sourceType ?? "unknown";
  const resolutionStatus = input.resolutionStatus ?? "open";
  const isAutoDismissed = resolutionStatus !== "open";
  const resolvedBy = isAutoDismissed ? input.resolvedBy ?? null : null;
  // resolved_at is informational only (no TTL/idempotency reads it), so a direct
  // wall-clock read is fine here. (ponytail)
  const resolvedAt = isAutoDismissed ? new Date().toISOString() : null;
  logGoogleEvent({
    event_type: "import_conflict_detected",
    // Auto-dismissed noise must not read as a failure: a "failure" outcome would
    // keep the recurring overlap loud in log-based alerting even though it is no
    // longer actionable. Surface it as a benign no-op instead.
    outcome: isAutoDismissed ? "noop" : "failure",
    calendar_id: input.job.calendar_id,
    store_id: input.job.store_id,
    conflict_type: input.conflictType,
    error_class: isAutoDismissed ? undefined : "conflict_detected"
  });
  await input.db.batch([
    ...upsertGoogleEvent({
      db: input.db,
      storeId: input.job.store_id,
      calendarId: input.job.calendar_id,
      googleEventId,
      googleEtag,
      googleUpdatedAt,
      sourceType,
      status: "conflict",
      reservationId: sourceType === "reservation" ? input.reservationId ?? null : null,
      externalBlockId: sourceType === "external_block" ? input.externalBlockId ?? null : null,
      safeSnapshot: input.safeSnapshot
    }),
    input.db
      .prepare(
        `
          INSERT INTO google_calendar_conflicts (
            id,
            store_id,
            calendar_id,
            google_event_id,
            reservation_id,
            external_block_id,
            conflict_type,
            google_safe_snapshot_json,
            resolution_status,
            resolved_at,
            resolved_by
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (
            SELECT 1
            FROM google_calendar_conflicts
            WHERE calendar_id = ?
              AND google_event_id = ?
              AND conflict_type = ?
              AND resolution_status = ?
          )
        `
      )
      // Dedup on the SAME status we are inserting: 'open' keeps the original
      // "one open conflict per (calendar,event,type)" guard; 'ignored' makes the
      // auto-dismiss idempotent so a recurring overlap records exactly one ignored
      // row instead of piling up a fresh row on every sync.
      .bind(
        crypto.randomUUID(),
        input.job.store_id,
        input.job.calendar_id,
        googleEventId,
        input.reservationId ?? null,
        input.externalBlockId ?? null,
        input.conflictType,
        JSON.stringify(buildConflictSnapshot(input.safeSnapshot, input.event)),
        resolutionStatus,
        resolvedAt,
        resolvedBy,
        input.job.calendar_id,
        googleEventId,
        input.conflictType,
        resolutionStatus
      )
  ]);
};

const recordReservationMarkerMismatch = async (input: {
  db: D1Database;
  job: ImportJobRow;
  event: GoogleEvent;
  safeSnapshot: SafeGoogleSnapshot;
  reservationId: string;
}) => {
  const reservation = await fetchReservationMarker(input.db, input.reservationId);
  await recordGoogleEventConflict({
    db: input.db,
    job: input.job,
    event: input.event,
    safeSnapshot: input.safeSnapshot,
    conflictType: "reservation_marker_mismatch",
    reservationId: reservation?.id ?? null
  });
};

const hasExternalBlockSlotConflict = async (input: {
  db: D1Database;
  storeId: string;
  resourceId: string;
  slots: string[];
  externalBlockId: string;
}) => {
  for (const chunk of chunkBindValues(input.slots)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const conflict = await input.db
      .prepare(
        `
          SELECT id
          FROM slot_locks
          WHERE store_id = ?
            AND resource_id = ?
            AND slot_at IN (${placeholders})
            AND NOT (
              owner_type = 'external_block'
              AND owner_id = ?
            )
          LIMIT 1
        `
      )
      .bind(input.storeId, input.resourceId, ...chunk, input.externalBlockId)
      .first<{ id: string }>();
    if (conflict) {
      return true;
    }
  }
  return false;
};

const recordExternalBlockInvalidTime = async (input: {
  db: D1Database;
  job: ImportJobRow;
  event: GoogleEvent;
  safeSnapshot: SafeGoogleSnapshot;
}) => {
  await recordGoogleEventConflict({
    db: input.db,
    job: input.job,
    event: input.event,
    safeSnapshot: input.safeSnapshot,
    conflictType: "external_block_invalid_time"
  });
};

const handleNonGoogleExternalBlockEdit = async (input: {
  db: D1Database;
  job: ImportJobRow;
  event: GoogleEvent;
  safeSnapshot: SafeGoogleSnapshot;
  externalBlockId: string;
  googleEventId: string;
  nowIso: string;
}) => {
  await input.db.batch([
    queueExternalBlockCanonicalRevert({
      db: input.db,
      externalBlockId: input.externalBlockId,
      googleEventId: input.googleEventId,
      nowIso: input.nowIso
    }),
    ...upsertGoogleEvent({
      db: input.db,
      storeId: input.job.store_id,
      calendarId: input.job.calendar_id,
      googleEventId: input.googleEventId,
      googleEtag: isNonEmptyString(input.event.etag, 512) ? input.event.etag : null,
      googleUpdatedAt: isNonEmptyString(input.event.updated, 64) ? input.event.updated : null,
      sourceType: "external_block",
      status: "conflict",
      externalBlockId: input.externalBlockId,
      safeSnapshot: input.safeSnapshot,
      nowIso: input.nowIso
    }),
    input.db
      .prepare(
        `
          INSERT INTO google_calendar_conflicts (
            id,
            store_id,
            calendar_id,
            google_event_id,
            external_block_id,
            conflict_type,
            google_safe_snapshot_json,
            resolution_status
          )
          SELECT ?, ?, ?, ?, ?, 'external_block_non_google_edit', ?, 'open'
          WHERE NOT EXISTS (
            SELECT 1
            FROM google_calendar_conflicts
            WHERE calendar_id = ?
              AND google_event_id = ?
              AND external_block_id = ?
              AND conflict_type = 'external_block_non_google_edit'
              AND resolution_status = 'open'
          )
        `
      )
      .bind(
        crypto.randomUUID(),
        input.job.store_id,
        input.job.calendar_id,
        input.googleEventId,
        input.externalBlockId,
        JSON.stringify(buildConflictSnapshot(input.safeSnapshot, input.event)),
        input.job.calendar_id,
        input.googleEventId,
        input.externalBlockId
      )
  ]);
};

type ExternalBlockImportInput = {
  db: D1Database;
  job: ImportJobRow;
  resourceId: string;
  event: GoogleEvent;
  safeSnapshot: SafeGoogleSnapshot;
  nowIso: string;
};

type PreparedExternalBlockImport = {
  slots: string[];
  existing: Awaited<ReturnType<typeof fetchExternalBlock>>;
  externalBlockId: string;
  googleEventId: string;
};

// Runs the validation + conflict guards for an external-block import. Returns the
// prepared data when the import should proceed, or null when a guard already
// recorded the outcome (invalid time, non-Google edit takeover, too-long block, or
// a pre-checked slot conflict) and the caller should stop. Extracted from
// importExternalBlock to keep that function's cognitive complexity in range.
const prepareExternalBlockImport = async (
  input: ExternalBlockImportInput
): Promise<PreparedExternalBlockImport | null> => {
  if (!input.safeSnapshot.start_at || !input.safeSnapshot.end_at) {
    await recordExternalBlockInvalidTime(input);
    return null;
  }
  const slots = generateSlotTimesForRange(
    new Date(input.safeSnapshot.start_at),
    new Date(input.safeSnapshot.end_at),
    SLOT_INTERVAL_MINUTES,
    { maxSlotsForOverflowSignal: MAX_EXTERNAL_BLOCK_SLOTS }
  );
  if (!slots) {
    await recordExternalBlockInvalidTime(input);
    return null;
  }

  const googleEventId = input.safeSnapshot.google_event_id;
  const existing = await fetchExternalBlock(input.db, googleEventId);
  const externalBlockId = existing?.id ?? crypto.randomUUID();
  if (existing && existing.source !== "google_calendar") {
    await handleNonGoogleExternalBlockEdit({
      db: input.db,
      job: input.job,
      event: input.event,
      safeSnapshot: input.safeSnapshot,
      externalBlockId,
      googleEventId,
      nowIso: input.nowIso
    });
    return null;
  }
  if (slots.length > MAX_EXTERNAL_BLOCK_SLOTS) {
    await recordGoogleEventConflict({
      db: input.db,
      job: input.job,
      event: input.event,
      safeSnapshot: input.safeSnapshot,
      conflictType: "external_block_too_long",
      sourceType: existing ? "external_block" : "unknown",
      externalBlockId: existing?.id ?? null
    });
    return null;
  }
  if (
    await hasExternalBlockSlotConflict({
      db: input.db,
      storeId: input.job.store_id,
      resourceId: input.resourceId,
      slots,
      externalBlockId
    })
  ) {
    await recordGoogleEventConflict({
      db: input.db,
      job: input.job,
      event: input.event,
      safeSnapshot: input.safeSnapshot,
      conflictType: "external_block_slot_conflict",
      sourceType: existing ? "external_block" : "unknown",
      externalBlockId: existing?.id ?? null,
      // existing (an imported block moved into conflict) → keep 'open' (real D1↔Google
      // divergence); new unknown event → 'ignored' (recurring noise). recordGoogleEventConflict
      // nulls resolvedBy for the 'open' case.
      resolutionStatus: existing ? "open" : "ignored",
      resolvedBy: EXTERNAL_BLOCK_OVERLAP_AUTO_RESOLVED_BY
    });
    return null;
  }
  return { slots, existing, externalBlockId, googleEventId };
};

// Translates a TOCTOU slot_locks UNIQUE violation raised while committing an
// external-block import into the SAME handled conflict the pre-check records, so
// the import event is consumed and the sync token advances — otherwise the throw
// escapes to the outer 'google-import-unhandled' catch, burning retry budget and
// stalling this calendar's incremental sync. Match the UNIQUE message specifically
// (not the bare table name) so any other slot_locks error still surfaces. Extracted
// from importExternalBlock to keep its cognitive complexity in range.
const handleExternalBlockBatchError = async (input: {
  db: D1Database;
  job: ImportJobRow;
  event: GoogleEvent;
  safeSnapshot: SafeGoogleSnapshot;
  existing: Awaited<ReturnType<typeof fetchExternalBlock>>;
  externalBlockId: string;
  googleEventId: string;
  error: unknown;
}): Promise<undefined> => {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  if (message.includes("UNIQUE constraint failed: slot_locks")) {
    safeCaptureException(input.error, {
      tags: { google_module: "import-sync", operation: "external_block_batch" },
      contexts: { d1_query: { external_block_id: input.externalBlockId, google_event_id: input.googleEventId } }
    });
    await recordGoogleEventConflict({
      db: input.db,
      job: input.job,
      event: input.event,
      safeSnapshot: input.safeSnapshot,
      conflictType: "external_block_slot_conflict",
      sourceType: input.existing ? "external_block" : "unknown",
      externalBlockId: input.existing?.id ?? null,
      // existing block moved into conflict → 'open' (real divergence); new unknown
      // event → 'ignored' (recurring noise). resolvedBy is nulled for the 'open' case.
      resolutionStatus: input.existing ? "open" : "ignored",
      resolvedBy: EXTERNAL_BLOCK_OVERLAP_AUTO_RESOLVED_BY
    });
    return undefined;
  }
  throw input.error;
};

const importExternalBlock = async (input: ExternalBlockImportInput) => {
  const plan = await prepareExternalBlockImport(input);
  if (!plan) {
    return undefined;
  }
  const { slots, existing, externalBlockId, googleEventId } = plan;
  const googleEtag = isNonEmptyString(input.event.etag, 512) ? input.event.etag : null;
  const googleUpdatedAt = isNonEmptyString(input.event.updated, 64) ? input.event.updated : null;
  const titleSnapshot = (extractEventSummary(input.event) ?? "（タイトルなし）").slice(0, 512);
  const statements = [
    existing
      ? input.db
          .prepare(
            `
              UPDATE external_blocks
              SET title_snapshot = ?,
                  start_at = ?,
                  end_at = ?,
                  status = 'active',
                  google_event_etag = ?,
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `
          )
          .bind(titleSnapshot, input.safeSnapshot.start_at, input.safeSnapshot.end_at, googleEtag, externalBlockId)
      : input.db
          .prepare(
            `
              INSERT INTO external_blocks (
                id,
                store_id,
                resource_id,
                source,
                title_snapshot,
                start_at,
                end_at,
                status,
                google_event_id,
                google_event_etag,
                created_by
              ) VALUES (?, ?, ?, 'google_calendar', ?, ?, ?, 'active', ?, ?, 'google_calendar')
            `
          )
          .bind(
            externalBlockId,
            input.job.store_id,
            input.resourceId,
            titleSnapshot,
            input.safeSnapshot.start_at,
            input.safeSnapshot.end_at,
            googleEventId,
            googleEtag
          ),
    input.db
      .prepare(
        `
          DELETE FROM slot_locks
          WHERE owner_type = 'external_block'
            AND owner_id = ?
        `
      )
      .bind(externalBlockId),
    ...upsertGoogleEvent({
      db: input.db,
      storeId: input.job.store_id,
      calendarId: input.job.calendar_id,
      googleEventId,
      googleEtag,
      googleUpdatedAt,
      sourceType: "external_block",
      status: "active",
      externalBlockId,
      safeSnapshot: input.safeSnapshot,
      nowIso: input.nowIso
    })
  ];

  for (const slotAt of slots) {
    statements.push(
      input.db
        .prepare(
          `
            INSERT INTO slot_locks (
              id,
              store_id,
              resource_id,
              slot_at,
              owner_type,
              owner_id,
              lock_status,
              expires_at
            ) VALUES (?, ?, ?, ?, 'external_block', ?, 'confirmed', NULL)
          `
        )
        .bind(crypto.randomUUID(), input.job.store_id, input.resourceId, slotAt, externalBlockId)
    );
  }

  try {
    await input.db.batch(statements);
  } catch (error) {
    return handleExternalBlockBatchError({
      db: input.db,
      job: input.job,
      event: input.event,
      safeSnapshot: input.safeSnapshot,
      existing,
      externalBlockId,
      googleEventId,
      error
    });
  }
  logGoogleEvent({
    event_type: "import_external_block_created",
    outcome: "success",
    calendar_id: input.job.calendar_id,
    store_id: input.job.store_id
  });
  return undefined;
};

const cancelExternalBlock = async (input: {
  db: D1Database;
  job: ImportJobRow;
  event: GoogleEvent;
  safeSnapshot: SafeGoogleSnapshot;
  nowIso: string;
}) => {
  const googleEventId = input.safeSnapshot.google_event_id;
  const existing = await fetchExternalBlock(input.db, googleEventId);
  const googleEtag = isNonEmptyString(input.event.etag, 512) ? input.event.etag : null;
  const googleUpdatedAt = isNonEmptyString(input.event.updated, 64) ? input.event.updated : null;
  const statements: D1PreparedStatement[] = [];

  if (existing) {
    if (existing.source !== "google_calendar") {
      await input.db.batch([
        input.db
          .prepare(
            `
              UPDATE external_blocks
              SET google_event_id = NULL,
                  google_event_etag = NULL,
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `
          )
          .bind(existing.id),
        queueExternalBlockCanonicalRevert({
          db: input.db,
          externalBlockId: existing.id,
          googleEventId,
          nowIso: input.nowIso
        }),
        insertExternalBlockDeletionConflict({
          db: input.db,
          job: input.job,
          externalBlockId: existing.id,
          googleEventId,
          event: input.event,
          safeSnapshot: input.safeSnapshot
        }),
        ...upsertGoogleEvent({
          db: input.db,
          storeId: input.job.store_id,
          calendarId: input.job.calendar_id,
          googleEventId,
          googleEtag,
          googleUpdatedAt,
          sourceType: "external_block",
          status: "conflict",
          externalBlockId: existing.id,
          safeSnapshot: input.safeSnapshot,
          nowIso: input.nowIso
        })
      ]);
      return;
    }

    statements.push(
      input.db
        .prepare(
          `
            UPDATE external_blocks
            SET status = 'cancelled',
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `
        )
        .bind(existing.id),
      input.db
        .prepare(
          `
            DELETE FROM slot_locks
            WHERE owner_type = 'external_block'
              AND owner_id = ?
          `
        )
        .bind(existing.id)
    );
  }

  statements.push(
    ...upsertGoogleEvent({
      db: input.db,
      storeId: input.job.store_id,
      calendarId: input.job.calendar_id,
      googleEventId,
      googleEtag,
      googleUpdatedAt,
      sourceType: existing ? "external_block" : "unknown",
      status: "deleted",
      externalBlockId: existing?.id ?? null,
      safeSnapshot: input.safeSnapshot,
      nowIso: input.nowIso
    })
  );

  await input.db.batch(statements);
};

const recordReservationEventDeletion = async (input: {
  db: D1Database;
  job: ImportJobRow;
  event: GoogleEvent;
  safeSnapshot: SafeGoogleSnapshot;
  reservationId: string;
  nowIso: string;
}) => {
  const googleEventId = input.safeSnapshot.google_event_id;
  const googleEtag = isNonEmptyString(input.event.etag, 512) ? input.event.etag : null;
  const googleUpdatedAt = isNonEmptyString(input.event.updated, 64) ? input.event.updated : null;

  // Terminal resolution suppression: if this calendar_id/google_event_id/
  // reservation_id was previously resolved as approved_as_cancel or rejected,
  // do NOT create a new open conflict or restore job. This prevents webhook
  // re-delivery or full reconcile from overriding an operator's decision.
  const terminalRow = await input.db
    .prepare(
      `SELECT resolution_status FROM google_calendar_conflicts
       WHERE calendar_id = ?
         AND google_event_id = ?
         AND reservation_id = ?
         AND conflict_type = 'reservation_event_deleted'
         AND resolution_status IN ('approved_as_cancel', 'rejected')
       LIMIT 1`
    )
    .bind(input.job.calendar_id, googleEventId, input.reservationId)
    .first<{ resolution_status: string }>();

  if (terminalRow) {
    const isRejected = terminalRow.resolution_status === "rejected";
    // Record the google_calendar_events deletion but skip conflict + restore
    // (approved_as_cancel) or skip conflict only (rejected — restore continues
    // via existing queued job).
    const statements: D1PreparedStatement[] = [...upsertGoogleEvent({
      db: input.db,
      storeId: input.job.store_id,
      calendarId: input.job.calendar_id,
      googleEventId,
      googleEtag,
      googleUpdatedAt,
      sourceType: "reservation",
      status: "deleted",
      reservationId: input.reservationId,
      safeSnapshot: input.safeSnapshot,
      nowIso: input.nowIso
    })];

    if (isRejected) {
      // Rejected means operator wants the event restored on Google.
      // Re-queue a fresh restore job scoped to THIS etag so that a second
      // deletion (new etag from Google) is not swallowed by INSERT OR IGNORE
      // on a previously-succeeded key. Mirrors queueReservationCanonicalRevert
      // etag-scoped pattern (Codex #14 follow-up).
      const etagSegment = googleEtag ?? "noEtag";
      statements.push(
        input.db
          .prepare(
            `UPDATE reservations
             SET google_event_id = NULL,
                 google_event_etag = NULL,
                 google_sync_state = 'pending',
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?
               AND google_event_id = ?`
          )
          .bind(input.reservationId, googleEventId),
        input.db
          .prepare(
            `INSERT OR IGNORE INTO calendar_sync_jobs (
               id, dedupe_key, owner_type, owner_id, google_action, status, available_at
             ) VALUES (?, ?, 'reservation', ?, 'upsert', 'queued', ?)`
          )
          .bind(
            crypto.randomUUID(),
            compactDedupeKey(
              `reservation:${input.reservationId}:google:upsert:restore:${googleEventId}:etag:${etagSegment}`,
              "calendar-sync:reservation-restore"
            ),
            input.reservationId,
            input.nowIso
          )
      );
    }
    // approved_as_cancel: no reservation update, no restore job, no conflict.
    // Just record the google_calendar_events status='deleted'.

    await input.db.batch(statements);
    return;
  }

  await input.db.batch([
    ...upsertGoogleEvent({
      db: input.db,
      storeId: input.job.store_id,
      calendarId: input.job.calendar_id,
      googleEventId,
      googleEtag,
      googleUpdatedAt,
      sourceType: "reservation",
      status: "deleted",
      reservationId: input.reservationId,
      safeSnapshot: input.safeSnapshot,
      nowIso: input.nowIso
    }),
    input.db
      .prepare(
        `
          UPDATE reservations
          SET google_event_id = NULL,
              google_event_etag = NULL,
              google_sync_state = 'pending',
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
            AND google_event_id = ?
        `
      )
      .bind(input.reservationId, googleEventId),
    input.db
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
          ) VALUES (?, ?, 'reservation', ?, 'upsert', 'queued', ?)
        `
      )
      .bind(
        crypto.randomUUID(),
        compactDedupeKey(
          // etag-scope this restore key like the rejected-terminal path (and
          // queueReservationCanonicalRevert) so a later distinct deletion (new etag)
          // is not swallowed by INSERT OR IGNORE on a previously-succeeded same-key job.
          `reservation:${input.reservationId}:google:upsert:restore:${googleEventId}:etag:${googleEtag ?? "noEtag"}`,
          "calendar-sync:reservation-restore"
        ),
        input.reservationId,
        input.nowIso
      ),
    input.db
      .prepare(
        `
          INSERT INTO google_calendar_conflicts (
            id,
            store_id,
            calendar_id,
            google_event_id,
            reservation_id,
            conflict_type,
            google_safe_snapshot_json,
            resolution_status
          )
          SELECT ?, ?, ?, ?, ?, 'reservation_event_deleted', ?, 'open'
          WHERE NOT EXISTS (
            SELECT 1
            FROM google_calendar_conflicts
            WHERE calendar_id = ?
              AND google_event_id = ?
              AND reservation_id = ?
              AND conflict_type = 'reservation_event_deleted'
              AND resolution_status = 'open'
          )
        `
      )
      .bind(
        crypto.randomUUID(),
        input.job.store_id,
        input.job.calendar_id,
        googleEventId,
        input.reservationId,
        JSON.stringify(buildConflictSnapshot(input.safeSnapshot, input.event)),
        input.job.calendar_id,
        googleEventId,
        input.reservationId
      )
  ]);
};

// Codex #14 follow-up — the dedupe_key must scope to the specific incoming
// Google event version (etag). The previous key was reservation/event-only,
// so once a canonical revert succeeded the calendar_sync_jobs row stayed at
// status='succeeded' and `INSERT OR IGNORE` dropped every subsequent revert
// attempt for that same event — letting later staff edits keep their PII in
// place. Including the sanitized etag (or a `noEtag` sentinel) in the key
// scopes idempotency to "this specific staff-edit version", so each new etag
// emitted by Google for the same event produces a fresh queued revert job.
const queueReservationCanonicalRevert = (input: {
  db: D1Database;
  reservationId: string;
  googleEventId: string;
  incomingGoogleEtag: string | null;
  nowIso: string;
}) => {
  logGoogleEvent({
    event_type: "import_outbound_revert",
    outcome: "success"
  });
  const etagSegment = input.incomingGoogleEtag ?? "noEtag";
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
        ) VALUES (?, ?, 'reservation', ?, 'upsert', 'queued', ?)
      `
    )
    .bind(
      crypto.randomUUID(),
      compactDedupeKey(
        `reservation:${input.reservationId}:google:upsert:revert:${input.googleEventId}:etag:${etagSegment}`,
        "calendar-sync:reservation-revert"
      ),
      input.reservationId,
      input.nowIso
    );
};

// Codex #14: the active-outbound-write check is the only echo signal we use to
// decide whether to suppress a canonical revert when a Google event comes back
// with start/end matching D1. Before this tightening it only checked for the
// existence of any unexpired outbound upsert for the same calendar/event/
// reservation, so a staff edit of the title/description shortly after a
// legitimate system upsert was misclassified as an echo (start/end unchanged
// + outbound-write row still present), leaving PII-bearing text in Google
// Calendar for up to the 24-hour outbound-write window. We now require the
// stored `google_etag_after` to match the incoming Google event's etag — only
// then is the event verifiably the byte-for-byte echo of our own write. Any
// post-write edit increments Google's etag, so etag mismatch (or a NULL
// `google_etag_after` from a write whose etag we never captured) makes this
// return false and the importer queues the canonical rewrite.
const hasActiveReservationOutboundWrite = async (input: {
  db: D1Database;
  job: ImportJobRow;
  reservationId: string;
  googleEventId: string;
  googleEventEtag: string | null;
}) => {
  if (input.googleEventEtag === null) {
    return false;
  }
  const row = await input.db
    .prepare(
      `
        SELECT id
        FROM google_calendar_outbound_writes
        WHERE calendar_id = ?
          AND google_event_id = ?
          AND owner_type = 'reservation'
          AND owner_id = ?
          AND action = 'upsert'
          AND expires_at > CURRENT_TIMESTAMP
          AND google_etag_after IS NOT NULL
          AND google_etag_after = ?
        LIMIT 1
      `
    )
    .bind(
      input.job.calendar_id,
      input.googleEventId,
      input.reservationId,
      input.googleEventEtag
    )
    .first<{ id: string }>();
  return Boolean(row);
};

const hasResolvedReservationConflict = async (input: {
  db: D1Database;
  job: ImportJobRow;
  reservationId: string;
  googleEventId: string;
}) => {
  const row = await input.db
    .prepare(
      `
        SELECT id
        FROM google_calendar_conflicts
        WHERE calendar_id = ?
          AND google_event_id = ?
          AND reservation_id = ?
          AND resolution_status IN ('auto_reverted', 'manual_resolved', 'ignored', 'accepted')
        LIMIT 1
      `
    )
    .bind(input.job.calendar_id, input.googleEventId, input.reservationId)
    .first<{ id: string }>();
  return Boolean(row);
};

const shouldSuppressRevertEcho = (input: {
  activeOutbound: boolean;
  resolvedConflict: boolean;
  reservation: ReservationForGoogleMoveRow;
  safeSnapshot: SafeGoogleSnapshot;
}) => {
  return (
    input.activeOutbound &&
    input.resolvedConflict &&
    input.safeSnapshot.start_at === input.reservation.start_at &&
    input.safeSnapshot.end_at === input.reservation.end_at
  );
};

const insertReservationConflict = (input: {
  db: D1Database;
  job: ImportJobRow;
  reservationId: string;
  googleEventId: string;
  conflictType: string;
  event: GoogleEvent;
  safeSnapshot: SafeGoogleSnapshot;
}) => {
  return input.db
    .prepare(
      `
        INSERT INTO google_calendar_conflicts (
          id,
          store_id,
          calendar_id,
          google_event_id,
          reservation_id,
          conflict_type,
          google_safe_snapshot_json,
          resolution_status
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, 'open'
        WHERE NOT EXISTS (
          SELECT 1
          FROM google_calendar_conflicts
          WHERE calendar_id = ?
            AND google_event_id = ?
            AND reservation_id = ?
            AND conflict_type = ?
            AND resolution_status = 'open'
        )
      `
    )
    .bind(
      crypto.randomUUID(),
      input.job.store_id,
      input.job.calendar_id,
      input.googleEventId,
      input.reservationId,
      input.conflictType,
      JSON.stringify(buildConflictSnapshot(input.safeSnapshot, input.event)),
      input.job.calendar_id,
      input.googleEventId,
      input.reservationId,
      input.conflictType
    );
};

const rejectReservationGoogleMove = async (input: {
  db: D1Database;
  job: ImportJobRow;
  reservationId: string;
  googleEventId: string;
  conflictType: string;
  event: GoogleEvent;
  safeSnapshot: SafeGoogleSnapshot;
  nowIso: string;
}) => {
  const rejectIncomingEtag = isNonEmptyString(input.event.etag, 512) ? input.event.etag : null;
  const statements: D1PreparedStatement[] = [
    queueReservationCanonicalRevert({
      db: input.db,
      reservationId: input.reservationId,
      googleEventId: input.googleEventId,
      incomingGoogleEtag: rejectIncomingEtag,
      nowIso: input.nowIso
    }),
    insertReservationConflict({
      db: input.db,
      job: input.job,
      reservationId: input.reservationId,
      googleEventId: input.googleEventId,
      conflictType: input.conflictType,
      event: input.event,
      safeSnapshot: input.safeSnapshot
    })
  ];
  if (input.conflictType === "reservation_checked_in_move_blocked") {
    statements.push(
      input.db
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
            VALUES (?, 'google_calendar', ?, 'google_reservation_time_changed_blocked_checked_in', 'reservation', ?, ?)
          `
        )
        .bind(
          crypto.randomUUID(),
          input.googleEventId,
          input.reservationId,
          JSON.stringify({
            google_event_id: input.googleEventId,
            attempted_start_at: input.safeSnapshot.start_at,
            attempted_end_at: input.safeSnapshot.end_at,
            conflict_type: input.conflictType
          })
        )
    );
  }
  await input.db.batch(statements);
};

const buildGoogleMoveNotificationStatement = async (input: {
  db: D1Database;
  reservation: ReservationForGoogleMoveRow;
  availableAt: string;
  nextVersion: number;
  moveGuardBindings: BoundValue[];
}) => {
  const pending = await input.db
    .prepare(
      `
        SELECT id
        FROM notification_jobs
        WHERE reservation_id = ?
          AND template_key = 'reservation_time_changed'
          AND recipient_type = 'customer'
          AND status IN ('queued', 'retryable')
        ORDER BY created_at DESC
        LIMIT 1
      `
    )
    .bind(input.reservation.id)
    .first<{ id: string }>();

  if (pending) {
    return input.db
      .prepare(
        `
          UPDATE notification_jobs
          SET available_at = ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
            AND status IN ('queued', 'retryable')
            AND EXISTS (${acceptedReservationGoogleMoveExistsSql})
        `
      )
      .bind(input.availableAt, pending.id, ...input.moveGuardBindings);
  }

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
          status,
          available_at
        )
        SELECT ?, ?, 'reservation_time_changed', 'customer', ?, ?, 'queued', ?
        WHERE EXISTS (${acceptedReservationGoogleMoveExistsSql})
      `
    )
    .bind(
      crypto.randomUUID(),
      `reservation:${input.reservation.id}:template:reservation_time_changed:google_move:revision:${input.nextVersion}`,
      input.reservation.customer_id,
      input.reservation.id,
      input.availableAt,
      ...input.moveGuardBindings
    );
};

type BoundValue = string | number | null;

const acceptedReservationGoogleMoveExistsSql = `
  SELECT 1
  FROM reservations
  WHERE id = ?
    AND status = ?
    AND version = ?
    AND start_at = ?
    AND end_at = ?
    AND checked_in_at IS NULL
    AND google_sync_state = 'synced'
    AND updated_by = 'google_calendar'
    AND updated_at = ?
    AND NOT EXISTS (
      SELECT 1
      FROM audit_logs
      WHERE target_type = 'reservation'
        AND target_id = ?
        AND action = 'google_reservation_time_changed'
        AND actor_type = 'google_calendar'
        AND actor_id = ?
        AND metadata_json = ?
    )
`;

const acceptedReservationGoogleMoveBindings = (input: {
  reservation: ReservationForGoogleMoveRow;
  safeSnapshot: SafeGoogleSnapshot;
  nextVersion: number;
  nowIso: string;
  auditMetadataJson: string;
}): BoundValue[] => [
  input.reservation.id,
  input.reservation.status,
  input.nextVersion,
  input.safeSnapshot.start_at,
  input.safeSnapshot.end_at,
  input.nowIso,
  input.reservation.id,
  input.safeSnapshot.google_event_id,
  input.auditMetadataJson
];

const upsertGoogleEventForAcceptedReservationMove = (input: {
  db: D1Database;
  job: ImportJobRow;
  safeSnapshot: SafeGoogleSnapshot;
  reservationId: string;
  googleEtag: string | null;
  googleUpdatedAt: string | null;
  moveGuardBindings: BoundValue[];
  nowIso?: string;
}): GoogleEventUpsertStatements => {
  const capturedAt = input.nowIso ?? toIso(Date.now());
  const upsert = input.db
    .prepare(
      `
        INSERT INTO google_calendar_events (
          id,
          store_id,
          calendar_id,
          google_event_id,
          reservation_id,
          external_block_id,
          google_etag,
          google_updated_at,
          last_seen_at,
          last_imported_at,
          source_type,
          status,
          google_safe_snapshot_json
        )
        SELECT ?, ?, ?, ?, ?, NULL, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'reservation', 'active', ?
        WHERE EXISTS (${acceptedReservationGoogleMoveExistsSql})
        ON CONFLICT(calendar_id, google_event_id) DO UPDATE SET
          reservation_id = excluded.reservation_id,
          external_block_id = excluded.external_block_id,
          google_etag = excluded.google_etag,
          google_updated_at = excluded.google_updated_at,
          last_seen_at = excluded.last_seen_at,
          last_imported_at = excluded.last_imported_at,
          source_type = excluded.source_type,
          status = excluded.status,
          google_safe_snapshot_json = excluded.google_safe_snapshot_json
      `
    )
    .bind(
      crypto.randomUUID(),
      input.job.store_id,
      input.job.calendar_id,
      input.safeSnapshot.google_event_id,
      input.reservationId,
      input.googleEtag,
      input.googleUpdatedAt,
      JSON.stringify(input.safeSnapshot),
      ...input.moveGuardBindings
    );
  // Guarded history INSERT — same WHERE EXISTS clause + guard bindings so the
  // history row is skipped together with the event UPSERT when the move guard
  // is lost (e.g. reservation deleted mid-batch).
  const history = input.db
    .prepare(
      `
        INSERT INTO google_calendar_event_history (
          id,
          store_id,
          calendar_id,
          google_event_id,
          google_etag,
          google_updated_at,
          source_type,
          status,
          reason,
          snapshot_json,
          captured_at
        )
        SELECT ?, ?, ?, ?, ?, ?, 'reservation', 'active', 'upsert', ?, ?
        WHERE EXISTS (${acceptedReservationGoogleMoveExistsSql})
      `
    )
    .bind(
      crypto.randomUUID(),
      input.job.store_id,
      input.job.calendar_id,
      input.safeSnapshot.google_event_id,
      input.googleEtag,
      input.googleUpdatedAt,
      JSON.stringify(input.safeSnapshot),
      capturedAt,
      ...input.moveGuardBindings
    );
  return [upsert, history];
};

// Classifies a batch failure raised while committing an accepted Google-Calendar
// reservation move into the discriminated outcome the caller expects, or rethrows
// unrelated errors. Extracted from acceptReservationGoogleMove to keep its
// cognitive complexity in range.
const classifyReservationMoveBatchError = async (input: {
  db: D1Database;
  job: ImportJobRow;
  reservation: ReservationForGoogleMoveRow;
  event: GoogleEvent;
  safeSnapshot: SafeGoogleSnapshot;
  nowIso: string;
  error: unknown;
}): Promise<"business-time-conflict-handled" | "phone-conflict-handled" | "lost-race" | "slot-conflict-handled"> => {
  safeCaptureException(input.error, {
    tags: { google_module: "import-sync", operation: "reservation_move_batch" },
    contexts: { d1_query: { reservation_id: input.reservation.id, google_event_id: input.safeSnapshot.google_event_id } }
  });
  // PR #27 review feedback (Codex P2 + P2 follow-up): the new
  // idx_customer_time_locks_phone_slot UNIQUE can fire here when an
  // admin/phone-tracked reservation is moved (via Google Calendar edit)
  // onto a slot already locked by another customer with the same phone.
  // hasReservationMoveConflict only pre-validates by customer_id, so this
  // path needs to translate the constraint failure into a normal conflict
  // outcome (audit + canonical revert via rejectReservationMoveConflict)
  // AND signal "handled" upstream so processReservationGoogleEvent does
  // NOT report the import event as failed — otherwise the import job
  // burns retry budget and may dead-letter on a conflict that we
  // already recorded once. We return a discriminated "phone-conflict-
  // handled" result and the caller advances the sync token normally.
  //
  // Substring `customer_time_locks.phone_hash` is the new index added by
  // migration 0008 — phone-scoped conflict, treat as handled outcome
  // (audit + canonical revert) so the import event is consumed and the
  // sync token advances. Substring `customer_time_locks.customer_id` is
  // the legacy `(customer_id, slot_at)` UNIQUE — rare same-customer
  // race against another path (e.g. concurrent admin reschedule).
  // Classify it as a lost race so the caller emits the precise
  // "reservation-move-lost-race" telemetry and the next import attempt
  // re-runs validateReservationMoveCandidate. Anything else throws so
  // the outer "google-import-unhandled" catch still surfaces unrelated
  // batch failures.
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  if (message.includes("store_closed")) {
    await rejectReservationMoveConflict({
      db: input.db,
      job: input.job,
      reservationId: input.reservation.id,
      event: input.event,
      safeSnapshot: input.safeSnapshot,
      conflictType: "reservation_business_time_conflict",
      nowIso: input.nowIso
    });
    return "business-time-conflict-handled";
  }
  if (message.includes("customer_time_locks.phone_hash")) {
    await rejectReservationMoveConflict({
      db: input.db,
      job: input.job,
      reservationId: input.reservation.id,
      event: input.event,
      safeSnapshot: input.safeSnapshot,
      conflictType: "reservation_phone_time_conflict",
      nowIso: input.nowIso
    });
    return "phone-conflict-handled";
  }
  if (message.includes("customer_time_locks.customer_id")) {
    return "lost-race";
  }
  // A foreign owner can grab the destination (store_id, resource_id, slot_at)
  // between hasReservationMoveConflict's pre-check and this batch commit (TOCTOU),
  // tripping the slot_locks UNIQUE. The in-batch DELETE only clears THIS
  // reservation's own locks, so a different owner's conflicting lock is not removed.
  // The sibling customer_time_locks failures above are already translated to handled
  // outcomes; slot_locks was the uncovered table. Record a handled conflict (audit +
  // canonical revert) and advance the sync token instead of letting the throw escape
  // to the outer 'google-import-unhandled' catch, where it would burn retry budget
  // and stall this calendar's incremental sync. Match the UNIQUE message specifically
  // (not the bare table name) so any other slot_locks error still surfaces.
  if (message.includes("UNIQUE constraint failed: slot_locks")) {
    await rejectReservationMoveConflict({
      db: input.db,
      job: input.job,
      reservationId: input.reservation.id,
      event: input.event,
      safeSnapshot: input.safeSnapshot,
      conflictType: "reservation_slot_conflict",
      nowIso: input.nowIso
    });
    return "slot-conflict-handled";
  }
  throw input.error;
};

const acceptReservationGoogleMove = async (input: {
  db: D1Database;
  job: ImportJobRow;
  reservation: ReservationForGoogleMoveRow;
  event: GoogleEvent;
  safeSnapshot: SafeGoogleSnapshot;
  slots: string[];
  nowMs: number;
}) => {
  const googleEtag = isNonEmptyString(input.event.etag, 512) ? input.event.etag : null;
  const googleUpdatedAt = isNonEmptyString(input.event.updated, 64) ? input.event.updated : null;
  const lockStatus = input.reservation.status === "confirmed" ? "confirmed" : "pending";
  const lockExpiresAt = input.reservation.status === "pending_approval" ? input.reservation.pending_expires_at : null;
  const nextVersion = input.reservation.version + 1;
  const notificationAvailableAt = toIso(input.nowMs + 3 * 60 * 1000);
  const nowIso = toIso(input.nowMs);
  const auditMetadataJson = JSON.stringify({
    old_start_at: input.reservation.start_at,
    old_end_at: input.reservation.end_at,
    new_start_at: input.safeSnapshot.start_at,
    new_end_at: input.safeSnapshot.end_at
  });
  const moveGuardBindings = acceptedReservationGoogleMoveBindings({
    reservation: input.reservation,
    safeSnapshot: input.safeSnapshot,
    nextVersion,
    nowIso,
    auditMetadataJson
  });

  const statements = [
    input.db
      .prepare(
        `
          UPDATE reservations
          SET start_at = ?,
              end_at = ?,
              google_event_etag = ?,
              google_sync_state = 'synced',
              version = version + 1,
              updated_by = 'google_calendar',
              updated_at = ?
          WHERE id = ?
            AND status = ?
            AND version = ?
            AND checked_in_at IS NULL
        `
      )
      .bind(
        input.safeSnapshot.start_at,
        input.safeSnapshot.end_at,
        googleEtag,
        nowIso,
        input.reservation.id,
        input.reservation.status,
        input.reservation.version
      ),
    input.db
      .prepare(
        `
          DELETE FROM slot_locks
          WHERE owner_type = 'reservation'
            AND owner_id = ?
            AND EXISTS (${acceptedReservationGoogleMoveExistsSql})
        `
      )
      .bind(input.reservation.id, ...moveGuardBindings),
    input.db
      .prepare(
        `
          DELETE FROM customer_time_locks
          WHERE owner_type = 'reservation'
            AND owner_id = ?
            AND EXISTS (${acceptedReservationGoogleMoveExistsSql})
        `
      )
      .bind(input.reservation.id, ...moveGuardBindings),
    ...upsertGoogleEventForAcceptedReservationMove({
      db: input.db,
      job: input.job,
      safeSnapshot: input.safeSnapshot,
      googleEtag,
      googleUpdatedAt,
      reservationId: input.reservation.id,
      moveGuardBindings,
      nowIso
    })
  ];

  if (input.reservation.status === "confirmed" && input.reservation.line_identity_id) {
    statements.push(
      await buildGoogleMoveNotificationStatement({
        db: input.db,
        reservation: input.reservation,
        availableAt: notificationAvailableAt,
        nextVersion,
        moveGuardBindings
      })
    );
  }

  for (const slotAt of input.slots) {
    statements.push(
      input.db
        .prepare(
          `
            INSERT INTO slot_locks (
              id,
              store_id,
              resource_id,
              slot_at,
              owner_type,
              owner_id,
              lock_status,
              expires_at
            )
            SELECT ?, ?, ?, ?, 'reservation', ?, ?, ?
            WHERE EXISTS (${acceptedReservationGoogleMoveExistsSql})
          `
        )
        .bind(
          crypto.randomUUID(),
          input.reservation.store_id,
          input.reservation.resource_id,
          slotAt,
          input.reservation.id,
          lockStatus,
          lockExpiresAt,
          ...moveGuardBindings
        ),
      input.db
        .prepare(
          `
            INSERT INTO customer_time_locks (
              id,
              customer_id,
              slot_at,
              owner_type,
              owner_id,
              lock_status,
              expires_at,
              phone_hash
            )
            SELECT ?, ?, ?, 'reservation', ?, ?, ?, ${CUSTOMER_TIME_LOCK_PHONE_HASH_SQL}
            WHERE EXISTS (${acceptedReservationGoogleMoveExistsSql})
          `
        )
        .bind(
          crypto.randomUUID(),
          input.reservation.customer_id,
          slotAt,
          input.reservation.id,
          lockStatus,
          lockExpiresAt,
          input.reservation.id,
          ...moveGuardBindings
        )
    );
  }

  statements.push(
    input.db
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
          SELECT ?, 'google_calendar', ?, 'google_reservation_time_changed', 'reservation', ?, ?
          WHERE EXISTS (${acceptedReservationGoogleMoveExistsSql})
        `
      )
      .bind(
        crypto.randomUUID(),
        input.safeSnapshot.google_event_id,
        input.reservation.id,
        auditMetadataJson,
        ...moveGuardBindings
      )
  );

  let results: D1Result[];
  try {
    results = await input.db.batch(statements);
  } catch (error) {
    return classifyReservationMoveBatchError({
      db: input.db,
      job: input.job,
      reservation: input.reservation,
      event: input.event,
      safeSnapshot: input.safeSnapshot,
      nowIso,
      error
    });
  }
  return hasChangedRows(results[0]) ? "accepted" as const : "lost-race" as const;
};

const getGoogleEventMetadata = (event: GoogleEvent) => ({
  googleEtag: isNonEmptyString(event.etag, 512) ? event.etag : null,
  googleUpdatedAt: isNonEmptyString(event.updated, 64) ? event.updated : null
});

const buildActiveReservationGoogleEventStatements = (input: {
  db: D1Database;
  job: ImportJobRow;
  event: GoogleEvent;
  safeSnapshot: SafeGoogleSnapshot;
  reservationId: string;
  nowIso?: string;
}): GoogleEventUpsertStatements => {
  const metadata = getGoogleEventMetadata(input.event);
  return upsertGoogleEvent({
    db: input.db,
    storeId: input.job.store_id,
    calendarId: input.job.calendar_id,
    googleEventId: input.safeSnapshot.google_event_id,
    googleEtag: metadata.googleEtag,
    googleUpdatedAt: metadata.googleUpdatedAt,
    sourceType: "reservation",
    status: "active",
    reservationId: input.reservationId,
    safeSnapshot: input.safeSnapshot,
    nowIso: input.nowIso
  });
};

const rejectReservationMoveConflict = async (input: {
  db: D1Database;
  job: ImportJobRow;
  reservationId: string;
  event: GoogleEvent;
  safeSnapshot: SafeGoogleSnapshot;
  conflictType: string;
  nowIso: string;
}) => {
  await rejectReservationGoogleMove({
    db: input.db,
    job: input.job,
    reservationId: input.reservationId,
    googleEventId: input.safeSnapshot.google_event_id,
    conflictType: input.conflictType,
    event: input.event,
    safeSnapshot: input.safeSnapshot,
    nowIso: input.nowIso
  });
};

const recordSuppressedReservationEcho = async (input: {
  db: D1Database;
  job: ImportJobRow;
  event: GoogleEvent;
  safeSnapshot: SafeGoogleSnapshot;
  reservationId: string;
  nowIso?: string;
}) => {
  // Refactored from .run() to .batch() so the event UPSERT and the history
  // INSERT land in the same atomic call (snapshot history depends on this).
  await input.db.batch([...buildActiveReservationGoogleEventStatements(input)]);
};

const recordUnchangedReservationGoogleEvent = async (input: {
  db: D1Database;
  job: ImportJobRow;
  event: GoogleEvent;
  safeSnapshot: SafeGoogleSnapshot;
  reservationId: string;
  nowIso: string;
  activeOutbound: boolean;
  incomingGoogleEtag: string | null;
}) => {
  const statements: D1PreparedStatement[] = [
    ...buildActiveReservationGoogleEventStatements(input)
  ];
  if (!input.activeOutbound) {
    statements.push(
      queueReservationCanonicalRevert({
        db: input.db,
        reservationId: input.reservationId,
        googleEventId: input.safeSnapshot.google_event_id,
        incomingGoogleEtag: input.incomingGoogleEtag,
        nowIso: input.nowIso
      })
    );
  }
  await input.db.batch(statements);
};

type ReservationMoveValidation =
  | {
      ok: true;
      slots: string[];
    }
  | {
      ok: false;
      conflictType: string;
    };

const validateReservationMoveCandidate = async (input: {
  db: D1Database;
  reservation: ReservationForGoogleMoveRow;
  safeSnapshot: SafeGoogleSnapshot;
}): Promise<ReservationMoveValidation> => {
  if (input.reservation.checked_in_at !== null) {
    return {
      ok: false,
      conflictType: "reservation_checked_in_move_blocked"
    };
  }
  if (!input.safeSnapshot.start_at || !input.safeSnapshot.end_at) {
    return {
      ok: false,
      conflictType: "reservation_invalid_time"
    };
  }

  const startAt = new Date(input.safeSnapshot.start_at);
  const endAt = new Date(input.safeSnapshot.end_at);
  const durationMinutes = (endAt.getTime() - startAt.getTime()) / 60_000;
  if (durationMinutes !== input.reservation.duration_minutes) {
    return {
      ok: false,
      conflictType: "reservation_duration_changed"
    };
  }

  const businessTime = await ensureBusinessTime({
    db: input.db,
    reservation: input.reservation,
    startAt,
    endAt
  });
  if (!businessTime) {
    return {
      ok: false,
      conflictType: "reservation_outside_business_hours"
    };
  }

  const slots = generateSlotTimesForRange(
    new Date(input.safeSnapshot.start_at),
    new Date(input.safeSnapshot.end_at),
    SLOT_INTERVAL_MINUTES,
    { maxSlotsForOverflowSignal: MAX_EXTERNAL_BLOCK_SLOTS }
  );
  if (!slots) {
    return {
      ok: false,
      conflictType: "reservation_invalid_time"
    };
  }

  const conflict = await hasReservationMoveConflict({
    db: input.db,
    reservation: input.reservation,
    slots
  });
  return conflict
    ? {
        ok: false,
        conflictType: "reservation_slot_conflict"
      }
    : {
        ok: true,
        slots
      };
};

// Handle a Google event whose reservation is no longer active (status is not
// pending_approval/confirmed). Extracted from processReservationGoogleEvent to
// keep that function's cognitive complexity in check (SonarCloud S3776). Every
// path is terminal for the import event, so the caller returns once this runs.
const handleNonActiveReservationGoogleEvent = async (input: {
  db: D1Database;
  job: ImportJobRow;
  event: GoogleEvent;
  safeSnapshot: SafeGoogleSnapshot;
  reservation: ReservationForGoogleMoveRow;
  nowIso: string;
}) => {
  const { reservation } = input;
  if (
    (reservation.status === "completed" || reservation.status === "no_show") &&
    (
      input.safeSnapshot.start_at !== reservation.start_at ||
      input.safeSnapshot.end_at !== reservation.end_at
    )
  ) {
    await rejectReservationMoveConflict({
      db: input.db,
      job: input.job,
      reservationId: reservation.id,
      event: input.event,
      safeSnapshot: input.safeSnapshot,
      conflictType: "reservation_terminal_status_move",
      nowIso: input.nowIso
    });
    return;
  }

  // Codex #14 follow-up — completed/no_show reservations keep their Google
  // Calendar event in place (no delete is queued by the lifecycle), so a
  // staff edit of title/description that leaves start/end unchanged would
  // otherwise sit on the calendar indefinitely. Apply the same etag-based
  // echo check used for active reservations and queue a canonical revert
  // when the incoming event etag does not match our last-written etag.
  // rejected/expired/cancelled_* reservations already have delete jobs
  // queued elsewhere, so leave their suppression as-is — adding a revert
  // would race with the in-flight delete.
  if (reservation.status === "completed" || reservation.status === "no_show") {
    const terminalIncomingEtag = isNonEmptyString(input.event.etag, 512) ? input.event.etag : null;
    const terminalEcho = await hasActiveReservationOutboundWrite({
      db: input.db,
      job: input.job,
      reservationId: reservation.id,
      googleEventId: input.safeSnapshot.google_event_id,
      googleEventEtag: terminalIncomingEtag
    });
    if (!terminalEcho) {
      await input.db.batch([
        ...buildActiveReservationGoogleEventStatements({
          db: input.db,
          job: input.job,
          event: input.event,
          safeSnapshot: input.safeSnapshot,
          reservationId: reservation.id,
          nowIso: input.nowIso
        }),
        queueReservationCanonicalRevert({
          db: input.db,
          reservationId: reservation.id,
          googleEventId: input.safeSnapshot.google_event_id,
          incomingGoogleEtag: terminalIncomingEtag,
          nowIso: input.nowIso
        })
      ]);
      return;
    }
  }

  await recordSuppressedReservationEcho({
    db: input.db,
    job: input.job,
    event: input.event,
    safeSnapshot: input.safeSnapshot,
    reservationId: reservation.id
  });
};

const processReservationGoogleEvent = async (input: {
  db: D1Database;
  job: ImportJobRow;
  event: GoogleEvent;
  safeSnapshot: SafeGoogleSnapshot;
  reservationId: string;
  editModeEnabled: boolean;
  nowMs: number;
}) => {
  const nowIso = toIso(input.nowMs);
  const reservation = await fetchReservationForGoogleMove({
    db: input.db,
    job: input.job,
    reservationId: input.reservationId,
    googleEventId: input.safeSnapshot.google_event_id
  });
  if (!reservation) {
    await recordReservationMarkerMismatch({
      db: input.db,
      job: input.job,
      event: input.event,
      safeSnapshot: input.safeSnapshot,
      reservationId: input.reservationId
    });
    return undefined;
  }

  if (reservation.status !== "pending_approval" && reservation.status !== "confirmed") {
    await handleNonActiveReservationGoogleEvent({
      db: input.db,
      job: input.job,
      event: input.event,
      safeSnapshot: input.safeSnapshot,
      reservation,
      nowIso
    });
    return undefined;
  }

  const incomingEtagForOutbound = isNonEmptyString(input.event.etag, 512) ? input.event.etag : null;
  const activeOutbound = await hasActiveReservationOutboundWrite({
    db: input.db,
    job: input.job,
    reservationId: reservation.id,
    googleEventId: input.safeSnapshot.google_event_id,
    googleEventEtag: incomingEtagForOutbound
  });
  const resolvedConflict = await hasResolvedReservationConflict({
    db: input.db,
    job: input.job,
    reservationId: reservation.id,
    googleEventId: input.safeSnapshot.google_event_id
  });
  if (shouldSuppressRevertEcho({
    activeOutbound,
    resolvedConflict,
    reservation,
    safeSnapshot: input.safeSnapshot
  })) {
    await recordSuppressedReservationEcho({
      db: input.db,
      job: input.job,
      event: input.event,
      safeSnapshot: input.safeSnapshot,
      reservationId: reservation.id
    });
    return undefined;
  }

  if (
    input.safeSnapshot.start_at === reservation.start_at &&
    input.safeSnapshot.end_at === reservation.end_at
  ) {
    await recordUnchangedReservationGoogleEvent({
      db: input.db,
      job: input.job,
      event: input.event,
      safeSnapshot: input.safeSnapshot,
      reservationId: reservation.id,
      nowIso,
      activeOutbound,
      incomingGoogleEtag: incomingEtagForOutbound
    });
    return undefined;
  }

  if (!input.editModeEnabled) {
    await rejectReservationMoveConflict({
      db: input.db,
      job: input.job,
      reservationId: reservation.id,
      event: input.event,
      safeSnapshot: input.safeSnapshot,
      conflictType: "reservation_edit_mode_disabled",
      nowIso
    });
    return undefined;
  }

  const move = await validateReservationMoveCandidate({
    db: input.db,
    reservation,
    safeSnapshot: input.safeSnapshot
  });
  if (!move.ok) {
    await rejectReservationMoveConflict({
      db: input.db,
      job: input.job,
      reservationId: reservation.id,
      event: input.event,
      safeSnapshot: input.safeSnapshot,
      conflictType: move.conflictType,
      nowIso
    });
    return undefined;
  }

  const accepted = await acceptReservationGoogleMove({
    db: input.db,
    job: input.job,
    reservation,
    event: input.event,
    safeSnapshot: input.safeSnapshot,
    slots: move.slots,
    nowMs: input.nowMs
  });
  if (accepted === "lost-race") {
    return "reservation-move-lost-race";
  }
  // "accepted" or a handled conflict outcome — all are
  // terminal handled outcomes for this import event, so the sync token can advance
  // and the import job is not retried (PR #27 review feedback Codex P2 follow-up).
  return undefined;
};

const recordIgnoredGoogleEvent = async (input: {
  db: D1Database;
  job: ImportJobRow;
  event: GoogleEvent;
  safeSnapshot: SafeGoogleSnapshot;
  status: "ignored" | "conflict";
  conflictType?: string;
  nowIso?: string;
}) => {
  const googleEventId = input.safeSnapshot.google_event_id;
  const googleEtag = isNonEmptyString(input.event.etag, 512) ? input.event.etag : null;
  const googleUpdatedAt = isNonEmptyString(input.event.updated, 64) ? input.event.updated : null;
  const statements: D1PreparedStatement[] = [
    ...upsertGoogleEvent({
      db: input.db,
      storeId: input.job.store_id,
      calendarId: input.job.calendar_id,
      googleEventId,
      googleEtag,
      googleUpdatedAt,
      sourceType: "unknown",
      status: input.status,
      safeSnapshot: input.safeSnapshot,
      nowIso: input.nowIso
    })
  ];

  if (input.conflictType) {
    statements.push(
      input.db
        .prepare(
          `
              INSERT INTO google_calendar_conflicts (
                id,
                store_id,
                calendar_id,
                google_event_id,
                conflict_type,
                google_safe_snapshot_json,
                resolution_status
              )
              SELECT ?, ?, ?, ?, ?, ?, 'open'
              WHERE NOT EXISTS (
                SELECT 1
                FROM google_calendar_conflicts
                WHERE calendar_id = ?
                  AND google_event_id = ?
                  AND conflict_type = ?
                  AND resolution_status = 'open'
              )
            `
          )
          .bind(
            crypto.randomUUID(),
            input.job.store_id,
            input.job.calendar_id,
            googleEventId,
            input.conflictType,
            JSON.stringify(buildConflictSnapshot(input.safeSnapshot, input.event)),
            input.job.calendar_id,
            googleEventId,
            input.conflictType
          )
      );
  }

  await input.db.batch(statements);
};

// A delete we issued ourselves comes back through the full walk as a tombstone
// (the walk asks for showDeleted=true). By then the ledger row is
// status='deleted' and reservations.google_event_id is NULL, so
// fetchReservationForGoogleMove matches neither of its two arms and every
// ordinary deletion opened a reservation_marker_mismatch that staff had to
// clear by hand (#600).
//
// The suppression keys on google_calendar_events, NOT on
// google_calendar_outbound_writes: outbound rows expire after 24h while Google
// keeps tombstones for about 30 days, so an outbound-based check would let the
// false conflict reappear the next day.
//
// status='deleted' alone is NOT proof that we deleted it — the orphan sweep
// (step 7 of the full walk) writes the same value to every row it has not seen
// for ORPHAN_GRACE_SECONDS, keeping reservation_id and source_type intact. An
// attacker with calendar write access could push a live reservation event out
// of the events.list window, let the daily full reconcile sweep its ledger row
// to 'deleted', then bring the event back and delete it — and a ledger-only
// check would swallow the deletion of a *confirmed* reservation's event.
// So the reservation must also have let go of this event id: after a delete we
// issued, reservations.google_event_id is NULL (or already points at a newer
// event). A row the sweep touched still has the reservation pointing at it, and
// that case stays fail-closed.
//
// Only the cancelled branch calls this. A *confirmed* event carrying a marker we
// cannot match is a restored old event and has to stay fail-closed, which is why
// processReservationGoogleEvent still calls recordReservationMarkerMismatch
// directly.
const recordReservationTombstoneOrMarkerMismatch = async (input: {
  db: D1Database;
  job: ImportJobRow;
  event: GoogleEvent;
  safeSnapshot: SafeGoogleSnapshot;
  reservationId: string;
  nowIso: string;
}) => {
  const googleEventId = input.safeSnapshot.google_event_id;
  const ownDeletion = await input.db
    .prepare(
      `SELECT 1 AS found FROM google_calendar_events
       WHERE calendar_id = ?
         AND google_event_id = ?
         AND reservation_id = ?
         AND source_type = 'reservation'
         AND status = 'deleted'
         AND NOT EXISTS (
           SELECT 1
           FROM reservations
           WHERE reservations.id = ?
             AND reservations.google_event_id = ?
         )
       LIMIT 1`
    )
    .bind(
      input.job.calendar_id,
      googleEventId,
      input.reservationId,
      input.reservationId,
      googleEventId
    )
    .first<{ found: number }>();

  if (!ownDeletion) {
    await recordReservationMarkerMismatch({
      db: input.db,
      job: input.job,
      event: input.event,
      safeSnapshot: input.safeSnapshot,
      reservationId: input.reservationId
    });
    return;
  }

  // Same end state as the approved_as_cancel branch of
  // recordReservationEventDeletion: refresh the ledger row so the orphan sweep
  // keeps seeing it via last_seen_at, and create no conflict, no restore job and
  // no reservation update.
  await input.db.batch([
    ...upsertGoogleEvent({
      db: input.db,
      storeId: input.job.store_id,
      calendarId: input.job.calendar_id,
      googleEventId,
      googleEtag: isNonEmptyString(input.event.etag, 512) ? input.event.etag : null,
      googleUpdatedAt: isNonEmptyString(input.event.updated, 64) ? input.event.updated : null,
      sourceType: "reservation",
      status: "deleted",
      reservationId: input.reservationId,
      safeSnapshot: input.safeSnapshot,
      nowIso: input.nowIso
    })
  ]);

  // After the write, not before: an outcome:"success" logged ahead of the batch
  // would still read as success if D1 rejected it, inflating the suppression
  // count exactly when something is wrong. The suppression writes no conflict
  // and no audit row, so this line is the only place the decision is visible to
  // an operator asking why marker conflicts stopped appearing.
  logGoogleEvent({
    event_type: "import_reservation_marker_mismatch_suppressed",
    outcome: "success",
    calendar_id: input.job.calendar_id,
    store_id: input.job.store_id,
    conflict_type: "reservation_marker_mismatch"
  });
};

const processGoogleEvent = async (input: {
  db: D1Database;
  job: ImportJobRow;
  resourceId: string;
  event: GoogleEvent;
  editModeEnabled: boolean;
  nowMs: number;
}) => {
  const safeSnapshot = createSafeSnapshot(input.event);
  if (!safeSnapshot) {
    return undefined;
  }

  const nowIso = toIso(input.nowMs);
  const reservationId = getReservationMarker(input.event);
  if (safeSnapshot.status === "cancelled") {
    if (reservationId) {
      const reservation = await fetchReservationForGoogleMove({
        db: input.db,
        job: input.job,
        reservationId,
        googleEventId: safeSnapshot.google_event_id
      });
      if (!reservation) {
        await recordReservationTombstoneOrMarkerMismatch({
          db: input.db,
          job: input.job,
          event: input.event,
          safeSnapshot,
          reservationId,
          nowIso
        });
        return undefined;
      }
      await recordReservationEventDeletion({
        db: input.db,
        job: input.job,
        event: input.event,
        safeSnapshot,
        reservationId: reservation.id,
        nowIso
      });
      return undefined;
    }

    const reservation = await fetchReservationByGoogleEvent({
      db: input.db,
      job: input.job,
      googleEventId: safeSnapshot.google_event_id
    });
    if (reservation) {
      await recordReservationEventDeletion({
        db: input.db,
        job: input.job,
        event: input.event,
        safeSnapshot,
        reservationId: reservation.id,
        nowIso
      });
      return undefined;
    }

    await cancelExternalBlock({
      db: input.db,
      job: input.job,
      event: input.event,
      safeSnapshot,
      nowIso
    });
    return undefined;
  }

  if (reservationId) {
    return processReservationGoogleEvent({
      db: input.db,
      job: input.job,
      event: input.event,
      safeSnapshot,
      reservationId,
      editModeEnabled: input.editModeEnabled,
      nowMs: input.nowMs
    });
  }

  if (safeSnapshot.transparency === "transparent") {
    await recordIgnoredGoogleEvent({
      db: input.db,
      job: input.job,
      event: input.event,
      safeSnapshot,
      status: "ignored"
    });
    return undefined;
  }

  if (safeSnapshot.all_day || safeSnapshot.recurring) {
    await recordIgnoredGoogleEvent({
      db: input.db,
      job: input.job,
      event: input.event,
      safeSnapshot,
      status: "conflict",
      conflictType: safeSnapshot.all_day ? "google_all_day_event" : "google_recurring_event"
    });
    return undefined;
  }

  return importExternalBlock({
    db: input.db,
    job: input.job,
    resourceId: input.resourceId,
    event: input.event,
    safeSnapshot,
    nowIso
  });
};

const updateChannelSyncToken = async (input: {
  db: D1Database;
  job: ImportJobRow;
  claim: ImportJobClaim;
  channelId: string | null;
  syncToken: string | null;
  reason: ImportJobRow["reason"];
  nowMs: number;
}) => {
  if (!input.channelId || !input.syncToken) {
    return true;
  }

  const result = await input.db
    .prepare(
      `
        UPDATE google_calendar_channels
        SET sync_token = ?,
            last_incremental_sync_at = CASE
              WHEN ? = 'full_reconcile' THEN last_incremental_sync_at
              ELSE ?
            END,
            last_full_reconcile_at = CASE
              WHEN ? = 'full_reconcile' THEN ?
              ELSE last_full_reconcile_at
            END,
            updated_at = ?
        WHERE id = ?
          AND EXISTS (${importJobClaimExistsSql})
      `
    )
    .bind(
      input.syncToken,
      input.reason,
      toIso(input.nowMs),
      input.reason,
      toIso(input.nowMs),
      toIso(input.nowMs),
      input.channelId,
      ...importJobClaimBindings(input.job, input.claim)
    )
    .run();
  return hasChangedRows(result);
};

const queueFullReconcile = async (input: {
  db: D1Database;
  job: ImportJobRow;
  claim: ImportJobClaim;
  channelId: string | null;
  nowMs: number;
}) => {
  if (!(await importJobClaimExists(input.db, input.job, input.claim))) {
    return false;
  }

  const nowIso = toIso(input.nowMs);
  const nextRunAt = toIso(input.nowMs + FULL_RECONCILE_DELAY_MS);
  const fullReconcileDedupeKey = compactDedupeKey(
    `${input.job.calendar_id}:full_reconcile:sync_token_expired`,
    "google-import:sync-token-expired"
  );
  const statements = [
    input.db
      .prepare(
        `
          INSERT INTO google_calendar_import_jobs (
            id,
            store_id,
            calendar_id,
            reason,
            status,
            next_run_at,
            dedupe_key,
            updated_at
          )
          SELECT ?, ?, ?, 'full_reconcile', 'queued', ?, ?, ?
          WHERE EXISTS (${importJobClaimExistsSql})
          ON CONFLICT(dedupe_key) DO UPDATE SET
            store_id = excluded.store_id,
            calendar_id = excluded.calendar_id,
            reason = excluded.reason,
            status = 'queued',
            next_run_at = excluded.next_run_at,
            locked_until = NULL,
            attempt_count = 0,
            last_error = NULL,
            resume_page_token = NULL,
            resume_processed_count = 0,
            resume_sweep_start_seconds = NULL,
            resume_time_min = NULL,
            resume_yield_count = 0,
            updated_at = excluded.updated_at
          WHERE google_calendar_import_jobs.status IN ('succeeded', 'failed', 'dead')
            AND EXISTS (${importJobClaimExistsSql})
        `
      )
      .bind(
        crypto.randomUUID(),
        input.job.store_id,
        input.job.calendar_id,
        nextRunAt,
        fullReconcileDedupeKey,
        nowIso,
        ...importJobClaimBindings(input.job, input.claim),
        ...importJobClaimBindings(input.job, input.claim)
      )
  ];

  if (input.channelId) {
    statements.push(
      input.db
        .prepare(
          `
            UPDATE google_calendar_channels
            SET sync_token = NULL,
                updated_at = ?
            WHERE id = ?
              AND EXISTS (${importJobClaimExistsSql})
              AND EXISTS (
                SELECT 1
                FROM google_calendar_import_jobs
                WHERE dedupe_key = ?
                  AND calendar_id = ?
                  AND reason = 'full_reconcile'
                  AND status IN ('queued', 'retryable', 'processing')
              )
          `
        )
        .bind(
          nowIso,
          input.channelId,
          ...importJobClaimBindings(input.job, input.claim),
          fullReconcileDedupeKey,
          input.job.calendar_id
        )
    );
  }

  await input.db.batch(statements);
  const runnableFullReconcileJob = await input.db
    .prepare(
      `
        SELECT id
        FROM google_calendar_import_jobs
        WHERE dedupe_key = ?
          AND calendar_id = ?
          AND reason = 'full_reconcile'
          AND status IN ('queued', 'retryable', 'processing')
        LIMIT 1
      `
    )
    .bind(fullReconcileDedupeKey, input.job.calendar_id)
    .first<{ id: string }>();
  return Boolean(runnableFullReconcileJob);
};

// Reroute a broken/absent sync_token to the bounded, checkpoint-capable
// full_reconcile recovery instead of walking events inline. Shared by the 410
// sync-token-EXPIRED path (handleEventsListFailure) and the pre-request
// sync-token-MISSING guard in runImportJob — both want the identical recovery
// (queue one full_reconcile under the shared dedupe key, then report whether
// the claim survived and the queue is runnable). errorClass is the only thing
// that differs so logs/alerts can tell the two triggers apart.
const rerouteToFullReconcile = async (input: {
  db: D1Database;
  job: ImportJobRow;
  claim: ImportJobClaim;
  channelId: string | null;
  nowMs: number;
  errorClass: GoogleErrorClass;
}): Promise<ImportJobRunResult> => {
  logGoogleEvent({
    event_type: "import_sync_token_invalid",
    outcome: "failure",
    calendar_id: input.job.calendar_id,
    store_id: input.job.store_id,
    error_class: input.errorClass
  });

  const fullReconcileQueued = await queueFullReconcile({
    db: input.db,
    job: input.job,
    claim: input.claim,
    channelId: input.channelId,
    nowMs: input.nowMs
  });
  if (!(await importJobClaimExists(input.db, input.job, input.claim))) {
    return {
      ok: false,
      reason: "google-import-claim-lost",
      fullSyncQueued: false
    };
  }
  if (!fullReconcileQueued) {
    return {
      ok: false,
      reason: "google-full-reconcile-not-runnable",
      fullSyncQueued: false
    };
  }
  return {
    ok: true,
    fullSyncQueued: true,
    nextSyncToken: null
  };
};

const handleEventsListFailure = async (input: {
  db: D1Database;
  job: ImportJobRow;
  claim: ImportJobClaim;
  channelId: string | null;
  eventsPage: Extract<EventsListPage, { ok: false }>;
  nowMs: number;
}): Promise<ImportJobRunResult> => {
  if (!input.eventsPage.syncTokenExpired) {
    return {
      ok: false,
      reason: input.eventsPage.reason,
      fullSyncQueued: false
    };
  }

  return rerouteToFullReconcile({
    db: input.db,
    job: input.job,
    claim: input.claim,
    channelId: input.channelId,
    nowMs: input.nowMs,
    errorClass: "sync_token_invalid"
  });
};

const processEventsListItems = async (input: {
  db: D1Database;
  job: ImportJobRow;
  resourceId: string;
  events: GoogleEvent[];
  editModeEnabled: boolean;
  nowMs: number;
}) => {
  for (const event of input.events) {
    const failure = await processGoogleEvent({
      db: input.db,
      job: input.job,
      resourceId: input.resourceId,
      event,
      editModeEnabled: input.editModeEnabled,
      nowMs: input.nowMs
    });
    if (failure) {
      return failure;
    }
  }
  return undefined;
};

// Outcome for a full_reconcile attempt that wants to stop early with more
// pages remaining (soft deadline hit, or the per-attempt page cap reached).
// Enforces the yield budget, then parks the job attempt-free via
// markJobYielded. The checkpoint for every completed page was already
// persisted inside the page loop.
const yieldReconcileAttempt = async (input: {
  db: D1Database;
  job: ImportJobRow;
  claim: ImportJobClaim;
  nowMs: number;
}): Promise<ImportJobRunResult> => {
  if (input.job.resume_yield_count >= MAX_RECONCILE_YIELDS) {
    // Pathologically long/looping pagination: stop riding free yields and
    // consume attempts so the job can still reach dead-letter.
    return {
      ok: false,
      reason: "google-reconcile-yield-budget-exhausted",
      fullSyncQueued: false
    };
  }
  const parked = await markJobYielded(input.db, input.job, input.claim, input.nowMs);
  if (!parked) {
    return {
      ok: false,
      reason: "google-import-claim-lost",
      fullSyncQueued: false
    };
  }
  return {
    ok: false,
    reason: "google-reconcile-yielded",
    fullSyncQueued: false,
    yielded: true
  };
};

// Routes a failed events.list page to the right terminal result. A dead
// resume pageToken (Google 400/410 on pageToken) clears the checkpoint and
// fails normally (attempt consumed) so the next attempt restarts from page 1
// with a fresh timeMin window — deliberately NOT routed through
// handleEventsListFailure, which is for syncToken expiry and would NULL the
// channel sync_token and enqueue a recovery full_reconcile.
const handleEventsPageFailure = async (
  input: {
    db: D1Database;
    job: ImportJobRow;
    claim: ImportJobClaim;
    channelId: string | null;
    nowMs: number;
  },
  eventsPage: Extract<EventsListPage, { ok: false }>
): Promise<ImportJobRunResult> => {
  if (eventsPage.pageTokenInvalid) {
    await clearImportResumeCheckpoint(input.db, input.job, input.claim, input.nowMs);
    return {
      ok: false,
      reason: eventsPage.reason,
      fullSyncQueued: false
    };
  }
  return handleEventsListFailure({
    db: input.db,
    job: input.job,
    claim: input.claim,
    channelId: input.channelId,
    eventsPage,
    nowMs: input.nowMs
  });
};

// Checkpoints one completed page of a resumable walk and decides whether the
// attempt keeps going. Returns null to continue with the next page, otherwise
// a terminal result: a no-progress failure (a "next" token identical to the
// one this page was fetched with means the walk is not advancing — consume
// the attempt instead of looping on free yields), a lost claim, or a
// cooperative yield once the soft deadline has passed (the progress guard
// holds because a checkpoint for this attempt was just persisted).
const checkpointResumableWalkPage = async (input: {
  db: D1Database;
  job: ImportJobRow;
  claim: ImportJobClaim;
  isResumableWalk: boolean;
  pageToken: string | null;
  nextPageToken: string;
  processedEventCount: number;
  sweepStartSeconds: number | null;
  timeMinIso: string | null;
  claimStartMs: number;
  now: () => number;
  nowMs: number;
}): Promise<ImportJobRunResult | null> => {
  if (!input.isResumableWalk) {
    return null;
  }
  if (input.nextPageToken === input.pageToken) {
    return {
      ok: false,
      reason: "google-reconcile-no-progress",
      fullSyncQueued: false
    };
  }
  const persisted = await persistImportResumeCheckpoint({
    db: input.db,
    row: input.job,
    claim: input.claim,
    pageToken: input.nextPageToken,
    processedCount: input.processedEventCount,
    sweepStartSeconds: input.sweepStartSeconds,
    timeMinIso: input.timeMinIso,
    nowMs: input.nowMs
  });
  if (!persisted) {
    return {
      ok: false,
      reason: "google-import-claim-lost",
      fullSyncQueued: false
    };
  }
  if (input.now() - input.claimStartMs > IMPORT_SOFT_DEADLINE_MS) {
    return yieldReconcileAttempt({
      db: input.db,
      job: input.job,
      claim: input.claim,
      nowMs: input.nowMs
    });
  }
  return null;
};

const runImportEventPages = async (input: {
  db: D1Database;
  job: ImportJobRow;
  claim: ImportJobClaim;
  channelId: string | null;
  syncToken: string | null;
  resourceId: string;
  accessToken: string;
  fetcher: typeof fetch;
  editModeEnabled: boolean;
  nowMs: number;
  now: () => number;
  timeMinIso: string | null;
  sweepStartSeconds: number | null;
}): Promise<ImportJobRunResult> => {
  // Only the scheduled full reconcile is resumable: it is the one walk big
  // enough to outgrow a single claim budget, and its sweep anchor semantics
  // are designed for cross-attempt continuation.
  const isResumableWalk = input.job.reason === "full_reconcile";
  let pageToken: string | null = null;
  let processedEventCount = 0;
  if (isResumableWalk) {
    pageToken = input.job.resume_page_token;
    processedEventCount = input.job.resume_processed_count;
  }
  let nextSyncToken: string | null = null;
  let pagesCompletedThisAttempt = 0;
  const claimStartMs = input.nowMs;
  // Small pages only where the checkpoint/yield machinery can use the page
  // boundaries; a non-resumable initial sync keeps Google's max so its
  // reachable calendar size is not shrunk by the page cap.
  const pageSize = isResumableWalk ? FULL_WALK_PAGE_SIZE : INITIAL_WALK_PAGE_SIZE;

  for (let page = 0; page < MAX_EVENTS_LIST_PAGES; page += 1) {
    const eventsPage = await fetchEventsListPage({
      calendarId: input.job.calendar_id,
      syncToken: input.syncToken,
      pageToken,
      timeMinIso: input.timeMinIso,
      pageSize,
      accessToken: input.accessToken,
      fetcher: input.fetcher
    });

    if (!eventsPage.ok) {
      return handleEventsPageFailure(input, eventsPage);
    }

    const failure = await processEventsListItems({
      db: input.db,
      job: input.job,
      resourceId: input.resourceId,
      events: eventsPage.items,
      editModeEnabled: input.editModeEnabled,
      nowMs: input.nowMs
    });
    if (failure) {
      return {
        ok: false,
        reason: failure,
        fullSyncQueued: false
      };
    }

    processedEventCount += eventsPage.items.filter(isValidGoogleEventId).length;
    nextSyncToken = eventsPage.nextSyncToken ?? nextSyncToken;
    if (!eventsPage.nextPageToken) {
      return {
        ok: true,
        fullSyncQueued: false,
        nextSyncToken,
        processedEventCount
      };
    }

    const interrupted = await checkpointResumableWalkPage({
      db: input.db,
      job: input.job,
      claim: input.claim,
      isResumableWalk,
      pageToken,
      nextPageToken: eventsPage.nextPageToken,
      processedEventCount,
      sweepStartSeconds: input.sweepStartSeconds,
      timeMinIso: input.timeMinIso,
      claimStartMs,
      now: input.now,
      nowMs: input.nowMs
    });
    if (interrupted) {
      return interrupted;
    }
    pagesCompletedThisAttempt += 1;

    pageToken = eventsPage.nextPageToken;
  }

  if (isResumableWalk && pagesCompletedThisAttempt > 0) {
    // Per-attempt page cap reached with more pages remaining: yield with the
    // checkpoint pointing at the next page instead of failing the walk.
    return yieldReconcileAttempt({
      db: input.db,
      job: input.job,
      claim: input.claim,
      nowMs: input.nowMs
    });
  }

  return {
    ok: false,
    reason: "google-events-pagination-incomplete",
    fullSyncQueued: false
  };
};

// Step 3 — drift threshold alert logic extracted to
// drift-threshold-alert.ts. The evaluateDriftThreshold function handles
// threshold evaluation + feature-flag gating + LINE fan-out.

// Resolve the drift/orphan sweep anchor for a job. A mid-walk full_reconcile
// resume MUST reuse the anchor captured at the ORIGINAL walk start (or stay
// disabled if that capture failed) — a fresh anchor would shift the orphan
// cutoff past events earlier attempts already saw and falsely delete them.
// Extracted from runImportJob to bound its cognitive complexity (SonarCloud
// S3776).
const resolveFullReconcileSweepAnchor = async (input: {
  db: D1Database;
  job: ImportJobRow;
  isFullReconcile: boolean;
  resuming: boolean;
  captureSweepStart: DriftDeps["captureSweepStart"];
}): Promise<{ sweepStartSeconds: number | null; driftCaptureFailed: boolean }> => {
  if (!input.isFullReconcile) {
    return { sweepStartSeconds: null, driftCaptureFailed: false };
  }
  if (input.resuming) {
    // Mid-walk resume must NEVER capture a fresh anchor: pages processed by
    // earlier attempts updated last_seen_at at the original walk time, so a
    // newer anchor would shift the orphan cutoff past them and falsely
    // delete events the walk already saw. If the original capture failed
    // (NULL checkpoint anchor), keep drift/orphan sweep disabled for the
    // whole walk instead of mixing anchors.
    if (input.job.resume_sweep_start_seconds === null) {
      return { sweepStartSeconds: null, driftCaptureFailed: true };
    }
    return { sweepStartSeconds: input.job.resume_sweep_start_seconds, driftCaptureFailed: false };
  }
  try {
    const sweepStartSeconds = await (input.captureSweepStart ?? captureSweepStartSeconds)(input.db);
    return { sweepStartSeconds, driftCaptureFailed: false };
  } catch (error) {
    safeCaptureException(error, {
      tags: { google_module: "import-sync", operation: "capture_sweep_start" },
      contexts: { d1_query: { store_id: input.job.store_id, job_reason: input.job.reason } }
    });
    return { sweepStartSeconds: null, driftCaptureFailed: true };
  }
};

// Post-walk full_reconcile bookkeeping: drift threshold evaluation then orphan
// sweep. Extracted from runImportJob to bound its cognitive complexity
// (SonarCloud S3776). Every failure here is logged and swallowed — neither
// step fails the import attempt.
const runFullReconcilePostWalk = async (input: {
  db: D1Database;
  env: GoogleCalendarImportEnv;
  job: ImportJobRow;
  nowMs: number;
  sweepStartSeconds: number | null;
  driftCaptureFailed: boolean;
  processedEventCount: number;
  computeDrift: DriftDeps["computeDrift"];
}) => {
  if (input.driftCaptureFailed || input.sweepStartSeconds === null) {
    logGoogleEvent({
      event_type: "google_drift_check_failed",
      outcome: "failure",
      calendar_id: input.job.calendar_id,
      store_id: input.job.store_id,
      error_class: "unexpected"
    });
  } else {
    try {
      const counts = await (input.computeDrift ?? computeCalendarDrift)({
        db: input.db,
        storeId: input.job.store_id,
        calendarId: input.job.calendar_id,
        googleSweepCount: input.processedEventCount,
        sweepStartSeconds: input.sweepStartSeconds
      });
      // Step 3: evaluate drift against threshold and conditionally
      // enqueue LINE notifications (feature-flagged).
      await evaluateDriftThreshold({
        db: input.db,
        env: input.env,
        storeId: input.job.store_id,
        calendarId: input.job.calendar_id,
        googleCount: counts.googleSweepCount,
        d1Count: counts.d1SweepCount,
        drift: counts.drift,
        nowMs: input.nowMs
      });
    } catch (error) {
      safeCaptureException(error, {
        tags: { google_module: "import-sync", operation: "drift_check" },
        contexts: { d1_query: { calendar_id: input.job.calendar_id, store_id: input.job.store_id } }
      });
      logGoogleEvent({
        event_type: "google_drift_check_failed",
        outcome: "failure",
        calendar_id: input.job.calendar_id,
        store_id: input.job.store_id,
        error_class: "unexpected"
      });
    }
  }

  // Step 7 — orphan sweep (docs/plans/orphan-detection.md Option B).
  // After the full_reconcile page walk completes, transition any
  // google_calendar_events rows last seen >ORPHAN_GRACE_SECONDS ago to
  // status='deleted'. These rows fell outside the events.list window
  // (Google's ~90 day cutoff) and would otherwise occupy `active` row
  // scans forever. We do NOT hard-delete — audit history must survive.
  //
  // Race safety: the grace period (60 minutes) is wide enough that any
  // in-flight push-import path with a stale `last_seen_at` will either
  // win or lose cleanly; concurrent webhooks land after the grace cutoff
  // and update last_seen_at to a current value before this UPDATE
  // evaluates its WHERE clause.
  //
  // Gated on a successful drift capture (`sweepStartSeconds !== null`)
  // because the same sweep instant anchors the orphan cutoff; if drift
  // capture failed we cannot trust any timestamp comparison this tick.
  if (!input.driftCaptureFailed && input.sweepStartSeconds !== null) {
    try {
      const orphanCutoffSeconds = input.sweepStartSeconds - ORPHAN_GRACE_SECONDS;
      // The codebase has two coexisting last_seen_at formats:
      //   - ISO with T+Z suffix (`new Date().toISOString()`), written by
      //     test fixtures and some newer writers.
      //   - SQLite CURRENT_TIMESTAMP (`'YYYY-MM-DD HH:MM:SS'`, space
      //     separator, no Z), written by the upsertGoogleEvent path.
      // A raw string compare between these two breaks both ways: 'T'
      // (0x54) > ' ' (0x20), so an ISO row sorts AFTER a CURRENT_TIMESTAMP
      // row at the same wall-clock instant. Normalizing both sides with
      // SQLite's datetime() function reduces both to 'YYYY-MM-DD HH:MM:SS'
      // so the cutoff compare is wall-clock honest regardless of which
      // writer touched the row last.
      // last_seen_at is stamped via SQLite's CURRENT_TIMESTAMP so the
      // value lives in the same format upsertGoogleEvent and the rest of
      // the production writers use ('YYYY-MM-DD HH:MM:SS'). Mixing
      // formats here would not break the orphan sweep itself (the WHERE
      // datetime() normalizes both sides), but downstream sites that
      // compare last_seen_at as a raw string (e.g. drift counting) would
      // see the freshly-swept rows mis-ordered if we stamped them with
      // toISOString(). Keeping the production format wins both ways.
      const sweepResult = await input.db
        .prepare(
          `UPDATE google_calendar_events
             SET status = 'deleted', last_seen_at = CURRENT_TIMESTAMP
             WHERE store_id = ?
               AND calendar_id = ?
               AND status != 'deleted'
               AND datetime(last_seen_at) < datetime(?, 'unixepoch')`
        )
        .bind(input.job.store_id, input.job.calendar_id, orphanCutoffSeconds)
        .run();
      const sweptCount = Number(sweepResult.meta?.changes ?? 0);
      if (sweptCount > 0) {
        logGoogleEvent({
          event_type: "google_orphan_swept",
          // D1 is mutated (rows transition to status='deleted'), so
          // "success" matches the rest of the codebase's verb usage —
          // "noop" was misleading because the sweep DID write changes.
          outcome: "success",
          calendar_id: input.job.calendar_id,
          store_id: input.job.store_id,
          swept_count: sweptCount,
          grace_seconds: ORPHAN_GRACE_SECONDS
        });
      }
    } catch (error) {
      safeCaptureException(error, {
        tags: { google_module: "import-sync", operation: "orphan_sweep" },
        contexts: { d1_query: { calendar_id: input.job.calendar_id, store_id: input.job.store_id } }
      });
      // Surface the error message (sanitized by the logger) so operators
      // can distinguish between SQL-level failures (constraint /
      // permission) and D1 transport failures. error_message goes
      // through the same redactor as other strings before landing in
      // Cloudflare Logs.
      const message = error instanceof Error ? error.message : String(error);
      logGoogleEvent({
        event_type: "google_orphan_sweep_failed",
        outcome: "failure",
        calendar_id: input.job.calendar_id,
        store_id: input.job.store_id,
        error_class: "unexpected",
        error_message: message
      });
    }
  } else {
    // No trusted sweep anchor this tick: either drift capture failed, or a
    // mid-walk resume is carrying forward a NULL anchor from a prior failed
    // capture. Emit a DISTINCT event — not the generic google_drift_check_failed
    // above, which also fires when computeDrift throws — so that repeatedly
    // skipping the orphan sweep (which would let stale 'active' rows accrue) is
    // independently alert-able. This does NOT fail the attempt; the next fresh
    // full_reconcile re-captures the anchor and runs the sweep.
    logGoogleEvent({
      event_type: "google_orphan_sweep_skipped",
      outcome: "noop",
      calendar_id: input.job.calendar_id,
      store_id: input.job.store_id
    });
  }
};

const runImportJob = async (input: {
  db: D1Database;
  env: GoogleCalendarImportEnv;
  job: ImportJobRow;
  claim: ImportJobClaim;
  accessToken: string;
  fetcher: typeof fetch;
  nowMs: number;
  now: () => number;
} & DriftDeps) => {
  const channel = await fetchLatestChannel(input.db, input.job);
  const isFullReconcile = input.job.reason === "full_reconcile";
  const syncToken = isFullReconcile ? null : channel?.sync_token ?? null;

  // A non-full_reconcile job (cron_incremental/push/manual) with no usable
  // sync_token (NULL or empty) must NOT fall into a syncToken-LESS INITIAL_WALK
  // run INLINE: up to MAX_EVENTS_LIST_PAGES x INITIAL_WALK_PAGE_SIZE (=25 000)
  // events in a SINGLE claim with no checkpoint and no soft-deadline yield — the
  // exact shape of the 2026-06-18 cron CPU runaway.
  if (!isFullReconcile && !syncToken) {
    if (!channel) {
      // No channel row at all: incremental sync can never converge (there is
      // nowhere to persist a sync_token), so a full_reconcile here would just
      // re-walk the whole calendar every cron. Fail explicitly instead, so the
      // missing channel surfaces via the dead-letter + alert path (watch
      // re-registration) rather than silently churning recovery jobs.
      logGoogleEvent({
        event_type: "import_sync_token_invalid",
        outcome: "failure",
        calendar_id: input.job.calendar_id,
        store_id: input.job.store_id,
        error_class: "sync_token_missing"
      });
      return {
        ok: false as const,
        reason: "google-import-channel-missing",
        fullSyncQueued: false
      };
    }
    // Channel exists but its sync_token is absent (a fresh channel's first sync,
    // or a prior recovery that NULLed it). Reroute to the bounded, resumable
    // full_reconcile recovery (the same path a 410 sync-token-expired takes)
    // BEFORE touching events.list, so the heavy walk runs off-spike with
    // checkpoints instead of racing the 270s claim axe.
    return rerouteToFullReconcile({
      db: input.db,
      job: input.job,
      claim: input.claim,
      channelId: channel.id,
      nowMs: input.nowMs,
      errorClass: "sync_token_missing"
    });
  }

  const resource = await fetchStoreResource(input.db, input.job.store_id);
  if (!resource) {
    return {
      ok: false as const,
      reason: "missing-store-resource",
      fullSyncQueued: false
    };
  }

  const editModeRow = await input.db
    .prepare(`SELECT google_controlled_edit_mode AS mode FROM store_settings WHERE store_id = ?`)
    .bind(input.job.store_id)
    .first<{ mode: number | null }>();
  const editModeEnabled = editModeRow?.mode === 1;

  // A checkpointed full_reconcile resumes mid-walk: both anchors captured at
  // the ORIGINAL walk start must be reused. timeMin because Google pagination
  // requires the exact first-page query on every pageToken request, and the
  // sweep anchor so drift counting / the orphan cutoff stay pinned to when the
  // walk actually began (events seen by earlier attempts keep counting as
  // seen).
  const resuming = isFullReconcile && input.job.resume_page_token !== null;

  const { sweepStartSeconds, driftCaptureFailed } = await resolveFullReconcileSweepAnchor({
    db: input.db,
    job: input.job,
    isFullReconcile,
    resuming,
    captureSweepStart: input.captureSweepStart
  });

  const resumedTimeMin = resuming ? input.job.resume_time_min : null;
  const timeMinIso = syncToken ? null : (resumedTimeMin ?? fullWalkTimeMinIso(input.nowMs));

  const eventsResult = await runImportEventPages({
    db: input.db,
    job: input.job,
    claim: input.claim,
    channelId: channel?.id ?? null,
    syncToken,
    resourceId: resource.id,
    accessToken: input.accessToken,
    fetcher: input.fetcher,
    editModeEnabled,
    nowMs: input.nowMs,
    now: input.now,
    timeMinIso,
    sweepStartSeconds
  });
  if (!eventsResult.ok || eventsResult.fullSyncQueued) {
    return eventsResult;
  }

  const tokenUpdated = await updateChannelSyncToken({
    db: input.db,
    job: input.job,
    claim: input.claim,
    channelId: channel?.id ?? null,
    syncToken: eventsResult.nextSyncToken,
    reason: input.job.reason,
    nowMs: input.nowMs
  });
  if (!tokenUpdated) {
    return {
      ok: false as const,
      reason: "google-import-claim-lost",
      fullSyncQueued: false
    };
  }

  if (input.job.reason === "full_reconcile") {
    await runFullReconcilePostWalk({
      db: input.db,
      env: input.env,
      job: input.job,
      nowMs: input.nowMs,
      sweepStartSeconds,
      driftCaptureFailed,
      processedEventCount: eventsResult.processedEventCount ?? 0,
      computeDrift: input.computeDrift
    });
  }

  return {
    ok: true as const,
    fullSyncQueued: false
  };
};

const processClaimedImportJob = async (input: {
  db: D1Database;
  env: GoogleCalendarImportEnv;
  row: ImportJobRow;
  claim: ImportJobClaim;
  fetcher: typeof fetch;
  accessTokenProvider?: () => Promise<string | undefined>;
  now: () => number;
  nowMs: number;
} & DriftDeps) => {
  try {
    const accessToken = input.accessTokenProvider
      ? await input.accessTokenProvider()
      : await defaultGoogleCalendarAccessTokenProvider(input.env, input.fetcher, input.now);
    if (!accessToken) {
      await markJobFailure(input.db, input.row, input.claim, "google-token-failed", input.nowMs);
      return {
        ok: false as const
      };
    }

    const importResult = await runImportJob({
      db: input.db,
      env: input.env,
      job: input.row,
      claim: input.claim,
      accessToken,
      fetcher: input.fetcher,
      nowMs: input.nowMs,
      now: input.now,
      computeDrift: input.computeDrift,
      captureSweepStart: input.captureSweepStart
    });
    if (!importResult.ok) {
      if ("yielded" in importResult && importResult.yielded) {
        // markJobYielded already parked the job (attempt-free, checkpoint
        // kept). No failure to record — surface yielded so the processDue
        // loop stops claiming for this invocation.
        return {
          ok: false as const,
          yielded: true as const
        };
      }
      await markJobFailure(input.db, input.row, input.claim, importResult.reason, input.nowMs);
      return {
        ok: false as const
      };
    }

    const completed = await markJobSuccess(input.db, input.row, input.claim, input.nowMs);
    if (!completed) {
      return {
        ok: false as const
      };
    }
    return {
      ok: true as const,
      fullSyncQueued: importResult.fullSyncQueued
    };
  } catch (error) {
    if (isTransientD1Error(error)) {
      // A long-running D1 export (the backup-verify workflow's `wrangler d1
      // export`) briefly rejects every D1 write on this database. Don't capture
      // (expected, infra-level) and DON'T call markJobFailure — its write would
      // throw the same error. Leave the claim to lapse so the next sweep retries,
      // and signal the loop to stop claiming (the whole DB is export-locked for
      // now). Sentry RESERVATION-LINE-HOMEPAGE-D.
      return { ok: false as const, transientD1: true as const };
    }
    safeCaptureException(error, {
      tags: { google_module: "import-sync", operation: "process_claimed_job" },
      contexts: { d1_query: { store_id: input.row.store_id, job_id: input.row.job_id } }
    });
    try {
      await markJobFailure(input.db, input.row, input.claim, "google-import-unhandled", input.nowMs);
    } catch (failError) {
      // The failure-write itself can land in the D1 export window (the original
      // error is already captured above). Treat it like any other export-lock:
      // stop the sweep and let the claim lapse for a clean retry next tick. A
      // throw inside this catch would otherwise escape processClaimedImportJob and
      // bypass the transientD1 signal. Re-throw anything that is NOT export-lock.
      if (isTransientD1Error(failError)) {
        return { ok: false as const, transientD1: true as const };
      }
      throw failError;
    }
    return {
      ok: false as const
    };
  }
};

export async function enqueueGoogleCalendarMaintenanceJobs(input: {
  db: D1Database;
  now?: () => number;
}): Promise<GoogleCalendarMaintenanceResult> {
  const result = createEmptyMaintenanceResult();
  const nowMs = (input.now ?? Date.now)();
  const nowIso = toIso(nowMs);
  const cronBucket = nowIso.slice(0, 16);
  const dailyBucket = nowIso.slice(0, 10);
  const calendars = await fetchStoreCalendars(input.db);
  result.checked = calendars.length;

  // Several stores can share a calendar. Preserve the first store-ID-ordered mapping.
  const seenCalendars = new Set<string>();
  const distinctCalendars = calendars.filter((store) => {
    if (seenCalendars.has(store.calendar_id)) return false;
    seenCalendars.add(store.calendar_id);
    return true;
  });
  await mapConcurrent(distinctCalendars, async (store) => {
    const cronDedupeKey = compactDedupeKey(
      `${store.calendar_id}:cron_incremental:${cronBucket}`,
      "google-import:cron"
    );
    const fullDedupeKey = compactDedupeKey(
      `${store.calendar_id}:full_reconcile:${dailyBucket}`,
      "google-import:full"
    );
    const [cron, full] = await input.db.batch([
      insertImportJob({
        db: input.db,
        storeId: store.store_id,
        calendarId: store.calendar_id,
        reason: "cron_incremental",
        dedupeKey: cronDedupeKey,
        nowIso
      }),
      insertImportJob({
        db: input.db,
        storeId: store.store_id,
        calendarId: store.calendar_id,
        reason: "full_reconcile",
        dedupeKey: fullDedupeKey,
        nowIso,
        // Defer the heavy daily reconcile out of the 09:00 JST */10 spike,
        // staggered per calendar so stores don't all land on one tick.
        nextRunAtIso: quietWindowNextRunAtIso(nowMs, store.calendar_id)
      })
    ]);
    result.cronIncrementalQueued += Number(cron.meta?.changes ?? 0);
    result.fullReconcileQueued += Number(full.meta?.changes ?? 0);
  });

  return result;
}

export async function processDueGoogleCalendarImportJobs(input: {
  db: D1Database;
  env: GoogleCalendarImportEnv;
  fetcher?: typeof fetch;
  accessTokenProvider?: () => Promise<string | undefined>;
  now?: () => number;
  maxJobs?: number;
} & DriftDeps): Promise<GoogleCalendarImportResult> {
  const result = createEmptyResult();
  const fetcher = input.fetcher ?? withOutboundTimeout(fetch.bind(globalThis));
  const now = input.now ?? Date.now;
  const maxJobs = input.maxJobs ?? 5;

  // Sweep dead-letter candidates once per batch; subsequent iterations don't
  // add new MAX_ATTEMPTS hits because the claim path enforces attempt_count < cap.
  await markStaleImportClaimsExhausted(input.db, now());

  for (let index = 0; index < maxJobs; index += 1) {
    const nowMs = now();
    const row = await fetchNextImportJob(input.db, toIso(nowMs));
    if (!row) {
      break;
    }

    const claim = await markJobProcessing(input.db, row, nowMs);
    if (!claim) {
      continue;
    }

    result.processed += 1;
    const outcome = await processClaimedImportJob({
      db: input.db,
      env: input.env,
      row,
      claim,
      fetcher,
      accessTokenProvider: input.accessTokenProvider,
      now,
      nowMs,
      computeDrift: input.computeDrift,
      captureSweepStart: input.captureSweepStart
    });
    if (outcome.ok) {
      result.succeeded += 1;
      if (outcome.fullSyncQueued) {
        result.fullSyncQueued += 1;
      }
      continue;
    }
    if ("transientD1" in outcome) {
      // The whole D1 is export-locked for the rest of this sweep; stop claiming.
      // The claimed-but-unwritten row lapses on lock expiry and retries next tick.
      // (`transientD1` exists only on the export-lock outcome, so its presence is
      // the discriminant — no truthiness check needed.)
      console.warn("google_import_d1_export_locked", { event: "d1_export_locked", job_id: row.job_id });
      break;
    }
    if ("yielded" in outcome && outcome.yielded) {
      // The yielded job is immediately due again (next_run_at = now).
      // Claiming more work after the soft deadline would spend the slack
      // reserved for finishing cleanly under CLAIM_TASK_TIMEOUT_MS, so end
      // this batch here; the next tick resumes from the checkpoint.
      result.yielded += 1;
      break;
    }
    result.failed += 1;
  }

  return result;
}

const DEFAULT_EVENT_HISTORY_RETENTION_DAYS = 30;
const PRUNE_TASK_KEY = "prune_google_calendar_event_history";

export type PruneGoogleEventHistoryResult =
  | { skipped: true; reason: "already_ran_today" }
  | { skipped: false; deleted: number };

// Persistent daily-bucket dedupe: INSERT OR IGNORE writes a marker row keyed
// by (task_key, day_bucket). If another cron tick already wrote today's
// marker the INSERT reports 0 changes and we short-circuit. This survives
// across separate scheduled invocations, unlike the in-memory nowIso bucket
// used elsewhere (codex plan-review iter 1 blocker B4).
export async function pruneGoogleEventHistory(input: {
  db: D1Database;
  retentionDays?: number;
  nowMs?: number;
}): Promise<PruneGoogleEventHistoryResult> {
  const days = input.retentionDays ?? DEFAULT_EVENT_HISTORY_RETENTION_DAYS;
  const nowMs = input.nowMs ?? Date.now();
  const nowIso = toIso(nowMs);
  const dayBucket = nowIso.slice(0, 10);
  const cutoffIso = toIso(nowMs - days * 24 * 60 * 60 * 1000);

  const markerResult = await input.db
    .prepare(
      `
        INSERT OR IGNORE INTO google_calendar_history_maintenance_runs
          (task_key, day_bucket, completed_at)
        VALUES (?, ?, ?)
      `
    )
    .bind(PRUNE_TASK_KEY, dayBucket, nowIso)
    .run();
  if ((markerResult.meta?.changes ?? 0) === 0) {
    return { skipped: true, reason: "already_ran_today" };
  }

  // The marker acts as a lock so concurrent cron ticks do not double-run the
  // DELETE. If the DELETE fails (network hiccup, D1 unavailable, etc.) we
  // release the lock so the next scheduled invocation retries instead of
  // returning a false "already_ran_today" until midnight UTC.
  try {
    const deleteResult = await input.db
      .prepare(
        `DELETE FROM google_calendar_event_history WHERE captured_at < ?`
      )
      .bind(cutoffIso)
      .run();
    return { skipped: false, deleted: deleteResult.meta?.changes ?? 0 };
  } catch (error) {
    safeCaptureException(error, {
      tags: { google_module: "import-sync", operation: "prune_event_history" },
      contexts: { d1_query: { cutoff_iso: cutoffIso } }
    });
    await input.db
      .prepare(
        `
          DELETE FROM google_calendar_history_maintenance_runs
          WHERE task_key = ? AND day_bucket = ?
        `
      )
      .bind(PRUNE_TASK_KEY, dayBucket)
      .run()
      .catch(() => undefined);
    throw error;
  }
}

export type StagingDriftSweepInput = {
  db: D1Database;
  env: GoogleCalendarImportEnv;
  storeId: string;
  calendarId: string;
  injectCount: number;
  cleanupExisting: boolean;
};

export type StagingDriftSweepResult = {
  sweepStartSeconds: number;
  d1Count: number;
  drift: number;
  alertEnqueued: boolean;
  insertedCount: number;
  existingCount: number;
  jobIds: string[];
};

export const runStagingDriftSweep = async (
  input: StagingDriftSweepInput
): Promise<StagingDriftSweepResult> => {
  if (input.cleanupExisting) {
    await input.db
      .prepare(
        `DELETE FROM google_calendar_events
         WHERE store_id = ? AND calendar_id = ? AND google_event_id LIKE 'drift_inject_%'`
      )
      .bind(input.storeId, input.calendarId)
      .run();
    await input.db
      .prepare(
        `DELETE FROM notification_jobs
         WHERE dedupe_key LIKE 'google_drift_alert:v1:' || DATE('now') || ':store:' || ? || ':%'`
      )
      .bind(input.storeId)
      .run();
  }

  const sweepStartSeconds = await captureSweepStartSeconds(input.db);

  // Build all INSERT statements upfront and execute them in a single atomic
  // db.batch() call so that either all drift-inject rows land or none do.
  // This prevents partial injections from polluting the events table if the
  // worker hits a timeout or D1 hiccup mid-loop (codex follow-up item b).
  const injectRowIds: string[] = [];
  const injectStatements: D1PreparedStatement[] = [];
  for (let i = 0; i < input.injectCount; i += 1) {
    const rowId = crypto.randomUUID();
    const googleEventId = `drift_inject_${crypto.randomUUID()}`;
    injectRowIds.push(rowId);
    injectStatements.push(
      input.db
        .prepare(
          `INSERT INTO google_calendar_events (
             id, store_id, calendar_id, google_event_id,
             reservation_id, external_block_id,
             google_etag, google_updated_at, last_seen_at, last_imported_at,
             source_type, status, google_safe_snapshot_json
           ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'unknown', 'active', NULL)`
        )
        .bind(rowId, input.storeId, input.calendarId, googleEventId)
    );
  }

  try {
    await input.db.batch(injectStatements);
  } catch (batchError) {
    safeCaptureException(batchError, {
      tags: { google_module: "import-sync", operation: "staging_drift_inject_batch" },
      contexts: { d1_query: { store_id: input.storeId, calendar_id: input.calendarId, inject_count: injectStatements.length } }
    });
    // Compensating cleanup: delete any rows that may have been partially
    // committed (belt-and-suspenders — batch itself is atomic on D1, but
    // a network-level timeout could leave an ambiguous state).
    await mapConcurrent(injectRowIds, async (rowId) => {
      try {
        await input.db
          .prepare(`DELETE FROM google_calendar_events WHERE id = ?`)
          .bind(rowId)
          .run();
      } catch {
        // Continue compensating other exact IDs; retain the original injection error.
      }
    });
    throw batchError;
  }

  const counts = await computeCalendarDrift({
    db: input.db,
    storeId: input.storeId,
    calendarId: input.calendarId,
    googleSweepCount: 0,
    sweepStartSeconds
  });

  let enqueueResult: DriftAlertEnqueueResult = { insertedCount: 0, existingCount: 0, jobIds: [] };

  const driftEval = await evaluateDriftThreshold({
    db: input.db,
    env: input.env,
    storeId: input.storeId,
    calendarId: input.calendarId,
    googleCount: counts.googleSweepCount,
    d1Count: counts.d1SweepCount,
    drift: counts.drift,
    nowMs: Date.now()
  });
  if (driftEval.enqueueResult) {
    enqueueResult = driftEval.enqueueResult;
  }

  return {
    sweepStartSeconds,
    d1Count: counts.d1SweepCount,
    drift: counts.drift,
    alertEnqueued: enqueueResult.insertedCount > 0 || enqueueResult.existingCount > 0,
    insertedCount: enqueueResult.insertedCount,
    existingCount: enqueueResult.existingCount,
    jobIds: enqueueResult.jobIds
  };
};

// Internal helpers exposed under a single namespace for regression tests.
// Production code MUST NOT import these — the entry points above are the
// supported surface. The `__testing__` namespace is a repo-wide convention
// so a grep for `__testing__` finds all the deliberate test-only exports.
export const __testing__ = {
  MAX_DEDUPE_KEY_LENGTH,
  stableHash,
  compactDedupeKey,
  ORPHAN_GRACE_SECONDS,
  DRIFT_ALERT_THRESHOLD,
  createSafeSnapshot,
  readDateAsUtcIso,
  buildConflictSnapshot,
  fetchEventsListPage,
  buildEventsListUrl,
  fullWalkTimeMinIso,
  chunkBindValues,
  SLOT_QUERY_CHUNK_SIZE,
  FULL_WALK_PAGE_SIZE,
  INITIAL_WALK_PAGE_SIZE,
  MAX_RECONCILE_YIELDS,
  MAX_EVENTS_LIST_PAGES
};
