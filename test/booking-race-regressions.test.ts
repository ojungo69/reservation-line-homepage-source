import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdminUser } from "../src/admin/access";
import { createAdminExternalBlock } from "../src/admin/external-blocks";
import { runAdminReservationAction } from "../src/admin/reservations";
import { createPublicReservation, getUpcomingReservations, type PublicReservationRequest } from "../src/reservations/public-submit";
import { listMyReservations } from "../src/reservations/my-reservations";
import { createMigratedSqliteD1 } from "./helpers/sqlite-d1";

const line = { lineUserId: "race_line_user", channelId: "race_channel" };
const owner: AdminUser = {
  id: "race_owner", email: "race@example.invalid", role: "owner", staff_member_id: null, store_id: null
};
const bookingTime = Date.parse("2026-05-09T23:00:00.000Z");
const request: PublicReservationRequest = {
  idempotencyKey: "race_public", storeId: "kyoto", serviceId: "service_kyoto_default_60",
  resourceId: "resource_kyoto_calendar", startAt: "2026-06-01T01:00:00.000Z",
  customer: { displayName: "競合確認", phone: "09012345678" },
  consents: {
    noticeVersion: "notice-terms-2026-06", cancellationPolicyVersion: "cancel-2026-08-31",
    privacyPolicyVersion: "privacy-2026-06"
  }
};

