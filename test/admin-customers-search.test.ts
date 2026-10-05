import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  normalizeCustomerSearchQuery,
  searchAdminCustomers,
  listAllCustomers,
  listCustomerMergeCandidates
} from "../src/admin/customers";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

describe("normalizeCustomerSearchQuery", () => {
  it("rejects empty input as invalid_request", () => {
    expect(normalizeCustomerSearchQuery("")).toEqual({
      ok: false,
      reason: "invalid_request"
    });
  });

  it("rejects whitespace-only input as invalid_request", () => {
    expect(normalizeCustomerSearchQuery("   \t\n ")).toEqual({
      ok: false,
      reason: "invalid_request"
    });
  });

  it("returns name text and null phones for non-phone-like text", () => {
    expect(normalizeCustomerSearchQuery("山田")).toEqual({
      text: "山田",
      phoneA: null,
      phoneB: null
    });
  });

  it("returns kana text and null phones for katakana-only input", () => {
    expect(normalizeCustomerSearchQuery("ヤマダ")).toEqual({
      text: "ヤマダ",
      phoneA: null,
      phoneB: null
    });
  });

  it("preserves mixed text containing 3-7 digits and falls through to phone search", () => {
    expect(normalizeCustomerSearchQuery("山田 090")).toEqual({
      text: "山田 090",
      phoneA: "090",
      phoneB: "090"
    });
  });

  it("treats 3-digit numeric input as phone prefix with text=null", () => {
    expect(normalizeCustomerSearchQuery("090")).toEqual({
      text: null,
      phoneA: "090",
      phoneB: "090"
    });
  });

  it("treats 7-digit numeric input as phone prefix with text=null", () => {
    expect(normalizeCustomerSearchQuery("0901234")).toEqual({
      text: null,
      phoneA: "0901234",
      phoneB: "0901234"
    });
  });

  it("expands full domestic phone to both 0- and +81- forms", () => {
    expect(normalizeCustomerSearchQuery("080-1234-5678")).toEqual({
      text: null,
      phoneA: "08012345678",
      phoneB: "+818012345678"
    });
  });

  // 入力が +81 でも保存形 (国内表記) が先。二つ目は正規化を入れる前に作られた行を
  // 拾うための旧表記で、backfill が終われば実データからは消える。
  it("folds a full international +81 phone to the domestic form and keeps the legacy twin", () => {
    expect(normalizeCustomerSearchQuery("+81 80 1234 5678")).toEqual({
      text: null,
      phoneA: "08012345678",
      phoneB: "+818012345678"
    });
  });

  it("preserves non-+81 international number as same phoneA and phoneB", () => {
    expect(normalizeCustomerSearchQuery("+12025550199")).toEqual({
      text: null,
      phoneA: "+12025550199",
      phoneB: "+12025550199"
    });
  });

  it("returns all-null fields for 2-digit numeric input (too short for prefix)", () => {
    expect(normalizeCustomerSearchQuery("09")).toEqual({
      text: null,
      phoneA: null,
      phoneB: null
    });
  });

  it("returns text and null phones for kanji+kana with no digits", () => {
    expect(normalizeCustomerSearchQuery("ヤマダ太郎")).toEqual({
      text: "ヤマダ太郎",
      phoneA: null,
      phoneB: null
    });
  });

  it("trims leading and trailing whitespace before classification", () => {
    expect(normalizeCustomerSearchQuery("  山田  ")).toEqual({
      text: "山田",
      phoneA: null,
      phoneB: null
    });
  });
});

