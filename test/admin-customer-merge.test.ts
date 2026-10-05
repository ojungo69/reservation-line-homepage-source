import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import { createAccessJwksFetchMock, createAccessJwtFixture, insertAdminUser as insertAdminUserHelper, type AdminRole } from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const TEAM_DOMAIN = "https://team.example.cloudflareaccess.com";
const ACCESS_AUD = "admin-customer-merge-aud";
const ADMIN_EMAIL = "owner@example.com";
const ADMIN_ACCESS_SUBJECT = "access-subject-admin-customer-merge";
const ACCESS_KEY_ID = "admin-customer-merge-key-1";


const createTestAccessJwt = () =>
  createAccessJwtFixture({
    issuer: TEAM_DOMAIN,
    audience: ACCESS_AUD,
    keyId: ACCESS_KEY_ID,
    claims: { email: ADMIN_EMAIL, sub: ADMIN_ACCESS_SUBJECT }
  });

const insertAdminUser = (db: SqliteD1Database, role: AdminRole = "owner") =>
  insertAdminUserHelper(db, {
    id: "admin_customer_merge_1",
    email: ADMIN_EMAIL,
    accessSubject: ADMIN_ACCESS_SUBJECT,
    role,
    updatedAt: "2026-05-19T00:00:00.000Z",
  });

const baseEnv = (db: SqliteD1Database): Record<string, unknown> => ({
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  ACCESS_AUD,
  DB: db
});

