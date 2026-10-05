import { adminWriteGuard, adminWriteSnapshot, adminWriteWasRevoked } from "./write-authorization";
import type { AdminUser } from "./access";
import { readErrorMessage } from "../outbound-timeout";
import {
  buildCreateContext,
  MAX_ID_LENGTH,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_NAME_LENGTH,
  fetchAdminActionIdempotency,
  guardImmutableStore,
  isActorTypeBatchError,
  isAdminPrivileged,
  recoverFromCreateBatchFailure,
  sha256Hex,
  startedIdempotencyStatement,
  storeExists,
  succeededIdempotencyStatement,
  trimAndCap,
  type IdempotencyRow
} from "./settings-common";

// Tier C.3 4c — staff_members editor. role gate + audit_logs +
// idempotency_keys for POST. No future-reservation guard: reservations
// do not directly reference staff_members; admin_users.staff_member_id
// uses ON DELETE SET NULL so soft delete via active=0 is structurally
// safe.
//
// F-3.2 (Tier C.3 audit): self-deactivation lockout guard implemented
// in updateAdminStaff. AdminUser now carries staff_member_id so the
// guard can compare caller identity against the target row without an
// extra DB lookup.
//
// F-3.3 (Tier C.3 audit): system_admin role escalation guard. Only an
// existing system_admin may create another row at `system_admin`,
// promote a row to `system_admin`, or modify / delete an existing
// `system_admin` row in any way. Owner-tier admins managing routine
// staff cannot grant — nor revoke — the elevated role through the UI.
// Seed (direct DB) remains the only path for the first system_admin
// and the only emergency recovery path if all system_admins are lost.
// Guard lives in createAdminStaff + updateAdminStaff + softDeleteAdminStaff.

export type AdminStaffRole = "owner" | "staff" | "system_admin";

const STAFF_ROLES: ReadonlySet<AdminStaffRole> = new Set([
  "owner",
  "staff",
  "system_admin"
]);

// Store-login sentinel staff_members ids are `staff_login_<storeId>`. These
// anchor the shared store login (src/admin/settings-store-login.ts) and are
// managed ONLY through the /store-logins endpoints — never the generic staff
// CRUD, which would propagate role/active to the linked admin_users row.
const isStoreLoginSentinelStaffId = (staffId: string): boolean =>
  staffId.startsWith("staff_login_");

export type AdminStaffCreateRequest = {
  storeId: string;
  displayName: string;
  role: AdminStaffRole;
  active: boolean;
  idempotencyKey: string;
};

export type AdminStaffUpdateRequest = {
  storeId: string;
  displayName: string;
  role: AdminStaffRole;
  active: boolean;
  expectedVersion: number;
};

const isSelfDeactivation = (
  admin: AdminUser,
  staffId: string,
  active: boolean
): boolean => admin.staff_member_id === staffId && !active;

export type AdminStaffCreateError =
  | "forbidden"
  | "forbidden_role_escalation"
  | "invalid_request"
  | "not_found"
  | "missing_database"
  | "store_not_found"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "write_failed";

export type AdminStaffUpdateError =
  | "forbidden"
  | "forbidden_self_deactivation"
  | "forbidden_role_escalation"
  | "invalid_request"
  | "not_found"
  | "missing_database"
  | "store_not_found"
  | "immutable_store"
  | "stale_snapshot"
  | "write_failed";

export type AdminStaffDeleteError =
  | "forbidden"
  | "forbidden_self_deactivation"
  | "forbidden_role_escalation"
  | "invalid_request"
  | "not_found"
  | "missing_database"
  | "write_failed";

export type AdminStaffCreateResult =
  | { ok: true; staffId: string; replayed: boolean }
  | { ok: false; error: AdminStaffCreateError };

export type AdminStaffUpdateResult =
  | { ok: true; staffId: string }
  | { ok: false; error: AdminStaffUpdateError };

export type AdminStaffDeleteResult =
  | { ok: true; staffId: string }
  | { ok: false; error: AdminStaffDeleteError };

const parseStaffRole = (value: unknown): AdminStaffRole | null => {
  if (typeof value !== "string") return null;
  return STAFF_ROLES.has(value as AdminStaffRole) ? (value as AdminStaffRole) : null;
};

