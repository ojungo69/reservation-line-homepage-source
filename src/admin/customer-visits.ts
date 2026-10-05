import type { AdminUser } from "./access";
import { captureBatchWriteFailure, safeCaptureException } from "../sentry-helpers";
import { jstDayRangeFromKey, jstDayKey } from "./shared";
import { isNonEmptyString, toIso } from "./reservation-time-utils";
import {
  IDEMPOTENCY_TTL_MS,
  fetchAdminActionIdempotency,
  sha256Hex,
  startedIdempotencyStatement,
  type IdempotencyRow,
} from "./settings-common";
import { adminWriteGuard, adminWriteWasRevoked } from "./write-authorization";

export type AdminAddCustomerVisitRequest = {
  idempotencyKey: string;
  visitedAt: string;
  storeId: string;
  treatmentNotes?: string | null;
};

type AdminAddCustomerVisitFailureReason =
  | "forbidden"
  | "invalid_request"
  | "invalid_visit_date"
  | "future_visit_date"
  | "notes_too_long"
  | "invalid_store"
  | "not_found"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "write_failed";

export type AdminAddCustomerVisitResult =
  | { ok: true; visitId: string; replayed: boolean }
  | { ok: false; reason: AdminAddCustomerVisitFailureReason };

const createRequestHash = (input: {
  customerId: string;
  visitedAt: string;
  storeId: string;
  treatmentNotes: string | null;
}) =>
  sha256Hex(
    JSON.stringify({
      action: "add_visit",
      customerId: input.customerId,
      visitedAt: input.visitedAt,
      storeId: input.storeId,
      treatmentNotes: input.treatmentNotes,
    })
  );

const successResult = (visitId: string, replayed: boolean): AdminAddCustomerVisitResult => ({
  ok: true,
  visitId,
  replayed,
});

const mapBatchError = (): AdminAddCustomerVisitResult => ({ ok: false, reason: "write_failed" });

const resolveIdempotency = (
  idempotency: IdempotencyRow | null,
  requestHash: string
): AdminAddCustomerVisitResult | undefined => {
  if (!idempotency) return undefined;
  if (idempotency.request_hash !== requestHash) {
    return { ok: false, reason: "idempotency_conflict" };
  }
  if (idempotency.status === "succeeded" && idempotency.target_id) {
    return successResult(idempotency.target_id, true);
  }
  return { ok: false, reason: "idempotency_in_progress" };
};

const resolveBatchFailure = async (
  db: D1Database,
  idempotencyKey: string,
  requestHash: string,
  nowIso: string
): Promise<AdminAddCustomerVisitResult> => {
  try {
    const concurrent = await fetchAdminActionIdempotency(db, idempotencyKey, nowIso);
    return resolveIdempotency(concurrent, requestHash) ?? mapBatchError();
  } catch (lookupError) {
    // Same read-path distinction as updateAdminCustomerVisit's recovery: the
    // idempotency re-read failing is a different incident than the batch write.
    captureBatchWriteFailure(lookupError, {
      component: "customer-visits",
      op: "idempotency_lookup_failed",
      helper: "resolveBatchFailure"
    });
    return mapBatchError();
  }
};

type AddVisitValidation =
  | { ok: false; reason: AdminAddCustomerVisitFailureReason }
  | { ok: true; trimmedNotes: string | null };

// Pure request validation (shape, notes length, round-trip JST date) split out
// so addAdminCustomerVisit's orchestration stays under the cognitive-complexity
// budget. Returns the normalized notes on success.
const validateAddVisitRequest = (
  customerId: string,
  request: AdminAddCustomerVisitRequest,
  nowMs: number
): AddVisitValidation => {
  const notes = request.treatmentNotes;
  if (
    !isNonEmptyString(customerId, 128) ||
    !isNonEmptyString(request.idempotencyKey, 256) ||
    !isNonEmptyString(request.storeId, 64) ||
    (notes !== undefined && notes !== null && typeof notes !== "string")
  ) {
    return { ok: false, reason: "invalid_request" };
  }

  const trimmedNotes = typeof notes === "string" ? notes.trim() || null : null;
  if (trimmedNotes !== null && trimmedNotes.length > 2000) {
    return { ok: false, reason: "notes_too_long" };
  }

  // Round-trip JST date validation (not just the YYYY-MM-DD regex): rejects
  // impossible dates like 2026-02-31 / 2025-99-99 that would otherwise be stored
  // as a valid visit and pollute valid_visit_count. (codex blocking)
  if (!jstDayRangeFromKey(request.visitedAt)) {
    return { ok: false, reason: "invalid_visit_date" };
  }
  if (request.visitedAt > jstDayKey(nowMs)) {
    // String compare is safe for zero-padded YYYY-MM-DD keys.
    return { ok: false, reason: "future_visit_date" };
  }

  return { ok: true, trimmedNotes };
};

