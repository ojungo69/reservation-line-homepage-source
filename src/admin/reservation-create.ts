import type { AdminUser } from "./access";
import { isNonEmptyString, toIso, addMinutes, parseStartAt } from "./reservation-time-utils";
import { IDEMPOTENCY_TTL_MS, isActorTypeBatchError, sha256Hex } from "./settings-common";
import { adminWriteGuard, adminWriteWasRevoked } from "./write-authorization";
import { normalizePhone } from "./shared";
import { OWN_STORE_MEMBERSHIP_ARMS, staffCanAccessCustomer } from "./customers";
import { ensureBusinessTime } from "../reservations/business-hours";
import { captureBatchWriteFailure } from "../sentry-helpers";
import {
  buildBookingContext,
  generateSlotTimesForDuration,
  normalizeServiceIds,
  SLOT_LOCK_INTERVAL_MINUTES
} from "../reservations/slot-times";
import { classifyReservationWriteError } from "../reservations/write-error";
import { CUSTOMER_TIME_LOCK_PHONE_HASH_SQL } from "../reservations/transitions";

export type AdminCreateReservationRequest = {
  idempotencyKey: string;
  source: "phone_admin" | "admin";
  storeId: string;
  serviceIds: string[];
  resourceId: string;
  startAt: string;
  // 既存客モード: customerId 指定（既存 customers 行を再利用、電話任意）。
  customerId?: string;
  // 新規客モード: customer 手入力（従来。minimo/店頭の新規客用）。
  customer?: {
    displayName: string;
    displayNameKana?: string;
    phone: string;
  };
  // phone は廃止前の成功済みリクエストの再送だけで受理する。
  origin?: ReservationOrigin | "phone";
};

export type ReservationOrigin = "minimo" | "walk_in" | "other";

const RESERVATION_ORIGINS: ReadonlySet<ReservationOrigin> = new Set([
  "minimo",
  "walk_in",
  "other",
]);

const isReservationOrigin = (value: unknown): value is ReservationOrigin =>
  typeof value === "string" && RESERVATION_ORIGINS.has(value as ReservationOrigin);

type AdminCreateReservationSuccess = {
  ok: true;
  reservationId: string;
  status: "confirmed";
  source: "phone_admin" | "admin";
  storeId: string;
  startAt: string;
  endAt: string;
  replayed: boolean;
};

type AdminCreateReservationFailure = {
  ok: false;
  reason:
    | "invalid_request"
    | "idempotency_conflict"
    | "idempotency_in_progress"
    | "store_not_found"
    | "service_not_available"
    | "resource_not_available"
    | "invalid_time"
    | "outside_business_hours"
    | "store_closed"
    | "slot_unavailable"
    | "customer_time_conflict"
    | "customer_blocked"
    | "customer_not_found"
    | "forbidden"
    | "write_failed";
};

export type AdminCreateReservationResult = AdminCreateReservationSuccess | AdminCreateReservationFailure;

type BookingContext = {
  storeId: string;
  timezone: string;
  serviceId: string;
  serviceIds: string[];
  services: Array<{
    id: string;
    name: string;
    durationMinutes: number;
  }>;
  durationMinutes: number;
  resourceId: string;
  resourceStoreId: string;
};

type CustomerRow = {
  id: string;
  block_status: "active" | "blocked";
  phone_normalized: string | null;
  phone_hash: string | null;
  archived_at: string | null;
};

type IdempotencyRow = {
  status: "started" | "succeeded" | "failed";
  target_id: string | null;
  request_hash: string | null;
};

type ReservationRow = {
  id: string;
  source: "phone_admin" | "admin";
  store_id: string;
  status: "confirmed";
  start_at: string;
  end_at: string;
};

