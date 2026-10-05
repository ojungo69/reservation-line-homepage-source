import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AdminUser } from "../src/admin/access";
import { createAdminCustomer } from "../src/admin/customer-create";
import { sha256Hex } from "../src/admin/settings-common";
import { insertAdminUser } from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const owner: AdminUser = {
  id: "admin_create_owner",
  email: "owner@example.com",
  role: "owner",
  staff_member_id: null,
  store_id: null,
};

const staff: AdminUser = {
  id: "admin_create_staff",
  email: "staff@example.com",
  role: "staff",
  staff_member_id: "staff_owner_kyoto",
  store_id: "kyoto",
};

describe("createAdminCustomer", () => {
  let d1: SqliteD1Database;

  // createAdminCustomer now threads its INJECTED `now` into the idempotency TTL
  // read (B8), so the read and the `expires_at` write agree on one clock. The
  // default `create` helper omits `now` (real clock); tests that need a
  // controlled clock pass it explicitly (see the TTL-expiry test below).
  beforeEach(() => {
    d1 = createMigratedSqliteD1();
    // customers.created_store_id is a real FK (D1 enforces declared FKs), so the
    // stores a staff member can belong to must exist before any staff create.
    // The migrations already seed both; OR IGNORE keeps this independent of that.
    for (const [id, name] of [["kyoto", "京都店"], ["osaka", "大阪店"]]) {
      d1.sqlite
        .prepare(`INSERT OR IGNORE INTO stores (id, name, timezone) VALUES (?, ?, 'Asia/Tokyo')`)
        .run(id, name);
    }
    insertAdminUser(d1, {
      id: owner.id,
      email: owner.email,
      accessSubject: "admin-create-owner-subject",
      role: owner.role,
    });
    insertAdminUser(d1, {
      id: staff.id,
      email: staff.email,
      accessSubject: "admin-create-staff-subject",
      role: staff.role,
      staffMemberId: staff.staff_member_id,
    });
  });
  afterEach(() => {
    d1.sqlite.close();
  });

  const create = (request: {
    idempotencyKey: string;
    displayName: string;
    displayNameKana?: string | null;
    phone?: string | null;
  }, admin: AdminUser = owner) =>
    createAdminCustomer({ db: d1 as unknown as D1Database, admin, request });

  const storeOf = (customerId: string) =>
    d1.sqlite
      .prepare("SELECT created_store_id FROM customers WHERE id = ?")
      .get(customerId) as { created_store_id: string | null } | undefined;

  // Staff may register customers since 2026-08-26. The row is stamped with THEIR
  // store so own-store membership survives the moment of creation (a fresh manual
  // customer has no reservation and no visit to derive it from).
  it("lets a staff caller create, stamping their own store on the row", async () => {
    const result = await create({ idempotencyKey: "k_staff", displayName: "田中" }, staff);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(storeOf(result.customerId)?.created_store_id).toBe("kyoto");
  });

  it("records the acting store in the audit metadata (no PII)", async () => {
    const result = await create({ idempotencyKey: "k_audit", displayName: "監査 太郎", phone: "09011112222" }, staff);
    expect(result.ok).toBe(true);
    const audit = d1.sqlite
      .prepare("SELECT metadata_json FROM audit_logs WHERE action = 'customer.create_manual'")
      .get() as { metadata_json: string } | undefined;
    const metadata = JSON.parse(audit?.metadata_json ?? "{}");
    expect(metadata.created_store_id).toBe("kyoto");
    expect(metadata.admin_role).toBe("staff");
    expect(metadata.has_phone).toBe(true);
    expect(JSON.stringify(metadata)).not.toContain("09011112222");
  });

  it("fails closed for a staff caller with no store binding, writing nothing", async () => {
    const orphanStaff: AdminUser = { ...staff, staff_member_id: null, store_id: null };
    expect(await create({ idempotencyKey: "k_orphan", displayName: "田中" }, orphanStaff)).toEqual({
      ok: false,
      reason: "forbidden",
    });
    const count = d1.sqlite.prepare("SELECT COUNT(*) AS n FROM customers").get() as { n: number };
    expect(count.n).toBe(0);
  });

  // Idempotency rows live 24h, so an owner retry can span this deploy. Serializing
  // `createdStoreId: null` would change their hash and turn a replay of an
  // already-succeeded create into idempotency_conflict. (chatgpt-codex-connector 指摘)
  it("keeps the owner request hash byte-identical to the pre-staff shape", async () => {
    expect((await create({ idempotencyKey: "k_hash", displayName: "田中", phone: "090-1111-2222" })).ok).toBe(true);
    const legacy = await sha256Hex(
      JSON.stringify({
        action: "create_customer",
        displayName: "田中",
        displayNameKana: null,
        phoneNormalized: "09011112222",
      })
    );
    const row = d1.sqlite
      .prepare("SELECT request_hash FROM idempotency_keys WHERE idempotency_key = ?")
      .get("k_hash") as { request_hash: string };
    expect(row.request_hash).toBe(legacy);
  });

  it("leaves created_store_id NULL for owner (they see every customer already)", async () => {
    const result = await create({ idempotencyKey: "k_owner", displayName: "田中" }, owner);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(storeOf(result.customerId)?.created_store_id).toBeNull();
  });

  it.each([
    ["disabled", "UPDATE admin_users SET active = 0 WHERE id = 'admin_create_staff'"],
    ["role changed", "UPDATE admin_users SET role = 'owner' WHERE id = 'admin_create_staff'"],
    ["staff association changed", "UPDATE admin_users SET staff_member_id = 'staff_owner_osaka' WHERE id = 'admin_create_staff'"],
    ["store changed", "UPDATE staff_members SET store_id = 'osaka' WHERE id = 'staff_owner_kyoto'"],
  ])("rejects a staff actor whose %s immediately before the batch without partial writes", async (change, revoke) => {
    let reachedBatch = false;
    const racingDb = {
      prepare: d1.prepare.bind(d1),
      batch: (statements: D1PreparedStatement[]) => {
        reachedBatch = true;
        d1.sqlite.exec(revoke);
        return d1.batch(statements);
      },
    } as unknown as D1Database;

    const result = await createAdminCustomer({
      db: racingDb,
      admin: staff,
      request: { idempotencyKey: `k-revoked-${change}`, displayName: "失効 顧客" },
    });

    expect(reachedBatch).toBe(true);
    expect(result).toEqual({ ok: false, reason: "forbidden" });
    expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM customers WHERE display_name = '失効 顧客'").get()).toEqual({ n: 0 });
    expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'customer.create_manual'").get()).toEqual({ n: 0 });
    expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM idempotency_keys WHERE idempotency_key = ?").get(`k-revoked-${change}`)).toEqual({ n: 0 });
  });

  // The store is part of the request identity: without it, replaying one key from
  // another store would hand back the first store's customer as a fresh create.
  it("treats the same key from another store as an idempotency conflict", async () => {
    const first = await create({ idempotencyKey: "k_shared", displayName: "田中" }, staff);
    expect(first.ok).toBe(true);
    const otherStoreStaff: AdminUser = { ...staff, id: "admin_create_staff_osaka", store_id: "osaka" };
    expect(await create({ idempotencyKey: "k_shared", displayName: "田中" }, otherStoreStaff)).toEqual({
      ok: false,
      reason: "idempotency_conflict",
    });
  });

  it("replays a staff retry of the same key without creating a second customer", async () => {
    const first = await create({ idempotencyKey: "k_retry", displayName: "田中" }, staff);
    const second = await create({ idempotencyKey: "k_retry", displayName: "田中" }, staff);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second).toEqual({ ok: true, customerId: first.customerId, replayed: true });
    const count = d1.sqlite.prepare("SELECT COUNT(*) AS n FROM customers").get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("does not treat an EXPIRED idempotency row as a conflict — the TTL read uses the injected clock (B8)", async () => {
    // Identical setup except expires_at; the injected 2100 clock drives the TTL
    // read, so only the predicate can make the two diverge. A live row →
    // request_hash mismatch → idempotency_conflict; an expired row → filtered →
    // falls through to the started-INSERT UNIQUE collision → write_failed.
    const runWithExpiry = async (expiresAt: string) => {
      const db = createMigratedSqliteD1();
      try {
        insertAdminUser(db, {
          id: owner.id,
          email: owner.email,
          accessSubject: "admin-create-owner-expiry-subject",
          role: owner.role,
        });
        db.sqlite
          .prepare(
            `INSERT INTO idempotency_keys (id, scope, idempotency_key, status, request_hash, expires_at)
             VALUES ('b8_cc_row', 'admin_action', 'b8_cc_key', 'started', 'stale-mismatch-hash', ?)`
          )
          .run(expiresAt);
        return await createAdminCustomer({
          db: db as unknown as D1Database,
          admin: owner,
          request: { idempotencyKey: "b8_cc_key", displayName: "期限 太郎" },
          now: () => Date.parse("2100-01-01T00:00:00.000Z"),
        });
      } finally {
        db.sqlite.close();
      }
    };

    // Live row (expires after the injected clock) → request_hash mismatch → conflict.
    expect(await runWithExpiry("2101-01-01T00:00:00.000Z")).toEqual({
      ok: false,
      reason: "idempotency_conflict",
    });
    // Expired row (expires before the injected clock) → filtered → NOT a conflict.
    const expired = await runWithExpiry("2099-01-01T00:00:00.000Z");
    expect(expired).toEqual({ ok: false, reason: "write_failed" });
  });

  it("rejects a blank display name with invalid_request", async () => {
    expect(await create({ idempotencyKey: "k1", displayName: "   " })).toEqual({
      ok: false,
      reason: "invalid_request",
    });
  });

  it("rejects an over-long display name (>120) with invalid_request", async () => {
    expect(await create({ idempotencyKey: "k1", displayName: "あ".repeat(121) })).toEqual({
      ok: false,
      reason: "invalid_request",
    });
  });

  it("rejects an over-long kana (>120) with invalid_request", async () => {
    expect(
      await create({ idempotencyKey: "k1", displayName: "田中", displayNameKana: "ア".repeat(121) }),
    ).toEqual({ ok: false, reason: "invalid_request" });
  });

  it("rejects an un-normalizable phone with invalid_request", async () => {
    expect(await create({ idempotencyKey: "k1", displayName: "田中", phone: "abc" })).toEqual({
      ok: false,
      reason: "invalid_request",
    });
  });

  it("creates a customer with phone (normalized + hashed), active, with an audit row", async () => {
    const result = await create({
      idempotencyKey: "k-phone",
      displayName: "田中花子",
      displayNameKana: "タナカハナコ",
      phone: "090-1111-2222",
    });
    expect(result.ok).toBe(true);
    const customerId = result.ok ? result.customerId : "";
    const row = d1.sqlite
      .prepare(
        "SELECT display_name, display_name_kana, phone_normalized, phone_hash, block_status FROM customers WHERE id = ?",
      )
      .get(customerId) as {
        display_name: string;
        display_name_kana: string | null;
        phone_normalized: string | null;
        phone_hash: string | null;
        block_status: string;
      };
    expect(row.display_name).toBe("田中花子");
    expect(row.display_name_kana).toBe("タナカハナコ");
    // Concrete normalized value (not just truthy) so a normalizePhone regression is caught.
    expect(row.phone_normalized).toBe("09011112222");
    expect(row.phone_hash).toBeTruthy();
    expect(row.block_status).toBe("active");

    const audit = d1.sqlite
      .prepare("SELECT metadata_json FROM audit_logs WHERE action = 'customer.create_manual' AND target_id = ?")
      .get(customerId) as { metadata_json: string };
    expect(audit).toBeTruthy();
    // No raw phone in the audit metadata.
    expect(audit.metadata_json).not.toContain("0901111");
    const meta = JSON.parse(audit.metadata_json) as { has_phone: boolean };
    expect(meta.has_phone).toBe(true);
  });

  it("creates a customer without a phone (phone_normalized / phone_hash NULL)", async () => {
    const result = await create({ idempotencyKey: "k-nophone", displayName: "電話なし", phone: "" });
    expect(result.ok).toBe(true);
    const customerId = result.ok ? result.customerId : "";
    const row = d1.sqlite
      .prepare("SELECT phone_normalized, phone_hash FROM customers WHERE id = ?")
      .get(customerId) as { phone_normalized: string | null; phone_hash: string | null };
    expect(row.phone_normalized).toBeNull();
    expect(row.phone_hash).toBeNull();
  });

  it("replays an identical repeated request (single customer row)", async () => {
    const first = await create({ idempotencyKey: "k-rep", displayName: "重複なし" });
    expect(first.ok).toBe(true);
    const firstId = first.ok ? first.customerId : "";
    const second = await create({ idempotencyKey: "k-rep", displayName: "重複なし" });
    expect(second).toEqual({ ok: true, customerId: firstId, replayed: true });
    const n = (d1.sqlite.prepare("SELECT COUNT(*) AS n FROM customers").get() as { n: number }).n;
    expect(n).toBe(1);
  });

  it("maps a same-key different-body request to idempotency_conflict", async () => {
    await create({ idempotencyKey: "k-conf", displayName: "名前A" });
    expect(await create({ idempotencyKey: "k-conf", displayName: "名前B" })).toEqual({
      ok: false,
      reason: "idempotency_conflict",
    });
  });

  it("allows a duplicate phone (two rows; surfaced via merge UI, not blocked at create)", async () => {
    const a = await create({ idempotencyKey: "dup-a", displayName: "客A", phone: "090-1111-2222" });
    const b = await create({ idempotencyKey: "dup-b", displayName: "客B", phone: "090-1111-2222" });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const rows = d1.sqlite
      .prepare("SELECT phone_hash FROM customers WHERE phone_normalized IS NOT NULL")
      .all() as Array<{ phone_hash: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].phone_hash).toBe(rows[1].phone_hash); // same phone → same hash, two distinct customers
  });
});
