import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminUser } from "../src/admin/access";
import {
  setAdminCustomerBlockStatus,
  setAdminCustomerArchiveStatus,
} from "../src/admin/customer-actions";
import { createApp } from "../src/app";
import {
  createAccessJwksFetchMock,
  createAccessJwtFixture,
  grantCustomerTabGate,
  insertAdminUser,
  type AccessJwk,
} from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const { captureExceptionSpy } = vi.hoisted(() => ({ captureExceptionSpy: vi.fn() }));
vi.mock("@sentry/cloudflare", () => ({
  captureException: captureExceptionSpy,
  init: vi.fn(),
  withSentry: (_opts: unknown, handler: unknown) => handler,
  withMonitor: vi.fn((_slug: string, callback: () => unknown) => callback())
}));

// 事前チェック (staffCanAccessCustomer の SELECT) が通った直後に所属を消す。事前 SELECT と
// UPDATE は別の文なので、そのあいだに唯一の所属が失われることが実際にありうる
// (最後の valid な来店が無効化された・スタッフの所属店舗が変わった)。UPDATE 自体に同じ
// 条件が入っていないと、スコープを失ったスタッフの書き込みが成功し、監査ログにも成功として
// 残る。ゲートの SELECT は `AS hit` を含む唯一のクエリなので、それだけを包む。
const dropMembershipAfterGate = (db: SqliteD1Database, onGatePassed: () => void): D1Database => {
  const prepare = db.prepare.bind(db);
  let fired = false;
  return {
    batch: db.batch.bind(db),
    prepare: (sql: string) => {
      const statement = prepare(sql);
      if (!sql.includes("AS hit")) return statement;
      return {
        bind: (...values: unknown[]) => {
          const bound = (statement as unknown as { bind: (...v: unknown[]) => D1PreparedStatement }).bind(
            ...(values as never[])
          );
          return {
            first: async () => {
              const row = await bound.first();
              if (!fired) {
                fired = true;
                onGatePassed();
              }
              return row;
            }
          } as unknown as D1PreparedStatement;
        }
      } as unknown as D1PreparedStatement;
    }
  } as unknown as D1Database;
};

