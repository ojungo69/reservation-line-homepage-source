import { parseDateJstToUtcIso } from "../date-parse";
import { createMinimoRequestPacer, MinimoClient, MinimoClientError, type MinimoRequestPacer } from "./client";
import { minimoConnectionHash, parseMinimoConfig, type MinimoAccount } from "./config";
import type { InboundResult } from "./inbound";
import { pollMinimoInbound } from "./inbound-poll";
import { loadAvailabilityInputs, planOutboundDay, scheduleKey, type ScheduleOwnership } from "./outbound";
import type { MinimoSchedule } from "./schedule";
import { openSession, sealSession } from "./session";
import { claimStoreLease, fencedBatch, recordSyncConflict, releaseStoreLease, renewStoreLease, recordMinimoFailure,
  MINIMO_RESTRICTION_CODES, type SyncState, type ScheduleState, type StoreLease } from "./state";

type SyncEnvironment = Parameters<typeof parseMinimoConfig>[0];
export type MinimoStoreResult = InboundResult & {
  storeId: string; outcome: "skipped" | "complete" | "partial" | "attention" | "failed";
  dates: number; closed: number; reopened: number; error?: string;
};
type StoreContext = {
  db: D1Database; account: MinimoAccount; lease: StoreLease; client: MinimoClient;
  mode: "preview" | "apply"; now: () => number; sessionKey: string; configHash: string;
  savedCookie: string | null; result: MinimoStoreResult; deadline: number;
};

const SESSION_MS = 6 * 60 * 60_000;
const RUN_MS = 180_000;
const ISO = (ms: number) => new Date(ms).toISOString();
const dateKey = (ms: number) => ISO(ms + 9 * 60 * 60_000).slice(0, 10);
const safeCodes = new Set(["minimo_remote_changed", "minimo_staff_missing", "minimo_config_changed",
  "minimo_duration_exceeds_mapping", "minimo_catalogue_changed", "minimo_reservation_unresolved",
  "minimo_resource_invalid", "minimo_invalid_state", "minimo_local_changed", "minimo_lease_lost",
  "minimo_write_review_required", "minimo_inbound_conflict", "minimo_write_unverified"]);

function safeError(error: unknown): string {
  if (error instanceof MinimoClientError) return error.code;
  return error instanceof Error && safeCodes.has(error.message) ? error.message : "internal_error";
}

function emptyResult(storeId: string): MinimoStoreResult {
  return { storeId, outcome: "skipped", dates: 0, imported: 0, updated: 0, cancelled: 0,
    conflicts: 0, closed: 0, reopened: 0 };
}

async function storeWindow(db: D1Database, account: MinimoAccount): Promise<number> {
  const store = await db.prepare(`SELECT stores.timezone, COALESCE(store_settings.booking_window_days, 30) AS days
    FROM stores LEFT JOIN store_settings ON store_settings.store_id = stores.id WHERE stores.id = ?`)
    .bind(account.storeId).first<{ timezone: string; days: number }>();
  if (store?.timezone !== "Asia/Tokyo" || !Number.isInteger(store.days) || store.days < 1 || store.days > 90) {
    throw new Error("minimo_resource_invalid");
  }
  const resources = await db.prepare(`SELECT id FROM store_resources WHERE store_id = ? AND active = 1
    AND resource_type = 'staff_calendar'`).bind(account.storeId).all<{ id: string }>();
  if (account.staff.some((staff) => !resources.results.some((resource) => resource.id === staff.resourceId))) {
    throw new Error("minimo_resource_invalid");
  }
  return store.days;
}

async function sweepDates(db: D1Database, account: MinimoAccount, windowDays: number, nowMs: number): Promise<string[]> {
  const today = dateKey(nowMs);
  const midnight = Date.parse(parseDateJstToUtcIso(today)!);
  const dates = new Set(Array.from({ length: windowDays + 1 }, (_, index) => dateKey(midnight + index * 86_400_000)));
  const [imports, owned] = await Promise.all([
    db.prepare(`SELECT DISTINCT substr(datetime(start_at, '+9 hours'), 1, 10) AS date FROM external_blocks
      WHERE store_id = ? AND source = 'minimo' AND status = 'active' AND end_at > ?`)
      .bind(account.storeId, ISO(nowMs)).all<{ date: string }>(),
    db.prepare("SELECT date FROM minimo_schedule_state WHERE store_id = ? AND date >= ?")
      .bind(account.storeId, today).all<{ date: string }>()
  ]);
  for (const row of [...imports.results, ...owned.results]) {
    if (row.date >= today && parseDateJstToUtcIso(row.date)) dates.add(row.date);
  }
  return [...dates].sort((a, b) => a.localeCompare(b));
}

