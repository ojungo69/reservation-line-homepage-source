import type { AdminUser } from "./access";
import { parseDateJstToUtcIso } from "../date-parse";
import { parseIsoInstantToCanonical } from "./parse-iso-instant";
import { CHANNEL_RENEWAL_WINDOW_MS } from "../google/channel-watch";
import {
  aggregateGoogleConflictsForOwner,
  RETIRED_NOTIFICATION_TEMPLATES_SQL,
  NOTIFICATION_ACKNOWLEDGEMENT_SQL,
  type OwnerConflictAggregate
} from "./sync-recovery";

// Renewal attempts begin CHANNEL_RENEWAL_WINDOW_MS before expiry (minus up to 2h of
// per-store jitter) and repeat on every sweep. An active/renewing channel still inside
// half that window therefore means renewals have been failing for hours — normal
// operation never reaches here, because a successful renewal replaces the row.
const CHANNEL_EXPIRY_WARNING_LEAD_MS = CHANNEL_RENEWAL_WINDOW_MS / 2;

type CountRow = {
  count: number;
};

type ChannelRow = {
  id: string;
  store_id: string;
  calendar_id: string;
  status: string;
  sync_token: string | null;
  expiration_at: string | null;
  last_notification_at: string | null;
  last_resource_state: string | null;
  last_message_number: string | null;
  last_incremental_sync_at: string | null;
  last_full_reconcile_at: string | null;
  updated_at: string;
};

type GoogleImportJobRow = {
  id: string;
  store_id: string;
  calendar_id: string;
  reason: string;
  status: string;
  attempt_count: number;
  last_error: string | null;
  updated_at: string;
};

type CalendarSyncJobRow = {
  id: string;
  owner_type: string;
  owner_id: string;
  google_action: string;
  status: string;
  attempts: number;
  last_error: string | null;
  updated_at: string;
};

type NotificationJobRow = {
  id: string;
  template_key: string;
  recipient_type: string;
  recipient_id: string;
  reservation_id: string | null;
  status: string;
  attempts: number;
  last_error: string | null;
  updated_at: string;
};

type ConflictRow = {
  id: string;
  store_id: string;
  calendar_id: string;
  google_event_id: string;
  reservation_id: string | null;
  external_block_id: string | null;
  conflict_type: string;
  google_safe_snapshot_json: string;
  d1_safe_snapshot_json: string | null;
  resolution_status: string;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
};

type GoogleEventRow = {
  id: string;
  store_id: string;
  calendar_id: string;
  google_event_id: string;
  reservation_id: string | null;
  external_block_id: string | null;
  google_etag: string | null;
  google_updated_at: string | null;
  last_seen_at: string;
  last_imported_at: string | null;
  source_type: string;
  status: string;
  google_safe_snapshot_json: string | null;
};

type OutboundWriteRow = {
  id: string;
  calendar_sync_job_id: string | null;
  dedupe_key: string;
  calendar_id: string;
  google_event_id: string;
  owner_type: string;
  owner_id: string;
  action: string;
  expected_fingerprint: string;
  google_etag_after: string | null;
  expires_at: string;
  created_at: string;
};

type WarningItem = {
  kind: string;
  count: number;
  message: string;
};

type WarningTemplate = readonly [kind: string, message: string];

type SyncSummary = {
  openGoogleConflicts: number;
  googleSyncJobsNeedingAttention: number;
  lineNotificationJobsNeedingAttention: number;
  channelsNeedingAttention: number;
};

