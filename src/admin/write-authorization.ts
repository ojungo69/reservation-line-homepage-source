import type { AdminUser } from "./access";
import { isActorTypeBatchError } from "./settings-common";

// Preserve the role/store decision already made by the service, but only while
// the authenticated actor's authorization snapshot still matches the database.
export const adminWriteSnapshot = (admin: AdminUser) => ({
  sql: `EXISTS (
    SELECT 1 FROM admin_users au
    LEFT JOIN staff_members sm ON sm.id = au.staff_member_id
    WHERE au.id = ? AND au.active = 1 AND au.role = ?
      AND au.staff_member_id IS ? AND sm.store_id IS ?
  )`,
  bindings: [admin.id, admin.role, admin.staff_member_id, admin.store_id]
});

// First statement in a mutation batch. A current actor inserts nothing; a stale
// actor hits the existing audit actor_type CHECK and aborts the whole transaction.
// Keep this before domain writes, never between an UPDATE and its changes() gate.
export const adminWriteGuard = (db: D1Database, admin: AdminUser): D1PreparedStatement => {
  const snapshot = adminWriteSnapshot(admin);
  return db.prepare(`
    INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id)
    SELECT ?, 'admin_write_forbidden', ?, 'admin.write.guard', 'admin_user', ?
    WHERE NOT ${snapshot.sql}
  `).bind(crypto.randomUUID(), admin.id, admin.id, ...snapshot.bindings);
};

// A fail-closed checkpoint before starting an external operation. Delivery itself
// cannot share the D1 transaction; already-started side effects remain irreversible.
export const assertAdminWriteCurrent = async (db: D1Database, admin: AdminUser): Promise<void> => {
  await db.batch([adminWriteGuard(db, admin)]);
};

// Classification only, after the atomic guard already rejected/rolled back the
// write. An unrelated CHECK or an actor restored after rejection retains the
// caller's existing conflict handling. A failed read cannot prove revocation.
export const adminWriteWasRevoked = async (
  db: D1Database,
  admin: AdminUser,
  error?: unknown
): Promise<boolean> => {
  if (error !== undefined && !isActorTypeBatchError(error)) return false;
  const snapshot = adminWriteSnapshot(admin);
  try {
    const row = await db.prepare(`SELECT 1 AS authorized WHERE ${snapshot.sql}`)
      .bind(...snapshot.bindings).first();
    return row === null;
  } catch {
    return false;
  }
};
