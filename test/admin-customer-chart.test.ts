import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import type { AdminCustomerDetail } from "../src/admin/operations";
import { createAccessJwtFixture, createAccessJwksFetchMock, grantCustomerTabGate, insertAdminUser } from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const team = "https://chart.example.cloudflareaccess.com";
const audience = "customer-chart";
const access = createAccessJwtFixture({ issuer: team, audience, keyId: "chart", claims: { email: "chart@example.com", sub: "chart" } });

describe("customer chart HTTP contract", () => {
  let db: SqliteD1Database;
  beforeEach(() => {
    db = createMigratedSqliteD1();
    insertAdminUser(db, { id: "chart_admin", email: "chart@example.com", accessSubject: "chart", role: "owner" });
    db.sqlite.exec(`INSERT INTO customers (id, display_name, block_status, created_store_id) VALUES ('chart_customer', 'カルテ 太郎', 'active', 'kyoto');`);
    vi.stubGlobal("fetch", createAccessJwksFetchMock(team, access.jwk));
  });
  afterEach(() => { db.sqlite.close(); vi.unstubAllGlobals(); });

  const request = (suffix = "", method = "GET", body?: unknown, binding: D1Database = db as unknown as D1Database) =>
    createApp().request(`/api/admin/customers/chart_customer${suffix}`, {
      method, headers: { "Cf-Access-Jwt-Assertion": access.token, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    }, { DB: binding, ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: audience });
  const detail = async () => {
    const response = await request();
    expect(response.status).toBe(200);
    return (await response.json() as { customer: AdminCustomerDetail }).customer;
  };
  const reservation = (id: string, startAt: string, storeId = "kyoto", status = "completed", customerId = "chart_customer") => {
    db.sqlite.prepare(`INSERT INTO reservations (id, store_id, service_id, customer_id, resource_id, source, status, duration_minutes, idempotency_key, start_at, end_at)
      VALUES (?, ?, ?, ?, ?, 'admin', ?, 60, ?, ?, ?)`)
      .run(id, storeId, `service_${storeId}_default_60`, customerId, `resource_${storeId}_calendar`, status, id, startAt, new Date(Date.parse(startAt) + 3_600_000).toISOString());
  };
  const seedVisit = () => db.sqlite.exec(`INSERT INTO customer_visits (id, customer_id, store_id, visited_at, visit_source, status, recorded_by)
    VALUES ('chart_visit', 'chart_customer', 'kyoto', '2026-01-01', 'manual_import', 'valid', 'chart_admin');`);
  const beforeWrite = (sql: string): D1Database => ({
    prepare: (query: string) => db.prepare(query),
    batch: async (statements: D1PreparedStatement[]) => { db.sqlite.exec(sql); return db.batch(statements); }
  }) as unknown as D1Database;
  const mutations = [
    { suffix: "/referrer", body: { referrerName: "新しい記録", expectedReferrerName: null }, table: "customers", column: "referrer_name", id: "chart_customer" },
    { suffix: "/memo", body: { memo: "新しい記録", expectedMemo: null }, table: "customers", column: "memo", id: "chart_customer" },
    { suffix: "/visits/chart_visit/notes", body: { treatmentNotes: "新しい記録", expectedTreatmentNotes: null }, table: "customer_visits", column: "treatment_notes", id: "chart_visit" }
  ];

  it("saves an unregistered referrer's name and shows it on the customer chart", async () => {
    const response = await request("/referrer", "PUT", { referrerName: "  紹介 花子  ", expectedReferrerName: null });
    expect(response.status).toBe(200);
    expect((await detail()).referrerName).toBe("紹介 花子");
  });

  it("clears a referrer, rejects stale edits and leaves no success audit on conflict", async () => {
    await request("/referrer", "PUT", { referrerName: "紹介者", expectedReferrerName: null });
    const conflict = await request("/referrer", "PUT", { referrerName: "古い画面", expectedReferrerName: null });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ ok: false, reason: "stale_snapshot" });
    expect((await detail()).referrerName).toBe("紹介者");
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'customer.referrer_update'").get()).toEqual({ n: 1 });
    expect((await request("/referrer", "PUT", { referrerName: "　 ", expectedReferrerName: "紹介者" })).status).toBe(200);
    expect((await detail()).referrerName).toBeNull();
  });

  it.each([
    {}, { referrerName: "名前" }, { expectedReferrerName: null },
    { referrerName: 1, expectedReferrerName: null }, { referrerName: null, expectedReferrerName: [] },
    { referrerName: "長".repeat(121), expectedReferrerName: null }
  ])("rejects invalid referrer input without writing: %j", async (body) => {
    expect((await request("/referrer", "PUT", body)).status).toBe(400);
    expect((await detail()).referrerName).toBeNull();
  });

  it("requires Access authentication and the staff owner grant", async () => {
    expect((await createApp().request("/api/admin/customers/chart_customer/referrer", { method: "PUT", body: "{}" }, { DB: db, ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: audience })).status).toBe(403);
    db.sqlite.exec("UPDATE admin_users SET role = 'staff', staff_member_id = 'staff_owner_kyoto' WHERE id = 'chart_admin'");
    const blocked = await request("/referrer", "PUT", { referrerName: "紹介者", expectedReferrerName: null });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toEqual({ ok: false, reason: "customer_gate_required" });
    grantCustomerTabGate(db, "chart_admin");
    expect((await request("/referrer", "PUT", { referrerName: "紹介者", expectedReferrerName: null })).status).toBe(200);
    db.sqlite.exec("UPDATE customers SET created_store_id = 'osaka' WHERE id = 'chart_customer'");
    expect((await request("/referrer", "PUT", { referrerName: "他店", expectedReferrerName: "紹介者" })).status).toBe(403);
  });

  it.each(["archived_at = '2026-01-01'", "merged_into_id = 'customer_seed_existing'"])("does not edit inactive customers: %s", async (change) => {
    // A separate canonical target avoids depending on development seed identities.
    db.sqlite.exec("INSERT INTO customers (id, display_name) VALUES ('customer_seed_existing', '統合先')");
    db.sqlite.exec(`UPDATE customers SET ${change} WHERE id = 'chart_customer'`);
    expect((await request("/referrer", "PUT", { referrerName: "紹介者", expectedReferrerName: null })).status).toBe(404);
    expect(db.sqlite.prepare("SELECT referrer_name FROM customers WHERE id = 'chart_customer'").get()).toEqual({ referrer_name: null });
  });

  it("carries a referrer into a blank merge target without erasing legacy referral notes", async () => {
    db.sqlite.exec(`UPDATE customers SET phone_hash = 'same' WHERE id = 'chart_customer';
      INSERT INTO customers (id, display_name, phone_hash) VALUES ('chart_target', '統合先', 'same');
      INSERT INTO referral_notes (id, customer_id, note, created_by) VALUES ('legacy_referral', 'chart_customer', '昔の自由文', 'chart_admin');`);
    await request("/referrer", "PUT", { referrerName: "紹介 花子", expectedReferrerName: null });
    expect((await request("/merge", "POST", { targetId: "chart_target" })).status).toBe(200);
    const response = await createApp().request("/api/admin/customers/chart_target", { headers: { "Cf-Access-Jwt-Assertion": access.token } }, { DB: db, ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: audience });
    expect((await response.json() as { customer: AdminCustomerDetail }).customer.referrerName).toBe("紹介 花子");
    expect(db.sqlite.prepare("SELECT note FROM referral_notes WHERE id = 'legacy_referral'").get()).toEqual({ note: "昔の自由文" });
  });

  it("rejects a stale customer memo and preserves the winner without a success audit", async () => {
    expect((await request("/memo", "PUT", { memo: "先の記録", expectedMemo: null })).status).toBe(200);
    const stale = await request("/memo", "PUT", { memo: "上書き", expectedMemo: null });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ ok: false, reason: "stale_snapshot" });
    expect((await detail()).memo).toBe("先の記録");
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'customer.memo_update'").get()).toEqual({ n: 1 });
  });

  it("rejects stale visit notes through the same HTTP endpoint used by both editors", async () => {
    seedVisit();
    expect((await request("/visits/chart_visit/notes", "PUT", { treatmentNotes: "今回の記録", expectedTreatmentNotes: null })).status).toBe(200);
    const stale = await request("/visits/chart_visit/notes", "PUT", { treatmentNotes: "古い画面", expectedTreatmentNotes: null });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ ok: false, reason: "stale_snapshot" });
    expect((await detail()).visits[0].treatmentNotes).toBe("今回の記録");
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'customer.visit_notes_update'").get()).toEqual({ n: 1 });
  });

  it("shows visit menus with their provenance and customer-wide last visit and next booking", async () => {
    reservation("chart_reserved", "2026-01-01T01:00:00.000Z");
    db.sqlite.exec(`INSERT INTO reservation_services (reservation_id, service_id, display_order, name_snapshot, duration_minutes)
      VALUES ('chart_reserved', 'service_kyoto_default_60', 0, '当時のメニュー', 60);
      UPDATE services SET name = '現在のメニュー' WHERE id = 'service_kyoto_default_60';
      INSERT INTO customer_visits (id, customer_id, reservation_id, store_id, visited_at, visit_source, status, recorded_by) VALUES
        ('chart_visit', 'chart_customer', 'chart_reserved', 'kyoto', '2026-01-01', 'reservation_completed', 'valid', 'chart_admin'),
        ('chart_manual', 'chart_customer', NULL, 'kyoto', '2026-01-02', 'manual_import', 'valid', 'chart_admin');
      INSERT INTO customer_visits (id, customer_id, store_id, visited_at, visit_source, status, recorded_by, voided_by, voided_at, void_reason)
        VALUES ('chart_voided', 'chart_customer', 'kyoto', '2026-01-03', 'manual_import', 'voided', 'chart_admin', 'chart_admin', '2026-01-04', '訂正');`);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    reservation("chart_future", future, "kyoto", "confirmed");
    const customer = await detail();
    expect(customer.visits.find(v => v.id === "chart_visit")).toMatchObject({ storeName: "ExampleStore A", serviceName: "当時のメニュー", serviceNameSource: "snapshot" });
    expect(customer.visits.find(v => v.id === "chart_manual")).toMatchObject({ serviceName: null, serviceNameSource: "unrecorded" });
    expect(customer.reservations.find(r => r.id === "chart_future")).toMatchObject({ serviceName: "現在のメニュー", serviceNameSource: "current" });
    expect(customer.lastVisitAt).toBe("2026-01-02");
    expect(customer.nextReservation?.id).toBe("chart_future");
  });

  it("loads bookings after the first 50 in a deterministic order", async () => {
    for (let i = 0; i < 61; i++) reservation(`chart_${String(i).padStart(3, "0")}`, "2026-01-01T01:00:00.000Z");
    const response = await request("/reservations?offset=50");
    expect(response.status).toBe(200);
    const page = await response.json() as { reservations: Array<{ id: string }>; nextOffset: number | null };
    expect(page.reservations.map(r => r.id)).toEqual(Array.from({ length: 11 }, (_, i) => `chart_${String(10 - i).padStart(3, "0")}`));
    expect(page.nextOffset).toBeNull();
    const customer = await detail();
    expect(customer.reservationsNextOffset).toBe(50);
    expect(customer.reservations[0].id).toBe("chart_060");
  });

  it.each([
    ["2026-09-29 15:05:06", "2026-09-29T15:05:06.000Z"],
    ["2026-09-30T00:05:06.123+09:00", "2026-09-29T15:05:06.123Z"],
    ["unrecorded", null],
  ])("returns booking provenance with a normalized registration time: %s", async (stored, expected) => {
    reservation("chart_provenance", "2026-10-01T01:00:00.000Z", "kyoto", "confirmed");
    reservation("chart_other_store", "2026-10-02T01:00:00.000Z", "osaka", "confirmed");
    db.sqlite.prepare("UPDATE reservations SET source = 'phone_admin', reservation_origin = 'minimo', created_at = ? WHERE id = 'chart_provenance'").run(stored);
    db.sqlite.exec("UPDATE admin_users SET role = 'staff', staff_member_id = 'staff_owner_kyoto' WHERE id = 'chart_admin'");
    grantCustomerTabGate(db, "chart_admin");
    const expectedBooking = { id: "chart_provenance", source: "phone_admin", reservationOrigin: "minimo", createdAt: expected };
    expect((await detail()).reservations).toEqual([expect.objectContaining(expectedBooking)]);
    const response = await request("/reservations?offset=0");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ reservations: [expectedBooking], nextOffset: null });
  });

  it.each(mutations)("checks the expectation at write time: $suffix", async (mutation) => {
    seedVisit();
    const response = await request(mutation.suffix, "PUT", mutation.body,
      beforeWrite(`UPDATE ${mutation.table} SET ${mutation.column} = '並行更新' WHERE id = '${mutation.id}'`));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, reason: "stale_snapshot" });
    expect(db.sqlite.prepare(`SELECT ${mutation.column} AS value FROM ${mutation.table} WHERE id = ?`).get(mutation.id)).toEqual({ value: "並行更新" });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action LIKE 'customer.%'").get()).toEqual({ n: 0 });
  });

  it.each(mutations.flatMap(mutation => [
    { ...mutation, revoked: "active", sql: "UPDATE admin_users SET active = 0 WHERE id = 'chart_admin'" },
    { ...mutation, revoked: "role", sql: "UPDATE admin_users SET role = 'owner' WHERE id = 'chart_admin'" },
    { ...mutation, revoked: "store", sql: "UPDATE staff_members SET store_id = 'osaka' WHERE id = 'staff_owner_kyoto'" }
  ]))("rolls back when $revoked is revoked before $suffix writes", async (mutation) => {
    seedVisit();
    db.sqlite.exec("UPDATE admin_users SET role = 'staff', staff_member_id = 'staff_owner_kyoto' WHERE id = 'chart_admin'");
    grantCustomerTabGate(db, "chart_admin");
    const response = await request(mutation.suffix, "PUT", mutation.body, beforeWrite(mutation.sql));
    expect(response.status).toBe(403);
    expect(db.sqlite.prepare(`SELECT ${mutation.column} AS value FROM ${mutation.table} WHERE id = ?`).get(mutation.id)).toEqual({ value: null });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action LIKE 'customer.%'").get()).toEqual({ n: 0 });
  });

  it.each(mutations.flatMap(mutation => [
    { ...mutation, state: "archive", sql: "UPDATE customers SET archived_at = '2026-01-02' WHERE id = 'chart_customer'" },
    { ...mutation, state: "merge", sql: "UPDATE customers SET merged_into_id = 'chart_target' WHERE id = 'chart_customer'" }
  ]))("does not edit a customer whose $state changed before $suffix writes", async (mutation) => {
    seedVisit();
    db.sqlite.exec("INSERT INTO customers (id, display_name) VALUES ('chart_target', '統合先')");
    const response = await request(mutation.suffix, "PUT", mutation.body, beforeWrite(mutation.sql));
    expect(response.status).toBe(404);
    expect(db.sqlite.prepare(`SELECT ${mutation.column} AS value FROM ${mutation.table} WHERE id = ?`).get(mutation.id)).toEqual({ value: null });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action LIKE 'customer.%'").get()).toEqual({ n: 0 });
  });

  it("keeps old memo clients compatible while comparing new expectations exactly", async () => {
    seedVisit();
    db.sqlite.exec("UPDATE customers SET memo = '  元のメモ  ' WHERE id = 'chart_customer'");
    expect((await request("/memo", "PUT", { memo: " 更新 ", expectedMemo: "  元のメモ  " })).status).toBe(200);
    expect((await request("/memo", "PUT", { memo: null })).status).toBe(200);
    expect((await detail()).memo).toBeNull();
    expect((await request("/visits/chart_visit/notes", "PUT", { treatmentNotes: "旧UI" })).status).toBe(200);
    expect((await request("/visits/chart_visit/notes", "PUT", { treatmentNotes: null, expectedTreatmentNotes: "旧UI" })).status).toBe(200);
    expect((await detail()).visits[0].treatmentNotes).toBeNull();
  });

  it.each([
    { suffix: "/memo", body: { memo: "記録", expectedMemo: 1 } },
    { suffix: "/visits/chart_visit/notes", body: { treatmentNotes: "記録", expectedTreatmentNotes: [] } }
  ])("rejects malformed expectations: $suffix", async ({ suffix, body }) => {
    seedVisit();
    expect((await request(suffix, "PUT", body)).status).toBe(400);
  });

  it("preserves a populated merge target and deletes the customer with its new column", async () => {
    db.sqlite.exec(`UPDATE customers SET phone_hash = 'same', referrer_name = '統合元の紹介者' WHERE id = 'chart_customer';
      INSERT INTO customers (id, display_name, phone_hash, referrer_name) VALUES ('chart_target', '統合先', 'same', '統合先の紹介者');`);
    expect((await request("/merge", "POST", { targetId: "chart_target" })).status).toBe(200);
    expect(db.sqlite.prepare("SELECT referrer_name FROM customers WHERE id = 'chart_target'").get()).toEqual({ referrer_name: "統合先の紹介者" });
    expect(db.sqlite.prepare("SELECT referrer_name FROM customers WHERE id = 'chart_customer'").get()).toEqual({ referrer_name: "統合元の紹介者" });
    expect((await request("/delete", "POST", {})).status).toBe(200);
    expect((await request()).status).toBe(404);
    expect(db.sqlite.prepare("SELECT referrer_name FROM customers WHERE id = 'chart_target'").get()).toEqual({ referrer_name: "統合先の紹介者" });
  });

  it("scopes summaries and pagination before the 50-row limit and keeps archived history readable", async () => {
    for (let i = 0; i < 60; i++) {
      reservation(`chart_k_${i}`, "2026-01-01T01:00:00.000Z");
      reservation(`chart_o_${i}`, "2026-02-01T01:00:00.000Z", "osaka");
    }
    const nearest = new Date(Date.now() + 86_400_000).toISOString();
    reservation("chart_near", nearest, "kyoto", "pending_approval");
    reservation("chart_other_near", new Date(Date.now() + 43_200_000).toISOString(), "osaka", "confirmed");
    seedVisit();
    db.sqlite.exec(`INSERT INTO customer_visits (id, customer_id, store_id, visited_at, visit_source, status, recorded_by)
      VALUES ('other_visit', 'chart_customer', 'osaka', '2026-03-01', 'manual_import', 'valid', 'chart_admin');
      UPDATE admin_users SET role = 'staff', staff_member_id = 'staff_owner_kyoto' WHERE id = 'chart_admin';
      UPDATE customers SET archived_at = '2026-04-01' WHERE id = 'chart_customer';`);
    expect((await request("/reservations?offset=50")).status).toBe(403);
    grantCustomerTabGate(db, "chart_admin");
    const customer = await detail();
    expect(customer.reservations).toHaveLength(50);
    expect(customer.reservations.every(r => r.storeId === "kyoto")).toBe(true);
    expect(customer.lastVisitAt).toBe("2026-01-01");
    expect(customer.nextReservation?.id).toBe("chart_near");
    const response = await request("/reservations?offset=50");
    expect(response.status).toBe(200);
    const page = await response.json() as { reservations: Array<{ storeId: string }> };
    expect(page.reservations).toHaveLength(11);
    expect(page.reservations.every(r => r.storeId === "kyoto")).toBe(true);
  });

  it.each(["-1", "1.5", "NaN", "9007199254740992", "Infinity"])("rejects invalid history offset %s", async (offset) => {
    expect((await request(`/reservations?offset=${offset}`)).status).toBe(400);
  });

  it("does not join a mismatched reservation's menu into the customer's visit", async () => {
    db.sqlite.exec("INSERT INTO customers (id, display_name) VALUES ('chart_other', '別顧客')");
    reservation("wrong_customer", "2026-01-01T01:00:00.000Z", "kyoto", "completed", "chart_other");
    reservation("wrong_store", "2026-01-02T01:00:00.000Z", "osaka");
    db.sqlite.exec(`INSERT INTO customer_visits (id, customer_id, reservation_id, store_id, visited_at, visit_source, status, recorded_by) VALUES
      ('visit_wrong_customer', 'chart_customer', 'wrong_customer', 'kyoto', '2026-01-01', 'reservation_completed', 'valid', 'chart_admin'),
      ('visit_wrong_store', 'chart_customer', 'wrong_store', 'kyoto', '2026-01-02', 'reservation_completed', 'valid', 'chart_admin');`);
    const customer = await detail();
    expect(customer.visits).toHaveLength(2);
    expect(customer.visits.every(v => v.serviceName === null && v.serviceNameSource === "unrecorded")).toBe(true);
    expect(customer.visits.every(v => v.reservationId === null)).toBe(true);
  });

  it("computes summaries from records outside both initial history pages", async () => {
    const near = new Date(Date.now() + 86_400_000).toISOString();
    reservation("chart_nearest", near, "kyoto", "confirmed");
    for (let i = 0; i < 60; i++) {
      reservation(`chart_later_${i}`, new Date(Date.now() + (i + 2) * 86_400_000).toISOString(), "kyoto", "confirmed");
      db.sqlite.prepare(`INSERT INTO customer_visits (id, customer_id, store_id, visited_at, visit_source, status, recorded_by, voided_by, voided_at, void_reason)
        VALUES (?, 'chart_customer', 'kyoto', '2026-02-01', 'manual_import', 'voided', 'chart_admin', 'chart_admin', '2026-02-02', '訂正')`).run(`chart_void_${i}`);
    }
    seedVisit();
    const customer = await detail();
    expect(customer.reservations.some(r => r.id === "chart_nearest")).toBe(false);
    expect(customer.visits.some(v => v.id === "chart_visit")).toBe(false);
    expect(customer.nextReservation?.id).toBe("chart_nearest");
    expect(customer.lastVisitAt).toBe("2026-01-01");
    expect(customer.validVisitCount).toBe(1);
    const response = await request("/visits?offset=50");
    expect(response.status).toBe(200);
    const page = await response.json() as { visits: AdminCustomerDetail["visits"] };
    expect(page.visits.find(v => v.id === "chart_visit")).toMatchObject({ storeName: "ExampleStore A", serviceNameSource: "unrecorded" });
  });

  it("keeps every historical menu in display order after master names change", async () => {
    reservation("chart_multi", "2026-01-01T01:00:00.000Z");
    db.sqlite.exec(`INSERT INTO services (id, store_id, name, duration_minutes) VALUES ('chart_service', 'kyoto', '変更後の追加メニュー', 15);
      INSERT INTO reservation_services (reservation_id, service_id, display_order, name_snapshot, duration_minutes) VALUES
        ('chart_multi', 'service_kyoto_default_60', 1, '当時の全身', 45),
        ('chart_multi', 'chart_service', 0, '当時の追加メニュー', 15);
      INSERT INTO customer_visits (id, customer_id, reservation_id, store_id, visited_at, visit_source, status, recorded_by)
        VALUES ('chart_visit', 'chart_customer', 'chart_multi', 'kyoto', '2026-01-01', 'reservation_completed', 'valid', 'chart_admin');`);
    const customer = await detail();
    expect(customer.visits[0]).toMatchObject({ serviceName: "当時の追加メニュー / 当時の全身", serviceNameSource: "snapshot", reservationId: "chart_multi" });
    expect(customer.reservations[0]).toMatchObject({ serviceName: "当時の追加メニュー / 当時の全身", serviceNameSource: "snapshot" });
  });
});
