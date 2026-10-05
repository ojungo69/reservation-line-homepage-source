import { adminWriteGuard, adminWriteWasRevoked } from "./write-authorization";
import type { AdminUser } from "./access";
import {
  buildCreateContext,
  MAX_ID_LENGTH,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_NAME_LENGTH,
  fetchAdminActionIdempotency,
  guardImmutableStore,
  isActorTypeBatchError,
  isAdminPrivileged,
  recoverFromCreateBatchFailure,
  sha256Hex,
  startedIdempotencyStatement,
  storeExists,
  succeededIdempotencyStatement,
  trimAndCap,
  type IdempotencyRow
} from "./settings-common";

// Tier C.3 4c — store_resources editor. Same shape as settings-services.ts
// (role gate, idempotency_keys POST, audit_logs, has_future_reservations
// write-time guard on deactivation). FK from reservations(resource_id) is
// ON DELETE CASCADE — hard delete is hazardous because it would orphan
// reservation rows; soft-delete via active=0 with the future-reservation
// guard keeps the contract intact.

export type AdminResourceType = "staff_calendar";

const RESOURCE_TYPES: ReadonlySet<AdminResourceType> = new Set([
  "staff_calendar"
]);

export type AdminResourceCreateRequest = {
  storeId: string;
  name: string;
  resourceType: AdminResourceType;
  active: boolean;
  idempotencyKey: string;
};

export type AdminResourceUpdateRequest = {
  storeId: string;
  name: string;
  resourceType: AdminResourceType;
  active: boolean;
};

export type AdminResourceCreateError =
  | "forbidden"
  | "invalid_request"
  | "not_found"
  | "missing_database"
  | "store_not_found"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "write_failed";

export type AdminResourceUpdateError =
  | "forbidden"
  | "invalid_request"
  | "not_found"
  | "missing_database"
  | "store_not_found"
  | "has_future_reservations"
  | "immutable_store"
  | "write_failed";

export type AdminResourceDeleteError =
  | "forbidden"
  | "invalid_request"
  | "not_found"
  | "missing_database"
  | "has_future_reservations"
  | "write_failed";

export type AdminResourceCreateResult =
  | { ok: true; resourceId: string; replayed: boolean }
  | { ok: false; error: AdminResourceCreateError };

export type AdminResourceUpdateResult =
  | { ok: true; resourceId: string }
  | { ok: false; error: AdminResourceUpdateError };

export type AdminResourceDeleteResult =
  | { ok: true; resourceId: string }
  | { ok: false; error: AdminResourceDeleteError };

const parseResourceType = (value: unknown): AdminResourceType | null => {
  if (typeof value !== "string") return null;
  return RESOURCE_TYPES.has(value as AdminResourceType) ? (value as AdminResourceType) : null;
};

type CommonMutationFields = Omit<AdminResourceUpdateRequest, "active"> & {
  active: boolean | null;
};

const parseCommonMutationFields = (body: unknown): CommonMutationFields | null => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const raw = body as Record<string, unknown>;
  const storeId = trimAndCap(raw.storeId, MAX_ID_LENGTH);
  const name = trimAndCap(raw.name, MAX_NAME_LENGTH);
  if (!storeId || !name) return null;
  const resourceType = parseResourceType(raw.resourceType);
  if (!resourceType) return null;
  const active = typeof raw.active === "boolean" ? raw.active : null;
  return { storeId, name, resourceType, active };
};

export const parseAdminResourceCreateRequest = (
  body: unknown
): AdminResourceCreateRequest | null => {
  const common = parseCommonMutationFields(body);
  if (!common) return null;
  const raw = body as Record<string, unknown>;
  const idempotencyKey = trimAndCap(raw.idempotencyKey, MAX_IDEMPOTENCY_KEY_LENGTH);
  if (!idempotencyKey) return null;
  const active = common.active ?? true;
  return { ...common, active, idempotencyKey };
};

export const parseAdminResourceUpdateRequest = (
  body: unknown
): AdminResourceUpdateRequest | null => {
  const common = parseCommonMutationFields(body);
  if (common?.active == null) return null;
  return { ...common, active: common.active };
};

const createResourceRequestHash = async (input: AdminResourceUpdateRequest) =>
  sha256Hex(
    JSON.stringify({
      storeId: input.storeId,
      name: input.name,
      resourceType: input.resourceType,
      active: input.active
    })
  );

const resolveCreateIdempotency = (
  idempotency: IdempotencyRow | null,
  requestHash: string
): AdminResourceCreateResult | undefined => {
  if (!idempotency) return undefined;
  if (idempotency.request_hash !== requestHash) {
    return { ok: false, error: "idempotency_conflict" };
  }
  if (idempotency.status === "succeeded" && idempotency.target_id) {
    return { ok: true, resourceId: idempotency.target_id, replayed: true };
  }
  return { ok: false, error: "idempotency_in_progress" };
};