async function initializeState(
  context: StoreContext, state: SyncState | undefined, phase: "inbound" | "outbound"
): Promise<void> {
  const { db, account, lease, configHash, mode } = context;
  const nowMs = context.now();
  if (state && state.config_hash !== configHash) {
    const owned = await db.prepare(`SELECT 1 AS found FROM external_blocks
      WHERE store_id = ? AND source = 'minimo' LIMIT 1`).bind(account.storeId).first();
    const schedule = await db.prepare("SELECT 1 AS found FROM minimo_schedule_state WHERE store_id = ? LIMIT 1")
      .bind(account.storeId).first();
    if (owned || schedule) throw new Error("minimo_config_changed");
  }
  await fencedBatch(db, lease, [db.prepare(`INSERT INTO minimo_sync_state
    (store_id, config_hash, sweep_mode, next_attempt_at, last_attempt_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(store_id) DO UPDATE SET
      session_ciphertext = CASE WHEN config_hash = excluded.config_hash THEN session_ciphertext ELSE NULL END,
      session_expires_at = CASE WHEN config_hash = excluded.config_hash THEN session_expires_at ELSE NULL END,
      next_date = CASE WHEN config_hash = excluded.config_hash AND sweep_mode = excluded.sweep_mode THEN next_date ELSE NULL END,
      sweep_error = CASE WHEN config_hash = excluded.config_hash AND sweep_mode = excluded.sweep_mode THEN sweep_error ELSE NULL END,
      next_inbound_id = CASE WHEN config_hash = excluded.config_hash AND sweep_mode = excluded.sweep_mode
        THEN next_inbound_id ELSE NULL END,
      inbound_sweep_error = CASE WHEN config_hash = excluded.config_hash AND sweep_mode = excluded.sweep_mode
        THEN inbound_sweep_error ELSE NULL END,
      next_inbound_at = CASE WHEN config_hash = excluded.config_hash AND sweep_mode = excluded.sweep_mode
        THEN next_inbound_at ELSE excluded.last_attempt_at END,
      next_outbound_at = CASE WHEN config_hash = excluded.config_hash AND sweep_mode = excluded.sweep_mode
        THEN next_outbound_at ELSE excluded.last_attempt_at END,
      config_hash = excluded.config_hash, sweep_mode = excluded.sweep_mode,
      last_attempt_at = CASE WHEN ? = 'outbound' THEN excluded.last_attempt_at ELSE last_attempt_at END,
      last_inbound_attempt_at = CASE WHEN ? = 'inbound' THEN excluded.last_attempt_at ELSE last_inbound_attempt_at END`)
    .bind(account.storeId, configHash, mode, ISO(nowMs), ISO(nowMs), phase, phase),
    db.prepare(`UPDATE minimo_sync_state SET last_inbound_attempt_at = ? WHERE store_id = ? AND ? = 'inbound'`)
      .bind(ISO(nowMs), account.storeId, phase)], nowMs);
}

async function saveSession(context: StoreContext): Promise<void> {
  const cookie = context.client.sessionCookie;
  if (!cookie || cookie === context.savedCookie) return;
  const encrypted = await sealSession(cookie, context.sessionKey, `${context.account.storeId}:${context.configHash}`);
  await fencedBatch(context.db, context.lease, [context.db.prepare(`UPDATE minimo_sync_state
    SET session_ciphertext = ?, session_expires_at = ? WHERE store_id = ?`)
    .bind(encrypted, ISO(context.now() + SESSION_MS), context.account.storeId)], context.now());
  context.savedCookie = cookie;
}

function readOwnership(row: ScheduleState): ScheduleOwnership {
  try {
    const snapshot = JSON.parse(row.snapshot_json) as MinimoSchedule;
    const owned = JSON.parse(row.owned_json) as Record<string, string[]>;
    if (!owned || Array.isArray(owned) || typeof owned !== "object"
      || Object.values(owned).some((slots) => !Array.isArray(slots) || slots.length > 288
        || slots.some((slot) => typeof slot !== "string" || !Number.isFinite(Date.parse(slot))))) {
      throw new Error("minimo_invalid_state");
    }
    scheduleKey(snapshot);
    return { snapshot, owned };
  } catch {
    throw new Error("minimo_invalid_state");
  }
}

