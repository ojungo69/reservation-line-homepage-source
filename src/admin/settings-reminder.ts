import { adminWriteGuard, adminWriteWasRevoked } from "./write-authorization";
import type { AdminUser } from "./access";
import { isAdminPrivileged, MAX_ID_LENGTH, storeExists, trimAndCap } from "./settings-common";

// Tier C.3 4d — singleton per-store reminder offset settings.
//
// store_settings is keyed by store_id (PRIMARY KEY) and is conceptually
// one-row-per-store. There is no batching or bulk shape here — just a single
// numeric column that the Phase 2 reminder dispatcher will read to decide how
// many minutes before reservations.start_at to enqueue a reservation_reminder
// notification_jobs row. NULL = reminder disabled for the store.
//
// The endpoint uses an UPSERT (INSERT ... ON CONFLICT(store_id) DO UPDATE)
// because store_settings rows are only seeded for known stores (seeds/dev.sql)
// and a freshly-bootstrapped production store might not have a row yet. The
// UPSERT keeps the singleton invariant whether or not the row exists.
//
// PUT is HTTP-idempotent and the SPEC idempotency_keys contract only mandates
// `idempotencyKey` for admin POST routes; PUT settings updates omit it the
// same way settings-services / settings-resources / settings-staff PUTs do.

const MIN_OFFSET_MINUTES = 0;
// 72h before reservation. Aligns with the CHECK constraint in
// migrations/0015_store_settings_reminder.sql; the two must move together
// to keep the API contract and the schema in sync.
const MAX_OFFSET_MINUTES = 72 * 60;

export type AdminReminderUpdateRequest = {
  storeId: string;
  offsetMinutes: number | null;
};

export type AdminReminderUpdateError =
  | "forbidden"
  | "invalid_request"
  | "store_not_found"
  | "missing_database"
  | "write_failed";

export type AdminReminderUpdateResult =
  | { ok: true; storeId: string; offsetMinutes: number | null }
  | { ok: false; error: AdminReminderUpdateError };

const INVALID_OFFSET = Symbol("invalid_offset");

const parseOffsetMinutes = (value: unknown): number | null | typeof INVALID_OFFSET => {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) return INVALID_OFFSET;
  if (value < MIN_OFFSET_MINUTES || value > MAX_OFFSET_MINUTES) return INVALID_OFFSET;
  return value;
};

export const parseAdminReminderUpdateRequest = (
  body: unknown
): AdminReminderUpdateRequest | null => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const raw = body as Record<string, unknown>;
  const storeId = trimAndCap(raw.storeId, MAX_ID_LENGTH);
  if (!storeId) return null;
  // offsetMinutes must be explicit — silently defaulting null on omission would
  // make a partial PUT body accidentally clear the saved reminder offset.
  if (!Object.hasOwn(raw, "offsetMinutes")) return null;
  const offsetMinutes = parseOffsetMinutes(raw.offsetMinutes);
  if (offsetMinutes === INVALID_OFFSET) return null;
  return { storeId, offsetMinutes };
};

type ReminderRow = { offset: number | null };

const fetchCurrentOffset = async (
  db: D1Database,
  storeId: string
): Promise<number | null> => {
  const row = await db
    .prepare(
      `SELECT reservation_reminder_offset_minutes AS offset
       FROM store_settings
       WHERE store_id = ?`
    )
    .bind(storeId)
    .first<ReminderRow>();
  return row?.offset ?? null;
};

export const updateAdminReminderSettings = async (input: {
  db: D1Database;
  admin: AdminUser;
  request: AdminReminderUpdateRequest;
  now?: () => number;
}): Promise<AdminReminderUpdateResult> => {
  if (!isAdminPrivileged(input.admin.role)) {
    return { ok: false, error: "forbidden" };
  }
  if (!(await storeExists(input.db, input.request.storeId))) {
    return { ok: false, error: "store_not_found" };
  }

  const nowIso = new Date((input.now ?? Date.now)()).toISOString();
  const beforeOffset = await fetchCurrentOffset(input.db, input.request.storeId);

  try {
    await input.db.batch([
      adminWriteGuard(input.db, input.admin),
      // UPSERT — store_settings rows are seeded per environment but a
      // freshly-bootstrapped store may not have one yet. Initialize the reservation
      // cap explicitly when this is the first setting written for a store.
      input.db
        .prepare(
          `INSERT INTO store_settings (
             store_id, reservation_reminder_offset_minutes, max_active_reservations_per_customer, updated_at
           ) VALUES (?, ?, 1, ?)
           ON CONFLICT(store_id) DO UPDATE SET
             reservation_reminder_offset_minutes = excluded.reservation_reminder_offset_minutes,
             updated_at = excluded.updated_at`
        )
        .bind(input.request.storeId, input.request.offsetMinutes, nowIso),
      input.db
        .prepare(
          `INSERT INTO audit_logs (
             id, actor_type, actor_id, action, target_type, target_id, metadata_json
           ) VALUES (?, 'staff', ?, 'settings.reminder.update', 'store', ?, ?)`
        )
        .bind(
          crypto.randomUUID(),
          input.admin.id,
          input.request.storeId,
          JSON.stringify({
            storeId: input.request.storeId,
            before: { offsetMinutes: beforeOffset },
            after: { offsetMinutes: input.request.offsetMinutes },
            adminRole: input.admin.role
          })
        )
    ]);
  } catch (error) {
    if (await adminWriteWasRevoked(input.db, input.admin, error)) {
      return { ok: false, error: "forbidden" };
    }
    console.error("updateAdminReminderSettings batch failed", {
      storeId: input.request.storeId,
      error: error instanceof Error ? error.message : String(error)
    });
    return { ok: false, error: "write_failed" };
  }

  return {
    ok: true,
    storeId: input.request.storeId,
    offsetMinutes: input.request.offsetMinutes
  };
};
