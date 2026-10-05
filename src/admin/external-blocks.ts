import { adminWriteGuard, adminWriteWasRevoked } from "./write-authorization";
import type { AdminUser } from "./access";
import {
  IDEMPOTENCY_TTL_MS,
  fetchAdminActionIdempotency,
  sha256Hex,
  startedIdempotencyStatement,
} from "./settings-common";
import { generateSlotTimesForRange } from "../reservations/slot-times";
import { captureBatchWriteFailure } from "../sentry-helpers";
import { isNonEmptyString, parseStartAt, toIso } from "./reservation-time-utils";

export type AdminCreateExternalBlockRequest = {
  idempotencyKey: string;
  storeId: string;
  resourceId: string;
  startAt: string;
  endAt: string;
  title?: string;
};

export type AdminCancelExternalBlockRequest = {
  idempotencyKey: string;
  reason?: string;
};

type AdminExternalBlockSuccess = {
  ok: true;
  externalBlockId: string;
  status: "active" | "cancelled";
  storeId: string;
  startAt: string;
  endAt: string;
  replayed: boolean;
};

type AdminExternalBlockFailure = {
  ok: false;
  reason:
    | "invalid_request"
    | "forbidden"
    | "not_found"
    | "invalid_transition"
    | "idempotency_conflict"
    | "idempotency_in_progress"
    | "store_not_found"
    | "resource_not_available"
    | "invalid_time"
    | "slot_unavailable"
    | "write_failed";
};

export type AdminExternalBlockResult = AdminExternalBlockSuccess | AdminExternalBlockFailure;

type ExternalBlockContext = {
  storeId: string;
  resourceId: string;
  resourceStoreId: string;
};

type ExternalBlockRow = {
  id: string;
  store_id: string;
  resource_id: string;
  status: "active" | "cancelled";
  start_at: string;
  end_at: string;
};

const SLOT_INTERVAL_MINUTES = 5;

// Cap external block duration at 2 days. Each 5-minute slot becomes 2 D1 batch statements
// (slot_locks + slot_lock_history). D1 enforces both a statement-count ceiling AND a ~1MB
// total payload per batch — 2 days = 576 slots = 1152 per-slot statements (plus 5 fixed
// statements outside the loop: external_blocks, calendar_sync_jobs, audit_logs, idempotency_keys×2)
// ≈ 600KB payload, safely under the 1MB cap. Longer closures (weekly renovation, multi-week
// holiday) should be expressed via store_business_hours.active=0 or be split into multiple
// blocks at admin-tool level.
const MAX_EXTERNAL_BLOCK_DURATION_MS = 2 * 24 * 60 * 60 * 1000;

const fetchContext = async (
  db: D1Database,
  storeId: string,
  resourceId: string
): Promise<ExternalBlockContext | AdminExternalBlockFailure> => {
  const context = await db
    .prepare(
      `
        SELECT
          stores.id AS storeId,
          store_resources.id AS resourceId,
          store_resources.store_id AS resourceStoreId
        FROM stores
        JOIN store_resources ON store_resources.id = ?
        WHERE stores.id = ?
          AND store_resources.active = 1
        LIMIT 1
      `
    )
    .bind(resourceId, storeId)
    .first<ExternalBlockContext>();

  if (!context) {
    return {
      ok: false,
      reason: "store_not_found"
    };
  }
  if (context.resourceStoreId !== storeId) {
    return {
      ok: false,
      reason: "resource_not_available"
    };
  }
  return context;
};

const readExternalBlockResult = async (
  db: D1Database,
  externalBlockId: string,
  replayed: boolean
): Promise<AdminExternalBlockResult> => {
  const row = await db
    .prepare(
      `
        SELECT id, store_id, resource_id, status, start_at, end_at
        FROM external_blocks
        WHERE id = ?
        LIMIT 1
      `
    )
    .bind(externalBlockId)
    .first<ExternalBlockRow>();

  if (!row) {
    return {
      ok: false,
      reason: "write_failed"
    };
  }

  return {
    ok: true,
    externalBlockId: row.id,
    status: row.status,
    storeId: row.store_id,
    startAt: row.start_at,
    endAt: row.end_at,
    replayed
  };
};

const createExternalBlockRequestHash = async (
  request: AdminCreateExternalBlockRequest,
  normalizedStartAt: string,
  normalizedEndAt: string
) => {
  return sha256Hex(
    JSON.stringify({
      storeId: request.storeId,
      resourceId: request.resourceId,
      startAt: normalizedStartAt,
      endAt: normalizedEndAt,
      title: request.title?.trim() ?? null
    })
  );
};

