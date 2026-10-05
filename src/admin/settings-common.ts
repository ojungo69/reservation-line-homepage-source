import type { AdminUser } from "./access";
import { safeCaptureException } from "../sentry-helpers";
export { sha256Hex } from "../crypto-utils";

// Shared helpers for the admin settings editor modules (services / resources
// / staff / closures). All four per-table modules import from here so the
// idempotency_keys plumbing, batch-error detection, and parser primitives
// live in one place. The HTTP-layer wrapper for the matching CRUD routes
// lives in src/admin/settings-route-helpers.ts.

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_ID_LENGTH = 128;
export const MAX_NAME_LENGTH = 100;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 256;

export const isAdminPrivileged = (role: AdminUser["role"]): boolean =>
  role === "owner" || role === "system_admin";

/**
 * Check if an admin can perform a settings mutation on a given store.
 *
 * - owner / system_admin: always allowed.
 * - staff: allowed only if their store_id matches the target store.
 *
 * Use this for services, closures, business-hours — areas where staff are
 * permitted to edit within their own store scope.
 * Resources stay `isAdminPrivileged`-only: deleting a store_resource cascades
 * to slot_locks / slot_lock_history / external_blocks (reservations.resource_id
 * is ON DELETE RESTRICT, so reservations survive, but the cascades silently
 * drop lock/block state). Staff CRUD also remains `isAdminPrivileged`-only
 * (privilege escalation risk).
 */
export const isAdminAllowedForStoreSettings = (
  admin: Pick<AdminUser, "role" | "store_id">,
  targetStoreId: string
): boolean => {
  if (admin.role === "owner" || admin.role === "system_admin") return true;
  if (admin.role === "staff") return admin.store_id === targetStoreId;
  return false;
};

export const trimAndCap = (value: unknown, max: number): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
};

export const isActorTypeBatchError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("actor_type");
};

export const storeExists = async (db: D1Database, storeId: string): Promise<boolean> => {
  const row = await db
    .prepare(`SELECT 1 AS hit FROM stores WHERE id = ? LIMIT 1`)
    .bind(storeId)
    .first<{ hit: number }>();
  return row?.hit === 1;
};

// Cross-store moves are refused for any entity whose foreign-keyed downstream
// state (reservations.{store_id,service_id,resource_id}, external_blocks,
// admin_users.staff_member_id) was associated with the entity at write time.
// Silently re-assigning to a new store would leave the downstream rows
// pointing at a (entity, store) tuple that no longer matches.
// Used by settings-services / settings-resources / settings-staff UPDATE paths.
// Returns null when the storeId matches (continue with the update), or
// `{ ok: false, error: "immutable_store" }` when the caller requested a move.
export const guardImmutableStore = (
  currentStoreId: string,
  requestedStoreId: string
): { ok: false; error: "immutable_store" } | null =>
  currentStoreId === requestedStoreId
    ? null
    : { ok: false, error: "immutable_store" };

export type IdempotencyRow = {
  status: "started" | "succeeded" | "failed";
  target_id: string | null;
  request_hash: string | null;
};

export const fetchAdminActionIdempotency = async (
  db: D1Database,
  idempotencyKey: string,
  nowIso?: string
): Promise<IdempotencyRow | null> =>
  // Filter on expires_at so a "started" row from a crashed request stops
  // blocking the same idempotency_key string after its TTL window has
  // elapsed. Without this filter the key would be permanently locked
  // (see docs/SECURITY-AUDIT-2026-05-27.md F-6.1).
  //
  // Note: expires_at is stored as `Date.toISOString()`
  // (`YYYY-MM-DDTHH:mm:ss.sssZ`) and `datetime('now')` returns
  // `YYYY-MM-DD HH:mm:ss`. SQLite TEXT comparison would order `T` (0x54)
  // after ` ` (0x20), so a lexical `>` would treat an expired same-UTC-day
  // ISO row as still-valid. Wrap both sides in `datetime(...)` so SQLite
  // parses them to the canonical numeric/UNIX representation before
  // comparing.
  //
  // `nowIso` lets a caller thread its INJECTED clock so the TTL read and the
  // TTL write (`expires_at` stamped from the same injected `now`) are judged
  // against ONE clock — required for deterministic time-travel tests and to
  // avoid wall-clock/injected-clock skew at the TTL boundary. When omitted we
  // bind the literal SQLite `'now'` modifier, so `datetime(?)` collapses to
  // `datetime('now')` — byte-for-byte the legacy wall-clock behavior for
  // callers that have not (yet) threaded a clock.
  db
    .prepare(
      `SELECT status, target_id, request_hash
       FROM idempotency_keys
       WHERE scope = 'admin_action'
         AND idempotency_key = ?
         AND (expires_at IS NULL OR datetime(expires_at) > datetime(?))
       LIMIT 1`
    )
    .bind(idempotencyKey, nowIso ?? "now")
    .first<IdempotencyRow>();