export async function addAdminCustomerVisit(input: {
  db: D1Database;
  admin: AdminUser;
  customerId: string;
  request: AdminAddCustomerVisitRequest;
  now?: () => number;
}): Promise<AdminAddCustomerVisitResult> {
  if (input.admin.role === "staff") {
    return { ok: false, reason: "forbidden" };
  }

  // Single clock stamps expires_at on write AND filters the TTL read.
  const nowMs = (input.now ?? Date.now)();
  const nowIso = toIso(new Date(nowMs));

  const validated = validateAddVisitRequest(input.customerId, input.request, nowMs);
  if (!validated.ok) {
    return { ok: false, reason: validated.reason };
  }
  const trimmedNotes = validated.trimmedNotes;

  const requestHash = await createRequestHash({
    customerId: input.customerId,
    visitedAt: input.request.visitedAt,
    storeId: input.request.storeId,
    treatmentNotes: trimmedNotes,
  });

  const idempotency = await fetchAdminActionIdempotency(input.db, input.request.idempotencyKey, nowIso);
  const idempotencyResult = resolveIdempotency(idempotency, requestHash);
  if (idempotencyResult) return idempotencyResult;

  const customer = await input.db
    .prepare("SELECT 1 AS hit FROM customers WHERE id = ? AND merged_into_id IS NULL AND archived_at IS NULL LIMIT 1")
    .bind(input.customerId)
    .first<{ hit: number }>();
  if (!customer) {
    return { ok: false, reason: "not_found" };
  }

  const store = await input.db
    .prepare("SELECT 1 AS hit FROM stores WHERE id = ? LIMIT 1")
    .bind(input.request.storeId)
    .first<{ hit: number }>();
  if (!store) {
    return { ok: false, reason: "invalid_store" };
  }

  const visitId = crypto.randomUUID();
  const idempotencyId = crypto.randomUUID();
  // Fixed audit id so the idempotency success-flip can be gated on the audit row
  // actually existing (it is only inserted when the visit INSERT changed a row).
  const auditId = crypto.randomUUID();
  const expiresAt = toIso(new Date(nowMs + IDEMPOTENCY_TTL_MS));

  try {
    const batchResult = await input.db.batch([
      adminWriteGuard(input.db, input.admin),
      startedIdempotencyStatement({
        db: input.db,
        id: idempotencyId,
        key: input.request.idempotencyKey,
        requestHash,
        expiresAt,
        nowIso,
      }),
      input.db
        .prepare(
          `
            INSERT INTO customer_visits (
              id,
              customer_id,
              reservation_id,
              store_id,
              visited_at,
              visit_source,
              status,
              recorded_by,
              treatment_notes
            )
            SELECT ?, ?, NULL, ?, ?, 'manual_import', 'valid', ?, ?
            WHERE EXISTS (
              SELECT 1 FROM customers
              WHERE id = ? AND merged_into_id IS NULL AND archived_at IS NULL
            )
          `
        )
        .bind(
          visitId,
          input.customerId,
          input.request.storeId,
          input.request.visitedAt,
          input.admin.id,
          trimmedNotes,
          input.customerId
        ),
      input.db
        .prepare(
          `
            INSERT INTO audit_logs (
              id, actor_type, actor_id, action, target_type, target_id, metadata_json
            )
            SELECT ?, 'staff', ?, 'customer.visit_manual_add', 'customer_visit', ?, ?
            WHERE changes() = 1
          `
        )
        .bind(
          auditId,
          input.admin.id,
          visitId,
          JSON.stringify({
            customer_id: input.customerId,
            store_id: input.request.storeId,
            visited_at: input.request.visitedAt,
            notes_length: trimmedNotes?.length ?? 0,
            admin_role: input.admin.role,
          })
        ),
      input.db
        .prepare(
          `
            UPDATE idempotency_keys
            SET status = 'succeeded',
                target_type = 'customer_visit',
                target_id = ?,
                updated_at = ?
            WHERE id = ?
              AND EXISTS (SELECT 1 FROM audit_logs WHERE id = ?)
          `
        )
        .bind(visitId, nowIso, idempotencyId, auditId),
    ]);
    // The visit INSERT is conditional on the customer still being active; a
    // concurrent archive/merge landing between the pre-check and this batch
    // matches 0 rows. The audit INSERT (changes()=1 guard) and the idempotency
    // success-flip (EXISTS audit row) are both skipped, so the idempotency row
    // stays 'started' — a same-key replay returns idempotency_in_progress, never
    // a false ok — and we report not_found to the live caller.
    if (Number(batchResult[2]?.meta?.changes ?? 0) !== 1) {
      return { ok: false, reason: "not_found" };
    }
  } catch (error) {
    if (await adminWriteWasRevoked(input.db, input.admin, error)) {
      return { ok: false, reason: "forbidden" };
    }
    const result = await resolveBatchFailure(input.db, input.request.idempotencyKey, requestHash, nowIso);
    if (!result.ok && result.reason === "write_failed") {
      captureBatchWriteFailure(error, {
        component: "customer-visits",
        op: "batch_write_failed",
        helper: "addAdminCustomerVisit"
      });
    }
    return result;
  }

  return successResult(visitId, false);
}

