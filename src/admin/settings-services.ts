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
  isAdminAllowedForStoreSettings,
  recoverFromCreateBatchFailure,
  sha256Hex,
  startedIdempotencyStatement,
  storeExists,
  succeededIdempotencyStatement,
  trimAndCap,
  type IdempotencyRow
} from "./settings-common";
import { SLOT_LOCK_INTERVAL_MINUTES } from "../reservations/slot-times";

// Tier C.3 4b — first slice of the settings editor stack. PR #63 shipped
// the read-only services display in the settings tab; this module adds
// the write side: services CRUD with admin role gate + audit_logs +
// idempotency_keys(scope='admin_action') for POST per SPEC.md.
//
// Soft-delete: the existing services.active CHECK (0,1) doubles as the
// tombstone bit. The has_future_reservations guard is enforced at both
// SELECT (fast path) AND UPDATE (NOT EXISTS subquery, race-safe). The
// audit_logs INSERT uses a `CASE WHEN changes()=1 THEN 'staff' ELSE …`
// anchor so a 0-row UPDATE aborts the batch on actor_type CHECK
// violation, forcing the caller into the error re-detection branch.
//
// PUT update is also write-time guarded against the active 1→0 path —
// otherwise an operator could deactivate (soft-delete) a service that
// still has future bookings by routing through the update endpoint and
// bypassing the DELETE guard.
//
// FK guard: services.id is referenced from reservations(service_id) with
// ON DELETE RESTRICT — hard delete is impossible while any reservation
// rows still point at the service.

export type AdminServiceCreateRequest = {
  storeId: string;
  name: string;
  priceLabel: string | null;
  priceAmount?: number | null;
  comboPriceAmount?: number | null;
  comboWithPrefix?: string | null;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  active: boolean;
  mensMenu?: boolean;
  idempotencyKey: string;
};

export type AdminServiceUpdateRequest = {
  storeId: string;
  name: string;
  priceLabel?: string | null;
  priceAmount?: number | null;
  comboPriceAmount?: number | null;
  comboWithPrefix?: string | null;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  active: boolean;
  mensMenu?: boolean;
};

export type AdminServiceDeleteError =
  | "forbidden"
  | "invalid_request"
  | "not_found"
  | "missing_database"
  | "has_future_reservations"
  | "write_failed";

export type AdminServiceCreateError =
  | "forbidden"
  | "invalid_request"
  | "not_found"
  | "missing_database"
  | "store_not_found"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "write_failed";

export type AdminServiceUpdateError =
  | "forbidden"
  | "invalid_request"
  | "not_found"
  | "missing_database"
  | "store_not_found"
  | "immutable_store"
  | "has_future_reservations"
  | "write_failed";

export type AdminServiceCreateResult =
  | { ok: true; serviceId: string; replayed: boolean }
  | { ok: false; error: AdminServiceCreateError };

export type AdminServiceUpdateResult =
  | { ok: true; serviceId: string }
  | { ok: false; error: AdminServiceUpdateError };

export type AdminServiceDeleteResult =
  | { ok: true; serviceId: string }
  | { ok: false; error: AdminServiceDeleteError };

const MIN_DURATION = 1;
const MAX_DURATION = 24 * 60; // 1 day
const MAX_PRICE_LABEL_LENGTH = 80;
const MAX_PRICE_AMOUNT = 1_000_000;
const MAX_COMBO_PREFIX_LENGTH = 40;
const INVALID_PRICE_LABEL = Symbol("invalid_price_label");
const INVALID_PRICE_AMOUNT = Symbol("invalid_price_amount");
// Booking flows (public-submit / public-options / admin reservation-create
// + reschedule) all lock slots in 5-minute increments and refuse to schedule
// a service whose duration is not a multiple. Persisting a non-multiple here
// would create a service the booking pages immediately hide as unavailable.
// buffer_before_minutes / buffer_after_minutes are persisted on the schema
// but no booking path actually reads them when computing slot locks. Until
// the booking layer enforces them, the write API refuses non-zero values
// (operators would otherwise believe they had configured cleanup buffers
// while customers could still book back-to-back). Lift the cap when the
// availability / submit flow starts honouring the column.
const MAX_BUFFER = 0;