export const startedIdempotencyStatement = (input: {
  db: D1Database;
  id: string;
  key: string;
  requestHash: string;
  expiresAt: string;
  nowIso: string;
}): D1PreparedStatement =>
  input.db
    .prepare(
      `INSERT INTO idempotency_keys (
         id, scope, idempotency_key, status, request_hash, expires_at, updated_at
       ) VALUES (?, 'admin_action', ?, 'started', ?, ?, ?)`
    )
    .bind(input.id, input.key, input.requestHash, input.expiresAt, input.nowIso);

export type CreateContext = {
  nowMs: number;
  nowIso: string;
  expiresAt: string;
  idempotencyId: string;
};

// Build the shared scratch values every create-flow needs (timestamps, the
// idempotency_keys row id) in one place so each module just destructures
// the result instead of repeating four assignments.
export const buildCreateContext = (now?: () => number): CreateContext => {
  const nowMs = (now ?? Date.now)();
  const nowIso = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + IDEMPOTENCY_TTL_MS).toISOString();
  const idempotencyId = crypto.randomUUID();
  return { nowMs, nowIso, expiresAt, idempotencyId };
};

export const succeededIdempotencyStatement = (input: {
  db: D1Database;
  idempotencyId: string;
  targetType: string;
  targetId: string;
  nowIso: string;
}): D1PreparedStatement =>
  input.db
    .prepare(
      `UPDATE idempotency_keys
       SET status = 'succeeded', target_type = ?, target_id = ?, updated_at = ?
       WHERE id = ?`
    )
    .bind(input.targetType, input.targetId, input.nowIso, input.idempotencyId);

// Shared catch-block recovery for the settings POST create flow. When the
// main db.batch throws, a concurrent caller may have already finished the
// same idempotency key — re-read it and let the per-table replay resolver
// decide whether to return the replayed result or fall through to
// write_failed. Wraps the concurrent lookup defensively so a D1 outage
// mid-recovery still surfaces the documented error code instead of an
// unhandled exception. `errorLabel` is prefixed into console.error messages
// so ops grep can scope to the originating helper.
export const recoverFromCreateBatchFailure = async <T>(input: {
  db: D1Database;
  idempotencyKey: string;
  error: unknown;
  errorLabel: string;
  // Optional injected clock for the concurrent re-read's TTL filter. Threaded
  // by callers whose WRITE stamps `expires_at` from the same injected `now`
  // (buildCreateContext) so the catch-path read and the write agree on one
  // clock. Omitted → wall-clock fallback (legacy behavior).
  nowIso?: string;
  resolveReplay: (row: IdempotencyRow | null) => T | undefined;
}): Promise<T | { ok: false; error: "write_failed" }> => {
  let concurrent: IdempotencyRow | null = null;
  try {
    concurrent = await fetchAdminActionIdempotency(input.db, input.idempotencyKey, input.nowIso);
  } catch (lookupError) {
    safeCaptureException(
      lookupError instanceof Error ? lookupError : new Error(String(lookupError)),
      { tags: { component: "admin-settings", op: "idempotency_lookup_failed", helper: input.errorLabel } }
    );
    console.error("admin settings: concurrent idempotency lookup failed", {
      helper: input.errorLabel,
      idempotencyKey: input.idempotencyKey,
      error: lookupError instanceof Error ? lookupError.message : String(lookupError)
    });
  }
  const replay = input.resolveReplay(concurrent);
  if (replay) return replay;
  safeCaptureException(input.error instanceof Error ? input.error : new Error(String(input.error)), {
    tags: { component: "admin-settings", op: "batch_write_failed", helper: input.errorLabel }
  });
  console.error("admin settings: create batch failed", {
    helper: input.errorLabel,
    idempotencyKey: input.idempotencyKey,
    error: input.error instanceof Error ? input.error.message : String(input.error)
  });
  return { ok: false, error: "write_failed" };
};
