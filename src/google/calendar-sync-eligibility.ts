/**
 * Calendar sync eligibility and cleanup helpers.
 *
 * This module provides symmetric pre-write eligibility checks and post-write
 * stale cleanup logic for both reservation and external_block owner types.
 *
 * The pattern (for both sides):
 *   1. Pre-write: isStillUpsertable — abort the Google write if the D1 state
 *      no longer warrants it (race between job dequeue and status change).
 *   2. Post-write: shouldDeleteEventAfterWrite — detect status transitions
 *      that happened during the Google API call and flag for cleanup.
 *   3. Cleanup: persistStaleGoogleEventCleanup — record the newly-created
 *      event_id and enqueue a follow-up delete job so the next sync pass
 *      removes the orphan from Google Calendar.
 */

// Types (re-declared locally to keep the module self-contained; the canonical
// types remain in calendar-sync.ts and are structurally compatible)

type ReservationCalendarSyncJobRow = {
  job_id: string;
  dedupe_key: string;
  owner_type: "reservation";
  owner_id: string;
  google_action: string;
  attempts: number;
  reservation_id: string;
  external_block_id: null;
  store_id: string;
  timezone: string;
  calendar_id: string;
  status: string;
  start_at: string;
  end_at: string;
  service_names: string | null;
  customer_name: string | null;
  google_event_id: string | null;
  google_event_etag: string | null;
  version: number;
};