// Existing-customer (customerId) booking authorization: owner/system_admin may
// book any customer; staff may book ONLY customers visible in their own-store
// scope (same predicate as the customer directory / detail: a reservation or a
// valid visit at the staff's store, canonical customers only). Staff cannot see
// real phone numbers (masked PII), so the customerId path is their only way to
// rebook an existing customer. Fail closed without a store binding, mirroring
// assertStaffCustomerStoreScope's 403 semantics. customer_id is a UUID, so the
// 403 existence oracle is not enumerable. The booking batch rechecks the current
// customer's canonical state and membership BEFORE inserting the new reservation,
// so that reservation cannot manufacture the membership that authorized itself.
const mayBookCustomerId = async (
  db: D1Database,
  admin: AdminUser,
  customerId: string | undefined
): Promise<boolean> => {
  if (!customerId || admin.role !== "staff") {
    return true;
  }
  if (!admin.store_id) {
    return false;
  }
  return staffCanAccessCustomer(db, customerId, admin.store_id);
};

const isValidRequestShape = (request: AdminCreateReservationRequest) => {
  const baseValid =
    isNonEmptyString(request.idempotencyKey, 256) &&
    (request.source === "phone_admin" || request.source === "admin") &&
    isNonEmptyString(request.storeId, 64) &&
    request.serviceIds.length > 0 &&
    isNonEmptyString(request.resourceId, 128) &&
    isNonEmptyString(request.startAt, 64) &&
    (request.origin === undefined || request.origin === "phone" || isReservationOrigin(request.origin));
  if (!baseValid) {
    return false;
  }
  // Exactly one of customerId / customer must be present.
  const hasCustomerId = isNonEmptyString(request.customerId, 64);
  const hasCustomer = request.customer !== undefined;
  if (hasCustomerId === hasCustomer) {
    return false;
  }
  if (hasCustomer) {
    const customer = request.customer as NonNullable<AdminCreateReservationRequest["customer"]>;
    return (
      isNonEmptyString(customer.displayName, 120) &&
      (customer.displayNameKana === undefined || isNonEmptyString(customer.displayNameKana, 120)) &&
      isNonEmptyString(customer.phone, 32)
    );
  }
  return true;
};

