/**
 * Shared reservation transition statement builders.
 *
 * Used by:
 *   - src/admin/reservations.ts            (admin cancel)
 *   - src/admin/reservation-reschedule.ts  (admin reschedule)
 *   - admin reservation-create and Google import-sync also share the phone-lock SQL.
 *
 * (The Phase 3 customer change-request approve flavor — actor.kind
 * "change_request" with a full version/start_at/end_at snapshot pin — was
 * removed with the change-request feature retirement: reschedule 2026-07-24,
 * cancel 2026-08-01.)
 *
 * Statement ordering contract (PR #1 plan section 2):
 *   transition[0] === reservation UPDATE.
 *
 *   Legacy admin caller contract (src/admin/reservations.ts cancel branch,
 *   src/admin/reservation-reschedule.ts): splice the existing
 *   guard{Reservation,Reschedule}TransitionApplied between transition[0]
 *   and transition.slice(1). The guard inspects changes() of the UPDATE
 *   and writes a follow-up idempotency_keys row. Do not reorder.
 *   Versioned reschedule callers insert the operation's audit mark after the
 *   update and pass its SQL condition to the lock and history statements.
 *
 * Bind-parameter budget (D1 limit per query = 100):
 *   - per-slot INSERT: 7-8 binds plus the versioned condition, if supplied.
 */

import { generateSlotTimes } from "./slot-times";

const SLOT_INTERVAL_MINUTES = 5;

// Resolve inside the writing batch: a phone edit may commit after preflight reads.
// The one bind is the reservation ID. Public/LINE locks remain customer-ID-only.
export const CUSTOMER_TIME_LOCK_PHONE_HASH_SQL = `(
  SELECT c.phone_hash FROM reservations r
  JOIN customers c ON c.id = r.customer_id
  WHERE r.id = ? AND r.source IN ('phone_admin', 'admin')
)`;

const buildExpectedStatusPlaceholders = (
  expectedStatusList: ReadonlyArray<string>
): string => {
  const placeholders = expectedStatusList.map(() => "?").join(", ");
  if (placeholders === "") {
    throw new Error("transitions: expectedStatusList must contain at least one status");
  }
  return placeholders;
};

type RescheduleCondition = { sql: string; bindings: ReadonlyArray<string | number | null> };

const andCondition = (condition?: RescheduleCondition) => condition ? `AND (${condition.sql})` : "";
const conditionBindings = (condition?: RescheduleCondition) => condition?.bindings ?? [];

const buildSlotLockReleaseHistoryStatement = (input: {
  db: D1Database;
  reservationId: string;
  adminId: string;
  reason: string;
  condition?: RescheduleCondition;
}): D1PreparedStatement =>
  input.db
    .prepare(
      `
        INSERT INTO slot_lock_history (
          id,
          slot_lock_id,
          store_id,
          resource_id,
          old_slot_at,
          old_owner_id,
          action,
          actor_type,
          actor_id,
          reason
        )
        SELECT
          lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6))),
          id,
          store_id,
          resource_id,
          slot_at,
          owner_id,
          'released',
          'staff',
          ?,
          ?
        FROM slot_locks
        WHERE owner_type = 'reservation'
          AND owner_id = ?
          ${andCondition(input.condition)}
      `
    )
    .bind(input.adminId, input.reason, input.reservationId, ...conditionBindings(input.condition));

const buildSlotLocksDeleteStatement = (
  db: D1Database,
  reservationId: string,
  condition?: RescheduleCondition
): D1PreparedStatement =>
  db
    .prepare(
      `
        DELETE FROM slot_locks
        WHERE owner_type = 'reservation'
          AND owner_id = ?
          ${andCondition(condition)}
      `
    )
    .bind(reservationId, ...conditionBindings(condition));

const buildCustomerTimeLocksDeleteStatement = (
  db: D1Database,
  reservationId: string,
  condition?: RescheduleCondition
): D1PreparedStatement =>
  db
    .prepare(
      `
        DELETE FROM customer_time_locks
        WHERE owner_type = 'reservation'
          AND owner_id = ?
          ${andCondition(condition)}
      `
    )
    .bind(reservationId, ...conditionBindings(condition));