async function saveSchedule(
  context: StoreContext, schedule: MinimoSchedule, owned: Record<string, string[]>, status: ScheduleState["status"]
): Promise<void> {
  await fencedBatch(context.db, context.lease, [context.db.prepare(`INSERT INTO minimo_schedule_state
    (store_id, date, snapshot_json, owned_json, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(store_id, date) DO UPDATE SET snapshot_json = excluded.snapshot_json,
      owned_json = excluded.owned_json, status = excluded.status, updated_at = excluded.updated_at`)
    .bind(context.account.storeId, schedule.date, JSON.stringify(schedule), JSON.stringify(owned), status, ISO(context.now()))], context.now());
}

async function updateAvailability(context: StoreContext, schedule: MinimoSchedule, latestDate: string): Promise<void> {
  const { db, account, client, result } = context;
  const row = await db.prepare("SELECT snapshot_json, owned_json, status FROM minimo_schedule_state WHERE store_id = ? AND date = ?")
    .bind(account.storeId, schedule.date).first<ScheduleState>();
  if (row && row.status !== "verified") throw new Error("minimo_write_review_required");
  const inputs = await loadAvailabilityInputs(db, account, schedule.date, context.now());
  if (schedule.date > latestDate) inputs.hours = [];
  const plan = planOutboundDay(account, schedule, inputs, row ? readOwnership(row) : null, context.now());
  if (context.mode === "preview") {
    result.closed += plan.closed;
    result.reopened += plan.reopened;
    return;
  }
  if (!plan.changed) {
    // Keep no empty baseline row: only recorded closures establish ownership.
    if (row) await saveSchedule(context, schedule, plan.owned, "verified");
    return;
  }
  const remote = await client.getSchedule(schedule.date, Math.min(context.deadline, context.lease.expiresAt));
  if (scheduleKey(remote) !== scheduleKey(schedule)) throw new Error("minimo_remote_changed");
  const freshInputs = await loadAvailabilityInputs(db, account, schedule.date, context.now());
  if (schedule.date > latestDate) freshInputs.hours = [];
  if (JSON.stringify(inputs) !== JSON.stringify(freshInputs)) throw new Error("minimo_local_changed");
  if (!await renewStoreLease(db, context.lease, context.now())) throw new Error("minimo_lease_lost");
  await saveSchedule(context, plan.schedule, plan.owned, "pending");
  if (!await renewStoreLease(db, context.lease, context.now()) || context.now() >= context.lease.expiresAt) {
    throw new Error("minimo_lease_lost");
  }
  await client.postSchedule(plan.schedule, Math.min(context.deadline, context.lease.expiresAt));
  const observed = await client.getSchedule(schedule.date, Math.min(context.deadline, context.lease.expiresAt));
  const afterInputs = await loadAvailabilityInputs(db, account, schedule.date, context.now());
  if (schedule.date > latestDate) afterInputs.hours = [];
  if (scheduleKey(observed) !== scheduleKey(plan.schedule) || JSON.stringify(freshInputs) !== JSON.stringify(afterInputs)) {
    throw new Error("minimo_write_unverified");
  }
  await saveSchedule(context, observed, plan.owned, "verified");
  result.closed += plan.closed;
  result.reopened += plan.reopened;
}

async function processDay(context: StoreContext, date: string, latestDate: string): Promise<void> {
  const schedule = await context.client.getSchedule(date, Math.min(context.deadline, context.lease.expiresAt));
  await saveSession(context);
  for (const mapping of context.account.staff) {
    if (!schedule.entries.some((entry) => entry.staffId === mapping.rimaUserId)) throw new Error("minimo_staff_missing");
  }
  try {
    await updateAvailability(context, schedule, latestDate);
  } catch (error) {
    const code = safeError(error);
    if (error instanceof MinimoClientError || !safeCodes.has(code) || code === "minimo_lease_lost") throw error;
    context.result.error = code;
    if (context.mode === "apply") {
      await recordSyncConflict(context.db, context.lease, code, date, context.now());
      if (code === "minimo_remote_changed") {
        await fencedBatch(context.db, context.lease, [context.db.prepare(`UPDATE minimo_schedule_state
          SET status = 'blocked', updated_at = ? WHERE store_id = ? AND date = ?`)
          .bind(ISO(context.now()), context.account.storeId, date)], context.now());
      }
    }
  }
}

