import { sha256Hex } from "../crypto-utils";
import type { MinimoAccount } from "./config";
import type { MinimoClientError } from "./client";

export type SyncState = {
  store_id: string; config_hash: string; session_ciphertext: string | null; session_expires_at: string | null;
  next_attempt_at: string; next_date: string | null; last_attempt_at: string | null;
  last_success_at: string | null; last_error: string | null; consecutive_failures: number;
  sweep_mode: "preview" | "apply" | null; sweep_error: string | null;
  last_preview_at: string | null; paused_reason: string | null;
  next_inbound_at: string; next_outbound_at: string; last_inbound_attempt_at: string | null;
  last_inbound_success_at: string | null; last_inbound_preview_at: string | null;
  inbound_error: string | null; rate_limited_until: string | null;
  next_inbound_id: string | null; inbound_sweep_error: string | null;
};
export type ScheduleState = { snapshot_json: string; owned_json: string; status: "verified" | "pending" | "blocked" };

export const MINIMO_RESTRICTION_CODES = new Set([
  "forbidden", "challenge", "auth_failed", "redirect", "invalid_session", "invalid_response", "body_too_large", "account_mismatch", "account_unavailable"
]);

const LEASE_MS = 90_000;

export type StoreLease = {
  key: string;
  owner: string;
  storeId: string;
  resourceIds: string[];
  expiresAt: number;
};

export async function claimStoreLease(
  db: D1Database,
  storeId: string,
  resourceIds: string[],
  nowMs: number,
  leaseMs = LEASE_MS
): Promise<StoreLease | null> {
  const lease = { key: `minimo:${storeId}`, owner: crypto.randomUUID(), storeId, resourceIds, expiresAt: nowMs + leaseMs };
  const result = await db.prepare(`
    INSERT INTO job_leases (id, lease_key, locked_by, locked_until, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(lease_key) DO UPDATE SET locked_by = excluded.locked_by,
      locked_until = excluded.locked_until, updated_at = excluded.updated_at
    WHERE job_leases.locked_until <= ?
  `).bind(crypto.randomUUID(), lease.key, lease.owner,
    new Date(lease.expiresAt).toISOString(), new Date(nowMs).toISOString(), new Date(nowMs).toISOString()).run();
  return result.meta.changes === 1 ? lease : null;
}

/** The NOT NULL constraint aborts the whole batch if ownership or mapping changed. */
export function leaseFence(db: D1Database, lease: StoreLease, nowMs: number): D1PreparedStatement {
  const resourceSql = lease.resourceIds.length
    ? `AND (SELECT COUNT(*) FROM store_resources WHERE store_id = ? AND active = 1
        AND resource_type = 'staff_calendar' AND id IN (${lease.resourceIds.map(() => "?").join(",")})) = ?`
    : "";
  return db.prepare(`
    INSERT INTO job_leases (id, lease_key, locked_by, locked_until)
    SELECT ?, ?, CASE WHEN EXISTS (
      SELECT 1 FROM job_leases WHERE lease_key = ? AND locked_by = ? AND locked_until > ?
      ${resourceSql}
    ) THEN ? ELSE NULL END, ?
    ON CONFLICT(lease_key) DO UPDATE SET updated_at = job_leases.updated_at
  `).bind(crypto.randomUUID(), lease.key, lease.key, lease.owner, new Date(nowMs).toISOString(),
    ...(lease.resourceIds.length ? [lease.storeId, ...lease.resourceIds, lease.resourceIds.length] : []),
    lease.owner, new Date(nowMs).toISOString());
}

export async function fencedBatch(
  db: D1Database,
  lease: StoreLease,
  statements: D1PreparedStatement[],
  nowMs: number
): Promise<D1Result[]> {
  const results = await db.batch([leaseFence(db, lease, nowMs), ...statements]);
  return results.slice(1);
}

export async function renewStoreLease(db: D1Database, lease: StoreLease, nowMs: number): Promise<boolean> {
  const result = await db.prepare(`UPDATE job_leases SET locked_until = ?, updated_at = ?
    WHERE lease_key = ? AND locked_by = ? AND locked_until > ?`)
    .bind(new Date(nowMs + LEASE_MS).toISOString(), new Date(nowMs).toISOString(),
      lease.key, lease.owner, new Date(nowMs).toISOString()).run();
  if (result.meta.changes === 1) lease.expiresAt = nowMs + LEASE_MS;
  return result.meta.changes === 1;
}

export async function releaseStoreLease(db: D1Database, lease: StoreLease, nowMs: number): Promise<void> {
  await db.prepare("UPDATE job_leases SET locked_until = ? WHERE lease_key = ? AND locked_by = ?")
    .bind(new Date(nowMs).toISOString(), lease.key, lease.owner).run();
}

export async function recordSyncConflict(
  db: D1Database,
  lease: StoreLease,
  reason: string,
  externalId: string,
  nowMs: number
): Promise<void> {
  const id = await sha256Hex(`minimo:${lease.storeId}:${reason}:${externalId}`);
  await fencedBatch(db, lease, [db.prepare(`INSERT OR IGNORE INTO audit_logs
    (id, actor_type, actor_id, action, target_type, target_id, metadata_json)
    VALUES (?, 'system', 'minimo_sync', 'minimo_sync_conflict', 'store', ?, ?)`)
    .bind(id, lease.storeId, JSON.stringify({ reason, external_id: externalId }))], nowMs);
}

/** A provider delay is a lower bound; recovery and mode changes never shorten it. */
export async function recordMinimoFailure(input: {
  db: D1Database; lease: StoreLease; account: MinimoAccount; state?: SyncState;
  error: MinimoClientError; nowMs: number; phase?: "inbound" | "outbound";
}): Promise<void> {
  const { db, lease, account, state, error, nowMs } = input;
  const failures = (state?.consecutive_failures ?? 0) + 1;
  const delay = Math.max(error.retryAfterMs ?? 0, account.intervalMinutes * 60_000,
    Math.min(6 * 60 * 60_000, 10 * 60_000 * 2 ** Math.min(failures - 1, 6)));
  const paused = MINIMO_RESTRICTION_CODES.has(error.code) ? error.code : null;
  // An HTTP-date Retry-After can name the last instant a Date holds; adding elapsed time must not overflow toISOString.
  const next = Math.min(8_640_000_000_000_000, Math.max(Date.parse(state?.next_attempt_at ?? "") || 0, nowMs + delay));
  const rateLimit = error.code === "rate_limited" || error.status === 429
    ? new Date(Math.max(next, Date.parse(state?.rate_limited_until ?? "") || 0)).toISOString() : null;
  // Restriction evidence must survive a staff mapping change during HTTP.
  await fencedBatch(db, { ...lease, resourceIds: [] }, [db.prepare(`UPDATE minimo_sync_state SET next_attempt_at = ?,
    last_error = CASE WHEN ? = 'outbound' THEN ? ELSE last_error END,
    inbound_error = CASE WHEN ? = 'inbound' THEN ? ELSE inbound_error END,
    consecutive_failures = ?, paused_reason = COALESCE(?, paused_reason),
    rate_limited_until = COALESCE(?, rate_limited_until),
    session_ciphertext = CASE WHEN ? IS NOT NULL THEN NULL ELSE session_ciphertext END,
    session_expires_at = CASE WHEN ? IS NOT NULL THEN NULL ELSE session_expires_at END WHERE store_id = ?`)
    .bind(new Date(next).toISOString(), input.phase ?? "outbound", error.code,
      input.phase ?? "outbound", error.code, failures, paused, rateLimit, paused, paused, account.storeId)], nowMs);
}