// ── 来店履歴の編集（来店日）/ 削除 ─────────────────────────────────────────
// owner+ のみ。手動 visit (reservation_id IS NULL) だけを対象にし、予約由来の
// 完了 visit (reservation_id NOT NULL) は保護する — 予約由来の来店履歴は予約側で
// 管理され、Google「新規予約」タイトルの自己除外サブクエリや valid_visit_count の
// 整合に依存するため、編集/削除させない。UPDATE/DELETE の WHERE 句にも
// `reservation_id IS NULL` を入れて、事前チェックとの間の TOCTOU でも予約由来
// visit を絶対に触らないようにする（pre-check と WHERE の二重ガード）。

export type AdminUpdateCustomerVisitRequest = {
  idempotencyKey: string;
  visitedAt: string;
};

type AdminUpdateCustomerVisitFailureReason =
  | "forbidden"
  | "invalid_request"
  | "invalid_visit_date"
  | "future_visit_date"
  | "not_found"
  | "reservation_linked"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "write_failed";

export type AdminUpdateCustomerVisitResult =
  | { ok: true; visitId: string; replayed: boolean }
  | { ok: false; reason: AdminUpdateCustomerVisitFailureReason };

export type AdminDeleteCustomerVisitResult =
  | { ok: true }
  | {
      ok: false;
      reason: "forbidden" | "invalid_request" | "not_found" | "reservation_linked" | "write_failed";
    };

const resolveUpdateIdempotency = (
  idempotency: IdempotencyRow | null,
  requestHash: string
): AdminUpdateCustomerVisitResult | undefined => {
  if (!idempotency) return undefined;
  if (idempotency.request_hash !== requestHash) {
    return { ok: false, reason: "idempotency_conflict" };
  }
  if (idempotency.status === "succeeded" && idempotency.target_id) {
    return { ok: true, visitId: idempotency.target_id, replayed: true };
  }
  return { ok: false, reason: "idempotency_in_progress" };
};