const parsePositiveInt = (value: unknown, min: number, max: number): number | null => {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < min || value > max) return null;
  return value;
};

const parseDurationMinutes = (value: unknown): number | null => {
  const integer = parsePositiveInt(value, MIN_DURATION, MAX_DURATION);
  if (integer === null) return null;
  // Booking flows lock slots in 5-minute increments — durations that are
  // not a multiple would be hidden from the customer/admin booking pages
  // even though the row exists. Reject at the write API so the services
  // list and the booking flow never disagree.
  if (integer % SLOT_LOCK_INTERVAL_MINUTES !== 0) return null;
  return integer;
};

const parseNonNegativeInt = (value: unknown, max: number): number | null => {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < 0 || value > max) return null;
  return value;
};

const parsePriceLabel = (
  value: unknown
): string | null | undefined | typeof INVALID_PRICE_LABEL => {
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") return INVALID_PRICE_LABEL;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_PRICE_LABEL_LENGTH) return INVALID_PRICE_LABEL;
  return trimmed;
};

const parsePriceAmount = (
  value: unknown
): number | null | undefined | typeof INVALID_PRICE_AMOUNT => {
  if (value === undefined || value === null) return value;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_PRICE_AMOUNT) {
    return INVALID_PRICE_AMOUNT;
  }
  return value;
};

const parseComboWithPrefix = (
  value: unknown
): string | null | undefined | typeof INVALID_PRICE_AMOUNT => {
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") return INVALID_PRICE_AMOUNT;
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_COMBO_PREFIX_LENGTH || trimmed.includes("｜")) {
    return INVALID_PRICE_AMOUNT;
  }
  return trimmed;
};

const isValidPriceTuple = (
  priceAmount: number | null,
  comboPriceAmount: number | null,
  comboWithPrefix: string | null
): boolean =>
  (comboPriceAmount === null) === (comboWithPrefix === null) &&
  (comboPriceAmount === null || priceAmount !== null);

type CommonMutationFields = Omit<AdminServiceUpdateRequest, "active"> & {
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
  const durationMinutes = parseDurationMinutes(raw.durationMinutes);
  if (durationMinutes === null) return null;
  // MAX_BUFFER is currently 0 — nonzero values fall outside the allowed
  // range and parseNonNegativeInt returns null, surfacing as invalid_request.
  // When present, buffer values must be non-negative integers; non-integer or
  // negative values (e.g. -1, 2.5, "10") are rejected before the ?? 0 default
  // so malformed input does not silently coerce to the zero-buffer default.
  if (raw.bufferBeforeMinutes !== undefined && raw.bufferBeforeMinutes !== null) {
    if (typeof raw.bufferBeforeMinutes !== "number" || !Number.isInteger(raw.bufferBeforeMinutes) || raw.bufferBeforeMinutes < 0) {
      return null;
    }
  }
  if (raw.bufferAfterMinutes !== undefined && raw.bufferAfterMinutes !== null) {
    if (typeof raw.bufferAfterMinutes !== "number" || !Number.isInteger(raw.bufferAfterMinutes) || raw.bufferAfterMinutes < 0) {
      return null;
    }
  }
  const bufferBeforeMinutes = parseNonNegativeInt(raw.bufferBeforeMinutes ?? 0, MAX_BUFFER);
  if (bufferBeforeMinutes === null) return null;
  const bufferAfterMinutes = parseNonNegativeInt(raw.bufferAfterMinutes ?? 0, MAX_BUFFER);
  if (bufferAfterMinutes === null) return null;
  const active = typeof raw.active === "boolean" ? raw.active : null;
  return {
    storeId,
    name,
    durationMinutes,
    bufferBeforeMinutes,
    bufferAfterMinutes,
    active
  };
};

