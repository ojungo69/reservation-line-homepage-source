import type { WorkerBindings } from "../bindings";
import { trackEvent } from "../analytics/metrics";
import { isGoogleLiveAvailabilityEnabled } from "../runtime-config";
import { fetchGoogleBusyIntervals } from "../google/availability-live-check";
import { ensureBusinessTime } from "./business-hours";
import {
  buildBookingContext,
  generateSlotTimesForDuration,
  normalizeServiceIds,
  SLOT_LOCK_INTERVAL_MINUTES
} from "./slot-times";
import {
  resolvePublicConsentVersions,
  isInstantWithinBookingWindow,
  DEFAULT_BOOKING_WINDOW_DAYS_FALLBACK
} from "./public-options";
import { OWNER_EMAIL_RECIPIENT_ID } from "../notifications/operations-email";
// 電話番号の正規化は admin 側と同一実装でなければならない。ここに複製を持つと、
// 公開フォームだけが表記ゆれを別ハッシュとして保存し、ブロックが素通りする (issue #639)。
import { normalizePhone } from "../admin/shared";
import { sha256Hex } from "../crypto-utils";
import { toIso, addMinutes } from "../time-utils";
import { captureBatchWriteFailure } from "../sentry-helpers";
import { classifyReservationWriteError } from "./write-error";

export type PublicReservationRequest = {
  idempotencyKey: string;
  storeId: string;
  serviceId: string;
  serviceIds?: string[];
  resourceId: string;
  startAt: string;
  customer?: {
    displayName: string;
    displayNameKana?: string;
    phone: string;
  };
  consents: {
    noticeVersion: string;
    cancellationPolicyVersion: string;
    privacyPolicyVersion: string;
    minorGuardianVersion?: string;
    // Echo of the duplicate-reservation warning version the client displayed. Present
    // only when the warning was shown (the customer already held active future
    // reservations). The submit path validates it against the server-canonical version
    // and records the canonical value as consent evidence. Kept inside `consents` so it
    // is part of the idempotency request hash (replay stability) like the other versions.
    duplicateReservationWarningVersion?: string;
  };
};

export type VerifiedLineContext = {
  lineUserId: string;
  channelId: string;
};

type ResolvedCustomer = {
  displayName: string;
  displayNameKana?: string;
  phone: string;
};

// A reservation request whose customer contact has been resolved — either from
// the request body (new / changed / phone-less existing customer) or reused from
// the verified LINE customer's on-file record when the client omitted it.
type ResolvedPublicReservationRequest = Omit<PublicReservationRequest, "customer"> & {
  customer: ResolvedCustomer;
};

type PublicReservationSuccess = {
  ok: true;
  reservationId: string;
  // 新規作成は常に pending_approval (全予約承認制)。confirmed は旧実装が確定させた
  // 予約の idempotency replay (readReservationResult) が返す場合のみ。
  status: "pending_approval" | "confirmed";
  storeId: string;
  startAt: string;
  endAt: string;
  replayed: boolean;
};

type PublicReservationFailure = {
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
    | "reservation_limit_reached"
    | "consent_version_mismatch"
    | "duplicate_reservation_consent_required"
    | "write_failed";
};

export type PublicReservationResult = PublicReservationSuccess | PublicReservationFailure;

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
  bookingWindowDays: number;
};

export type ExistingLineIdentity = {
  id: string;
  customer_id: string;
  block_status: "active" | "blocked";
  archived_at: string | null;
  display_name: string;
  display_name_kana: string | null;
  phone_normalized: string | null;
  phone_hash: string | null;
  // 1 when an owner/admin manually linked this LINE identity to a known (paper-chart)
  // customer. Marks the customer as existing even with zero recorded visits, which
  // selects the owner email template and the Google "新規予約" title
  // (see the treatAsExisting gate below). SQLite returns INTEGER as number.
  linked_by_admin: number;
};

type BlockedCustomer = {
  id: string;
  block_status: "active" | "blocked";
};

type IdempotencyRow = {
  status: "started" | "succeeded" | "failed";
  target_id: string | null;
  request_hash: string | null;
};

type ReservationRow = {
  id: string;
  store_id: string;
  status: "pending_approval" | "confirmed";
  start_at: string;
  end_at: string;
};

const SLOT_START_INTERVAL_MINUTES = 15;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const PENDING_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

const isNonEmptyString = (value: unknown, maxLength: number): value is string => {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
};

const parseStartAt = (value: string) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return undefined;
  }
  if (date.getUTCSeconds() !== 0 || date.getUTCMilliseconds() !== 0) {
    return undefined;
  }
  if (date.getUTCMinutes() % SLOT_START_INTERVAL_MINUTES !== 0) {
    return undefined;
  }
  return date;
};