type ResourceRow = {
  id: string;
  store_id: string;
  name: string;
  resource_type: AdminResourceType;
  active: number;
};

const fetchResource = async (db: D1Database, id: string): Promise<ResourceRow | null> =>
  db
    .prepare(
      `SELECT id, store_id, name, resource_type, active FROM store_resources WHERE id = ?`
    )
    .bind(id)
    .first<ResourceRow>();

const countFutureReservationsForResource = async (
  db: D1Database,
  resourceId: string,
  nowIso: string
): Promise<number> => {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM reservations
       WHERE resource_id = ?
         AND status IN ('pending_approval', 'confirmed')
         AND start_at > ?`
    )
    .bind(resourceId, nowIso)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
};

async function handleResourceUpdateBatchError(
  db: D1Database,
  error: unknown,
  resourceId: string,
  isDeactivating: boolean
): Promise<AdminResourceUpdateResult> {
  if (isActorTypeBatchError(error)) {
    const fresh = await fetchResource(db, resourceId);
    if (!fresh) return { ok: false, error: "not_found" };
    if (isDeactivating) return { ok: false, error: "has_future_reservations" };
    return { ok: false, error: "write_failed" };
  }
  console.error("updateAdminResource batch failed", {
    resourceId,
    error: error instanceof Error ? error.message : String(error)
  });
  return { ok: false, error: "write_failed" };
}

async function checkResourceDeactivation(
  db: D1Database,
  resourceId: string,
  nowIso: string,
  isDeactivating: boolean
): Promise<boolean> {
  if (!isDeactivating) return false;
  const future = await countFutureReservationsForResource(db, resourceId, nowIso);
  return future > 0;
}

export const createAdminResource = async (input: {
  db: D1Database;
  admin: AdminUser;
  resourceId?: string;
  request: AdminResourceCreateRequest;
  now?: () => number;
}): Promise<AdminResourceCreateResult> => {
  if (!isAdminPrivileged(input.admin.role)) {
    return { ok: false, error: "forbidden" };
  }
  const requestHash = await createResourceRequestHash(input.request);
  // Derive the idempotency clock before the TTL read so the read, the expires_at write, and the catch re-read share one injected now (B8).
  const { nowIso, expiresAt, idempotencyId } = buildCreateContext(input.now);
  const existingIdempotency = await fetchAdminActionIdempotency(input.db, input.request.idempotencyKey, nowIso);
  const idempotencyResult = resolveCreateIdempotency(existingIdempotency, requestHash);
  if (idempotencyResult) return idempotencyResult;

  if (!(await storeExists(input.db, input.request.storeId))) {
    return { ok: false, error: "store_not_found" };
  }
  const id = input.resourceId ?? crypto.randomUUID();
  const activeInt = input.request.active ? 1 : 0;

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
          `INSERT INTO store_resources (
             id, store_id, name, resource_type, active, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          id,
          input.request.storeId,
          input.request.name,
          input.request.resourceType,
          activeInt,
          nowIso,
          nowIso
        ),
      input.db
        .prepare(
          `INSERT INTO audit_logs (
             id, actor_type, actor_id, action, target_type, target_id, metadata_json
           ) VALUES (?, 'staff', ?, 'settings.resources.create', 'store_resource', ?, ?)`
        )
        .bind(
          crypto.randomUUID(),
          input.admin.id,
          id,
          JSON.stringify({
            resourceId: id,
            storeId: input.request.storeId,
            name: input.request.name,
            resourceType: input.request.resourceType,
            active: input.request.active,
            adminRole: input.admin.role
          })
        ),
      succeededIdempotencyStatement({
        db: input.db,
        idempotencyId,
        targetType: "store_resource",
        targetId: id,
        nowIso
      })
    ]);
  } catch (error) {
    if (await adminWriteWasRevoked(input.db, input.admin, error)) {
      return { ok: false, error: "forbidden" };
    }
    return recoverFromCreateBatchFailure({
      db: input.db,
      idempotencyKey: input.request.idempotencyKey,
      error,
      errorLabel: "createAdminResource",
      nowIso,
      resolveReplay: (row) => resolveCreateIdempotency(row, requestHash)
    });
  }

  return { ok: true, resourceId: id, replayed: false };
};