describe("booking write boundaries", () => {
  let db: ReturnType<typeof createMigratedSqliteD1>;
  let d1: D1Database;
  beforeEach(() => {
    db = createMigratedSqliteD1();
    d1 = db as unknown as D1Database;
    db.sqlite.prepare("INSERT INTO admin_users(id,email,access_subject,role) VALUES(?,?,?,?)")
      .run(owner.id, owner.email, "race_subject", owner.role);
  });
  afterEach(() => db.sqlite.close());

  it("does not approve when the LINE check crosses expiry and a block takes the slots", async () => {
    const created = await createPublicReservation({ db: d1, request, line, now: () => bookingTime });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.reason);
    const expiry = bookingTime + 24 * 60 * 60 * 1000;
    let nowMs = expiry - 1;
    const result = await runAdminReservationAction({
      db: d1, env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "fixture-token" }, admin: owner,
      reservationId: created.reservationId, action: "approve",
      request: { idempotencyKey: "race_approve" }, now: () => nowMs,
      fetcher: async () => {
        nowMs = expiry + 1;
        const block = await createAdminExternalBlock({
          db: d1, admin: owner,
          request: {
            idempotencyKey: "race_block", storeId: request.storeId, resourceId: request.resourceId,
            startAt: created.startAt, endAt: created.endAt
          },
          now: () => nowMs
        });
        expect(block.ok).toBe(true);
        return Response.json({ userId: line.lineUserId });
      }
    });
    expect(result).toEqual({ ok: false, reason: "invalid_transition" });
    expect(db.sqlite.prepare("SELECT status FROM reservations WHERE id=?").get(created.reservationId))
      .toMatchObject({ status: "pending_approval" });
    expect(db.sqlite.prepare("SELECT COUNT(*) n FROM notification_jobs WHERE template_key='reservation_confirmed'").get())
      .toMatchObject({ n: 0 });
    expect(db.sqlite.prepare("SELECT COUNT(*) n FROM idempotency_keys WHERE idempotency_key='race_approve'").get())
      .toMatchObject({ n: 0 });
  });

  it.each(["slot_locks", "customer_time_locks"])(
    "rolls back approval when a %s hold disappears after the final precheck", async (table) => {
      const created = await createPublicReservation({ db: d1, request, line, now: () => bookingTime });
      if (!created.ok) throw new Error(created.reason);
      const originalBatch = db.batch.bind(db);
      db.batch = async (statements) => {
        db.sqlite.prepare(`DELETE FROM ${table} WHERE owner_id=? AND slot_at=?`)
          .run(created.reservationId, created.startAt);
        return originalBatch(statements);
      };
      const result = await runAdminReservationAction({
        db: d1, env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "fixture-token" }, admin: owner,
        reservationId: created.reservationId, action: "approve",
        request: { idempotencyKey: "race_approve" }, now: () => bookingTime + 1,
        fetcher: async () => Response.json({ userId: line.lineUserId })
      });
      expect(result.ok).toBe(false);
      expect(db.sqlite.prepare("SELECT status,version FROM reservations WHERE id=?").get(created.reservationId))
        .toMatchObject({ status: "pending_approval", version: 1 });
      expect(db.sqlite.prepare("SELECT COUNT(*) n FROM notification_jobs WHERE template_key='reservation_confirmed'").get())
        .toMatchObject({ n: 0 });
      expect(db.sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='admin_reservation_approved'").get())
        .toMatchObject({ n: 0 });
      expect(db.sqlite.prepare("SELECT COUNT(*) n FROM idempotency_keys WHERE idempotency_key='race_approve'").get())
        .toMatchObject({ n: 0 });
    }
  );

  it("stamps successful approval from the fresh time after the LINE check", async () => {
    const created = await createPublicReservation({ db: d1, request, line, now: () => bookingTime });
    if (!created.ok) throw new Error(created.reason);
    let nowMs = bookingTime + 1000;
    const result = await runAdminReservationAction({
      db: d1, env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "fixture-token" }, admin: owner,
      reservationId: created.reservationId, action: "approve",
      request: { idempotencyKey: "fresh_approve" }, now: () => nowMs,
      fetcher: async () => {
        nowMs = bookingTime + 3000;
        return Response.json({ userId: line.lineUserId });
      }
    });
    expect(result).toMatchObject({ ok: true, status: "confirmed", version: 2 });
    expect(db.sqlite.prepare("SELECT updated_at FROM reservations WHERE id=?").get(created.reservationId))
      .toEqual({ updated_at: "2026-05-09T23:00:03.000Z" });
    expect(db.sqlite.prepare("SELECT updated_at,expires_at FROM idempotency_keys WHERE idempotency_key='fresh_approve'").get())
      .toEqual({ updated_at: "2026-05-09T23:00:03.000Z", expires_at: "2026-05-10T23:00:03.000Z" });
    expect(db.sqlite.prepare("SELECT available_at FROM calendar_sync_jobs WHERE dedupe_key=?")
      .get(`reservation:${created.reservationId}:google:upsert:revision:2`))
      .toEqual({ available_at: "2026-05-09T23:00:03.000Z" });
  });

  it.each(["slot_locks", "customer_time_locks"])(
    "rejects an expired pending %s hold despite the future reservation deadline", async (table) => {
      const created = await createPublicReservation({ db: d1, request, line, now: () => bookingTime });
      if (!created.ok) throw new Error(created.reason);
      db.sqlite.prepare(`UPDATE ${table} SET expires_at=? WHERE owner_id=? AND slot_at=?`)
        .run("2026-05-09T23:00:02.000Z", created.reservationId, created.startAt);
      let nowMs = bookingTime + 1000;
      const result = await runAdminReservationAction({
        db: d1, env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "fixture-token" }, admin: owner,
        reservationId: created.reservationId, action: "approve",
        request: { idempotencyKey: "expired_hold_approve" }, now: () => nowMs,
        fetcher: async () => {
          nowMs = bookingTime + 2000;
          return Response.json({ userId: line.lineUserId });
        }
      });
      expect(result.ok).toBe(false);
      expect(db.sqlite.prepare("SELECT status,version,updated_at FROM reservations WHERE id=?").get(created.reservationId))
        .toMatchObject({ status: "pending_approval", version: 1, updated_at: "2026-05-09T23:00:00.000Z" });
      expect(db.sqlite.prepare("SELECT COUNT(*) n FROM notification_jobs WHERE template_key='reservation_confirmed'").get())
        .toMatchObject({ n: 0 });
      expect(db.sqlite.prepare("SELECT COUNT(*) n FROM calendar_sync_jobs WHERE owner_id=?").get(created.reservationId))
        .toMatchObject({ n: 1 });
      expect(db.sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='admin_reservation_approved'").get())
        .toMatchObject({ n: 0 });
      expect(db.sqlite.prepare("SELECT COUNT(*) n FROM idempotency_keys WHERE idempotency_key='expired_hold_approve'").get())
        .toMatchObject({ n: 0 });
    }
  );

  it("rolls back when the reservation deadline expires between the precheck and the batch", async () => {
    const created = await createPublicReservation({ db: d1, request, line, now: () => bookingTime });
    if (!created.ok) throw new Error(created.reason);
    const originalBatch = db.batch.bind(db);
    db.batch = async (statements) => {
      db.sqlite.prepare("UPDATE reservations SET pending_expires_at=? WHERE id=?")
        .run("2026-05-09T23:00:01.000Z", created.reservationId);
      return originalBatch(statements);
    };
    const result = await runAdminReservationAction({
      db: d1, env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "fixture-token" }, admin: owner,
      reservationId: created.reservationId, action: "approve",
      request: { idempotencyKey: "deadline_approve" }, now: () => bookingTime + 1000,
      fetcher: async () => Response.json({ userId: line.lineUserId })
    });
    expect(result.ok).toBe(false);
    expect(db.sqlite.prepare("SELECT status,version,pending_expires_at FROM reservations WHERE id=?").get(created.reservationId))
      .toMatchObject({ status: "pending_approval", version: 1, pending_expires_at: "2026-05-09T23:00:01.000Z" });
    expect(db.sqlite.prepare("SELECT COUNT(*) n FROM notification_jobs WHERE template_key='reservation_confirmed'").get())
      .toMatchObject({ n: 0 });
    expect(db.sqlite.prepare("SELECT COUNT(*) n FROM calendar_sync_jobs WHERE owner_id=?").get(created.reservationId))
      .toMatchObject({ n: 1 });
    expect(db.sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='admin_reservation_approved'").get())
      .toMatchObject({ n: 0 });
    expect(db.sqlite.prepare("SELECT COUNT(*) n FROM idempotency_keys WHERE idempotency_key='deadline_approve'").get())
      .toMatchObject({ n: 0 });
  });

  it.each([
    { status: "pending", expiresAt: null },
    { status: "confirmed", expiresAt: "2026-05-08T23:00:00.000Z" }
  ])("preserves legacy null deadlines with $status holds", async ({ status, expiresAt }) => {
    const created = await createPublicReservation({ db: d1, request, line, now: () => bookingTime });
    if (!created.ok) throw new Error(created.reason);
    db.sqlite.prepare("UPDATE reservations SET pending_expires_at=NULL WHERE id=?").run(created.reservationId);
    for (const table of ["slot_locks", "customer_time_locks"]) {
      db.sqlite.prepare(`UPDATE ${table} SET lock_status=?,expires_at=? WHERE owner_id=?`)
        .run(status, expiresAt, created.reservationId);
    }
    const result = await runAdminReservationAction({
      db: d1, env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "fixture-token" }, admin: owner,
      reservationId: created.reservationId, action: "approve",
      request: { idempotencyKey: "legacy_approve" }, now: () => bookingTime + 1000,
      fetcher: async () => Response.json({ userId: line.lineUserId })
    });
    expect(result).toMatchObject({ ok: true, status: "confirmed", version: 2 });
    for (const table of ["slot_locks", "customer_time_locks"]) {
      expect(db.sqlite.prepare(`SELECT COUNT(*) n FROM ${table} WHERE owner_id=? AND lock_status='confirmed' AND expires_at IS NULL`)
        .get(created.reservationId)).toMatchObject({ n: 13 });
    }
  });

  it("shows every booked menu snapshot to customers after the catalog is renamed", async () => {
    db.sqlite.prepare("UPDATE services SET name='予約時メニューA' WHERE id=?").run(request.serviceId);
    db.sqlite.prepare("INSERT INTO services(id,store_id,name,duration_minutes) VALUES('race_second','kyoto','予約時メニューB',30)").run();
    db.sqlite.prepare("INSERT INTO service_stores(service_id,store_id) VALUES('race_second','kyoto')").run();
    const created = await createPublicReservation({
      db: d1, request: { ...request, serviceIds: [request.serviceId, "race_second"] }, line, now: () => bookingTime
    });
    if (!created.ok) throw new Error(created.reason);
    db.sqlite.prepare("UPDATE services SET name='変更後のメニュー' WHERE store_id='kyoto'").run();
    const identity = db.sqlite.prepare("SELECT id,customer_id FROM line_identities WHERE line_user_id=?")
      .get(line.lineUserId) as { id: string; customer_id: string };
    const nowIso = new Date(bookingTime).toISOString();
    const mine = await listMyReservations(d1, { lineIdentityId: identity.id, nowIso });
    const upcoming = await getUpcomingReservations(d1, identity.customer_id, nowIso);
    expect(mine[0].serviceName).toBe("予約時メニューA / 予約時メニューB");
    expect(upcoming[0].serviceName).toBe("予約時メニューA / 予約時メニューB");
  });
});
