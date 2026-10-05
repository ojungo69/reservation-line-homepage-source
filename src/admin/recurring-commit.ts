import { adminWriteGuard, adminWriteWasRevoked } from "./write-authorization";
import type { AdminUser } from "./access";
import { createAdminExternalBlock, type AdminExternalBlockResult } from "./external-blocks";
import { expandRrule } from "../google/rrule-expander";
import { SLOT_LOCK_INTERVAL_MINUTES } from "../reservations/slot-times";
import { JST_OFFSET_MS } from "../time-utils";
import { parseStrictIsoInstantMs } from "./parse-iso-instant";
import { isNonEmptyString } from "./reservation-time-utils";
import {
  IDEMPOTENCY_TTL_MS,
  isAdminPrivileged,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  sha256Hex
} from "./settings-common";

// Tier D.4 — POST /api/admin/recurring/commit.
//
// Takes an RRULE preview-shape payload (rrule + dtstart + windowEnd) plus a
// per-occurrence duration and materialises each expanded occurrence as an
// external_blocks row via the existing createAdminExternalBlock helper. The
// commit pattern is "best-effort partial success":
//
// - past occurrences are reported as `skipped_past` (createAdminExternalBlock
//   refuses startAt < now); the commit moves on without aborting.
// - slot conflicts (`slot_unavailable`) and other per-occurrence write errors
//   are reported as `failed` rows with the inner reason; the commit still
//   marks the parent idempotency_keys row as 'succeeded' so a retry replays
//   the same aggregate verdict instead of accidentally re-attempting writes.
//
// Idempotency model:
//
// - Parent idempotency_keys row (scope='admin_action') uses the caller's
//   `idempotencyKey`. request_hash binds the entire batch input — same key +
//   different payload returns 409 idempotency_conflict (same as singleton
//   POSTs).
// - Each occurrence gets a derived child key
//   `sha256(parentKey + ":occ:" + occurrenceIso)`. createAdminExternalBlock
//   already implements per-row idempotency, so partial retries replay the
//   per-occurrence outcome at the inner layer.
// - Replay of the parent reads back the aggregate from the audit_logs row
//   addressed by the parent target_id, returning replayed:true. We do not
//   re-expand the RRULE on replay — the persisted result is the source of
//   truth even if the RRULE definition would now expand differently.

const MAX_RRULE_LEN = 1024;
const MAX_TITLE_LEN = 120;
const MAX_STORE_ID_LEN = 64;
const MAX_RESOURCE_ID_LEN = 128;
const MAX_ISO_LEN = 64;
const MIN_DURATION_MINUTES = 5;
// 4h is enough for typical recurring closures; combined with the slot cap
// below it bounds the synchronous workload to ~1500 slot_lock inserts which
// each createAdminExternalBlock call performs across 50 separate D1 batches.
// Operators wanting longer or more frequent blocks should still file via the
// per-occurrence external-blocks endpoint.
const MAX_DURATION_MINUTES = 4 * 60;
// Caps below paired together — total materialised slot count ceiling is
// guarded by MAX_BATCH_SLOTS so neither MAX_COMMIT_OCCURRENCES alone nor
// MAX_DURATION_MINUTES alone can blow up Worker wallclock budget.
const MAX_COMMIT_OCCURRENCES = 50;
// Pass this raw cap to expandRrule so the expander returns enough candidates
// to fill MAX_COMMIT_OCCURRENCES future ones even when dtstart sits in the
// past (e.g. a Google-imported RRULE the operator wants to commit going
// forward). Without it the expander would stop at the first
// MAX_COMMIT_OCCURRENCES, all of which could be skipped past, and the
// upcoming series would never materialise. Keep this in sync with the
// ABSOLUTE_MAX_OCCURRENCES literal in src/google/rrule-expander.ts.
const RAW_EXPANSION_MAX = 200;
// Hard ceiling on the total `slot_locks` (and `slot_lock_history`) rows the
// commit batch is allowed to write across all its per-occurrence
// createAdminExternalBlock calls. 1500 rows × 2 inserts = 3000 statements is
// the maximum I/O the synchronous endpoint takes on; anything larger should
// fan out to multiple commit calls with non-overlapping window slices.
const MAX_BATCH_SLOTS = 1500;
const RRULE_COMMIT_MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export type AdminRecurringCommitRequest = {
  idempotencyKey: string;
  storeId: string;
  resourceId: string;
  rrule: string;
  dtstart: string;
  windowEnd: string;
  durationMinutes: number;
  title?: string;
};

