import { adminWriteGuard, adminWriteWasRevoked } from "./write-authorization";
import type { AdminUser } from "./access";
import { isAdminPrivileged, MAX_ID_LENGTH, storeExists, trimAndCap } from "./settings-common";

// Per-store PUBLIC booking window: how many days ahead a customer may book on the
// reservation page. This endpoint only edits the configured value
// (store_settings.booking_window_days); the window is enforced server-side per
// request by listPublicAvailability (src/reservations/public-options.ts) and the
// booking UI date dropdown reads the same per-store value via the options
// endpoint, so client and server can never desync on the window length.
//
// Range 1..90 mirrors the CHECK constraint in migration 0032 — the two must move
// together to keep the API contract and the schema in sync. Bounded at 90 so the
// per-day Google freeBusy availability checks never exceed the prior query budget.
//
// The UPSERT keeps the singleton store_settings invariant (a freshly bootstrapped
// store may have no row yet) and preserves the other columns' CREATE TABLE /
// migration defaults on first insert, exactly like settings-reservation-cap /
// settings-reminder. PUT omits idempotencyKey the same way the other settings PUT
// routes do.

const MIN_WINDOW_DAYS = 1;
const MAX_WINDOW_DAYS = 90;
// Effective window when a store has no store_settings row yet. Mirrors the column
// DEFAULT in migrations/0032 and the COALESCE(..., 30) fallback at every read site.
const DEFAULT_WINDOW_DAYS = 30;

export type AdminBookingWindowUpdateRequest = {
  storeId: string;
  bookingWindowDays: number;
};

export type AdminBookingWindowUpdateError =
  | "forbidden"
  | "invalid_request"
  | "store_not_found"
  | "missing_database"
  | "write_failed";

export type AdminBookingWindowUpdateResult =
  | { ok: true; storeId: string; bookingWindowDays: number }
  | { ok: false; error: AdminBookingWindowUpdateError };

const INVALID_WINDOW = Symbol("invalid_window");

const parseWindow = (value: unknown): number | typeof INVALID_WINDOW => {
  if (typeof value !== "number" || !Number.isInteger(value)) return INVALID_WINDOW;
  if (value < MIN_WINDOW_DAYS || value > MAX_WINDOW_DAYS) return INVALID_WINDOW;
  return value;
};

export const parseBookingWindowUpdateRequest = (
  body: unknown
): AdminBookingWindowUpdateRequest | null => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const raw = body as Record<string, unknown>;
  const storeId = trimAndCap(raw.storeId, MAX_ID_LENGTH);
  if (!storeId) return null;
  // The window must be explicit — a partial PUT body must not silently reset it.
  if (!Object.hasOwn(raw, "bookingWindowDays")) return null;
  const days = parseWindow(raw.bookingWindowDays);
  if (days === INVALID_WINDOW) return null;
  return { storeId, bookingWindowDays: days };
};

type WindowRow = { days: number | null };

// Returns the EFFECTIVE prior window: the configured value, or DEFAULT_WINDOW_DAYS
// when no store_settings row exists (matching what the availability endpoint
// enforced before this edit), so the audit-log `before` reflects what was actually
// in force rather than null.
const fetchCurrentWindow = async (db: D1Database, storeId: string): Promise<number> => {
  const row = await db
    .prepare(
      `SELECT booking_window_days AS days
       FROM store_settings
       WHERE store_id = ?`
    )
    .bind(storeId)
    .first<WindowRow>();
  return row?.days ?? DEFAULT_WINDOW_DAYS;
};

export const updateAdminBookingWindowSettings = async (input: {
  db: D1Database;
  admin: AdminUser;
  request: AdminBookingWindowUpdateRequest;
  now?: () => number;
}): Promise<AdminBookingWindowUpdateResult> => {
  if (!isAdminPrivileged(input.admin.role)) {
    return { ok: false, error: "forbidden" };
  }
  if (!(await storeExists(input.db, input.request.storeId))) {
    return { ok: false, error: "store_not_found" };
  }

  const nowIso = new Date((input.now ?? Date.now)()).toISOString();
  const beforeDays = await fetchCurrentWindow(input.db, input.request.storeId);

  try {
    await input.db.batch([
      adminWriteGuard(input.db, input.admin),
      // UPSERT — preserves the singleton invariant and initializes the reservation
      // cap explicitly when this is the first setting written for a store.
      input.db
        .prepare(
          `INSERT INTO store_settings (
             store_id, booking_window_days, max_active_reservations_per_customer, updated_at
           ) VALUES (?, ?, 1, ?)
           ON CONFLICT(store_id) DO UPDATE SET
             booking_window_days = excluded.booking_window_days,
             updated_at = excluded.updated_at`
        )
        .bind(input.request.storeId, input.request.bookingWindowDays, nowIso),
      input.db
        .prepare(
          `INSERT INTO audit_logs (
             id, actor_type, actor_id, action, target_type, target_id, metadata_json
           ) VALUES (?, 'staff', ?, 'settings.booking_window.update', 'store', ?, ?)`
        )
        .bind(
          crypto.randomUUID(),
          input.admin.id,
          input.request.storeId,
          JSON.stringify({
            storeId: input.request.storeId,
            before: { bookingWindowDays: beforeDays },
            after: { bookingWindowDays: input.request.bookingWindowDays },
            adminRole: input.admin.role
          })
        )
    ]);
  } catch (error) {
    if (await adminWriteWasRevoked(input.db, input.admin, error)) {
      return { ok: false, error: "forbidden" };
    }
    console.error("updateAdminBookingWindowSettings batch failed", {
      storeId: input.request.storeId,
      error: error instanceof Error ? error.message : String(error)
    });
    return { ok: false, error: "write_failed" };
  }

  return {
    ok: true,
    storeId: input.request.storeId,
    bookingWindowDays: input.request.bookingWindowDays
  };
};