const isValidRequestShape = (request: PublicReservationRequest, line: VerifiedLineContext) => {
  return (
    isNonEmptyString(request.idempotencyKey, 256) &&
    isNonEmptyString(request.storeId, 64) &&
    isNonEmptyString(request.serviceId, 128) &&
    normalizeServiceIds(request.serviceIds, request.serviceId).length > 0 &&
    isNonEmptyString(request.resourceId, 128) &&
    isNonEmptyString(request.consents.noticeVersion, 64) &&
    isNonEmptyString(request.consents.cancellationPolicyVersion, 64) &&
    isNonEmptyString(request.consents.privacyPolicyVersion, 64) &&
    (request.consents.minorGuardianVersion === undefined ||
      isNonEmptyString(request.consents.minorGuardianVersion, 64)) &&
    isNonEmptyString(line.lineUserId, 128) &&
    isNonEmptyString(line.channelId, 128)
  );
};

const fetchBookingContext = async (
  db: D1Database,
  storeId: string,
  serviceIds: string[],
  resourceId: string
): Promise<BookingContext | PublicReservationFailure> => {
  const context = await db
    .prepare(
      `
        SELECT
          stores.id AS storeId,
          stores.timezone AS timezone,
          COALESCE(store_settings.booking_window_days, ${DEFAULT_BOOKING_WINDOW_DAYS_FALLBACK}) AS bookingWindowDays,
          store_resources.id AS resourceId,
          store_resources.store_id AS resourceStoreId
        FROM stores
        -- LEFT JOIN (matches public-options.ts availability path): a freshly
        -- bootstrapped store with no store_settings row falls back to schema
        -- defaults via COALESCE instead of wrongly returning store_not_found
        -- (which would let availability show slots the store can't book).
        LEFT JOIN store_settings ON store_settings.store_id = stores.id
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

export const getExistingLineIdentity = async (
  db: D1Database,
  line: VerifiedLineContext
): Promise<ExistingLineIdentity | null> => {
  return db
    .prepare(
      `
        SELECT
          line_identities.id,
          line_identities.customer_id,
          line_identities.linked_by_admin,
          customers.block_status,
          customers.archived_at,
          customers.display_name,
          customers.display_name_kana,
          customers.phone_normalized,
          customers.phone_hash
        FROM line_identities
        JOIN customers ON customers.id = line_identities.customer_id
        WHERE line_identities.provider = 'line'
          AND line_identities.channel_id = ?
          AND line_identities.line_user_id = ?
        LIMIT 1
      `
    )
    .bind(line.channelId, line.lineUserId)
    .first<ExistingLineIdentity>();
};

// Resolve the contact used for this booking. A provided customer (new / changed /
// phone-less existing customer) is validated and used as-is. When the client omits
// customer, the verified LINE customer's on-file record is reused — but only when a
// phone is on file. The lookup key is the verified line_user_id alone (never a
// phone_hash or other cross-customer key), so a caller can only ever reuse their own
// record. Returns undefined when no usable contact exists (→ invalid_request).
const resolveEffectiveCustomer = (
  provided: PublicReservationRequest["customer"],
  identity: ExistingLineIdentity | null
): ResolvedCustomer | undefined => {
  if (provided) {
    if (!isNonEmptyString(provided.displayName, 120) || !isNonEmptyString(provided.phone, 32)) {
      return undefined;
    }
    if (provided.displayNameKana !== undefined && !isNonEmptyString(provided.displayNameKana, 120)) {
      return undefined;
    }
    return {
      displayName: provided.displayName,
      displayNameKana: provided.displayNameKana,
      phone: provided.phone
    };
  }
  if (identity && isNonEmptyString(identity.phone_normalized ?? "", 32)) {
    return {
      displayName: identity.display_name,
      displayNameKana: identity.display_name_kana ?? undefined,
      phone: identity.phone_normalized as string
    };
  }
  return undefined;
};

const getBlockedCustomerByPhoneHash = async (db: D1Database, phoneHash: string): Promise<BlockedCustomer | null> => {
  // Tombstoned merge sources also carry block_status='blocked' (the
  // existing CHECK on the column only allows active/blocked), but those
  // are not real blocks — the canonical customer has been consolidated
  // into merged_into_id and the active record under the same phone_hash
  // is the target customer. Filtering merged_into_id IS NULL keeps the
  // post-merge booking flow from rejecting the target's phone.
  return db
    .prepare(
      `
        SELECT id, block_status
        FROM customers
        WHERE phone_hash = ?
          AND block_status = 'blocked'
          AND merged_into_id IS NULL
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1
      `
    )
    .bind(phoneHash)
    .first<BlockedCustomer>();
};

const getValidVisitCount = async (db: D1Database, customerId: string) => {
  const row = await db
    .prepare(
      `
        SELECT COUNT(*) AS count
        FROM customer_visits
        WHERE customer_id = ?
          AND status = 'valid'
      `
    )
    .bind(customerId)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
};

// A future, still-active reservation the customer already holds. Surfaced to the
// booking form (so a recognized customer is warned that a NEW booking does not
// replace it) and re-evaluated on submit (so the warning cannot be bypassed by a
// tampered client). `isWithinLeadTime` marks reservations starting within 24h —
// the booking-form warning uses it to pick its strongest (hard) wording.
export type UpcomingReservation = {
  reservationId: string;
  storeId: string;
  storeName: string;
  serviceName: string;
  startAt: string;
  // 承認待ちか確定済みか。LIFF の重複予約警告が「既に確定している」と断定できるか
  // どうかの文言分岐に使う (全予約承認制では pending_approval が通常状態のため)。
  status: "confirmed" | "pending_approval";
  isWithinLeadTime: boolean;
  // キャンセル申請機能の廃止 (2026-08-01) により顧客の自己キャンセル手段は無い。
  // デプロイ窓の旧クライアント互換のためフィールド形だけ維持し、常に true を返す。
  cancelBlocked: boolean;
};

// 旧 change-request lead time (24h)。機能廃止後も isWithinLeadTime の表示分岐
// (直前予約への強い警告文言) だけがこの境界を使い続ける。
const UPCOMING_HARD_WARNING_LEAD_TIME_MS = 24 * 60 * 60 * 1000;

type UpcomingReservationRow = {
  id: string;
  store_id: string;
  store_name: string;
  service_name: string;
  start_at: string;
  end_at: string;
  status: "confirmed" | "pending_approval";
};

// Evidence that the customer acknowledged the duplicate-reservation warning, recorded
// in an audit_logs row inside the booking batch. PII-minimal by design: only ids and
// timestamps (no contact details / names), since this is a long-lived audit record.
type DuplicateConsentEvidence = {
  stage: "hard" | "soft";
  warningVersion: string;
  existingReservations: Array<{
    reservationId: string;
    storeId: string;
    startAt: string;
    status: "confirmed" | "pending_approval";
  }>;
  consentedAt: string;
  customerId: string;
};

// Default cap on how many existing reservations we surface. The customer only needs to
// see that they already hold bookings (and which ones), not an unbounded list — also a
// DoS guard on the query.
const UPCOMING_RESERVATIONS_LIMIT = 10;

// List the customer's active FUTURE reservations across ALL stores. The WHERE clause is
// kept character-for-character in sync with trg_reservations_web_cap
// (migrations/0024_store_settings_reservation_cap.sql:41-51): identity by customer_id
// only, start_at > now, and status confirmed OR (pending_approval AND not expired). The
// expired-pending exclusion is essential — listMyReservations (my-reservations.ts) keys
// off end_at and does NOT drop expired pendings, so it must NOT be reused here, or the
// form would warn about a reservation the submit-side cap no longer counts. `nowIso`
// must be the submit instant (checkedAt) so this matches the trigger's
// datetime(NEW.updated_at). Uses idx_reservations_customer_time(customer_id, start_at).
export const getUpcomingReservations = async (
  db: D1Database,
  customerId: string | null | undefined,
  nowIso: string,
  limit: number = UPCOMING_RESERVATIONS_LIMIT
): Promise<UpcomingReservation[]> => {
  if (!customerId) {
    return [];
  }
  const rows = await db
    .prepare(
      `
        SELECT
          r.id          AS id,
          r.store_id    AS store_id,
          stores.name   AS store_name,
          services.name AS service_name,
          r.start_at    AS start_at,
          r.end_at      AS end_at,
          r.status      AS status
        FROM reservations r
        JOIN stores   ON stores.id   = r.store_id
        JOIN services ON services.id = r.service_id
        WHERE r.customer_id = ?
          AND datetime(r.start_at) > datetime(?)
          AND (
            r.status = 'confirmed'
            OR (
              r.status = 'pending_approval'
              AND (r.pending_expires_at IS NULL OR datetime(r.pending_expires_at) > datetime(?))
            )
          )
        ORDER BY r.start_at ASC
        LIMIT ?
      `
    )
    .bind(customerId, nowIso, nowIso, limit)
    .all<UpcomingReservationRow>();

  const nowMs = Date.parse(nowIso);
  return (rows.results ?? []).map((row) => ({
    reservationId: row.id,
    storeId: row.store_id,
    storeName: row.store_name,
    serviceName: row.service_name,
    startAt: row.start_at,
    status: row.status,
    isWithinLeadTime: Date.parse(row.start_at) - nowMs < UPCOMING_HARD_WARNING_LEAD_TIME_MS,
    cancelBlocked: true
  }));
};

const createRequestHash = async (
  request: ResolvedPublicReservationRequest,
  line: VerifiedLineContext,
  normalizedPhone: string,
  normalizedStartAt: string,
  serviceIds: string[]
) => {
  return sha256Hex(
    JSON.stringify({
      storeId: request.storeId,
      serviceId: request.serviceId,
      serviceIds,
      resourceId: request.resourceId,
      startAt: normalizedStartAt,
      customer: {
        displayName: request.customer.displayName.trim(),
        displayNameKana: request.customer.displayNameKana?.trim() ?? null,
        phone: normalizedPhone
      },
      consents: request.consents,
      line
    })
  );
};

const createIdempotencyStorageKey = async (
  idempotencyKey: string,
  line: VerifiedLineContext
) => {
  return sha256Hex(
    JSON.stringify({
      scope: "public_submit",
      channelId: line.channelId,
      lineUserId: line.lineUserId,
      idempotencyKey
    })
  );
};

const readReservationResult = async (
  db: D1Database,
  reservationId: string,
  replayed: boolean
): Promise<PublicReservationResult> => {
  const row = await db
    .prepare(
      `
        SELECT id, store_id, status, start_at, end_at
        FROM reservations
        WHERE id = ?
        LIMIT 1
      `
    )
    .bind(reservationId)
    .first<ReservationRow>();

  if (!row || (row.status !== "pending_approval" && row.status !== "confirmed")) {
    return {
      ok: false,
      reason: "write_failed"
    };
  }

  return {
    ok: true,
    reservationId: row.id,
    status: row.status,
    storeId: row.store_id,
    startAt: row.start_at,
    endAt: row.end_at,
    replayed
  };
};

const mapBatchError = (error: unknown): PublicReservationFailure => {
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
      reason: "invalid_request"
    };
  }
  if (message.includes("reservation_limit_reached")) {
    return {
      ok: false,
      reason: "reservation_limit_reached"
    };
  }
  if (message.includes("idempotency_keys")) {
    return {
      ok: false,
      reason: "idempotency_in_progress"
    };
  }
  return {
    ok: false,
    reason: "write_failed"
  };
};

const resolvePublicIdempotency = async (
  db: D1Database,
  idempotencyStorageKey: string,
  requestHash: string,
  nowIso: string
): Promise<PublicReservationResult | undefined> => {
  // Filter on expires_at so a `started` row from a crashed submit stops
  // blocking the same idempotency_key after its TTL window elapses — parity
  // with the admin resolver (docs/SECURITY-AUDIT-2026-05-27.md F-6.1). Without
  // it an expired row with a different request_hash would return
  // idempotency_conflict and permanently lock key reuse past its TTL. `nowIso`
  // is the booking instant (checkedAt) that ALSO stamps the row's expires_at on
  // write, so read and write judge expiry against one clock. The `datetime(...)`
  // wrapping on both sides handles the ISO `T`-separator lexical-ordering quirk.
  const idempotency = await db
    .prepare(
      `
        SELECT status, target_id, request_hash
        FROM idempotency_keys
        WHERE scope = 'public_submit'
          AND idempotency_key = ?
          AND (expires_at IS NULL OR datetime(expires_at) > datetime(?))
        LIMIT 1
      `
    )
    .bind(idempotencyStorageKey, nowIso)
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

const buildPublicReservationStatements = (input: {
  db: D1Database;
  request: ResolvedPublicReservationRequest;
  line: VerifiedLineContext;
  context: BookingContext;
  existingLineIdentity: ExistingLineIdentity | null;
  checkedAt: string;
  normalizedPhone: string;
  phoneHash: string;
  customerId: string;
  lineIdentityId: string;
  // 全予約承認制: 公開Web予約の新規作成は常に承認待ち。
  status: "pending_approval";
  lockStatus: "pending";
  pendingExpiresAt: string;
  reservationId: string;
  idempotencyId: string;
  idempotencyStorageKey: string;
  requestHash: string;
  idempotencyExpiresAt: string;
  startAt: Date;
  endAtIso: string;
  slotTimes: string[];
  /** True when the customer has no completed visits yet (always a pending booking). */
  isNewCustomer: boolean;
  /** Duplicate-reservation acknowledgement to record as audit evidence; null when the
   *  customer held no existing reservations (no warning was shown). */
  duplicateConsent: DuplicateConsentEvidence | null;
}) => {
  const statements: D1PreparedStatement[] = [
    // Reclaim any EXPIRED idempotency row for this key before inserting the new
    // `started` row. The resolver's TTL filter hides expired rows from the READ,
    // but such a row still occupies UNIQUE(scope, idempotency_key); without this
    // delete the INSERT below would collide and the customer would stay locked
    // out of reusing the key past its TTL — defeating B9's purpose, since
    // public/app.js reuses one key per unchanged form signature. Only EXPIRED
    // rows are removed (datetime(expires_at) <= checkedAt), so a genuine live
    // concurrent submit is left intact and still resolves to in_progress. D1
    // batch is atomic, so this delete + the insert are one transaction.
    input.db
      .prepare(
        `DELETE FROM idempotency_keys
         WHERE scope = 'public_submit'
           AND idempotency_key = ?
           AND datetime(expires_at) <= datetime(?)`
      )
      .bind(input.idempotencyStorageKey, input.checkedAt),
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
          ) VALUES (?, 'public_submit', ?, 'started', ?, ?, ?)
        `
      )
      .bind(
        input.idempotencyId,
        input.idempotencyStorageKey,
        input.requestHash,
        input.idempotencyExpiresAt,
        input.checkedAt
      )
  ];

  if (input.existingLineIdentity) {
    statements.push(
      input.db
        .prepare(
          `
            UPDATE line_identities
            SET friend_flag = 1,
                official_friend_status = 'friend',
                last_friend_checked_at = ?,
                updated_at = ?
            WHERE id = ?
          `
        )
        .bind(input.checkedAt, input.checkedAt, input.lineIdentityId)
    );
  } else {
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
          input.request.customer.displayName.trim(),
          input.request.customer.displayNameKana?.trim() ?? null,
          input.normalizedPhone,
          input.phoneHash,
          input.checkedAt
        ),
      input.db
        .prepare(
          `
            INSERT INTO line_identities (
              id,
              customer_id,
              channel_id,
              line_user_id,
              friend_flag,
              official_friend_status,
              last_friend_checked_at,
              updated_at
            ) VALUES (?, ?, ?, ?, 1, 'friend', ?, ?)
          `
        )
        .bind(
          input.lineIdentityId,
          input.customerId,
          input.line.channelId,
          input.line.lineUserId,
          input.checkedAt,
          input.checkedAt
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
            resource_id,
            line_identity_id,
            source,
            status,
            start_at,
            end_at,
            duration_minutes,
            pending_expires_at,
            created_by,
            updated_by,
            idempotency_key,
            google_sync_state,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'web_line', ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
        `
      )
      .bind(
        input.reservationId,
        input.context.storeId,
        input.context.serviceId,
        input.customerId,
        input.context.resourceId,
        input.lineIdentityId,
        input.status,
        toIso(input.startAt),
        input.endAtIso,
        input.context.durationMinutes,
        input.pendingExpiresAt,
        input.lineIdentityId,
        input.lineIdentityId,
        input.idempotencyStorageKey,
        input.checkedAt
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

  // Clear any stranded EXPIRED PENDING locks at the target slots before re-locking them,
  // on BOTH lock tables. A pending lock whose TTL has lapsed but which the out-of-band
  // expiry sweep never DELETEd (the documented orphaned-lock incident class) would
  // otherwise collide with the INSERTs below and make a slot that availability already
  // shows as free (getBusySlots ignores expired pending locks) un-bookable — so
  // availability self-heals but booking does not. Removing only dead PENDING locks keeps
  // the two consistent: live pending (future expires_at) and confirmed (any expires_at)
  // locks are left intact, so a genuinely held slot still collides → slot_unavailable /
  // customer_time_conflict. customer_time_locks is cleared too so the same LINE customer
  // re-booking their OWN expired-pending slot isn't blocked by the (customer_id, slot_at)
  // UNIQUE after the slot_lock is gone.
  if (input.slotTimes.length > 0) {
    const slotPlaceholders = input.slotTimes.map(() => "?").join(", ");
    statements.push(
      input.db
        .prepare(
          `
            DELETE FROM slot_locks
            WHERE store_id = ?
              AND resource_id = ?
              AND slot_at IN (${slotPlaceholders})
              AND lock_status = 'pending'
              AND expires_at IS NOT NULL
              AND datetime(expires_at) <= datetime(?)
          `
        )
        .bind(input.context.storeId, input.context.resourceId, ...input.slotTimes, input.checkedAt),
      input.db
        .prepare(
          `
            DELETE FROM customer_time_locks
            WHERE customer_id = ?
              AND slot_at IN (${slotPlaceholders})
              AND lock_status = 'pending'
              AND expires_at IS NOT NULL
              AND datetime(expires_at) <= datetime(?)
          `
        )
        .bind(input.customerId, ...input.slotTimes, input.checkedAt)
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
            ) VALUES (?, ?, ?, ?, 'reservation', ?, ?, ?)
          `
        )
        .bind(
          slotLockId,
          input.context.storeId,
          input.context.resourceId,
          slotAt,
          input.reservationId,
          input.lockStatus,
          input.pendingExpiresAt
        ),
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
              expires_at
            ) VALUES (?, ?, ?, 'reservation', ?, ?, ?)
          `
        )
        .bind(
          crypto.randomUUID(),
          input.customerId,
          slotAt,
          input.reservationId,
          input.lockStatus,
          input.pendingExpiresAt
        ),
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
            ) VALUES (?, ?, ?, ?, ?, ?, 'created', 'customer', ?, 'public_web_reservation')
          `
        )
        .bind(
          crypto.randomUUID(),
          slotLockId,
          input.context.storeId,
          input.context.resourceId,
          slotAt,
          input.reservationId,
          input.lineIdentityId
        )
    );
  }

  for (const [consentType, version] of [
    ["notice", input.request.consents.noticeVersion],
    ["cancellation_policy", input.request.consents.cancellationPolicyVersion],
    ["privacy_policy", input.request.consents.privacyPolicyVersion],
    ["minor_guardian", input.request.consents.minorGuardianVersion]
  ] as const) {
    if (!version) {
      continue;
    }
    statements.push(
      input.db
        .prepare(
          `
            INSERT INTO consent_records (
              id,
              customer_id,
              reservation_id,
              consent_type,
              version,
              consented_at
            ) VALUES (?, ?, ?, ?, ?, ?)
          `
        )
        .bind(crypto.randomUUID(), input.customerId, input.reservationId, consentType, version, input.checkedAt)
    );
  }

  // 予約作成時は顧客向けLINE通知を積まない (全予約が承認待ちのため)。LIFF 画面の
  // 受付表示のみとし、reservation_confirmed は管理画面の承認時に enqueue される。
  // LINE Messaging API 無料枠 (200通/月) の節約 (2026-07-04 オーナー決定4)。

  // Notify owners for every public reservation application. New customers keep
  // the dedicated alert; established customers use the general approval prompt.
  const ownerTemplateKey = input.isNewCustomer
    ? "reservation_new_customer"
    : "pending_approval_created";
  // Owner notifications are email-only: one job per reservation, independent
  // of LINE_OPERATIONS_USER_IDS. The sentinel keeps email addresses out of D1.
  statements.push(
    input.db
      .prepare(
        `
          INSERT OR IGNORE INTO notification_jobs (
            id,
            dedupe_key,
            template_key,
            recipient_type,
            recipient_id,
            reservation_id,
            status,
            available_at
          ) VALUES (?, ?, ?, 'owner', ?, ?, 'queued', ?)
        `
      )
      .bind(
        crypto.randomUUID(),
        `reservation:${input.reservationId}:template:${ownerTemplateKey}:recipient:${OWNER_EMAIL_RECIPIENT_ID}`,
        ownerTemplateKey,
        OWNER_EMAIL_RECIPIENT_ID,
        input.reservationId,
        input.checkedAt
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
        input.checkedAt
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
          ) VALUES (?, 'customer', ?, 'public_reservation_created', 'reservation', ?, ?)
        `
      )
      .bind(
        crypto.randomUUID(),
        input.lineIdentityId,
        input.reservationId,
        JSON.stringify({
          status: input.status,
          storeId: input.context.storeId,
          serviceId: input.context.serviceId,
          serviceIds: input.context.serviceIds,
          resourceId: input.context.resourceId
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
      .bind(input.reservationId, input.checkedAt, input.idempotencyId)
  );

  // Duplicate-reservation consent evidence — a SEPARATE audit row (not folded into
  // public_reservation_created) so the owner-facing reservation detail and customer
  // ledger can filter on this action, and so only this row's metadata is surfaced to
  // owners (the generic created-row metadata stays system_admin-only). Same batch →
  // atomic with the booking: a reservation is never created without its evidence.
  if (input.duplicateConsent) {
    statements.push(
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
            ) VALUES (?, 'customer', ?, 'public_reservation_duplicate_consent', 'reservation', ?, ?)
          `
        )
        .bind(
          crypto.randomUUID(),
          input.lineIdentityId,
          input.reservationId,
          JSON.stringify(input.duplicateConsent)
        )
    );
  }

  return statements;
};