type ExternalBlockCalendarSyncJobRow = {
  job_id: string;
  dedupe_key: string;
  owner_type: "external_block";
  owner_id: string;
  google_action: string;
  attempts: number;
  reservation_id: null;
  external_block_id: string;
  store_id: string;
  timezone: string;
  calendar_id: string;
  status: "active" | "cancelled";
  start_at: string;
  end_at: string;
  service_names: string | null;
  customer_name: string | null;
  google_event_id: string | null;
  google_event_etag: string | null;
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

type CalendarSyncJobOutcome = "succeeded" | "failed" | "skipped";

type ReservationUpsertEligibilityRow = {
  status: string;
  pending_expires_at: string | null;
};

type ExternalBlockEligibilityRow = {
  status: string;
};

// Shared SQL and utilities

const OUTBOUND_WRITE_TTL_MS = 24 * 60 * 60 * 1000;

const toIso = (ms: number) => new Date(ms).toISOString();

const hasChangedRows = (result: D1Result) => {
  return Number(result.meta?.changes ?? 0) > 0;
};

const calendarSyncJobClaimExistsSql = `
  SELECT 1
  FROM calendar_sync_jobs
  WHERE id = ?
    AND status = 'processing'
    AND attempts = ?
    AND locked_until = ?
`;

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

const calendarSyncJobClaimOrExternalBlockSupersededSql = `
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
        AND last_error = 'superseded_by_external_block_cancellation'
      )
    )
`;

const calendarSyncJobClaimBindings = (
  row: { job_id: string },
  claim: CalendarSyncJobClaim
) => [row.job_id, claim.attempts, claim.lockedUntil];

// Reservation eligibility helpers

/**
 * Pre-write check: Is the reservation still in a state that warrants an
 * upsert to Google Calendar?
 *
 * Returns true for confirmed/completed/no_show or non-expired pending_approval.
 */
export const isReservationStillUpsertable = async (
  db: D1Database,
  row: ReservationCalendarSyncJobRow,
  nowIso: string
): Promise<boolean> => {
  const reservation = await db
    .prepare(
      `
        SELECT status, pending_expires_at
        FROM reservations
        WHERE id = ?
        LIMIT 1
      `
    )
    .bind(row.reservation_id)
    .first<ReservationUpsertEligibilityRow>();

  return reservation?.status === "confirmed" ||
    reservation?.status === "completed" ||
    reservation?.status === "no_show" ||
    (reservation?.status === "pending_approval" &&
      (reservation.pending_expires_at === null || reservation.pending_expires_at > nowIso));
};

/**
 * Post-write check: Has the reservation transitioned to a terminal state
 * during the Google API call, making the just-written event stale?
 */
export const shouldDeleteReservationEventAfterWrite = async (
  db: D1Database,
  row: ReservationCalendarSyncJobRow,
  nowIso: string
): Promise<boolean> => {
  const reservation = await db
    .prepare(
      `
        SELECT status, pending_expires_at
        FROM reservations
        WHERE id = ?
        LIMIT 1
      `
    )
    .bind(row.reservation_id)
    .first<ReservationUpsertEligibilityRow>();

  return reservation?.status === "rejected" ||
    reservation?.status === "expired" ||
    reservation?.status === "cancelled_by_customer" ||
    reservation?.status === "cancelled_by_admin" ||
    (
      reservation?.status === "pending_approval" &&
      reservation.pending_expires_at !== null &&
      reservation.pending_expires_at <= nowIso
    );
};

/**
 * Cleanup: Record the stale event_id, insert into google_calendar_events and
 * outbound_writes, and enqueue a follow-up delete job.
 */
export const persistStaleReservationGoogleEventCleanup = async (
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
              google_sync_state = 'pending',
              updated_at = ?
          WHERE id = ?
            AND (
              status IN ('rejected', 'expired', 'cancelled_by_customer', 'cancelled_by_admin')
              OR (
                status = 'pending_approval'
                AND pending_expires_at IS NOT NULL
                AND pending_expires_at <= ?
              )
            )
            AND EXISTS (${calendarSyncJobClaimOrExpirySupersededSql})
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
                status IN ('rejected', 'expired', 'cancelled_by_customer', 'cancelled_by_admin')
                OR (
                  status = 'pending_approval'
                  AND pending_expires_at IS NOT NULL
                  AND pending_expires_at <= ?
                )
              )
          )
          AND EXISTS (${calendarSyncJobClaimOrExpirySupersededSql})
          ON CONFLICT(calendar_id, google_event_id) DO UPDATE SET
            reservation_id = excluded.reservation_id,
            -- Clear external_block_id symmetric to the external_block-side
            -- cleanup at L578 which clears reservation_id. If a prior
            -- google_event_id row was sourced from external_block and
            -- this reservation cleanup is rewriting it, we must drop the
            -- stale external_block linkage. Gemini PR review medium adopted.
            external_block_id = NULL,
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
          end_at: row.end_at,
          stale_after_write: true
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
                status IN ('rejected', 'expired', 'cancelled_by_customer', 'cancelled_by_admin')
                OR (
                  status = 'pending_approval'
                  AND pending_expires_at IS NOT NULL
                  AND pending_expires_at <= ?
                )
              )
          )
          AND EXISTS (${calendarSyncJobClaimOrExpirySupersededSql})
        `
      )
      .bind(
        crypto.randomUUID(),
        row.job_id,
        `calendar_sync_job:${row.job_id}:stale-upsert:${payloadFingerprint}`,
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
          INSERT OR IGNORE INTO calendar_sync_jobs (
            id,
            dedupe_key,
            owner_type,
            owner_id,
            google_action,
            status,
            available_at
          )
          SELECT ?, ?, 'reservation', ?, 'delete', 'queued', ?
          WHERE EXISTS (
            SELECT 1
            FROM reservations
            WHERE id = ?
              AND (
                status IN ('rejected', 'expired', 'cancelled_by_customer', 'cancelled_by_admin')
                OR (
                  status = 'pending_approval'
                  AND pending_expires_at IS NOT NULL
                  AND pending_expires_at <= ?
                )
              )
          )
          AND EXISTS (${calendarSyncJobClaimOrExpirySupersededSql})
        `
      )
      .bind(
        crypto.randomUUID(),
        `calendar_sync_job:${row.job_id}:stale-reservation-delete`,
        row.reservation_id,
        nowIso,
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
          SELECT ?, 'system', 'calendar_sync', 'google_calendar_event_upsert_superseded', 'reservation', ?, ?
          WHERE EXISTS (
            SELECT 1
            FROM reservations
            WHERE id = ?
              AND (
                status IN ('rejected', 'expired', 'cancelled_by_customer', 'cancelled_by_admin')
                OR (
                  status = 'pending_approval'
                  AND pending_expires_at IS NOT NULL
                  AND pending_expires_at <= ?
                )
              )
          )
          AND EXISTS (${calendarSyncJobClaimOrExpirySupersededSql})
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
    db
      .prepare(
        `
          UPDATE calendar_sync_jobs
          SET status = 'succeeded',
              locked_until = NULL,
              last_error = 'superseded_by_reservation_expiry_after_google_write',
              updated_at = ?
          WHERE id = ?
            AND EXISTS (${calendarSyncJobClaimOrExpirySupersededSql})
        `
      )
      .bind(nowIso, row.job_id, ...calendarSyncJobClaimBindings(row, claim))
  ]);
  return hasChangedRows(results[5]) ? "succeeded" : "skipped";
};

// External block eligibility helpers

/**
 * Pre-write check: Is the external block still in a state that warrants an
 * upsert to Google Calendar?
 *
 * Returns true only when status = 'active'. If the block has been cancelled
 * between dequeue and write, the upsert should be superseded.
 */
