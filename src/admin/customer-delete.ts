import type { AdminUser } from "./access";
import { adminWriteSnapshot, adminWriteWasRevoked } from "./write-authorization";

// Customer hard-delete — irreversible, owner/system_admin only.
//
// Unlike block (reversible flag) and archive (soft-delete, hideable +
// restorable), this PERMANENTLY removes a customer and every record that
// hangs off it. It exists for cleaning up test data / junk records, NOT
// for routine customer management — operators should prefer archive.
//
// Why this is safe to do as an FK-ordered batch:
//   Cloudflare D1 ENFORCES declared FOREIGN KEY constraints in production
//   (developers.cloudflare.com/d1/sql-api/foreign-keys — equivalent to
//   PRAGMA foreign_keys=on for every transaction; db.batch() is a single
//   transaction; ON DELETE CASCADE/SET NULL/RESTRICT all fire for real).
//   The test harness (createMigratedSqliteD1) runs PRAGMA foreign_keys=ON,
//   so ordering/coverage is verified identically to prod.
//
// Delete strategy: manually delete only the rows the schema will NOT clean
// up for us — the RESTRICT children (which would otherwise abort the parent
// delete) and the no-FK "orphan" tables (slot_locks / calendar_sync_jobs /
// google_calendar_outbound_writes / customer_time_locks owner_id pointers,
// which are plain-TEXT owner_id discriminators with no REFERENCES clause) —
// then let the declared CASCADE handle the rest when we drop the customer.
//
// RESTRICT blockers (must delete first):
//   customers  <- reservations.customer_id, customer_visits.customer_id
//   reservations <- customer_visits.reservation_id, google_calendar_events.reservation_id
//
// FAIL-CLOSED on cross-column anomalies + merge state: every DELETE targets a
// SINGLE ownership column (customer_id = target, or owner_id ∈ target's
// reservations). Several relationships are a (customer_id, reservation_id) /
// (owner_id, calendar_sync_job_id) / (customer_id, line_identity_id) PAIR with
// no FK enforcing the two columns agree about ownership. A consistent row has
// BOTH columns pointing at the target (or neither); an anomalous row has them
// disagree — which a delete-by-the-other-column would silently mutate or
// CASCADE-delete for ANOTHER owner. customer-merge re-points reservations /
// line_identities / customer_visits / customer_time_locks to the canonical
// target but NOT reservation_change_requests / consent_records, so a post-merge
// canonical customer legitimately carries such mismatched rows. We therefore
// also refuse to hard-delete a customer that is a merge CANONICAL (some
// tombstone has merged_into_id = target — a no-FK column that would otherwise
// dangle). All of this is detected in the step-0 audit gate and reported as
// integrity_conflict; the operator resolves it via merge/repair first.
//
// Concurrency: an INSERT that races this delete (e.g. a public booking that
// resolved the customer just before deletion) FAILS with a FK error at commit
// because reservations.customer_id REFERENCES customers ON DELETE RESTRICT —
// D1 serializes writes, so no orphan reservation can be created. The business
// guards (no active/upcoming reservation, no live Google event, no in-flight
// sync, no open Google conflict) are re-validated ATOMICALLY inside the batch
// via the audit-row gate (same pattern as customer-merge.ts): the step-0 audit
// INSERT only lands when every guard still holds, and all subsequent DELETEs
// gate on that audit row, so a guard that flips between the pre-check and the
// batch makes the whole delete no-op rather than removing protected data.
//
// NOTE on D1↔Google drift (accepted residual): the live-event / open-conflict
// guards key on google_calendar_events.status='active' and
// google_calendar_conflicts.resolution_status='open'. If D1's mirror is stale
// (says cancelled while a real Google event survives) a delete could drop the
// local mapping. That is a pre-existing sync-drift concern handled by the
// reconciliation subsystem, not introduced here.

export type CustomerDeleteReason =
  | "forbidden"
  | "not_found"
  | "integrity_conflict"
  | "has_active_reservations"
  | "has_active_google_events"
  | "has_open_google_conflicts"
  | "has_pending_google_sync"
  | "has_pending_notifications"
  | "conflict";

export type CustomerDeleteResult =
  | {
      ok: true;
      removed: { reservations: number; visits: number; lineIdentities: number };
    }
  | { ok: false; reason: CustomerDeleteReason };

