/**
 * Customer-facing reservation list domain layer.
 *
 * Owns the data contract for GET /api/public/my-reservations. Formerly
 * src/reservations/change-requests.ts (Phase 3); the change-request feature
 * (customer cancel/reschedule requests) was retired — reschedule on
 * 2026-07-24 (PR#495), cancel on 2026-08-01 — so this module now only lists
 * reservations. The response shape is kept contract-compatible with the
 * retired feature so LIFF clients loaded before a deploy keep working:
 * `pendingChangeRequest` is always null, `historyCount` is always 0, and
 * `requestable` reports both actions as permanently closed.
 */

export type ChangeRequestType = "cancel" | "reschedule";

export type MyReservationRow = {
  id: string;
  storeId: string;
  storeName: string;
  storeTimezone: string;
  resourceId: string;
  resourceName: string;
  serviceId: string;
  serviceName: string;
  durationMinutes: number;
  startAt: string;
  endAt: string;
  status: "pending_approval" | "confirmed";
  pendingChangeRequest: null | {
    id: string;
    type: ChangeRequestType;
    requestedStartAt: string | null;
    createdAt: string;
  };
  historyCount: number;
  requestable: {
    cancel: { allowed: boolean; reason?: string };
    reschedule: { allowed: boolean; reason?: string };
  };
};

type MyReservationDbRow = {
  id: string;
  store_id: string;
  store_name: string;
  store_timezone: string;
  resource_id: string;
  resource_name: string;
  service_id: string;
  service_name: string;
  duration_minutes: number;
  start_at: string;
  end_at: string;
  status: "pending_approval" | "confirmed";
};

export const listMyReservations = async (
  db: D1Database,
  input: { lineIdentityId: string; nowIso: string; limit?: number }
): Promise<MyReservationRow[]> => {
  const limit = Math.min(Math.max(input.limit ?? 30, 1), 100);
  const rows = await db
    .prepare(
      `
        SELECT
          r.id                              AS id,
          r.store_id                        AS store_id,
          stores.name                       AS store_name,
          stores.timezone                   AS store_timezone,
          r.resource_id                     AS resource_id,
          store_resources.name              AS resource_name,
          r.service_id                      AS service_id,
          services.name                     AS service_name,
          r.duration_minutes                AS duration_minutes,
          r.start_at                        AS start_at,
          r.end_at                          AS end_at,
          r.status                          AS status
        FROM reservations r
        JOIN stores            ON stores.id = r.store_id
        JOIN store_resources   ON store_resources.id = r.resource_id
        JOIN services          ON services.id = r.service_id
        WHERE (
          r.line_identity_id = ?
          OR (
            r.line_identity_id IS NULL
            AND r.source IN ('phone_admin', 'admin')
            AND EXISTS (
              SELECT 1 FROM line_identities li
              WHERE li.id = ? AND li.customer_id = r.customer_id
            )
          )
        )
          AND r.status IN ('pending_approval', 'confirmed')
          AND r.end_at > ?
        ORDER BY r.start_at ASC
        LIMIT ?
      `
    )
    .bind(input.lineIdentityId, input.lineIdentityId, input.nowIso, limit)
    .all<MyReservationDbRow>();

  return (rows.results ?? []).map((row) => ({
    id: row.id,
    storeId: row.store_id,
    storeName: row.store_name,
    storeTimezone: row.store_timezone,
    resourceId: row.resource_id,
    resourceName: row.resource_name,
    serviceId: row.service_id,
    serviceName: row.service_name,
    durationMinutes: row.duration_minutes,
    startAt: row.start_at,
    endAt: row.end_at,
    status: row.status,
    // Retired-feature compatibility: stale LIFF bundles read these fields to
    // decide whether to render request buttons/banners — permanently closed.
    pendingChangeRequest: null,
    historyCount: 0,
    requestable: {
      cancel: { allowed: false, reason: "cancel_requests_closed" },
      reschedule: { allowed: false, reason: "reschedule_requests_closed" }
    }
  }));
};
