import { adminWriteGuard, adminWriteWasRevoked } from "./write-authorization";
import type { AdminUser } from "./access";
import { isAdminPrivileged, MAX_ID_LENGTH, storeExists, trimAndCap } from "./settings-common";
import { captureBatchWriteFailure } from "../sentry-helpers";

// Per-store cap on how many active *future* reservations a single customer may
// hold via PUBLIC web bookings. The cap is enforced atomically at insert time by
// trg_reservations_web_cap (migrations/0024); this endpoint only edits the
// configured value (store_settings.max_active_reservations_per_customer).
//
// Range 1..50 mirrors the CHECK constraint in migration 0024 — the two must move
// together to keep the API contract and the schema in sync. The UPSERT keeps the
// singleton store_settings invariant (a freshly bootstrapped store may have no
// row yet), exactly like settings-reminder / settings-google-edit. PUT omits
// idempotencyKey the same way the other settings PUT routes do.

const MIN_CAP = 1;
const MAX_CAP = 50;
// Effective cap when a store has no store_settings row yet. Mirrors the current
// trigger/application fallback established by migration 0045.
const DEFAULT_CAP = 1;

export type AdminReservationCapUpdateRequest = {
  storeId: string;
  maxActiveReservationsPerCustomer: number;
};

export type AdminReservationCapUpdateError =
  | "forbidden"
  | "invalid_request"
  | "store_not_found"
  | "missing_database"
  | "write_failed";

export type AdminReservationCapUpdateResult =
  | { ok: true; storeId: string; maxActiveReservationsPerCustomer: number }
  | { ok: false; error: AdminReservationCapUpdateError };

const INVALID_CAP = Symbol("invalid_cap");

const parseCap = (value: unknown): number | typeof INVALID_CAP => {
  if (typeof value !== "number" || !Number.isInteger(value)) return INVALID_CAP;
  if (value < MIN_CAP || value > MAX_CAP) return INVALID_CAP;
  return value;
};

export const parseReservationCapUpdateRequest = (
  body: unknown
): AdminReservationCapUpdateRequest | null => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const raw = body as Record<string, unknown>;
  const storeId = trimAndCap(raw.storeId, MAX_ID_LENGTH);
  if (!storeId) return null;
  // The cap must be explicit — a partial PUT body must not silently reset it.
  if (!Object.hasOwn(raw, "maxActiveReservationsPerCustomer")) return null;
  const cap = parseCap(raw.maxActiveReservationsPerCustomer);
  if (cap === INVALID_CAP) return null;
  return { storeId, maxActiveReservationsPerCustomer: cap };
};

type CapRow = { cap: number | null };

// Returns the EFFECTIVE prior cap: the configured value, or DEFAULT_CAP when no
// store_settings row exists (matching what the trigger enforced before this edit),
// so the audit-log `before` reflects what was actually in force rather than null.
const fetchCurrentCap = async (db: D1Database, storeId: string): Promise<number> => {
  const row = await db
    .prepare(
      `SELECT max_active_reservations_per_customer AS cap
       FROM store_settings
       WHERE store_id = ?`
    )
    .bind(storeId)
    .first<CapRow>();
  return row?.cap ?? DEFAULT_CAP;
};

export const updateAdminReservationCapSettings = async (input: {
  db: D1Database;
  admin: AdminUser;
  request: AdminReservationCapUpdateRequest;
  now?: () => number;
}): Promise<AdminReservationCapUpdateResult> => {
  if (!isAdminPrivileged(input.admin.role)) {
    return { ok: false, error: "forbidden" };
  }
  if (!(await storeExists(input.db, input.request.storeId))) {
    return { ok: false, error: "store_not_found" };
  }

  const nowIso = new Date((input.now ?? Date.now)()).toISOString();
  const beforeCap = await fetchCurrentCap(input.db, input.request.storeId);

  try {
    await input.db.batch([
      adminWriteGuard(input.db, input.admin),
      // UPSERT — preserves the singleton invariant and the CREATE TABLE defaults
      // for reservation_approval_mode / google_controlled_edit_mode on first insert.
      input.db
        .prepare(
          `INSERT INTO store_settings (
             store_id, max_active_reservations_per_customer, updated_at
           ) VALUES (?, ?, ?)
           ON CONFLICT(store_id) DO UPDATE SET
             max_active_reservations_per_customer = excluded.max_active_reservations_per_customer,
             updated_at = excluded.updated_at`
        )
        .bind(input.request.storeId, input.request.maxActiveReservationsPerCustomer, nowIso),
      input.db
        .prepare(
          `INSERT INTO audit_logs (
             id, actor_type, actor_id, action, target_type, target_id, metadata_json
           ) VALUES (?, 'staff', ?, 'settings.reservation_cap.update', 'store', ?, ?)`
        )
        .bind(
          crypto.randomUUID(),
          input.admin.id,
          input.request.storeId,
          JSON.stringify({
            storeId: input.request.storeId,
            before: { maxActiveReservationsPerCustomer: beforeCap },
            after: { maxActiveReservationsPerCustomer: input.request.maxActiveReservationsPerCustomer },
            adminRole: input.admin.role
          })
        )
    ]);
  } catch (error) {
    if (await adminWriteWasRevoked(input.db, input.admin, error)) {
      return { ok: false, error: "forbidden" };
    }
    console.error("updateAdminReservationCapSettings batch failed", {
      storeId: input.request.storeId,
      error: error instanceof Error ? error.message : String(error)
    });
    captureBatchWriteFailure(error, {
      component: "settings-reservation-cap",
      op: "batch_write_failed",
      helper: "updateAdminReservationCapSettings"
    });
    return { ok: false, error: "write_failed" };
  }

  return {
    ok: true,
    storeId: input.request.storeId,
    maxActiveReservationsPerCustomer: input.request.maxActiveReservationsPerCustomer
  };
};