describe("admin customer block actions", () => {
  let d1: SqliteD1Database;

  const owner: AdminUser = {
    id: "admin_customer_action_owner_1",
    email: "owner@example.com",
    role: "owner",
  staff_member_id: null,
  store_id: null
  };

  beforeEach(() => {
    d1 = createMigratedSqliteD1();
    insertAdminUser(d1, { id: owner.id, email: owner.email, accessSubject: owner.id });
    for (const [id, staffId] of [
      ["admin_customer_action_staff_1", "sm_block_1"],
      ["admin_customer_action_staff_race", "sm_race_1"],
      ["admin_customer_action_staff_unblock", "sm_unblock_1"],
      ["admin_customer_action_staff_2", "sm_block_2"]
    ]) {
      d1.sqlite.prepare("INSERT INTO staff_members (id, store_id, display_name, role) VALUES (?, 'kyoto', 'スタッフ', 'staff')").run(staffId);
      insertAdminUser(d1, { id, email: `${id}@example.com`, accessSubject: id, role: "staff", staffMemberId: staffId });
    }
    d1.sqlite.exec(`
      INSERT INTO customers (id, display_name, block_status, updated_at)
      VALUES ('customer_block_action_1', 'ブロック 操作', 'active', '2026-05-09T00:00:00.000Z');
    `);
  });

  afterEach(() => {
    d1.sqlite.close();
  });

  const count = (sql: string, ...values: (string | number)[]) => {
    return (d1.sqlite.prepare(sql).get(...values) as { count: number }).count;
  };

  it("rolls back audit and idempotency when a stale block transition loses a state race", async () => {
    const racingDb = {
      prepare: d1.prepare.bind(d1),
      batch: async (statements: D1PreparedStatement[]) => {
        d1.sqlite
          .prepare("UPDATE customers SET block_status = 'blocked' WHERE id = 'customer_block_action_1'")
          .run();
        return d1.batch(statements);
      }
    } as unknown as D1Database;

    const result = await setAdminCustomerBlockStatus({
      db: racingDb,
      admin: owner,
      customerId: "customer_block_action_1",
      action: "block",
      request: {
        idempotencyKey: "customer_block_race_1",
        reason: "race"
      },
      now: () => 1_700_000_000_000
    });

    expect(result).toEqual({
      ok: false,
      reason: "invalid_transition"
    });
    expect(count("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'admin_customer_blocked'")).toBe(0);
    expect(count("SELECT COUNT(*) AS count FROM idempotency_keys WHERE idempotency_key = 'customer_block_race_1'")).toBe(0);
  });

  it("maps a same-key insert race to idempotency_in_progress", async () => {
    // Use a recent timestamp so the idempotency row is within its 24h TTL.
    const recentNow = Date.now();
    const racingDb = {
      prepare: d1.prepare.bind(d1),
      batch: async (statements: D1PreparedStatement[]) => {
        await d1.batch([statements[0]]);
        throw new Error("UNIQUE constraint failed: idempotency_keys.scope, idempotency_keys.idempotency_key");
      }
    } as unknown as D1Database;

    const result = await setAdminCustomerBlockStatus({
      db: racingDb,
      admin: owner,
      customerId: "customer_block_action_1",
      action: "block",
      request: {
        idempotencyKey: "customer_block_same_key_race"
      },
      now: () => recentNow
    });

    expect(result).toEqual({
      ok: false,
      reason: "idempotency_in_progress"
    });
  });

  it("returns not_found when blocking an archived customer (no audit row, no block applied)", async () => {
    d1.sqlite.exec(`
      INSERT INTO customers (id, display_name, block_status, archived_at, updated_at)
      VALUES ('customer_block_archived', 'アーカイブ済', 'active', '2026-05-10T00:00:00.000Z', '2026-05-10T00:00:00.000Z');
    `);
    const result = await setAdminCustomerBlockStatus({
      db: d1 as unknown as D1Database,
      admin: owner,
      customerId: "customer_block_archived",
      action: "block",
      request: { idempotencyKey: "block_archived_1" },
      now: () => Date.now()
    });
    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect(count("SELECT COUNT(*) AS count FROM audit_logs WHERE target_id = 'customer_block_archived'")).toBe(0);
    expect(count("SELECT COUNT(*) AS count FROM customers WHERE id = 'customer_block_archived' AND block_status = 'blocked'")).toBe(0);
  });

  // 2026-08-26: staff may block/unblock, scoped to their own store. A block is a
  // global state (it stops the customer booking at every store), so the acting
  // store goes into the audit metadata — the role alone no longer identifies it.
  it("lets staff block an own-store customer and records the acting store", async () => {
    const staff: AdminUser = {
      ...owner,
      id: "admin_customer_action_staff_1",
      role: "staff",
      store_id: "kyoto",
      staff_member_id: "sm_block_1"
    };
    d1.sqlite.exec(`
      INSERT INTO customers (id, display_name, block_status, created_store_id, updated_at)
      VALUES ('customer_block_own_store', '自店舗 顧客', 'active', 'kyoto', '2026-05-10T00:00:00.000Z');
    `);
    const result = await setAdminCustomerBlockStatus({
      db: d1 as unknown as D1Database,
      admin: staff,
      customerId: "customer_block_own_store",
      action: "block",
      request: { idempotencyKey: "block_staff_own_1" },
      now: () => Date.now()
    });
    expect(result).toEqual({
      ok: true,
      customerId: "customer_block_own_store",
      blockStatus: "blocked",
      replayed: false
    });
    const audit = d1.sqlite
      .prepare("SELECT metadata_json FROM audit_logs WHERE action = 'admin_customer_blocked'")
      .get() as { metadata_json: string } | undefined;
    const metadata = JSON.parse(audit?.metadata_json ?? "{}");
    expect(metadata.adminRole).toBe("staff");
    expect(metadata.adminStoreId).toBe("kyoto");
  });

  // 事前チェックと UPDATE のあいだで所属が消えた場合。UPDATE に店舗条件が無いと、
  // スコープを失ったスタッフのブロックがそのまま成立し、監査ログにも成功として残る。
  it("refuses the write when the staff loses the customer between the gate and the update", async () => {
    const staff: AdminUser = {
      ...owner,
      id: "admin_customer_action_staff_race",
      role: "staff",
      store_id: "kyoto",
      staff_member_id: "sm_race_1"
    };
    d1.sqlite.exec(`
      INSERT INTO customers (id, display_name, block_status, created_store_id, updated_at)
      VALUES ('customer_block_race', 'レース 顧客', 'active', 'kyoto', '2026-05-10T00:00:00.000Z');
    `);
    let raced = false;
    const racing = dropMembershipAfterGate(d1, () => {
      raced = true;
      d1.sqlite.exec("UPDATE customers SET created_store_id = NULL WHERE id = 'customer_block_race'");
    });

    const result = await setAdminCustomerBlockStatus({
      db: racing,
      admin: staff,
      customerId: "customer_block_race",
      action: "block",
      request: { idempotencyKey: "block_staff_race_1" },
      now: () => Date.now()
    });

    // フックは gate の SELECT を SQL 文字列で見分けている。将来その文が変わると
    // フックが発火せず、race を起こさないまま緑になる = ガードを外しても落ちない
    // テストに化ける。実際に割り込めたことをここで固定する。
    expect(raced).toBe(true);
    expect(result).toEqual({ ok: false, reason: "invalid_transition" });
    expect(
      d1.sqlite.prepare("SELECT block_status FROM customers WHERE id = 'customer_block_race'").get()
    ).toEqual({ block_status: "active" });
    // batch ごと巻き戻るので、監査ログにも冪等キーにも痕跡は残らない。
    expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs").get()).toEqual({ n: 0 });
    expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM idempotency_keys").get()).toEqual({ n: 0 });
  });

  // owner は店舗スコープを持たないので、同じ race でも通常どおり成立する
  // (店舗条件を全員に付けてしまうと owner の操作まで巻き添えで落ちる)。
  it("still lets an owner block a customer with no store membership at all", async () => {
    d1.sqlite.exec(`
      INSERT INTO customers (id, display_name, block_status, updated_at)
      VALUES ('customer_block_no_store', '無所属 顧客', 'active', '2026-05-10T00:00:00.000Z');
    `);
    expect(
      await setAdminCustomerBlockStatus({
        db: d1 as unknown as D1Database,
        admin: owner,
        customerId: "customer_block_no_store",
        action: "block",
        request: { idempotencyKey: "block_owner_no_store" },
        now: () => Date.now()
      })
    ).toEqual({ ok: true, customerId: "customer_block_no_store", blockStatus: "blocked", replayed: false });
  });

  // unblock is the half staff most need (they are the ones who take the phone call),
  // and it was the untested half: the scope gate is shared, but nothing pinned that
  // the unblock ACTION reaches it and clears the state. (verify-tasks T028)
  it("lets staff unblock an own-store customer and refuses one outside their store", async () => {
    const staff: AdminUser = {
      ...owner,
      id: "admin_customer_action_staff_unblock",
      role: "staff",
      store_id: "kyoto",
      staff_member_id: "sm_unblock_1"
    };
    d1.sqlite.exec(`
      INSERT INTO customers (id, display_name, block_status, created_store_id, updated_at)
      VALUES ('customer_unblock_own', '自店舗 顧客', 'blocked', 'kyoto', '2026-05-10T00:00:00.000Z');
      INSERT INTO customers (id, display_name, block_status, created_store_id, updated_at)
      VALUES ('customer_unblock_other', '他店舗 顧客', 'blocked', 'osaka', '2026-05-10T00:00:00.000Z');
    `);

    expect(
      await setAdminCustomerBlockStatus({
        db: d1 as unknown as D1Database,
        admin: staff,
        customerId: "customer_unblock_own",
        action: "unblock",
        request: { idempotencyKey: "unblock_staff_own_1" },
        now: () => Date.now()
      })
    ).toEqual({
      ok: true,
      customerId: "customer_unblock_own",
      blockStatus: "active",
      replayed: false
    });
    expect(
      count("SELECT COUNT(*) AS count FROM customers WHERE id = 'customer_unblock_own' AND block_status = 'active'")
    ).toBe(1);
    const audit = d1.sqlite
      .prepare("SELECT metadata_json FROM audit_logs WHERE action = 'admin_customer_unblocked'")
      .get() as { metadata_json: string } | undefined;
    expect(JSON.parse(audit?.metadata_json ?? "{}").adminStoreId).toBe("kyoto");

    expect(
      await setAdminCustomerBlockStatus({
        db: d1 as unknown as D1Database,
        admin: staff,
        customerId: "customer_unblock_other",
        action: "unblock",
        request: { idempotencyKey: "unblock_staff_other_1" },
        now: () => Date.now()
      })
    ).toEqual({ ok: false, reason: "forbidden" });
    expect(
      count("SELECT COUNT(*) AS count FROM customers WHERE id = 'customer_unblock_other' AND block_status = 'blocked'")
    ).toBe(1);
  });

  it("rejects staff on a customer outside their store, writing nothing", async () => {
    const staff: AdminUser = {
      ...owner,
      id: "admin_customer_action_staff_2",
      role: "staff",
      store_id: "kyoto",
      staff_member_id: "sm_block_2"
    };
    // customer_block_action_1 has no reservation / visit / created_store_id.
    const result = await setAdminCustomerBlockStatus({
      db: d1 as unknown as D1Database,
      admin: staff,
      customerId: "customer_block_action_1",
      action: "block",
      request: { idempotencyKey: "block_staff_other_1" },
      now: () => Date.now()
    });
    expect(result).toEqual({ ok: false, reason: "forbidden" });
    expect(count("SELECT COUNT(*) AS count FROM audit_logs WHERE target_id = 'customer_block_action_1'")).toBe(0);
    expect(count("SELECT COUNT(*) AS count FROM idempotency_keys WHERE idempotency_key = 'block_staff_other_1'")).toBe(0);
  });

  it("rejects a staff member with no store binding (fail closed)", async () => {
    const orphan: AdminUser = {
      ...owner,
      id: "admin_customer_action_staff_3",
      role: "staff",
      store_id: null,
      staff_member_id: null
    };
    d1.sqlite.exec(`
      INSERT INTO customers (id, display_name, block_status, created_store_id, updated_at)
      VALUES ('customer_block_orphan_target', '自店舗 顧客', 'active', 'kyoto', '2026-05-10T00:00:00.000Z');
    `);
    const result = await setAdminCustomerBlockStatus({
      db: d1 as unknown as D1Database,
      admin: orphan,
      customerId: "customer_block_orphan_target",
      action: "block",
      request: { idempotencyKey: "block_staff_orphan_1" },
      now: () => Date.now()
    });
    expect(result).toEqual({ ok: false, reason: "forbidden" });
    expect(count("SELECT COUNT(*) AS count FROM customers WHERE id = 'customer_block_orphan_target' AND block_status = 'blocked'")).toBe(0);
  });

  it("returns not_found when blocking a merge tombstone (merged_into_id set)", async () => {
    d1.sqlite.exec(`
      INSERT INTO customers (id, display_name, block_status, merged_into_id, updated_at)
      VALUES ('customer_block_tombstone', '統合済', 'active', 'customer_block_action_1', '2026-05-10T00:00:00.000Z');
    `);
    const result = await setAdminCustomerBlockStatus({
      db: d1 as unknown as D1Database,
      admin: owner,
      customerId: "customer_block_tombstone",
      action: "block",
      request: { idempotencyKey: "block_tombstone_1" },
      now: () => Date.now()
    });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("setAdminCustomerArchiveStatus", () => {
  let d1: SqliteD1Database;
  const owner: AdminUser = {
    id: "admin_archive_owner_1",
    email: "owner-archive@example.com",
    role: "owner",
    staff_member_id: null,
    store_id: null,
  };
  const FIXED_NOW = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z, well within TTL

  beforeEach(() => {
    d1 = createMigratedSqliteD1();
    insertAdminUser(d1, { id: owner.id, email: owner.email, accessSubject: owner.id });
    d1.sqlite.exec("INSERT INTO staff_members (id, store_id, display_name, role) VALUES ('sm_1', 'kyoto', 'スタッフ', 'staff')");
    insertAdminUser(d1, { id: "staff_1", email: "staff@example.com", accessSubject: "staff_1", role: "staff", staffMemberId: "sm_1" });
    d1.sqlite.exec(`
      INSERT INTO customers (id, display_name, block_status, archived_at, updated_at)
      VALUES ('cust_archive_1', 'アーカイブ 対象', 'active', NULL, '2026-05-09T00:00:00.000Z');
    `);
  });
  afterEach(() => d1.sqlite.close());

  const archivedAt = (id: string) =>
    (
      d1.sqlite.prepare("SELECT archived_at FROM customers WHERE id = ?").get(id) as
        | { archived_at: string | null }
        | undefined
    )?.archived_at ?? null;

  const countAudit = (action: string) =>
    (
      d1.sqlite
        .prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = ?")
        .get(action) as { count: number }
    ).count;

  it("archives an active customer, stamps archived_at and writes an audit row", async () => {
    const result = await setAdminCustomerArchiveStatus({
      db: d1 as unknown as D1Database,
      admin: owner,
      customerId: "cust_archive_1",
      action: "archive",
      request: { idempotencyKey: "arch_key_1" },
      now: () => FIXED_NOW,
    });
    expect(result).toEqual({ ok: true, customerId: "cust_archive_1", archived: true, replayed: false });
    expect(archivedAt("cust_archive_1")).toBe(new Date(FIXED_NOW).toISOString());
    expect(countAudit("admin_customer_archived")).toBe(1);
  });

  it("unarchives an archived customer back to NULL", async () => {
    d1.sqlite
      .prepare("UPDATE customers SET archived_at = '2026-05-09T00:00:00.000Z' WHERE id = 'cust_archive_1'")
      .run();
    const result = await setAdminCustomerArchiveStatus({
      db: d1 as unknown as D1Database,
      admin: owner,
      customerId: "cust_archive_1",
      action: "unarchive",
      request: { idempotencyKey: "arch_key_2" },
      now: () => FIXED_NOW,
    });
    expect(result).toEqual({ ok: true, customerId: "cust_archive_1", archived: false, replayed: false });
    expect(archivedAt("cust_archive_1")).toBeNull();
    expect(countAudit("admin_customer_unarchived")).toBe(1);
  });

  // 2026-08-26: staff may archive/restore, but only inside their own-store scope.
  // cust_archive_1 has no reservation, no visit and no created_store_id, so it is
  // out of scope for every staff member.
  const staff: AdminUser = { ...owner, id: "staff_1", role: "staff", store_id: "kyoto", staff_member_id: "sm_1" };

  const seedOwnStoreCustomer = (id: string, archivedAtValue: string | null = null) =>
    d1.sqlite
      .prepare(
        `INSERT INTO customers (id, display_name, block_status, archived_at, created_store_id, updated_at)
         VALUES (?, '自店舗 顧客', 'active', ?, 'kyoto', '2026-05-09T00:00:00.000Z')`
      )
      .run(id, archivedAtValue);

  const archiveAs = (admin: AdminUser, customerId: string, action: "archive" | "unarchive", key: string) =>
    setAdminCustomerArchiveStatus({
      db: d1 as unknown as D1Database,
      admin,
      customerId,
      action,
      request: { idempotencyKey: key },
      now: () => FIXED_NOW,
    });

  it("rejects staff on an out-of-scope customer and changes nothing", async () => {
    expect(await archiveAs(staff, "cust_archive_1", "archive", "arch_key_staff")).toEqual({
      ok: false,
      reason: "forbidden",
    });
    expect(archivedAt("cust_archive_1")).toBeNull();
    expect(countAudit("admin_customer_archived")).toBe(0);
  });

  // ブロックと同じ race。アーカイブは顧客をスタッフの一覧から消す操作なので、
  // スコープを失った側の実行が成立すると取り返しが付きにくい。
  it("refuses the archive when the staff loses the customer between the gate and the update", async () => {
    seedOwnStoreCustomer("cust_archive_race");
    let raced = false;
    const racing = dropMembershipAfterGate(d1, () => {
      raced = true;
      d1.sqlite.exec("UPDATE customers SET created_store_id = NULL WHERE id = 'cust_archive_race'");
    });

    const result = await setAdminCustomerArchiveStatus({
      db: racing,
      admin: staff,
      customerId: "cust_archive_race",
      action: "archive",
      request: { idempotencyKey: "arch_key_race" },
      now: () => FIXED_NOW,
    });

    // ブロック側と同じ理由。フックが発火しなければ race は起きていない。
    expect(raced).toBe(true);
    expect(result).toEqual({ ok: false, reason: "invalid_transition" });
    expect(archivedAt("cust_archive_race")).toBeNull();
    expect(countAudit("admin_customer_archived")).toBe(0);
  });

  it("rejects a staff member with no store binding (fail closed)", async () => {
    seedOwnStoreCustomer("cust_archive_scoped");
    const orphan: AdminUser = { ...staff, store_id: null, staff_member_id: null };
    expect(await archiveAs(orphan, "cust_archive_scoped", "archive", "arch_key_orphan")).toEqual({
      ok: false,
      reason: "forbidden",
    });
    expect(archivedAt("cust_archive_scoped")).toBeNull();
  });

  it("lets staff archive an own-store customer and records the acting store", async () => {
    seedOwnStoreCustomer("cust_archive_scoped");
    const result = await archiveAs(staff, "cust_archive_scoped", "archive", "arch_key_scoped");
    expect(result).toEqual({
      ok: true,
      customerId: "cust_archive_scoped",
      archived: true,
      replayed: false,
    });
    expect(archivedAt("cust_archive_scoped")).not.toBeNull();
    const audit = d1.sqlite
      .prepare("SELECT metadata_json FROM audit_logs WHERE action = 'admin_customer_archived'")
      .get() as { metadata_json: string } | undefined;
    const metadata = JSON.parse(audit?.metadata_json ?? "{}");
    expect(metadata.adminRole).toBe("staff");
    expect(metadata.adminStoreId).toBe("kyoto");
  });

  // The restore path must judge an ALREADY archived customer, which the default
  // scope predicate excludes — otherwise archive is a one-way door for staff.
  it("lets staff restore an own-store customer they archived", async () => {
    seedOwnStoreCustomer("cust_archive_scoped", "2026-05-09T00:00:00.000Z");
    expect(await archiveAs(staff, "cust_archive_scoped", "unarchive", "arch_key_restore")).toEqual({
      ok: true,
      customerId: "cust_archive_scoped",
      archived: false,
      replayed: false,
    });
    expect(archivedAt("cust_archive_scoped")).toBeNull();
  });

  // Retry with the same key after a successful archive: the row is archived now, so
  // a scope check that excluded archived customers would answer 403 instead of the
  // replay the owner path returns.
  it("replays a staff archive retry that reuses the idempotency key", async () => {
    seedOwnStoreCustomer("cust_archive_scoped");
    const first = await archiveAs(staff, "cust_archive_scoped", "archive", "arch_key_retry");
    expect(first.ok).toBe(true);
    expect(await archiveAs(staff, "cust_archive_scoped", "archive", "arch_key_retry")).toEqual({
      ok: true,
      customerId: "cust_archive_scoped",
      archived: true,
      replayed: true,
    });
    expect(countAudit("admin_customer_archived")).toBe(1);
  });

  // Same reason as the archive retry above, on the block path: the customer may be
  // archived between a successful block and the client's retry of the same key. A
  // scope check that judged on archived_at would answer 403 for an operation that
  // already succeeded, where owner replays. (/code-review 指摘)
  it("replays a staff block retry whose customer was archived in between", async () => {
    seedOwnStoreCustomer("cust_block_retry");
    const first = await setAdminCustomerBlockStatus({
      db: d1 as unknown as D1Database,
      admin: staff,
      customerId: "cust_block_retry",
      action: "block",
      request: { idempotencyKey: "block_key_retry" },
      now: () => FIXED_NOW,
    });
    expect(first.ok).toBe(true);
    d1.sqlite
      .prepare("UPDATE customers SET archived_at = '2026-05-09T00:00:00.000Z' WHERE id = 'cust_block_retry'")
      .run();

    expect(
      await setAdminCustomerBlockStatus({
        db: d1 as unknown as D1Database,
        admin: staff,
        customerId: "cust_block_retry",
        action: "block",
        request: { idempotencyKey: "block_key_retry" },
        now: () => FIXED_NOW,
      })
    ).toEqual({
      ok: true,
      customerId: "cust_block_retry",
      blockStatus: "blocked",
      replayed: true,
    });
  });

  it("still rejects a genuine double-archive (different key) as invalid_transition", async () => {
    seedOwnStoreCustomer("cust_archive_scoped");
    expect((await archiveAs(staff, "cust_archive_scoped", "archive", "arch_key_a")).ok).toBe(true);
    expect(await archiveAs(staff, "cust_archive_scoped", "archive", "arch_key_b")).toEqual({
      ok: false,
      reason: "invalid_transition",
    });
  });

  it("does not let staff restore another store's archived customer", async () => {
    d1.sqlite
      .prepare(
        `INSERT INTO customers (id, display_name, block_status, archived_at, created_store_id, updated_at)
         VALUES ('cust_archive_osaka', '他店舗 顧客', 'active', '2026-05-09T00:00:00.000Z', 'osaka', '2026-05-09T00:00:00.000Z')`
      )
      .run();
    expect(await archiveAs(staff, "cust_archive_osaka", "unarchive", "arch_key_other")).toEqual({
      ok: false,
      reason: "forbidden",
    });
    expect(archivedAt("cust_archive_osaka")).not.toBeNull();
  });

  it("returns not_found for an unknown customer", async () => {
    const result = await setAdminCustomerArchiveStatus({
      db: d1 as unknown as D1Database,
      admin: owner,
      customerId: "cust_does_not_exist",
      action: "archive",
      request: { idempotencyKey: "arch_key_missing" },
      now: () => FIXED_NOW,
    });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("rejects archiving an already-archived customer as invalid_transition", async () => {
    d1.sqlite
      .prepare("UPDATE customers SET archived_at = '2026-05-09T00:00:00.000Z' WHERE id = 'cust_archive_1'")
      .run();
    const result = await setAdminCustomerArchiveStatus({
      db: d1 as unknown as D1Database,
      admin: owner,
      customerId: "cust_archive_1",
      action: "archive",
      request: { idempotencyKey: "arch_key_dup" },
      now: () => FIXED_NOW,
    });
    expect(result).toEqual({ ok: false, reason: "invalid_transition" });
  });

  it("replays a succeeded archive idempotently (same key, same hash)", async () => {
    const req = { idempotencyKey: "arch_key_replay" };
    const first = await setAdminCustomerArchiveStatus({
      db: d1 as unknown as D1Database,
      admin: owner,
      customerId: "cust_archive_1",
      action: "archive",
      request: req,
      now: () => FIXED_NOW,
    });
    expect(first).toEqual({ ok: true, customerId: "cust_archive_1", archived: true, replayed: false });
    const second = await setAdminCustomerArchiveStatus({
      db: d1 as unknown as D1Database,
      admin: owner,
      customerId: "cust_archive_1",
      action: "archive",
      request: req,
      now: () => FIXED_NOW,
    });
    expect(second).toEqual({ ok: true, customerId: "cust_archive_1", archived: true, replayed: true });
    expect(countAudit("admin_customer_archived")).toBe(1); // not double-written
  });
});

// ---------------------------------------------------------------------------
// PUT /api/admin/customers/:id/memo — HTTP-level tests
// ---------------------------------------------------------------------------

const TEAM_DOMAIN = "https://team.example.cloudflareaccess.com";
const ACCESS_AUD = "admin-customer-memo-aud";
const ADMIN_EMAIL = "owner-memo@example.com";
const ADMIN_ACCESS_SUBJECT = "access-subject-memo-owner";

const createMemoAccessFixture = () =>
  createAccessJwtFixture({
    issuer: TEAM_DOMAIN,
    audience: ACCESS_AUD,
    keyId: "memo-test-key-1",
    claims: { email: ADMIN_EMAIL, sub: ADMIN_ACCESS_SUBJECT }
  });

const createFetchMock = (jwk: AccessJwk) => createAccessJwksFetchMock(TEAM_DOMAIN, jwk);

const insertMemoAdminUser = (db: SqliteD1Database) => {
  db.sqlite
    .prepare(
      `INSERT INTO admin_users (id, email, access_subject, role, active, updated_at)
       VALUES ('admin_memo_owner', ?, ?, 'owner', 1, '2026-05-22T00:00:00.000Z')`
    )
    .run(ADMIN_EMAIL, ADMIN_ACCESS_SUBJECT);
};

const insertMemoCustomer = (db: SqliteD1Database, id: string) => {
  db.sqlite
    .prepare(
      `INSERT INTO customers (id, display_name, block_status, updated_at)
       VALUES (?, 'メモ顧客', 'active', '2026-05-22T00:00:00.000Z')`
    )
    .run(id);
};

const memoEnv = (db: SqliteD1Database): Record<string, unknown> => ({
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  ACCESS_AUD,
  DB: db
});

const memoRequest = (
  db: SqliteD1Database,
  token: string | null,
  customerId: string,
  body: unknown
) => {
  const app = createApp();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Cf-Access-Jwt-Assertion"] = token;
  return app.request(
    `/api/admin/customers/${encodeURIComponent(customerId)}/memo`,
    { method: "PUT", headers, body: JSON.stringify(body) },
    memoEnv(db)
  );
};

describe("PUT /api/admin/customers/:id/memo", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("saves memo text for a customer", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertMemoAdminUser(db);
      insertMemoCustomer(db, "cust_memo_1");
      const access = createMemoAccessFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await memoRequest(db, access.token, "cust_memo_1", {
        memo: "アレルギーなし。カラー希望。"
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: boolean };
      expect(body.ok).toBe(true);

      // Verify persisted
      const row = db.sqlite
        .prepare("SELECT memo FROM customers WHERE id = ?")
        .get("cust_memo_1") as { memo: string } | undefined;
      expect(row?.memo).toBe("アレルギーなし。カラー希望。");
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects memo longer than 1000 chars", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertMemoAdminUser(db);
      insertMemoCustomer(db, "cust_memo_2");
      const access = createMemoAccessFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await memoRequest(db, access.token, "cust_memo_2", {
        memo: "x".repeat(1001)
      });
      expect(response.status).toBe(400);
    } finally {
      db.sqlite.close();
    }
  });

  it("allows clearing memo by setting null", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertMemoAdminUser(db);
      insertMemoCustomer(db, "cust_memo_3");
      // Pre-set a memo
      db.sqlite
        .prepare("UPDATE customers SET memo = ? WHERE id = ?")
        .run("既存メモ", "cust_memo_3");

      const access = createMemoAccessFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await memoRequest(db, access.token, "cust_memo_3", {
        memo: null
      });
      expect(response.status).toBe(200);

      const row = db.sqlite
        .prepare("SELECT memo FROM customers WHERE id = ?")
        .get("cust_memo_3") as { memo: string | null } | undefined;
      expect(row?.memo).toBeNull();
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 403 without auth", async () => {
    const db = createMigratedSqliteD1();
    try {
      const response = await memoRequest(db, null, "any-id", {
        memo: "test"
      });
      expect(response.status).toBe(403);
    } finally {
      db.sqlite.close();
    }
  });

  it("accepts exactly 1000 chars", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertMemoAdminUser(db);
      insertMemoCustomer(db, "cust_memo_4");
      const access = createMemoAccessFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await memoRequest(db, access.token, "cust_memo_4", {
        memo: "あ".repeat(1000)
      });
      expect(response.status).toBe(200);

      const row = db.sqlite
        .prepare("SELECT memo FROM customers WHERE id = ?")
        .get("cust_memo_4") as { memo: string } | undefined;
      expect(row?.memo).toBe("あ".repeat(1000));
    } finally {
      db.sqlite.close();
    }
  });

  it("trims whitespace from memo", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertMemoAdminUser(db);
      insertMemoCustomer(db, "cust_memo_5");
      const access = createMemoAccessFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await memoRequest(db, access.token, "cust_memo_5", {
        memo: "  メモ内容  "
      });
      expect(response.status).toBe(200);

      const row = db.sqlite
        .prepare("SELECT memo FROM customers WHERE id = ?")
        .get("cust_memo_5") as { memo: string } | undefined;
      expect(row?.memo).toBe("メモ内容");
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 400 for invalid JSON body", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertMemoAdminUser(db);
      const access = createMemoAccessFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const app = createApp();
      const response = await app.request(
        "/api/admin/customers/cust_memo_x/memo",
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "Cf-Access-Jwt-Assertion": access.token
          },
          body: "not-json{"
        },
        memoEnv(db)
      );
      expect(response.status).toBe(400);
    } finally {
      db.sqlite.close();
    }
  });
});