export const isExternalBlockStillUpsertable = async (
  db: D1Database,
  row: ExternalBlockCalendarSyncJobRow
): Promise<boolean> => {
  const block = await db
    .prepare(
      `
        SELECT status
        FROM external_blocks
        WHERE id = ?
        LIMIT 1
      `
    )
    .bind(row.external_block_id)
    .first<ExternalBlockEligibilityRow>();

  return block?.status === "active";
};

/**
 * Post-write check: Has the external block been cancelled during the Google
 * API call, making the just-written event stale?
 */
export const shouldDeleteExternalBlockEventAfterWrite = async (
  db: D1Database,
  row: ExternalBlockCalendarSyncJobRow
): Promise<boolean> => {
  const block = await db
    .prepare(
      `
        SELECT status
        FROM external_blocks
        WHERE id = ?
        LIMIT 1
      `
    )
    .bind(row.external_block_id)
    .first<ExternalBlockEligibilityRow>();

  return block?.status === "cancelled";
};

/**
 * Cleanup: Record the stale event_id for the external block, insert into
 * google_calendar_events and outbound_writes, and enqueue a follow-up delete
 * job so the next sync pass removes the orphan from Google Calendar.
 *
 * Symmetric to persistStaleReservationGoogleEventCleanup.
 */
export const persistStaleExternalBlockGoogleEventCleanup = async (
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

  const results = await db.batch([
    // [0] Update external_blocks with the new google_event_id (guarded by
    //     status='cancelled' so we only proceed if the block is truly stale)
    db
      .prepare(
        `
          UPDATE external_blocks
          SET google_event_id = ?,
              google_event_etag = ?,
              updated_at = ?
          WHERE id = ?
            AND status = 'cancelled'
            AND EXISTS (${calendarSyncJobClaimOrExternalBlockSupersededSql})
        `
      )
      .bind(event.id, etag, nowIso, row.external_block_id, ...calendarSyncJobClaimBindings(row, claim)),
    // [1] Record in google_calendar_events tracking table
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
            SELECT 1
            FROM external_blocks
            WHERE id = ?
              AND status = 'cancelled'
          )
          AND EXISTS (${calendarSyncJobClaimOrExternalBlockSupersededSql})
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
          end_at: row.end_at,
          stale_after_write: true
        }),
        row.external_block_id,
        ...calendarSyncJobClaimBindings(row, claim)
      ),
    // [2] Record in outbound_writes for echo suppression
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
            SELECT 1
            FROM external_blocks
            WHERE id = ?
              AND status = 'cancelled'
          )
          AND EXISTS (${calendarSyncJobClaimOrExternalBlockSupersededSql})
        `
      )
      .bind(
        crypto.randomUUID(),
        row.job_id,
        `calendar_sync_job:${row.job_id}:stale-upsert:${payloadFingerprint}`,
        row.calendar_id,
        event.id,
        row.external_block_id,
        payloadFingerprint,
        etag,
        outboundExpiresAt,
        row.external_block_id,
        ...calendarSyncJobClaimBindings(row, claim)
      ),
    // [3] Enqueue follow-up delete job
    db
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
          )
          SELECT ?, ?, 'external_block', ?, 'delete', 'queued', ?
          WHERE EXISTS (
            SELECT 1
            FROM external_blocks
            WHERE id = ?
              AND status = 'cancelled'
          )
          AND EXISTS (${calendarSyncJobClaimOrExternalBlockSupersededSql})
        `
      )
      .bind(
        crypto.randomUUID(),
        `calendar_sync_job:${row.job_id}:stale-external-block-delete`,
        row.external_block_id,
        nowIso,
        row.external_block_id,
        ...calendarSyncJobClaimBindings(row, claim)
      ),
    // [4] Audit log
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
          SELECT ?, 'system', 'calendar_sync', 'google_calendar_external_block_upsert_superseded', 'external_block', ?, ?
          WHERE EXISTS (
            SELECT 1
            FROM external_blocks
            WHERE id = ?
              AND status = 'cancelled'
          )
          AND EXISTS (${calendarSyncJobClaimOrExternalBlockSupersededSql})
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
      ),
    // [5] Mark the original upsert job as succeeded (superseded)
    db
      .prepare(
        `
          UPDATE calendar_sync_jobs
          SET status = 'succeeded',
              locked_until = NULL,
              last_error = 'superseded_by_external_block_cancellation_after_google_write',
              updated_at = ?
          WHERE id = ?
            AND EXISTS (${calendarSyncJobClaimOrExternalBlockSupersededSql})
        `
      )
      .bind(nowIso, row.job_id, ...calendarSyncJobClaimBindings(row, claim))
  ]);
  return hasChangedRows(results[5]) ? "succeeded" : "skipped";
};