export type AdminRecurringCommitOccurrenceCreated = {
  status: "created";
  startAt: string;
  endAt: string;
  externalBlockId: string;
};

export type AdminRecurringCommitOccurrenceReplayed = {
  status: "replayed";
  startAt: string;
  endAt: string;
  externalBlockId: string;
};

export type AdminRecurringCommitOccurrenceFailed = {
  status: "failed";
  startAt: string;
  endAt: string;
  reason: string;
};

// Past-anchored occurrences are reported via skippedPastCount only — the
// per-row list omits them so a long-history RRULE doesn't bloat the
// response payload with hundreds of indistinguishable skip entries.
export type AdminRecurringCommitOccurrence =
  | AdminRecurringCommitOccurrenceCreated
  | AdminRecurringCommitOccurrenceReplayed
  | AdminRecurringCommitOccurrenceFailed;

export type AdminRecurringCommitSummary = {
  occurrences: AdminRecurringCommitOccurrence[];
  createdCount: number;
  replayedCount: number;
  skippedPastCount: number;
  failedCount: number;
  truncatedByWindow: boolean;
  truncatedByCap: boolean;
  windowCapped: boolean;
};

export type AdminRecurringCommitError =
  | "forbidden"
  | "invalid_request"
  | "missing_database"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "invalid_rrule"
  | "unsupported_freq"
  | "write_failed";

export type AdminRecurringCommitResult =
  | ({ ok: true; auditLogId: string; replayed: boolean } & AdminRecurringCommitSummary)
  | { ok: false; error: AdminRecurringCommitError };

const parseDurationMinutes = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < MIN_DURATION_MINUTES || value > MAX_DURATION_MINUTES) return null;
  if (value % MIN_DURATION_MINUTES !== 0) return null;
  return value;
};

export const parseAdminRecurringCommitRequest = (
  body: unknown
): AdminRecurringCommitRequest | null => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const raw = body as Record<string, unknown>;
  if (!isNonEmptyString(raw.idempotencyKey, MAX_IDEMPOTENCY_KEY_LENGTH)) return null;
  if (!isNonEmptyString(raw.storeId, MAX_STORE_ID_LEN)) return null;
  if (!isNonEmptyString(raw.resourceId, MAX_RESOURCE_ID_LEN)) return null;
  if (!isNonEmptyString(raw.rrule, MAX_RRULE_LEN)) return null;
  if (!isNonEmptyString(raw.dtstart, MAX_ISO_LEN)) return null;
  if (!isNonEmptyString(raw.windowEnd, MAX_ISO_LEN)) return null;
  const durationMinutes = parseDurationMinutes(raw.durationMinutes);
  if (durationMinutes === null) return null;
  let title: string | undefined;
  if (raw.title !== undefined) {
    if (!isNonEmptyString(raw.title, MAX_TITLE_LEN)) return null;
    title = raw.title.trim();
  }
  return {
    idempotencyKey: raw.idempotencyKey.trim(),
    storeId: raw.storeId.trim(),
    resourceId: raw.resourceId.trim(),
    rrule: raw.rrule.trim(),
    dtstart: raw.dtstart.trim(),
    windowEnd: raw.windowEnd.trim(),
    durationMinutes,
    title
  };
};

const buildRequestHash = async (request: AdminRecurringCommitRequest) =>
  sha256Hex(
    JSON.stringify({
      storeId: request.storeId,
      resourceId: request.resourceId,
      rrule: request.rrule,
      dtstart: request.dtstart,
      windowEnd: request.windowEnd,
      durationMinutes: request.durationMinutes,
      title: request.title ?? null
    })
  );

