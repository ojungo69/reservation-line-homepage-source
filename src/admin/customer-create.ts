import type { AdminUser } from "./access";
import { normalizePhone } from "./shared";
import {
  buildCreateContext,
  fetchAdminActionIdempotency,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  sha256Hex,
  startedIdempotencyStatement,
  succeededIdempotencyStatement,
  trimAndCap,
  type IdempotencyRow,
} from "./settings-common";
import { adminWriteGuard, adminWriteWasRevoked } from "./write-authorization";

// Manual customer creation (every admin role). Lets the operator register a
// paper-chart customer who has never booked online, so the "既存客に紐付け" LINE
// flow has a record to attach to. Mirrors the settings create-flow idempotency
// machinery but returns the { ok, reason } shape used by the other customer
// endpoints (customer-visits.ts) rather than the settings `{ ok, error }` shape.
//
// Staff were added in 2026-08-26: they could already create customer rows through
// the reservation new-customer path (reservation-create.ts), so this is the same
// capability without a booking attached. The row records created_store_id so the
// staff member keeps seeing what they just created — customers carry no store_id,
// and own-store membership is otherwise derived from reservations/visits, neither
// of which a fresh manual customer has.
//
// customers.display_name / display_name_kana have a DB CHECK of length<=120 (this
// is NOT the 100 of settings-common.MAX_NAME_LENGTH — using that would over-reject
// valid names). phone_normalized CHECK<=32; normalizePhone already bounds it.
// There is intentionally NO duplicate-phone rejection: customers.phone_hash is
// non-unique by design and duplicates are surfaced/resolved through the merge UI.
const MAX_CUSTOMER_NAME_LENGTH = 120;

export type AdminCreateCustomerRequest = {
  idempotencyKey: string;
  displayName: string;
  displayNameKana?: string | null;
  phone?: string | null;
};

type AdminCreateCustomerFailureReason =
  | "forbidden"
  | "invalid_request"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "write_failed";

export type AdminCreateCustomerResult =
  | { ok: true; customerId: string; replayed: boolean }
  | { ok: false; reason: AdminCreateCustomerFailureReason };

const resolveCreateIdempotency = (
  idempotency: IdempotencyRow | null,
  requestHash: string
): AdminCreateCustomerResult | undefined => {
  if (!idempotency) return undefined;
  if (idempotency.request_hash !== requestHash) {
    return { ok: false, reason: "idempotency_conflict" };
  }
  if (idempotency.status === "succeeded" && idempotency.target_id) {
    return { ok: true, customerId: idempotency.target_id, replayed: true };
  }
  return { ok: false, reason: "idempotency_in_progress" };
};

type ParsedCreateCustomerFields = {
  idempotencyKey: string;
  displayName: string;
  displayNameKana: string | null;
  phoneNormalized: string | null;
};

// Validate + normalize the create-customer request. Returns null on any invalid
// field (caller maps to invalid_request). Extracted from createAdminCustomer to
// keep its cognitive complexity low (SonarCloud S3776). phone_hash is computed by
// the caller (async) from phoneNormalized.
const parseCreateCustomerFields = (
  request: AdminCreateCustomerRequest
): ParsedCreateCustomerFields | null => {
  const idempotencyKey = trimAndCap(request.idempotencyKey, MAX_IDEMPOTENCY_KEY_LENGTH);
  if (!idempotencyKey) return null;

  const displayName = trimAndCap(request.displayName, MAX_CUSTOMER_NAME_LENGTH);
  if (!displayName) return null;

  // kana: absent / blank → null; present-but-over-cap → invalid.
  let displayNameKana: string | null = null;
  if (request.displayNameKana != null && request.displayNameKana.trim().length > 0) {
    displayNameKana = trimAndCap(request.displayNameKana, MAX_CUSTOMER_NAME_LENGTH);
    if (!displayNameKana) return null;
  }

  // phone: blank/whitespace → "not provided" (null), never passed to normalizePhone
  // (which would return undefined and wrongly reject an intentionally-blank phone).
  let phoneNormalized: string | null = null;
  if (typeof request.phone === "string" && request.phone.trim().length > 0) {
    const normalized = normalizePhone(request.phone);
    if (!normalized) return null;
    phoneNormalized = normalized;
  }

  return { idempotencyKey, displayName, displayNameKana, phoneNormalized };
};