export type AdminSyncStatusResult =
  | {
      ok: true;
      role: "staff";
      warnings: WarningItem[];
    }
  | {
      ok: true;
      role: "owner";
      summary: SyncSummary;
      recoveryTasks: WarningItem[];
      conflictAggregate: OwnerConflictAggregate;
      actionableConflicts: Array<{
        id: string;
        storeId: string;
        conflictType: string;
        summary: string | null;
        createdAt: string;
        startAt: string | null;
        endAt: string | null;
        storeName: string;
        customerDisplayName: string | null;
        overlappingReservations: [];
      }>;
    }
  | {
      ok: true;
      role: "system_admin";
      summary: SyncSummary;
      channels: Array<{
        id: string;
        storeId: string;
        calendarId: string;
        status: string;
        syncToken: string | null;
        syncTokenPresent: boolean;
        expirationAt: string | null;
        lastNotificationAt: string | null;
        lastResourceState: string | null;
        lastMessageNumber: string | null;
        lastIncrementalSyncAt: string | null;
        lastFullReconcileAt: string | null;
        updatedAt: string;
      }>;
      dlq: {
        source: "d1_attention_jobs";
        jobs: Array<{
          source: "google_calendar_import_jobs" | "calendar_sync_jobs" | "notification_jobs";
          id: string;
          status: string;
          attemptCount: number;
          lastError: string | null;
          updatedAt: string;
          storeId?: string;
          calendarId?: string;
          reason?: string;
          ownerType?: string;
          ownerId?: string;
          googleAction?: string;
          templateKey?: string;
          recipientType?: string;
          recipientId?: string;
          reservationId?: string | null;
        }>;
      };
      conflicts: Array<{
        id: string;
        storeId: string;
        calendarId: string;
        googleEventId: string;
        reservationId: string | null;
        externalBlockId: string | null;
        conflictType: string;
        summary: string | null;
        googleSafeSnapshotJson: string;
        d1SafeSnapshotJson: string | null;
        resolutionStatus: string;
        createdAt: string;
        resolvedAt: string | null;
        resolvedBy: string | null;
        overlappingReservations: Array<{
          id: string;
          startAt: string;
          endAt: string;
          status: string;
          customerDisplayName: string;
        }>;
      }>;
      googleEvents: Array<{
        id: string;
        storeId: string;
        calendarId: string;
        googleEventId: string;
        reservationId: string | null;
        externalBlockId: string | null;
        googleEtag: string | null;
        googleUpdatedAt: string | null;
        lastSeenAt: string;
        lastImportedAt: string | null;
        sourceType: string;
        status: string;
        googleSafeSnapshotJson: string | null;
      }>;
      outboundWrites: Array<{
        id: string;
        calendarSyncJobId: string | null;
        dedupeKey: string;
        calendarId: string;
        googleEventId: string;
        ownerType: string;
        ownerId: string;
        action: string;
        expectedFingerprint: string;
        googleEtagAfter: string | null;
        expiresAt: string;
        createdAt: string;
      }>;
    };

type SystemAdminSyncStatus = Extract<AdminSyncStatusResult, { role: "system_admin" }>;
type AttentionJobDetails = SystemAdminSyncStatus["dlq"]["jobs"];

const ATTENTION_JOB_STATUS_FILTER = "('failed', 'retryable', 'dead')";
const ATTENTION_JOB_WHERE_SQL = `
  (
    status IN ${ATTENTION_JOB_STATUS_FILTER}
    OR (
      status = 'processing'
      AND locked_until IS NOT NULL
      AND locked_until <= ?
    )
  )
`;