export const updateAdminResource = async (input: {
  db: D1Database;
  admin: AdminUser;
  resourceId: string;
  request: AdminResourceUpdateRequest;
  now?: () => number;
}): Promise<AdminResourceUpdateResult> => {
  if (!isAdminPrivileged(input.admin.role)) {
    return { ok: false, error: "forbidden" };
  }
  if (!(await storeExists(input.db, input.request.storeId))) {
    return { ok: false, error: "store_not_found" };
  }
  const current = await fetchResource(input.db, input.resourceId);
  if (!current) {
    return { ok: false, error: "not_found" };
  }
  const storeGuard = guardImmutableStore(current.store_id, input.request.storeId);
  if (storeGuard) return storeGuard;
  const nowIso = new Date((input.now ?? Date.now)()).toISOString();
  const activeInt = input.request.active ? 1 : 0;
  const isDeactivating = current.active === 1 && !input.request.active;
  if (await checkResourceDeactivation(input.db, input.resourceId, nowIso, isDeactivating)) {
    return { ok: false, error: "has_future_reservations" };
  }

  const guardActive = isDeactivating ? 1 : 0;
  try {
    await input.db.batch([
      adminWriteGuard(input.db, input.admin),
      input.db
        .prepare(
          `UPDATE store_resources
           SET store_id = ?, name = ?, resource_type = ?, active = ?, updated_at = ?
           WHERE id = ?
             AND (? = 0 OR NOT EXISTS (
               SELECT 1 FROM reservations
               WHERE resource_id = ?
                 AND status IN ('pending_approval', 'confirmed')
                 AND start_at > ?
             ))`
        )
        .bind(
          input.request.storeId,
          input.request.name,
          input.request.resourceType,
          activeInt,
          nowIso,
          input.resourceId,
          guardActive,
          input.resourceId,
          nowIso
        ),
      input.db
        .prepare(
          `INSERT INTO audit_logs (
             id, actor_type, actor_id, action, target_type, target_id, metadata_json
           ) VALUES (
             ?,
             CASE WHEN changes() = 1 THEN 'staff' ELSE 'soft_delete_conflict' END,
             ?, 'settings.resources.update', 'store_resource', ?, ?
           )`
        )
        .bind(
          crypto.randomUUID(),
          input.admin.id,
          input.resourceId,
          JSON.stringify({
            resourceId: input.resourceId,
            before: {
              storeId: current.store_id,
              name: current.name,
              resourceType: current.resource_type,
              active: current.active === 1
            },
            after: {
              storeId: input.request.storeId,
              name: input.request.name,
              resourceType: input.request.resourceType,
              active: input.request.active
            },
            adminRole: input.admin.role
          })
        )
    ]);
  } catch (error) {
    if (await adminWriteWasRevoked(input.db, input.admin, error)) {
      return { ok: false, error: "forbidden" };
    }
    return handleResourceUpdateBatchError(input.db, error, input.resourceId, isDeactivating);
  }

  return { ok: true, resourceId: input.resourceId };
};

export const softDeleteAdminResource = async (input: {
  db: D1Database;
  admin: AdminUser;
  resourceId: string;
  now?: () => number;
}): Promise<AdminResourceDeleteResult> => {
  if (!isAdminPrivileged(input.admin.role)) {
    return { ok: false, error: "forbidden" };
  }
  const current = await fetchResource(input.db, input.resourceId);
  if (!current) {
    return { ok: false, error: "not_found" };
  }
  const nowIso = new Date((input.now ?? Date.now)()).toISOString();
  const futureCount = await countFutureReservationsForResource(input.db, input.resourceId, nowIso);
  if (futureCount > 0) {
    return { ok: false, error: "has_future_reservations" };
  }

  try {
    await input.db.batch([
      adminWriteGuard(input.db, input.admin),
      input.db
        .prepare(
          `UPDATE store_resources
           SET active = 0, updated_at = ?
           WHERE id = ?
             AND NOT EXISTS (
               SELECT 1 FROM reservations
               WHERE resource_id = ?
                 AND status IN ('pending_approval', 'confirmed')
                 AND start_at > ?
             )`
        )
        .bind(nowIso, input.resourceId, input.resourceId, nowIso),
      input.db
        .prepare(
          `INSERT INTO audit_logs (
             id, actor_type, actor_id, action, target_type, target_id, metadata_json
           ) VALUES (
             ?,
             CASE WHEN changes() = 1 THEN 'staff' ELSE 'soft_delete_conflict' END,
             ?, 'settings.resources.delete', 'store_resource', ?, ?
           )`
        )
        .bind(
          crypto.randomUUID(),
          input.admin.id,
          input.resourceId,
          JSON.stringify({
            resourceId: input.resourceId,
            before: {
              storeId: current.store_id,
              name: current.name,
              resourceType: current.resource_type,
              active: current.active === 1
            },
            softDelete: true,
            adminRole: input.admin.role
          })
        )
    ]);
  } catch (error) {
    if (await adminWriteWasRevoked(input.db, input.admin, error)) {
      return { ok: false, error: "forbidden" };
    }
    if (isActorTypeBatchError(error)) {
      const fresh = await fetchResource(input.db, input.resourceId);
      if (!fresh) return { ok: false, error: "not_found" };
      return { ok: false, error: "has_future_reservations" };
    }
    console.error("softDeleteAdminResource batch failed", {
      resourceId: input.resourceId,
      error: error instanceof Error ? error.message : String(error)
    });
    return { ok: false, error: "write_failed" };
  }

  return { ok: true, resourceId: input.resourceId };
};