export const parseAdminServiceCreateRequest = (
  body: unknown
): AdminServiceCreateRequest | null => {
  const common = parseCommonMutationFields(body);
  if (!common) return null;
  const raw = body as Record<string, unknown>;
  const idempotencyKey = trimAndCap(raw.idempotencyKey, MAX_IDEMPOTENCY_KEY_LENGTH);
  if (!idempotencyKey) return null;
  const priceLabel = parsePriceLabel(raw.priceLabel);
  if (priceLabel === INVALID_PRICE_LABEL) return null;
  const priceAmount = parsePriceAmount(raw.priceAmount);
  const comboPriceAmount = parsePriceAmount(raw.comboPriceAmount);
  const comboWithPrefix = parseComboWithPrefix(raw.comboWithPrefix);
  if (
    priceAmount === INVALID_PRICE_AMOUNT ||
    comboPriceAmount === INVALID_PRICE_AMOUNT ||
    comboWithPrefix === INVALID_PRICE_AMOUNT
  ) return null;
  const normalizedPriceAmount = priceAmount ?? null;
  const normalizedComboPriceAmount = comboPriceAmount ?? null;
  const normalizedComboWithPrefix = comboWithPrefix ?? null;
  if (!isValidPriceTuple(normalizedPriceAmount, normalizedComboPriceAmount, normalizedComboWithPrefix)) return null;
  // Reject malformed `active` values: if the field is present it MUST be a
  // boolean. Strings like "true" or numbers like 1 are not coerced — they
  // indicate a client-side serialization bug that should surface immediately.
  // When the field is absent (`active` parsed as null by parseCommonMutationFields),
  // default to true — the public services list would not benefit from a
  // newly-created service that is invisible by default. Update keeps the
  // field required to avoid unintended reactivation through partial PUT bodies.
  if ("active" in raw && typeof raw.active !== "boolean") return null;
  if ("mensMenu" in raw && typeof raw.mensMenu !== "boolean") return null;
  const active = common.active ?? true;
  return {
    ...common,
    active,
    idempotencyKey,
    priceLabel: priceLabel ?? null,
    priceAmount: normalizedPriceAmount,
    comboPriceAmount: normalizedComboPriceAmount,
    comboWithPrefix: normalizedComboWithPrefix,
    mensMenu: raw.mensMenu === true
  };
};

export const parseAdminServiceUpdateRequest = (
  body: unknown
): AdminServiceUpdateRequest | null => {
  const common = parseCommonMutationFields(body);
  if (common?.active == null) return null;
  const raw = body as Record<string, unknown>;
  const priceLabel = parsePriceLabel(raw.priceLabel);
  if (priceLabel === INVALID_PRICE_LABEL) return null;
  const priceAmount = parsePriceAmount(raw.priceAmount);
  const comboPriceAmount = parsePriceAmount(raw.comboPriceAmount);
  const comboWithPrefix = parseComboWithPrefix(raw.comboWithPrefix);
  if (
    priceAmount === INVALID_PRICE_AMOUNT ||
    comboPriceAmount === INVALID_PRICE_AMOUNT ||
    comboWithPrefix === INVALID_PRICE_AMOUNT
  ) return null;
  const request: AdminServiceUpdateRequest = { ...common, active: common.active };
  if (priceLabel !== undefined) request.priceLabel = priceLabel;
  if (priceAmount !== undefined) request.priceAmount = priceAmount;
  if (comboPriceAmount !== undefined) request.comboPriceAmount = comboPriceAmount;
  if (comboWithPrefix !== undefined) request.comboWithPrefix = comboWithPrefix;
  if ("mensMenu" in raw) {
    if (typeof raw.mensMenu !== "boolean") return null;
    request.mensMenu = raw.mensMenu;
  }
  return request;
};