// ── Doomed sets (subqueries reused across guards/deletes). Every `?` below
// binds the customerId; callers fill binds by counting `?` (countParams), so
// there is no manual bind-position bookkeeping to get wrong. ──
const RESERVATIONS_OF_CUSTOMER = "SELECT id FROM reservations WHERE customer_id = ?";
const LINE_IDENTITIES_OF_CUSTOMER = "SELECT id FROM line_identities WHERE customer_id = ?";
const TARGET_SYNC_JOBS = `SELECT id FROM calendar_sync_jobs WHERE owner_type = 'reservation' AND owner_id IN (${RESERVATIONS_OF_CUSTOMER})`;

// Bidirectional cross-column anomaly probes — a row is consistent iff both
// ownership columns agree about the target; flag it when they disagree in
// EITHER direction.
const ANOMALY_VISIT =
  `EXISTS (SELECT 1 FROM customer_visits WHERE ` +
  `(customer_id = ? AND reservation_id IS NOT NULL AND reservation_id NOT IN (${RESERVATIONS_OF_CUSTOMER})) ` +
  `OR (customer_id <> ? AND reservation_id IN (${RESERVATIONS_OF_CUSTOMER})))`;
const ANOMALY_TIME_LOCK =
  `EXISTS (SELECT 1 FROM customer_time_locks WHERE owner_type = 'reservation' AND (` +
  `(customer_id = ? AND owner_id NOT IN (${RESERVATIONS_OF_CUSTOMER})) ` +
  `OR (customer_id <> ? AND owner_id IN (${RESERVATIONS_OF_CUSTOMER}))))`;
const ANOMALY_OUTBOUND =
  `EXISTS (SELECT 1 FROM google_calendar_outbound_writes WHERE ` +
  `(owner_type = 'reservation' AND owner_id IN (${RESERVATIONS_OF_CUSTOMER}) AND calendar_sync_job_id IS NOT NULL AND calendar_sync_job_id NOT IN (${TARGET_SYNC_JOBS})) ` +
  `OR (calendar_sync_job_id IN (${TARGET_SYNC_JOBS}) AND NOT (owner_type = 'reservation' AND owner_id IN (${RESERVATIONS_OF_CUSTOMER}))))`;
// reservation_change_requests.(customer_id, reservation_id) — both ON DELETE
// CASCADE; a mismatch would CASCADE-delete another owner's request history.
const ANOMALY_CHANGE_REQUEST =
  `EXISTS (SELECT 1 FROM reservation_change_requests WHERE ` +
  `(customer_id = ? AND reservation_id NOT IN (${RESERVATIONS_OF_CUSTOMER})) ` +
  `OR (customer_id <> ? AND reservation_id IN (${RESERVATIONS_OF_CUSTOMER})))`;
// consent_records.(customer_id, reservation_id) — reservation_id is SET NULL,
// customer_id is CASCADE; a mismatch crosses owners on delete.
const ANOMALY_CONSENT =
  `EXISTS (SELECT 1 FROM consent_records WHERE ` +
  `(customer_id = ? AND reservation_id IS NOT NULL AND reservation_id NOT IN (${RESERVATIONS_OF_CUSTOMER})) ` +
  `OR (customer_id <> ? AND reservation_id IN (${RESERVATIONS_OF_CUSTOMER})))`;
// line_identity_id (SET NULL) is referenced by BOTH reservations and
// reservation_change_requests: a non-target row pointing at the target's
// identity would have its LINE link stripped on delete; or a target row
// pointing at a foreign identity. Guard both tables.
const ANOMALY_LINE_IDENTITY =
  `EXISTS (SELECT 1 FROM reservations WHERE ` +
  `(customer_id <> ? AND line_identity_id IN (${LINE_IDENTITIES_OF_CUSTOMER})) ` +
  `OR (customer_id = ? AND line_identity_id IS NOT NULL AND line_identity_id NOT IN (${LINE_IDENTITIES_OF_CUSTOMER}))) ` +
  `OR EXISTS (SELECT 1 FROM reservation_change_requests WHERE ` +
  `(customer_id <> ? AND line_identity_id IN (${LINE_IDENTITIES_OF_CUSTOMER})) ` +
  `OR (customer_id = ? AND line_identity_id IS NOT NULL AND line_identity_id NOT IN (${LINE_IDENTITIES_OF_CUSTOMER})))`;
// Merge canonical: a tombstone points merged_into_id (no FK) at the target.
const ANOMALY_MERGE_CANONICAL = `EXISTS (SELECT 1 FROM customers WHERE merged_into_id = ?)`;

