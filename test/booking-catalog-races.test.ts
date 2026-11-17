import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAdminReservation } from "../src/admin/reservation-create";
import { softDeleteAdminResource } from "../src/admin/settings-resources";
import { softDeleteAdminService, updateAdminService } from "../src/admin/settings-services";
import { createPublicReservation, type PublicReservationRequest } from "../src/reservations/public-submit";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const admin = { id: "catalog-owner", email: "catalog@example.invalid", role: "owner", staff_member_id: null, store_id: null } as const;
const now = () => Date.parse("2026-05-09T23:00:00.000Z");
const customer = { displayName: "テスト顧客", phone: "09012345678" };
const line = { lineUserId: "catalog-line", channelId: "catalog-channel" };
const request: PublicReservationRequest = {
  idempotencyKey: "catalog-booking", storeId: "kyoto", serviceId: "service_kyoto_default_60",
  resourceId: "resource_kyoto_calendar", startAt: "2026-06-01T01:00:00.000Z",
  customer,
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
    ? createPublicReservation({ db: d1, request: { ...request, serviceIds }, line, now })
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

  it.each(["primary", "secondary", "same-total"] as const)("rejects a %s duration change after preflight without writing stale locks", async (change) => {
    const serviceIds = [request.serviceId];
    if (change !== "primary") {
      db.sqlite.exec("INSERT INTO services (id, store_id, name, duration_minutes) VALUES ('catalog-extra', 'kyoto', '追加メニュー', 5)");
      serviceIds.push("catalog-extra");
    }
    const racingDb = {
      prepare: db.prepare.bind(db),
      batch: async (statements: D1PreparedStatement[]) => {
        const durations = change === "primary" ? [90] : change === "secondary" ? [60, 30] : [55, 10];
        for (const [index, serviceId] of serviceIds.entries()) {
          const updated = await updateAdminService({
            db: db as unknown as D1Database, admin, serviceId, now,
            request: {
              storeId: "kyoto", name: "更新メニュー", durationMinutes: durations[index],
              bufferBeforeMinutes: 0, bufferAfterMinutes: 0, active: true
            }
          });
          expect(updated.ok).toBe(true);
        }
        return db.batch(statements);
      }
    } as unknown as D1Database;

    expect(await book(racingDb, serviceIds)).toEqual({ ok: false, reason: "service_not_available" });
    for (const table of ["reservations", "customers", "line_identities", "slot_locks", "customer_time_locks", "reservation_services", "idempotency_keys", "notification_jobs", "calendar_sync_jobs", "consent_records"]) {
      expect(db.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action LIKE '%reservation%'").get()).toEqual({ count: 0 });
  });

  it("replays the successful booking snapshot after the catalog duration changes", async () => {
    const created = await book(db as unknown as D1Database);
    expect(created.ok).toBe(true);
    db.sqlite.prepare("UPDATE services SET duration_minutes = 90 WHERE id = ?").run(request.serviceId);

    expect(await book(db as unknown as D1Database)).toEqual({ ...created, replayed: true });
    expect(db.sqlite.prepare("SELECT duration_minutes, end_at FROM reservations").all())
      .toEqual([{ duration_minutes: 65, end_at: "2026-06-01T02:05:00.000Z" }]);
    expect(db.sqlite.prepare("SELECT duration_minutes FROM reservation_services").all()).toEqual([{ duration_minutes: 60 }]);
    for (const table of ["slot_locks", "customer_time_locks"]) {
      expect(db.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 13 });
    }
  });

  it("returns write_failed when a same-key winner cannot be re-read after a catalog race", async () => {
    let winner: Awaited<ReturnType<typeof book>> | undefined;
    let rolledBack = false;
    let lookupFailed = false;
    let catalogRechecked = false;
    const racingDb = {
      prepare: (sql: string) => {
        if (rolledBack && !lookupFailed && sql.includes("FROM idempotency_keys")) {
          lookupFailed = true;
          throw new Error("simulated transient idempotency lookup failure");
        }
        if (rolledBack && sql.includes("FROM stores")) catalogRechecked = true;
        return db.prepare(sql);
      },
      batch: async (statements: D1PreparedStatement[]) => {
        winner = await book(db as unknown as D1Database);
        expect(winner.ok).toBe(true);
        expect(await updateAdminService({
          db: db as unknown as D1Database, admin, serviceId: request.serviceId, now,
          request: { storeId: "kyoto", name: "変更後", durationMinutes: 90, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, active: true }
        })).toMatchObject({ ok: true });
        try { return await db.batch(statements); }
        finally { rolledBack = true; }
      }
    } as unknown as D1Database;

    expect(await book(racingDb)).toEqual({ ok: false, reason: "write_failed" });
    expect(lookupFailed).toBe(true);
    expect(catalogRechecked).toBe(false);
    expect(await book(db as unknown as D1Database)).toEqual({ ...winner, replayed: true });
    expect(db.sqlite.prepare("SELECT duration_minutes, end_at FROM reservations").all())
      .toEqual([{ duration_minutes: 65, end_at: "2026-06-01T02:05:00.000Z" }]);
    for (const table of ["slot_locks", "customer_time_locks"]) {
      expect(db.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 13 });
    }
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency_keys").get()).toEqual({ count: 1 });
  });

  if (flow === "public") {
    it.each(["replay", "conflict", "other-identity", "other-channel", "expired"] as const)("resolves only the caller-owned %s after a concurrent success and duration change", async (outcome) => {
      let winner: Awaited<ReturnType<typeof createPublicReservation>> | undefined;
      const racingDb = {
        prepare: db.prepare.bind(db),
        batch: async (statements: D1PreparedStatement[]) => {
          winner = await createPublicReservation({
            db: db as unknown as D1Database, now,
            request: { ...request, customer: { ...customer, displayName: outcome === "conflict" ? "別の内容" : customer.displayName } },
            line: {
              lineUserId: outcome === "other-identity" ? "other-customer" : line.lineUserId,
              channelId: outcome === "other-channel" ? "other-channel" : line.channelId
            }
          });
          expect(winner.ok).toBe(true);
          if (outcome === "expired") {
            db.sqlite.prepare("UPDATE idempotency_keys SET expires_at = ? WHERE scope = 'public_submit'")
              .run(new Date(now()).toISOString());
          }
          expect(await updateAdminService({
            db: db as unknown as D1Database, admin, serviceId: request.serviceId, now,
            request: { storeId: "kyoto", name: "変更後", durationMinutes: 90, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, active: true }
          })).toMatchObject({ ok: true });
          return db.batch(statements);
        }
      } as unknown as D1Database;

      expect(await book(racingDb)).toEqual(outcome === "replay" ? { ...winner, replayed: true }
        : { ok: false, reason: outcome === "conflict" ? "idempotency_conflict" : "service_not_available" });
      expect(db.sqlite.prepare("SELECT duration_minutes, end_at FROM reservations").all())
        .toEqual([{ duration_minutes: 65, end_at: "2026-06-01T02:05:00.000Z" }]);
      expect(db.sqlite.prepare("SELECT duration_minutes FROM reservation_services").all()).toEqual([{ duration_minutes: 60 }]);
      for (const table of ["slot_locks", "customer_time_locks"]) {
        expect(db.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 13 });
      }
      expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency_keys").get()).toEqual({ count: 1 });
    });

    it.each(["idempotency", "catalog"] as const)("returns write_failed when the %s re-read fails after rollback", async (failedRead) => {
      let rolledBack = false;
      const racingDb = {
        prepare: (sql: string) => {
          if (rolledBack && (failedRead === "idempotency" ? sql.includes("scope = 'public_submit'") : sql.includes("FROM stores"))) {
            throw new Error("simulated post-rollback lookup failure");
          }
          return db.prepare(sql);
        },
        batch: async (statements: D1PreparedStatement[]) => {
          db.sqlite.prepare("UPDATE services SET duration_minutes = 90 WHERE id = ?").run(request.serviceId);
          try { return await db.batch(statements); }
          finally { rolledBack = true; }
        }
      } as unknown as D1Database;

      expect(await book(racingDb)).toEqual({ ok: false, reason: "write_failed" });
      expect(rolledBack).toBe(true);
      for (const table of ["reservations", "customers", "line_identities", "slot_locks", "customer_time_locks", "reservation_services", "idempotency_keys", "notification_jobs", "calendar_sync_jobs", "consent_records"]) {
        expect(db.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
      }
    });
  }

  if (flow === "admin") {
    it.each([
      { outcome: "replay", change: "duration" },
      { outcome: "conflict", change: "duration" },
      { outcome: "revoked", change: "duration" },
      { outcome: "replay", change: "disabled" },
      { outcome: "conflict", change: "disabled" }
    ] as const)("preserves $outcome precedence over a $change change after a concurrent success", async ({ outcome, change }) => {
      let winner: Awaited<ReturnType<typeof createAdminReservation>> | undefined;
      const racingDb = {
        prepare: db.prepare.bind(db),
        batch: async (statements: D1PreparedStatement[]) => {
          winner = await createAdminReservation({
            db: db as unknown as D1Database, admin, now,
            request: {
              idempotencyKey: request.idempotencyKey, source: "admin", storeId: request.storeId,
              serviceIds: [request.serviceId], resourceId: request.resourceId, startAt: request.startAt,
              customer: { ...customer, displayName: outcome === "conflict" ? "別の内容" : customer.displayName }
            }
          });
          expect(winner.ok).toBe(true);
          if (change === "disabled") {
            db.sqlite.prepare("UPDATE services SET active = 0 WHERE id = ?").run(request.serviceId);
          } else {
            expect(await updateAdminService({
              db: db as unknown as D1Database, admin, serviceId: request.serviceId, now,
              request: { storeId: "kyoto", name: "変更後", durationMinutes: 90, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, active: true }
            })).toMatchObject({ ok: true });
          }
          if (outcome === "revoked") db.sqlite.prepare("UPDATE admin_users SET active = 0 WHERE id = ?").run(admin.id);
          return db.batch(statements);
        }
      } as unknown as D1Database;

      const result = await book(racingDb);

      expect(result).toEqual(outcome === "replay" ? { ...winner, replayed: true }
        : { ok: false, reason: outcome === "conflict" ? "idempotency_conflict" : "forbidden" });
      expect(db.sqlite.prepare("SELECT duration_minutes, end_at FROM reservations").all())
        .toEqual([{ duration_minutes: 65, end_at: "2026-06-01T02:05:00.000Z" }]);
      for (const table of ["slot_locks", "customer_time_locks"]) {
        expect(db.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 13 });
      }
      expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency_keys").get()).toEqual({ count: 1 });
    });
  }
});
