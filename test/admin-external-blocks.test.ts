import { describe, expect, it } from "vitest";

import type { AdminUser } from "../src/admin/access";
import {
  cancelAdminExternalBlock,
  createAdminExternalBlock
} from "../src/admin/external-blocks";
import { createMigratedSqliteD1 as createBaseD1 } from "./helpers/sqlite-d1";

const OWNER_ADMIN: AdminUser = {
  id: "admin_owner_1",
  email: "owner@example.com",
  role: "owner",
  staff_member_id: null,
store_id: null
};

const STAFF_ADMIN: AdminUser = {
  id: "admin_staff_1",
  email: "staff@example.com",
  role: "staff",
  staff_member_id: null,
store_id: null
};

const SYSTEM_ADMIN: AdminUser = {
  id: "admin_system_1",
  email: "admin@example.com",
  role: "system_admin",
  staff_member_id: null,
store_id: null
};

const BASE_CREATE_REQUEST = {
  storeId: "kyoto",
  resourceId: "resource_kyoto_calendar",
  startAt: "2099-07-01T01:00:00.000Z",
  endAt: "2099-07-01T02:00:00.000Z",
  title: "店内作業"
};

describe("createAdminExternalBlock staff gate", () => {
  it("rejects staff before idempotency lookup, returning forbidden", async () => {
    const db = createMigratedSqliteD1();
    try {
      const result = await createAdminExternalBlock({
        db: db as unknown as D1Database,
        admin: STAFF_ADMIN,
        request: { idempotencyKey: "ext-block-staff-create-1", ...BASE_CREATE_REQUEST }
      });
      expect(result).toEqual({ ok: false, reason: "forbidden" });

      const idempotencyCount = db.sqlite
        .prepare(
          `SELECT COUNT(*) AS count FROM idempotency_keys WHERE idempotency_key = 'ext-block-staff-create-1'`
        )
        .get() as { count: number };
      expect(idempotencyCount.count).toBe(0);

      const blockCount = db.sqlite
        .prepare(`SELECT COUNT(*) AS count FROM external_blocks`)
        .get() as { count: number };
      expect(blockCount.count).toBe(0);
    } finally {
      db.sqlite.close();
    }
  });

  it("allows system_admin to create external block", async () => {
    const db = createMigratedSqliteD1();
    try {
      const result = await createAdminExternalBlock({
        db: db as unknown as D1Database,
        admin: SYSTEM_ADMIN,
        request: { idempotencyKey: "ext-block-sysadmin-create-1", ...BASE_CREATE_REQUEST }
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("test setup failed");
      }
      expect(result.status).toBe("active");
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects staff with forbidden even when reusing owner's successful idempotency key", async () => {
    const db = createMigratedSqliteD1();
    try {
      const sharedKey = "ext-block-shared-key-create-1";
      const ownerResult = await createAdminExternalBlock({
        db: db as unknown as D1Database,
        admin: OWNER_ADMIN,
        request: { idempotencyKey: sharedKey, ...BASE_CREATE_REQUEST }
      });
      expect(ownerResult.ok).toBe(true);
      if (!ownerResult.ok) {
        throw new Error("test setup failed");
      }
      const ownerBlockId = ownerResult.externalBlockId;

      const staffReuse = await createAdminExternalBlock({
        db: db as unknown as D1Database,
        admin: STAFF_ADMIN,
        request: { idempotencyKey: sharedKey, ...BASE_CREATE_REQUEST }
      });
      expect(staffReuse).toEqual({ ok: false, reason: "forbidden" });

      const blockCount = db.sqlite
        .prepare(`SELECT COUNT(*) AS count FROM external_blocks`)
        .get() as { count: number };
      expect(blockCount.count).toBe(1);

      const idempotencyRow = db.sqlite
        .prepare(
          `SELECT target_id FROM idempotency_keys WHERE idempotency_key = ?`
        )
        .get(sharedKey) as { target_id: string };
      expect(idempotencyRow.target_id).toBe(ownerBlockId);
    } finally {
      db.sqlite.close();
    }
  });
});

describe("createAdminExternalBlock expired pending locks", () => {
  it("reclaims an expired pending slot_lock before creating the external block", async () => {
    const db = createMigratedSqliteD1();
    try {
      db.sqlite
        .prepare(
          `INSERT INTO slot_locks (
             id, store_id, resource_id, slot_at, owner_type, owner_id, lock_status, expires_at
           ) VALUES (
             'expired_pending_external_block_test', 'kyoto', 'resource_kyoto_calendar', ?,
             'reservation', 'expired_pending_reservation', 'pending', '2099-06-29T00:00:00.000Z'
           )`
        )
        .run(BASE_CREATE_REQUEST.startAt);

      const result = await createAdminExternalBlock({
        db: db as unknown as D1Database,
        admin: OWNER_ADMIN,
        request: { idempotencyKey: "ext-block-expired-pending-1", ...BASE_CREATE_REQUEST },
        now: () => Date.parse("2099-06-30T00:00:00.000Z")
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(
        db.sqlite
          .prepare(
            `SELECT owner_type, owner_id, lock_status, expires_at
             FROM slot_locks
             WHERE store_id = 'kyoto'
               AND resource_id = 'resource_kyoto_calendar'
               AND slot_at = ?`
          )
          .get(BASE_CREATE_REQUEST.startAt)
      ).toEqual({
        owner_type: "external_block",
        owner_id: result.externalBlockId,
        lock_status: "confirmed",
        expires_at: null
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects an unexpired pending slot_lock and preserves the lock", async () => {
    const db = createMigratedSqliteD1();
    try {
      db.sqlite
        .prepare(
          `INSERT INTO slot_locks (
             id, store_id, resource_id, slot_at, owner_type, owner_id, lock_status, expires_at
           ) VALUES (
             'unexpired_pending_external_block_test', 'kyoto', 'resource_kyoto_calendar', ?,
             'reservation', 'unexpired_pending_reservation', 'pending', '2099-07-02T00:00:00.000Z'
           )`
        )
        .run(BASE_CREATE_REQUEST.startAt);

      const result = await createAdminExternalBlock({
        db: db as unknown as D1Database,
        admin: OWNER_ADMIN,
        request: { idempotencyKey: "ext-block-unexpired-pending-1", ...BASE_CREATE_REQUEST },
        now: () => Date.parse("2099-06-30T00:00:00.000Z")
      });

      expect(result).toEqual({ ok: false, reason: "slot_unavailable" });
      expect(
        db.sqlite
          .prepare(
            `SELECT owner_type, owner_id, lock_status, expires_at
             FROM slot_locks
             WHERE id = 'unexpired_pending_external_block_test'`
          )
          .get()
      ).toEqual({
        owner_type: "reservation",
        owner_id: "unexpired_pending_reservation",
        lock_status: "pending",
        expires_at: "2099-07-02T00:00:00.000Z"
      });
    } finally {
      db.sqlite.close();
    }
  });
});

describe("createAdminExternalBlock duration cap", () => {
  it("rejects external block longer than 2 days as invalid_time (DoS guard)", async () => {
    const db = createMigratedSqliteD1();
    try {
      const result = await createAdminExternalBlock({
        db: db as unknown as D1Database,
        admin: OWNER_ADMIN,
        request: {
          idempotencyKey: "ext-block-duration-cap-1",
          storeId: BASE_CREATE_REQUEST.storeId,
          resourceId: BASE_CREATE_REQUEST.resourceId,
          startAt: "2099-07-01T01:00:00.000Z",
          endAt: "2099-07-05T01:00:00.000Z" // 4 days > 2 day cap
        }
      });
      expect(result).toEqual({ ok: false, reason: "invalid_time" });

      const blockCount = db.sqlite
        .prepare(`SELECT COUNT(*) AS count FROM external_blocks`)
        .get() as { count: number };
      expect(blockCount.count).toBe(0);
    } finally {
      db.sqlite.close();
    }
  });

  it("accepts external block exactly 2 days (boundary)", async () => {
    const db = createMigratedSqliteD1();
    try {
      const result = await createAdminExternalBlock({
        db: db as unknown as D1Database,
        admin: OWNER_ADMIN,
        request: {
          idempotencyKey: "ext-block-duration-cap-2",
          storeId: BASE_CREATE_REQUEST.storeId,
          resourceId: BASE_CREATE_REQUEST.resourceId,
          startAt: "2099-07-01T01:00:00.000Z",
          endAt: "2099-07-03T01:00:00.000Z" // exactly 2 days
        }
      });
      expect(result.ok).toBe(true);
    } finally {
      db.sqlite.close();
    }
  });
});

describe("cancelAdminExternalBlock staff gate", () => {
  it("rejects staff before idempotency lookup, returning forbidden", async () => {
    const db = createMigratedSqliteD1();
    try {
      const created = await createAdminExternalBlock({
        db: db as unknown as D1Database,
        admin: OWNER_ADMIN,
        request: { idempotencyKey: "ext-block-owner-create-cancel-1", ...BASE_CREATE_REQUEST }
      });
      expect(created.ok).toBe(true);
      if (!created.ok) {
        throw new Error("test setup failed");
      }

      const result = await cancelAdminExternalBlock({
        db: db as unknown as D1Database,
        admin: STAFF_ADMIN,
        externalBlockId: created.externalBlockId,
        request: {
          idempotencyKey: "ext-block-staff-cancel-1",
          reason: "テスト"
        }
      });
      expect(result).toEqual({ ok: false, reason: "forbidden" });

      const blockStatus = db.sqlite
        .prepare(`SELECT status FROM external_blocks WHERE id = ?`)
        .get(created.externalBlockId) as { status: string };
      expect(blockStatus.status).toBe("active");
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects staff with forbidden when reusing owner's successful cancel idempotency key", async () => {
    const db = createMigratedSqliteD1();
    try {
      const created = await createAdminExternalBlock({
        db: db as unknown as D1Database,
        admin: OWNER_ADMIN,
        request: { idempotencyKey: "ext-block-create-share-cancel-1", ...BASE_CREATE_REQUEST }
      });
      expect(created.ok).toBe(true);
      if (!created.ok) {
        throw new Error("test setup failed");
      }

      const sharedCancelKey = "ext-block-shared-cancel-key-1";
      const ownerCancel = await cancelAdminExternalBlock({
        db: db as unknown as D1Database,
        admin: OWNER_ADMIN,
        externalBlockId: created.externalBlockId,
        request: { idempotencyKey: sharedCancelKey, reason: "予定変更" }
      });
      expect(ownerCancel.ok).toBe(true);

      const staffReuse = await cancelAdminExternalBlock({
        db: db as unknown as D1Database,
        admin: STAFF_ADMIN,
        externalBlockId: created.externalBlockId,
        request: { idempotencyKey: sharedCancelKey, reason: "予定変更" }
      });
      expect(staffReuse).toEqual({ ok: false, reason: "forbidden" });
    } finally {
      db.sqlite.close();
    }
  });
});

describe("external block idempotency batch failure (expired TTL)", () => {
  it("returns write_failed (not idempotency_in_progress) when an expired row collides on create", async () => {
    const db = createMigratedSqliteD1();
    try {
      // A crashed request's "started" row, already past its TTL relative to the clock below.
      db.sqlite
        .prepare(
          `
            INSERT INTO idempotency_keys (
              id, scope, idempotency_key, status, request_hash, expires_at
            ) VALUES (
              'ext_block_create_expired_1', 'admin_action',
              'ext-block-create-expired-1', 'started', 'stale-request-hash',
              '2099-06-29T00:00:00.000Z'
            )
          `
        )
        .run();

      const result = await createAdminExternalBlock({
        db: db as unknown as D1Database,
        admin: OWNER_ADMIN,
        request: { idempotencyKey: "ext-block-create-expired-1", ...BASE_CREATE_REQUEST },
        now: () => Date.parse("2099-06-30T00:00:00.000Z")
      });

      expect(result).toEqual({ ok: false, reason: "write_failed" });
      const counts = db.sqlite
        .prepare(
          `
            SELECT
              (SELECT COUNT(*) FROM external_blocks) AS blockCount,
              (SELECT COUNT(*) FROM idempotency_keys WHERE idempotency_key = 'ext-block-create-expired-1') AS idempotencyCount
          `
        )
        .get() as { blockCount: number; idempotencyCount: number };
      // Atomic rollback: no block written, only the pre-existing expired row remains.
      expect(counts).toEqual({ blockCount: 0, idempotencyCount: 1 });
    } finally {
      db.sqlite.close();
    }
  });

  it("returns write_failed (not idempotency_in_progress) when an expired row collides on cancel", async () => {
    const db = createMigratedSqliteD1();
    try {
      const created = await createAdminExternalBlock({
        db: db as unknown as D1Database,
        admin: OWNER_ADMIN,
        request: { idempotencyKey: "ext-block-cancel-setup-1", ...BASE_CREATE_REQUEST }
      });
      expect(created.ok).toBe(true);
      if (!created.ok) {
        throw new Error("test setup failed");
      }

      db.sqlite
        .prepare(
          `
            INSERT INTO idempotency_keys (
              id, scope, idempotency_key, status, request_hash, expires_at
            ) VALUES (
              'ext_block_cancel_expired_1', 'admin_action',
              'ext-block-cancel-expired-1', 'started', 'stale-request-hash',
              '2099-06-29T00:00:00.000Z'
            )
          `
        )
        .run();

      const result = await cancelAdminExternalBlock({
        db: db as unknown as D1Database,
        admin: OWNER_ADMIN,
        externalBlockId: created.externalBlockId,
        request: { idempotencyKey: "ext-block-cancel-expired-1", reason: "TTL期限切れ" },
        now: () => Date.parse("2099-06-30T00:00:00.000Z")
      });

      expect(result).toEqual({ ok: false, reason: "write_failed" });
      const state = db.sqlite
        .prepare(
          `
            SELECT
              (SELECT status FROM external_blocks WHERE id = ?) AS status,
              (SELECT COUNT(*) FROM idempotency_keys WHERE idempotency_key = 'ext-block-cancel-expired-1') AS idempotencyCount
          `
        )
        .get(created.externalBlockId) as { status: string; idempotencyCount: number };
      // Atomic rollback: block still active, only the pre-existing expired row remains.
      expect(state).toEqual({ status: "active", idempotencyCount: 1 });
    } finally {
      db.sqlite.close();
    }
  });
});

// Domain calls use the same persisted actor snapshot as authenticated routes.
const createMigratedSqliteD1 = () => {
  const db = createBaseD1();
  db.sqlite.exec("INSERT INTO admin_users(id,email,access_subject,role) VALUES ('admin_owner_1','admin_owner_1@example.test','admin_owner_1','owner'), ('admin_system_1','admin_system_1@example.test','admin_system_1','system_admin')");
  return db;
};