const createServiceRequestHash = async (input: {
  storeId: string;
  name: string;
  priceLabel: string | null;
  priceAmount?: number | null;
  comboPriceAmount?: number | null;
  comboWithPrefix?: string | null;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  active: boolean;
  mensMenu?: boolean;
}) => {
  const payload: Record<string, unknown> = {
    storeId: input.storeId,
    name: input.name,
    durationMinutes: input.durationMinutes,
    bufferBeforeMinutes: input.bufferBeforeMinutes,
    bufferAfterMinutes: input.bufferAfterMinutes,
    active: input.active
  };
  // For backward compatibility, omit null priceLabel so the hash matches the pre-priceLabel format.
  if (input.priceLabel !== null) payload.priceLabel = input.priceLabel;
  if (input.priceAmount != null) payload.priceAmount = input.priceAmount;
  if (input.comboPriceAmount != null) payload.comboPriceAmount = input.comboPriceAmount;
  if (input.comboWithPrefix != null) payload.comboWithPrefix = input.comboWithPrefix;
  if (input.mensMenu) payload.mensMenu = true;
  return sha256Hex(JSON.stringify(payload));
};

const resolveCreateIdempotency = (
  idempotency: IdempotencyRow | null,
  requestHash: string
): AdminServiceCreateResult | undefined => {
  if (!idempotency) return undefined;
  if (idempotency.request_hash !== requestHash) {
    return { ok: false, error: "idempotency_conflict" };
  }
  if (idempotency.status === "succeeded" && idempotency.target_id) {
    return { ok: true, serviceId: idempotency.target_id, replayed: true };
  }
  return { ok: false, error: "idempotency_in_progress" };
};

type ServiceRow = {
  id: string;
  store_id: string;
  name: string;
  price_label: string | null;
  price_amount: number | null;
  combo_price_amount: number | null;
  combo_with_prefix: string | null;
  duration_minutes: number;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  active: number;
  mens_menu: number;
};

const fetchService = async (db: D1Database, id: string): Promise<ServiceRow | null> =>
  db
    .prepare(
      `SELECT id, store_id, name, price_label, price_amount, combo_price_amount, combo_with_prefix,
              duration_minutes, buffer_before_minutes, buffer_after_minutes, active, mens_menu
       FROM services WHERE id = ?`
    )
    .bind(id)
    .first<ServiceRow>();

const countFutureReservationsForService = async (
  db: D1Database,
  serviceId: string,
  nowIso: string
): Promise<number> => {
  // Multi-menu reservations only store the first service on reservations.service_id;
  // every other selected service lives in the reservation_services junction table.
  // Both paths must be checked so the second-or-later menu of a future booking
  // still blocks the deactivation. Matches the (service_id OR EXISTS junction)
  // pattern used by src/admin/operations.ts and src/admin/reservations.ts.
  const row = await db
    .prepare(
      `SELECT COUNT(DISTINCT r.id) AS count FROM reservations r
       LEFT JOIN reservation_services rs ON rs.reservation_id = r.id
       WHERE (r.service_id = ? OR rs.service_id = ?)
         AND r.status IN ('pending_approval', 'confirmed')
         AND r.start_at > ?`
    )
    .bind(serviceId, serviceId, nowIso)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
};

async function handleServiceUpdateBatchError(
  db: D1Database,
  error: unknown,
  serviceId: string,
  isDeactivating: boolean
): Promise<AdminServiceUpdateResult> {
  if (isActorTypeBatchError(error)) {
    const fresh = await fetchService(db, serviceId);
    if (!fresh) return { ok: false, error: "not_found" };
    if (isDeactivating) {
      return { ok: false, error: "has_future_reservations" };
    }
    return { ok: false, error: "write_failed" };
  }
  // Any other D1 batch failure (FK / CHECK / connection) normalizes to
  // write_failed per the API contract — keep the unhandled exception out of
  // the route layer so the operator sees a documented error code, not 500.
  console.error("updateAdminService batch failed", {
    serviceId,
    error: error instanceof Error ? error.message : String(error)
  });
  return { ok: false, error: "write_failed" };
}

async function checkServiceDeactivation(
  db: D1Database,
  serviceId: string,
  nowIso: string,
  isDeactivating: boolean
): Promise<boolean> {
  if (!isDeactivating) return false;
  const future = await countFutureReservationsForService(db, serviceId, nowIso);
  return future > 0;
}

