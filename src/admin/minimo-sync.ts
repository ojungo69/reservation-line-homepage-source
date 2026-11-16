import type { AdminUser } from "./access";
import { adminWriteGuard, adminWriteWasRevoked } from "./write-authorization";
import { sha256Hex } from "../crypto-utils";
import { parseDateJstToUtcIso } from "../date-parse";
import { minimoConnectionHash, parseMinimoConfig, type MinimoAccount } from "../minimo/config";
import { MinimoClient, MinimoClientError, type MinimoRequestPacer } from "../minimo/client";
import { scheduleKey } from "../minimo/outbound";
import { openSession, sealSession } from "../minimo/session";
import { claimStoreLease, fencedBatch, leaseFence, recordMinimoFailure, releaseStoreLease,
  type StoreLease, type SyncState } from "../minimo/state";

type Environment = Parameters<typeof parseMinimoConfig>[0];
type DayState = { store_id: string; date: string; status: string; snapshot_json: string; owned_json: string; updated_at: string };
type RecoveryRequest = { storeId: string; expectedToken: string; confirm: true } & (
  { action: "resume" } | { action: "reconcile"; date: string; discardOwnership: boolean }
);
type RecoveryInput = { db: D1Database; admin: AdminUser; env: Environment; request: unknown;
  fetchImpl?: typeof fetch; pace?: MinimoRequestPacer; now?: () => number };
type RecoveryContext = RecoveryInput & { state: SyncState; request: RecoveryRequest;
  runner: StoreLease; lease: StoreLease; now: () => number };

function parseRecovery(value: unknown): RecoveryRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !["storeId", "expectedToken", "confirm", "action", "date", "discardOwnership"].includes(key))
    || typeof row.storeId !== "string" || !["kyoto", "osaka", "nagoya", "wakayama"].includes(row.storeId)
    || typeof row.expectedToken !== "string" || !/^[a-f0-9]{64}$/.test(row.expectedToken) || row.confirm !== true) return null;
  const common = { storeId: row.storeId, expectedToken: row.expectedToken, confirm: true as const };
  if (row.action === "resume" && row.date === undefined && row.discardOwnership === undefined) return { ...common, action: "resume" };
  if (row.action !== "reconcile" || typeof row.date !== "string" || !parseDateJstToUtcIso(row.date)
    || (row.discardOwnership !== undefined && typeof row.discardOwnership !== "boolean")) return null;
  return { ...common, action: "reconcile", date: row.date, discardOwnership: row.discardOwnership === true };
}

function stateToken(state: SyncState): Promise<string> {
  return sha256Hex(JSON.stringify([state.store_id, state.config_hash, state.next_attempt_at, state.next_date,
    state.last_attempt_at, state.last_error, state.consecutive_failures, state.sweep_mode, state.sweep_error, state.paused_reason,
    state.next_inbound_at, state.next_outbound_at, state.last_inbound_attempt_at, state.last_inbound_success_at,
    state.last_inbound_preview_at, state.inbound_error, state.rate_limited_until, state.next_inbound_id, state.inbound_sweep_error]));
}

function dayToken(row: DayState, configHash: string): Promise<string> {
  return sha256Hex(JSON.stringify([configHash, row.store_id, row.date, row.status, row.snapshot_json, row.owned_json, row.updated_at]));
}

export async function getAdminMinimoStatus(input: { db: D1Database; admin: AdminUser; env: Environment }) {
  if (input.admin.role !== "system_admin") return { ok: false as const, reason: "forbidden" };
  const [states, days] = await Promise.all([
    input.db.prepare("SELECT * FROM minimo_sync_state ORDER BY store_id").all<SyncState>(),
    input.db.prepare("SELECT * FROM minimo_schedule_state WHERE status <> 'verified' ORDER BY store_id, date LIMIT 401").all<DayState>()
  ]);
  const mode = input.env.MINIMO_SYNC_MODE || "off";
  return { ok: true as const, mode: ["off", "preview", "apply"].includes(mode) ? mode : "invalid",
    truncated: days.results.length > 400,
    stores: await Promise.all(states.results.map(async (row) => ({
      storeId: row.store_id, token: await stateToken(row), pausedReason: row.paused_reason,
      nextAttemptAt: row.next_attempt_at, nextDate: row.next_date, sweepMode: row.sweep_mode,
      lastAttemptAt: row.last_attempt_at, lastSuccessAt: row.last_success_at, lastPreviewAt: row.last_preview_at,
      error: row.last_error, sweepError: row.sweep_error,
      nextInboundAt: row.next_inbound_at, nextOutboundAt: row.next_outbound_at,
      lastInboundAttemptAt: row.last_inbound_attempt_at, lastInboundSuccessAt: row.last_inbound_success_at,
      lastInboundPreviewAt: row.last_inbound_preview_at, inboundError: row.inbound_error,
      rateLimitedUntil: row.rate_limited_until, inboundPending: row.next_inbound_id !== null, inboundSweepError: row.inbound_sweep_error,
      days: await Promise.all(days.results.slice(0, 400).filter((day) => day.store_id === row.store_id)
        .map(async (day) => ({ date: day.date, status: day.status, token: await dayToken(day, row.config_hash) })))
    }))) };
}