async function runSweep(context: StoreContext, dates: string[], cursor: string | null, latestDate: string): Promise<void> {
  const remaining = cursor ? dates.filter((date) => date >= cursor) : dates;
  for (const date of remaining) {
    if (context.now() + 10_000 >= context.deadline) {
      context.result.outcome = "partial";
      return;
    }
    if (!await renewStoreLease(context.db, context.lease, context.now())) throw new Error("minimo_lease_lost");
    await fencedBatch(context.db, context.lease, [context.db.prepare("UPDATE minimo_sync_state SET next_date = ? WHERE store_id = ?")
      .bind(date, context.account.storeId)], context.now());
    await processDay(context, date, latestDate);
    context.result.dates += 1;
    const next = ISO(Date.parse(parseDateJstToUtcIso(date)!) + 86_400_000 + 9 * 60 * 60_000).slice(0, 10);
    await fencedBatch(context.db, context.lease, [context.db.prepare("UPDATE minimo_sync_state SET next_date = ?, sweep_error = ? WHERE store_id = ?")
      .bind(next, context.result.error ?? null, context.account.storeId)], context.now());
  }
  context.result.outcome = context.result.error ? "attention" : "complete";
}

async function finishStore(context: StoreContext): Promise<void> {
  const partial = context.result.outcome === "partial";
  const delay = partial ? 5 * 60_000 : context.account.intervalMinutes * 60_000;
  await fencedBatch(context.db, context.lease, [context.db.prepare(`UPDATE minimo_sync_state SET
    next_outbound_at = ?, next_date = CASE WHEN ? THEN next_date ELSE NULL END,
    last_success_at = CASE WHEN ? THEN ? ELSE last_success_at END,
    last_preview_at = CASE WHEN ? THEN ? ELSE last_preview_at END, last_error = ?,
    consecutive_failures = CASE WHEN inbound_error IS NULL THEN 0 ELSE consecutive_failures END
    WHERE store_id = ?`).bind(ISO(context.now() + delay), partial ? 1 : 0,
      context.result.outcome === "complete" && context.mode === "apply" ? 1 : 0, ISO(context.now()),
      context.result.outcome === "complete" && context.mode === "preview" ? 1 : 0, ISO(context.now()),
      context.result.error ?? null, context.account.storeId)], context.now());
}

async function cachedSession(
  state: SyncState | undefined, key: string, configHash: string, storeId: string, nowMs: number
): Promise<string | undefined> {
  if (state?.config_hash !== configHash || !state.session_ciphertext || !state.session_expires_at
    || state.session_expires_at <= ISO(nowMs)) return undefined;
  try { return await openSession(state.session_ciphertext, key, `${storeId}:${configHash}`); }
  catch { return undefined; } // Rotated keys or damaged caches require fresh authentication.
}

type Phase = "inbound" | "outbound";
type RunStoreInput = {
  db: D1Database; account: MinimoAccount; state: SyncState | undefined; mode: "preview" | "apply";
  sessionKey: string; fetchImpl?: typeof fetch; pace: MinimoRequestPacer; now: () => number;
  deadline: number; signal: AbortSignal; phase: Phase;
};

async function finishInbound(context: StoreContext, partial: boolean): Promise<void> {
  const { db, lease, result, account, mode, now } = context;
  result.outcome = partial ? "partial" : "complete";
  if (!partial && result.error) result.outcome = "attention";
  await fencedBatch(db, lease, [db.prepare(`UPDATE minimo_sync_state SET next_inbound_at = ?, inbound_error = ?,
    next_inbound_id = CASE WHEN ? THEN next_inbound_id ELSE NULL END,
    inbound_sweep_error = CASE WHEN ? THEN inbound_sweep_error ELSE NULL END,
    last_inbound_success_at = CASE WHEN ? THEN ? ELSE last_inbound_success_at END,
    last_inbound_preview_at = CASE WHEN ? THEN ? ELSE last_inbound_preview_at END,
    consecutive_failures = CASE WHEN last_error IS NULL THEN 0 ELSE consecutive_failures END WHERE store_id = ?`)
    .bind(ISO(now() + (partial ? 5 : account.inboundIntervalMinutes ?? 10) * 60_000), result.error ?? null, partial ? 1 : 0, partial ? 1 : 0,
      !partial && !result.error && mode === "apply" ? 1 : 0, ISO(now()), !partial && !result.error && mode === "preview" ? 1 : 0,
      ISO(now()), account.storeId)], now());
}