const createCancelRequestHash = async (
  externalBlockId: string,
  request: AdminCancelExternalBlockRequest
) => {
  return sha256Hex(
    JSON.stringify({
      externalBlockId,
      reason: request.reason?.trim() ?? null
    })
  );
};

const resolveExternalBlockIdempotency = async (
  db: D1Database,
  idempotencyKey: string,
  requestHash: string,
  nowIso: string
): Promise<AdminExternalBlockResult | undefined> => {
  const idempotency = await fetchAdminActionIdempotency(db, idempotencyKey, nowIso);
  if (!idempotency) {
    return undefined;
  }
  if (idempotency.request_hash !== requestHash) {
    return {
      ok: false,
      reason: "idempotency_conflict"
    };
  }
  if (idempotency.status === "succeeded" && idempotency.target_id) {
    return readExternalBlockResult(db, idempotency.target_id, true);
  }
  return {
    ok: false,
    reason: "idempotency_in_progress"
  };
};

const mapBatchError = (error: unknown): AdminExternalBlockFailure => {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("slot_locks")) {
    // Expected: a slot_locks UNIQUE collision means the slot was taken
    // concurrently — a normal booking-contention outcome, not a fault. Silent.
    return {
      ok: false,
      reason: "slot_unavailable"
    };
  }
  // An idempotency_keys UNIQUE collision is handled by resolveExternalBlockBatchFailure (a
  // TTL-aware re-resolve), not here: a concurrent in-flight request replays
  // cached/idempotency_in_progress, while a post-TTL expired row falls through to this
  // terminal write_failed (F-6.1). See [[idempotency-ttl-invariant]]. A genuine
  // unexpected write failure reaches here — surface it to Sentry.
  captureBatchWriteFailure(error, { component: "external-blocks", op: "batch_write_failed" });
  return {
    ok: false,
    reason: "write_failed"
  };
};

const resolveExternalBlockBatchFailure = async (
  db: D1Database,
  idempotencyKey: string,
  requestHash: string,
  nowIso: string,
  error: unknown
): Promise<AdminExternalBlockResult> => {
  // Re-resolve the idempotency row with the TTL filter so a concurrent in-flight request
  // (valid TTL) still replays cached/idempotency_in_progress, while a post-TTL expired
  // "started" row, no longer in flight, falls through to mapBatchError's terminal
  // write_failed (F-6.1, matching reservations.ts). [[idempotency-ttl-invariant]]
  try {
    const concurrent = await resolveExternalBlockIdempotency(db, idempotencyKey, requestHash, nowIso);
    if (concurrent) {
      return concurrent;
    }
  } catch {
    // fall through to the structured batch-error mapping
  }
  return mapBatchError(error);
};