type CommonMutationFields = Pick<
  AdminStaffUpdateRequest,
  "storeId" | "displayName" | "role"
> & {
  active: boolean | null;
};

const parseCommonMutationFields = (body: unknown): CommonMutationFields | null => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const raw = body as Record<string, unknown>;
  const storeId = trimAndCap(raw.storeId, MAX_ID_LENGTH);
  const displayName = trimAndCap(raw.displayName, MAX_NAME_LENGTH);
  if (!storeId || !displayName) return null;
  const role = parseStaffRole(raw.role);
  if (!role) return null;
  const active = typeof raw.active === "boolean" ? raw.active : null;
  return { storeId, displayName, role, active };
};

export const parseAdminStaffCreateRequest = (
  body: unknown
): AdminStaffCreateRequest | null => {
  const common = parseCommonMutationFields(body);
  if (!common) return null;
  const raw = body as Record<string, unknown>;
  const idempotencyKey = trimAndCap(raw.idempotencyKey, MAX_IDEMPOTENCY_KEY_LENGTH);
  if (!idempotencyKey) return null;
  const active = common.active ?? true;
  return { ...common, active, idempotencyKey };
};

export const parseAdminStaffUpdateRequest = (
  body: unknown
): AdminStaffUpdateRequest | null => {
  const common = parseCommonMutationFields(body);
  if (common?.active == null) return null;
  const expectedVersion = (body as Record<string, unknown>).expectedVersion;
  if (
    typeof expectedVersion !== "number" ||
    !Number.isInteger(expectedVersion) ||
    expectedVersion <= 0
  ) {
    return null;
  }
  return { ...common, active: common.active, expectedVersion };
};

const createStaffRequestHash = async (
  input: Pick<AdminStaffCreateRequest, "storeId" | "displayName" | "role" | "active">
) =>
  sha256Hex(
    JSON.stringify({
      storeId: input.storeId,
      displayName: input.displayName,
      role: input.role,
      active: input.active
    })
  );

const resolveCreateIdempotency = (
  idempotency: IdempotencyRow | null,
  requestHash: string
): AdminStaffCreateResult | undefined => {
  if (!idempotency) return undefined;
  if (idempotency.request_hash !== requestHash) {
    return { ok: false, error: "idempotency_conflict" };
  }
  if (idempotency.status === "succeeded" && idempotency.target_id) {
    return { ok: true, staffId: idempotency.target_id, replayed: true };
  }
  return { ok: false, error: "idempotency_in_progress" };
};

type StaffRow = {
  id: string;
  store_id: string;
  display_name: string;
  role: AdminStaffRole;
  active: number;
  version: number;
};

const fetchStaff = async (db: D1Database, id: string): Promise<StaffRow | null> =>
  db
    .prepare(
      `SELECT id, store_id, display_name, role, active, version
       FROM staff_members
       WHERE id = ?`
    )
    .bind(id)
    .first<StaffRow>();

async function handleStaffUpdateBatchError(
  db: D1Database,
  admin: AdminUser,
  error: unknown,
  staffId: string,
  expectedVersion: number
): Promise<AdminStaffUpdateResult> {
  if (await adminWriteWasRevoked(db, admin, error)) {
    return { ok: false, error: "forbidden" };
  }
  if (isActorTypeBatchError(error)) {
    const fresh = await fetchStaff(db, staffId);
    if (!fresh) return { ok: false, error: "not_found" };
    if (fresh.version !== expectedVersion) {
      return { ok: false, error: "stale_snapshot" };
    }
    return { ok: false, error: "write_failed" };
  }
  console.error("updateAdminStaff batch failed", {
    staffId,
    error: error instanceof Error ? error.message : String(error)
  });
  return { ok: false, error: "write_failed" };
}