async function runOutbound(context: StoreContext, state: SyncState | undefined, windowDays: number): Promise<void> {
  for (const staff of context.account.staff) {
    const durations = await context.client.getBookableMenuDurations(staff.rimaUserId, Math.min(context.deadline, context.lease.expiresAt));
    if (durations.some(duration => duration > staff.maxDurationMinutes)) {
      context.result.error = "minimo_duration_exceeds_mapping";
      context.result.outcome = "attention";
      await finishStore(context);
      return;
    }
  }
  const dates = await sweepDates(context.db, context.account, windowDays, context.now());
  const today = Date.parse(parseDateJstToUtcIso(dateKey(context.now()))!);
  const cursor = state?.config_hash === context.configHash && state.sweep_mode === context.mode ? state.next_date : null;
  if (cursor && state?.sweep_error) context.result.error = state.sweep_error;
  await runSweep(context, dates, cursor, dateKey(today + windowDays * 86_400_000));
  await finishStore(context);
}

async function runStore(input: RunStoreInput): Promise<MinimoStoreResult> {
  const { db, account, state, now, phase } = input;
  const result = emptyResult(account.storeId);
  const lease = await claimStoreLease(db, account.storeId, account.staff.map((staff) => staff.resourceId), now());
  if (!lease) return { ...result, error: "leased" };
  try {
    const windowDays = await storeWindow(db, account);
    const configHash = await minimoConnectionHash(account);
    const cookie = await cachedSession(state, input.sessionKey, configHash, account.storeId, now());
    const client = new MinimoClient({ account, cookie, fetchImpl: input.fetchImpl, pace: input.pace, now, signal: input.signal });
    const context: StoreContext = { ...input, lease, client, configHash, savedCookie: cookie ?? null, result };
    await initializeState(context, state, phase);
    if (phase === "inbound") {
      const continuing = state?.config_hash === configHash && state.sweep_mode === input.mode;
      const { partial, ...inbound } = await pollMinimoInbound({ ...context,
        cursor: continuing ? state.next_inbound_id : null, sweepError: continuing ? state.inbound_sweep_error : null });
      Object.assign(result, inbound);
      await finishInbound(context, partial);
    } else await runOutbound(context, state, windowDays);
    await saveSession(context);
  } catch (error) {
    result.outcome = "failed";
    result.error = safeError(error);
    try {
      await recordMinimoFailure({ db, lease, account, state, nowMs: now(), phase,
        error: error instanceof MinimoClientError ? error : new MinimoClientError(result.error, 0) });
    } catch { /* Lost ownership cannot overwrite the replacement worker's health or session. */ }
  } finally {
    await releaseStoreLease(db, lease, now());
  }
  return result;
}

function mergeResult(previous: MinimoStoreResult, next: MinimoStoreResult): MinimoStoreResult {
  if (previous.outcome === "skipped") return next;
  if (next.outcome === "skipped" || next.error === "provider_paused") return previous;
  const order = ["complete", "partial", "attention", "failed"];
  const result = { ...next, outcome: order.indexOf(previous.outcome) > order.indexOf(next.outcome) ? previous.outcome : next.outcome,
    error: next.error ?? previous.error };
  for (const key of ["dates", "imported", "updated", "cancelled", "conflicts", "closed", "reopened"] as const) result[key] += previous[key];
  return result;
}

function skipReason(state: SyncState | undefined, phase: Phase, mode: string, nowMs: number, deadline: number): string | null {
  if (nowMs + 10_000 >= deadline) return "not_due";
  if (!state) return phase === "outbound" ? "inbound_not_ready" : null;
  if (Date.parse(state.next_attempt_at) > nowMs) return "not_due";
  if (state.sweep_mode !== mode) return phase === "outbound" ? "inbound_not_ready" : null;
  if (phase === "outbound") {
    const inboundAt = mode === "apply" ? state.last_inbound_success_at : state.last_inbound_preview_at;
    if (state.inbound_error || !inboundAt || nowMs - Date.parse(inboundAt) > 20 * 60_000) return "inbound_not_ready";
  }
  const due = phase === "inbound" ? state.next_inbound_at : state.next_outbound_at;
  return Date.parse(due) > nowMs ? "not_due" : null;
}