const adminRequest = (
  db: SqliteD1Database,
  token: string,
  path: string,
  body: Record<string, unknown>
) => {
  const app = createApp();
  return app.request(
    path,
    {
      method: "POST",
      headers: {
        "Cf-Access-Jwt-Assertion": token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    },
    baseEnv(db)
  );
};

const seedCustomer = (
  db: SqliteD1Database,
  input: {
    id: string;
    name: string;
    phoneHash: string;
    blockStatus?: "active" | "blocked";
    mergedIntoId?: string | null;
    allergyNotes?: string | null;
    memo?: string | null;
    birthDate?: string | null;
    gender?: string | null;
  }
) => {
  db.sqlite
    .prepare(
      `
        INSERT INTO customers (
          id,
          display_name,
          phone_normalized,
          phone_hash,
          block_status,
          merged_into_id,
          allergy_notes,
          memo,
          birth_date,
          gender,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-05-19T00:00:00.000Z')
      `
    )
    .run(
      input.id,
      input.name,
      "09012345678",
      input.phoneHash,
      input.blockStatus ?? "active",
      input.mergedIntoId ?? null,
      input.allergyNotes ?? null,
      input.memo ?? null,
      input.birthDate ?? null,
      input.gender ?? null
    );
};

const seedReservation = (db: SqliteD1Database, id: string, customerId: string) => {
  db.sqlite
    .prepare(
      `
        INSERT INTO reservations (
          id,
          store_id,
          service_id,
          customer_id,
          resource_id,
          source,
          status,
          start_at,
          end_at,
          duration_minutes,
          idempotency_key,
          created_at,
          updated_at
        ) VALUES (
          ?,
          'kyoto',
          'service_kyoto_default_60',
          ?,
          'resource_kyoto_calendar',
          'admin',
          'confirmed',
          '2026-06-01T01:00:00.000Z',
          '2026-06-01T02:00:00.000Z',
          60,
          ?,
          '2026-05-19T00:00:00.000Z',
          '2026-05-19T00:00:00.000Z'
        )
      `
    )
    .run(id, customerId, `merge-test-${id}`);
};

const seedLineIdentity = (db: SqliteD1Database, id: string, customerId: string, lineUserId: string) => {
  db.sqlite
    .prepare(
      `
        INSERT INTO line_identities (
          id, customer_id, provider, channel_id, line_user_id, friend_flag, created_at, updated_at
        ) VALUES (?, ?, 'line', 'channel-test', ?, 0, '2026-05-19T00:00:00.000Z', '2026-05-19T00:00:00.000Z')
      `
    )
    .run(id, customerId, lineUserId);
};

const seedCustomerVisit = (db: SqliteD1Database, id: string, customerId: string) => {
  db.sqlite
    .prepare(
      `
        INSERT INTO customer_visits (
          id, customer_id, store_id, visited_at, visit_source, recorded_by
        ) VALUES (?, ?, 'kyoto', '2026-04-01T00:00:00.000Z', 'reservation_completed', 'admin_customer_merge_1')
      `
    )
    .run(id, customerId);
};

const seedCustomerTimeLock = (db: SqliteD1Database, id: string, customerId: string, ownerId: string, slotAt: string) => {
  db.sqlite
    .prepare(
      `
        INSERT INTO customer_time_locks (
          id, customer_id, slot_at, owner_type, owner_id, lock_status
        ) VALUES (?, ?, ?, 'reservation', ?, 'confirmed')
      `
    )
    .run(id, customerId, slotAt, ownerId);
};

const readJson = async (response: Response) => response.json() as Promise<Record<string, unknown>>;

describe("POST /api/admin/customers/:id/merge", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("merges two customers with the same phone_hash, moves reservations, and writes an audit log", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedCustomer(db, { id: "customer_merge_source", name: "統合 元", phoneHash: "same-phone-hash" });
      seedCustomer(db, { id: "customer_merge_target", name: "統合 先", phoneHash: "same-phone-hash" });
      seedReservation(db, "reservation_merge_1", "customer_merge_source");
      seedReservation(db, "reservation_merge_2", "customer_merge_source");
      const access = createTestAccessJwt();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const response = await adminRequest(
        db,
        access.token,
        "/api/admin/customers/customer_merge_source/merge",
        { targetId: "customer_merge_target" }
      );

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        ok: true,
        sourceId: "customer_merge_source",
        targetId: "customer_merge_target",
        reservationsMoved: 2
      });
      expect(
        (
          db.sqlite
            .prepare("SELECT COUNT(*) AS count FROM reservations WHERE customer_id = 'customer_merge_target'")
            .get() as { count: number }
        ).count
      ).toBe(2);
      const source = db.sqlite
        .prepare("SELECT block_status, merged_into_id FROM customers WHERE id = 'customer_merge_source'")
        .get() as { block_status: string; merged_into_id: string | null };
      expect(source).toMatchObject({
        block_status: "blocked",
        merged_into_id: "customer_merge_target"
      });
      const audit = db.sqlite
        .prepare(
          `
            SELECT action, target_type, target_id, metadata_json
            FROM audit_logs
            WHERE action = 'customer.merge'
          `
        )
        .get() as { action: string; target_type: string; target_id: string; metadata_json: string };
      expect(audit).toMatchObject({
        action: "customer.merge",
        target_type: "customer",
        target_id: "customer_merge_source"
      });
      const parsedAudit = JSON.parse(audit.metadata_json);
      expect(parsedAudit).toMatchObject({
        sourceId: "customer_merge_source",
        targetId: "customer_merge_target",
        phone_hash_prefix: "same-pho",
        adminRole: "owner"
      });
      // PII guard: full phone_hash must NOT appear in audit metadata —
      // only the truncated prefix. Full hash stays in customers row.
      expect(parsedAudit.full_phone_hash).toBeUndefined();
      expect(audit.metadata_json).not.toContain("same-phone-hash");
    } finally {
      db.sqlite.close();
    }
  });

  it("carries allergy notes and memo only into blank target fields", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      const cases = [
        {
          id: "null_target",
          source: { allergyNotes: "花粉症", memo: "刺激の弱い薬剤を使用" },
          target: { allergyNotes: null, memo: null },
          expected: { allergy_notes: "花粉症", memo: "刺激の弱い薬剤を使用" }
        },
        {
          id: "valued_target",
          source: { allergyNotes: "source allergy", memo: "source memo" },
          target: { allergyNotes: "target allergy", memo: "target memo" },
          expected: { allergy_notes: "target allergy", memo: "target memo" }
        },
        {
          id: "whitespace_target",
          source: { allergyNotes: "金属アレルギー", memo: "パッチテスト済み" },
          target: { allergyNotes: " \u3000\n", memo: "\n\u3000 " },
          expected: { allergy_notes: "金属アレルギー", memo: "パッチテスト済み" }
        },
        {
          id: "blank_source",
          source: { allergyNotes: null, memo: " \u3000\n" },
          target: { allergyNotes: null, memo: null },
          expected: { allergy_notes: null, memo: null }
        }
      ] as const;
      const access = createTestAccessJwt();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      for (const testCase of cases) {
        const phoneHash = `notes-${testCase.id}`;
        const sourceId = `customer_${testCase.id}_source`;
        const targetId = `customer_${testCase.id}_target`;
        seedCustomer(db, {
          id: sourceId,
          name: `${testCase.id} source`,
          phoneHash,
          ...testCase.source
        });
        seedCustomer(db, {
          id: targetId,
          name: `${testCase.id} target`,
          phoneHash,
          ...testCase.target
        });

        const response = await adminRequest(db, access.token, `/api/admin/customers/${sourceId}/merge`, {
          targetId
        });

        expect(response.status, testCase.id).toBe(200);
        const targetNotes = db.sqlite
          .prepare("SELECT allergy_notes, memo FROM customers WHERE id = ?")
          .get(targetId) as { allergy_notes: string | null; memo: string | null };
        expect(targetNotes, testCase.id).toEqual(testCase.expected);
      }
    } finally {
      db.sqlite.close();
    }
  });

  // アレルギー情報とメモだけを拾っても、同じプロフィール欄に並ぶ生年月日と性別は
  // 同じ経路 (統合元が merged_into_id IS NULL の条件で一覧から消える) で読めなくなる。
  it("carries birth date and gender into blank target fields too", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      const access = createTestAccessJwt();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      seedCustomer(db, {
        id: "customer_profile_source",
        name: "profile source",
        phoneHash: "profile-phone-hash",
        birthDate: "1990-04-01",
        gender: "female"
      });
      seedCustomer(db, {
        id: "customer_profile_target",
        name: "profile target",
        phoneHash: "profile-phone-hash",
        birthDate: null,
        gender: null
      });

      const response = await adminRequest(db, access.token, "/api/admin/customers/customer_profile_source/merge", {
        targetId: "customer_profile_target"
      });
      expect(response.status).toBe(200);

      expect(
        db.sqlite.prepare("SELECT birth_date, gender FROM customers WHERE id = 'customer_profile_target'").get()
      ).toEqual({ birth_date: "1990-04-01", gender: "female" });
    } finally {
      db.sqlite.close();
    }
  });

  it("retargets line_identities, customer_visits, and customer_time_locks alongside reservations (multi-row guard)", async () => {
    // Two reservations + one line_identity + two visits + two locks
    // exercises the EXISTS-gated path: the previous (broken) chain on
    // `(SELECT changes())=1` would have left line_identities / visits /
    // locks on the source tombstone whenever reservations updated to
    // changes()=2, masking the cross-table inconsistency. Anchoring
    // every retarget on `EXISTS (audit_logs WHERE id=?)` keeps them
    // tied to the customers UPDATE outcome regardless of per-table
    // row counts.
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedCustomer(db, { id: "customer_multi_source", name: "multi source", phoneHash: "multi-phone-hash" });
      seedCustomer(db, { id: "customer_multi_target", name: "multi target", phoneHash: "multi-phone-hash" });
      seedReservation(db, "reservation_multi_1", "customer_multi_source");
      seedReservation(db, "reservation_multi_2", "customer_multi_source");
      seedLineIdentity(db, "line_identity_multi", "customer_multi_source", "U-multi-line-user");
      seedCustomerVisit(db, "visit_multi_1", "customer_multi_source");
      seedCustomerVisit(db, "visit_multi_2", "customer_multi_source");
      seedCustomerTimeLock(db, "lock_multi_1", "customer_multi_source", "reservation_multi_1", "2026-06-01T01:00:00.000Z");
      seedCustomerTimeLock(db, "lock_multi_2", "customer_multi_source", "reservation_multi_2", "2026-06-02T01:00:00.000Z");
      const access = createTestAccessJwt();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const response = await adminRequest(db, access.token, "/api/admin/customers/customer_multi_source/merge", {
        targetId: "customer_multi_target"
      });

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        ok: true,
        sourceId: "customer_multi_source",
        targetId: "customer_multi_target",
        reservationsMoved: 2
      });
      // Every customer_id-bound table must now point at the target.
      const counts = {
        reservations: (
          db.sqlite
            .prepare("SELECT COUNT(*) AS count FROM reservations WHERE customer_id = 'customer_multi_target'")
            .get() as { count: number }
        ).count,
        line_identities: (
          db.sqlite
            .prepare("SELECT COUNT(*) AS count FROM line_identities WHERE customer_id = 'customer_multi_target'")
            .get() as { count: number }
        ).count,
        customer_visits: (
          db.sqlite
            .prepare("SELECT COUNT(*) AS count FROM customer_visits WHERE customer_id = 'customer_multi_target'")
            .get() as { count: number }
        ).count,
        customer_time_locks: (
          db.sqlite
            .prepare("SELECT COUNT(*) AS count FROM customer_time_locks WHERE customer_id = 'customer_multi_target'")
            .get() as { count: number }
        ).count
      };
      expect(counts).toEqual({
        reservations: 2,
        line_identities: 1,
        customer_visits: 2,
        customer_time_locks: 2
      });

      // Nothing left behind on the source tombstone.
      const sourceOrphans = {
        reservations: (
          db.sqlite
            .prepare("SELECT COUNT(*) AS count FROM reservations WHERE customer_id = 'customer_multi_source'")
            .get() as { count: number }
        ).count,
        line_identities: (
          db.sqlite
            .prepare("SELECT COUNT(*) AS count FROM line_identities WHERE customer_id = 'customer_multi_source'")
            .get() as { count: number }
        ).count,
        customer_visits: (
          db.sqlite
            .prepare("SELECT COUNT(*) AS count FROM customer_visits WHERE customer_id = 'customer_multi_source'")
            .get() as { count: number }
        ).count,
        customer_time_locks: (
          db.sqlite
            .prepare("SELECT COUNT(*) AS count FROM customer_time_locks WHERE customer_id = 'customer_multi_source'")
            .get() as { count: number }
        ).count
      };
      expect(sourceOrphans).toEqual({
        reservations: 0,
        line_identities: 0,
        customer_visits: 0,
        customer_time_locks: 0
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("drops conflicting source customer_time_locks before retarget (target keeps canonical lock)", async () => {
    // Duplicate customers can each have a lock at the same slot (each
    // bound to its own reservation). A naive UPDATE customer_id=target
    // would collide with UNIQUE(customer_id, slot_at). The DELETE-then-
    // UPDATE chain keeps the target's existing lock and discards the
    // redundant source-side lock for that slot, while non-overlapping
    // source locks retarget normally.
    const conflictSlot = "2026-06-10T01:00:00.000Z";
    const uniqueSlot = "2026-06-11T01:00:00.000Z";
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedCustomer(db, { id: "customer_lock_source", name: "lock source", phoneHash: "lock-phone-hash" });
      seedCustomer(db, { id: "customer_lock_target", name: "lock target", phoneHash: "lock-phone-hash" });
      seedReservation(db, "reservation_lock_source", "customer_lock_source");
      seedReservation(db, "reservation_lock_target", "customer_lock_target");
      seedCustomerTimeLock(db, "lock_source_conflict", "customer_lock_source", "reservation_lock_source", conflictSlot);
      seedCustomerTimeLock(db, "lock_source_unique", "customer_lock_source", "reservation_lock_source", uniqueSlot);
      seedCustomerTimeLock(db, "lock_target_conflict", "customer_lock_target", "reservation_lock_target", conflictSlot);
      const access = createTestAccessJwt();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const response = await adminRequest(db, access.token, "/api/admin/customers/customer_lock_source/merge", {
        targetId: "customer_lock_target"
      });

      expect(response.status).toBe(200);
      const targetLocks = db.sqlite
        .prepare(
          "SELECT id, slot_at FROM customer_time_locks WHERE customer_id = 'customer_lock_target' ORDER BY slot_at"
        )
        .all() as Array<{ id: string; slot_at: string }>;
      // Target should have its original conflict-slot lock plus the
      // retargeted unique-slot lock from source. The source's conflict
      // lock is gone (dropped, not retargeted).
      expect(targetLocks).toEqual([
        { id: "lock_target_conflict", slot_at: conflictSlot },
        { id: "lock_source_unique", slot_at: uniqueSlot }
      ]);
      const sourceLocks = (
        db.sqlite
          .prepare("SELECT COUNT(*) AS count FROM customer_time_locks WHERE customer_id = 'customer_lock_source'")
          .get() as { count: number }
      ).count;
      expect(sourceLocks).toBe(0);
    } finally {
      db.sqlite.close();
    }
  });

  it("retargets line_identities when there are zero reservations (zero-row guard)", async () => {
    // If reservations had been a 0-row UPDATE, the previous `(SELECT
    // changes())=1` chain would have left line_identities on the source
    // (changes()=0 from reservations propagating forward). With the
    // EXISTS gate, the absence of reservations does not affect downstream
    // retargets.
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedCustomer(db, { id: "customer_zero_source", name: "zero source", phoneHash: "zero-phone-hash" });
      seedCustomer(db, { id: "customer_zero_target", name: "zero target", phoneHash: "zero-phone-hash" });
      seedLineIdentity(db, "line_identity_zero", "customer_zero_source", "U-zero-line-user");
      const access = createTestAccessJwt();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const response = await adminRequest(db, access.token, "/api/admin/customers/customer_zero_source/merge", {
        targetId: "customer_zero_target"
      });

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        ok: true,
        reservationsMoved: 0
      });
      const identityRow = db.sqlite
        .prepare("SELECT customer_id FROM line_identities WHERE id = 'line_identity_zero'")
        .get() as { customer_id: string };
      expect(identityRow.customer_id).toBe("customer_zero_target");
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 400 when sourceId and targetId are the same", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      const access = createTestAccessJwt();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const response = await adminRequest(db, access.token, "/api/admin/customers/customer_same/merge", {
        targetId: "customer_same"
      });

      expect(response.status).toBe(400);
      await expect(readJson(response)).resolves.toMatchObject({ ok: false, error: "same_customer" });
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 404 when the source or target customer is missing", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedCustomer(db, { id: "customer_existing", name: "存在 顧客", phoneHash: "same-phone-hash" });
      const access = createTestAccessJwt();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const response = await adminRequest(db, access.token, "/api/admin/customers/customer_missing/merge", {
        targetId: "customer_existing"
      });

      expect(response.status).toBe(404);
      await expect(readJson(response)).resolves.toMatchObject({ ok: false, error: "not_found" });
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 400 when phone_hash differs", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedCustomer(db, { id: "customer_hash_source", name: "不一致 元", phoneHash: "source-phone-hash" });
      seedCustomer(db, { id: "customer_hash_target", name: "不一致 先", phoneHash: "target-phone-hash" });
      const access = createTestAccessJwt();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const response = await adminRequest(db, access.token, "/api/admin/customers/customer_hash_source/merge", {
        targetId: "customer_hash_target"
      });

      expect(response.status).toBe(400);
      await expect(readJson(response)).resolves.toMatchObject({ ok: false, error: "phone_hash_mismatch" });
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 403 for staff role", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "staff");
      const access = createTestAccessJwt();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const response = await adminRequest(db, access.token, "/api/admin/customers/customer_merge_source/merge", {
        targetId: "customer_merge_target"
      });

      expect(response.status).toBe(403);
      await expect(readJson(response)).resolves.toMatchObject({ ok: false, error: "forbidden" });
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 409 source_blocked when the source carries a manual block (preserve admin intent)", async () => {
    // A pre-merge blocked source signals an explicit admin decision to
    // refuse bookings for that phone. Silently retiring it to a merge
    // tombstone would let the canonical target keep accepting bookings
    // because the tombstone-aware lookups in this PR skip merged_into_id
    // rows. Refuse the merge instead and surface source_blocked so the
    // admin can explicitly choose to also block the target before
    // consolidating, or unblock the source first.
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedCustomer(db, {
        id: "customer_blocked_source",
        name: "blocked source",
        phoneHash: "block-phone-hash",
        blockStatus: "blocked"
      });
      seedCustomer(db, { id: "customer_active_target", name: "active target", phoneHash: "block-phone-hash" });
      const access = createTestAccessJwt();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const response = await adminRequest(db, access.token, "/api/admin/customers/customer_blocked_source/merge", {
        targetId: "customer_active_target"
      });

      expect(response.status).toBe(409);
      await expect(readJson(response)).resolves.toMatchObject({ ok: false, error: "source_blocked" });

      // Source still active-blocked, no audit, no tombstone.
      const source = db.sqlite
        .prepare(
          "SELECT block_status, merged_into_id FROM customers WHERE id = 'customer_blocked_source'"
        )
        .get() as { block_status: string; merged_into_id: string | null };
      expect(source).toEqual({ block_status: "blocked", merged_into_id: null });
      const audits = (
        db.sqlite
          .prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'customer.merge'")
          .get() as { count: number }
      ).count;
      expect(audits).toBe(0);
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 400 when the target customer is already a merged tombstone", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedCustomer(db, {
        id: "customer_target_tombstone",
        name: "tombstone target",
        phoneHash: "same-phone-hash",
        mergedIntoId: "customer_third"
      });
      seedCustomer(db, { id: "customer_source", name: "source", phoneHash: "same-phone-hash" });
      seedCustomer(db, { id: "customer_third", name: "canonical", phoneHash: "same-phone-hash" });
      const access = createTestAccessJwt();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const response = await adminRequest(db, access.token, "/api/admin/customers/customer_source/merge", {
        targetId: "customer_target_tombstone"
      });

      expect(response.status).toBe(409);
      await expect(readJson(response)).resolves.toMatchObject({ ok: false, error: "target_already_merged" });

      // No reservations moved, no audit log for this attempt.
      const audit = db.sqlite
        .prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'customer.merge'")
        .get() as { count: number };
      expect(audit.count).toBe(0);
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 409 (already_merged) and writes no audit when the customers guarded UPDATE no-ops (race)", async () => {
    // Simulate the race: source.merged_into_id is NULL when we SELECT,
    // but flips to non-NULL before our batch lands. We model it by
    // letting the batch run against a source that was already merged —
    // the customers UPDATE matches 0 rows because of the guard, and
    // the changes()-gated audit INSERT + reservations UPDATE no-op.
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedCustomer(db, {
        id: "customer_race_source",
        name: "race source",
        phoneHash: "same-phone-hash",
        allergyNotes: "競合時に移してはいけない情報",
        memo: "競合時に移してはいけないメモ"
      });
      seedCustomer(db, {
        id: "customer_race_target",
        name: "race target",
        phoneHash: "same-phone-hash"
      });
      seedReservation(db, "reservation_race", "customer_race_source");
      const access = createTestAccessJwt();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));
      const originalBatch = db.batch.bind(db);
      vi.spyOn(db, "batch").mockImplementationOnce(async (statements) => {
        // The preflight SELECT saw an active source. Another merge wins before
        // this batch, so step 0 must update zero rows and every audit-gated
        // side effect — including note carry-forward — must no-op.
        db.sqlite
          .prepare(
            `UPDATE customers
             SET block_status = 'blocked', merged_into_id = 'customer_other_winner'
             WHERE id = 'customer_race_source'`
          )
          .run();
        return originalBatch(statements);
      });

      const response = await adminRequest(db, access.token, "/api/admin/customers/customer_race_source/merge", {
        targetId: "customer_race_target"
      });

      expect(response.status).toBe(409);
      await expect(readJson(response)).resolves.toMatchObject({ ok: false, error: "already_merged" });

      // No audit log written for the failed merge attempt.
      const audit = db.sqlite
        .prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'customer.merge'")
        .get() as { count: number };
      expect(audit.count).toBe(0);

      // Reservations stay tied to the original tombstoned source — they
      // were not retargeted to the race target.
      const stillSource = db.sqlite
        .prepare("SELECT COUNT(*) AS count FROM reservations WHERE customer_id = 'customer_race_source'")
        .get() as { count: number };
      expect(stillSource.count).toBe(1);
      const targetNotes = db.sqlite
        .prepare(
          "SELECT allergy_notes, memo FROM customers WHERE id = 'customer_race_target'"
        )
        .get() as { allergy_notes: string | null; memo: string | null };
      expect(targetNotes).toEqual({ allergy_notes: null, memo: null });
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 400 when targetId is missing or empty (invalid_request)", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      const access = createTestAccessJwt();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const response = await adminRequest(db, access.token, "/api/admin/customers/customer_missing/merge", {
        targetId: "   "
      });

      expect(response.status).toBe(400);
      await expect(readJson(response)).resolves.toMatchObject({ ok: false, error: "invalid_request" });
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 400 when the source customer is already a merged tombstone", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedCustomer(db, {
        id: "customer_already_merged",
        name: "統合済 元",
        phoneHash: "same-phone-hash",
        mergedIntoId: "customer_merge_target"
      });
      seedCustomer(db, { id: "customer_merge_target", name: "統合 先", phoneHash: "same-phone-hash" });
      const access = createTestAccessJwt();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const response = await adminRequest(db, access.token, "/api/admin/customers/customer_already_merged/merge", {
        targetId: "customer_merge_target"
      });

      expect(response.status).toBe(409);
      await expect(readJson(response)).resolves.toMatchObject({ ok: false, error: "already_merged" });
    } finally {
      db.sqlite.close();
    }
  });

  it("enqueues one calendar_sync_jobs row per moved reservation with deterministic dedupe_key", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedCustomer(db, { id: "customer_sync_source", name: "sync source", phoneHash: "sync-phone-hash" });
      seedCustomer(db, { id: "customer_sync_target", name: "sync target", phoneHash: "sync-phone-hash" });
      seedReservation(db, "reservation_sync_1", "customer_sync_source");
      seedReservation(db, "reservation_sync_2", "customer_sync_source");
      seedReservation(db, "reservation_sync_3", "customer_sync_source");
      const access = createTestAccessJwt();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const response = await adminRequest(db, access.token, "/api/admin/customers/customer_sync_source/merge", {
        targetId: "customer_sync_target"
      });

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({ ok: true, reservationsMoved: 3 });

      // One calendar_sync_jobs row per moved reservation.
      const jobs = db.sqlite
        .prepare(
          `SELECT dedupe_key, owner_type, owner_id, google_action, status
           FROM calendar_sync_jobs
           ORDER BY dedupe_key`
        )
        .all() as Array<{
        dedupe_key: string;
        owner_type: string;
        owner_id: string;
        google_action: string;
        status: string;
      }>;
      expect(jobs).toHaveLength(3);
      for (const job of jobs) {
        expect(job.owner_type).toBe("reservation");
        expect(job.google_action).toBe("upsert");
        expect(job.status).toBe("queued");
        // Format: cm:<auditId_uuid>:r:<reservationId>
        expect(job.dedupe_key).toMatch(
          /^cm:[0-9a-f-]{36}:r:reservation_sync_\d$/
        );
      }
      // Each reservation maps to a distinct job.
      const ownerIds = new Set(jobs.map((j) => j.owner_id));
      expect(ownerIds).toEqual(new Set(["reservation_sync_1", "reservation_sync_2", "reservation_sync_3"]));
    } finally {
      db.sqlite.close();
    }
  });

  it("calendar_sync_jobs only covers moved (source) reservations, not pre-existing target reservations", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedCustomer(db, { id: "customer_mix_source", name: "mix source", phoneHash: "mix-phone-hash" });
      seedCustomer(db, { id: "customer_mix_target", name: "mix target", phoneHash: "mix-phone-hash" });
      // 2 source reservations (should get sync jobs)
      seedReservation(db, "reservation_mix_src_1", "customer_mix_source");
      seedReservation(db, "reservation_mix_src_2", "customer_mix_source");
      // 1 target reservation (should NOT get a sync job)
      seedReservation(db, "reservation_mix_tgt_1", "customer_mix_target");
      const access = createTestAccessJwt();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const response = await adminRequest(db, access.token, "/api/admin/customers/customer_mix_source/merge", {
        targetId: "customer_mix_target"
      });

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({ ok: true, reservationsMoved: 2 });

      const jobs = db.sqlite
        .prepare("SELECT owner_id FROM calendar_sync_jobs ORDER BY owner_id")
        .all() as Array<{ owner_id: string }>;
      expect(jobs).toHaveLength(2);
      const ownerIds = jobs.map((j) => j.owner_id);
      expect(ownerIds).toContain("reservation_mix_src_1");
      expect(ownerIds).toContain("reservation_mix_src_2");
      expect(ownerIds).not.toContain("reservation_mix_tgt_1");
    } finally {
      db.sqlite.close();
    }
  });

  it("calendar_sync_jobs dedupe_key is idempotent — re-merge attempt produces no duplicate rows", async () => {
    // INSERT OR IGNORE on the same dedupe_key means a retry (or second
    // merge of the same pair that somehow gets past the tombstone guard)
    // does not create duplicate sync jobs.
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedCustomer(db, { id: "customer_idem_source", name: "idem source", phoneHash: "idem-phone-hash" });
      seedCustomer(db, { id: "customer_idem_target", name: "idem target", phoneHash: "idem-phone-hash" });
      seedReservation(db, "reservation_idem_1", "customer_idem_source");
      const access = createTestAccessJwt();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      // First merge succeeds.
      const response1 = await adminRequest(db, access.token, "/api/admin/customers/customer_idem_source/merge", {
        targetId: "customer_idem_target"
      });
      expect(response1.status).toBe(200);

      const jobCountAfterFirst = (
        db.sqlite.prepare("SELECT COUNT(*) AS count FROM calendar_sync_jobs").get() as { count: number }
      ).count;
      expect(jobCountAfterFirst).toBe(1);

      // Second attempt for the same pair — source is now a tombstone,
      // so the API returns already_merged. Even if we manually pre-insert
      // the same dedupe_key, INSERT OR IGNORE will silently skip.
      const response2 = await adminRequest(db, access.token, "/api/admin/customers/customer_idem_source/merge", {
        targetId: "customer_idem_target"
      });
      expect(response2.status).toBe(409);

      const jobCountAfterSecond = (
        db.sqlite.prepare("SELECT COUNT(*) AS count FROM calendar_sync_jobs").get() as { count: number }
      ).count;
      // No duplicate row created by the failed second attempt.
      expect(jobCountAfterSecond).toBe(1);
    } finally {
      db.sqlite.close();
    }
  });

  it("race-lost merge enqueues zero calendar_sync_jobs (audit gate prevents ghost jobs)", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      // Pre-tombstone the source to simulate a lost race.
      seedCustomer(db, {
        id: "customer_race_sync_source",
        name: "race sync source",
        phoneHash: "race-sync-hash",
        mergedIntoId: "customer_other_winner"
      });
      seedCustomer(db, { id: "customer_race_sync_target", name: "race sync target", phoneHash: "race-sync-hash" });
      seedReservation(db, "reservation_race_sync_1", "customer_race_sync_source");
      const access = createTestAccessJwt();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const response = await adminRequest(
        db,
        access.token,
        "/api/admin/customers/customer_race_sync_source/merge",
        { targetId: "customer_race_sync_target" }
      );

      expect(response.status).toBe(409);
      await expect(readJson(response)).resolves.toMatchObject({ ok: false, error: "already_merged" });

      // No sync jobs enqueued for the lost merge.
      const jobCount = (
        db.sqlite.prepare("SELECT COUNT(*) AS count FROM calendar_sync_jobs").get() as { count: number }
      ).count;
      expect(jobCount).toBe(0);
    } finally {
      db.sqlite.close();
    }
  });

  it("bumps reservations.version on each moved reservation", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "owner");
      seedCustomer(db, { id: "customer_ver_source", name: "ver source", phoneHash: "ver-phone-hash" });
      seedCustomer(db, { id: "customer_ver_target", name: "ver target", phoneHash: "ver-phone-hash" });
      seedReservation(db, "reservation_ver_1", "customer_ver_source");
      seedReservation(db, "reservation_ver_2", "customer_ver_source");
      // Pre-set one reservation to version=3 to test increment is +1, not a reset.
      db.sqlite.prepare("UPDATE reservations SET version = 3 WHERE id = 'reservation_ver_2'").run();
      const access = createTestAccessJwt();
      vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));

      const response = await adminRequest(db, access.token, "/api/admin/customers/customer_ver_source/merge", {
        targetId: "customer_ver_target"
      });

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({ ok: true, reservationsMoved: 2 });

      // reservation_ver_1: was version=1 (default) → now version=2
      const ver1 = db.sqlite
        .prepare("SELECT version FROM reservations WHERE id = 'reservation_ver_1'")
        .get() as { version: number };
      expect(ver1.version).toBe(2);

      // reservation_ver_2: was version=3 (pre-set) → now version=4
      const ver2 = db.sqlite
        .prepare("SELECT version FROM reservations WHERE id = 'reservation_ver_2'")
        .get() as { version: number };
      expect(ver2.version).toBe(4);
    } finally {
      db.sqlite.close();
    }
  });
});
