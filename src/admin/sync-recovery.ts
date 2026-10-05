import { adminWriteGuard, adminWriteWasRevoked } from "./write-authorization";
import type { AdminUser } from "./access";
import { captureBatchWriteFailure } from "../sentry-helpers";
import { IDEMPOTENCY_TTL_MS, sha256Hex, startedIdempotencyStatement } from "./settings-common";
import { isNonEmptyString, toIso } from "./reservation-time-utils";
import { LINE_MONTHLY_QUOTA_EXHAUSTED } from "../line/quota";

export type AdminSyncJobSource =
  | "google_calendar_import_jobs"
  | "calendar_sync_jobs"
  | "notification_jobs";

export type AdminSyncJobRetryRequest = {
  idempotencyKey: string;
  source: AdminSyncJobSource;
  jobId: string;
};

export type AdminSyncJobAcknowledgeRequest = {
  idempotencyKey: string;
  source: "google_calendar_import_jobs" | "notification_jobs";
  jobId: string;
  note: string;
};

export type AdminSyncConflictResolutionRequest = {
  idempotencyKey: string;
  note?: string;
  // When true AND conflict_type === 'external_block_event_deleted' AND
  // resolutionStatus === 'manual_resolved', the same batch that resolves the
  // conflict also cancels the lingering external_block + frees its slot_locks
  // (atomic resolve, see Step 5 plan).
  cancelExternalBlock?: boolean;
};

type AdminSyncRecoveryFailureReason =
  | "forbidden"
  | "invalid_request"
  | "not_found"
  | "invalid_transition"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "write_failed";

export type AdminSyncJobRetryResult =
  | {
      ok: true;
      action: "retry_job";
      source: AdminSyncJobSource;
      jobId: string;
      status: string;
      replayed: boolean;
    }
  | {
      ok: false;
      reason: AdminSyncRecoveryFailureReason;
    };

export type AdminSyncJobAcknowledgeResult =
  | {
      ok: true;
      action: "acknowledge_job";
      source: AdminSyncJobAcknowledgeRequest["source"];
      jobId: string;
      status: string;
      replayed: boolean;
    }
  | {
      ok: false;
      reason: AdminSyncRecoveryFailureReason;
    };

export type AdminSyncConflictResolutionResult =
  | {
      ok: true;
      action: "resolve_conflict";
      conflictId: string;
      resolutionStatus: "ignored" | "manual_resolved";
      replayed: boolean;
    }
  | {
      ok: false;
      reason: AdminSyncRecoveryFailureReason;
    };

type IdempotencyRow = {
  status: "started" | "succeeded" | "failed";
  target_type: string | null;
  target_id: string | null;
  request_hash: string | null;
};

type JobRow = {
  id: string;
  status: string;
  locked_until: string | null;
  last_error: string | null;
  acknowledged?: number;
};

type ConflictRow = {
  id: string;
  resolution_status: "open" | "auto_reverted" | "accepted" | "ignored" | "manual_resolved";
  conflict_type: string;
  external_block_id: string | null;
};

const ATTENTION_STATUS_SQL = "('failed', 'retryable', 'dead')";

// キャンセル申請機能の廃止 (2026-08-01) で dispatcher の claim 対象から外れた
// template 群。歴史 dead 行を汎用 retry で queued に戻すと二度と配信されず永久滞留
// するため、retry 対象と attention 表示 (sync-status 側) の両方から除外する。
export const RETIRED_NOTIFICATION_TEMPLATES_SQL =
  "('change_request_received', 'change_request_approved', 'change_request_rejected')";

// Notification failures remain failures. The audit marker records disposition;
// retention must never remove it before the corresponding notification job.
export const NOTIFICATION_ACKNOWLEDGEMENT_SQL = `
  SELECT 1 FROM audit_logs
  WHERE target_type = 'notification_jobs'
    AND target_id = notification_jobs.id
    AND action = 'admin_sync_job_acknowledged'
`;

const isNotificationRetryBlocked = (job: JobRow) =>
  Boolean(job.acknowledged) || job.last_error === LINE_MONTHLY_QUOTA_EXHAUSTED;

export const isAdminSyncJobSource = (value: unknown): value is AdminSyncJobSource => {
  return (
    value === "google_calendar_import_jobs" ||
    value === "calendar_sync_jobs" ||
    value === "notification_jobs"
  );
};

const createRequestHash = async (payload: Record<string, unknown>) => {
  return sha256Hex(JSON.stringify(payload));
};