export const createAdminService = async (input: {
  db: D1Database;
  admin: AdminUser;
  serviceId?: string;
  request: AdminServiceCreateRequest;
  now?: () => number;
}): Promise<AdminServiceCreateResult> => {
  if (!isAdminAllowedForStoreSettings(input.admin, input.request.storeId)) {
    return { ok: false, error: "forbidden" };
  }
  const requestHash = await createServiceRequestHash(input.request);
  // Derive the idempotency clock before the TTL read so the read, the expires_at write, and the catch re-read share one injected now (B8).
  const { nowIso, expiresAt, idempotencyId } = buildCreateContext(input.now);
  const existingIdempotency = await fetchAdminActionIdempotency(input.db, input.request.idempotencyKey, nowIso);
  const idempotencyResult = resolveCreateIdempotency(existingIdempotency, requestHash);
  if (idempotencyResult) return idempotencyResult;

  if (!(await storeExists(input.db, input.request.storeId))) {
    return { ok: false, error: "store_not_found" };
  }
  const id = input.serviceId ?? crypto.randomUUID();
  const activeInt = input.request.active ? 1 : 0;
  const mensMenuInt = input.request.mensMenu ? 1 : 0;
  const priceAmount = input.request.priceAmount ?? null;
  const comboPriceAmount = input.request.comboPriceAmount ?? null;
  const comboWithPrefix = input.request.comboWithPrefix ?? null;

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
          `INSERT INTO services (
             id, store_id, name, price_label, price_amount, combo_price_amount, combo_with_prefix,
             duration_minutes, buffer_before_minutes, buffer_after_minutes, active, mens_menu, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          id,
          input.request.storeId,
          input.request.name,
          input.request.priceLabel,
          priceAmount,
          comboPriceAmount,
          comboWithPrefix,
          input.request.durationMinutes,
          input.request.bufferBeforeMinutes,
          input.request.bufferAfterMinutes,
          activeInt,
          mensMenuInt,
          nowIso,
          nowIso
        ),
      input.db
        .prepare(
          `INSERT INTO audit_logs (
             id, actor_type, actor_id, action, target_type, target_id, metadata_json
           ) VALUES (?, 'staff', ?, 'settings.services.create', 'service', ?, ?)`
        )
        .bind(
          crypto.randomUUID(),
          input.admin.id,
          id,
          JSON.stringify({
            serviceId: id,
            storeId: input.request.storeId,
            name: input.request.name,
            priceLabel: input.request.priceLabel,
            priceAmount,
            comboPriceAmount,
            comboWithPrefix,
            durationMinutes: input.request.durationMinutes,
            bufferBeforeMinutes: input.request.bufferBeforeMinutes,
            bufferAfterMinutes: input.request.bufferAfterMinutes,
            active: input.request.active,
            mensMenu: mensMenuInt === 1,
            adminRole: input.admin.role
          })
        ),
      succeededIdempotencyStatement({
        db: input.db,
        idempotencyId,
        targetType: "service",
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
      errorLabel: "createAdminService",
      nowIso,
      resolveReplay: (row) => resolveCreateIdempotency(row, requestHash)
    });
  }

  return { ok: true, serviceId: id, replayed: false };
};

/**
 * PATCH semantics for the update request: a field the client omitted keeps the
 * stored value. `??` would be wrong here — `null` is a real value on this API
 * (it clears priceLabel / the combo discount), so only `undefined` means absent.
 */
const keepWhenAbsent = <T>(next: T | undefined, current: T): T =>
  next === undefined ? current : next;

export const updateAdminService = async (input: {
  db: D1Database;
  admin: AdminUser;
  serviceId: string;
  request: AdminServiceUpdateRequest;
  now?: () => number;
}): Promise<AdminServiceUpdateResult> => {
  // Fetch current entity first to check store scope for staff
  const current = await fetchService(input.db, input.serviceId);
  if (!current) {
    return { ok: false, error: "not_found" };
  }
  if (!isAdminAllowedForStoreSettings(input.admin, current.store_id)) {
    return { ok: false, error: "forbidden" };
  }
  if (!(await storeExists(input.db, input.request.storeId))) {
    return { ok: false, error: "store_not_found" };
  }
  const storeGuard = guardImmutableStore(current.store_id, input.request.storeId);
  if (storeGuard) return storeGuard;
  const nowIso = new Date((input.now ?? Date.now)()).toISOString();
  const activeInt = input.request.active ? 1 : 0;
  const nextMensMenu = keepWhenAbsent(input.request.mensMenu, current.mens_menu === 1);
  const nextPriceLabel = keepWhenAbsent(input.request.priceLabel, current.price_label);
  const nextPriceAmount = keepWhenAbsent(input.request.priceAmount, current.price_amount);
  const nextComboPriceAmount = keepWhenAbsent(input.request.comboPriceAmount, current.combo_price_amount);
  const nextComboWithPrefix = keepWhenAbsent(input.request.comboWithPrefix, current.combo_with_prefix);
  if (!isValidPriceTuple(nextPriceAmount, nextComboPriceAmount, nextComboWithPrefix)) {
    return { ok: false, error: "invalid_request" };
  }
  // Active going from 1→0 is semantically the same as soft-delete — block it
  // when future bookings still reference the service. Pre-check is best-effort
  // (fast common-case error); the inline NOT EXISTS subquery in the UPDATE
  // makes the invariant hold even under a concurrent reservation create.
  const isDeactivating = current.active === 1 && !input.request.active;
  if (await checkServiceDeactivation(input.db, input.serviceId, nowIso, isDeactivating)) {
    return { ok: false, error: "has_future_reservations" };
  }

  // Guard only applies on the deactivation transition (active 1→0). Edits
  // that keep the service active, or that touch an already-inactive service,
  // pass through unconditionally — otherwise dirty data (an inactive service
  // that still has stray future bookings) would block routine edits. The
  // audit_logs INSERT anchors on `CASE WHEN changes()=1 THEN 'staff' ELSE
  // 'soft_delete_conflict' END` so a 0-row UPDATE (race or unknown id)
  // violates the audit_logs CHECK constraint and aborts the batch.
  const guardActive = isDeactivating ? 1 : 0;
  try {
    await input.db.batch([
      adminWriteGuard(input.db, input.admin),
      input.db
        .prepare(
          `UPDATE services
           SET store_id = ?, name = ?, price_label = ?, price_amount = ?, combo_price_amount = ?,
               combo_with_prefix = ?, duration_minutes = ?, buffer_before_minutes = ?,
               buffer_after_minutes = ?, active = ?, mens_menu = ?, updated_at = ?
           WHERE id = ?
             AND (? = 0 OR NOT EXISTS (
               SELECT 1 FROM reservations r
               LEFT JOIN reservation_services rs ON rs.reservation_id = r.id
               WHERE (r.service_id = ? OR rs.service_id = ?)
                 AND r.status IN ('pending_approval', 'confirmed')
                 AND r.start_at > ?
             ))`
        )
        .bind(
          input.request.storeId,
          input.request.name,
          nextPriceLabel,
          nextPriceAmount,
          nextComboPriceAmount,
          nextComboWithPrefix,
          input.request.durationMinutes,
          input.request.bufferBeforeMinutes,
          input.request.bufferAfterMinutes,
          activeInt,
          nextMensMenu ? 1 : 0,
          nowIso,
          input.serviceId,
          guardActive,
          input.serviceId,
          input.serviceId,
          nowIso
        ),
      input.db
        .prepare(
          `INSERT INTO audit_logs (
             id, actor_type, actor_id, action, target_type, target_id, metadata_json
           ) VALUES (
             ?,
             CASE WHEN changes() = 1 THEN 'staff' ELSE 'soft_delete_conflict' END,
             ?, 'settings.services.update', 'service', ?, ?
           )`
        )
        .bind(
          crypto.randomUUID(),
          input.admin.id,
          input.serviceId,
          JSON.stringify({
            serviceId: input.serviceId,
            before: {
              storeId: current.store_id,
              name: current.name,
              priceLabel: current.price_label,
              priceAmount: current.price_amount,
              comboPriceAmount: current.combo_price_amount,
              comboWithPrefix: current.combo_with_prefix,
              durationMinutes: current.duration_minutes,
              bufferBeforeMinutes: current.buffer_before_minutes,
              bufferAfterMinutes: current.buffer_after_minutes,
              active: current.active === 1,
              mensMenu: current.mens_menu === 1
            },
            after: {
              storeId: input.request.storeId,
              name: input.request.name,
              priceLabel: nextPriceLabel,
              priceAmount: nextPriceAmount,
              comboPriceAmount: nextComboPriceAmount,
              comboWithPrefix: nextComboWithPrefix,
              durationMinutes: input.request.durationMinutes,
              bufferBeforeMinutes: input.request.bufferBeforeMinutes,
              bufferAfterMinutes: input.request.bufferAfterMinutes,
              active: input.request.active,
              mensMenu: nextMensMenu
            },
            adminRole: input.admin.role
          })
        )
    ]);
  } catch (error) {
    if (await adminWriteWasRevoked(input.db, input.admin, error)) {
      return { ok: false, error: "forbidden" };
    }
    return handleServiceUpdateBatchError(input.db, error, input.serviceId, isDeactivating);
  }

  return { ok: true, serviceId: input.serviceId };
};