const fetchSummary = async (
  db: D1Database,
  nowIso: string,
  storeScope: string | null = null
): Promise<SyncSummary> => {
  // ponytail: single db.batch() round-trip instead of 5 separate .first() calls.
  const [
    openGoogleConflicts,
    attentionGoogleImportJobs,
    attentionCalendarSyncJobs,
    attentionLineNotificationJobs,
    channelsNeedingAttention
  ] = (
    await db.batch<CountRow>([
      db
        .prepare(
          `
          SELECT COUNT(*) AS count
          FROM google_calendar_conflicts
          WHERE resolution_status = 'open'
            AND (? IS NULL OR store_id = ?)
        `
        )
        .bind(storeScope, storeScope),
      db
        .prepare(
          `
            SELECT COUNT(*) AS count
            FROM google_calendar_import_jobs
            WHERE ${ATTENTION_JOB_WHERE_SQL}
              AND (? IS NULL OR store_id = ?)
          `
        )
        .bind(nowIso, storeScope, storeScope),
      db
        .prepare(
          `
            SELECT COUNT(*) AS count
            FROM calendar_sync_jobs
            WHERE ${ATTENTION_JOB_WHERE_SQL}
              AND (
                ? IS NULL
                OR (
                  owner_type = 'reservation'
                  AND EXISTS (
                    SELECT 1 FROM reservations
                    WHERE id = calendar_sync_jobs.owner_id AND store_id = ?
                  )
                )
                OR (
                  owner_type = 'external_block'
                  AND EXISTS (
                    SELECT 1 FROM external_blocks
                    WHERE id = calendar_sync_jobs.owner_id AND store_id = ?
                  )
                )
              )
          `
        )
        .bind(nowIso, storeScope, storeScope, storeScope),
      db
        .prepare(
          `
            SELECT COUNT(*) AS count
            FROM notification_jobs
            WHERE ${ATTENTION_JOB_WHERE_SQL}
              AND NOT EXISTS (${NOTIFICATION_ACKNOWLEDGEMENT_SQL})
              AND template_key NOT IN ${RETIRED_NOTIFICATION_TEMPLATES_SQL}
              AND (
                ? IS NULL
                OR EXISTS (
                  SELECT 1 FROM reservations
                  WHERE id = notification_jobs.reservation_id AND store_id = ?
                )
                OR (
                  json_valid(notification_jobs.payload_json)
                  AND json_extract(notification_jobs.payload_json, '$.store_id') = ?
                )
              )
          `
        )
        .bind(nowIso, storeScope, storeScope, storeScope),
      db
        .prepare(
          `
            SELECT COUNT(*) AS count
            FROM google_calendar_channels
            WHERE (
              -- No runtime path writes these two values today; kept so manually set
              -- incident rows (expired/failed) still surface in admin warnings.
              status IN ('expired', 'failed')
              OR (
                status IN ('active', 'renewing')
                AND expiration_at IS NOT NULL
                AND expiration_at <= ?
              )
            )
              AND (? IS NULL OR store_id = ?)
          `
        )
        .bind(
          new Date(Date.parse(nowIso) + CHANNEL_EXPIRY_WARNING_LEAD_MS).toISOString(),
          storeScope,
          storeScope
        )
    ])
  ).map((result) => result.results?.[0]?.count ?? 0);

  return {
    openGoogleConflicts,
    googleSyncJobsNeedingAttention: attentionGoogleImportJobs + attentionCalendarSyncJobs,
    lineNotificationJobsNeedingAttention: attentionLineNotificationJobs,
    channelsNeedingAttention
  };
};

// スタッフ向けと店長向けは同じ3条件を同じ順で見ており、違うのは文言と kind だけ。
// 条件を1箇所に集めるのが目的 — 片方だけ条件が変わると、同じ状態について
// スタッフ画面と店長画面が食い違う。
//
// テンプレートは配列でなくキー付きで受ける。位置で対応させると、行を1つ挿れたり
// 入れ替えたりしても型が通り、Google編集エラーの件数に LINE 未達の文言が付く。
const buildWarnings = (
  summary: SyncSummary,
  templates: Record<"conflicts" | "syncAttention" | "lineAttention", WarningTemplate>
): WarningItem[] => {
  const entries = [
    [summary.openGoogleConflicts, templates.conflicts],
    [summary.googleSyncJobsNeedingAttention + summary.channelsNeedingAttention, templates.syncAttention],
    [summary.lineNotificationJobsNeedingAttention, templates.lineAttention]
  ] as const;
  return entries.flatMap(([count, [kind, message]]) => (count > 0 ? [{ kind, count, message }] : []));
};

const buildStaffWarnings = (summary: SyncSummary): WarningItem[] =>
  buildWarnings(summary, {
    conflicts: ["google_edit_error", "Google編集エラーがあります。確認してください。"],
    syncAttention: ["google_sync_attention", "Google反映で確認が必要です。管理者に確認してください。"],
    lineAttention: ["line_notification_error", "LINE未達があります。確認してください。"]
  });

const buildOwnerTasks = (summary: SyncSummary): WarningItem[] =>
  buildWarnings(summary, {
    conflicts: ["google_edit_conflict", "Google編集エラーがあります。予約画面で確認してください。"],
    syncAttention: ["google_sync_attention_jobs", "Google反映で管理者確認が必要な処理があります。"],
    lineAttention: ["line_notification_attention_jobs", "LINE未達の確認が必要です。"]
  });