const fetchIdempotency = async (db: D1Database, idempotencyKey: string, nowIso: string) => {
  // Filter on expires_at so a "started" row from a crashed request stops
  // blocking this idempotency_key once its TTL has elapsed, matching the audited
  // canonical resolver (settings-common.ts fetchAdminActionIdempotency,
  // docs/SECURITY-AUDIT-2026-05-27.md F-6.1). Bind the caller's nowIso (the same
  // clock that stamps expires_at on insert) so read and write stay deterministic;
  // wrap both sides in datetime(...) because expires_at is an ISO string whose
  // `T` separator would lexically mis-order a bare `>`.
  return db
    .prepare(
      `
        SELECT status, target_type, target_id, request_hash
        FROM idempotency_keys
        WHERE scope = 'admin_action'
          AND idempotency_key = ?
          AND (expires_at IS NULL OR datetime(expires_at) > datetime(?))
        LIMIT 1
      `
    )
    .bind(idempotencyKey, nowIso)
    .first<IdempotencyRow>();
};

const succeededIdempotencyStatement = (input: {
  db: D1Database;
  id: string;
  targetType: string;
  targetId: string;
  nowIso: string;
}) => {
  return input.db
    .prepare(
      `
        UPDATE idempotency_keys
        SET status = 'succeeded',
            target_type = ?,
            target_id = ?,
            updated_at = ?
        WHERE id = ?
      `
    )
    .bind(input.targetType, input.targetId, input.nowIso, input.id);
};

const fetchJob = async (db: D1Database, source: AdminSyncJobSource, jobId: string) => {
  if (source === "google_calendar_import_jobs") {
    return db
      .prepare("SELECT id, status, locked_until, last_error FROM google_calendar_import_jobs WHERE id = ? LIMIT 1")
      .bind(jobId)
      .first<JobRow>();
  }
  if (source === "calendar_sync_jobs") {
    return db
      .prepare("SELECT id, status, locked_until, last_error FROM calendar_sync_jobs WHERE id = ? LIMIT 1")
      .bind(jobId)
      .first<JobRow>();
  }
  return db
    .prepare(
      `SELECT id, status, locked_until, last_error,
              EXISTS (${NOTIFICATION_ACKNOWLEDGEMENT_SQL}) AS acknowledged
       FROM notification_jobs
       WHERE id = ? AND template_key NOT IN ${RETIRED_NOTIFICATION_TEMPLATES_SQL} LIMIT 1`
    )
    .bind(jobId)
    .first<JobRow>();
};

const isRetryableAttentionJob = (job: JobRow, nowIso: string) => {
  return (
    job.status === "failed" ||
    job.status === "retryable" ||
    job.status === "dead" ||
    (
      job.status === "processing" &&
      job.locked_until !== null &&
      job.locked_until <= nowIso
    )
  );
};

const retryJobStatement = (db: D1Database, source: AdminSyncJobSource, jobId: string, nowIso: string) => {
  if (source === "google_calendar_import_jobs") {
    return db
      .prepare(
        `
          UPDATE google_calendar_import_jobs
          SET status = 'queued',
              next_run_at = ?,
              locked_until = NULL,
              attempt_count = 0,
              last_error = NULL,
              resume_page_token = NULL,
              resume_processed_count = 0,
              resume_sweep_start_seconds = NULL,
              resume_time_min = NULL,
              resume_yield_count = 0,
              updated_at = ?
          WHERE id = ?
            AND (
              status IN ${ATTENTION_STATUS_SQL}
              OR (
                status = 'processing'
                AND locked_until IS NOT NULL
                AND locked_until <= ?
              )
            )
        `
      )
      .bind(nowIso, nowIso, jobId, nowIso);
  }

  if (source === "calendar_sync_jobs") {
    return db
      .prepare(
        `
          UPDATE calendar_sync_jobs
          SET status = 'queued',
              available_at = ?,
              locked_until = NULL,
              attempts = 0,
              last_error = NULL,
              updated_at = ?
          WHERE id = ?
            AND (
              status IN ${ATTENTION_STATUS_SQL}
              OR (
                status = 'processing'
                AND locked_until IS NOT NULL
                AND locked_until <= ?
              )
            )
        `
      )
      .bind(nowIso, nowIso, jobId, nowIso);
  }

  return db
    .prepare(
      `
        UPDATE notification_jobs
        SET status = 'queued',
            available_at = ?,
            locked_until = NULL,
            attempts = 0,
            last_error = NULL,
            updated_at = ?
        WHERE id = ?
          AND template_key NOT IN ${RETIRED_NOTIFICATION_TEMPLATES_SQL}
          AND (last_error IS NULL OR last_error != '${LINE_MONTHLY_QUOTA_EXHAUSTED}')
          AND NOT EXISTS (${NOTIFICATION_ACKNOWLEDGEMENT_SQL})
          AND (
            status IN ${ATTENTION_STATUS_SQL}
            OR (
              status = 'processing'
              AND locked_until IS NOT NULL
              AND locked_until <= ?
            )
          )
      `
    )
    .bind(nowIso, nowIso, jobId, nowIso);
};