const fetchBookingContext = async (
  db: D1Database,
  storeId: string,
  serviceIds: string[],
  resourceId: string
): Promise<BookingContext | AdminCreateReservationFailure> => {
  const context = await db
    .prepare(
      `
        SELECT
          stores.id AS storeId,
          stores.timezone AS timezone,
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
    .first<Omit<BookingContext, "serviceId" | "serviceIds" | "services" | "durationMinutes">>();

  const built = await buildBookingContext(db, storeId, serviceIds, context);
  return built.ok ? built.context : built;
};

const createRequestHash = async (
  request: AdminCreateReservationRequest,
  normalizedPhone: string | null,
  normalizedStartAt: string
) => {
  return sha256Hex(
    JSON.stringify({
      source: request.source,
      storeId: request.storeId,
      ...(request.serviceIds.length === 1
        ? { serviceId: request.serviceIds[0] }
        : { serviceIds: request.serviceIds }),
      resourceId: request.resourceId,
      startAt: normalizedStartAt,
      origin: request.origin ?? null,
      customerId: request.customerId ?? null,
      customer: request.customer
        ? {
            displayName: request.customer.displayName.trim(),
            displayNameKana: request.customer.displayNameKana?.trim() ?? null,
            phone: normalizedPhone,
          }
        : null,
    })
  );
};

const getCustomerByPhoneHash = async (db: D1Database, phoneHash: string) => {
  // Skip merged tombstones — they share phone_hash with the canonical
  // target customer but carry block_status='blocked' (the Tier C.2 merge
  // marker on the source row). Without this filter, the admin create
  // path would prefer the tombstone over the canonical row and surface
  // a phantom block on a valid phone number.
  //
  // Ordering priority (phone_hash is a NON-unique index → multiple rows can
  // share a number):
  //   1. blocked first  — block enforcement must win, even when archived
  //      (blocks persist through archiving; the consumer keeps blocked rows).
  //   2. active before archived — an archived row must not shadow a valid
  //      active customer with the same phone, which would null out the match
  //      and create a duplicate instead of reusing the active row. (devin/codex)
  //   3. oldest first   — stable canonical pick among ties.
  return db
    .prepare(
      `
        SELECT id, block_status, phone_normalized, phone_hash, archived_at
        FROM customers
        WHERE phone_hash = ?
          AND merged_into_id IS NULL
        ORDER BY
          CASE WHEN block_status = 'blocked' THEN 0 ELSE 1 END,
          CASE WHEN archived_at IS NULL THEN 0 ELSE 1 END,
          created_at ASC
        LIMIT 1
      `
    )
    .bind(phoneHash)
    .first<CustomerRow>();
};

// Find a canonical customer sharing this phone_hash that the STAFF legitimately
// manages (own-store scope). Used so a staff new-customer booking reuses an
// existing OWN-STORE record (avoiding duplicate proliferation) but never a
// non-own-store customer — reusing a non-own-store row would fabricate own-store
// membership and expose that customer's PII via the store-scoped customer routes.
// Returns null when no own-store match exists (the caller then creates a fresh
// own-store row).
//
// The membership test itself is OWN_STORE_MEMBERSHIP_ARMS (customers.ts) — the
// same fragment staffCanAccessCustomer uses, so the two can no longer drift. Its
// created_store_id arm is what makes the headline flow work: a manually registered
// paper-chart customer has no reservation and no visit yet, so without it the very
// next phone booking for that person would silently create a SECOND row for the
// same number — and staff cannot merge (owner-only).
const findOwnStoreCustomerByPhoneHash = async (
  db: D1Database,
  phoneHash: string,
  storeId: string
): Promise<CustomerRow | null> => {
  const row = await db
    .prepare(
      `
        SELECT c.id, c.block_status, c.phone_normalized, c.phone_hash, c.archived_at
        FROM customers c
        WHERE c.phone_hash = ?
          AND c.merged_into_id IS NULL
          AND c.archived_at IS NULL
          AND ${OWN_STORE_MEMBERSHIP_ARMS}
        ORDER BY created_at ASC
        LIMIT 1
      `
    )
    .bind(phoneHash, storeId, storeId, storeId)
    .first<CustomerRow>();
  return row ?? null;
};

// Existing-customer mode: resolve a row by its id. Excludes merged tombstones so
// an operator can never book against a consolidated source row, and archived
// customers so a soft-deleted row can never be booked against either. The phone
// may be NULL (paper-chart customers) — locks then carry a NULL phone_hash.
const getCustomerById = async (db: D1Database, customerId: string) => {
  return db
    .prepare(
      `
        SELECT id, block_status, phone_normalized, phone_hash
        FROM customers
        WHERE id = ?
          AND merged_into_id IS NULL
          AND archived_at IS NULL
        LIMIT 1
      `
    )
    .bind(customerId)
    .first<CustomerRow>();
};

// Blocks are keyed on the PHONE NUMBER, not on the customers row: the public
// submit (getBlockedCustomerByPhoneHash) and the typed-phone admin path (blocked
// rows sort first in getCustomerByPhoneHash) both reject the whole phone_hash.
// Existing-customer mode resolves ONE row by id, so without this the second row
// for a number is bookable while the first one is blocked — and since specs/006
// staff can create exactly such a row from 顧客を追加 (no block check there by
// design: a second row is not itself a violation, booking it is).
//
// Archived rows are deliberately NOT filtered: a block survives archiving.
// Merged tombstones ARE filtered — they carry block_status='blocked' as the merge
// marker, not as a real block (same reasoning as public-submit.ts).
const isPhoneHashBlocked = async (db: D1Database, phoneHash: string): Promise<boolean> => {
  const row = await db
    .prepare(
      `
        SELECT 1 AS hit
        FROM customers
        WHERE phone_hash = ?
          AND block_status = 'blocked'
          AND merged_into_id IS NULL
        LIMIT 1
      `
    )
    .bind(phoneHash)
    .first<{ hit: number }>();
  return row != null;
};

const readReservationResult = async (
  db: D1Database,
  reservationId: string,
  replayed: boolean
): Promise<AdminCreateReservationResult> => {
  const row = await db
    .prepare(
      `
        SELECT id, source, store_id, status, start_at, end_at
        FROM reservations
        WHERE id = ?
        LIMIT 1
      `
    )
    .bind(reservationId)
    .first<ReservationRow>();

  if (row?.status !== "confirmed") {
    return {
      ok: false,
      reason: "write_failed"
    };
  }

  if (row.source !== "phone_admin" && row.source !== "admin") {
    return {
      ok: false,
      reason: "write_failed"
    };
  }

  return {
    ok: true,
    reservationId: row.id,
    status: "confirmed",
    source: row.source,
    storeId: row.store_id,
    startAt: row.start_at,
    endAt: row.end_at,
    replayed
  };
};

const mapBatchError = (error: unknown): AdminCreateReservationFailure => {
  const sharedReason = classifyReservationWriteError(error);
  if (sharedReason) {
    return {
      ok: false,
      reason: sharedReason
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("blocked_customer")) {
    return {
      ok: false,
      reason: "customer_blocked"
    };
  }
  // An idempotency_keys UNIQUE collision is handled by resolveCreateBatchFailure (a
  // TTL-aware re-resolve), not here: a concurrent in-flight request replays
  // cached/idempotency_in_progress, while a post-TTL expired row falls through to
  // this terminal write_failed (F-6.1). See [[idempotency-ttl-invariant]].
  return {
    ok: false,
    reason: "write_failed"
  };
};

const resolveAdminCreateIdempotency = async (
  db: D1Database,
  idempotencyKey: string,
  requestHash: string,
  nowIso: string
): Promise<AdminCreateReservationResult | undefined> => {
  // Filter on expires_at so a "started" row from a crashed request stops
  // blocking this idempotency_key once its TTL has elapsed, matching the audited
  // canonical resolver (settings-common.ts fetchAdminActionIdempotency,
  // docs/SECURITY-AUDIT-2026-05-27.md F-6.1). Bind the caller's nowIso (the same
  // clock that stamps expires_at on insert) so read and write stay deterministic
  // under time-travel tests; wrap both sides in datetime(...) because expires_at
  // is an ISO string whose `T` separator would lexically mis-order a bare `>`.
  const idempotency = await db
    .prepare(
      `
        SELECT status, target_id, request_hash
        FROM idempotency_keys
        WHERE scope = 'admin_action'
          AND idempotency_key = ?
          AND (expires_at IS NULL OR datetime(expires_at) > datetime(?))
        LIMIT 1
      `
    )
    .bind(idempotencyKey, nowIso)
    .first<IdempotencyRow>();

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
    return readReservationResult(db, idempotency.target_id, true);
  }
  return {
    ok: false,
    reason: "idempotency_in_progress"
  };
};

const resolveCreateBatchFailure = async (
  db: D1Database,
  idempotencyKey: string,
  requestHash: string,
  nowIso: string,
  error: unknown,
  admin: AdminUser,
  existingCustomerId?: string
): Promise<AdminCreateReservationResult> => {
  if (await adminWriteWasRevoked(db, admin, error)) {
    return { ok: false, reason: "forbidden" };
  }
  // An idempotency_keys UNIQUE collision at the batch INSERT means either a concurrent
  // in-flight request (valid TTL) or a post-TTL expired "started" row. Re-resolve with
  // the TTL filter so the former replays cached/idempotency_in_progress while the latter,
  // no longer in flight, falls through to mapBatchError's terminal write_failed (F-6.1,
  // matching reservations.ts). [[idempotency-ttl-invariant]]
  try {
    // Classification after the atomic CHECK rolled back all writes. An unrelated
    // error or an already-restored customer retains the existing conflict result.
    if (existingCustomerId && isActorTypeBatchError(error)) {
      if (!(await mayBookCustomerId(db, admin, existingCustomerId))) {
        return { ok: false, reason: "forbidden" };
      }
      if (!(await getCustomerById(db, existingCustomerId))) {
        return { ok: false, reason: "customer_not_found" };
      }
    }
    const concurrent = await resolveAdminCreateIdempotency(db, idempotencyKey, requestHash, nowIso);
    if (concurrent) {
      return concurrent;
    }
  } catch {
    // fall through to the structured batch-error mapping
  }
  return mapBatchError(error);
};

const buildAdminCreateReservationStatements = (input: {
  db: D1Database;
  admin: AdminUser;
  lineChannelId?: string;
  request: AdminCreateReservationRequest;
  context: BookingContext;
  existingCustomer: CustomerRow | null;
  normalizedPhone: string | null;
  phoneHash: string | null;
  customerId: string;
  reservationId: string;
  idempotencyId: string;
  requestHash: string;
  idempotencyExpiresAt: string;
  reservationOrigin: ReservationOrigin | null;
  nowIso: string;
  startAt: Date;
  endAtIso: string;
  slotTimes: string[];
}) => {
  const statements: D1PreparedStatement[] = [
    adminWriteGuard(input.db, input.admin),
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
          ) VALUES (?, 'admin_action', ?, 'started', ?, ?, ?)
        `
      )
      .bind(
        input.idempotencyId,
        input.request.idempotencyKey,
        input.requestHash,
        input.idempotencyExpiresAt,
        input.nowIso
      )
  ];

  if (input.existingCustomer) {
    // Reuse the audit actor_type CHECK to abort the transaction on a stale
    // customer scope, before this reservation could grant own-store membership.
    statements.push(input.db.prepare(`
      INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id)
      SELECT ?, 'reservation_customer_unavailable', ?, 'admin.reservation.customer.guard', 'customer', ?
      WHERE NOT EXISTS (
        SELECT 1 FROM customers c
        WHERE c.id = ? AND c.merged_into_id IS NULL AND c.archived_at IS NULL
          AND (? != 'staff' OR ${OWN_STORE_MEMBERSHIP_ARMS})
      )
    `).bind(crypto.randomUUID(), input.admin.id, input.customerId, input.customerId,
      input.admin.role, input.admin.store_id, input.admin.store_id, input.admin.store_id));
  }

  if (!input.existingCustomer) {
    statements.push(
      input.db
        .prepare(
          `
            INSERT INTO customers (
              id,
              display_name,
              display_name_kana,
              phone_normalized,
              phone_hash,
              block_status,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, 'active', ?)
          `
        )
        .bind(
          input.customerId,
          input.request.customer!.displayName.trim(),
          input.request.customer!.displayNameKana?.trim() ?? null,
          input.normalizedPhone,
          input.phoneHash,
          input.nowIso
        )
    );
  }

  statements.push(
    input.db
      .prepare(
        `
          INSERT INTO reservations (
            id,
            store_id,
            service_id,
            customer_id,
            line_identity_id,
            resource_id,
            source,
            status,
            start_at,
            end_at,
            duration_minutes,
            created_by,
            updated_by,
            idempotency_key,
            reservation_origin,
            google_sync_state,
            updated_at
          ) VALUES (?, ?, ?, ?, (
            SELECT MIN(li.id) FROM line_identities li
            WHERE li.customer_id = ? AND li.provider = 'line' AND li.channel_id = ?
            HAVING COUNT(*) = 1
          ), ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
        `
      )
      .bind(
        input.reservationId,
        input.context.storeId,
        input.context.serviceId,
        input.customerId,
        input.customerId,
        input.lineChannelId ?? null,
        input.context.resourceId,
        input.request.source,
        toIso(input.startAt),
        input.endAtIso,
        input.context.durationMinutes,
        input.admin.id,
        input.admin.id,
        input.request.idempotencyKey,
        input.reservationOrigin,
        input.nowIso
      )
  );

  for (const [index, service] of input.context.services.entries()) {
    statements.push(
      input.db
        .prepare(
          `
            INSERT INTO reservation_services (
              reservation_id,
              service_id,
              display_order,
              name_snapshot,
              duration_minutes
            ) VALUES (?, ?, ?, ?, ?)
          `
        )
        .bind(
          input.reservationId,
          service.id,
          index,
          service.name,
          service.durationMinutes
        )
    );
  }

  for (const slotAt of input.slotTimes) {
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
            ) VALUES (?, ?, ?, ?, 'reservation', ?, 'confirmed', NULL)
          `
        )
        .bind(slotLockId, input.context.storeId, input.context.resourceId, slotAt, input.reservationId),
      input.db
        .prepare(
          `
            INSERT INTO customer_time_locks (
              id,
              customer_id,
              slot_at,
              owner_type,
              owner_id,
              lock_status,
              expires_at,
              phone_hash
            ) VALUES (?, ?, ?, 'reservation', ?, 'confirmed', NULL, ${CUSTOMER_TIME_LOCK_PHONE_HASH_SQL})
          `
        )
        .bind(crypto.randomUUID(), input.customerId, slotAt, input.reservationId, input.reservationId),
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
            ) VALUES (?, ?, ?, ?, ?, ?, 'created', 'staff', ?, 'admin_reservation_create')
          `
        )
        .bind(
          crypto.randomUUID(),
          slotLockId,
          input.context.storeId,
          input.context.resourceId,
          slotAt,
          input.reservationId,
          input.admin.id
        )
    );
  }

  statements.push(
    // Resolve the recipient from the reservation written in this same batch.
    // No identity (including ambiguous links) means no customer notification.
    input.db.prepare(`
      INSERT INTO notification_jobs (
        id, dedupe_key, template_key, recipient_type, recipient_id,
        reservation_id, status, available_at
      )
      SELECT ?, ?, 'reservation_confirmed', 'customer', customer_id, id, 'queued', ?
      FROM reservations WHERE id = ? AND line_identity_id IS NOT NULL
    `).bind(
      crypto.randomUUID(),
      `reservation:${input.reservationId}:template:reservation_confirmed:revision:1`,
      input.nowIso,
      input.reservationId
    ),
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
          ) VALUES (?, ?, 'reservation', ?, 'upsert', 'queued', ?)
        `
      )
      .bind(
        crypto.randomUUID(),
        `reservation:${input.reservationId}:google:upsert:revision:1`,
        input.reservationId,
        input.nowIso
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
          ) VALUES (?, 'staff', ?, 'admin_reservation_created', 'reservation', ?, ?)
        `
      )
      .bind(
        crypto.randomUUID(),
        input.admin.id,
        input.reservationId,
        JSON.stringify({
          source: input.request.source,
          storeId: input.context.storeId,
          serviceId: input.context.serviceId,
          serviceIds: input.context.serviceIds,
          resourceId: input.context.resourceId,
          reservationOrigin: input.reservationOrigin,
        })
      ),
    input.db
      .prepare(
        `
          UPDATE idempotency_keys
          SET status = 'succeeded',
              target_type = 'reservation',
              target_id = ?,
              updated_at = ?
          WHERE id = ?
        `
      )
      .bind(input.reservationId, input.nowIso, input.idempotencyId)
  );

  return statements;
};