const recordForbiddenRoleEscalationAudit = async (input: {
  db: D1Database;
  admin: AdminUser;
  path: "create" | "update" | "delete";
  targetStaffId?: string;
  targetRole?: AdminStaffRole;
  requestedRole?: AdminStaffRole;
  requestedActive?: boolean;
  now?: () => number;
}): Promise<void> => {
  const actorSnapshot = adminWriteSnapshot(input.admin);
  try {
    await input.db
      .prepare(
        `INSERT INTO audit_logs (
           id, actor_type, actor_id, action, target_type, target_id, metadata_json, created_at
         ) SELECT ?, 'staff', ?, 'settings.staff.forbidden_role_escalation', 'staff_member', ?, ?, ?
         WHERE ${actorSnapshot.sql}`
      )
      .bind(
        crypto.randomUUID(),
        input.admin.id,
        input.targetStaffId ?? "pending_staff_member",
        JSON.stringify({
          path: input.path,
          adminRole: input.admin.role,
          targetRole: input.targetRole ?? null,
          requestedRole: input.requestedRole ?? null,
          requestedActive: input.requestedActive ?? null
        }),
        new Date((input.now ?? Date.now)()).toISOString(),
        ...actorSnapshot.bindings
      )
      .run();
  } catch (error) {
    console.warn("[settings-staff] forbidden_role_escalation audit write failed", {
      adminId: input.admin.id,
      path: input.path,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};

export const createAdminStaff = async (input: {
  db: D1Database;
  admin: AdminUser;
  staffId?: string;
  request: AdminStaffCreateRequest;
  now?: () => number;
}): Promise<AdminStaffCreateResult> => {
  if (!isAdminPrivileged(input.admin.role)) {
    return { ok: false, error: "forbidden" };
  }
  // F-3.3: only system_admin can create another system_admin via the UI.
  // owner-tier admins are blocked from granting the elevated role.
  if (input.request.role === "system_admin" && input.admin.role !== "system_admin") {
    console.warn("[settings-staff] forbidden_role_escalation refused", {
      adminId: input.admin.id,
      adminRole: input.admin.role,
      requestedRole: input.request.role,
      path: "create"
    });
    await recordForbiddenRoleEscalationAudit({
      db: input.db,
      admin: input.admin,
      path: "create",
      requestedRole: input.request.role,
      requestedActive: input.request.active,
      now: input.now
    });
    return { ok: false, error: "forbidden_role_escalation" };
  }
  const requestHash = await createStaffRequestHash(input.request);
  // Derive the idempotency clock before the TTL read so the read, the expires_at write, and the catch re-read share one injected now (B8).
  const { nowIso, expiresAt, idempotencyId } = buildCreateContext(input.now);
  const existingIdempotency = await fetchAdminActionIdempotency(input.db, input.request.idempotencyKey, nowIso);
  const idempotencyResult = resolveCreateIdempotency(existingIdempotency, requestHash);
  if (idempotencyResult) return idempotencyResult;

  if (!(await storeExists(input.db, input.request.storeId))) {
    return { ok: false, error: "store_not_found" };
  }
  const id = input.staffId ?? crypto.randomUUID();
  const activeInt = input.request.active ? 1 : 0;

  try {
    await input.db.batch([
      adminWriteGuard(input.db, input.admin),
      startedIdempotencyStatement({
        db: input.db,
        id: idempotencyId,
        key: input.request.idempotencyKey,
        requestHash,
        expiresAt,
        nowIso
      }),
      input.db
        .prepare(
          `INSERT INTO staff_members (
             id, store_id, display_name, role, active, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          id,
          input.request.storeId,
          input.request.displayName,
          input.request.role,
          activeInt,
          nowIso,
          nowIso
        ),
      input.db
        .prepare(
          `INSERT INTO audit_logs (
             id, actor_type, actor_id, action, target_type, target_id, metadata_json
           ) VALUES (?, 'staff', ?, 'settings.staff.create', 'staff_member', ?, ?)`
        )
        .bind(
          crypto.randomUUID(),
          input.admin.id,
          id,
          JSON.stringify({
            staffId: id,
            storeId: input.request.storeId,
            displayName: input.request.displayName,
            role: input.request.role,
            active: input.request.active,
            adminRole: input.admin.role
          })
        ),
      succeededIdempotencyStatement({
        db: input.db,
        idempotencyId,
        targetType: "staff_member",
        targetId: id,
        nowIso
      })
    ]);
  } catch (error) {
    if (await adminWriteWasRevoked(input.db, input.admin, error)) {
      return { ok: false, error: "forbidden" };
    }
    return recoverFromCreateBatchFailure({
      db: input.db,
      idempotencyKey: input.request.idempotencyKey,
      error,
      errorLabel: "createAdminStaff",
      nowIso,
      resolveReplay: (row) => resolveCreateIdempotency(row, requestHash)
    });
  }

  return { ok: true, staffId: id, replayed: false };
};

export const updateAdminStaff = async (input: {
  db: D1Database;
  admin: AdminUser;
  staffId: string;
  request: AdminStaffUpdateRequest;
  now?: () => number;
}): Promise<AdminStaffUpdateResult> => {
  if (!isAdminPrivileged(input.admin.role)) {
    return { ok: false, error: "forbidden" };
  }
  // Store-login sentinel rows (staff_login_<store>) are not real employees and
  // are managed only via the /store-logins endpoints. Mutating one here would
  // propagate role/active to the linked store-login admin_users row and could
  // silently revoke the shared login (codex PR #308 review, Fix C).
  if (isStoreLoginSentinelStaffId(input.staffId)) {
    return { ok: false, error: "not_found" };
  }
  // F-3.2: prevent an admin from deactivating their own staff row, which would
  // atomically revoke their admin_users access and lock them out. The guard is
  // skipped when staff_member_id is null (system_admins / service tokens have
  // no underlying staff_members row and cannot self-lockout this way).
  if (isSelfDeactivation(input.admin, input.staffId, input.request.active)) {
    return { ok: false, error: "forbidden_self_deactivation" };
  }
  // F-3.3 (escalate guard): only system_admin can promote a row to
  // system_admin. Caught BEFORE the DB read so an unauthorized request
  // doesn't even fetch the target row. Variable avoids TS6 inferred
  // type-predicate narrowing on isAdminPrivileged.
  const callerIsSA = input.admin.role === "system_admin";
  if (input.request.role === "system_admin" && !callerIsSA) {
    console.warn("[settings-staff] forbidden_role_escalation refused", {
      reason: "insufficient-role",
      adminId: input.admin.id,
      adminRole: input.admin.role,
      targetStaffId: input.staffId,
      requestedRole: input.request.role,
      path: "update"
    });
    await recordForbiddenRoleEscalationAudit({
      db: input.db,
      admin: input.admin,
      path: "update",
      targetStaffId: input.staffId,
      requestedRole: input.request.role,
      requestedActive: input.request.active,
      now: input.now
    });
    return { ok: false, error: "forbidden_role_escalation" };
  }
  if (!(await storeExists(input.db, input.request.storeId))) {
    return { ok: false, error: "store_not_found" };
  }
  const current = await fetchStaff(input.db, input.staffId);
  if (!current) {
    return { ok: false, error: "not_found" };
  }
  // F-3.3 (demote guard): non-system_admin callers may not modify a
  // row whose current role is system_admin (no demotion, no rename, no
  // deactivation, no store move). Without this, an owner-tier caller
  // could remove all system_admins and block elevated administration
  // (drift-sweep, sentry-test). Codex review iter1 adopted.
  if (current.role === "system_admin" && input.admin.role !== "system_admin") {
    console.warn("[settings-staff] forbidden_role_escalation refused (demote)", {
      adminId: input.admin.id,
      adminRole: input.admin.role,
      targetStaffId: input.staffId,
      targetRole: current.role,
      requestedRole: input.request.role,
      requestedActive: input.request.active,
      path: "update"
    });
    await recordForbiddenRoleEscalationAudit({
      db: input.db,
      admin: input.admin,
      path: "update",
      targetStaffId: input.staffId,
      targetRole: current.role,
      requestedRole: input.request.role,
      requestedActive: input.request.active,
      now: input.now
    });
    return { ok: false, error: "forbidden_role_escalation" };
  }
  // F-3.3 (self-promotion guard): a system_admin may not promote their
  // own staff row to system_admin. Runs post-DB so we can distinguish
  // actual promotions (current != SA) from no-op role retention (current == SA).
  if (
    input.request.role === "system_admin" &&
    current.role !== "system_admin" &&
    input.admin.staff_member_id != null &&
    input.admin.staff_member_id === input.staffId
  ) {
    console.warn("[settings-staff] forbidden_role_escalation refused", {
      reason: "self-promotion",
      adminId: input.admin.id,
      targetStaffId: input.staffId,
      currentRole: current.role,
      requestedRole: input.request.role,
      path: "update"
    });
    await recordForbiddenRoleEscalationAudit({
      db: input.db,
      admin: input.admin,
      path: "update",
      targetStaffId: input.staffId,
      requestedRole: input.request.role,
      requestedActive: input.request.active,
      now: input.now
    });
    return { ok: false, error: "forbidden_role_escalation" };
  }
  const storeGuard = guardImmutableStore(current.store_id, input.request.storeId);
  if (storeGuard) return storeGuard;
  if (current.version !== input.request.expectedVersion) {
    return { ok: false, error: "stale_snapshot" };
  }
  const nowIso = new Date((input.now ?? Date.now)()).toISOString();
  const activeInt = input.request.active ? 1 : 0;

  try {
    await input.db.batch([
      adminWriteGuard(input.db, input.admin),
      input.db
        .prepare(
          `UPDATE staff_members
           SET store_id = ?, display_name = ?, role = ?, active = ?,
               version = version + 1, updated_at = ?
           WHERE id = ? AND version = ?`
        )
        .bind(
          input.request.storeId,
          input.request.displayName,
          input.request.role,
          activeInt,
          nowIso,
          input.staffId,
          input.request.expectedVersion
        ),
      input.db
        .prepare(
          `INSERT INTO audit_logs (
             id, actor_type, actor_id, action, target_type, target_id, metadata_json
           ) VALUES (
             ?,
             CASE WHEN changes() = 1 THEN 'staff' ELSE 'staff_update_conflict' END,
             ?, 'settings.staff.update', 'staff_member', ?, ?
           )`
        )
        .bind(
          crypto.randomUUID(),
          input.admin.id,
          input.staffId,
          JSON.stringify({
            staffId: input.staffId,
            before: {
              storeId: current.store_id,
              displayName: current.display_name,
              role: current.role,
              active: current.active === 1,
              version: current.version
            },
            after: {
              storeId: input.request.storeId,
              displayName: input.request.displayName,
              role: input.request.role,
              active: input.request.active,
              version: input.request.expectedVersion + 1
            },
            adminRole: input.admin.role,
            linkedAdminUsersSynced: true
          })
        ),
      // 顧客タブの承認 (spec 008) は admin_user_id だけで引くので、役割を入れ替えても
      // 12 時間の承認がそのまま残る。staff → owner → staff と往復すればコード無しで
      // 顧客タブが開いてしまうため、役割が実際に変わるときは落とす。無効化中の行も同じで、
      // authenticateAdmin が active = 1 を要求するあいだ承認は死んでいるが、12 時間以内に
      // 再有効化するとそのまま生き返る。名前だけの編集で毎回落とすと、オーナーが設定を
      // 触るたびにスタッフが再申請することになるので、その 2 つの場合に限る。UPDATE より
      // 前に置くのは、ここで比較する role と active が変更前の値である必要があるから。
      input.db
        .prepare(
          `DELETE FROM admin_customer_gate_challenges
           WHERE admin_user_id IN (
             SELECT id FROM admin_users
             WHERE staff_member_id = ? AND (role <> ? OR active = 0)
           )`
        )
        .bind(input.staffId, input.request.role),
      // authenticateAdmin authorizes from admin_users.role + admin_users.active,
      // not from the linked staff_members row. Promote/demote and deactivate
      // through this endpoint must propagate so the privilege change takes
      // effect on the next admin API call. Same D1 batch keeps the two rows
      // atomic with the audit_logs entry.
      input.db
        .prepare(
          `UPDATE admin_users
           SET role = ?, active = ?, updated_at = ?
           WHERE staff_member_id = ?`
        )
        .bind(input.request.role, activeInt, nowIso, input.staffId)
    ]);
  } catch (error) {
    return handleStaffUpdateBatchError(
      input.db,
      input.admin,
      error,
      input.staffId,
      input.request.expectedVersion
    );
  }

  return { ok: true, staffId: input.staffId };
};

export const softDeleteAdminStaff = async (input: {
  db: D1Database;
  admin: AdminUser;
  staffId: string;
  now?: () => number;
}): Promise<AdminStaffDeleteResult> => {
  if (!isAdminPrivileged(input.admin.role)) {
    return { ok: false, error: "forbidden" };
  }
  // Store-login sentinel rows are managed only via /store-logins (Fix C). Refuse
  // to soft-delete one here — it would revoke the linked shared store login.
  if (isStoreLoginSentinelStaffId(input.staffId)) {
    return { ok: false, error: "not_found" };
  }
  // F-3.2: same self-deactivation guard as updateAdminStaff — soft-delete
  // always sets active=0 so the transition is always 1→0.
  if (isSelfDeactivation(input.admin, input.staffId, false)) {
    return { ok: false, error: "forbidden_self_deactivation" };
  }
  const current = await fetchStaff(input.db, input.staffId);
  if (!current) {
    return { ok: false, error: "not_found" };
  }
  // F-3.3 (demote guard): non-system_admin callers may not soft-delete
  // a system_admin row. Codex review iter1 adopted — without this an
  // owner could revoke higher-tier oversight via the delete endpoint.
  if (current.role === "system_admin" && input.admin.role !== "system_admin") {
    console.warn("[settings-staff] forbidden_role_escalation refused (delete)", {
      adminId: input.admin.id,
      adminRole: input.admin.role,
      targetStaffId: input.staffId,
      targetRole: current.role,
      path: "delete"
    });
    await recordForbiddenRoleEscalationAudit({
      db: input.db,
      admin: input.admin,
      path: "delete",
      targetStaffId: input.staffId,
      targetRole: current.role,
      now: input.now
    });
    return { ok: false, error: "forbidden_role_escalation" };
  }
  const nowIso = new Date((input.now ?? Date.now)()).toISOString();

  try {
    await input.db.batch([
      adminWriteGuard(input.db, input.admin),
      // Order matters: staff_members UPDATE first so the audit_logs INSERT's
      // CASE WHEN changes()=1 anchor reflects the staff_members outcome.
      // admin_users UPDATE happens last — its row count is independent of
      // whether linked accounts exist (zero matches is a valid no-op), and
      // batch atomicity still ensures it either commits with the rest or
      // rolls back together.
      input.db
        .prepare(
          `UPDATE staff_members
           SET active = 0, version = version + 1, updated_at = ?
           WHERE id = ?`
        )
        .bind(nowIso, input.staffId),
      input.db
        .prepare(
          `INSERT INTO audit_logs (
             id, actor_type, actor_id, action, target_type, target_id, metadata_json
           ) VALUES (
             ?,
             CASE WHEN changes() = 1 THEN 'staff' ELSE 'staff_update_conflict' END,
             ?, 'settings.staff.delete', 'staff_member', ?, ?
           )`
        )
        .bind(
          crypto.randomUUID(),
          input.admin.id,
          input.staffId,
          JSON.stringify({
            staffId: input.staffId,
            before: {
              storeId: current.store_id,
              displayName: current.display_name,
              role: current.role,
              active: current.active === 1
            },
            softDelete: true,
            adminRole: input.admin.role,
            linkedAdminUsersRevoked: true
          })
        ),
      // Revoke linked admin_users: authenticateAdmin authorizes solely from
      // admin_users.active=1, so flipping staff_members.active alone would
      // let the deactivated staff member keep using admin APIs until an
      // operator manually disabled the matching admin_users row. Atomic
      // with the staff_members + audit_logs writes via the same D1 batch.
      input.db
        .prepare(
          `UPDATE admin_users
           SET active = 0, updated_at = ?
           WHERE staff_member_id = ? AND active = 1`
        )
        .bind(nowIso, input.staffId)
    ]);
  } catch (error) {
    if (await adminWriteWasRevoked(input.db, input.admin, error)) {
      return { ok: false, error: "forbidden" };
    }
    if (isActorTypeBatchError(error)) {
      const fresh = await fetchStaff(input.db, input.staffId);
      if (!fresh) return { ok: false, error: "not_found" };
      return { ok: false, error: "write_failed" };
    }
    console.error("softDeleteAdminStaff batch failed", {
      staffId: input.staffId,
      error: readErrorMessage(error)
    });
    return { ok: false, error: "write_failed" };
  }

  return { ok: true, staffId: input.staffId };
};