const fetchChannels = async (db: D1Database) => {
  const rows = await db
    .prepare(
      `
        SELECT
          id,
          store_id,
          calendar_id,
          status,
          sync_token,
          expiration_at,
          last_notification_at,
          last_resource_state,
          last_message_number,
          last_incremental_sync_at,
          last_full_reconcile_at,
          updated_at
        FROM google_calendar_channels
        ORDER BY store_id, calendar_id, updated_at DESC
        LIMIT 100
      `
    )
    .all<ChannelRow>();

  return (rows.results ?? []).map((row) => ({
    id: row.id,
    storeId: row.store_id,
    calendarId: row.calendar_id,
    status: row.status,
    syncToken: row.sync_token,
    syncTokenPresent: Boolean(row.sync_token),
    expirationAt: row.expiration_at,
    lastNotificationAt: row.last_notification_at,
    lastResourceState: row.last_resource_state,
    lastMessageNumber: row.last_message_number,
    lastIncrementalSyncAt: row.last_incremental_sync_at,
    lastFullReconcileAt: row.last_full_reconcile_at,
    updatedAt: row.updated_at
  }));
};

const fetchAttentionJobs = async (db: D1Database, nowIso: string): Promise<AttentionJobDetails> => {
  // ponytail: single db.batch() round-trip instead of 3 sequential .all() calls.
  const [importResult, calendarResult, notificationResult] = await db.batch([
    db
      .prepare(
        `
          SELECT
            id,
            store_id,
            calendar_id,
            reason,
            status,
            attempt_count,
            last_error,
            updated_at
            FROM google_calendar_import_jobs
            WHERE ${ATTENTION_JOB_WHERE_SQL}
            ORDER BY updated_at DESC
            LIMIT 50
          `
      )
      .bind(nowIso),
    db
      .prepare(
        `
          SELECT
            id,
            owner_type,
            owner_id,
            google_action,
            status,
            attempts,
            last_error,
            updated_at
            FROM calendar_sync_jobs
            WHERE ${ATTENTION_JOB_WHERE_SQL}
            ORDER BY updated_at DESC
            LIMIT 50
          `
      )
      .bind(nowIso),
    db
      .prepare(
        `
          SELECT
            id,
            template_key,
            recipient_type,
            recipient_id,
            reservation_id,
            status,
            attempts,
            last_error,
            updated_at
            FROM notification_jobs
            WHERE ${ATTENTION_JOB_WHERE_SQL}
              AND NOT EXISTS (${NOTIFICATION_ACKNOWLEDGEMENT_SQL})
              AND template_key NOT IN ${RETIRED_NOTIFICATION_TEMPLATES_SQL}
            ORDER BY updated_at DESC
            LIMIT 50
          `
      )
      .bind(nowIso)
  ]);
  const importRows = (importResult.results ?? []) as GoogleImportJobRow[];
  const calendarRows = (calendarResult.results ?? []) as CalendarSyncJobRow[];
  const notificationRows = (notificationResult.results ?? []) as NotificationJobRow[];

  return [
    ...importRows.map((row) => ({
      source: "google_calendar_import_jobs" as const,
      id: row.id,
      status: row.status,
      attemptCount: row.attempt_count,
      lastError: row.last_error,
      updatedAt: row.updated_at,
      storeId: row.store_id,
      calendarId: row.calendar_id,
      reason: row.reason
    })),
    ...calendarRows.map((row) => ({
      source: "calendar_sync_jobs" as const,
      id: row.id,
      status: row.status,
      attemptCount: row.attempts,
      lastError: row.last_error,
      updatedAt: row.updated_at,
      ownerType: row.owner_type,
      ownerId: row.owner_id,
      googleAction: row.google_action
    })),
    ...notificationRows.map((row) => ({
      source: "notification_jobs" as const,
      id: row.id,
      status: row.status,
      attemptCount: row.attempts,
      lastError: row.last_error,
      updatedAt: row.updated_at,
      templateKey: row.template_key,
      recipientType: row.recipient_type,
      recipientId: row.recipient_id,
      reservationId: row.reservation_id
    }))
  ];
};

type OverlapRow = {
  id: string;
  store_id: string;
  start_at: string;
  end_at: string;
  status: string;
  customer_display_name: string | null;
};

type GoogleSnapshot = { start_at?: unknown; end_at?: unknown; start_date?: unknown; end_date?: unknown; summary?: unknown };

