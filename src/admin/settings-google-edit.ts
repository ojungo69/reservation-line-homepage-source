import { adminWriteGuard, adminWriteWasRevoked } from "./write-authorization";
import type { AdminUser } from "./access";
import { safeCaptureException } from "../sentry-helpers";
import { isAdminPrivileged, MAX_ID_LENGTH, storeExists, trimAndCap } from "./settings-common";

export type AdminGoogleEditModeUpdateRequest = {
  storeId: string;
  enabled: boolean;
};

export type AdminGoogleEditModeUpdateError =
  | "forbidden"
  | "invalid_request"
  | "store_not_found"
  | "missing_database"
  | "write_failed";

export type AdminGoogleEditModeUpdateResult =
  | { ok: true; storeId: string; enabled: boolean }
  | { ok: false; error: AdminGoogleEditModeUpdateError };

export const parseAdminGoogleEditModeUpdateRequest = (
  body: unknown
): AdminGoogleEditModeUpdateRequest | null => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const raw = body as Record<string, unknown>;
  const storeId = trimAndCap(raw.storeId, MAX_ID_LENGTH);
  if (!storeId) return null;
  if (typeof raw.enabled !== "boolean") return null;
  return { storeId, enabled: raw.enabled };
};

const fetchCurrentMode = async (
  db: D1Database,
  storeId: string
): Promise<boolean> => {
  const row = await db
    .prepare(
      `SELECT google_controlled_edit_mode AS mode
       FROM store_settings
       WHERE store_id = ?`
    )
    .bind(storeId)
    .first<{ mode: number | null }>();
  return row?.mode === 1;
};

export const updateAdminGoogleEditMode = async (input: {
  db: D1Database;
  admin: AdminUser;
  request: AdminGoogleEditModeUpdateRequest;
  now?: () => number;
}): Promise<AdminGoogleEditModeUpdateResult> => {
  if (!isAdminPrivileged(input.admin.role)) {
    return { ok: false, error: "forbidden" };
  }
  if (!(await storeExists(input.db, input.request.storeId))) {
    return { ok: false, error: "store_not_found" };
  }

  const nowIso = new Date((input.now ?? Date.now)()).toISOString();
  const beforeEnabled = await fetchCurrentMode(input.db, input.request.storeId);
  const modeInt = input.request.enabled ? 1 : 0;

  try {
    await input.db.batch([
      adminWriteGuard(input.db, input.admin),
      input.db
        .prepare(
          `INSERT INTO store_settings (
             store_id, google_controlled_edit_mode, max_active_reservations_per_customer, updated_at
           ) VALUES (?, ?, 1, ?)
           ON CONFLICT(store_id) DO UPDATE SET
             google_controlled_edit_mode = excluded.google_controlled_edit_mode,
             updated_at = excluded.updated_at`
        )
        .bind(input.request.storeId, modeInt, nowIso),
      input.db
        .prepare(
          `INSERT INTO audit_logs (
             id, actor_type, actor_id, action, target_type, target_id, metadata_json
           ) VALUES (?, 'staff', ?, 'settings.google_edit_mode.update', 'store', ?, ?)`
        )
        .bind(
          crypto.randomUUID(),
          input.admin.id,
          input.request.storeId,
          JSON.stringify({
            storeId: input.request.storeId,
            before: { enabled: beforeEnabled },
            after: { enabled: input.request.enabled },
            adminRole: input.admin.role
          })
        )
    ]);
  } catch (error) {
    if (await adminWriteWasRevoked(input.db, input.admin, error)) {
      return { ok: false, error: "forbidden" };
    }
    safeCaptureException(error instanceof Error ? error : new Error(String(error)), {
      tags: { component: "google-edit-mode", op: "batch_failed" },
      contexts: { update: { storeId: input.request.storeId } }
    });
    console.error("updateAdminGoogleEditMode batch failed", {
      storeId: input.request.storeId,
      error: error instanceof Error ? error.message : String(error)
    });
    return { ok: false, error: "write_failed" };
  }

  return {
    ok: true,
    storeId: input.request.storeId,
    enabled: input.request.enabled
  };
};