const retryTransitionExistsSql = (source: AdminSyncJobSource) => {
  if (source === "google_calendar_import_jobs") {
    return `
      SELECT 1
      FROM google_calendar_import_jobs
      WHERE id = ?
        AND status = 'queued'
        AND next_run_at = ?
        AND updated_at = ?
    `;
  }
  if (source === "calendar_sync_jobs") {
    return `
      SELECT 1
      FROM calendar_sync_jobs
      WHERE id = ?
        AND status = 'queued'
        AND available_at = ?
        AND updated_at = ?
    `;
  }
  return `
    SELECT 1
    FROM notification_jobs
    WHERE id = ?
      AND status = 'queued'
      AND available_at = ?
      AND updated_at = ?
  `;
};

const acknowledgeJobStatement = (
  db: D1Database,
  source: AdminSyncJobAcknowledgeRequest["source"],
  jobId: string,
  nowIso: string
) => {
  if (source === "notification_jobs") {
    // Same-value UPDATE supplies the existing changes() CAS witness without
    // altering delivery history or the failure timestamp. Audit is written in
    // this same batch; a concurrent retry must satisfy the inverse guard.
    return db.prepare(`
      UPDATE notification_jobs SET status = status
      WHERE id = ? AND status IN ('dead', 'failed')
        AND NOT EXISTS (${NOTIFICATION_ACKNOWLEDGEMENT_SQL})
    `).bind(jobId);
  }
  return db
    .prepare(
      `
        UPDATE google_calendar_import_jobs
        SET status = 'succeeded',
            locked_until = NULL,
            last_error = NULL,
            updated_at = ?
        WHERE id = ?
          AND status = 'dead'
      `
    )
    .bind(nowIso, jobId);
};

const acknowledgeTransitionExistsSql = (source: AdminSyncJobAcknowledgeRequest["source"]) => {
  if (source === "notification_jobs") {
    return `SELECT 1 FROM notification_jobs WHERE id = ? AND status IN ('dead', 'failed')
      AND NOT EXISTS (${NOTIFICATION_ACKNOWLEDGEMENT_SQL})`;
  }
  return `
    SELECT 1
    FROM google_calendar_import_jobs
    WHERE id = ?
      AND status = 'succeeded'
      AND locked_until IS NULL
      AND last_error IS NULL
      AND updated_at = ?
  `;
};

const guardAcknowledgeTransitionApplied = (input: {
  db: D1Database;
  idempotencyId: string;
  idempotencyKey: string;
  requestHash: string;
  expiresAt: string;
  source: AdminSyncJobAcknowledgeRequest["source"];
  jobId: string;
  nowIso: string;
}) => [
  input.db
    .prepare(
      `
        UPDATE idempotency_keys
        SET target_type = 'sync_acknowledge_transition',
            target_id = ?,
            updated_at = ?
        WHERE id = ?
          AND changes() > 0
          AND EXISTS (${acknowledgeTransitionExistsSql(input.source)})
      `
    )
    .bind(input.jobId, input.nowIso, input.idempotencyId, input.jobId,
      ...(input.source === "notification_jobs" ? [] : [input.nowIso])),
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
            AND target_type = 'sync_acknowledge_transition'
        )
      `
    )
    .bind(
      crypto.randomUUID(),
      input.idempotencyKey,
      input.requestHash,
      input.expiresAt,
      input.nowIso,
      input.idempotencyId
    )
];

const guardRetryTransitionApplied = (input: {
  db: D1Database;
  idempotencyId: string;
  idempotencyKey: string;
  requestHash: string;
  expiresAt: string;
  source: AdminSyncJobSource;
  jobId: string;
  nowIso: string;
}) => [
  input.db
    .prepare(
      `
        UPDATE idempotency_keys
        SET target_type = 'sync_retry_transition',
            target_id = ?,
            updated_at = ?
        WHERE id = ?
          AND changes() > 0
          AND EXISTS (${retryTransitionExistsSql(input.source)})
      `
    )
    .bind(input.jobId, input.nowIso, input.idempotencyId, input.jobId, input.nowIso, input.nowIso),
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
            AND target_type = 'sync_retry_transition'
        )
      `
    )
    .bind(
      crypto.randomUUID(),
      input.idempotencyKey,
      input.requestHash,
      input.expiresAt,
      input.nowIso,
      input.idempotencyId
    )
];

const readJobResult = async (
  db: D1Database,
  source: AdminSyncJobSource,
  jobId: string,
  replayed: boolean
): Promise<AdminSyncJobRetryResult> => {
  const job = await fetchJob(db, source, jobId);
  if (!job) {
    return {
      ok: false,
      reason: "write_failed"
    };
  }
  if (source === "notification_jobs" && isNotificationRetryBlocked(job)) {
    return { ok: false, reason: "invalid_transition" };
  }
  return {
    ok: true,
    action: "retry_job",
    source,
    jobId,
    status: job.status,
    replayed
  };
};