// Integrity = ANY anomaly (all reported as integrity_conflict).
const COND_INTEGRITY =
  `(${ANOMALY_VISIT} OR ${ANOMALY_TIME_LOCK} OR ${ANOMALY_OUTBOUND} ` +
  `OR ${ANOMALY_CHANGE_REQUEST} OR ${ANOMALY_CONSENT} OR ${ANOMALY_LINE_IDENTITY} ` +
  `OR ${ANOMALY_MERGE_CANONICAL})`;

// Business guards (concurrency-sensitive — re-validated atomically in step 0).
const COND_CUSTOMER_EXISTS = `EXISTS (SELECT 1 FROM customers WHERE id = ?)`;
const COND_ACTIVE_RESERVATION =
  `EXISTS (SELECT 1 FROM reservations WHERE customer_id = ? AND status IN ('pending_approval', 'confirmed'))`;
// Refuse on ANY Google event mapping that is not confirmed-gone on Google's
// side ('cancelled'/'deleted'). 'active'/'conflict'/'ignored' all imply a live
// Google event still exists, so deleting the local mapping would orphan it on
// the calendar (operator should cancel the reservation first, which enqueues +
// processes the Google delete, before hard-deleting).
const COND_ACTIVE_GOOGLE_EVENT =
  `EXISTS (SELECT 1 FROM google_calendar_events e JOIN reservations r ON e.reservation_id = r.id ` +
  `WHERE r.customer_id = ? AND e.status NOT IN ('cancelled', 'deleted'))`;
const COND_OPEN_GOOGLE_CONFLICT =
  `EXISTS (SELECT 1 FROM google_calendar_conflicts WHERE resolution_status = 'open' AND reservation_id IN (${RESERVATIONS_OF_CUSTOMER}))`;
const COND_PENDING_SYNC =
  `EXISTS (SELECT 1 FROM calendar_sync_jobs WHERE owner_type = 'reservation' ` +
  `AND owner_id IN (${RESERVATIONS_OF_CUSTOMER}) AND status IN ('queued', 'processing', 'retryable'))`;
// In-flight LINE notification: a job the dispatcher has already claimed
// ('processing') must not be deleted mid-send. Covers the same target set as
// the step-1 notification_jobs delete.
const COND_PROCESSING_NOTIFICATION =
  `EXISTS (SELECT 1 FROM notification_jobs WHERE status = 'processing' AND (` +
  `reservation_id IN (${RESERVATIONS_OF_CUSTOMER}) ` +
  `OR change_request_id IN (SELECT id FROM reservation_change_requests WHERE customer_id = ? OR reservation_id IN (${RESERVATIONS_OF_CUSTOMER})) ` +
  `OR (recipient_type = 'customer' AND recipient_id = ?)))`;

// All `?` in guard SQL bind the customerId, so binds are just the placeholder
// count filled with the id — no positional bookkeeping.
const countParams = (sql: string): number => (sql.match(/\?/g) ?? []).length;
const fillCustomerId = (sql: string, customerId: string): string[] =>
  new Array(countParams(sql)).fill(customerId);

type CustomerDeleteGuardRow = {
  customer_exists: number;
  integrity_anomaly: number;
  active_reservation: number;
  active_google_event: number;
  open_google_conflict: number;
  pending_sync: number;
  processing_notification: number;
};

// Single SELECT computing every guard boolean (order = bind order; all binds
// are customerId).
const GUARD_SELECT =
  `SELECT (${COND_CUSTOMER_EXISTS}) AS customer_exists, ` +
  `(${COND_INTEGRITY}) AS integrity_anomaly, ` +
  `(${COND_ACTIVE_RESERVATION}) AS active_reservation, ` +
  `(${COND_ACTIVE_GOOGLE_EVENT}) AS active_google_event, ` +
  `(${COND_OPEN_GOOGLE_CONFLICT}) AS open_google_conflict, ` +
  `(${COND_PENDING_SYNC}) AS pending_sync, ` +
  `(${COND_PROCESSING_NOTIFICATION}) AS processing_notification`;

const fetchGuardState = async (
  db: D1Database,
  customerId: string
): Promise<CustomerDeleteGuardRow> => {
  const row = await db
    .prepare(GUARD_SELECT)
    .bind(...fillCustomerId(GUARD_SELECT, customerId))
    .first<CustomerDeleteGuardRow>();
  return (
    row ?? {
      customer_exists: 0,
      integrity_anomaly: 0,
      active_reservation: 0,
      active_google_event: 0,
      open_google_conflict: 0,
      pending_sync: 0,
      processing_notification: 0
    }
  );
};