const parseSnapshotRange = (json: string | null): { startAt: string; endAt: string } | undefined => {
  if (typeof json !== "string" || json.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const snapshot = parsed as GoogleSnapshot;
  let startAt = typeof snapshot.start_at === "string" ? snapshot.start_at : undefined;
  let endAt = typeof snapshot.end_at === "string" ? snapshot.end_at : undefined;
  if (!startAt && typeof snapshot.start_date === "string") startAt = parseDateJstToUtcIso(snapshot.start_date) ?? undefined;
  if (!endAt && typeof snapshot.end_date === "string") endAt = parseDateJstToUtcIso(snapshot.end_date) ?? undefined;
  if (!startAt || !endAt) return undefined;
  if (parseIsoInstantToCanonical(startAt) !== startAt || parseIsoInstantToCanonical(endAt) !== endAt || startAt >= endAt) return undefined;
  return { startAt, endAt };
};

const parseSnapshotSummary = (json: string | null): string | null => {
  if (typeof json !== "string" || json.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const summary = (parsed as GoogleSnapshot).summary;
  if (typeof summary === "string") {
    const trimmed = summary.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
};

type RelevantConflict = {
  conflict: ConflictRow;
  range: { startAt: string; endAt: string };
};

function collectRelevantConflicts(conflicts: ConflictRow[]): RelevantConflict[] {
  const result: RelevantConflict[] = [];
  for (const conflict of conflicts) {
    if (conflict.conflict_type !== "external_block_slot_conflict") continue;
    const range = parseSnapshotRange(conflict.google_safe_snapshot_json);
    if (!range) continue;
    result.push({ conflict, range });
  }
  return result;
}

function buildStoreBuckets(
  relevantConflicts: RelevantConflict[]
): Map<string, { minStart: string; maxEnd: string }> {
  const buckets = new Map<string, { minStart: string; maxEnd: string }>();
  for (const { conflict, range } of relevantConflicts) {
    const existing = buckets.get(conflict.store_id);
    if (existing) {
      if (range.startAt < existing.minStart) existing.minStart = range.startAt;
      if (range.endAt > existing.maxEnd) existing.maxEnd = range.endAt;
    } else {
      buckets.set(conflict.store_id, { minStart: range.startAt, maxEnd: range.endAt });
    }
  }
  return buckets;
}

// Looks up active D1 reservations whose time range overlaps each external_block_slot_conflict
// row's Google event range, so the sync UI can show "what D1 reservation does this conflict
// actually collide with". One query per affected store keeps the cost bounded (≤ 4 queries
// with current 4-store deployment) even with 100 conflict rows.
const fetchOverlappingReservations = async (
  db: D1Database,
  conflicts: ConflictRow[]
): Promise<Map<string, OverlapRow[]>> => {
  const relevantConflicts = collectRelevantConflicts(conflicts);

  const overlapByConflict = new Map<string, OverlapRow[]>();
  if (relevantConflicts.length === 0) return overlapByConflict;

  const buckets = [...buildStoreBuckets(relevantConflicts)];
  const results = await db.batch<OverlapRow>(buckets.map(([storeId, range]) =>
    db
      .prepare(
        `
          SELECT
            r.id AS id,
            r.store_id AS store_id,
            r.start_at AS start_at,
            r.end_at AS end_at,
            r.status AS status,
            c.display_name AS customer_display_name
          FROM reservations r
          LEFT JOIN customers c ON r.customer_id = c.id
          WHERE r.store_id = ?
            AND r.status IN ('pending_approval', 'confirmed')
            AND r.start_at < ?
            AND r.end_at > ?
          ORDER BY r.start_at
        `
      )
      .bind(storeId, range.maxEnd, range.minStart)
  ));
  const rowsByStore = new Map<string, OverlapRow[]>(buckets.map(([storeId], index) =>
    [storeId, results[index].results ?? []]
  ));

  for (const { conflict, range } of relevantConflicts) {
    const storeRows = rowsByStore.get(conflict.store_id) ?? [];
    const overlaps = storeRows.filter(
      (row) => row.start_at < range.endAt && row.end_at > range.startAt
    );
    overlapByConflict.set(conflict.id, overlaps);
  }
  return overlapByConflict;
};

const fetchConflicts = async (db: D1Database, ownerStoreIds?: string[]) => {
  if (ownerStoreIds?.length === 0) return [];
  const ownerFilter = ownerStoreIds === undefined ? "" : `
    AND store_id IN (${ownerStoreIds.map(() => "?").join(",")})
    AND conflict_type IN ('google_all_day_event', 'reservation_event_deleted')`;
  const rows = await db
    .prepare(
      `
        SELECT
          id,
          store_id,
          calendar_id,
          google_event_id,
          reservation_id,
          external_block_id,
          conflict_type,
          google_safe_snapshot_json,
          d1_safe_snapshot_json,
          resolution_status,
          created_at,
          resolved_at,
          resolved_by
        FROM google_calendar_conflicts
        WHERE resolution_status = 'open'
          ${ownerFilter}
        ORDER BY created_at DESC
        LIMIT 100
      `
    )
    .bind(...(ownerStoreIds ?? []))
    .all<ConflictRow>();

  const conflictRows = rows.results ?? [];
  const overlapMap = await fetchOverlappingReservations(db, conflictRows);

  return conflictRows.map((row) => ({
    id: row.id,
    storeId: row.store_id,
    calendarId: row.calendar_id,
    googleEventId: row.google_event_id,
    reservationId: row.reservation_id,
    externalBlockId: row.external_block_id,
    conflictType: row.conflict_type,
    summary: parseSnapshotSummary(row.google_safe_snapshot_json),
    googleSafeSnapshotJson: row.google_safe_snapshot_json,
    d1SafeSnapshotJson: row.d1_safe_snapshot_json,
    resolutionStatus: row.resolution_status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    overlappingReservations: (overlapMap.get(row.id) ?? []).map((overlap) => ({
      id: overlap.id,
      startAt: overlap.start_at,
      endAt: overlap.end_at,
      status: overlap.status,
      customerDisplayName: overlap.customer_display_name ?? ""
    }))
  }));
};

const fetchGoogleEvents = async (db: D1Database) => {
  const rows = await db
    .prepare(
      `
        SELECT
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
        FROM google_calendar_events
        WHERE status IN ('active', 'conflict', 'deleted')
        ORDER BY last_seen_at DESC
        LIMIT 100
      `
    )
    .all<GoogleEventRow>();

  return (rows.results ?? []).map((row) => ({
    id: row.id,
    storeId: row.store_id,
    calendarId: row.calendar_id,
    googleEventId: row.google_event_id,
    reservationId: row.reservation_id,
    externalBlockId: row.external_block_id,
    googleEtag: row.google_etag,
    googleUpdatedAt: row.google_updated_at,
    lastSeenAt: row.last_seen_at,
    lastImportedAt: row.last_imported_at,
    sourceType: row.source_type,
    status: row.status,
    googleSafeSnapshotJson: row.google_safe_snapshot_json
  }));
};

const fetchOutboundWrites = async (db: D1Database) => {
  const rows = await db
    .prepare(
      `
        SELECT
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
          expires_at,
          created_at
        FROM google_calendar_outbound_writes
        ORDER BY created_at DESC
        LIMIT 100
      `
    )
    .all<OutboundWriteRow>();

  return (rows.results ?? []).map((row) => ({
    id: row.id,
    calendarSyncJobId: row.calendar_sync_job_id,
    dedupeKey: row.dedupe_key,
    calendarId: row.calendar_id,
    googleEventId: row.google_event_id,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    action: row.action,
    expectedFingerprint: row.expected_fingerprint,
    googleEtagAfter: row.google_etag_after,
    expiresAt: row.expires_at,
    createdAt: row.created_at
  }));
};

const fetchOwnerStoreIds = async (db: D1Database, adminId: string): Promise<string[]> => {
  const rows = await db
    .prepare(
      `
        SELECT stores.id AS store_id
        FROM admin_users au
        LEFT JOIN staff_members sm ON sm.id = au.staff_member_id AND sm.active = 1
        JOIN stores ON au.staff_member_id IS NULL OR stores.id = sm.store_id
        WHERE au.id = ?
          AND au.active = 1
          AND au.role = 'owner'
      `
    )
    .bind(adminId)
    .all<{ store_id: string }>();

  // An explicitly unbound owner manages all stores. An inactive linked staff
  // member must never turn a scoped owner into a global owner.
  return (rows.results ?? []).map((row) => row.store_id);
};

type OwnerConflictTarget = {
  id: string;
  storeName: string;
  customerDisplayName: string | null;
  startAt: string | null;
  endAt: string | null;
};

const fetchOwnerConflictTargets = async (db: D1Database, ids: string[], storeIds: string[]) => {
  if (!ids.length || !storeIds.length) return new Map<string, OwnerConflictTarget>();
  const rows = await db.prepare(`
    SELECT c.id, stores.name AS storeName, customers.display_name AS customerDisplayName,
      r.start_at AS startAt, r.end_at AS endAt
    FROM google_calendar_conflicts c
    JOIN stores ON stores.id = c.store_id
    LEFT JOIN reservations r ON r.id = c.reservation_id AND r.store_id = c.store_id
    LEFT JOIN customers ON customers.id = r.customer_id
    WHERE c.id IN (SELECT value FROM json_each(?))
      AND c.store_id IN (SELECT value FROM json_each(?))
  `).bind(JSON.stringify(ids), JSON.stringify(storeIds)).all<OwnerConflictTarget>();
  return new Map((rows.results ?? []).map((row) => [row.id, row]));
};

export async function getAdminSyncStatus(input: {
  db: D1Database;
  admin: AdminUser;
  now?: () => number;
}): Promise<AdminSyncStatusResult> {
  const nowIso = new Date((input.now ?? Date.now)()).toISOString();

  if (input.admin.role === "staff") {
    if (!input.admin.store_id) {
      return { ok: true, role: "staff", warnings: [] };
    }
    const summary = await fetchSummary(input.db, nowIso, input.admin.store_id);
    return {
      ok: true,
      role: "staff",
      warnings: buildStaffWarnings(summary)
    };
  }

  if (input.admin.role === "owner") {
    const ownerStoreIds = await fetchOwnerStoreIds(input.db, input.admin.id);
    let summary: SyncSummary = {
      openGoogleConflicts: 0,
      googleSyncJobsNeedingAttention: 0,
      lineNotificationJobsNeedingAttention: 0,
      channelsNeedingAttention: 0
    };
    if (ownerStoreIds.length > 0) {
      const storeScope = ownerStoreIds.length === 1 ? ownerStoreIds[0] : undefined;
      summary = await fetchSummary(input.db, nowIso, storeScope);
    }
    const conflictAggregate = await aggregateGoogleConflictsForOwner(input.db, ownerStoreIds);
    const ownerConflicts = await fetchConflicts(input.db, ownerStoreIds);
    const targets = await fetchOwnerConflictTargets(input.db, ownerConflicts.map((conflict) => conflict.id), ownerStoreIds);
    // Keep every warning count on the same store scope as the conflict list.
    const ownerSummary: SyncSummary = {
      ...summary,
      openGoogleConflicts: conflictAggregate.totalConflicts
    };
    return {
      ok: true,
      role: "owner",
      summary: ownerSummary,
      recoveryTasks: buildOwnerTasks(ownerSummary),
      conflictAggregate,
      // Only the two business decisions already authorized for owners. Keep
      // provider identifiers, snapshots and technical recovery cases private.
      actionableConflicts: ownerConflicts.map((conflict) => {
        const target = targets.get(conflict.id);
        const range = parseSnapshotRange(conflict.googleSafeSnapshotJson)
          ?? parseSnapshotRange(conflict.d1SafeSnapshotJson);
        return {
          id: conflict.id,
          storeId: conflict.storeId,
          conflictType: conflict.conflictType,
          summary: conflict.summary,
          createdAt: conflict.createdAt,
          startAt: target?.startAt ?? range?.startAt ?? null,
          endAt: target?.endAt ?? range?.endAt ?? null,
          storeName: target?.storeName ?? "",
          customerDisplayName: target?.customerDisplayName ?? null,
          overlappingReservations: []
        };
      })
    };
  }

  const summary = await fetchSummary(input.db, nowIso);
  const [channels, attentionJobs, conflicts, googleEvents, outboundWrites] = await Promise.all([
    fetchChannels(input.db),
    fetchAttentionJobs(input.db, nowIso),
    fetchConflicts(input.db),
    fetchGoogleEvents(input.db),
    fetchOutboundWrites(input.db)
  ]);

  return {
    ok: true,
    role: "system_admin",
    summary,
    channels,
    dlq: {
      source: "d1_attention_jobs",
      jobs: attentionJobs
    },
    conflicts,
    googleEvents,
    outboundWrites
  };
}