// ============================================================================
// CANCEL
// ============================================================================

export type AdminCancelInput = {
  db: D1Database;
  reservationId: string;
  customerId: string;
  expectedStatusList: ReadonlyArray<"pending_approval" | "confirmed">;
  nowIso: string;
  // No snapshot field - admin path uses status-only guard.
  actor: { kind: "admin"; adminId: string; reason: string };
};

export const buildCancelStatements = (
  input: AdminCancelInput
): D1PreparedStatement[] => {
  const statusPlaceholders = buildExpectedStatusPlaceholders(input.expectedStatusList);
  const updateStmt = input.db
    .prepare(
      `
        UPDATE reservations
        SET status = 'cancelled_by_admin',
            cancelled_at = ?,
            cancelled_by = ?,
            pending_expires_at = NULL,
            updated_by = ?,
            version = version + 1,
            updated_at = ?
        WHERE id = ?
          AND status IN (${statusPlaceholders})
      `
    )
    .bind(
      input.nowIso,
      input.actor.adminId,
      input.actor.adminId,
      input.nowIso,
      input.reservationId,
      ...input.expectedStatusList
    );

  return [
    updateStmt,
    buildSlotLockReleaseHistoryStatement({
      db: input.db,
      reservationId: input.reservationId,
      adminId: input.actor.adminId,
      reason: input.actor.reason
    }),
    buildSlotLocksDeleteStatement(input.db, input.reservationId),
    buildCustomerTimeLocksDeleteStatement(input.db, input.reservationId)
  ];
};

// 予約が terminal (expired / rejected / cancelled_by_admin / completed / no_show) に
// 遷移する batch に同梱し、その予約への pending 変更申請を 'expired' に閉じる共通文。
// terminalGuard には「同 batch 内で予約の terminal UPDATE が実際にコミットした
// ことを確認する EXISTS 句」を呼び出し側の文脈で渡す (D1 batch = 単一 tx 逐次実行)。
// キャンセル申請機能は 2026-08-01 に全廃したが、この文は廃止前に作られた stale な
// pending 行の後始末 (歴史データ整理) として温存する — 新規 pending は発生しない。
export const buildClosePendingChangeRequestsStatement = (input: {
  db: D1Database;
  reservationId: string;
  nowIso: string;
  terminalGuardSql: string;
  terminalGuardBinds: ReadonlyArray<string | number>;
}): D1PreparedStatement =>
  input.db
    .prepare(
      `UPDATE reservation_change_requests
       SET status = 'expired',
           updated_at = ?
       WHERE reservation_id = ?
         AND status = 'pending'
         AND ${input.terminalGuardSql}`
    )
    .bind(input.nowIso, input.reservationId, ...input.terminalGuardBinds);

// ============================================================================
// RESCHEDULE
// ============================================================================

type RescheduleCommon = {
  db: D1Database;
  reservationId: string;
  customerId: string;
  storeId: string;
  resourceId: string;
  expectedStatusList: ReadonlyArray<"pending_approval" | "confirmed">;
  newStartAt: string;
  newEndAt: string;
  newDurationMinutes: number;
  nowIso: string;
  /** Lock expiration; NULL for confirmed reservations (no auto-expiry). */
  newLockExpiresAt: string | null;
  newLockStatus: "pending" | "confirmed";
};

export type AdminRescheduleInput = RescheduleCommon & {
  actor: { kind: "admin"; adminId: string };
  // The caller supplies the actor guard; this update preserves the target store.
  versioned?: {
    update: RescheduleCondition;
    applied: RescheduleCondition;
    updatedBy: string;
  };
};

const validateRescheduleSlots = (
  newStartAt: string,
  newEndAt: string
): string[] => {
  const slotTimesIso = generateSlotTimes(newStartAt, newEndAt, SLOT_INTERVAL_MINUTES);
  if (slotTimesIso.length === 0) {
    throw new Error("transitions: reschedule must produce at least one slot");
  }
  if (slotTimesIso.length > 48) {
    throw new Error(
      `transitions: reschedule slot count ${slotTimesIso.length} exceeds 48 (4h cap). Reduce duration before approve.`
    );
  }
  return slotTimesIso;
};