export async function updateAdminCustomerVisit(input: {
  db: D1Database;
  admin: AdminUser;
  customerId: string;
  visitId: string;
  request: AdminUpdateCustomerVisitRequest;
  now?: () => number;
}): Promise<AdminUpdateCustomerVisitResult> {
  if (input.admin.role === "staff") {
    return { ok: false, reason: "forbidden" };
  }
  if (
    !isNonEmptyString(input.customerId, 128) ||
    !isNonEmptyString(input.visitId, 128) ||
    !isNonEmptyString(input.request.idempotencyKey, 256)
  ) {
    return { ok: false, reason: "invalid_request" };
  }

  const nowMs = (input.now ?? Date.now)();
  const nowIso = toIso(new Date(nowMs));

  // Same round-trip + not-future validation as addAdminCustomerVisit (rejects
  // impossible dates like 2026-02-31 that the YYYY-MM-DD regex alone would pass).
  if (!jstDayRangeFromKey(input.request.visitedAt)) {
    return { ok: false, reason: "invalid_visit_date" };
  }
  if (input.request.visitedAt > jstDayKey(nowMs)) {
    return { ok: false, reason: "future_visit_date" };
  }

  const requestHash = await sha256Hex(
    JSON.stringify({
      action: "update_visit",
      customerId: input.customerId,
      visitId: input.visitId,
      visitedAt: input.request.visitedAt,
    })
  );

  const idempotency = await fetchAdminActionIdempotency(input.db, input.request.idempotencyKey, nowIso);
  const idempotencyResult = resolveUpdateIdempotency(idempotency, requestHash);
  if (idempotencyResult) return idempotencyResult;

  // archived/merged 顧客の来店履歴は変更不可 (memo/profile と同じ不変条件)。
  // pre-check で早期 404、UPDATE の WHERE にも同条件を入れて pre-check→write の
  // TOCTOU archive レースでも 0 行更新 → not_found に落とす二重ガード。
  const visit = await input.db
    .prepare(
      `SELECT reservation_id FROM customer_visits
       WHERE id = ? AND customer_id = ?
         AND EXISTS (
           SELECT 1 FROM customers c
           WHERE c.id = customer_visits.customer_id
             AND c.merged_into_id IS NULL
             AND c.archived_at IS NULL
         )
       LIMIT 1`
    )
    .bind(input.visitId, input.customerId)
    .first<{ reservation_id: string | null }>();
  if (!visit) {
    return { ok: false, reason: "not_found" };
  }
  if (visit.reservation_id !== null) {
    return { ok: false, reason: "reservation_linked" };
  }

  const idempotencyId = crypto.randomUUID();
  // Fixed audit id so the idempotency-success flip can be gated on the audit row
  // actually existing (it is only inserted when the UPDATE changed a row).
  const auditId = crypto.randomUUID();
  const expiresAt = toIso(new Date(nowMs + IDEMPOTENCY_TTL_MS));

  try {
    const batchResult = await input.db.batch([
      adminWriteGuard(input.db, input.admin),
      startedIdempotencyStatement({
        db: input.db,
        id: idempotencyId,
        key: input.request.idempotencyKey,
        requestHash,
        expiresAt,
        nowIso,
      }),
      input.db
        .prepare(
          `UPDATE customer_visits
           SET visited_at = ?
           WHERE id = ? AND customer_id = ? AND reservation_id IS NULL
             AND EXISTS (
               SELECT 1 FROM customers c
               WHERE c.id = customer_visits.customer_id
                 AND c.merged_into_id IS NULL
                 AND c.archived_at IS NULL
             )`
        )
        .bind(input.request.visitedAt, input.visitId, input.customerId),
      input.db
        .prepare(
          `
            INSERT INTO audit_logs (
              id, actor_type, actor_id, action, target_type, target_id, metadata_json
            )
            SELECT ?, 'staff', ?, 'customer.visit_manual_update', 'customer_visit', ?, ?
            WHERE changes() = 1
          `
        )
        .bind(
          auditId,
          input.admin.id,
          input.visitId,
          JSON.stringify({
            customer_id: input.customerId,
            visited_at: input.request.visitedAt,
            admin_role: input.admin.role,
          })
        ),
      input.db
        .prepare(
          `
            UPDATE idempotency_keys
            SET status = 'succeeded',
                target_type = 'customer_visit',
                target_id = ?,
                updated_at = ?
            WHERE id = ?
              AND EXISTS (SELECT 1 FROM audit_logs WHERE id = ?)
          `
        )
        .bind(input.visitId, nowIso, idempotencyId, auditId),
    ]);
    // If the row vanished between the pre-check and the UPDATE (e.g. a concurrent
    // delete), the UPDATE matched 0 rows. The audit INSERT (changes()=1 guard) is
    // skipped, and the idempotency-success flip (EXISTS audit row) is therefore NOT
    // applied — the idempotency row stays 'started', so a same-key replay returns
    // idempotency_in_progress (never a false ok) until its TTL elapses. Report
    // not_found to the live caller.
    if (Number(batchResult[2]?.meta?.changes ?? 0) !== 1) {
      return { ok: false, reason: "not_found" };
    }
  } catch (error) {
    if (await adminWriteWasRevoked(input.db, input.admin, error)) {
      return { ok: false, reason: "forbidden" };
    }
    // Terminal write_failed only — idempotency replays resolved below stay silent.
    const captureTerminalWriteFailure = () =>
      captureBatchWriteFailure(error, {
        component: "customer-visits",
        op: "batch_write_failed",
        helper: "updateAdminCustomerVisit"
      });
    try {
      const concurrent = await fetchAdminActionIdempotency(input.db, input.request.idempotencyKey, nowIso);
      const resolved = resolveUpdateIdempotency(concurrent, requestHash);
      if (resolved) return resolved;
      captureTerminalWriteFailure();
      return { ok: false, reason: "write_failed" };
    } catch (lookupError) {
      // The idempotency re-read failed too — capture it under its own op so a
      // read-path outage is distinguishable from the batch write failure.
      captureBatchWriteFailure(lookupError, {
        component: "customer-visits",
        op: "idempotency_lookup_failed",
        helper: "updateAdminCustomerVisit"
      });
      captureTerminalWriteFailure();
      return { ok: false, reason: "write_failed" };
    }
  }

  return { ok: true, visitId: input.visitId, replayed: false };
}