export async function createAdminCustomer(input: {
  db: D1Database;
  admin: AdminUser;
  request: AdminCreateCustomerRequest;
  now?: () => number;
}): Promise<AdminCreateCustomerResult> {
  // Staff register into their OWN store only, and the store is taken from the
  // authenticated admin — never from the request body, which would let a staff
  // member plant a customer in another store. Fail closed when a staff account
  // has no store binding (we could not name an owning store for the row).
  const isStaff = input.admin.role === "staff";
  if (isStaff && !input.admin.store_id) {
    return { ok: false, reason: "forbidden" };
  }
  const createdStoreId = isStaff ? input.admin.store_id : null;

  const fields = parseCreateCustomerFields(input.request);
  if (!fields) {
    return { ok: false, reason: "invalid_request" };
  }
  const { idempotencyKey, displayName, displayNameKana, phoneNormalized } = fields;
  const phoneHash = phoneNormalized ? await sha256Hex(phoneNormalized) : null;

  // createdStoreId is part of the request identity: without it, a replay of the
  // same key from a different store would return the first store's customer id
  // as if it had just been created for the second one.
  //
  // The field is OMITTED when null rather than serialized as null, so an owner's
  // hash is byte-identical to the one this function produced before the staff
  // flow existed. Idempotency rows live for 24h: writing `createdStoreId: null`
  // would turn an owner's retry that spans this deploy into idempotency_conflict
  // for a request that already succeeded. Absent vs present still separates
  // owner from staff, and two stores still differ, so nothing is weakened.
  const requestHash = await sha256Hex(
    JSON.stringify({
      action: "create_customer",
      displayName,
      displayNameKana,
      phoneNormalized,
      ...(createdStoreId === null ? {} : { createdStoreId }),
    })
  );

  // Build the idempotency clock BEFORE the TTL read so the read, the
  // `expires_at` write, and the catch re-read all judge expiry against the
  // same injected `now` (B8: eliminates wall-clock/injected-clock skew at the
  // TTL boundary; deterministic under time-travel tests).
  const { nowIso, expiresAt, idempotencyId } = buildCreateContext(input.now);

  const existingIdempotency = await fetchAdminActionIdempotency(input.db, idempotencyKey, nowIso);
  const idempotencyResult = resolveCreateIdempotency(existingIdempotency, requestHash);
  if (idempotencyResult) return idempotencyResult;

  const customerId = crypto.randomUUID();

  try {
    await input.db.batch([
      adminWriteGuard(input.db, input.admin),
      startedIdempotencyStatement({
        db: input.db,
        id: idempotencyId,
        key: idempotencyKey,
        requestHash,
        expiresAt,
        nowIso,
      }),
      input.db
        .prepare(
          `INSERT INTO customers (
             id, display_name, display_name_kana, phone_normalized, phone_hash, block_status,
             created_store_id, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`
        )
        .bind(
          customerId,
          displayName,
          displayNameKana,
          phoneNormalized,
          phoneHash,
          createdStoreId,
          nowIso
        ),
      input.db
        .prepare(
          `
            INSERT INTO audit_logs (
              id, actor_type, actor_id, action, target_type, target_id, metadata_json
            )
            SELECT ?, 'staff', ?, 'customer.create_manual', 'customer', ?, ?
            WHERE changes() = 1
          `
        )
        .bind(
          crypto.randomUUID(),
          input.admin.id,
          customerId,
          // No raw phone in the audit metadata (no-PII-in-audit convention).
          JSON.stringify({
            customer_id: customerId,
            has_phone: phoneNormalized !== null,
            admin_role: input.admin.role,
            created_store_id: createdStoreId,
          })
        ),
      succeededIdempotencyStatement({
        db: input.db,
        idempotencyId,
        targetType: "customer",
        targetId: customerId,
        nowIso,
      }),
    ]);
  } catch (error) {
    if (await adminWriteWasRevoked(input.db, input.admin, error)) {
      return { ok: false, reason: "forbidden" };
    }
    // A concurrent caller may have finished the same idempotency key first —
    // re-read and replay before falling through to write_failed.
    try {
      const concurrent = await fetchAdminActionIdempotency(input.db, idempotencyKey, nowIso);
      const replay = resolveCreateIdempotency(concurrent, requestHash);
      if (replay) return replay;
    } catch {
      // ignore — fall through to write_failed below
    }
    console.error("createAdminCustomer batch failed", {
      error: String(error),
    });
    return { ok: false, reason: "write_failed" };
  }

  return { ok: true, customerId, replayed: false };
}