const buildAdminRescheduleStatements = (
  input: AdminRescheduleInput,
  slotTimesIso: ReadonlyArray<string>
): D1PreparedStatement[] => {
  const statusPlaceholders = buildExpectedStatusPlaceholders(input.expectedStatusList);
  const applied = input.versioned?.applied;
  const insertCondition = applied ? `WHERE ${applied.sql}` : "";
  const updateStmt = input.db
    .prepare(
      `
        UPDATE reservations
        SET start_at = ?,
            end_at = ?,
            duration_minutes = ?,
            updated_by = ?,
            updated_at = ?,
            google_sync_state = 'pending',
            version = version + 1
        WHERE id = ?
          AND store_id = ?
          AND status IN (${statusPlaceholders})
          AND checked_in_at IS NULL
          ${andCondition(input.versioned?.update)}
      `
    )
    .bind(
      input.newStartAt,
      input.newEndAt,
      input.newDurationMinutes,
      input.versioned?.updatedBy ?? input.actor.adminId,
      input.nowIso,
      input.reservationId,
      input.storeId,
      ...input.expectedStatusList,
      ...conditionBindings(input.versioned?.update)
    );

  const statements: D1PreparedStatement[] = [
    updateStmt,
    buildSlotLockReleaseHistoryStatement({
      db: input.db,
      reservationId: input.reservationId,
      adminId: input.actor.adminId,
      reason: "admin_reschedule",
      condition: applied
    }),
    buildSlotLocksDeleteStatement(input.db, input.reservationId, applied),
    buildCustomerTimeLocksDeleteStatement(input.db, input.reservationId, applied)
  ];

  for (const slotAt of slotTimesIso) {
    const slotLockId = crypto.randomUUID();
    statements.push(
      input.db
        .prepare(
          `
            INSERT INTO slot_locks (
              id, store_id, resource_id, slot_at, owner_type, owner_id, lock_status, expires_at
            ) SELECT ?, ?, ?, ?, 'reservation', ?, ?, ? ${insertCondition}
          `
        )
        .bind(
          slotLockId,
          input.storeId,
          input.resourceId,
          slotAt,
          input.reservationId,
          input.newLockStatus,
          input.newLockExpiresAt,
          ...conditionBindings(applied)
        ),
      input.db
        .prepare(
          `
            INSERT INTO customer_time_locks (
              id, customer_id, slot_at, owner_type, owner_id, lock_status, expires_at, phone_hash
            ) SELECT ?, ?, ?, 'reservation', ?, ?, ?, ${CUSTOMER_TIME_LOCK_PHONE_HASH_SQL} ${insertCondition}
          `
        )
        .bind(
          crypto.randomUUID(),
          input.customerId,
          slotAt,
          input.reservationId,
          input.newLockStatus,
          input.newLockExpiresAt,
          input.reservationId,
          ...conditionBindings(applied)
        ),
      input.db
        .prepare(
          `
            INSERT INTO slot_lock_history (
              id, slot_lock_id, store_id, resource_id, new_slot_at, new_owner_id, action, actor_type, actor_id, reason
            ) SELECT ?, ?, ?, ?, ?, ?, 'created', 'staff', ?, 'admin_reschedule' ${insertCondition}
          `
        )
        .bind(
          crypto.randomUUID(),
          slotLockId,
          input.storeId,
          input.resourceId,
          slotAt,
          input.reservationId,
          input.actor.adminId,
          ...conditionBindings(applied)
        )
    );
  }

  return statements;
};

export const buildRescheduleStatements = (
  input: AdminRescheduleInput
): D1PreparedStatement[] => {
  const slotTimesIso = validateRescheduleSlots(input.newStartAt, input.newEndAt);
  return buildAdminRescheduleStatements(input, slotTimesIso);
};