const deriveChildKey = async (parentKey: string, occurrenceIso: string) =>
  (await sha256Hex(`${parentKey}:occ:${occurrenceIso}`)).slice(0, 32);

const formatOccurrenceEndIso = (startMs: number, durationMinutes: number): string =>
  new Date(startMs + durationMinutes * 60 * 1000).toISOString();

const fetchReplayAggregate = async (
  db: D1Database,
  auditLogId: string
): Promise<AdminRecurringCommitSummary | null> => {
  const row = await db
    .prepare(`SELECT metadata_json FROM audit_logs WHERE id = ? LIMIT 1`)
    .bind(auditLogId)
    .first<{ metadata_json: string | null }>();
  if (!row?.metadata_json) return null;
  try {
    const parsed: unknown = JSON.parse(row.metadata_json);
    // JSON.parse("null") yields literal null; reject anything that isn't a
    // plain object before reaching for the summary field so a malformed
    // metadata row can't crash the replay path with TypeError. Arrays are
    // also rejected because audit_logs metadata for this action is
    // exclusively the { request, summary } object shape.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const summary = (parsed as { summary?: AdminRecurringCommitSummary }).summary;
    return summary ?? null;
  } catch {
    return null;
  }
};

// Stale-lease threshold for crash recovery. A `started` parent row whose
// updated_at is older than this is treated as a crashed previous attempt and
// becomes eligible for resume; anything more recent is treated as an
// in-flight peer and rejected with idempotency_in_progress so two concurrent
// callers with the same key + same payload don't both fan into the child
// loop, double-finalise the parent, and split the audit history.
const STALE_PARENT_LEASE_MS = 60_000;

type ParentIdempotencyRow = {
  status: "started" | "succeeded" | "failed";
  target_id: string | null;
  request_hash: string | null;
  updated_at: string | null;
};

const fetchParentIdempotency = async (
  db: D1Database,
  idempotencyKey: string
): Promise<ParentIdempotencyRow | null> =>
  db
    .prepare(
      `SELECT status, target_id, request_hash, updated_at
       FROM idempotency_keys
       WHERE scope = 'admin_action'
         AND idempotency_key = ?
       LIMIT 1`
    )
    .bind(idempotencyKey)
    .first<ParentIdempotencyRow>();

// Returns one of:
// - AdminRecurringCommitResult: short-circuit the caller (replay/conflict/in_progress)
// - "resume_eligible": parent row matches the hash and is either explicitly
//   failed or a stale-started leftover; caller must still atomically claim
//   the lease before entering the child loop.
type ExistingIdempotencyOutcome = AdminRecurringCommitResult | "resume_eligible";

const handleExistingParent = async (
  db: D1Database,
  parent: ParentIdempotencyRow,
  requestHash: string,
  nowMs: number
): Promise<ExistingIdempotencyOutcome> => {
  if (parent.request_hash !== requestHash) {
    return { ok: false, error: "idempotency_conflict" };
  }
  if (parent.status === "succeeded") {
    if (parent.target_id) {
      const summary = await fetchReplayAggregate(db, parent.target_id);
      if (summary) {
        return {
          ok: true,
          auditLogId: parent.target_id,
          replayed: true,
          ...summary
        };
      }
    }
    // Succeeded but audit_logs row vanished (manual cleanup) — block the
    // caller; bringing the row back requires operator intervention. Don't
    // resume into a fresh write loop because that would double-bind the
    // singleton target_id.
    return { ok: false, error: "idempotency_in_progress" };
  }
  if (parent.status === "started") {
    const updatedAtMs = parent.updated_at ? Date.parse(parent.updated_at) : Number.NaN;
    const isStale = !Number.isFinite(updatedAtMs) || nowMs - updatedAtMs >= STALE_PARENT_LEASE_MS;
    if (!isStale) {
      // Fresh started row → peer is mid-flight. Reject the concurrent
      // caller so only one runner finalises this idempotency key.
      return { ok: false, error: "idempotency_in_progress" };
    }
  }
  // status === 'failed' (last attempt's catch block flipped the parent) OR
  // status === 'started' and updated_at is older than the lease threshold
  // (previous Worker crashed without finalising) — both are claim-eligible
  // for resume via the CAS UPDATE below.
  return "resume_eligible";
};