const readAcknowledgeJobResult = async (
  db: D1Database,
  source: AdminSyncJobAcknowledgeRequest["source"],
  jobId: string,
  replayed: boolean
): Promise<AdminSyncJobAcknowledgeResult> => {
  const job = await fetchJob(db, source, jobId);
  if (!job) {
    return {
      ok: false,
      reason: "write_failed"
    };
  }
  return {
    ok: true,
    action: "acknowledge_job",
    source,
    jobId,
    status: job.status,
    replayed
  };
};

const resolveRetryIdempotency = async (
  db: D1Database,
  idempotencyKey: string,
  requestHash: string,
  nowIso: string
): Promise<AdminSyncJobRetryResult | undefined> => {
  const idempotency = await fetchIdempotency(db, idempotencyKey, nowIso);
  if (!idempotency) {
    return undefined;
  }
  if (idempotency.request_hash !== requestHash) {
    return {
      ok: false,
      reason: "idempotency_conflict"
    };
  }
  if (
    idempotency.status === "succeeded" &&
    isAdminSyncJobSource(idempotency.target_type) &&
    idempotency.target_id
  ) {
    return readJobResult(db, idempotency.target_type, idempotency.target_id, true);
  }
  return {
    ok: false,
    reason: "idempotency_in_progress"
  };
};

const resolveAcknowledgeIdempotency = async (
  db: D1Database,
  idempotencyKey: string,
  requestHash: string,
  nowIso: string
): Promise<AdminSyncJobAcknowledgeResult | undefined> => {
  const idempotency = await fetchIdempotency(db, idempotencyKey, nowIso);
  if (!idempotency) {
    return undefined;
  }
  if (idempotency.request_hash !== requestHash) {
    return {
      ok: false,
      reason: "idempotency_conflict"
    };
  }
  if (
    idempotency.status === "succeeded" &&
    (idempotency.target_type === "google_calendar_import_jobs" || idempotency.target_type === "notification_jobs") &&
    idempotency.target_id
  ) {
    return readAcknowledgeJobResult(db, idempotency.target_type, idempotency.target_id, true);
  }
  return {
    ok: false,
    reason: "idempotency_in_progress"
  };
};

const fetchConflict = async (db: D1Database, conflictId: string) => {
  return db
    .prepare(
      `
        SELECT id, resolution_status, conflict_type, external_block_id
        FROM google_calendar_conflicts
        WHERE id = ?
        LIMIT 1
      `
    )
    .bind(conflictId)
    .first<ConflictRow>();
};

const readConflictResult = async (
  db: D1Database,
  conflictId: string,
  replayed: boolean
): Promise<AdminSyncConflictResolutionResult> => {
  const conflict = await fetchConflict(db, conflictId);
  if (!conflict) {
    return {
      ok: false,
      reason: "write_failed"
    };
  }
  if (conflict.resolution_status !== "ignored" && conflict.resolution_status !== "manual_resolved") {
    return {
      ok: false,
      reason: "invalid_transition"
    };
  }
  return {
    ok: true,
    action: "resolve_conflict",
    conflictId,
    resolutionStatus: conflict.resolution_status,
    replayed
  };
};

const resolveConflictIdempotency = async (
  db: D1Database,
  idempotencyKey: string,
  requestHash: string,
  nowIso: string
): Promise<AdminSyncConflictResolutionResult | undefined> => {
  const idempotency = await fetchIdempotency(db, idempotencyKey, nowIso);
  if (!idempotency) {
    return undefined;
  }
  if (idempotency.request_hash !== requestHash) {
    return {
      ok: false,
      reason: "idempotency_conflict"
    };
  }
  if (
    idempotency.status === "succeeded" &&
    idempotency.target_type === "google_calendar_conflict" &&
    idempotency.target_id
  ) {
    return readConflictResult(db, idempotency.target_id, true);
  }
  return {
    ok: false,
    reason: "idempotency_in_progress"
  };
};

const validateConflictResolutionRequest = (input: {
  admin: AdminUser;
  conflictId: string;
  request: AdminSyncConflictResolutionRequest;
}): AdminSyncConflictResolutionResult | undefined => {
  if (input.admin.role !== "system_admin") {
    return {
      ok: false,
      reason: "forbidden"
    };
  }
  if (
    !isNonEmptyString(input.conflictId, 256) ||
    !isNonEmptyString(input.request.idempotencyKey, 256) ||
    (input.request.note !== undefined && !isNonEmptyString(input.request.note, 500))
  ) {
    return {
      ok: false,
      reason: "invalid_request"
    };
  }
  return undefined;
};