export const softDeleteAdminService = async (input: {
  db: D1Database;
  admin: AdminUser;
  serviceId: string;
  now?: () => number;
}): Promise<AdminServiceDeleteResult> => {
  const current = await fetchService(input.db, input.serviceId);
  if (!current) {
    return { ok: false, error: "not_found" };
  }
  if (!isAdminAllowedForStoreSettings(input.admin, current.store_id)) {
    return { ok: false, error: "forbidden" };
  }
  const nowIso = new Date((input.now ?? Date.now)()).toISOString();
  const futureCount = await countFutureReservationsForService(input.db, input.serviceId, nowIso);
  if (futureCount > 0) {
    return { ok: false, error: "has_future_reservations" };
  }

  // Race-safe write: UPDATE only succeeds when no future reservation has been
  // created in the SELECT→UPDATE gap. Audit INSERT anchors on changes()=1 via
  // the actor_type CASE so a 0-row UPDATE aborts the batch on CHECK violation
  // and forces the post-failure re-detect branch.
  try {
    await input.db.batch([
      adminWriteGuard(input.db, input.admin),
      input.db
        .prepare(
          `UPDATE services
           SET active = 0, updated_at = ?
           WHERE id = ?
             AND NOT EXISTS (
               SELECT 1 FROM reservations r
               LEFT JOIN reservation_services rs ON rs.reservation_id = r.id
               WHERE (r.service_id = ? OR rs.service_id = ?)
                 AND r.status IN ('pending_approval', 'confirmed')
                 AND r.start_at > ?
             )`
        )
        .bind(nowIso, input.serviceId, input.serviceId, input.serviceId, nowIso),
      input.db
        .prepare(
          `INSERT INTO audit_logs (
             id, actor_type, actor_id, action, target_type, target_id, metadata_json
           ) VALUES (
             ?,
             CASE WHEN changes() = 1 THEN 'staff' ELSE 'soft_delete_conflict' END,
             ?, 'settings.services.delete', 'service', ?, ?
           )`
        )
        .bind(
          crypto.randomUUID(),
          input.admin.id,
          input.serviceId,
          JSON.stringify({
            serviceId: input.serviceId,
            before: {
              storeId: current.store_id,
              name: current.name,
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
      const fresh = await fetchService(input.db, input.serviceId);
      if (!fresh) return { ok: false, error: "not_found" };
      return { ok: false, error: "has_future_reservations" };
    }
    console.error("softDeleteAdminService batch failed", {
      serviceId: input.serviceId,
      error: error instanceof Error ? error.message : String(error)
    });
    return { ok: false, error: "write_failed" };
  }

  return { ok: true, serviceId: input.serviceId };
};
