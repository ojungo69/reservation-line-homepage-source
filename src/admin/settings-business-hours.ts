import { adminWriteGuard, adminWriteWasRevoked } from "./write-authorization";
import type { AdminUser } from "./access";
import { isAdminAllowedForStoreSettings } from "./settings-common";
import { captureBatchWriteFailure } from "../sentry-helpers";

export type BusinessHourRow = {
  weekday: number; // 0=Sun … 6=Sat
  opensAt: string; // "HH:MM"
  closesAt: string; // "HH:MM"
  closed: boolean;
};

type GetResult =
  | { ok: true; businessHours: BusinessHourRow[] }
  | { ok: false; error: string };

export const getBusinessHours = async (
  db: D1Database,
  storeId: string
): Promise<GetResult> => {
  const rows = await db
    .prepare(
      `SELECT weekday, opens_at, closes_at, active
       FROM store_business_hours
       WHERE store_id = ?
       ORDER BY weekday`
    )
    .bind(storeId)
    .all<{ weekday: number; opens_at: string; closes_at: string; active: number }>();

  const byWeekday = new Map(
    (rows.results ?? []).map((r) => [r.weekday, r])
  );

  const businessHours: BusinessHourRow[] = [0, 1, 2, 3, 4, 5, 6].map((weekday) => {
    const r = byWeekday.get(weekday);
    return {
      weekday,
      opensAt: r?.opens_at ?? "10:00",
      closesAt: r?.closes_at ?? "19:00",
      closed: r ? r.active === 0 : false
    };
  });

  return { ok: true, businessHours };
};

export type PutHoursInput = {
  db: D1Database;
  storeId: string;
  actor: AdminUser;
  hours: BusinessHourRow[];
};

type PutResult =
  | { ok: true }
  | { ok: false; error: "forbidden" | "invalid_request" | "store_not_found" | "write_failed" };

const HH_MM_PATTERN = /^\d{2}:\d{2}$/;
const validateHhMm = (s: string): boolean => {
  if (!HH_MM_PATTERN.test(s)) return false;
  const [hh, mm] = s.split(":").map(Number);
  return hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59;
};

function validateHoursRow(rawH: unknown): "invalid_request" | null {
  if (rawH === null || typeof rawH !== "object" || Array.isArray(rawH)) return "invalid_request";
  const h = rawH as Record<string, unknown>;
  if (!Number.isInteger(h.weekday) || (h.weekday as number) < 0 || (h.weekday as number) > 6) return "invalid_request";
  if (typeof h.opensAt !== "string" || typeof h.closesAt !== "string") return "invalid_request";
  if (typeof h.closed !== "boolean") return "invalid_request";
  if (!validateHhMm(h.opensAt) || !validateHhMm(h.closesAt)) return "invalid_request";
  // The DB has CHECK (opens_at < closes_at) so even closed days must
  // carry a valid open < close pair.
  if (h.opensAt >= h.closesAt) return "invalid_request";
  return null;
}

export const putBusinessHours = async (input: PutHoursInput): Promise<PutResult> => {
  if (!isAdminAllowedForStoreSettings(input.actor, input.storeId)) return { ok: false, error: "forbidden" };
  if (!Array.isArray(input.hours) || input.hours.length !== 7) {
    return { ok: false, error: "invalid_request" };
  }
  // Row-level type guards before Set computation (input.hours comes from JSON, may contain null rows).
  for (const rawH of input.hours as unknown[]) {
    const rowError = validateHoursRow(rawH);
    if (rowError) return { ok: false, error: rowError };
  }
  // Weekday 0..6 must each appear exactly once.
  const weekdaySet = new Set(input.hours.map((h) => h.weekday));
  if (weekdaySet.size !== 7) {
    return { ok: false, error: "invalid_request" };
  }

  const storeRow = await input.db
    .prepare("SELECT 1 AS hit FROM stores WHERE id = ? LIMIT 1")
    .bind(input.storeId)
    .first<{ hit: number }>();
  if (!storeRow) return { ok: false, error: "store_not_found" };

  // Audit before/after: this endpoint replaces all 7 rows (DELETE + INSERT),
  // so without a before-snapshot the audit log cannot show what changed —
  // matters more now that store-scoped staff can edit hours too (parity with
  // the closures audit metadata).
  const beforeResult = await getBusinessHours(input.db, input.storeId);
  const beforeHours = beforeResult.ok ? beforeResult.businessHours : null;

  // Reject if any weekday has multiple existing rows — this editor manages
  // single-window-per-day only.  Overwriting multi-window data would silently
  // destroy it, so we surface the conflict instead.
  const multiRow = await input.db
    .prepare(
      `SELECT weekday FROM store_business_hours
       WHERE store_id = ?
       GROUP BY weekday HAVING COUNT(*) > 1
       LIMIT 1`
    )
    .bind(input.storeId)
    .first<{ weekday: number }>();
  if (multiRow) return { ok: false, error: "invalid_request" };

  // D1 does not support ON CONFLICT for ALTER'd unique constraints reliably.
  // Use DELETE + INSERT pattern for upsert.
  const deleteStmt = input.db
    .prepare("DELETE FROM store_business_hours WHERE store_id = ?")
    .bind(input.storeId);

  const insertStmts = input.hours.map((h) =>
    input.db
      .prepare(
        `INSERT INTO store_business_hours (id, store_id, weekday, opens_at, closes_at, active)
         VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?)`
      )
      .bind(input.storeId, h.weekday, h.opensAt, h.closesAt, h.closed ? 0 : 1)
  );

  const auditId = crypto.randomUUID();
  try {
    await input.db.batch([
      adminWriteGuard(input.db, input.actor),
      deleteStmt,
      ...insertStmts,
      input.db
        .prepare(
          `INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, metadata_json)
           VALUES (?, 'staff', ?, 'business_hours.update', 'store', ?, ?)`
        )
        .bind(
          auditId,
          input.actor.id,
          input.storeId,
          JSON.stringify({ before: beforeHours, after: input.hours, adminRole: input.actor.role })
        )
    ]);
  } catch (error) {
    if (await adminWriteWasRevoked(input.db, input.actor, error)) {
      return { ok: false, error: "forbidden" };
    }
    // Transient D1 failure. CHECK-constraint violations are already excluded by
    // validateHoursRow above, so this is a write failure, not bad input —
    // surface a typed error instead of letting an unhandled exception 500.
    captureBatchWriteFailure(error, { component: "settings-business-hours", op: "batch_write_failed" });
    return { ok: false, error: "write_failed" };
  }
  return { ok: true };
};