// Shared recovery for a failed db.batch() across retry / acknowledge / conflict
// resolution: re-resolve the idempotency row (a concurrent in-flight request
// replays its cached/in-progress result) and, when that yields nothing, capture
// the swallowed batch failure and return the terminal write_failed. All three
// resolvers share the (db, key, hash, nowIso) → Result|undefined signature.
const recoverSyncBatchWriteFailure = async <T>(
  resolveConcurrent: (
    db: D1Database,
    idempotencyKey: string,
    requestHash: string,
    nowIso: string
  ) => Promise<T | undefined>,
  db: D1Database,
  idempotencyKey: string,
  requestHash: string,
  nowIso: string,
  error: unknown,
  helper: string
): Promise<T | { ok: false; reason: "write_failed" }> => {
  try {
    const concurrent = await resolveConcurrent(db, idempotencyKey, requestHash, nowIso);
    if (concurrent) return concurrent;
  } catch (lookupError) {
    captureBatchWriteFailure(lookupError, { component: "sync-recovery", op: "idempotency_lookup_failed", helper });
  }
  captureBatchWriteFailure(error, { component: "sync-recovery", op: "batch_write_failed", helper });
  return { ok: false, reason: "write_failed" };
};

const guardConflictTransitionApplied = (input: {
  db: D1Database;
  idempotencyId: string;
  idempotencyKey: string;
  requestHash: string;
  expiresAt: string;
  conflictId: string;
  resolutionStatus: "ignored" | "manual_resolved";
  adminId: string;
  nowIso: string;
}) => [
  input.db
    .prepare(
      `
        UPDATE idempotency_keys
        SET target_type = 'google_conflict_transition',
            target_id = ?,
            updated_at = ?
        WHERE id = ?
          AND changes() > 0
          AND EXISTS (
            SELECT 1
            FROM google_calendar_conflicts
            WHERE id = ?
              AND resolution_status = ?
              AND resolved_at = ?
              AND resolved_by = ?
          )
      `
    )
    .bind(
      input.conflictId,
      input.nowIso,
      input.idempotencyId,
      input.conflictId,
      input.resolutionStatus,
      input.nowIso,
      input.adminId
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
            AND target_type = 'google_conflict_transition'
        )
      `
    )
    .bind(
      crypto.randomUUID(),
      input.idempotencyKey,
      input.requestHash,
      input.expiresAt,
      input.nowIso,
      input.idempotencyId
    )
];

export async function retryAdminSyncJob(input: {
  db: D1Database;
  admin: AdminUser;
  request: AdminSyncJobRetryRequest;
  now?: () => number;
}): Promise<AdminSyncJobRetryResult> {
  if (input.admin.role !== "system_admin") {
    return {
      ok: false,
      reason: "forbidden"
    };
  }
  if (
    !isNonEmptyString(input.request.idempotencyKey, 256) ||
    !isAdminSyncJobSource(input.request.source) ||
    !isNonEmptyString(input.request.jobId, 256)
  ) {
    return {
      ok: false,
      reason: "invalid_request"
    };
  }

  const requestHash = await createRequestHash({
    action: "admin_sync_job_retry",
    source: input.request.source,
    jobId: input.request.jobId
  });
  // Single clock stamps expires_at on write AND filters the TTL read (F-6.1).
  const nowMs = (input.now ?? Date.now)();
  const nowIso = toIso(new Date(nowMs));
  const idempotency = await fetchIdempotency(input.db, input.request.idempotencyKey, nowIso);
  if (idempotency) {
    if (idempotency.request_hash !== requestHash) {
      return {
        ok: false,
        reason: "idempotency_conflict"
      };
    }
    if (
      idempotency.status === "succeeded" &&
      isAdminSyncJobSource(idempotency.target_type) &&
      idempotency.target_id
    ) {
      return readJobResult(input.db, idempotency.target_type, idempotency.target_id, true);
    }
    return {
      ok: false,
      reason: "idempotency_in_progress"
    };
  }

  const job = await fetchJob(input.db, input.request.source, input.request.jobId);
  if (!job) {
    return {
      ok: false,
      reason: "not_found"
    };
  }
  if (!isRetryableAttentionJob(job, nowIso) ||
    (input.request.source === "notification_jobs" && isNotificationRetryBlocked(job))) {
    return {
      ok: false,
      reason: "invalid_transition"
    };
  }

  const idempotencyId = crypto.randomUUID();
  const expiresAt = toIso(new Date(nowMs + IDEMPOTENCY_TTL_MS));

  try {
    await input.db.batch([
      adminWriteGuard(input.db, input.admin),
      startedIdempotencyStatement({
        db: input.db,
        id: idempotencyId,
        key: input.request.idempotencyKey,
        requestHash,
        expiresAt,
        nowIso
      }),
      retryJobStatement(input.db, input.request.source, input.request.jobId, nowIso),
      ...guardRetryTransitionApplied({
        db: input.db,
        idempotencyId,
        idempotencyKey: input.request.idempotencyKey,
        requestHash,
        expiresAt,
        source: input.request.source,
        jobId: input.request.jobId,
        nowIso
      }),
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
            ) VALUES (?, 'staff', ?, 'admin_sync_job_retry_queued', ?, ?, ?)
          `
        )
        .bind(
          crypto.randomUUID(),
          input.admin.id,
          input.request.source,
          input.request.jobId,
          JSON.stringify({
            source: input.request.source,
            previousStatus: job.status,
            adminRole: input.admin.role
          })
        ),
      succeededIdempotencyStatement({
        db: input.db,
        id: idempotencyId,
        targetType: input.request.source,
        targetId: input.request.jobId,
        nowIso
      })
    ]);
  } catch (error) {
    if (await adminWriteWasRevoked(input.db, input.admin, error)) return { ok: false, reason: "forbidden" };
    return recoverSyncBatchWriteFailure(
      resolveRetryIdempotency,
      input.db,
      input.request.idempotencyKey,
      requestHash,
      nowIso,
      error,
      "retry"
    );
  }

  return readJobResult(input.db, input.request.source, input.request.jobId, false);
}

