import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import { executeAdminCustomerMerge } from "../src/admin/customer-merge";
import {
  createAccessJwksFetchMock,
  createAccessJwtFixture,
  grantCustomerTabGate,
  insertAdminUser,
} from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const TEAM_DOMAIN = "https://team.example.cloudflareaccess.com";
const ACCESS_AUD = "admin-customer-consents-aud";
const ADMIN_EMAIL = "consents@example.com";
const ADMIN_SUBJECT = "access-subject-admin-customer-consents";

const fixture = () =>
  createAccessJwtFixture({
    issuer: TEAM_DOMAIN,
    audience: ACCESS_AUD,
    keyId: "admin-customer-consents-key",
    claims: { email: ADMIN_EMAIL, sub: ADMIN_SUBJECT },
  });

const env = (db: SqliteD1Database): Record<string, unknown> => ({
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  ACCESS_AUD,
  DB: db,
});

const request = (db: SqliteD1Database, token: string, path: string) =>
  createApp().request(path, { headers: { "Cf-Access-Jwt-Assertion": token } }, env(db));

const seedAdmin = (db: SqliteD1Database, role: "owner" | "staff", staffMemberId: string | null = null) => {
  insertAdminUser(db, {
    id: "admin_customer_consents",
    email: ADMIN_EMAIL,
    accessSubject: ADMIN_SUBJECT,
    role,
    staffMemberId,
    updatedAt: "2026-09-12T00:00:00.000Z",
  });
  if (role === "staff") grantCustomerTabGate(db, "admin_customer_consents");
};

const seedCustomer = (db: SqliteD1Database, id: string) => {
  db.sqlite
    .prepare(
      `INSERT INTO customers (id, display_name, block_status, created_at, updated_at)
       VALUES (?, '同意 顧客', 'active', '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z')`,
    )
    .run(id);
};