const reasonFromGuard = (guard: CustomerDeleteGuardRow): CustomerDeleteReason => {
  if (guard.customer_exists === 0) return "not_found";
  if (guard.integrity_anomaly === 1) return "integrity_conflict";
  if (guard.active_reservation === 1) return "has_active_reservations";
  if (guard.active_google_event === 1) return "has_active_google_events";
  if (guard.open_google_conflict === 1) return "has_open_google_conflicts";
  if (guard.pending_sync === 1) return "has_pending_google_sync";
  if (guard.processing_notification === 1) return "has_pending_notifications";
  // Customer still exists and every guard is clear — the audit INSERT no-op'd
  // due to a transient race (a guard flipped true then false). Surface a
  // generic, retryable conflict rather than mislabeling the reason.
  return "conflict";
};

const guardBlocks = (g: CustomerDeleteGuardRow): boolean =>
  g.customer_exists === 0 ||
  g.integrity_anomaly === 1 ||
  g.active_reservation === 1 ||
  g.active_google_event === 1 ||
  g.open_google_conflict === 1 ||
  g.pending_sync === 1 ||
  g.processing_notification === 1;

// step-0 audit gate WHERE: customer exists AND none of the blocking conditions.
const GATE_WHERE =
  `${COND_CUSTOMER_EXISTS} ` +
  `AND NOT ${COND_ACTIVE_RESERVATION} ` +
  `AND NOT ${COND_ACTIVE_GOOGLE_EVENT} ` +
  `AND NOT ${COND_OPEN_GOOGLE_CONFLICT} ` +
  `AND NOT ${COND_PENDING_SYNC} ` +
  `AND NOT ${COND_PROCESSING_NOTIFICATION} ` +
  `AND NOT ${COND_INTEGRITY}`;