export async function acknowledgeAdminSyncJob(input: {
  db: D1Database;
  admin: AdminUser;
  request: AdminSyncJobAcknowledgeRequest;
  now?: () => number;
}): Promise<AdminSyncJobAcknowledgeResult> {
  if (input.admin.role !== "system_admin") {
    return {
      ok: false,
      reason: "forbidden"
    };
  }
  if (
    !isNonEmptyString(input.request.idempotencyKey, 256) ||
    (input.request.source !== "google_calendar_import_jobs" && input.request.source !== "notification_jobs") ||
    !isNonEmptyString(input.request.jobId, 256) ||
    !isNonEmptyString(input.request.note, 500)
  ) {
    return {
      ok: false,
      reason: "invalid_request"
    };
  }

  const note = input.request.note.trim();
  const requestHash = await createRequestHash({
    action: "admin_sync_job_acknowledge",
    source: input.request.source,
    jobId: input.request.jobId,
    note
  });
  const nowMs = (input.now ?? Date.now)();
  const nowIso = toIso(new Date(nowMs));
  const idempotency = await resolveAcknowledgeIdempotency(
    input.db,
    input.request.idempotencyKey,
    requestHash,
    nowIso
  );
  if (idempotency) {
    return idempotency;
  }

  const job = await fetchJob(input.db, input.request.source, input.request.jobId);
  if (!job) {
    return {
      ok: false,
      reason: "not_found"
    };
  }
  if (job.acknowledged || (job.status !== "dead" &&
    !(input.request.source === "notification_jobs" && job.status === "failed"))) {
    return {
      ok: false,
      reason: "invalid_transition"
    };
  }

  const idempotencyId = crypto.randomUUID();
  const expiresAt = toIso(new Date(nowMs + IDEMPOTENCY_TTL_MS));

  try {
    await input.db.batch([
      adminWriteGuard(input.db, input.admin),
      startedIdempotencyStatement({
        db: input.db,
        id: idempotencyId,
        key: input.request.idempotencyKey,
        requestHash,
        expiresAt,
        nowIso
      }),
      acknowledgeJobStatement(input.db, input.request.source, input.request.jobId, nowIso),
      ...guardAcknowledgeTransitionApplied({
        db: input.db,
        idempotencyId,
        idempotencyKey: input.request.idempotencyKey,
        requestHash,
        expiresAt,
        source: input.request.source,
        jobId: input.request.jobId,
        nowIso
      }),
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
            SELECT ?, 'staff', ?, 'admin_sync_job_acknowledged', ?, ?, ?
            WHERE EXISTS (
              SELECT 1
              FROM idempotency_keys
              WHERE id = ?
                AND target_type = 'sync_acknowledge_transition'
            )
          `
        )
        .bind(
          crypto.randomUUID(),
          input.admin.id,
          input.request.source,
          input.request.jobId,
          JSON.stringify({
            source: input.request.source,
            previousStatus: job.status,
            ...(input.request.source === "google_calendar_import_jobs" ? { previousLastError: job.last_error } : {}),
            adminRole: input.admin.role,
            note
          }),
          idempotencyId
        ),
      input.db
        .prepare(
          `
            UPDATE idempotency_keys
            SET status = 'succeeded',
                target_type = ?,
                target_id = ?,
                updated_at = ?
            WHERE id = ?
              AND target_type = 'sync_acknowledge_transition'
          `
        )
        .bind(input.request.source, input.request.jobId, nowIso, idempotencyId)
    ]);
  } catch (error) {
    if (await adminWriteWasRevoked(input.db, input.admin, error)) return { ok: false, reason: "forbidden" };
    return recoverSyncBatchWriteFailure(
      resolveAcknowledgeIdempotency,
      input.db,
      input.request.idempotencyKey,
      requestHash,
      nowIso,
      error,
      "acknowledge"
    );
  }

  return readAcknowledgeJobResult(input.db, input.request.source, input.request.jobId, false);
}

/**
 * Auto-handled conflict types that do not require manual intervention.
 * These are either auto-reverted by the import processor or self-resolving.
 */
const AUTO_HANDLED_CONFLICT_TYPES = new Set([
  "slot_conflict",
  "external_block_too_long"
]);

export type OwnerConflictStoreCount = {
  storeId: string;
  total: number;
  actionRequired: number;
};

export type OwnerConflictAggregate = {
  totalConflicts: number;
  totalRequiringAction: number;
  perStore: OwnerConflictStoreCount[];
};

// This aggregate contains counts only. The separate actionableConflicts projection
// exposes the two authorized business decisions without provider internals.
// Aggregates open conflicts at the SQL layer with GROUP BY so the counts reflect the
// full open set for the owner's stores, not just the first 100 rows. The auto-handled
// classification reuses AUTO_HANDLED_CONFLICT_TYPES via parameter binding, so the
// policy stays single-source.
export async function aggregateGoogleConflictsForOwner(
  db: D1Database,
  storeIds: ReadonlyArray<string>
): Promise<OwnerConflictAggregate> {
  if (storeIds.length === 0) {
    return { totalConflicts: 0, totalRequiringAction: 0, perStore: [] };
  }
  const storePlaceholders = storeIds.map(() => "?").join(", ");
  const autoHandledTypes = [...AUTO_HANDLED_CONFLICT_TYPES];
  const autoHandledPlaceholders = autoHandledTypes.map(() => "?").join(", ");
  const autoHandledClause = autoHandledTypes.length > 0
    ? `AND conflict_type NOT IN (${autoHandledPlaceholders})`
    : "";
  const rows = await db
    .prepare(
      `
        SELECT
          store_id,
          COUNT(*) AS total,
          SUM(CASE WHEN 1=1 ${autoHandledClause} THEN 1 ELSE 0 END) AS action_required
        FROM google_calendar_conflicts
        WHERE resolution_status = 'open'
          AND store_id IN (${storePlaceholders})
        GROUP BY store_id
      `
    )
    .bind(...autoHandledTypes, ...storeIds)
    .all<{ store_id: string; total: number; action_required: number | null }>();

  let totalConflicts = 0;
  let totalRequiringAction = 0;
  const perStore: OwnerConflictStoreCount[] = (rows.results ?? [])
    .map((row) => {
      const total = Number(row.total) || 0;
      const actionRequired = Number(row.action_required ?? 0) || 0;
      totalConflicts += total;
      totalRequiringAction += actionRequired;
      return { storeId: row.store_id, total, actionRequired };
    })
    .sort((a, b) => a.storeId.localeCompare(b.storeId));

  return { totalConflicts, totalRequiringAction, perStore };
}

export async function resolveAdminGoogleConflict(input: {
  db: D1Database;
  admin: AdminUser;
  conflictId: string;
  resolutionStatus: "ignored" | "manual_resolved";
  request: AdminSyncConflictResolutionRequest;
  now?: () => number;
}): Promise<AdminSyncConflictResolutionResult> {
  const validationResult = validateConflictResolutionRequest(input);
  if (validationResult) {
    return validationResult;
  }

  const cancelExternalBlock = input.request.cancelExternalBlock === true;
  const requestHash = await createRequestHash({
    action: "admin_google_conflict_resolution",
    conflictId: input.conflictId,
    resolutionStatus: input.resolutionStatus,
    note: input.request.note?.trim() ?? null,
    cancelExternalBlock
  });
  // Single clock stamps expires_at on write AND filters the TTL read (F-6.1).
  const nowMs = (input.now ?? Date.now)();
  const nowIso = toIso(new Date(nowMs));
  const idempotencyResult = await resolveConflictIdempotency(input.db, input.request.idempotencyKey, requestHash, nowIso);
  if (idempotencyResult) {
    return idempotencyResult;
  }

  const conflict = await fetchConflict(input.db, input.conflictId);
  if (!conflict) {
    return {
      ok: false,
      reason: "not_found"
    };
  }
  if (conflict.resolution_status !== "open") {
    return {
      ok: false,
      reason: "invalid_transition"
    };
  }
  // cancelExternalBlock is only honored when the conflict is the dedicated
  // external_block_event_deleted type and the staff resolution is the
  // manual_resolved positive close (Step 5 plan). Otherwise reject before
  // any side effect, mirroring the existing invalid_transition behavior.
  if (cancelExternalBlock) {
    if (
      input.resolutionStatus !== "manual_resolved" ||
      conflict.conflict_type !== "external_block_event_deleted" ||
      !conflict.external_block_id
    ) {
      return {
        ok: false,
        reason: "invalid_transition"
      };
    }
  }

  const idempotencyId = crypto.randomUUID();
  const expiresAt = toIso(new Date(nowMs + IDEMPOTENCY_TTL_MS));
  const action =
    input.resolutionStatus === "ignored"
      ? "admin_google_conflict_ignored"
      : "admin_google_conflict_manual_resolved";

  try {
    await input.db.batch([
      adminWriteGuard(input.db, input.admin),
      startedIdempotencyStatement({
        db: input.db,
        id: idempotencyId,
        key: input.request.idempotencyKey,
        requestHash,
        expiresAt,
        nowIso
      }),
      input.db
        .prepare(
          `
            UPDATE google_calendar_conflicts
            SET resolution_status = ?,
                resolved_at = ?,
                resolved_by = ?
            WHERE id = ?
              AND resolution_status = 'open'
          `
        )
        .bind(input.resolutionStatus, nowIso, input.admin.id, input.conflictId),
      ...guardConflictTransitionApplied({
        db: input.db,
        idempotencyId,
        idempotencyKey: input.request.idempotencyKey,
        requestHash,
        expiresAt,
        conflictId: input.conflictId,
        resolutionStatus: input.resolutionStatus,
        adminId: input.admin.id,
        nowIso
      }),
      // Step 5 atomic resolve — side effects only fire when the guard tagged
      // the idempotency_keys row as a confirmed conflict transition (which
      // requires the prior conflict UPDATE's changes() > 0). On a lost race
      // none of the three statements below touch any row.
      ...(cancelExternalBlock && conflict.external_block_id
        ? [
            input.db
              .prepare(
                `
                  UPDATE external_blocks
                  SET status = 'cancelled', updated_at = ?
                  WHERE id = ?
                    AND status = 'active'
                    AND EXISTS (
                      SELECT 1 FROM idempotency_keys
                      WHERE id = ?
                        AND target_type = 'google_conflict_transition'
                    )
                `
              )
              .bind(nowIso, conflict.external_block_id, idempotencyId),
            input.db
              .prepare(
                `
                  INSERT INTO slot_lock_history (
                    id, slot_lock_id, store_id, resource_id,
                    old_slot_at, old_owner_id, action, actor_type, actor_id, reason
                  )
                  SELECT
                    -- 36-char UUID v4 generated row-by-row inside SQLite so
                    -- each history row stays within the repo's id convention
                    -- (slot_lock_history.id is TEXT PK and other writers use
                    -- crypto.randomUUID() which yields 36 chars).
                    lower(hex(randomblob(4)))
                      || '-' || lower(hex(randomblob(2)))
                      || '-4' || substr(lower(hex(randomblob(2))), 2)
                      || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2)
                      || '-' || lower(hex(randomblob(6))),
                    sl.id,
                    sl.store_id,
                    sl.resource_id,
                    sl.slot_at,
                    sl.owner_id,
                    'released',
                    'staff',
                    ?,
                    'admin_atomic_resolve_external_block_cancel'
                  FROM slot_locks sl
                  WHERE sl.owner_type = 'external_block'
                    AND sl.owner_id = ?
                    AND EXISTS (
                      SELECT 1 FROM idempotency_keys
                      WHERE id = ?
                        AND target_type = 'google_conflict_transition'
                    )
                `
              )
              .bind(
                input.admin.id,
                conflict.external_block_id,
                idempotencyId
              ),
            input.db
              .prepare(
                `
                  DELETE FROM slot_locks
                  WHERE owner_type = 'external_block'
                    AND owner_id = ?
                    AND EXISTS (
                      SELECT 1 FROM idempotency_keys
                      WHERE id = ?
                        AND target_type = 'google_conflict_transition'
                    )
                `
              )
              .bind(conflict.external_block_id, idempotencyId)
          ]
        : []),
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
            ) VALUES (?, 'staff', ?, ?, 'google_calendar_conflict', ?, ?)
          `
        )
        .bind(
          crypto.randomUUID(),
          input.admin.id,
          action,
          input.conflictId,
          JSON.stringify({
            resolutionStatus: input.resolutionStatus,
            note: input.request.note?.trim() ?? null,
            adminRole: input.admin.role,
            ...(cancelExternalBlock && conflict.external_block_id
              ? { cancelledExternalBlockId: conflict.external_block_id }
              : {})
          })
        ),
      succeededIdempotencyStatement({
        db: input.db,
        id: idempotencyId,
        targetType: "google_calendar_conflict",
        targetId: input.conflictId,
        nowIso
      })
    ]);
  } catch (error) {
    if (await adminWriteWasRevoked(input.db, input.admin, error)) return { ok: false, reason: "forbidden" };
    return recoverSyncBatchWriteFailure(
      resolveConflictIdempotency,
      input.db,
      input.request.idempotencyKey,
      requestHash,
      nowIso,
      error,
      "resolve_conflict"
    );
  }

  return readConflictResult(input.db, input.conflictId, false);
}