export async function createAdminExternalBlock(input: {
  db: D1Database;
  admin: AdminUser;
  request: AdminCreateExternalBlockRequest;
  now?: () => number;
}): Promise<AdminExternalBlockResult> {
  if (input.admin.role === "staff") {
    return {
      ok: false,
      reason: "forbidden"
    };
  }
  const now = input.now ?? Date.now;
  if (
    !isNonEmptyString(input.request.idempotencyKey, 256) ||
    !isNonEmptyString(input.request.storeId, 64) ||
    !isNonEmptyString(input.request.resourceId, 128) ||
    !isNonEmptyString(input.request.startAt, 64) ||
    !isNonEmptyString(input.request.endAt, 64) ||
    (input.request.title !== undefined && !isNonEmptyString(input.request.title, 120))
  ) {
    return {
      ok: false,
      reason: "invalid_request"
    };
  }

  const startAt = parseStartAt(input.request.startAt, SLOT_INTERVAL_MINUTES);
  const endAt = parseStartAt(input.request.endAt, SLOT_INTERVAL_MINUTES);
  if (!startAt || !endAt || startAt.getTime() < now()) {
    return {
      ok: false,
      reason: "invalid_time"
    };
  }

  const slotTimes = generateSlotTimesForRange(startAt, endAt, SLOT_INTERVAL_MINUTES, {
    maxDurationMs: MAX_EXTERNAL_BLOCK_DURATION_MS
  });
  if (!slotTimes) {
    return {
      ok: false,
      reason: "invalid_time"
    };
  }

  const context = await fetchContext(input.db, input.request.storeId, input.request.resourceId);
  if ("ok" in context) {
    return context;
  }

  const requestHash = await createExternalBlockRequestHash(input.request, toIso(startAt), toIso(endAt));
  // Single clock stamps expires_at on write AND filters the TTL read (F-6.1).
  const nowMs = now();
  const nowIso = toIso(new Date(nowMs));
  const idempotencyResult = await resolveExternalBlockIdempotency(
    input.db,
    input.request.idempotencyKey,
    requestHash,
    nowIso
  );
  if (idempotencyResult) {
    return idempotencyResult;
  }

  const idempotencyId = crypto.randomUUID();
  const externalBlockId = crypto.randomUUID();
  const expiresAt = toIso(new Date(nowMs + IDEMPOTENCY_TTL_MS));
  const titleSnapshot = input.request.title?.trim() ?? "Admin block";
  const statements: D1PreparedStatement[] = [
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
        `DELETE FROM slot_locks
         WHERE store_id = ?
           AND resource_id = ?
           AND slot_at >= ?
           AND slot_at < ?
           AND lock_status = 'pending'
           AND expires_at IS NOT NULL
           AND datetime(expires_at) <= datetime(?)`
      )
      .bind(context.storeId, context.resourceId, toIso(startAt), toIso(endAt), nowIso),
    input.db
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
            created_by,
            updated_at
          ) VALUES (?, ?, ?, 'admin_block', ?, ?, ?, 'active', ?, ?)
        `
      )
      .bind(
        externalBlockId,
        context.storeId,
        context.resourceId,
        titleSnapshot,
        toIso(startAt),
        toIso(endAt),
        input.admin.id,
        nowIso
      )
  ];

  for (const slotAt of slotTimes) {
    const slotLockId = crypto.randomUUID();
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
        .bind(slotLockId, context.storeId, context.resourceId, slotAt, externalBlockId),
      input.db
        .prepare(
          `
            INSERT INTO slot_lock_history (
              id,
              slot_lock_id,
              store_id,
              resource_id,
              new_slot_at,
              new_owner_id,
              action,
              actor_type,
              actor_id,
              reason
            ) VALUES (?, ?, ?, ?, ?, ?, 'created', 'staff', ?, 'admin_external_block_created')
          `
        )
        .bind(
          crypto.randomUUID(),
          slotLockId,
          context.storeId,
          context.resourceId,
          slotAt,
          externalBlockId,
          input.admin.id
        )
    );
  }

  statements.push(
    input.db
      .prepare(
        `
          INSERT INTO calendar_sync_jobs (
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
      .bind(crypto.randomUUID(), `external_block:${externalBlockId}:google:upsert:created`, externalBlockId, nowIso),
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
          ) VALUES (?, 'staff', ?, 'admin_external_block_created', 'external_block', ?, ?)
        `
      )
      .bind(
        crypto.randomUUID(),
        input.admin.id,
        externalBlockId,
        JSON.stringify({
          storeId: context.storeId,
          resourceId: context.resourceId,
          startAt: toIso(startAt),
          endAt: toIso(endAt)
        })
      ),
    input.db
      .prepare(
        `
          UPDATE idempotency_keys
          SET status = 'succeeded',
              target_type = 'external_block',
              target_id = ?,
              updated_at = ?
          WHERE id = ?
        `
      )
      .bind(externalBlockId, nowIso, idempotencyId)
  );

  try {
    await input.db.batch(statements);
  } catch (error) {
    if (await adminWriteWasRevoked(input.db, input.admin, error)) return { ok: false, reason: "forbidden" };
    return resolveExternalBlockBatchFailure(input.db, input.request.idempotencyKey, requestHash, nowIso, error);
  }

  return readExternalBlockResult(input.db, externalBlockId, false);
}

export async function cancelAdminExternalBlock(input: {
  db: D1Database;
  admin: AdminUser;
  externalBlockId: string;
  request: AdminCancelExternalBlockRequest;
  now?: () => number;
}): Promise<AdminExternalBlockResult> {
  if (input.admin.role === "staff") {
    return {
      ok: false,
      reason: "forbidden"
    };
  }
  const now = input.now ?? Date.now;
  if (
    !isNonEmptyString(input.externalBlockId, 128) ||
    !isNonEmptyString(input.request.idempotencyKey, 256) ||
    (input.request.reason !== undefined && !isNonEmptyString(input.request.reason, 500))
  ) {
    return {
      ok: false,
      reason: "invalid_request"
    };
  }

  const requestHash = await createCancelRequestHash(input.externalBlockId, input.request);
  // Single clock stamps expires_at on write AND filters the TTL read (F-6.1).
  const nowMs = now();
  const nowIso = toIso(new Date(nowMs));
  const idempotencyResult = await resolveExternalBlockIdempotency(
    input.db,
    input.request.idempotencyKey,
    requestHash,
    nowIso
  );
  if (idempotencyResult) {
    return idempotencyResult;
  }

  const block = await input.db
    .prepare(
      `
        SELECT id, store_id, resource_id, status, start_at, end_at
        FROM external_blocks
        WHERE id = ?
        LIMIT 1
      `
    )
    .bind(input.externalBlockId)
    .first<ExternalBlockRow>();

  if (!block) {
    return {
      ok: false,
      reason: "not_found"
    };
  }
  if (block.status !== "active") {
    return {
      ok: false,
      reason: "invalid_transition"
    };
  }

  const idempotencyId = crypto.randomUUID();
  const expiresAt = toIso(new Date(nowMs + IDEMPOTENCY_TTL_MS));
  const transitionMarkerGuardSql = `
    SELECT 1
    FROM idempotency_keys
    WHERE id = ?
      AND scope = 'admin_action'
      AND target_type = 'external_block_cancel_transition'
      AND target_id = ?
  `;
  const statements: D1PreparedStatement[] = [
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
          UPDATE external_blocks
          SET status = 'cancelled',
              updated_at = ?
          WHERE id = ?
            AND status = 'active'
        `
      )
      .bind(nowIso, block.id),
    input.db
      .prepare(
        `
          UPDATE idempotency_keys
          SET target_type = 'external_block_cancel_transition',
              target_id = ?,
              updated_at = ?
          WHERE id = ?
            AND changes() = 1
        `
      )
      .bind(block.id, nowIso, idempotencyId),
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
            'admin_external_block_cancelled'
          FROM slot_locks
          WHERE owner_type = 'external_block'
            AND owner_id = ?
            AND EXISTS (${transitionMarkerGuardSql})
        `
      )
      .bind(input.admin.id, block.id, idempotencyId, block.id),
    input.db
      .prepare(
        `
          DELETE FROM slot_locks
          WHERE owner_type = 'external_block'
            AND owner_id = ?
            AND EXISTS (${transitionMarkerGuardSql})
        `
      )
      .bind(block.id, idempotencyId, block.id),
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
          )
          SELECT ?, ?, 'external_block', ?, 'delete', 'queued', ?
          WHERE EXISTS (${transitionMarkerGuardSql})
        `
      )
      .bind(
        crypto.randomUUID(),
        `external_block:${block.id}:google:delete:cancelled`,
        block.id,
        nowIso,
        idempotencyId,
        block.id
      ),
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
          SELECT ?, 'staff', ?, 'admin_external_block_cancelled', 'external_block', ?, ?
          WHERE EXISTS (${transitionMarkerGuardSql})
        `
      )
      .bind(
        crypto.randomUUID(),
        input.admin.id,
        block.id,
        JSON.stringify({
          reason: input.request.reason?.trim() ?? null,
          storeId: block.store_id,
          resourceId: block.resource_id
        }),
        idempotencyId,
        block.id
      ),
    input.db
      .prepare(
        `
          DELETE FROM idempotency_keys
          WHERE id = ?
            AND status = 'started'
            AND NOT EXISTS (${transitionMarkerGuardSql})
        `
      )
      .bind(idempotencyId, idempotencyId, block.id),
    input.db
      .prepare(
        `
          UPDATE idempotency_keys
          SET status = 'succeeded',
              target_type = 'external_block',
              target_id = ?,
              updated_at = ?
          WHERE id = ?
            AND EXISTS (${transitionMarkerGuardSql})
        `
      )
      .bind(block.id, nowIso, idempotencyId, idempotencyId, block.id)
  ];

  try {
    await input.db.batch(statements);
  } catch (error) {
    if (await adminWriteWasRevoked(input.db, input.admin, error)) return { ok: false, reason: "forbidden" };
    return resolveExternalBlockBatchFailure(input.db, input.request.idempotencyKey, requestHash, nowIso, error);
  }

  const transitioned = await input.db
    .prepare(
      `
        SELECT 1 AS value
        FROM idempotency_keys
        WHERE id = ?
          AND status = 'succeeded'
          AND target_type = 'external_block'
          AND target_id = ?
        LIMIT 1
      `
    )
    .bind(idempotencyId, block.id)
    .first<{ value: number }>();

  if (!transitioned) {
    return {
      ok: false,
      reason: "invalid_transition"
    };
  }

  return readExternalBlockResult(input.db, block.id, false);
}