const seedReservation = (
  db: SqliteD1Database,
  id: string,
  customerId: string,
  storeId: "kyoto" | "osaka",
) => {
  const suffix = storeId === "kyoto" ? "kyoto" : "osaka";
  db.sqlite
    .prepare(
      `INSERT INTO reservations (
         id, store_id, service_id, customer_id, resource_id, source, status,
         start_at, end_at, duration_minutes, idempotency_key, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'admin', 'completed',
                 '2026-09-01T01:00:00.000Z', '2026-09-01T02:00:00.000Z', 60, ?,
                 '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
    )
    .run(
      id,
      storeId,
      `service_${suffix}_default_60`,
      customerId,
      `resource_${suffix}_calendar`,
      `idem_${id}`,
    );
};

const seedConsent = (
  db: SqliteD1Database,
  id: string,
  customerId: string,
  reservationId: string | null,
  type = "notice",
  consentedAt = "2026-09-12T03:00:00.000Z",
) => {
  db.sqlite
    .prepare(
      `INSERT INTO consent_records (id, customer_id, reservation_id, consent_type, version, consented_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, customerId, reservationId, type, `version-${id}`, consentedAt);
};

afterEach(() => vi.unstubAllGlobals());

describe("admin customer ordinary consent history", () => {
  it("keeps captured consent rows intact across real multi-hop merges and pages them on the canonical customer", async () => {
    const db = createMigratedSqliteD1();
    const access = fixture();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));
    try {
      seedAdmin(db, "owner");
      for (const id of ["merge_a", "merge_b", "merge_c"]) {
        seedCustomer(db, id);
        db.sqlite.prepare("UPDATE customers SET phone_hash = 'merge_phone' WHERE id = ?").run(id);
        seedReservation(db, `reservation_${id}`, id, "kyoto");
      }
      for (let index = 0; index < 52; index += 1) {
        seedConsent(db, `consent-a-${String(index).padStart(2, "0")}`, "merge_a", "reservation_merge_a");
      }
      seedConsent(db, "consent-b", "merge_b", "reservation_merge_b");
      seedConsent(db, "consent-c", "merge_c", "reservation_merge_c");
      seedConsent(db, "consent-orphan", "merge_a", null);
      const captured = db.sqlite.prepare("SELECT * FROM consent_records ORDER BY id").all();
      const merge = (sourceId: string, targetId: string) => executeAdminCustomerMerge({
        db: db as unknown as D1Database, sourceId, targetId,
        admin: { id: "admin_customer_consents", email: ADMIN_EMAIL, role: "owner", staff_member_id: null, store_id: null }
      });
      const readPage = async (customerId: string, offset: number) => {
        const response = await request(db, access.token, `/api/admin/customers/${customerId}/consents?offset=${offset}`);
        expect(response.status).toBe(200);
        return response.json() as Promise<{ consents: Array<{ id: string }>; nextOffset: number | null }>;
      };

      expect((await merge("merge_a", "merge_b")).ok).toBe(true);
      expect((await readPage("merge_b", 0)).consents).toHaveLength(50);
      expect((await merge("merge_b", "merge_c")).ok).toBe(true);
      expect(db.sqlite.prepare("SELECT id, merged_into_id FROM customers ORDER BY id").all()).toEqual([
        { id: "merge_a", merged_into_id: "merge_b" },
        { id: "merge_b", merged_into_id: "merge_c" },
        { id: "merge_c", merged_into_id: null }
      ]);

      // A tombstone is still readable by the owner, but its history remains the
      // original directly captured records, not the canonical family's history.
      expect((await readPage("merge_b", 0)).consents.map(row => row.id)).toEqual(["consent-b"]);
      for (const role of ["owner", "staff"] as const) {
        if (role === "staff") {
          db.sqlite.exec("UPDATE admin_users SET role = 'staff', staff_member_id = 'staff_owner_kyoto' WHERE id = 'admin_customer_consents'");
          grantCustomerTabGate(db, "admin_customer_consents");
        }
        const detail = await request(db, access.token, "/api/admin/customers/merge_c");
        expect(detail.status).toBe(200);
        const body = await detail.json() as { customer: { consentHistory: Array<{ id: string }>; consentHistoryNextOffset: number | null } };
        const first = await readPage("merge_c", 0);
        expect(first.consents).toEqual(body.customer.consentHistory);
        expect(first.nextOffset).toBe(50);
        expect(body.customer.consentHistoryNextOffset).toBe(50);
        const rest = await readPage("merge_c", 50);
        expect(rest.nextOffset).toBeNull();
        const expected = captured.map(row => String(row.id)).filter(id => role === "owner" || id !== "consent-orphan").reverse();
        expect([...first.consents, ...rest.consents].map(row => row.id)).toEqual(expected);
      }
      expect((await request(db, access.token, "/api/admin/customers/merge_b/consents")).status).toBe(403);
      expect(db.sqlite.prepare("SELECT * FROM consent_records ORDER BY id").all()).toEqual(captured);
    } finally { db.sqlite.close(); }
  });

  it.each(["owner", "staff"] as const)("reads persisted merge chains for %s without admitting unrelated capture identities", async role => {
    const db = createMigratedSqliteD1();
    const access = fixture();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));
    try {
      seedAdmin(db, role, role === "staff" ? "staff_owner_kyoto" : null);
      for (const id of ["old_a", "old_b", "old_c", "unrelated", "cycle_a", "cycle_b", "dangling"]) {
        seedCustomer(db, id);
      }
      // Persisted rows from an old A -> B -> C merge, with a deleted/missing
      // destination and a disconnected cycle alongside it. Equal phone hashes
      // alone never establish the consent owner's identity.
      db.sqlite.exec(`
        UPDATE customers SET phone_hash = 'same_phone';
        UPDATE customers SET merged_into_id = 'old_b', block_status = 'blocked', archived_at = '2026-09-01T00:00:00Z' WHERE id = 'old_a';
        UPDATE customers SET merged_into_id = 'old_c', block_status = 'blocked' WHERE id = 'old_b';
        UPDATE customers SET merged_into_id = 'cycle_b', block_status = 'blocked' WHERE id = 'cycle_a';
        UPDATE customers SET merged_into_id = 'cycle_a', block_status = 'blocked' WHERE id = 'cycle_b';
        UPDATE customers SET merged_into_id = 'missing', block_status = 'blocked' WHERE id = 'dangling';
      `);
      seedReservation(db, "old_kyoto", "old_c", "kyoto");
      seedReservation(db, "old_osaka", "old_c", "osaka");
      seedReservation(db, "unrelated_kyoto", "unrelated", "kyoto");
      seedConsent(db, "direct", "old_c", "old_kyoto");
      seedConsent(db, "source", "old_a", "old_kyoto");
      seedConsent(db, "other-store", "old_b", "old_osaka");
      seedConsent(db, "orphan", "old_a", null);
      seedConsent(db, "wrong-reservation", "old_a", "unrelated_kyoto");
      seedConsent(db, "wrong-capture", "unrelated", "old_kyoto");
      seedConsent(db, "cycle-a", "cycle_a", "old_kyoto");
      seedConsent(db, "cycle-b", "cycle_b", "old_kyoto");
      seedConsent(db, "dangling", "dangling", "old_kyoto");
      const captured = db.sqlite.prepare("SELECT * FROM consent_records ORDER BY id").all();
      // Owner views retain the capture identity, including orphan records.
      // Staff additionally require the reservation's CURRENT customer and store.
      const expected = role === "staff" ? ["source", "direct"]
        : ["wrong-reservation", "source", "other-store", "orphan", "direct"];
      const detail = await request(db, access.token, "/api/admin/customers/old_c");
      expect(detail.status).toBe(200);
      const detailBody = await detail.json() as { customer: { consentHistory: Array<{ id: string }> } };
      expect(detailBody.customer.consentHistory.map(row => row.id)).toEqual(expected);
      const page = await request(db, access.token, "/api/admin/customers/old_c/consents");
      expect(page.status).toBe(200);
      const pageBody = await page.json() as { consents: Array<{ id: string }>; nextOffset: number | null };
      expect(pageBody.consents.map(row => row.id)).toEqual(expected);
      expect(pageBody.nextOffset).toBeNull();
      const cycle = await request(db, access.token, "/api/admin/customers/cycle_a/consents");
      expect(cycle.status).toBe(role === "owner" ? 200 : 403);
      if (role === "owner") {
        const cycleBody = await cycle.json() as { consents: Array<{ id: string }> };
        expect(cycleBody.consents.map(row => row.id)).toEqual(["cycle-a"]);
      }
      expect(db.sqlite.prepare("SELECT * FROM consent_records ORDER BY id").all()).toEqual(captured);
    } finally { db.sqlite.close(); }
  });

  it("returns the first 50 in stable order and pages the remainder without private fields", async () => {
    const db = createMigratedSqliteD1();
    const access = fixture();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));
    try {
      seedAdmin(db, "owner");
      seedCustomer(db, "customer_consents");
      for (let index = 0; index < 52; index += 1) {
        seedConsent(db, `consent-${String(index).padStart(2, "0")}`, "customer_consents", null);
      }

      const detail = await request(db, access.token, "/api/admin/customers/customer_consents");
      expect(detail.status).toBe(200);
      const detailBody = (await detail.json()) as {
        customer: {
          consentHistory: Array<Record<string, unknown>>;
          consentHistoryNextOffset: number | null;
        };
      };
      expect(detailBody.customer.consentHistory).toHaveLength(50);
      expect(detailBody.customer.consentHistoryNextOffset).toBe(50);
      expect(detailBody.customer.consentHistory[0]).toEqual({
        id: "consent-51",
        type: "notice",
        version: "version-consent-51",
        consentedAt: "2026-09-12T03:00:00.000Z",
      });
      expect(Object.keys(detailBody.customer.consentHistory[0]).sort()).toEqual([
        "consentedAt",
        "id",
        "type",
        "version",
      ]);

      const rest = await request(
        db,
        access.token,
        "/api/admin/customers/customer_consents/consents?offset=50",
      );
      expect(rest.status).toBe(200);
      await expect(rest.json()).resolves.toEqual({
        ok: true,
        consents: [
          {
            id: "consent-01",
            type: "notice",
            version: "version-consent-01",
            consentedAt: "2026-09-12T03:00:00.000Z",
          },
          {
            id: "consent-00",
            type: "notice",
            version: "version-consent-00",
            consentedAt: "2026-09-12T03:00:00.000Z",
          },
        ],
        nextOffset: null,
      });

      expect(
        (
          await request(
            db,
            access.token,
            "/api/admin/customers/customer_consents/consents?offset=-1",
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await request(
            db,
            access.token,
            "/api/admin/customers/customer_consents/consents?offset=abc",
          )
        ).status,
      ).toBe(400);
    } finally {
      db.sqlite.close();
    }
  });

  it("limits staff to records tied to this customer and a reservation in their store", async () => {
    const db = createMigratedSqliteD1();
    const access = fixture();
    vi.stubGlobal("fetch", createAccessJwksFetchMock(TEAM_DOMAIN, access.jwk));
    try {
      seedAdmin(db, "staff", "staff_owner_kyoto");
      seedCustomer(db, "customer_cross_store");
      seedCustomer(db, "customer_other");
      seedReservation(db, "reservation_kyoto", "customer_cross_store", "kyoto");
      seedReservation(db, "reservation_osaka", "customer_cross_store", "osaka");
      seedReservation(db, "reservation_wrong_customer", "customer_other", "kyoto");
      seedConsent(db, "consent_kyoto", "customer_cross_store", "reservation_kyoto");
      seedConsent(db, "consent_osaka", "customer_cross_store", "reservation_osaka", "privacy_policy");
      seedConsent(db, "consent_orphan", "customer_cross_store", null, "cancellation_policy");
      seedConsent(
        db,
        "consent_wrong_customer",
        "customer_cross_store",
        "reservation_wrong_customer",
        "minor_guardian",
      );

      const detail = await request(db, access.token, "/api/admin/customers/customer_cross_store");
      expect(detail.status).toBe(200);
      const body = (await detail.json()) as { customer: { consentHistory: Array<{ id: string }> } };
      expect(body.customer.consentHistory.map((entry) => entry.id)).toEqual(["consent_kyoto"]);

      const page = await request(
        db,
        access.token,
        "/api/admin/customers/customer_cross_store/consents?offset=0",
      );
      const pageBody = (await page.json()) as { consents: Array<{ id: string }> };
      expect(pageBody.consents.map((entry) => entry.id)).toEqual(["consent_kyoto"]);

      seedCustomer(db, "customer_osaka_only");
      seedReservation(db, "reservation_osaka_only", "customer_osaka_only", "osaka");
      seedConsent(db, "consent_osaka_only", "customer_osaka_only", "reservation_osaka_only");
      const forbidden = await request(
        db, access.token, "/api/admin/customers/customer_osaka_only/consents?offset=0",
      );
      expect(forbidden.status).toBe(403);
      await expect(forbidden.json()).resolves.toEqual({ ok: false, reason: "forbidden" });
    } finally {
      db.sqlite.close();
    }
  });

  it("requires an authenticated admin for the consent page", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedCustomer(db, "customer_consents");
      const response = await createApp().request(
        "/api/admin/customers/customer_consents/consents?offset=0",
        {},
        env(db),
      );
      expect(response.status).toBe(403);
    } finally {
      db.sqlite.close();
    }
  });
});