// ---------------------------------------------------------------------------
// PUT /api/admin/reservations/:id/cancellation-fee — HTTP-level tests
// "キャンセル料未納" flag set/clear (owner+). Reuses the memo-test JWT fixtures.
// ---------------------------------------------------------------------------

describe("PUT /api/admin/reservations/:id/cancellation-fee", () => {
  afterEach(() => vi.unstubAllGlobals());

  const RES_ID = "res_fee_1";

  const seedReservationForFee = (
    db: SqliteD1Database,
    opts: { status?: string; unpaidAt?: string | null } = {}
  ) => {
    const status = opts.status ?? "no_show";
    const unpaidAt = opts.unpaidAt === undefined ? "2026-05-31T02:00:00.000Z" : opts.unpaidAt;
    db.sqlite
      .prepare(
        `INSERT INTO customers (id, display_name, block_status, updated_at)
         VALUES ('cust_fee_1', '料金 顧客', 'active', '2026-05-22T00:00:00.000Z')`
      )
      .run();
    db.sqlite
      .prepare(
        `INSERT INTO reservations (
           id, store_id, service_id, customer_id, resource_id, line_identity_id,
           source, status, start_at, end_at, duration_minutes, no_show_at,
           cancellation_fee_unpaid_at, idempotency_key, google_sync_state, version, updated_at
         ) VALUES (?, 'kyoto', 'service_kyoto_default_60', 'cust_fee_1', 'resource_kyoto_calendar', NULL,
           'web_line', ?, '2026-05-31T01:00:00.000Z', '2026-05-31T02:00:00.000Z', 60, ?, ?, ?, 'pending', 2, '2026-05-22T00:00:00.000Z')`
      )
      .run(RES_ID, status, unpaidAt, unpaidAt, `idem-${RES_ID}`);
  };

  const feeRequest = (db: SqliteD1Database, token: string | null, id: string, body: unknown) => {
    const app = createApp();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Cf-Access-Jwt-Assertion"] = token;
    return app.request(
      `/api/admin/reservations/${encodeURIComponent(id)}/cancellation-fee`,
      { method: "PUT", headers, body: JSON.stringify(body) },
      memoEnv(db)
    );
  };

  const readUnpaidAt = (db: SqliteD1Database, id: string) =>
    (
      db.sqlite
        .prepare("SELECT cancellation_fee_unpaid_at FROM reservations WHERE id = ?")
        .get(id) as { cancellation_fee_unpaid_at: string | null } | undefined
    )?.cancellation_fee_unpaid_at ?? null;

  it("does not write the unpaid flag onto a reservation restored to completed mid-request", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertMemoAdminUser(db);
      seedReservationForFee(db, { unpaidAt: null });
      const access = createMemoAccessFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      // 事前 SELECT (no_show) の後、UPDATE の前に「完了に戻す」訂正が着地する競合。
      const originalBatch = db.batch.bind(db);
      let injected = false;
      db.batch = async (statements) => {
        if (!injected) {
          injected = true;
          db.sqlite
            .prepare("UPDATE reservations SET status = 'completed', no_show_at = NULL WHERE id = ?")
            .run(RES_ID);
        }
        return originalBatch(statements);
      };

      const response = await feeRequest(db, access.token, RES_ID, { unpaid: true });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ ok: false, reason: "not_no_show" });
      expect(readUnpaidAt(db, RES_ID)).toBeNull();
      expect(
        (
          db.sqlite
            .prepare(
              "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'reservation.cancellation_fee_update'"
            )
            .get() as { n: number }
        ).n
      ).toBe(0);
    } finally {
      db.sqlite.close();
    }
  });

  it("lets an owner clear (paid) and re-set the unpaid flag, with audit logs", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertMemoAdminUser(db);
      seedReservationForFee(db); // starts flagged
      const access = createMemoAccessFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      // Clear once paid.
      let response = await feeRequest(db, access.token, RES_ID, { unpaid: false });
      expect(response.status).toBe(200);
      expect(readUnpaidAt(db, RES_ID)).toBeNull();

      // Manually re-set.
      response = await feeRequest(db, access.token, RES_ID, { unpaid: true });
      expect(response.status).toBe(200);
      expect(readUnpaidAt(db, RES_ID)).not.toBeNull();

      const audit = db.sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM audit_logs WHERE target_id = ? AND action = 'reservation.cancellation_fee_update'"
        )
        .get(RES_ID) as { n: number };
      expect(audit.n).toBe(2);
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects a non-boolean unpaid value with 400", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertMemoAdminUser(db);
      seedReservationForFee(db);
      const access = createMemoAccessFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await feeRequest(db, access.token, RES_ID, { unpaid: "yes" });
      expect(response.status).toBe(400);
      // unchanged
      expect(readUnpaidAt(db, RES_ID)).not.toBeNull();
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 404 for an unknown reservation", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertMemoAdminUser(db);
      const access = createMemoAccessFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await feeRequest(db, access.token, "res_does_not_exist", { unpaid: false });
      expect(response.status).toBe(404);
    } finally {
      db.sqlite.close();
    }
  });

  it("returns the structured write_failed (500) — not an unstructured error — when the D1 batch throws", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertMemoAdminUser(db);
      seedReservationForFee(db, { status: "no_show", unpaidAt: null });
      const access = createMemoAccessFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      // SELECT-status passes (delegated to the real D1) but the write batch throws.
      const failingBatchDb = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === "batch") {
            return () => Promise.reject(new Error("D1_BATCH_FAIL"));
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
      }) as SqliteD1Database;

      captureExceptionSpy.mockClear();
      const response = await feeRequest(failingBatchDb, access.token, RES_ID, { unpaid: true });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ ok: false, reason: "write_failed" });
      // The batch is atomic — a failed write must leave the flag untouched.
      expect(readUnpaidAt(db, RES_ID)).toBeNull();
      // Catching the throw here robs the global onError handler of the signal, so
      // the handler must capture it explicitly — guard against silent removal.
      expect(captureExceptionSpy).toHaveBeenCalledTimes(1);
      expect(captureExceptionSpy.mock.calls[0][1]).toMatchObject({
        tags: { admin_route: "cancellation_fee_update" }
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 403 without auth and leaves the flag untouched", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedReservationForFee(db);
      const response = await feeRequest(db, null, RES_ID, { unpaid: false });
      expect(response.status).toBe(403);
      expect(readUnpaidAt(db, RES_ID)).not.toBeNull();
    } finally {
      db.sqlite.close();
    }
  });

  // Same identity as the JWT fixture, but role=staff. Passing a storeId also creates
  // the staff_members row the auth JOIN needs — without it store_id stays null and the
  // store-scope gate fails closed.
  const insertStaffAdminUser = (db: SqliteD1Database, storeId?: string) => {
    if (storeId) {
      db.sqlite
        .prepare(
          `INSERT INTO staff_members (id, store_id, display_name, role, active, updated_at)
           VALUES ('staff_fee_1', ?, '料金 スタッフ', 'staff', 1, '2026-05-22T00:00:00.000Z')`
        )
        .run(storeId);
    }
    db.sqlite
      .prepare(
        `INSERT INTO admin_users (id, email, access_subject, role, staff_member_id, active, updated_at)
         VALUES ('admin_fee_staff', ?, ?, 'staff', ?, 1, '2026-05-22T00:00:00.000Z')`
      )
      .run(ADMIN_EMAIL, ADMIN_ACCESS_SUBJECT, storeId ? "staff_fee_1" : null);
  };

  it.each([true, false])("rejects revoked actors at the fee batch boundary (unpaid=%s)", async (unpaid) => {
    for (const revocation of [
      "UPDATE admin_users SET active = 0 WHERE id = 'admin_fee_staff'",
      "UPDATE admin_users SET role = 'owner' WHERE id = 'admin_fee_staff'",
      "UPDATE admin_users SET staff_member_id = NULL WHERE id = 'admin_fee_staff'",
      "UPDATE staff_members SET store_id = 'osaka' WHERE id = 'staff_fee_1'"
    ]) {
      const db = createMigratedSqliteD1();
      try {
        insertStaffAdminUser(db, "kyoto");
        seedReservationForFee(db, { unpaidAt: unpaid ? null : "2026-05-31T02:00:00.000Z" });
        const access = createMemoAccessFixture();
        vi.stubGlobal("fetch", createFetchMock(access.jwk));
        const before = db.sqlite.prepare("SELECT * FROM reservations").all();
        const originalBatch = db.batch.bind(db);
        db.batch = async (statements) => {
          db.sqlite.exec(revocation);
          return originalBatch(statements);
        };
        const response = await feeRequest(db, access.token, RES_ID, { unpaid });
        expect(response.status, revocation).toBe(403);
        await expect(response.json()).resolves.toEqual({ ok: false, reason: "forbidden" });
        expect(db.sqlite.prepare("SELECT * FROM reservations").all()).toEqual(before);
        expect(db.sqlite.prepare("SELECT * FROM audit_logs").all()).toEqual([]);
      } finally { db.sqlite.close(); }
    }
  });

  it.each([true, false])("fee writes reject a target moved or deleted before the batch (unpaid=%s)", async (unpaid) => {
    for (const moved of [true, false]) {
      const db = createMigratedSqliteD1();
      try {
        insertStaffAdminUser(db, "kyoto");
        seedReservationForFee(db, { unpaidAt: unpaid ? null : "2026-05-31T02:00:00.000Z" });
        const access = createMemoAccessFixture();
        vi.stubGlobal("fetch", createFetchMock(access.jwk));
        const originalBatch = db.batch.bind(db);
        let before: unknown;
        db.batch = async (statements) => {
          db.sqlite.exec(moved
            ? `UPDATE reservations SET store_id = 'osaka', service_id = 'service_osaka_default_60',
                 resource_id = 'resource_osaka_calendar' WHERE id = 'res_fee_1'`
            : "DELETE FROM reservations WHERE id = 'res_fee_1'");
          before = db.sqlite.prepare("SELECT * FROM reservations").all();
          return originalBatch(statements);
        };
        const response = await feeRequest(db, access.token, RES_ID, { unpaid });
        expect(response.status).toBe(moved ? 403 : 404);
        expect(before).toBeDefined();
        expect(db.sqlite.prepare("SELECT * FROM reservations").all()).toEqual(before);
        expect(db.sqlite.prepare("SELECT * FROM audit_logs").all()).toEqual([]);
      } finally { db.sqlite.close(); }
    }
  });

  // The reservation seeded above lives at store 'kyoto'.
  it("lets a staff member of the SAME store record the payment", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertStaffAdminUser(db, "kyoto");
      seedReservationForFee(db);
      const access = createMemoAccessFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await feeRequest(db, access.token, RES_ID, { unpaid: false });
      expect(response.status).toBe(200);
      expect(readUnpaidAt(db, RES_ID)).toBeNull();

      const audit = db.sqlite
        .prepare(
          "SELECT actor_id FROM audit_logs WHERE target_id = ? AND action = 'reservation.cancellation_fee_update'"
        )
        .get(RES_ID) as { actor_id: string } | undefined;
      expect(audit?.actor_id).toBe("admin_fee_staff");
    } finally {
      db.sqlite.close();
    }
  });

  it("forbids a staff member of ANOTHER store with 403", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertStaffAdminUser(db, "osaka");
      seedReservationForFee(db);
      const access = createMemoAccessFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await feeRequest(db, access.token, RES_ID, { unpaid: false });
      expect(response.status).toBe(403);
      expect(readUnpaidAt(db, RES_ID)).not.toBeNull();
    } finally {
      db.sqlite.close();
    }
  });

  it("forbids a staff member with no store binding with 403 (fail closed)", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertStaffAdminUser(db);
      seedReservationForFee(db);
      const access = createMemoAccessFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await feeRequest(db, access.token, RES_ID, { unpaid: false });
      expect(response.status).toBe(403);
      expect(readUnpaidAt(db, RES_ID)).not.toBeNull();
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects a manual set (unpaid:true) on a non-no_show reservation with 409", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertMemoAdminUser(db);
      seedReservationForFee(db, { status: "confirmed", unpaidAt: null });
      const access = createMemoAccessFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await feeRequest(db, access.token, RES_ID, { unpaid: true });
      expect(response.status).toBe(409);
      expect(readUnpaidAt(db, RES_ID)).toBeNull();
    } finally {
      db.sqlite.close();
    }
  });

  it("allows a clear (unpaid:false) on a non-no_show reservation", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertMemoAdminUser(db);
      // e.g. a cancelled reservation that somehow carries the flag — clearing must work.
      seedReservationForFee(db, { status: "cancelled_by_admin", unpaidAt: "2026-05-31T02:00:00.000Z" });
      const access = createMemoAccessFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await feeRequest(db, access.token, RES_ID, { unpaid: false });
      expect(response.status).toBe(200);
      expect(readUnpaidAt(db, RES_ID)).toBeNull();
    } finally {
      db.sqlite.close();
    }
  });

  it("stamps the unpaid flag as an ISO-8601 timestamp (matching the no_show path)", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertMemoAdminUser(db);
      seedReservationForFee(db, { status: "no_show", unpaidAt: null });
      const access = createMemoAccessFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const response = await feeRequest(db, access.token, RES_ID, { unpaid: true });
      expect(response.status).toBe(200);
      const stamped = readUnpaidAt(db, RES_ID);
      // ISO-8601 (e.g. 2026-06-01T05:00:00.000Z), not SQLite's "YYYY-MM-DD HH:MM:SS".
      expect(stamped).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    } finally {
      db.sqlite.close();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/customers/:id/archive | /unarchive — HTTP-level tests.
// Reuses the memo-test JWT fixtures (owner identity = ADMIN_EMAIL / ADMIN_ACCESS_SUBJECT).
// ---------------------------------------------------------------------------
describe("POST /api/admin/customers/:id/archive | /unarchive", () => {
  afterEach(() => vi.unstubAllGlobals());

  const insertArchiveCustomer = (db: SqliteD1Database, id: string, archivedAt: string | null) => {
    db.sqlite
      .prepare(
        `INSERT INTO customers (id, display_name, block_status, archived_at, updated_at)
         VALUES (?, 'アーカイブ顧客', 'active', ?, '2026-05-22T00:00:00.000Z')`
      )
      .run(id, archivedAt);
  };

  const archiveRequest = (
    db: SqliteD1Database,
    token: string | null,
    id: string,
    action: "archive" | "unarchive",
    body: unknown
  ) => {
    const app = createApp();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Cf-Access-Jwt-Assertion"] = token;
    return app.request(
      `/api/admin/customers/${encodeURIComponent(id)}/${action}`,
      { method: "POST", headers, body: JSON.stringify(body) },
      memoEnv(db)
    );
  };

  const readArchivedAt = (db: SqliteD1Database, id: string) =>
    (
      db.sqlite.prepare("SELECT archived_at FROM customers WHERE id = ?").get(id) as
        | { archived_at: string | null }
        | undefined
    )?.archived_at ?? null;

  it("lets an owner archive then restore a customer", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertMemoAdminUser(db);
      insertArchiveCustomer(db, "cust_http_archive", null);
      const access = createMemoAccessFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      let res = await archiveRequest(db, access.token, "cust_http_archive", "archive", {
        idempotencyKey: crypto.randomUUID(),
      });
      expect(res.status).toBe(200);
      expect(readArchivedAt(db, "cust_http_archive")).not.toBeNull();

      res = await archiveRequest(db, access.token, "cust_http_archive", "unarchive", {
        idempotencyKey: crypto.randomUUID(),
      });
      expect(res.status).toBe(200);
      expect(readArchivedAt(db, "cust_http_archive")).toBeNull();
    } finally {
      db.sqlite.close();
    }
  });

  // A staff row with no staff_member_id resolves to store_id = null → fail closed,
  // whatever the target customer is.
  it("returns 403 for a staff member with no store binding, leaving the customer un-archived", async () => {
    const db = createMigratedSqliteD1();
    try {
      db.sqlite
        .prepare(
          `INSERT INTO admin_users (id, email, access_subject, role, active, updated_at)
           VALUES ('admin_archive_staff', ?, ?, 'staff', 1, '2026-05-22T00:00:00.000Z')`
        )
        .run(ADMIN_EMAIL, ADMIN_ACCESS_SUBJECT);
      insertArchiveCustomer(db, "cust_http_staff", null);
      const access = createMemoAccessFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const res = await archiveRequest(db, access.token, "cust_http_staff", "archive", {
        idempotencyKey: crypto.randomUUID(),
      });
      expect(res.status).toBe(403);
      expect(readArchivedAt(db, "cust_http_staff")).toBeNull();
    } finally {
      db.sqlite.close();
    }
  });

  it("lets a store-bound staff member archive and restore their own-store customer", async () => {
    const db = createMigratedSqliteD1();
    try {
      db.sqlite
        .prepare(
          `INSERT INTO admin_users (id, email, access_subject, role, staff_member_id, active, updated_at)
           VALUES ('admin_archive_staff_kyoto', ?, ?, 'staff', 'staff_owner_kyoto', 1, '2026-05-22T00:00:00.000Z')`
        )
        .run(ADMIN_EMAIL, ADMIN_ACCESS_SUBJECT);
      grantCustomerTabGate(db, "admin_archive_staff_kyoto");
      db.sqlite
        .prepare(
          `INSERT INTO customers (id, display_name, block_status, archived_at, created_store_id, updated_at)
           VALUES ('cust_http_staff_own', '自店舗顧客', 'active', NULL, 'kyoto', '2026-05-22T00:00:00.000Z')`
        )
        .run();
      const access = createMemoAccessFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      let res = await archiveRequest(db, access.token, "cust_http_staff_own", "archive", {
        idempotencyKey: crypto.randomUUID(),
      });
      expect(res.status).toBe(200);
      expect(readArchivedAt(db, "cust_http_staff_own")).not.toBeNull();

      res = await archiveRequest(db, access.token, "cust_http_staff_own", "unarchive", {
        idempotencyKey: crypto.randomUUID(),
      });
      expect(res.status).toBe(200);
      expect(readArchivedAt(db, "cust_http_staff_own")).toBeNull();
    } finally {
      db.sqlite.close();
    }
  });

  // The store-bound half of the route gate: a staff member WITH a store must still be
  // refused on a customer outside it. Without this the route describe only pinned the
  // no-store-binding case, so a regression that dropped the per-customer scope check
  // while keeping the binding check would have stayed green. (verify-tasks T021)
  it("returns 403 when a store-bound staff member archives another store's customer", async () => {
    const db = createMigratedSqliteD1();
    try {
      db.sqlite
        .prepare(
          `INSERT INTO admin_users (id, email, access_subject, role, staff_member_id, active, updated_at)
           VALUES ('admin_archive_staff_other', ?, ?, 'staff', 'staff_owner_kyoto', 1, '2026-05-22T00:00:00.000Z')`
        )
        .run(ADMIN_EMAIL, ADMIN_ACCESS_SUBJECT);
      db.sqlite
        .prepare(
          `INSERT INTO customers (id, display_name, block_status, archived_at, created_store_id, updated_at)
           VALUES ('cust_http_other_store', '他店舗顧客', 'active', NULL, 'osaka', '2026-05-22T00:00:00.000Z')`
        )
        .run();
      const access = createMemoAccessFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const res = await archiveRequest(db, access.token, "cust_http_other_store", "archive", {
        idempotencyKey: crypto.randomUUID(),
      });
      expect(res.status).toBe(403);
      expect(readArchivedAt(db, "cust_http_other_store")).toBeNull();
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 403 without auth", async () => {
    const db = createMigratedSqliteD1();
    try {
      const res = await archiveRequest(db, null, "any-id", "archive", {
        idempotencyKey: crypto.randomUUID(),
      });
      expect(res.status).toBe(403);
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 404 for an unknown customer", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertMemoAdminUser(db);
      const access = createMemoAccessFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const res = await archiveRequest(db, access.token, "nope", "archive", {
        idempotencyKey: crypto.randomUUID(),
      });
      expect(res.status).toBe(404);
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 400 when idempotencyKey is missing", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertMemoAdminUser(db);
      insertArchiveCustomer(db, "cust_http_badreq", null);
      const access = createMemoAccessFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const res = await archiveRequest(db, access.token, "cust_http_badreq", "archive", {});
      expect(res.status).toBe(400);
    } finally {
      db.sqlite.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Archived customers are not mutable via memo/profile, and surface only in the
// archived list view.
// ---------------------------------------------------------------------------
describe("archived customers are filtered from memo/profile and listed under view=archived", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("PUT memo on an archived customer returns 404 (filtered out)", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertMemoAdminUser(db);
      db.sqlite
        .prepare(
          `INSERT INTO customers (id, display_name, block_status, archived_at, updated_at)
           VALUES ('cust_arch_memo', 'アーカイブ', 'active', '2026-05-10T00:00:00.000Z', '2026-05-10T00:00:00.000Z')`
        )
        .run();
      const access = createMemoAccessFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const res = await memoRequest(db, access.token, "cust_arch_memo", { memo: "x" });
      expect(res.status).toBe(404);
    } finally {
      db.sqlite.close();
    }
  });

  it("GET /customers?mode=list&view=archived returns only archived rows", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertMemoAdminUser(db);
      db.sqlite.exec(`
        INSERT INTO customers (id, display_name, block_status, archived_at, updated_at) VALUES
          ('cust_a_active', '現役', 'active', NULL, '2026-05-09T00:00:00.000Z'),
          ('cust_a_archived', 'アーカイブ', 'active', '2026-05-10T00:00:00.000Z', '2026-05-10T00:00:00.000Z');
      `);
      const access = createMemoAccessFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      const app = createApp();
      const res = await app.request(
        "/api/admin/customers?mode=list&view=archived",
        { headers: { "Cf-Access-Jwt-Assertion": access.token } },
        memoEnv(db)
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { customers: Array<{ id: string }>; total: number };
      expect(body.customers.map((c) => c.id)).toEqual(["cust_a_archived"]);
      expect(body.total).toBe(1);
    } finally {
      db.sqlite.close();
    }
  });
});