type ResolvedAdminCreateCustomer = {
  existingCustomer: CustomerRow | null;
  normalizedPhone: string | null;
  phoneHash: string | null;
};

// New-customer (typed-phone) resolution, extracted from resolveAdminCreateCustomer
// to keep that function's cognitive complexity under the threshold. Normalizes the
// typed phone, matches an existing row by phone_hash (skipping archived non-blocked
// rows), and applies the staff own-store-scope guard. Returns a failure result
// (checked via `"ok" in ...`) or the resolved fields; `typedPhoneHash` is always
// set and reused by the caller for the lock phone_hash.
const resolveNewCustomerByPhone = async (
  db: D1Database,
  request: AdminCreateReservationRequest,
  admin: AdminUser
): Promise<
  | AdminCreateReservationResult
  | { existingCustomer: CustomerRow | null; normalizedPhone: string; typedPhoneHash: string }
> => {
  // isValidRequestShape guarantees a well-formed customer here.
  const typedPhone = normalizePhone(request.customer!.phone);
  if (!typedPhone) {
    return { ok: false, reason: "invalid_request" };
  }
  const typedPhoneHash = await sha256Hex(typedPhone);
  let existingCustomer = await getCustomerByPhoneHash(db, typedPhoneHash);
  // An archived (soft-deleted) ACTIVE customer matched by phone must not be
  // reused — that would resurface a hidden customer. A blocked-archived row is
  // intentionally kept so the later block check still rejects it (blocks persist
  // through archiving; the lookup no longer filters archived for that reason).
  if (existingCustomer?.archived_at != null && existingCustomer.block_status !== "blocked") {
    existingCustomer = null;
  }

  // Staff store-scope guard (membership-fabrication defense + duplicate hygiene):
  // a staff must NOT reuse a customer found by phone unless it is one they
  // legitimately manage (own-store reservation/valid visit). Otherwise a staff
  // could type a victim's phone to attach this new own-store reservation to the
  // victim's GLOBAL customer row and then read/edit that customer's PII via the
  // store-scoped customer routes. For a non-blocked match we therefore reuse ONLY
  // an OWN-STORE customer sharing this phone (preferring an existing own-store
  // duplicate over creating yet another); when none exists we create a fresh
  // own-store row (the owner can merge later). Blocked matches are kept untouched
  // so the global block check still rejects the booking. (codex adversarial + P2)
  if (admin.role === "staff" && existingCustomer != null && existingCustomer.block_status !== "blocked") {
    existingCustomer = admin.store_id
      ? await findOwnStoreCustomerByPhoneHash(db, typedPhoneHash, admin.store_id)
      : null;
  }

  return { existingCustomer, normalizedPhone: typedPhone, typedPhoneHash };
};