describe("searchAdminCustomers", () => {
  let d1: SqliteD1Database;

  beforeEach(() => {
    d1 = createMigratedSqliteD1();
    d1.sqlite.exec(`
      DELETE FROM customers;
      INSERT INTO customers (id, display_name, display_name_kana, phone_normalized, block_status, updated_at)
      VALUES
        ('cust_yamada', '山田 太郎', 'ヤマダ タロウ', '08012345678', 'active', '2026-05-12T01:00:00.000Z'),
        ('cust_yamamoto', '山本 花子', 'ヤマモト ハナコ', '08087654321', 'active', '2026-05-12T02:00:00.000Z'),
        ('cust_blocked', '佐藤 健', 'サトウ ケン', '09011112222', 'blocked', '2026-05-12T03:00:00.000Z'),
        ('cust_underscore_name', 'tricky_name', null, null, 'active', '2026-05-12T04:00:00.000Z'),
        ('cust_percent_name', '100%fan', null, null, 'active', '2026-05-12T05:00:00.000Z'),
        ('cust_no_phone', 'No Phone', 'ノーフォン', null, 'active', '2026-05-12T00:30:00.000Z');
    `);
  });

  afterEach(() => {
    d1.sqlite.close();
  });

  it("rejects a text query whose LIKE pattern exceeds D1's 50-byte cap", async () => {
    // 17 Japanese chars = 51 bytes UTF-8; with %...% wrapping it is 53 bytes.
    // Local SQLite would accept this, but production D1 rejects LIKE patterns
    // over 50 bytes — the guard must fail closed as invalid_request instead.
    const result = await searchAdminCustomers({
      db: d1 as unknown as D1Database,
      query: "あ".repeat(17)
    });
    expect(result).toEqual({ ok: false, reason: "invalid_request" });
  });

  it("rejects an all-digit query too long to be a phone number (normalize layer)", async () => {
    // 49 digits exceed normalizePhone's 8-16 digit window, so normalization
    // already yields no usable pattern and the search fails closed BEFORE the
    // phone LIKE budget guard. The phone-pattern guards in
    // searchAdminCustomers are defense-in-depth for future normalize changes
    // (canonical phones today are <= 17 chars, far under 50 bytes) and are
    // not reachable through the public API.
    const result = await searchAdminCustomers({
      db: d1 as unknown as D1Database,
      query: "1".repeat(49)
    });
    expect(result).toEqual({ ok: false, reason: "invalid_request" });
  });

  it("accepts a text query just under the byte budget", async () => {
    // 16 Japanese chars = 48 bytes; +2 for %...% = 50 bytes (at the cap, OK).
    const result = await searchAdminCustomers({
      db: d1 as unknown as D1Database,
      query: "あ".repeat(16)
    });
    expect(result.ok).toBe(true);
  });

  it("returns invalid_request when query is empty", async () => {
    const result = await searchAdminCustomers({ db: d1 as unknown as D1Database, query: "  " });
    expect(result).toEqual({ ok: false, reason: "invalid_request" });
  });

  it("returns invalid_request when normalized fields are all null", async () => {
    const result = await searchAdminCustomers({ db: d1 as unknown as D1Database, query: "09" });
    expect(result).toEqual({ ok: false, reason: "invalid_request" });
  });

  it.each([
    {
      name: "matches by display_name substring without false-positive phone matches",
      query: "山田",
      expectedIds: ["cust_yamada"]
    },
    {
      name: "matches by display_name_kana substring",
      query: "ヤマモト",
      expectedIds: ["cust_yamamoto"]
    },
    {
      name: "matches a domestic 0-prefixed phone via the +81 variant column",
      query: "080-1234-5678",
      expectedIds: ["cust_yamada"]
    },
    {
      name: "matches a +81-prefixed query against the domestic form on file",
      query: "+818087654321",
      expectedIds: ["cust_yamamoto"]
    },
    {
      name: "matches a 3-7 digit prefix against phone_normalized",
      query: "9011",
      expectedIds: ["cust_blocked"]
    },
    {
      name: "escapes underscore LIKE wildcard so it matches literally",
      query: "_name",
      expectedIds: ["cust_underscore_name"]
    },
    {
      name: "escapes percent LIKE wildcard so it matches literally",
      query: "100%",
      expectedIds: ["cust_percent_name"]
    }
  ])("$name", async ({ query, expectedIds }) => {
    const result = await searchAdminCustomers({
      db: d1 as unknown as D1Database,
      query
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.customers.map((c) => c.id)).toEqual(expectedIds);
  });

  it("masks the phone to its last 4 digits for staff, returns it raw for owner", async () => {
    const asStaff = await searchAdminCustomers({
      db: d1 as unknown as D1Database,
      query: "山田",
      isStaff: true
    });
    expect(asStaff.ok).toBe(true);
    if (!asStaff.ok) throw new Error("unreachable");
    expect(asStaff.customers[0].phoneNormalized).toBe("***-****-5678");

    const asOwner = await searchAdminCustomers({
      db: d1 as unknown as D1Database,
      query: "山田",
      isStaff: false
    });
    expect(asOwner.ok).toBe(true);
    if (!asOwner.ok) throw new Error("unreachable");
    expect(asOwner.customers[0].phoneNormalized).toBe("08012345678");

    // A phoneless customer stays null for staff — NOT a masked "****" that would
    // falsely imply a hidden number exists.
    const staffNoPhone = await searchAdminCustomers({
      db: d1 as unknown as D1Database,
      query: "No Phone",
      isStaff: true
    });
    expect(staffNoPhone.ok).toBe(true);
    if (!staffNoPhone.ok) throw new Error("unreachable");
    expect(staffNoPhone.customers[0]?.phoneNormalized).toBeNull();
  });

  it("staff phone search is exact-match (full number works, partial probe finds nothing) — closes the mask oracle", async () => {
    // Staff: a FULL-number lookup still works (both canonical variants matched).
    const staffFull = await searchAdminCustomers({
      db: d1 as unknown as D1Database,
      query: "08012345678",
      isStaff: true
    });
    expect(staffFull.ok).toBe(true);
    if (!staffFull.ok) throw new Error("unreachable");
    expect(staffFull.customers.map((c) => c.id)).toEqual(["cust_yamada"]);

    // Staff: a PARTIAL digit probe (what a recovery oracle needs) matches nothing.
    const staffPartial = await searchAdminCustomers({
      db: d1 as unknown as D1Database,
      query: "8012",
      isStaff: true
    });
    expect(staffPartial.ok).toBe(true);
    if (!staffPartial.ok) throw new Error("unreachable");
    expect(staffPartial.customers).toEqual([]);

    // Owner: substring LIKE is preserved for convenience (partial probe matches).
    const ownerPartial = await searchAdminCustomers({
      db: d1 as unknown as D1Database,
      query: "8012",
      isStaff: false
    });
    expect(ownerPartial.ok).toBe(true);
    if (!ownerPartial.ok) throw new Error("unreachable");
    expect(ownerPartial.customers.map((c) => c.id)).toEqual(["cust_yamada"]);
  });

  it("orders by updated_at descending", async () => {
    const result = await searchAdminCustomers({
      db: d1 as unknown as D1Database,
      query: "山"
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.customers.map((c) => c.id)).toEqual(["cust_yamamoto", "cust_yamada"]);
  });

  it("respects the limit parameter", async () => {
    const result = await searchAdminCustomers({
      db: d1 as unknown as D1Database,
      query: "山",
      limit: 1
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.customers).toHaveLength(1);
    expect(result.customers[0].id).toBe("cust_yamamoto");
  });

  it("returns empty array when no rows match", async () => {
    const result = await searchAdminCustomers({
      db: d1 as unknown as D1Database,
      query: "存在しない人物"
    });
    expect(result).toEqual({ ok: true, customers: [] });
  });

  it("excludes merged tombstones (merged_into_id set) from results", async () => {
    // A merge tombstone keeps the source's display_name/phone but points at the
    // canonical record. Search must not resurface it (listAllCustomers already
    // filters merged_into_id IS NULL; search must match).
    d1.sqlite.exec(`
      INSERT INTO customers (id, display_name, display_name_kana, phone_normalized, block_status, merged_into_id, updated_at)
      VALUES ('cust_yamada_dup', '山田 太郎', 'ヤマダ タロウ', '08012345678', 'blocked', 'cust_yamada', '2026-05-12T06:00:00.000Z');
    `);
    const result = await searchAdminCustomers({
      db: d1 as unknown as D1Database,
      query: "山田"
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // Only the canonical row, never the tombstone.
    expect(result.customers.map((c) => c.id)).toEqual(["cust_yamada"]);
  });

  it("excludes a merged tombstone matched by phone too", async () => {
    d1.sqlite.exec(`
      INSERT INTO customers (id, display_name, display_name_kana, phone_normalized, block_status, merged_into_id, updated_at)
      VALUES ('cust_phone_dup', '重複 電話', null, '08087654321', 'blocked', 'cust_yamamoto', '2026-05-12T07:00:00.000Z');
    `);
    const result = await searchAdminCustomers({
      db: d1 as unknown as D1Database,
      query: "080-8765-4321"
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.customers.map((c) => c.id)).toEqual(["cust_yamamoto"]);
  });

  it("returns block_status, displayName, kana, and normalized phone in the projection", async () => {
    const result = await searchAdminCustomers({
      db: d1 as unknown as D1Database,
      query: "佐藤"
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.customers[0]).toEqual({
      id: "cust_blocked",
      displayName: "佐藤 健",
      displayNameKana: "サトウ ケン",
      phoneNormalized: "09011112222",
      blockStatus: "blocked",
      memo: null
    });
  });

  it("returns null for missing kana and phone columns", async () => {
    const result = await searchAdminCustomers({
      db: d1 as unknown as D1Database,
      query: "No Phone"
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.customers[0]).toEqual({
      id: "cust_no_phone",
      displayName: "No Phone",
      displayNameKana: "ノーフォン",
      phoneNormalized: null,
      blockStatus: "active",
      memo: null
    });
  });
});

describe("listAllCustomers", () => {
  let d1: SqliteD1Database;

  beforeEach(() => {
    d1 = createMigratedSqliteD1();
    d1.sqlite.exec(`
      DELETE FROM reservations;
      DELETE FROM customers;
    `);
    d1.sqlite.exec(`
      INSERT INTO customers (id, display_name, display_name_kana, phone_normalized, block_status, memo, created_at, updated_at)
      VALUES
        ('c1', '田中花子', 'タナカ ハナコ', '08011111111', 'active', 'VIP顧客', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z'),
        ('c2', '山田太郎', 'ヤマダ タロウ', '08022222222', 'active', NULL, '2026-05-02T00:00:00.000Z', '2026-05-02T00:00:00.000Z'),
        ('c3', '佐藤健',   NULL,            NULL,            'blocked', '要注意', '2026-05-03T00:00:00.000Z', '2026-05-03T00:00:00.000Z')
    `);
  });

  afterEach(() => {
    d1.sqlite.close();
  });

  it("returns all customers with total count", async () => {
    const result = await listAllCustomers(d1 as unknown as D1Database);
    expect(result.total).toBe(3);
    expect(result.customers).toHaveLength(3);
    const ids = result.customers.map((c) => c.id);
    expect(ids).toContain("c1");
    expect(ids).toContain("c2");
    expect(ids).toContain("c3");
  });

  it("masks phone numbers showing only last 4 digits", async () => {
    const result = await listAllCustomers(d1 as unknown as D1Database);
    const c1 = result.customers.find((c) => c.id === "c1")!;
    expect(c1.phoneNormalizedMasked).toBe("***-****-1111");
    const c2 = result.customers.find((c) => c.id === "c2")!;
    expect(c2.phoneNormalizedMasked).toBe("***-****-2222");
  });

  it("returns empty string for customers without phone", async () => {
    const result = await listAllCustomers(d1 as unknown as D1Database);
    const c3 = result.customers.find((c) => c.id === "c3")!;
    expect(c3.phoneNormalizedMasked).toBe("");
  });

  it("includes memo field", async () => {
    const result = await listAllCustomers(d1 as unknown as D1Database);
    const c1 = result.customers.find((c) => c.id === "c1")!;
    expect(c1.memo).toBe("VIP顧客");
    const c2 = result.customers.find((c) => c.id === "c2")!;
    expect(c2.memo).toBeNull();
  });

  it("computes visitCount from valid customer_visits (completed reservations + manual imports, excluding voided)", async () => {
    // A completed reservation always writes a ledger row, so seed the ledger
    // directly. c1: one reservation_completed + one manual_import (paper-chart
    // history added from the card) + one voided manual row that must NOT count.
    d1.sqlite.exec(`
      INSERT INTO reservations (id, store_id, service_id, customer_id, resource_id, source, status, duration_minutes, idempotency_key, start_at, end_at, created_at, updated_at)
      VALUES
        ('r1', 'kyoto', 'service_kyoto_default_60', 'c1', 'resource_kyoto_calendar', 'admin', 'completed', 60, 'ik_r1', '2026-04-01T10:00:00Z', '2026-04-01T11:00:00Z', '2026-04-01T10:00:00Z', '2026-04-01T10:00:00Z')
    `);
    // reservation_completed rows carry a full ISO timestamp (buildCompleteVisitStatement
    // binds the reservation's start_at); manual_import rows carry a bare date-only
    // 'YYYY-MM-DD' key (customer-visits.ts validates request.visitedAt as YYYY-MM-DD)
    // — seed both formats so the mixed-format reality is exercised.
    d1.sqlite.exec(`
      INSERT INTO customer_visits (id, customer_id, reservation_id, store_id, visited_at, visit_source, status, recorded_by)
      VALUES
        ('v1', 'c1', 'r1', 'kyoto', '2026-04-01T10:00:00Z', 'reservation_completed', 'valid', 'admin_test'),
        ('v2', 'c1', NULL, 'kyoto', '2026-03-10', 'manual_import', 'valid', 'admin_test');
      INSERT INTO customer_visits (id, customer_id, reservation_id, store_id, visited_at, visit_source, status, recorded_by, voided_by, voided_at, void_reason)
      VALUES
        ('v3', 'c1', NULL, 'kyoto', '2026-03-12', 'manual_import', 'voided', 'admin_test', 'admin_test', '2026-03-13T00:00:00Z', 'entered by mistake');
    `);
    const result = await listAllCustomers(d1 as unknown as D1Database);
    const c1 = result.customers.find((c) => c.id === "c1")!;
    expect(c1.visitCount).toBe(2);
    const c2 = result.customers.find((c) => c.id === "c2")!;
    expect(c2.visitCount).toBe(0);
  });

  it("reports 0 visits and no last visit when every ledger row is voided", async () => {
    d1.sqlite.exec(`
      INSERT INTO reservations (id, store_id, service_id, customer_id, resource_id, source, status, duration_minutes, idempotency_key, start_at, end_at, created_at, updated_at)
      VALUES
        ('r1', 'kyoto', 'service_kyoto_default_60', 'c1', 'resource_kyoto_calendar', 'admin', 'no_show', 60, 'ik_r1', '2026-04-01T10:00:00Z', '2026-04-01T11:00:00Z', '2026-04-01T10:00:00Z', '2026-04-01T10:00:00Z');
      INSERT INTO customer_visits (id, customer_id, reservation_id, store_id, visited_at, visit_source, status, recorded_by, voided_by, voided_at, void_reason)
      VALUES
        ('v1', 'c1', 'r1', 'kyoto', '2026-04-01T10:00:00Z', 'reservation_completed', 'voided', 'admin_test', 'admin_test', '2026-04-03T00:00:00Z', 'reservation_corrected_to_no_show'),
        ('v2', 'c1', NULL, 'kyoto', '2026-03-10', 'manual_import', 'voided', 'admin_test', 'admin_test', '2026-04-03T00:00:00Z', 'entered by mistake');
    `);
    const result = await listAllCustomers(d1 as unknown as D1Database);
    const c1 = result.customers.find((c) => c.id === "c1")!;
    expect(c1.visitCount).toBe(0);
    expect(c1.lastVisitAt).toBeNull();
  });

  it("computes lastVisitAt from the latest valid ledger visit (manual import can be the latest)", async () => {
    d1.sqlite.exec(`
      INSERT INTO reservations (id, store_id, service_id, customer_id, resource_id, source, status, duration_minutes, idempotency_key, start_at, end_at, created_at, updated_at)
      VALUES
        ('r1', 'kyoto', 'service_kyoto_default_60', 'c1', 'resource_kyoto_calendar', 'admin', 'completed', 60, 'ik-r1', '2026-04-01T10:00:00Z', '2026-04-01T11:00:00Z', '2026-04-01T10:00:00Z', '2026-04-01T10:00:00Z')
    `);
    // Manual import in production format (date-only). MAX() over mixed formats:
    // '2026-04-15' (date-only) sorts lexicographically after the earlier
    // reservation_completed timestamp, so it is the latest visit.
    d1.sqlite.exec(`
      INSERT INTO customer_visits (id, customer_id, reservation_id, store_id, visited_at, visit_source, status, recorded_by)
      VALUES
        ('v1', 'c1', 'r1', 'kyoto', '2026-04-01T10:00:00Z', 'reservation_completed', 'valid', 'admin_test'),
        ('v2', 'c1', NULL, 'kyoto', '2026-04-15', 'manual_import', 'valid', 'admin_test');
    `);
    const result = await listAllCustomers(d1 as unknown as D1Database);
    const c1 = result.customers.find((c) => c.id === "c1")!;
    expect(c1.lastVisitAt).toBe("2026-04-15");
    const c2 = result.customers.find((c) => c.id === "c2")!;
    expect(c2.lastVisitAt).toBeNull();
  });

  it("returns the raw latest visit while ordering customers by JST-normalized time", async () => {
    d1.sqlite.exec(`
      INSERT INTO customer_visits (id, customer_id, store_id, visited_at, visit_source, status, recorded_by)
      VALUES
        ('v_c1_iso', 'c1', 'kyoto', '2026-04-01T23:30:00.000Z', 'reservation_completed', 'valid', 'admin_test'),
        ('v_c1_manual', 'c1', 'kyoto', '2026-04-02', 'manual_import', 'valid', 'admin_test'),
        ('v_c2_iso', 'c2', 'kyoto', '2026-04-01T22:30:00.000Z', 'reservation_completed', 'valid', 'admin_test'),
        ('v_c3_manual', 'c3', 'kyoto', '2026-04-02', 'manual_import', 'valid', 'admin_test');
    `);

    const { customers } = await listAllCustomers(d1 as unknown as D1Database);

    expect(customers.map((customer) => customer.id)).toEqual(["c1", "c2", "c3"]);
    expect(customers[0]?.lastVisitAt).toBe("2026-04-01T23:30:00.000Z");
  });

  it("computes nextReservationAt from future confirmed reservations", async () => {
    d1.sqlite.exec(`
      INSERT INTO reservations (id, store_id, service_id, customer_id, resource_id, source, status, duration_minutes, idempotency_key, start_at, end_at, created_at, updated_at)
      VALUES
        ('r1', 'kyoto', 'service_kyoto_default_60', 'c2', 'resource_kyoto_calendar', 'admin', 'confirmed', 60, 'ik-r1', '2099-01-01T10:00:00Z', '2099-01-01T11:00:00Z', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z'),
        ('r2', 'kyoto', 'service_kyoto_default_60', 'c2', 'resource_kyoto_calendar', 'admin', 'confirmed', 60, 'ik-r2', '2099-06-01T10:00:00Z', '2099-06-01T11:00:00Z', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z')
    `);
    const result = await listAllCustomers(d1 as unknown as D1Database);
    const c2 = result.customers.find((c) => c.id === "c2")!;
    expect(c2.nextReservationAt).toBe("2099-01-01T10:00:00Z");
  });

  it("excludes merged tombstone customers", async () => {
    d1.sqlite.exec("UPDATE customers SET merged_into_id = 'c1' WHERE id = 'c3'");
    const result = await listAllCustomers(d1 as unknown as D1Database);
    expect(result.total).toBe(2);
    expect(result.customers).toHaveLength(2);
    const ids = result.customers.map((c) => c.id);
    expect(ids).not.toContain("c3");
  });

  it("respects limit and offset for pagination", async () => {
    const page1 = await listAllCustomers(d1 as unknown as D1Database, 2, 0);
    expect(page1.customers).toHaveLength(2);
    expect(page1.total).toBe(3);

    const page2 = await listAllCustomers(d1 as unknown as D1Database, 2, 2);
    expect(page2.customers).toHaveLength(1);
    expect(page2.total).toBe(3);
  });

  it("returns empty list when no customers exist", async () => {
    d1.sqlite.exec("DELETE FROM customers");
    const result = await listAllCustomers(d1 as unknown as D1Database);
    expect(result.customers).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});

describe("archive filtering excludes archived customers", () => {
  let d1: SqliteD1Database;

  beforeEach(() => {
    d1 = createMigratedSqliteD1();
    // Two customers sharing a phone_hash (a merge-candidate pair); one archived.
    d1.sqlite.exec(`
      INSERT INTO customers (id, display_name, display_name_kana, phone_normalized, phone_hash, block_status, archived_at, updated_at)
      VALUES
        ('cust_active', '田中 太郎', 'タナカ タロウ', '09011112222', 'shared_hash', 'active', NULL, '2026-05-09T00:00:00.000Z'),
        ('cust_archived', '田中 二郎', 'タナカ ジロウ', '09011112222', 'shared_hash', 'active', '2026-05-10T00:00:00.000Z', '2026-05-10T00:00:00.000Z');
    `);
  });
  afterEach(() => d1.sqlite.close());

  it("search by name omits archived rows", async () => {
    const result = await searchAdminCustomers({ db: d1 as unknown as D1Database, query: "田中" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.customers.map((c) => c.id);
    expect(ids).toContain("cust_active");
    expect(ids).not.toContain("cust_archived");
  });

  it("list mode omits archived rows and the count matches", async () => {
    const { customers, total } = await listAllCustomers(d1 as unknown as D1Database, 200, 0);
    const ids = customers.map((c) => c.id);
    expect(ids).toContain("cust_active");
    expect(ids).not.toContain("cust_archived");
    expect(total).toBe(1);
  });

  it("archivedOnly list returns only archived rows", async () => {
    const { customers, total } = await listAllCustomers(d1 as unknown as D1Database, 200, 0, {
      archivedOnly: true,
    });
    const ids = customers.map((c) => c.id);
    expect(ids).toEqual(["cust_archived"]);
    expect(total).toBe(1);
  });

  it("merge-candidates does not group an archived row (no false duplicate)", async () => {
    const result = await listCustomerMergeCandidates({ db: d1 as unknown as D1Database });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only one non-archived row shares the hash → not a duplicate group.
    expect(result.groups).toHaveLength(0);
  });
});

// Task 6: staff store-scope (own-store customers only). The route passes
// storeScope = staff.store_id; owner/system_admin pass null (full view).
describe("customer list/search store scope (staff own-store only)", () => {
  let d1: SqliteD1Database;

  // Keep each reservation's seeded service/resource in the same store.
  const resv = (id: string, customerId: string, storeId: string, status: string, startAt: string) => {
    const endAt = new Date(new Date(startAt).getTime() + 3_600_000).toISOString();
    return `INSERT INTO reservations (id, store_id, service_id, customer_id, resource_id, source, status, duration_minutes, idempotency_key, start_at, end_at, created_at, updated_at)
     VALUES ('${id}', '${storeId}', 'service_${storeId}_default_60', '${customerId}', 'resource_${storeId}_calendar', 'admin', '${status}', 60, 'ik_${id}', '${startAt}', '${endAt}', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z');`;
  };
  const visit = (id: string, customerId: string, storeId: string, status: string, visitedAt: string) =>
    `INSERT INTO customer_visits (id, customer_id, reservation_id, store_id, visited_at, visit_source, status, recorded_by)
     VALUES ('${id}', '${customerId}', NULL, '${storeId}', '${visitedAt}', 'manual_import', '${status}', 'admin_test');`;

  beforeEach(() => {
    d1 = createMigratedSqliteD1();
    d1.sqlite.exec(`DELETE FROM reservations; DELETE FROM customer_visits; DELETE FROM customers;`);
    d1.sqlite.exec(`
      INSERT INTO customers (id, display_name, display_name_kana, phone_normalized, block_status, created_at, updated_at) VALUES
        ('c_kyoto',  '京都 太郎', 'キョウト タロウ', '08011110001', 'active', '2026-05-01T00:00:00Z', '2026-05-05T00:00:00Z'),
        ('c_osaka',  '大阪 花子', 'オオサカ ハナコ', '08011110002', 'active', '2026-05-02T00:00:00Z', '2026-05-04T00:00:00Z'),
        ('c_cross',  '横断 次郎', 'オウダン ジロウ', '08011110003', 'active', '2026-05-03T00:00:00Z', '2026-05-06T00:00:00Z'),
        ('c_voided', '無効 三郎', 'ムコウ サブロウ', '08011110004', 'active', '2026-05-03T00:00:00Z', '2026-05-03T00:00:00Z');
    `);
    // c_kyoto: kyoto reservation + valid kyoto visit.
    d1.sqlite.exec(resv("r_kyoto", "c_kyoto", "kyoto", "completed", "2026-04-01T10:00:00Z"));
    d1.sqlite.exec(visit("v_kyoto", "c_kyoto", "kyoto", "valid", "2026-04-01"));
    // c_osaka: osaka reservation only.
    d1.sqlite.exec(resv("r_osaka", "c_osaka", "osaka", "completed", "2026-04-02T10:00:00Z"));
    // c_cross: reservations + valid visits at BOTH stores (tests aggregate scoping).
    d1.sqlite.exec(resv("r_cross_k", "c_cross", "kyoto", "confirmed", "2099-01-01T10:00:00Z"));
    d1.sqlite.exec(resv("r_cross_o", "c_cross", "osaka", "confirmed", "2099-02-01T10:00:00Z"));
    d1.sqlite.exec(visit("v_cross_k", "c_cross", "kyoto", "valid", "2026-04-10"));
    d1.sqlite.exec(visit("v_cross_o1", "c_cross", "osaka", "valid", "2026-04-20"));
    d1.sqlite.exec(visit("v_cross_o2", "c_cross", "osaka", "valid", "2026-04-21"));
    // c_voided: only a VOIDED visit at kyoto, no reservation → NOT an own-store customer.
    d1.sqlite.exec(
      `INSERT INTO customer_visits (id, customer_id, reservation_id, store_id, visited_at, visit_source, status, recorded_by, voided_by, voided_at, void_reason)
       VALUES ('v_voided', 'c_voided', NULL, 'kyoto', '2026-04-05', 'manual_import', 'voided', 'admin_test', 'admin_test', '2026-04-06T00:00:00Z', 'entered by mistake');`
    );
  });
  afterEach(() => d1.sqlite.close());

  it("search scoped to kyoto returns only own-store customers (excludes osaka-only and voided-only)", async () => {
    const result = await searchAdminCustomers({ db: d1 as unknown as D1Database, query: "08011110", storeScope: "kyoto" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const ids = result.customers.map((c) => c.id).sort();
    expect(ids).toEqual(["c_cross", "c_kyoto"]);
  });

  // 並び順にも店舗スコープが要る。外側の ORDER BY が使う MAX(...) サブクエリから
  // 店舗条件を落とすと、他店舗のより新しい来店で順序が決まってしまう。c_cross は
  // 大阪により新しい来店があるので、条件が効いていればこの 2 人の順序が入れ替わる。
  it("orders the scoped list by own-store visits only", async () => {
    d1.sqlite.exec(visit("v_kyoto_late", "c_kyoto", "kyoto", "valid", "2026-04-15"));

    const { customers } = await listAllCustomers(d1 as unknown as D1Database, 200, 0, { storeScope: "kyoto" });

    expect(customers.map((c) => c.id)).toEqual(["c_kyoto", "c_cross"]);
    // 返す最終来店日も自店舗ぶんだけ (大阪の 04-20 / 04-21 は出さない)。
    expect(customers.find((c) => c.id === "c_cross")?.lastVisitAt).toBe("2026-04-10");
  });

  // datetime() は秒までしか見ないので、同じ秒のミリ秒違いは正規化キーで同点になる。
  // 同点の解き方が無いと、返る最終来店日が挿入順まかせになる。
  it("breaks a same-second tie by created_at so lastVisitAt is deterministic", async () => {
    d1.sqlite.exec(`DELETE FROM customer_visits WHERE customer_id = 'c_kyoto';`);
    d1.sqlite.exec(
      `INSERT INTO customer_visits (id, customer_id, reservation_id, store_id, visited_at, visit_source, status, recorded_by, created_at)
       VALUES ('v_tie_late', 'c_kyoto', NULL, 'kyoto', '2026-05-01T00:30:00.900Z', 'manual_import', 'valid', 'admin_test', '2026-05-02T00:00:00Z');`
    );
    d1.sqlite.exec(
      `INSERT INTO customer_visits (id, customer_id, reservation_id, store_id, visited_at, visit_source, status, recorded_by, created_at)
       VALUES ('v_tie_early', 'c_kyoto', NULL, 'kyoto', '2026-05-01T00:30:00.100Z', 'manual_import', 'valid', 'admin_test', '2026-05-01T00:00:00Z');`
    );

    const { customers } = await listAllCustomers(d1 as unknown as D1Database, 200, 0, { storeScope: "kyoto" });

    expect(customers.find((c) => c.id === "c_kyoto")?.lastVisitAt).toBe("2026-05-01T00:30:00.900Z");
  });

  it("search without scope (owner) returns all matching customers", async () => {
    const result = await searchAdminCustomers({ db: d1 as unknown as D1Database, query: "08011110" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.customers.map((c) => c.id).sort()).toEqual(["c_cross", "c_kyoto", "c_osaka", "c_voided"]);
  });

  it("list scoped to kyoto excludes osaka-only and voided-only customers", async () => {
    const { customers, total } = await listAllCustomers(d1 as unknown as D1Database, 200, 0, { storeScope: "kyoto" });
    const ids = customers.map((c) => c.id).sort();
    expect(ids).toEqual(["c_cross", "c_kyoto"]);
    expect(total).toBe(2);
  });

  it("list scoped to kyoto reports a cross-store customer's stats for kyoto ONLY (no other-store leak)", async () => {
    const { customers } = await listAllCustomers(d1 as unknown as D1Database, 200, 0, { storeScope: "kyoto" });
    const cross = customers.find((c) => c.id === "c_cross")!;
    // Only the 1 kyoto valid visit counts, not the 2 osaka visits.
    expect(cross.visitCount).toBe(1);
    expect(cross.lastVisitAt).toBe("2026-04-10");
    // Only the kyoto future confirmed reservation, not the osaka one.
    expect(cross.nextReservationAt).toBe("2099-01-01T10:00:00Z");
  });

  it("keeps JST ordering and raw lastVisitAt inside the staff store scope", async () => {
    d1.sqlite.exec(`DELETE FROM customer_visits;`);
    d1.sqlite.exec(`
      INSERT INTO customer_visits (id, customer_id, store_id, visited_at, visit_source, status, recorded_by)
      VALUES
        ('v_cross_kyoto_iso', 'c_cross', 'kyoto', '2026-04-01T23:30:00.000Z', 'reservation_completed', 'valid', 'admin_test'),
        ('v_kyoto_manual', 'c_kyoto', 'kyoto', '2026-04-02', 'manual_import', 'valid', 'admin_test'),
        ('v_cross_osaka_later', 'c_cross', 'osaka', '2026-12-31', 'manual_import', 'valid', 'admin_test');
    `);

    const { customers } = await listAllCustomers(d1 as unknown as D1Database, 200, 0, {
      storeScope: "kyoto"
    });

    expect(customers.map((customer) => customer.id)).toEqual(["c_cross", "c_kyoto"]);
    expect(customers[0]?.lastVisitAt).toBe("2026-04-01T23:30:00.000Z");
  });

  it("list without scope (owner) reports full cross-store stats", async () => {
    const { customers, total } = await listAllCustomers(d1 as unknown as D1Database);
    expect(total).toBe(4);
    const cross = customers.find((c) => c.id === "c_cross")!;
    expect(cross.visitCount).toBe(3); // 1 kyoto + 2 osaka valid visits
    expect(cross.lastVisitAt).toBe("2026-04-21");
    expect(cross.nextReservationAt).toBe("2099-01-01T10:00:00Z"); // earliest future across stores
  });
});
