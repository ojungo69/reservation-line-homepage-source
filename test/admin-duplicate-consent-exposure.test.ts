import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPublicReservation, type PublicReservationRequest, type VerifiedLineContext } from "../src/reservations/public-submit";
import { getAdminReservationDetail, getAdminCustomerDetail } from "../src/admin/operations";
import type { AdminUser } from "../src/admin/access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

// Verifies the admin-side surfacing of the duplicate-reservation acknowledgement:
// owner/system_admin see the derived duplicateConsent field; staff (who receive no
// audit rows at all) do not. The reservation + its evidence audit row are created via
// the real submit path so the parsing is exercised end-to-end.

const lineContext: VerifiedLineContext = { lineUserId: "line_user_1", channelId: "line_channel_id" };
const DUP_VERSION = "dup-warning-2026-08-31";
const CUSTOMER_ID = "cust_dup_admin";
const NOW_SUBMIT = () => Date.parse("2026-05-09T23:00:00.000Z");

const sha256Hex = (value: string) =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(value))
    .then((bytes) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join(""));

const owner: AdminUser = { id: "owner1", email: "o@example.com", role: "owner", staff_member_id: null, store_id: null };
const staff: AdminUser = { id: "staff1", email: "s@example.com", role: "staff", staff_member_id: "sm1", store_id: "kyoto" };

const createRequest = (): PublicReservationRequest => ({
  idempotencyKey: "dup_admin_1",
  storeId: "kyoto",
  serviceId: "service_kyoto_default_60",
  resourceId: "resource_kyoto_calendar",
  startAt: "2026-06-01T01:00:00.000Z",
  consents: {
    noticeVersion: "notice-terms-2026-06",
    cancellationPolicyVersion: "cancel-2026-08-31",
    privacyPolicyVersion: "privacy-2026-06",
    duplicateReservationWarningVersion: DUP_VERSION
  }
});

describe("admin surfacing of duplicate-reservation consent", () => {
  let d1: SqliteD1Database;
  let reservationId: string;

  beforeEach(async () => {
    d1 = createMigratedSqliteD1();
    d1.sqlite
      .prepare(
        "UPDATE store_settings SET max_active_reservations_per_customer = 2 WHERE store_id = 'kyoto'"
      )
      .run();
    const phone = "09012345678";
    d1.sqlite
      .prepare(
        `INSERT INTO customers (id, display_name, display_name_kana, phone_normalized, phone_hash, block_status, updated_at)
         VALUES (?, '山田 花子', 'ヤマダ ハナコ', ?, ?, 'active', '2026-01-01T00:00:00.000Z')`
      )
      .run(CUSTOMER_ID, phone, await sha256Hex(phone));
    d1.sqlite
      .prepare(
        `INSERT INTO line_identities (id, customer_id, provider, channel_id, line_user_id, friend_flag, official_friend_status, last_friend_checked_at, updated_at)
         VALUES ('li_dup', ?, 'line', ?, ?, 1, 'friend', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run(CUSTOMER_ID, lineContext.channelId, lineContext.lineUserId);
    // Pre-existing active future reservation → the new booking must carry the ack.
    d1.sqlite
      .prepare(
        `INSERT INTO reservations (
           id, store_id, service_id, customer_id, resource_id, source, status,
           start_at, end_at, duration_minutes, idempotency_key, updated_at
         ) VALUES ('existing_resv', 'kyoto', 'service_kyoto_default_60', ?, 'resource_kyoto_calendar', 'web_line', 'confirmed',
                   '2026-08-01T03:00:00.000Z', '2026-08-01T04:00:00.000Z', 60, 'existing_idem', '2026-05-09T00:00:00.000Z')`
      )
      .run(CUSTOMER_ID);
    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      env: {},
      request: createRequest(),
      line: lineContext,
      now: NOW_SUBMIT
    });
    if (!result.ok) throw new Error(`setup booking failed: ${result.reason}`);
    reservationId = result.reservationId;
  });
  afterEach(() => d1.sqlite.close());

  it("exposes duplicateConsent on the reservation detail for an owner", async () => {
    const detail = await getAdminReservationDetail({ db: d1 as unknown as D1Database, reservationId, admin: owner });
    expect(detail.ok).toBe(true);
    if (!detail.ok) throw new Error("not found");
    expect(detail.reservation.duplicateConsent).not.toBeNull();
    expect(detail.reservation.duplicateConsent?.stage).toBe("soft");
    expect(detail.reservation.duplicateConsent?.warningVersion).toBe(DUP_VERSION);
    expect(detail.reservation.duplicateConsent?.existingReservations).toEqual([
      { reservationId: "existing_resv", storeId: "kyoto", startAt: "2026-08-01T03:00:00.000Z" }
    ]);
  });

  it("keeps duplicateConsent visible even when the reservation has more than 20 newer audit rows", async () => {
    // Pile on 25 newer generic audit rows for this reservation. The generic detail audit
    // query is capped at LIMIT 20, so the dedicated dup-consent query (not the cap) must
    // still surface the evidence.
    for (let i = 0; i < 25; i += 1) {
      d1.sqlite
        .prepare(
          `INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, metadata_json, created_at)
           VALUES (?, 'staff', 'admin1', 'admin_reservation_approved', 'reservation', ?, '{}', ?)`
        )
        .run(`noise_${i}`, reservationId, `2026-05-10T00:00:${String(i).padStart(2, "0")}.000Z`);
    }
    const detail = await getAdminReservationDetail({ db: d1 as unknown as D1Database, reservationId, admin: owner });
    if (!detail.ok) throw new Error("not found");
    expect(detail.reservation.duplicateConsent).not.toBeNull();
    expect(detail.reservation.duplicateConsent?.warningVersion).toBe(DUP_VERSION);
  });

  it("does NOT expose duplicateConsent (or any audit) to staff", async () => {
    const detail = await getAdminReservationDetail({ db: d1 as unknown as D1Database, reservationId, admin: staff });
    expect(detail.ok).toBe(true);
    if (!detail.ok) throw new Error("not found");
    expect(detail.reservation.duplicateConsent).toBeNull();
    expect(detail.reservation.audit).toEqual([]);
  });

  it("lists duplicateConsentHistory on the customer karte for an owner", async () => {
    const detail = await getAdminCustomerDetail({ db: d1 as unknown as D1Database, customerId: CUSTOMER_ID, admin: owner });
    expect(detail.ok).toBe(true);
    if (!detail.ok) throw new Error("not found");
    expect(detail.customer.duplicateConsentHistory).toHaveLength(1);
    const entry = detail.customer.duplicateConsentHistory[0];
    expect(entry.reservationId).toBe(reservationId);
    expect(entry.stage).toBe("soft");
    expect(entry.warningVersion).toBe(DUP_VERSION);
    expect(entry.existingCount).toBe(1);
  });

  it("returns an empty duplicateConsentHistory to staff", async () => {
    const detail = await getAdminCustomerDetail({ db: d1 as unknown as D1Database, customerId: CUSTOMER_ID, admin: staff });
    // Staff at the kyoto store can access the customer (they have a reservation there)
    // but must not receive the audit-derived history.
    if (!detail.ok) throw new Error(detail.reason);
    expect(detail.customer.duplicateConsentHistory).toEqual([]);
  });
});