// Atomic CAS claim: at most one concurrent caller wins the resume attempt.
// The WHERE clause re-checks the lease/status conditions so two callers
// racing on a stale 'started' row converge — one UPDATE applies, the other
// returns 0-changes and is told idempotency_in_progress.
const claimStaleOrFailedParent = async (
  db: D1Database, admin: AdminUser, idempotencyKey: string, requestHash: string,
  nowMs: number, nowIso: string
): Promise<boolean | "forbidden"> => {
  const staleBeforeIso = new Date(nowMs - STALE_PARENT_LEASE_MS).toISOString();
  try {
    const results = await db.batch([adminWriteGuard(db, admin), db.prepare(`UPDATE idempotency_keys
      SET status = 'started', updated_at = ?
      WHERE scope = 'admin_action' AND idempotency_key = ? AND request_hash = ?
        AND (status = 'failed' OR (status = 'started' AND updated_at < ?))`)
      .bind(nowIso, idempotencyKey, requestHash, staleBeforeIso)]);
    return (results[1].meta?.changes ?? 0) >= 1;
  } catch (error) {
    if (await adminWriteWasRevoked(db, admin, error)) return "forbidden";
    throw error;
  }
};

const externalBlockReasonToOccurrenceFailure = (
  result: Extract<AdminExternalBlockResult, { ok: false }>,
  startIso: string,
  endIso: string
): AdminRecurringCommitOccurrence => ({
  status: "failed",
  startAt: startIso,
  endAt: endIso,
  reason: result.reason
});

const persistParentIdempotency = async (input: {
  db: D1Database;
  admin: AdminUser;
  idempotencyKey: string;
  requestHash: string;
  nowMs: number;
  nowIso: string;
}): Promise<boolean | "forbidden"> => {
  const idempotencyId = crypto.randomUUID();
  const expiresAt = new Date(input.nowMs + IDEMPOTENCY_TTL_MS).toISOString();
  try {
    await input.db.batch([adminWriteGuard(input.db, input.admin), input.db.prepare(
        `INSERT INTO idempotency_keys (
           id, scope, idempotency_key, status, request_hash, expires_at, updated_at
         ) VALUES (?, 'admin_action', ?, 'started', ?, ?, ?)`
      )
      .bind(idempotencyId, input.idempotencyKey, input.requestHash, expiresAt, input.nowIso)
    ]);
    return true;
  } catch (error) {
    if (await adminWriteWasRevoked(input.db, input.admin, error)) return "forbidden";
    console.error("recurring-commit parent idempotency insert failed", {
      idempotencyKey: input.idempotencyKey,
      error: error instanceof Error ? error.message : String(error)
    });
    return false;
  }
};

// UPDATE-by-idempotency_key (not by row id) so the same statement works
// whether we just inserted the parent row or are resuming a row that the
// previous attempt created. The WHERE filters out conflicting payloads as
// a defence-in-depth check: the caller already short-circuited a
// request_hash mismatch above, but the same-key + same-payload guarantee
// here is what lets the resume path safely reuse the parent row.
const finalizeParentIdempotency = (input: {
  db: D1Database;
  idempotencyKey: string;
  requestHash: string;
  auditLogId: string;
  nowIso: string;
}): D1PreparedStatement => {
  return input.db
    .prepare(
      `UPDATE idempotency_keys
       SET status = 'succeeded', target_type = 'recurring_batch', target_id = ?, updated_at = ?
       WHERE scope = 'admin_action'
         AND idempotency_key = ?
         AND request_hash = ?`
    )
    .bind(input.auditLogId, input.nowIso, input.idempotencyKey, input.requestHash);
};