/** Abort the same mutation batch if the reviewed store or day changed. */
function recoveryGuard(context: RecoveryContext, day?: DayState): D1PreparedStatement {
  const { db, state } = context;
  const daySql = day ? `AND EXISTS (SELECT 1 FROM minimo_schedule_state WHERE store_id = ? AND date = ?
    AND status = ? AND snapshot_json = ? AND owned_json = ? AND updated_at = ?)` : "";
  return db.prepare(`INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id)
    SELECT ?, 'minimo_recovery_conflict', ?, 'minimo_recovery_guard', 'store', ? WHERE NOT EXISTS
    (SELECT 1 FROM minimo_sync_state WHERE store_id = ? AND config_hash = ? AND next_attempt_at = ?
      AND next_date IS ? AND last_attempt_at IS ? AND last_error IS ? AND consecutive_failures = ?
      AND sweep_mode IS ? AND sweep_error IS ? AND paused_reason IS ?
      AND next_inbound_at = ? AND next_outbound_at = ? AND last_inbound_attempt_at IS ?
      AND last_inbound_success_at IS ? AND last_inbound_preview_at IS ? AND inbound_error IS ?
      AND rate_limited_until IS ? AND next_inbound_id IS ? AND inbound_sweep_error IS ? ${daySql})`)
    .bind(crypto.randomUUID(), context.admin.id, state.store_id, state.store_id, state.config_hash,
      state.next_attempt_at, state.next_date, state.last_attempt_at, state.last_error, state.consecutive_failures,
      state.sweep_mode, state.sweep_error, state.paused_reason,
      state.next_inbound_at, state.next_outbound_at, state.last_inbound_attempt_at, state.last_inbound_success_at,
      state.last_inbound_preview_at, state.inbound_error, state.rate_limited_until, state.next_inbound_id, state.inbound_sweep_error,
      ...(day ? [day.store_id, day.date, day.status, day.snapshot_json, day.owned_json, day.updated_at] : []));
}

async function commitRecovery(context: RecoveryContext, statements: D1PreparedStatement[], day?: DayState): Promise<void> {
  const { db, admin, request, now } = context;
  await fencedBatch(db, context.lease, [leaseFence(db, context.runner, now()), adminWriteGuard(db, admin),
    recoveryGuard(context, day), ...statements,
    db.prepare(`INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, metadata_json)
      VALUES (?, 'staff', ?, ?, 'store', ?, ?)`)
      .bind(crypto.randomUUID(), admin.id, `minimo_sync_${request.action}`, request.storeId,
        JSON.stringify(request.action === "resume" ? { reason: context.state.paused_reason }
          : { date: request.date, discarded_ownership: request.discardOwnership }))
  ], now());
}

async function readRecoverySchedule(context: RecoveryContext, row: DayState, account: MinimoAccount, sessionKey: string) {
  const { db, state, lease, now } = context;
  let cookie: string | undefined;
  if (state.session_ciphertext && state.session_expires_at && Date.parse(state.session_expires_at) > now()) {
    try { cookie = await openSession(state.session_ciphertext, sessionKey, `${state.store_id}:${state.config_hash}`); }
    catch { /* A rotated or invalid cache requires fresh authentication. */ }
  }
  const client = new MinimoClient({ account, cookie, fetchImpl: context.fetchImpl, pace: context.pace, now });
  const observed = await client.getSchedule(row.date, Math.min(lease.expiresAt, context.runner.expiresAt));
  if (client.sessionCookie && client.sessionCookie !== cookie) {
    const ciphertext = await sealSession(client.sessionCookie, sessionKey, `${state.store_id}:${state.config_hash}`);
    await fencedBatch(db, lease, [leaseFence(db, context.runner, now()), adminWriteGuard(db, context.admin),
      recoveryGuard(context, row), db.prepare("UPDATE minimo_sync_state SET session_ciphertext = ?, session_expires_at = ? WHERE store_id = ?")
        .bind(ciphertext, new Date(now() + 6 * 60 * 60_000).toISOString(), state.store_id)
    ], now());
  }
  return observed;
}