export const executeAdminCustomerDelete = async (input: {
  db: D1Database;
  admin: AdminUser;
  customerId: string;
}): Promise<CustomerDeleteResult> => {
  // Owner / system_admin only. Staff manage own-store customers (view + memo /
  // カルテ / profile) but irreversible destruction stays with the owner, like
  // block / archive / merge.
  if (input.admin.role === "staff") {
    return { ok: false, reason: "forbidden" };
  }

  const { db, customerId } = input;

  // Pre-check for a precise, fast error (the authoritative guard is the
  // in-batch audit gate below).
  const preGuard = await fetchGuardState(db, customerId);
  if (guardBlocks(preGuard)) {
    return { ok: false, reason: reasonFromGuard(preGuard) };
  }

  const auditId = crypto.randomUUID();
  const actorSnapshot = adminWriteSnapshot(input.admin);
  const auditMetadata = JSON.stringify({ adminRole: input.admin.role });
  // Gate suffix re-checked by every DELETE: only proceed if the step-0 audit
  // row landed (i.e. customer still existed AND all guards still held).
  const gate = "EXISTS (SELECT 1 FROM audit_logs WHERE id = ?)";

  const batchResult = await db.batch([
    // step 0 — audit gate. Self-gates on customer existence + all business
    // guards + the integrity checks. If any condition flipped since the
    // pre-check, the SELECT yields no row, audit INSERT affects 0 rows, and
    // every gated DELETE below no-ops. Binds: 4 SELECT values then one
    // customerId per `?` in GATE_WHERE (filled by count, never hand-counted).
    db
      .prepare(
        `INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, metadata_json)
         SELECT ?, 'staff', ?, 'customer.delete', 'customer', ?, ?
         WHERE ${GATE_WHERE} AND ${actorSnapshot.sql}`
      )
      .bind(auditId, input.admin.id, customerId, auditMetadata, ...fillCustomerId(GATE_WHERE, customerId), ...actorSnapshot.bindings),
    // step 1 — notification_jobs (reservations FK is SET NULL → would survive;
    // notification_logs cascade via notification_job_id CASCADE).
    db
      .prepare(
        `
          DELETE FROM notification_jobs
          WHERE (
            reservation_id IN (${RESERVATIONS_OF_CUSTOMER})
            OR change_request_id IN (
              SELECT id FROM reservation_change_requests
              WHERE customer_id = ? OR reservation_id IN (${RESERVATIONS_OF_CUSTOMER})
            )
            OR (recipient_type = 'customer' AND recipient_id = ?)
          )
          AND ${gate}
        `
      )
      .bind(customerId, customerId, customerId, customerId, auditId),
    // step 2 — google_calendar_outbound_writes (owner_id: no FK reservation
    // pointer). Single-ownership; cross-links are refused at step 0.
    db
      .prepare(
        `DELETE FROM google_calendar_outbound_writes
         WHERE owner_type = 'reservation' AND owner_id IN (${RESERVATIONS_OF_CUSTOMER}) AND ${gate}`
      )
      .bind(customerId, auditId),
    // step 3 — calendar_sync_jobs (owner_id: no FK → would orphan).
    db
      .prepare(
        `DELETE FROM calendar_sync_jobs
         WHERE owner_type = 'reservation' AND owner_id IN (${RESERVATIONS_OF_CUSTOMER}) AND ${gate}`
      )
      .bind(customerId, auditId),
    // step 4 — slot_locks (owner_id: no FK → orphan locks would freeze the
    // slot forever; cf. incident-bulk-cleanup-orphaned-slot-locks).
    db
      .prepare(
        `DELETE FROM slot_locks
         WHERE owner_type = 'reservation' AND owner_id IN (${RESERVATIONS_OF_CUSTOMER}) AND ${gate}`
      )
      .bind(customerId, auditId),
    // step 5 — customer_time_locks (customer_id is CASCADE; explicit by owner).
    db
      .prepare(`DELETE FROM customer_time_locks WHERE customer_id = ? AND ${gate}`)
      .bind(customerId, auditId),
    // step 6 — google_calendar_conflicts (reservation_id FK is SET NULL →
    // would survive with a dangling NULL; delete for a clean full removal).
    db
      .prepare(
        `DELETE FROM google_calendar_conflicts WHERE reservation_id IN (${RESERVATIONS_OF_CUSTOMER}) AND ${gate}`
      )
      .bind(customerId, auditId),
    // step 7 — google_calendar_events (reservation_id FK is RESTRICT → blocks
    // the reservations delete; must go first).
    db
      .prepare(
        `DELETE FROM google_calendar_events WHERE reservation_id IN (${RESERVATIONS_OF_CUSTOMER}) AND ${gate}`
      )
      .bind(customerId, auditId),
    // step 8 — customer_visits. RESTRICT child of BOTH customers and
    // reservations; an anomaly is refused at step 0, so deleting by the owning
    // customer_id clears every visit on the target's reservations and step 9
    // cannot FK-abort.
    db
      .prepare(`DELETE FROM customer_visits WHERE customer_id = ? AND ${gate}`)
      .bind(customerId, auditId),
    // step 9 — reservations. RESTRICT blockers gone. CASCADE: reservation_
    // services, reservation_change_requests. SET NULL: consent_records.
    db
      .prepare(`DELETE FROM reservations WHERE customer_id = ? AND ${gate}`)
      .bind(customerId, auditId),
    // step 10 — line_identities (explicit for an exact count; CASCADE →
    // customer_match_candidates).
    db
      .prepare(`DELETE FROM line_identities WHERE customer_id = ? AND ${gate}`)
      .bind(customerId, auditId),
    // step 11 — customers. RESTRICT blockers cleared. CASCADE: remaining
    // customer_match_candidates, consent_records, referral_notes.
    db
      .prepare(`DELETE FROM customers WHERE id = ? AND ${gate}`)
      .bind(customerId, auditId)
  ]);

  const auditChanges = Number(batchResult[0]?.meta?.changes ?? 0);
  if (auditChanges === 0) {
    if (await adminWriteWasRevoked(db, input.admin)) {
      return { ok: false, reason: "forbidden" };
    }
    // A guard flipped between the pre-check and the batch (or a concurrent
    // delete won). Nothing was removed (every DELETE gated on the absent audit
    // row). Re-read the guards to return a precise reason.
    const postGuard = await fetchGuardState(db, customerId);
    return { ok: false, reason: reasonFromGuard(postGuard) };
  }

  return {
    ok: true,
    removed: {
      reservations: Number(batchResult[9]?.meta?.changes ?? 0),
      visits: Number(batchResult[8]?.meta?.changes ?? 0),
      lineIdentities: Number(batchResult[10]?.meta?.changes ?? 0)
    }
  };
};