export async function deleteAdminCustomerVisit(input: {
  db: D1Database;
  admin: AdminUser;
  customerId: string;
  visitId: string;
}): Promise<AdminDeleteCustomerVisitResult> {
  if (input.admin.role === "staff") {
    return { ok: false, reason: "forbidden" };
  }
  if (!isNonEmptyString(input.customerId, 128) || !isNonEmptyString(input.visitId, 128)) {
    return { ok: false, reason: "invalid_request" };
  }

  // Load pre-delete fields for the audit record (gone after the DELETE). Delete is
  // intentionally NON-idempotent (no idempotency_keys row): a repeat DELETE of an
  // already-removed row returns not_found, which is acceptable.
  // archived/merged 顧客の来店履歴は削除不可 (memo/profile と同じ不変条件)。
  // pre-check で早期 404、DELETE の WHERE にも同条件を入れて pre-check→write の
  // TOCTOU archive レースでも 0 行削除 → not_found に落とす二重ガード。
  const visit = await input.db
    .prepare(
      `SELECT reservation_id, store_id, visited_at, visit_source, status, treatment_notes
       FROM customer_visits
       WHERE id = ? AND customer_id = ?
         AND EXISTS (
           SELECT 1 FROM customers c
           WHERE c.id = customer_visits.customer_id
             AND c.merged_into_id IS NULL
             AND c.archived_at IS NULL
         )
       LIMIT 1`
    )
    .bind(input.visitId, input.customerId)
    .first<{
      reservation_id: string | null;
      store_id: string;
      visited_at: string;
      visit_source: string;
      status: string;
      treatment_notes: string | null;
    }>();
  if (!visit) {
    return { ok: false, reason: "not_found" };
  }
  if (visit.reservation_id !== null) {
    return { ok: false, reason: "reservation_linked" };
  }

  try {
    const batchResult = await input.db.batch([
      adminWriteGuard(input.db, input.admin),
      input.db
        .prepare(
          `DELETE FROM customer_visits
           WHERE id = ? AND customer_id = ? AND reservation_id IS NULL
             AND EXISTS (
               SELECT 1 FROM customers c
               WHERE c.id = customer_visits.customer_id
                 AND c.merged_into_id IS NULL
                 AND c.archived_at IS NULL
             )`
        )
        .bind(input.visitId, input.customerId),
      input.db
        .prepare(
          `
            INSERT INTO audit_logs (
              id, actor_type, actor_id, action, target_type, target_id, metadata_json
            )
            SELECT ?, 'staff', ?, 'customer.visit_manual_delete', 'customer_visit', ?, ?
            WHERE changes() = 1
          `
        )
        .bind(
          crypto.randomUUID(),
          input.admin.id,
          input.visitId,
          JSON.stringify({
            customer_id: input.customerId,
            store_id: visit.store_id,
            visited_at: visit.visited_at,
            visit_source: visit.visit_source,
            status: visit.status,
            notes_length: visit.treatment_notes?.length ?? 0,
            admin_role: input.admin.role,
          })
        ),
    ]);
    // Concurrent delete race: if the row was already removed between the pre-check
    // and this DELETE, it matches 0 rows (audit suppressed by changes()=1). Report
    // not_found rather than a misleading ok.
    if (Number(batchResult[1]?.meta?.changes ?? 0) !== 1) {
      return { ok: false, reason: "not_found" };
    }
  } catch (error) {
    if (await adminWriteWasRevoked(input.db, input.admin, error)) {
      return { ok: false, reason: "forbidden" };
    }
    safeCaptureException(error instanceof Error ? error : new Error(String(error)), {
      tags: { component: "customer-visits", op: "delete_batch_failed" },
      contexts: { visit: { visitId: input.visitId, storeId: visit.store_id } }
    });
    console.error("deleteAdminCustomerVisit batch failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, reason: "write_failed" };
  }

  return { ok: true };
}