async function reconcileDay(context: RecoveryContext, request: Extract<RecoveryRequest, { action: "reconcile" }>) {
  const { db, state, lease, now } = context;
  const row = await db.prepare("SELECT * FROM minimo_schedule_state WHERE store_id = ? AND date = ?")
    .bind(request.storeId, request.date).first<DayState>();
  if (!row || row.status === "verified") return { ok: false as const, reason: "invalid_transition" };
  if (await dayToken(row, state.config_hash) !== request.expectedToken) return { ok: false as const, reason: "stale_snapshot" };
  const states = (await db.prepare("SELECT * FROM minimo_sync_state").all<SyncState>()).results;
  if (states.some((item) => item.paused_reason)) return { ok: false as const, reason: "minimo_provider_paused" };
  if (Date.parse(state.next_attempt_at) > now() || Date.parse(state.next_outbound_at) > now()
    || states.some((item) => Date.parse(item.rate_limited_until ?? "") > now())) {
    return { ok: false as const, reason: "minimo_cooldown" };
  }
  const config = parseMinimoConfig(context.env);
  if (config.mode !== "apply") return { ok: false as const, reason: "minimo_disabled" };
  const account = config.accounts.find((item) => item.storeId === request.storeId);
  if (!account || await minimoConnectionHash(account) !== state.config_hash) return { ok: false as const, reason: "minimo_config_changed" };
  lease.resourceIds = account.staff.map((staff) => staff.resourceId);
  const attemptedAt = new Date(now()).toISOString();
  const nextAttemptAt = new Date(now() + account.intervalMinutes * 60_000).toISOString();
  // Reserve the attempt before any login/read so mismatches cannot be polled
  // repeatedly through the operator endpoint. This also validates the mapping.
  await fencedBatch(db, lease, [leaseFence(db, context.runner, now()), adminWriteGuard(db, context.admin),
    recoveryGuard(context, row),
    db.prepare("UPDATE minimo_sync_state SET last_attempt_at = ?, next_attempt_at = ? WHERE store_id = ?")
      .bind(attemptedAt, nextAttemptAt, state.store_id)
  ], now());
  state.last_attempt_at = attemptedAt;
  state.next_attempt_at = nextAttemptAt;
  try {
    const observed = await readRecoverySchedule(context, row, account, config.sessionKey);
    if (!request.discardOwnership && scheduleKey(observed) !== scheduleKey(JSON.parse(row.snapshot_json))) {
      return { ok: false as const, reason: "minimo_remote_changed" };
    }
    if (account.staff.some((staff) => !observed.entries.some((entry) => entry.staffId === staff.rimaUserId))) {
      return { ok: false as const, reason: "minimo_config_changed" };
    }
    await commitRecovery(context, [
      db.prepare(`UPDATE minimo_schedule_state SET status = 'verified', snapshot_json = ?, owned_json = ?, updated_at = ?
        WHERE store_id = ? AND date = ?`).bind(JSON.stringify(observed), request.discardOwnership ? "{}" : row.owned_json,
          new Date(now()).toISOString(), request.storeId, request.date),
      db.prepare("UPDATE minimo_sync_state SET next_date = NULL, sweep_error = NULL WHERE store_id = ?").bind(request.storeId)
    ], row);
    return { ok: true as const, action: request.action, storeId: request.storeId };
  } catch (error) {
    if (!(error instanceof MinimoClientError)) throw error;
    await recordMinimoFailure({ db, lease, account, state, error, nowMs: now() });
    return { ok: false as const, reason: error.code === "rate_limited" ? "rate_limited" : "minimo_provider_error", providerReason: error.code };
  }
}

export async function recoverAdminMinimoSync(input: RecoveryInput) {
  const { db, admin } = input;
  if (admin.role !== "system_admin") return { ok: false as const, reason: "forbidden" };
  const request = parseRecovery(input.request);
  if (!request) return { ok: false as const, reason: "invalid_request" };
  if (await adminWriteWasRevoked(db, admin)) return { ok: false as const, reason: "forbidden" };
  const now = input.now ?? Date.now;
  const runner = await claimStoreLease(db, "runner", [], now());
  if (!runner) return { ok: false as const, reason: "minimo_busy" };
  let lease: Awaited<ReturnType<typeof claimStoreLease>> = null;
  try {
    lease = await claimStoreLease(db, request.storeId, [], now());
    if (!lease) return { ok: false as const, reason: "minimo_busy" };
    const state = await db.prepare("SELECT * FROM minimo_sync_state WHERE store_id = ?").bind(request.storeId).first<SyncState>();
    if (!state) return { ok: false as const, reason: "not_found" };
    const context = { ...input, state, request, runner, lease, now };
    if (request.action === "reconcile") return await reconcileDay(context, request);
    if (await stateToken(state) !== request.expectedToken) return { ok: false as const, reason: "stale_snapshot" };
    if (!state.paused_reason) return { ok: false as const, reason: "invalid_transition" };
    await commitRecovery(context, [
      db.prepare("UPDATE minimo_sync_state SET paused_reason = NULL, next_date = NULL, sweep_error = NULL WHERE store_id = ?")
        .bind(request.storeId)
    ]);
    return { ok: true as const, action: request.action, storeId: request.storeId };
  } catch (error) {
    return { ok: false as const, reason: await adminWriteWasRevoked(db, admin, error) ? "forbidden" : "write_failed" };
  } finally {
    if (lease) await releaseStoreLease(db, lease, now());
    await releaseStoreLease(db, runner, now());
  }
}