// Resolve the customer for an admin create. Existing-customer mode reuses a row
// by id (phone optional → paper-chart customers); new-customer mode delegates to
// resolveNewCustomerByPhone. Returns a failure result (checked via `"ok" in ...`
// like fetchBookingContext) or the resolved trio.
const resolveAdminCreateCustomer = async (
  db: D1Database,
  request: AdminCreateReservationRequest,
  admin: AdminUser
): Promise<AdminCreateReservationResult | ResolvedAdminCreateCustomer> => {
  if (request.customerId) {
    const found = await getCustomerById(db, request.customerId);
    if (!found) {
      return { ok: false, reason: "customer_not_found" };
    }
    // Existing-customer mode reuses the on-file row's phone_hash for locks (NULL →
    // phone-less paper-chart customers carry a NULL lock phone_hash, accepted by
    // customer_time_locks.phone_hash).
    return { existingCustomer: found, normalizedPhone: found.phone_normalized, phoneHash: found.phone_hash };
  }

  const resolved = await resolveNewCustomerByPhone(db, request, admin);
  if ("ok" in resolved) {
    return resolved;
  }
  // phone_hash for locks: reuse the matched row's hash when present, otherwise the
  // already-computed new-customer hash (always set in new-customer mode).
  const phoneHash = resolved.existingCustomer ? resolved.existingCustomer.phone_hash : resolved.typedPhoneHash;
  return { existingCustomer: resolved.existingCustomer, normalizedPhone: resolved.normalizedPhone, phoneHash };
};

