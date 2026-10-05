import { adminWriteGuard, adminWriteWasRevoked } from "./write-authorization";
import type { AdminUser } from "./access";
import { isAdminPrivileged, MAX_ID_LENGTH, storeExists, trimAndCap } from "./settings-common";
import { captureBatchWriteFailure } from "../sentry-helpers";

// Per-store CUSTOMER-FACING notice shown on the public booking page when the
// customer selects a store (e.g. "水曜・土曜はメンズデーとなっております。"). This
// endpoint only edits the configured value (store_settings.customer_notice); the
// public options endpoint (src/reservations/public-options.ts) returns it per store
// and the booking UI renders it with textContent (never innerHTML) so a notice can
// never inject markup.
//
// 500-char cap mirrors the CHECK constraint in migration 0039 — the two must move
// together to keep the API contract and the schema in sync.
//
// The UPSERT keeps the singleton store_settings invariant (a freshly bootstrapped
// store may have no row yet) and preserves the other columns' CREATE TABLE /
// migration defaults on first insert, exactly like settings-booking-window. PUT
// omits idempotencyKey the same way the other settings PUT routes do.

export const MAX_NOTICE_LENGTH = 500;

export type AdminCustomerNoticeUpdateRequest = {
  storeId: string;
  customerNotice: string | null;
};

export type AdminCustomerNoticeUpdateError =
  | "forbidden"
  | "invalid_request"
  | "store_not_found"
  | "missing_database"
  | "write_failed";

export type AdminCustomerNoticeUpdateResult =
  | { ok: true; storeId: string; customerNotice: string | null }
  | { ok: false; error: AdminCustomerNoticeUpdateError };

const INVALID_NOTICE = Symbol("invalid_notice");

// Normalize the notice: string → trim, empty → null (clears the notice), > 500 → invalid,
// anything that is not a string or null → invalid.
const parseNotice = (value: unknown): string | null | typeof INVALID_NOTICE => {
  if (value === null) return null;
  if (typeof value !== "string") return INVALID_NOTICE;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_NOTICE_LENGTH) return INVALID_NOTICE;
  return trimmed;
};

export const parseCustomerNoticeUpdateRequest = (
  body: unknown
): AdminCustomerNoticeUpdateRequest | null => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const raw = body as Record<string, unknown>;
  const storeId = trimAndCap(raw.storeId, MAX_ID_LENGTH);
  if (!storeId) return null;
  // The notice must be explicit — a partial PUT body must not silently reset it.
  if (!Object.hasOwn(raw, "customerNotice")) return null;
  const notice = parseNotice(raw.customerNotice);
  if (notice === INVALID_NOTICE) return null;
  return { storeId, customerNotice: notice };
};

type NoticeRow = { notice: string | null };

// Returns the prior notice (or null when no store_settings row exists) so the
// audit-log `before` reflects what was actually in force.
const fetchCurrentNotice = async (db: D1Database, storeId: string): Promise<string | null> => {
  const row = await db
    .prepare(
      `SELECT customer_notice AS notice
       FROM store_settings
       WHERE store_id = ?`
    )
    .bind(storeId)
    .first<NoticeRow>();
  return row?.notice ?? null;
};

export const updateAdminCustomerNoticeSettings = async (input: {
  db: D1Database;
  admin: AdminUser;
  request: AdminCustomerNoticeUpdateRequest;
  now?: () => number;
}): Promise<AdminCustomerNoticeUpdateResult> => {
  if (!isAdminPrivileged(input.admin.role)) {
    return { ok: false, error: "forbidden" };
  }
  if (!(await storeExists(input.db, input.request.storeId))) {
    return { ok: false, error: "store_not_found" };
  }

  const nowIso = new Date((input.now ?? Date.now)()).toISOString();
  const beforeNotice = await fetchCurrentNotice(input.db, input.request.storeId);

  try {
    await input.db.batch([
      adminWriteGuard(input.db, input.admin),
      // UPSERT — preserves the singleton invariant and initializes the reservation
      // cap explicitly when this is the first setting written for a store.
      input.db
        .prepare(
          `INSERT INTO store_settings (
             store_id, customer_notice, max_active_reservations_per_customer, updated_at
           ) VALUES (?, ?, 1, ?)
           ON CONFLICT(store_id) DO UPDATE SET
             customer_notice = excluded.customer_notice,
             updated_at = excluded.updated_at`
        )
        .bind(input.request.storeId, input.request.customerNotice, nowIso),
      input.db
        .prepare(
          `INSERT INTO audit_logs (
             id, actor_type, actor_id, action, target_type, target_id, metadata_json
           ) VALUES (?, 'staff', ?, 'settings.customer_notice.update', 'store', ?, ?)`
        )
        .bind(
          crypto.randomUUID(),
          input.admin.id,
          input.request.storeId,
          JSON.stringify({
            storeId: input.request.storeId,
            before: { customerNotice: beforeNotice },
            after: { customerNotice: input.request.customerNotice },
            adminRole: input.admin.role
          })
        )
    ]);
  } catch (error) {
    if (await adminWriteWasRevoked(input.db, input.admin, error)) {
      return { ok: false, error: "forbidden" };
    }
    captureBatchWriteFailure(error, {
      component: "settings-customer-notice",
      op: "batch_write_failed"
    });
    return { ok: false, error: "write_failed" };
  }

  return {
    ok: true,
    storeId: input.request.storeId,
    customerNotice: input.request.customerNotice
  };
};