export async function createPublicReservation(input: {
  db: D1Database;
  env?: Partial<WorkerBindings>;
  request: PublicReservationRequest;
  line: VerifiedLineContext;
  now?: () => number;
  /** Injected fetcher for testing Google API calls. */
  fetcher?: typeof fetch;
  /** Injected access-token provider for testing. */
  accessTokenProvider?: (env: Partial<WorkerBindings>) => Promise<string | undefined>;
}): Promise<PublicReservationResult> {
  const now = input.now ?? Date.now;
  if (!isValidRequestShape(input.request, input.line)) {
    return {
      ok: false,
      reason: "invalid_request"
    };
  }

  // Resolve the effective contact up front: the provided customer, or the verified
  // LINE customer's on-file record when the client omitted it. Keyed on the verified
  // line_user_id only — a caller can only ever reuse their own record. From here on
  // use `request` (customer guaranteed present), not `input.request`.
  const existingLineIdentity = await getExistingLineIdentity(input.db, input.line);
  const effectiveCustomer = resolveEffectiveCustomer(input.request.customer, existingLineIdentity);
  if (!effectiveCustomer) {
    return {
      ok: false,
      reason: "invalid_request"
    };
  }
  // Keep the client's submitted consent versions verbatim (validated below, after the
  // idempotency check). Recording the client echo — rather than overriding with the
  // env-resolved canonical — keeps them out of the live env state so the idempotency
  // request hash stays stable across retries even if a consent-version env var is bumped.
  const request: ResolvedPublicReservationRequest = { ...input.request, customer: effectiveCustomer };
  const serviceIds = normalizeServiceIds(request.serviceIds, request.serviceId);

  const normalizedPhone = normalizePhone(request.customer.phone);
  const startAt = parseStartAt(request.startAt);
  if (!normalizedPhone) {
    return {
      ok: false,
      reason: "invalid_request"
    };
  }
  if (!startAt) {
    return {
      ok: false,
      reason: "invalid_time"
    };
  }
  if (startAt.getTime() <= now()) {
    return {
      ok: false,
      reason: "invalid_time"
    };
  }

  const requestHash = await createRequestHash(request, input.line, normalizedPhone, toIso(startAt), serviceIds);
  const idempotencyStorageKey = await createIdempotencyStorageKey(request.idempotencyKey, input.line);

  // Submit instant — the single clock for this booking. Derived BEFORE the
  // idempotency read so the read's TTL filter, the row's expires_at write, and
  // the duplicate-reservation lookup all judge time against ONE instant (B9:
  // expired public_submit rows must not replay, with no read/write clock skew).
  // Also used as the `now` for the duplicate-reservation lookup so it matches
  // trg_reservations_web_cap's datetime(NEW.updated_at), and bound as updated_at
  // on every inserted row.
  const checkedAtMs = now();
  const checkedAt = toIso(new Date(checkedAtMs));

  const idempotencyResult = await resolvePublicIdempotency(input.db, idempotencyStorageKey, requestHash, checkedAt);
  if (idempotencyResult) {
    return idempotencyResult;
  }

  const context = await fetchBookingContext(
    input.db,
    request.storeId,
    serviceIds,
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

  const businessTimeError = await ensureBusinessTime(
    input.db,
    context.storeId,
    context.timezone,
    startAt,
    endAt,
    context.serviceIds
  );
  if (businessTimeError) {
    return businessTimeError;
  }

  // Enforce the per-store booking window (store_settings.booking_window_days) on the
  // SUBMIT path, not just on the availability/UI path — only for a genuinely NEW
  // reservation (AFTER the idempotency check above), so a replay of an
  // already-created reservation is returned without re-validation even if the owner
  // shortened the window meanwhile. This mirrors the consent-version check below and
  // preserves idempotent-retry semantics. The date dropdown only OFFERS in-window
  // dates, but a LINE/Turnstile-authenticated client could POST a startAt beyond the
  // window directly — reject it here with the same boundary semantics as
  // listPublicAvailability so a tampered body can never bypass the window.
  if (!isInstantWithinBookingWindow(startAt, context.timezone, now(), context.bookingWindowDays)) {
    return {
      ok: false,
      reason: "invalid_time"
    };
  }

  // Validate the submitted consent versions against the server's currently-published
  // canonical versions — only for a genuinely NEW reservation (after the idempotency
  // check, so a replay of an already-created reservation is returned above without
  // re-validation even if a consent-version env var was bumped meanwhile). A forged or
  // stale-page submission is REJECTED rather than silently recorded as agreement to the
  // current policy, keeping consent_records an accurate audit trail; the client reloads,
  // sees the current policy, and re-consents. The optional minor-guardian consent is
  // validated only when the client included it.
  const canonicalConsents = resolvePublicConsentVersions(input.env ?? {});
  const submittedConsents = input.request.consents;
  const consentVersionsMatch =
    submittedConsents.noticeVersion === canonicalConsents.notice &&
    submittedConsents.cancellationPolicyVersion === canonicalConsents.cancellationPolicy &&
    submittedConsents.privacyPolicyVersion === canonicalConsents.privacyPolicy &&
    (submittedConsents.minorGuardianVersion === undefined ||
      submittedConsents.minorGuardianVersion === canonicalConsents.minorGuardian);
  if (!consentVersionsMatch) {
    return {
      ok: false,
      reason: "consent_version_mismatch"
    };
  }

  // Duplicate-reservation gate (only a recognized existing customer can already hold
  // reservations; a brand-new LINE customer has no customer_id yet, so skip). If the
  // customer already holds active future reservations, a NEW booking must carry an
  // explicit acknowledgement (the warning the form showed) that those reservations
  // stay billable — otherwise reject. This re-runs the SAME check the form rendered,
  // so a tampered/stale client cannot bypass it, and catches a reservation that was
  // created in the window between form load and submit. Fail CLOSED on a DB error
  // (write_failed) — unlike the fail-open pre-fill/visit-count helpers — so a lookup
  // failure can never wave a booking through without the acknowledgement.
  let duplicateConsent: DuplicateConsentEvidence | null = null;
  if (existingLineIdentity) {
    let upcoming: UpcomingReservation[];
    try {
      upcoming = await getUpcomingReservations(input.db, existingLineIdentity.customer_id, checkedAt);
    } catch (error) {
      console.error("getUpcomingReservations failed during public submit", {
        customerId: existingLineIdentity.customer_id,
        error: error instanceof Error ? error.message : String(error)
      });
      return { ok: false, reason: "write_failed" };
    }
    if (upcoming.length > 0) {
      // Reuse the canonical versions already resolved for the consent-version check above
      // (same env snapshot) rather than resolving a second time.
      const canonicalDuplicateWarningVersion = canonicalConsents.duplicateReservationWarning;
      if (request.consents.duplicateReservationWarningVersion !== canonicalDuplicateWarningVersion) {
        return { ok: false, reason: "duplicate_reservation_consent_required" };
      }
      duplicateConsent = {
        // Hard whenever ANY existing reservation is already inside the change-request
        // lead time (no longer cancellable) — that is the strongest warning the form
        // could have shown.
        stage: upcoming.some((reservation) => reservation.isWithinLeadTime) ? "hard" : "soft",
        warningVersion: canonicalDuplicateWarningVersion,
        existingReservations: upcoming.map((reservation) => ({
          reservationId: reservation.reservationId,
          storeId: reservation.storeId,
          startAt: reservation.startAt,
          // 同意時点の status を証跡に固定する。警告文言は status で分岐する
          // (「既に確定している」断定 or 承認待ちを含む非断定) ため、後から
          // 予約が承認/失効しても「顧客がどちらの文言を見て同意したか」を
          // audit_logs から証明できるようにする。
          status: reservation.status
        })),
        consentedAt: checkedAt,
        customerId: existingLineIdentity.customer_id
      };
    }
  }

  const phoneHash = await sha256Hex(normalizedPhone);
  const blockedCustomerByPhone = await getBlockedCustomerByPhoneHash(input.db, phoneHash);
  // Fail closed for an archived (soft-deleted) LINE customer: reject BEFORE reusing
  // customer_id / inserting any row, so a soft-deleted customer can never resurface
  // through the public LINE booking path. (Re-using the row, or treating them as new
  // and inserting a fresh line_identity, would either un-hide them or collide on the
  // line_identities UNIQUE(provider, channel_id, line_user_id) constraint.) The owner
  // must restore the customer to let them book again. (codex PR-B blocking)
  if (
    existingLineIdentity?.block_status === "blocked" ||
    existingLineIdentity?.archived_at != null ||
    blockedCustomerByPhone
  ) {
    return {
      ok: false,
      reason: "invalid_request"
    };
  }

  const customerId = existingLineIdentity?.customer_id ?? crypto.randomUUID();
  const lineIdentityId = existingLineIdentity?.id ?? crypto.randomUUID();
  const validVisitCount = existingLineIdentity ? await getValidVisitCount(input.db, customerId) : 0;
  // 「既存客」= 実来店が1件以上 OR オーナーが目視で既存客として LINE 紐付け済み
  // (linked_by_admin=1)。後者は来店履歴を seed せず紐付けフラグだけで表現する
  // (来店していない登録日付を来店履歴に作らないため)。isNewCustomer
  // (= owner 通知 template の選択 / Google「新規予約」タイトル) にのみ使う。
  const treatAsExisting = validVisitCount > 0 || existingLineIdentity?.linked_by_admin === 1;
  // 全予約承認制 (2026-07-04 オーナー決定): 新規・既存を問わず公開Web予約は常に
  // 承認待ちで作成し、管理画面の承認 (approve) で confirmed へ遷移させる。
  // 旧 store_settings.reservation_approval_mode ('existing_customer_auto') による
  // 既存客の自動確定は廃止 (カラムは残るが予約確定判定からは参照しない)。
  const status = "pending_approval" as const;
  const lockStatus = "pending" as const;
  const pendingExpiresAt = toIso(new Date(now() + PENDING_APPROVAL_TTL_MS));

  // Google live availability check (fail-closed on submit)
  const env = input.env ?? {};
  if (isGoogleLiveAvailabilityEnabled(env)) {
    const storeRow = await input.db
      .prepare("SELECT google_calendar_id FROM stores WHERE id = ? LIMIT 1")
      .bind(context.storeId)
      .first<{ google_calendar_id: string | null }>();
    const calendarId = storeRow?.google_calendar_id;
    if (!calendarId) {
      return { ok: false, reason: "slot_unavailable" };
    }
    const googleResult = await fetchGoogleBusyIntervals({
      env,
      storeId: context.storeId,
      calendarId,
      rangeStartUtc: toIso(startAt),
      rangeEndUtc: toIso(endAt),
      fetcher: input.fetcher,
      accessTokenProvider: input.accessTokenProvider,
      now: input.now
    });
    if (!googleResult.ok) {
      return { ok: false, reason: "slot_unavailable" };
    }
    // Check if requested slot overlaps any busy interval
    const slotStartMs = startAt.getTime();
    const slotEndMs = endAt.getTime();
    for (const interval of googleResult.busyIntervals) {
      const busyStartMs = new Date(interval.startUtc).getTime();
      const busyEndMs = new Date(interval.endUtc).getTime();
      if (slotStartMs < busyEndMs && slotEndMs > busyStartMs) {
        return { ok: false, reason: "slot_unavailable" };
      }
    }
  }

  const reservationId = crypto.randomUUID();
  const idempotencyId = crypto.randomUUID();
  const endAtIso = toIso(endAt);
  // Derive the idempotency row's expires_at from the SAME instant the TTL read
  // bound (checkedAtMs), so a future resend's read judges this row's expiry
  // against the exact clock that stamped it (B9: read and write share one clock).
  const idempotencyExpiresAt = toIso(new Date(checkedAtMs + IDEMPOTENCY_TTL_MS));

  const statements = buildPublicReservationStatements({
    db: input.db,
    request,
    line: input.line,
    context,
    existingLineIdentity,
    checkedAt,
    normalizedPhone,
    phoneHash,
    customerId,
    lineIdentityId,
    status,
    lockStatus,
    pendingExpiresAt,
    reservationId,
    idempotencyId,
    idempotencyStorageKey,
    requestHash,
    idempotencyExpiresAt,
    startAt,
    endAtIso,
    slotTimes,
    // Owner通知templateの選択。staff-linked 客 (linked_by_admin=1) は既存客扱い。
    // !treatAsExisting = (validVisitCount===0 && linked_by_admin!==1)。
    isNewCustomer: !treatAsExisting,
    duplicateConsent
  });

  try {
    await input.db.batch(statements);
  } catch (error) {
    const failure = mapBatchError(error);
    if (failure.reason === "write_failed") {
      captureBatchWriteFailure(error, {
        component: "public-submit",
        op: "batch_write_failed",
        helper: "createPublicReservation"
      });
    }
    return failure;
  }

  if (input.env) {
    trackEvent(input.env, {
      type: "created",
      storeId: context.storeId,
      serviceId: serviceIds.length === 1 ? serviceIds[0] : "multi",
      source: "online",
      environment: input.env.ENVIRONMENT ?? "local"
    });
  }

  return readReservationResult(input.db, reservationId, false);
}