// Capture only terminal write failures — idempotency replays resolved by
// resolveCreateBatchFailure are expected concurrency, not telemetry.
const captureCreateBatchFailure = (error: unknown, result: AdminCreateReservationResult): void => {
  if (!result.ok && result.reason === "write_failed") {
    captureBatchWriteFailure(error, {
      component: "reservation-create",
      op: "batch_write_failed",
      helper: "createAdminReservation"
    });
  }
};

export async function createAdminReservation(input: {
  db: D1Database;
  admin: AdminUser;
  lineChannelId?: string;
  request: AdminCreateReservationRequest;
  now?: () => number;
}): Promise<AdminCreateReservationResult> {
  const now = input.now ?? Date.now;
  const serviceIds = normalizeServiceIds(input.request.serviceIds);
  const request: AdminCreateReservationRequest = { ...input.request, serviceIds };
  if (!isValidRequestShape(request)) {
    return {
      ok: false,
      reason: "invalid_request"
    };
  }

  if (!(await mayBookCustomerId(input.db, input.admin, request.customerId))) {
    return {
      ok: false,
      reason: "forbidden"
    };
  }

  // Staff may only create reservations for THEIR OWN store. Enforce server-side
  // (fail closed without a store binding) so a staff cannot book — and thereby
  // create a customer relationship — at a store they don't belong to. Owner /
  // system_admin may book any store. (codex adversarial: defense-in-depth)
  if (input.admin.role === "staff" && request.storeId !== input.admin.store_id) {
    return {
      ok: false,
      reason: "forbidden"
    };
  }

  // Admin manual booking accepts any start on the slot_locks grid (5 min), not just
  // the 15-min grid the public availability UI offers — the owner takes phone bookings
  // at times like 09:40. 5 is the FLOOR: an off-grid start (e.g. 09:42) would write
  // locks the public path's 5-min collision check can never match → double booking.
  const startAt = parseStartAt(request.startAt, SLOT_LOCK_INTERVAL_MINUTES);
  if (!startAt || startAt.getTime() <= now()) {
    return {
      ok: false,
      reason: "invalid_time"
    };
  }

  const resolvedCustomer = await resolveAdminCreateCustomer(input.db, request, input.admin);
  if ("ok" in resolvedCustomer) {
    return resolvedCustomer;
  }
  const { existingCustomer, normalizedPhone, phoneHash } = resolvedCustomer;

  const requestHash = await createRequestHash(request, normalizedPhone, toIso(startAt));
  // Single clock stamps expires_at on write AND filters the TTL read (F-6.1).
  const nowMs = now();
  const nowIso = toIso(new Date(nowMs));
  const idempotencyResult = await resolveAdminCreateIdempotency(
    input.db,
    request.idempotencyKey,
    requestHash,
    nowIso
  );
  if (idempotencyResult) {
    return idempotencyResult;
  }

  if (request.origin === "phone") {
    return { ok: false, reason: "invalid_request" };
  }

  const context = await fetchBookingContext(
    input.db,
    request.storeId,
    request.serviceIds,
    request.resourceId
  );
  if ("ok" in context) {
    return context;
  }

  const endAt = addMinutes(startAt, context.durationMinutes);
  const slotTimes = generateSlotTimesForDuration(startAt, context.durationMinutes, SLOT_LOCK_INTERVAL_MINUTES);
  if (!slotTimes) {
    return {
      ok: false,
      reason: "invalid_time"
    };
  }

  // serviceIds is intentionally omitted so admin-created reservations stay outside
  // the customer-facing men's booking window, exactly like admin reschedule and
  // change-request approval. The admin slot picker (getAvailableSlots) does NOT
  // narrow its hours, so enforcing the window here would show staff a bookable
  // slot and then reject it at write time — the same dead end that #503 removed.
  // The window is a customer-facing display rule; staff keep the manual override.
  const businessTimeError = await ensureBusinessTime(input.db, context.storeId, context.timezone, startAt, endAt);
  if (businessTimeError) {
    return businessTimeError;
  }

  // Block check AFTER idempotency resolution: a replay of an already-succeeded
  // create (same key+hash) must return the cached reservation result even if the
  // customer was blocked between the original success and the retry. Only genuinely
  // new requests reach this and are rejected. (codex chatgpt-connector P2)
  if (existingCustomer?.block_status === "blocked") {
    return {
      ok: false,
      reason: "customer_blocked"
    };
  }
  // Same gate, widened to the phone number (see isPhoneHashBlocked): the row
  // resolved by id is only one of the rows that can share this number. Kept HERE,
  // after idempotency resolution, for the replay reason above — moving it into
  // resolveAdminCreateCustomer (called before the idempotency read) would make a
  // retry of an already-succeeded create return customer_blocked instead of the
  // cached reservation.
  if (phoneHash != null && (await isPhoneHashBlocked(input.db, phoneHash))) {
    return {
      ok: false,
      reason: "customer_blocked"
    };
  }

  const customerId = existingCustomer?.id ?? crypto.randomUUID();
  const reservationId = crypto.randomUUID();
  const idempotencyId = crypto.randomUUID();
  const endAtIso = toIso(endAt);
  const idempotencyExpiresAt = toIso(new Date(nowMs + IDEMPOTENCY_TTL_MS));

  const statements = buildAdminCreateReservationStatements({
    db: input.db,
    admin: input.admin,
    lineChannelId: input.lineChannelId,
    request,
    context,
    existingCustomer,
    normalizedPhone,
    phoneHash,
    customerId,
    reservationId,
    idempotencyId,
    requestHash,
    idempotencyExpiresAt,
    reservationOrigin: request.origin ?? null,
    nowIso,
    startAt,
    endAtIso,
    slotTimes
  });

  try {
    await input.db.batch(statements);
  } catch (error) {
    const result = await resolveCreateBatchFailure(input.db, request.idempotencyKey, requestHash, nowIso, error, input.admin, existingCustomer?.id);
    captureCreateBatchFailure(error, result);
    return result;
  }

  return readReservationResult(input.db, reservationId, false);
}