function providerBlock(states: Map<string, SyncState>, nowMs: number): string | null {
  if ([...states.values()].some(row => row.paused_reason)) return "provider_paused";
  if ([...states.values()].some(row => Date.parse(row.rate_limited_until ?? "") > nowMs)) return "rate_limited";
  return null;
}

async function runPhase(input: Omit<RunStoreInput, "account" | "state"> & {
  accounts: MinimoAccount[]; states: Map<string, SyncState>; results: Map<string, MinimoStoreResult>;
  stop: { reason: string | null };
}): Promise<void> {
  const { phase, states, results, now, deadline } = input;
  const field = phase === "inbound" ? "last_inbound_attempt_at" : "last_attempt_at";
  const accounts = [...input.accounts].sort((a, b) =>
    (states.get(a.storeId)?.[field] ?? "").localeCompare(states.get(b.storeId)?.[field] ?? ""));
  for (const [index, account] of accounts.entries()) {
    const state = states.get(account.storeId);
    const reason = input.stop.reason ?? providerBlock(states, now()) ?? skipReason(state, phase, input.mode, now(), deadline);
    if (reason) {
      const skipped: MinimoStoreResult = { ...emptyResult(account.storeId),
        outcome: reason === "provider_paused" ? "attention" : "skipped", error: reason };
      results.set(account.storeId, mergeResult(results.get(account.storeId)!, skipped));
      continue;
    }
    const budget = phase === "inbound" ? 35_000 : (deadline - now()) / (accounts.length - index);
    const result = await runStore({ ...input, account, state, deadline: Math.min(deadline, now() + budget) });
    if (MINIMO_RESTRICTION_CODES.has(result.error ?? "")) input.stop.reason = "provider_paused";
    if (result.error === "rate_limited") input.stop.reason = "rate_limited";
    const updated = await input.db.prepare("SELECT * FROM minimo_sync_state WHERE store_id = ?")
      .bind(account.storeId).first<SyncState>();
    if (updated) states.set(account.storeId, updated);
    results.set(account.storeId, mergeResult(results.get(account.storeId)!, result));
  }
}

export async function runMinimoSync(input: {
  db: D1Database; env: SyncEnvironment; fetchImpl?: typeof fetch; pace?: MinimoRequestPacer; now?: () => number;
}): Promise<{ mode: "off" | "preview" | "apply"; stores: MinimoStoreResult[] }> {
  const config = parseMinimoConfig(input.env);
  if (config.mode === "off") return { mode: "off", stores: [] };
  const now = input.now ?? Date.now;
  const pace = input.pace ?? createMinimoRequestPacer();
  const deadline = now() + RUN_MS;
  const signal = AbortSignal.timeout(RUN_MS);
  // ponytail: one bounded run lease for four salons; partition only if that scale changes.
  const sweepLease = await claimStoreLease(input.db, "runner", [], now(), RUN_MS + 30_000);
  if (!sweepLease) return { mode: config.mode, stores: config.accounts.map((account) => ({ ...emptyResult(account.storeId), error: "leased" })) };
  try {
    const rows = await input.db.prepare("SELECT * FROM minimo_sync_state").all<SyncState>();
    const states = new Map(rows.results.map((state) => [state.store_id, state]));
    const results = new Map(config.accounts.map(account => [account.storeId, emptyResult(account.storeId)]));
    const stop = { reason: null as string | null };
    for (const phase of ["inbound", "outbound"] as const) {
      await runPhase({ ...input, pace, phase, mode: config.mode, sessionKey: config.sessionKey, now,
        deadline, signal, accounts: config.accounts, states, results, stop });
    }
    const stores = [...results.values()].map(result => {
      const state = states.get(result.storeId);
      const error = result.error ?? state?.inbound_error ?? state?.inbound_sweep_error ?? state?.last_error;
      return { ...result, error: error ?? undefined,
        outcome: result.outcome === "complete" && error ? "attention" as const : result.outcome };
    });
    return { mode: config.mode, stores };
  } finally {
    await releaseStoreLease(input.db, sweepLease, now());
  }
}
