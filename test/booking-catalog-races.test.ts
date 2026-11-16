import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAdminReservation } from "../src/admin/reservation-create";
import { softDeleteAdminResource } from "../src/admin/settings-resources";
import { softDeleteAdminService } from "../src/admin/settings-services";
import { createPublicReservation, type PublicReservationRequest } from "../src/reservations/public-submit";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const admin = { id: "catalog-owner", email: "catalog@example.invalid", role: "owner", staff_member_id: null, store_id: null } as const;
const now = () => Date.parse("2026-05-09T23:00:00.000Z");
const request: PublicReservationRequest = {
  idempotencyKey: "catalog-booking", storeId: "kyoto", serviceId: "service_kyoto_default_60",
  resourceId: "resource_kyoto_calendar", startAt: "2026-06-01T01:00:00.000Z",
  customer: { displayName: "テスト顧客", phone: "09012345678" },
  consents: { noticeVersion: "notice-terms-2026-06", cancellationPolicyVersion: "cancel-2026-08-31", privacyPolicyVersion: "privacy-2026-06" }
};

describe.each(["public", "admin"] as const)("%s booking catalog write boundary", (flow) => {
  let db: SqliteD1Database;
  beforeEach(() => {
    db = createMigratedSqliteD1();
    db.sqlite.prepare("INSERT INTO admin_users (id, email, access_subject, role) VALUES (?, ?, 'catalog-subject', 'owner')")
      .run(admin.id, admin.email);
  });
  afterEach(() => db.sqlite.close());

  const book = (d1: D1Database, serviceIds = [request.serviceId]) => flow === "public"
    ? createPublicReservation({ db: d1, request: { ...request, serviceIds }, line: { lineUserId: "catalog-line", channelId: "catalog-channel" }, now })
    : createAdminReservation({
      db: d1, admin, now,
      request: {
        idempotencyKey: request.idempotencyKey, source: "admin", storeId: request.storeId,
        serviceIds, resourceId: request.resourceId, startAt: request.startAt,
        customer: request.customer
      }
    });

  it.each(["service", "secondary-service", "resource"] as const)("rejects a %s disabled after its availability read", async (target) => {
    const serviceIds = [request.serviceId];
    if (target === "secondary-service") {
      db.sqlite.exec("INSERT INTO services (id, store_id, name, duration_minutes) VALUES ('catalog-extra', 'kyoto', '追加メニュー', 5)");
      serviceIds.push("catalog-extra");
    }
    const racingDb = new Proxy(db, {
      get(database, prop, receiver) {
        if (prop === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            const input = { db: database as unknown as D1Database, admin, now };
            const disabled = target === "resource"
              ? await softDeleteAdminResource({ ...input, resourceId: request.resourceId })
              : await softDeleteAdminService({ ...input, serviceId: serviceIds.at(-1)! });
            expect(disabled.ok).toBe(true);
            return database.batch(statements);
          };
        }
        return Reflect.get(database, prop, receiver);
      }
    }) as unknown as D1Database;

    const result = await book(racingDb, serviceIds);

    expect(result).toEqual({ ok: false, reason: target === "resource" ? "store_not_found" : "service_not_available" });
    for (const table of ["reservations", "customers", "line_identities", "slot_locks", "customer_time_locks", "reservation_services", "idempotency_keys", "notification_jobs", "calendar_sync_jobs", "consent_records"]) {
      expect(db.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action LIKE '%reservation%'").get()).toEqual({ count: 0 });
  });

  it("still creates a reservation with the active catalog", async () => {
    const result = await book(db as unknown as D1Database);

    expect(result.ok).toBe(true);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM reservations").get()).toEqual({ count: 1 });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM slot_locks").get()).toEqual({ count: 13 });
  });
});