// Best-effort: flip the parent row to 'failed' so a subsequent retry of the
// same key + same payload can resume instead of being blocked behind a
// stuck 'started' row. We don't surface failures from this UPDATE — the
// caller already returned write_failed; making this throw on top would only
// obscure the original error.
const markParentIdempotencyFailed = async (input: {
  db: D1Database;
  idempotencyKey: string;
  requestHash: string;
  nowIso: string;
}): Promise<void> => {
  try {
    await input.db
      .prepare(
        `UPDATE idempotency_keys
         SET status = 'failed', updated_at = ?
         WHERE scope = 'admin_action'
           AND idempotency_key = ?
           AND request_hash = ?
           AND status = 'started' AND updated_at = ?`
      )
      .bind(input.nowIso, input.idempotencyKey, input.requestHash, input.nowIso)
      .run();
  } catch (error) {
    console.error("recurring-commit parent idempotency failure mark failed", {
      idempotencyKey: input.idempotencyKey,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};

const writeBatchAuditLog = async (input: {
  db: D1Database;
  admin: AdminUser;
  request: AdminRecurringCommitRequest;
  summary: AdminRecurringCommitSummary;
  requestHash: string;
  nowIso: string;
}): Promise<string> => {
  const auditLogId = crypto.randomUUID();
  const audit = input.db.prepare(
      `INSERT INTO audit_logs (
         id, actor_type, actor_id, action, target_type, target_id, metadata_json
       ) VALUES (?, 'staff', ?, 'settings.recurring.commit', 'recurring_batch', ?, ?)`
    )
    .bind(
      auditLogId,
      input.admin.id,
      auditLogId,
      JSON.stringify({
        adminRole: input.admin.role,
        request: {
          storeId: input.request.storeId,
          resourceId: input.request.resourceId,
          rrule: input.request.rrule,
          dtstart: input.request.dtstart,
          windowEnd: input.request.windowEnd,
          durationMinutes: input.request.durationMinutes,
          title: input.request.title ?? null
        },
        summary: input.summary
      })
    );
  await input.db.batch([adminWriteGuard(input.db, input.admin), audit,
    finalizeParentIdempotency({ db: input.db, idempotencyKey: input.request.idempotencyKey,
      requestHash: input.requestHash, auditLogId, nowIso: input.nowIso })]);
  return auditLogId;
};

type RecurringAttempt = {
  db: D1Database; admin: AdminUser; request: AdminRecurringCommitRequest;
  requestHash: string; nowMs: number; nowIso: string;
};

// Preserve the existing successful replay and stale-parent CAS contracts.
const resumeParent = async (input: RecurringAttempt, parent: ParentIdempotencyRow): Promise<"resumed" | AdminRecurringCommitResult> => {
  const outcome = await handleExistingParent(input.db, parent, input.requestHash, input.nowMs);
  if (outcome !== "resume_eligible") return outcome;
  const claimed = await claimStaleOrFailedParent(input.db, input.admin, input.request.idempotencyKey,
    input.requestHash, input.nowMs, input.nowIso);
  if (claimed === "forbidden") return { ok: false, error: "forbidden" };
  return claimed ? "resumed" : { ok: false, error: "idempotency_in_progress" };
};

const startParent = async (input: RecurringAttempt): Promise<"created" | "resumed" | AdminRecurringCommitResult> => {
  const persisted = await persistParentIdempotency({ ...input, idempotencyKey: input.request.idempotencyKey });
  if (persisted === "forbidden") return { ok: false, error: "forbidden" };
  if (persisted) return "created";
  const concurrent = await fetchParentIdempotency(input.db, input.request.idempotencyKey);
  return concurrent ? resumeParent(input, concurrent) : { ok: false, error: "write_failed" };
};

// Each child commits independently. A revoked actor stops the series; successful
// children stay replayable when an authorized operator resumes the same parent.
const commitOccurrences = async (input: RecurringAttempt, futureOccurrences: Date[]): Promise<
  ({ ok: true } & Pick<AdminRecurringCommitSummary, "occurrences" | "createdCount" | "replayedCount" | "failedCount">)
  | { ok: false; error: "forbidden" }
> => {
  const { requestHash, nowMs, nowIso } = input;
  const occurrenceResults: AdminRecurringCommitOccurrence[] = [];
  let createdCount = 0;
  let replayedCount = 0;
  let failedCount = 0;

  for (const occurrence of futureOccurrences) {
    const startMs = occurrence.getTime();
    const startIso = occurrence.toISOString();
    const endIso = formatOccurrenceEndIso(startMs, input.request.durationMinutes);

    const childKey = await deriveChildKey(input.request.idempotencyKey, startIso);
    const childResult = await createAdminExternalBlock({
      db: input.db,
      admin: input.admin,
      request: {
        idempotencyKey: childKey,
        storeId: input.request.storeId,
        resourceId: input.request.resourceId,
        startAt: startIso,
        endAt: endIso,
        title: input.request.title
      },
      now: () => nowMs
    });

    if (childResult.ok) {
      const status: "created" | "replayed" = childResult.replayed ? "replayed" : "created";
      occurrenceResults.push({
        status,
        startAt: childResult.startAt,
        endAt: childResult.endAt,
        externalBlockId: childResult.externalBlockId
      });
      if (status === "replayed") replayedCount += 1;
      else createdCount += 1;
    } else {
      if (childResult.reason === "forbidden") {
        await markParentIdempotencyFailed({ db: input.db, idempotencyKey: input.request.idempotencyKey, requestHash, nowIso });
        return { ok: false, error: "forbidden" };
      }
      occurrenceResults.push(externalBlockReasonToOccurrenceFailure(childResult, startIso, endIso));
      failedCount += 1;
    }
  }
  return { ok: true, occurrences: occurrenceResults, createdCount, replayedCount, failedCount };
};

const expandCommitOccurrences = (
  request: AdminRecurringCommitRequest, dtstartMs: number, cappedWindowEndMs: number, nowMs: number
): { ok: true; futureOccurrences: Date[]; totalPastSkipped: number; truncatedByWindow: boolean; truncatedByCap: boolean }
  | { ok: false; error: "unsupported_freq" | "invalid_rrule" | "invalid_request" } => {
  // Expand with the raw (rrule-expander absolute) cap so a past-anchored
  // RRULE doesn't exhaust its returned slice on already-past occurrences.
  // We then slice the future part down to MAX_COMMIT_OCCURRENCES — the
  // operator-facing limit — and only count past occurrences in the tally.
  const expansion = expandRrule({
    rrule: request.rrule,
    dtstartMs,
    windowEndMs: cappedWindowEndMs,
    maxOccurrences: RAW_EXPANSION_MAX,
    // Wizard BYDAY / BYMONTHDAY are JST wall-calendar; dtstart is a UTC
    // instant of a JST local time. Expand against the JST calendar.
    localOffsetMs: JST_OFFSET_MS
  });
  if (!expansion.ok) {
    return {
      ok: false,
      error: expansion.reason === "unsupported_freq" ? "unsupported_freq" : "invalid_rrule"
    };
  }

  // Split the raw expansion into past (tallied only) and future
  // (materialised up to MAX_COMMIT_OCCURRENCES). The slot ceiling gates
  // the future portion only — past occurrences write nothing, so
  // including them would reject legitimate catch-up commits where the
  // operator just wants the next N future blocks.
  let totalPastSkipped = 0;
  let totalFutureCandidates = 0;
  const futureOccurrences: Date[] = [];
  for (const occ of expansion.occurrences) {
    if (occ.getTime() < nowMs) {
      totalPastSkipped += 1;
    } else {
      totalFutureCandidates += 1;
      if (futureOccurrences.length < MAX_COMMIT_OCCURRENCES) {
        futureOccurrences.push(occ);
      }
    }
  }
  // If the raw expansion already flagged truncatedByCap, keep that;
  // otherwise detect the case where the future slice itself dropped
  // candidates so the operator can paginate via the next call (advance
  // dtstart past the last materialised occurrence) instead of silently
  // thinking the whole series committed.
  const truncatedByFutureSlice =
    expansion.truncatedByCap || totalFutureCandidates > futureOccurrences.length;
  const slotsPerOccurrence = request.durationMinutes / SLOT_LOCK_INTERVAL_MINUTES;
  if (futureOccurrences.length * slotsPerOccurrence > MAX_BATCH_SLOTS) {
    return { ok: false, error: "invalid_request" };
  }

  return { ok: true, futureOccurrences, totalPastSkipped,
    truncatedByWindow: expansion.truncatedByWindow, truncatedByCap: truncatedByFutureSlice };
};

export const commitAdminRecurring = async (input: {
  db: D1Database;
  admin: AdminUser;
  request: AdminRecurringCommitRequest;
  now?: () => number;
}): Promise<AdminRecurringCommitResult> => {
  if (!isAdminPrivileged(input.admin.role)) {
    return { ok: false, error: "forbidden" };
  }

  const dtstartMs = parseStrictIsoInstantMs(input.request.dtstart);
  const windowEndMs = parseStrictIsoInstantMs(input.request.windowEnd);
  if (dtstartMs === null || windowEndMs === null || windowEndMs < dtstartMs
    || dtstartMs % (MIN_DURATION_MINUTES * 60 * 1000) !== 0) {
    return { ok: false, error: "invalid_request" };
  }
  const nowMs = (input.now ?? Date.now)();
  const nowIso = new Date(nowMs).toISOString();
  // Anchor the window cap on max(dtstart, now) — capping from dtstart alone
  // would land the entire expansion window in the past for an imported
  // RRULE whose dtstart sits more than 90 days ago. The operator-facing
  // semantics are "expand forward from now up to 90 days", regardless of
  // how old the anchor is.
  const windowAnchorMs = Math.max(dtstartMs, nowMs);
  const cappedWindowEndMs = Math.min(
    windowEndMs,
    windowAnchorMs + RRULE_COMMIT_MAX_WINDOW_MS
  );
  const windowCapped = cappedWindowEndMs < windowEndMs;

  const requestHash = await buildRequestHash(input.request);
  const existingParent = await fetchParentIdempotency(
    input.db,
    input.request.idempotencyKey
  );

  const attempt: RecurringAttempt = { ...input, requestHash, nowMs, nowIso };
  let resumingExistingParent = false;
  if (existingParent) {
    const outcome = await resumeParent(attempt, existingParent);
    if (outcome !== "resumed") return outcome;
    resumingExistingParent = true;
  }

  const expansion = expandCommitOccurrences(input.request, dtstartMs, cappedWindowEndMs, nowMs);
  if (!expansion.ok) return expansion;
  const { futureOccurrences, totalPastSkipped } = expansion;

  if (!resumingExistingParent) {
    const outcome = await startParent(attempt);
    if (typeof outcome !== "string") return outcome;
    resumingExistingParent = outcome === "resumed";
  }

  try {
    const children = await commitOccurrences(attempt, futureOccurrences);
    if (!children.ok) return children;
    const { occurrences, createdCount, replayedCount, failedCount } = children;

    const summary: AdminRecurringCommitSummary = {
      occurrences,
      createdCount,
      replayedCount,
      skippedPastCount: totalPastSkipped,
      failedCount,
      truncatedByWindow: expansion.truncatedByWindow,
      truncatedByCap: expansion.truncatedByCap,
      windowCapped
    };
    const auditLogId = await writeBatchAuditLog({
      db: input.db,
      admin: input.admin,
      request: input.request,
      summary, requestHash, nowIso
    });

    return {
      ok: true,
      auditLogId,
      replayed: resumingExistingParent,
      ...summary
    };
  } catch (error) {
    console.error("recurring-commit batch failed", {
      idempotencyKey: input.request.idempotencyKey,
      error: error instanceof Error ? error.message : String(error)
    });
    // Best-effort: flip the parent row to 'failed' so a same-key + same-
    // payload retry can re-enter the resume path instead of being blocked
    // behind a 'started' row forever.
    await markParentIdempotencyFailed({
      db: input.db,
      idempotencyKey: input.request.idempotencyKey,
      requestHash,
      nowIso
    });
    if (await adminWriteWasRevoked(input.db, input.admin, error)) return { ok: false, error: "forbidden" };
    return { ok: false, error: "write_failed" };
  }
};
