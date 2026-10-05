import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/sentry-helpers", () => ({
  captureBatchWriteFailure: vi.fn()
}));

import type { WorkerBindings } from "../src/bindings";
import {
  createPublicReservation,
  type PublicReservationRequest,
  type VerifiedLineContext
} from "../src/reservations/public-submit";
import { _resetCacheForTesting } from "../src/google/availability-live-check";
import { statusForPublicReservationResult } from "../src/routes/shared";
import { captureBatchWriteFailure } from "../src/sentry-helpers";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

describe("public reservation submit", () => {
  let d1: SqliteD1Database;

  beforeEach(() => {
    d1 = createMigratedSqliteD1();
    vi.mocked(captureBatchWriteFailure).mockClear();
  });

  afterEach(() => {
    d1.sqlite.close();
  });

  const lineContext: VerifiedLineContext = {
    lineUserId: "line_user_1",
    channelId: "line_channel_id"
  };

  const createRequest = (overrides: Partial<PublicReservationRequest> = {}): PublicReservationRequest => ({
    idempotencyKey: "public_submit_1",
    storeId: "kyoto",
    serviceId: "service_kyoto_default_60",
    resourceId: "resource_kyoto_calendar",
    startAt: "2026-06-01T01:00:00.000Z",
    customer: {
      displayName: "予約 太郎",
      displayNameKana: "ヨヤク タロウ",
      phone: "075-123-4567"
    },
    consents: {
      noticeVersion: "notice-terms-2026-06",
      cancellationPolicyVersion: "cancel-2026-08-31",
      privacyPolicyVersion: "privacy-2026-06",
      // Model a client that echoes the duplicate-reservation warning version it was
      // shown. Inert for requests whose customer holds no upcoming reservations (the
      // server skips the duplicate gate); required by the cap/active-pending cases
      // below, where the seeded existing reservations make the gate apply first.
      duplicateReservationWarningVersion: "dup-warning-2026-08-31"
    },
    ...overrides
  });

  const count = (sql: string, ...values: (string | number)[]) => {
    return (d1.sqlite.prepare(sql).get(...values) as { count: number }).count;
  };

  const sha256Hex = async (value: string) => {
    return crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(value))
      .then((bytes) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join(""));
  };

  const idempotencyStorageKey = (idempotencyKey: string, line = lineContext) => {
    return sha256Hex(
      JSON.stringify({
        scope: "public_submit",
        channelId: line.channelId,
        lineUserId: line.lineUserId,
        idempotencyKey
      })
    );
  };

  type ExistingLineCustomerSeed = {
    customerId: string;
    lineUserId: string;
    phone?: string | null;
    kana?: string | null;
    blocked?: boolean;
    channelId?: string;
  };

  const seedExistingLineCustomer = async (seed: ExistingLineCustomerSeed): Promise<void> => {
    const phoneHash = seed.phone ? await sha256Hex(seed.phone) : null;
    d1.sqlite
      .prepare(
        `INSERT INTO customers (id, display_name, display_name_kana, phone_normalized, phone_hash, block_status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`
      )
      .run(
        seed.customerId,
        "山田 花子",
        seed.kana ?? null,
        seed.phone ?? null,
        phoneHash,
        seed.blocked ? "blocked" : "active"
      );
    d1.sqlite
      .prepare(
        `INSERT INTO line_identities (id, customer_id, provider, channel_id, line_user_id, friend_flag, official_friend_status, last_friend_checked_at, updated_at)
         VALUES (?, ?, 'line', ?, ?, 1, 'friend', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run(
        `li-${seed.customerId}`,
        seed.customerId,
        seed.channelId ?? lineContext.channelId,
        seed.lineUserId
      );
  };

  const seedBlockedCustomerByPhone = async (customerId: string, phone: string): Promise<void> => {
    d1.sqlite
      .prepare(
        `INSERT INTO customers (id, display_name, phone_normalized, phone_hash, block_status, updated_at)
         VALUES (?, 'ブロック客', ?, ?, 'blocked', '2026-01-01T00:00:00.000Z')`
      )
      .run(customerId, phone, await sha256Hex(phone));
  };

  it("reuses the registered record when an existing LINE customer omits customer (phone on file)", async () => {
    await seedExistingLineCustomer({ customerId: "cust_existing", lineUserId: lineContext.lineUserId, phone: "09012345678", kana: "ヤマダ ハナコ" });
    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest({ customer: undefined }),
      line: lineContext,
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    // No new customer created; reservation bound to the existing customer.
    expect(count("SELECT COUNT(*) AS count FROM customers")).toBe(1);
    const row = d1.sqlite
      .prepare("SELECT customer_id FROM reservations WHERE id = ?")
      .get(result.reservationId) as { customer_id: string };
    expect(row.customer_id).toBe("cust_existing");
  });

  it("falls back to schema defaults when the store has no store_settings row (LEFT JOIN, not store_not_found)", async () => {
    await seedExistingLineCustomer({ customerId: "cust_nosettings", lineUserId: lineContext.lineUserId, phone: "09012345678", kana: "ヤマダ ハナコ" });
    // Bootstrapped store: store_settings row absent. fetchBookingContext must
    // LEFT JOIN + COALESCE to defaults rather than failing the INNER JOIN and
    // returning store_not_found (which would let availability show un-bookable slots).
    d1.sqlite.prepare("DELETE FROM store_settings WHERE store_id = 'kyoto'").run();
    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest({ customer: undefined }),
      line: lineContext,
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });
    expect(result.ok).toBe(true);
  });

  it("rejects omitted customer when no LINE identity exists", async () => {
    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest({ customer: undefined }),
      line: { lineUserId: "line_user_unknown", channelId: lineContext.channelId },
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });
    expect(result).toEqual({ ok: false, reason: "invalid_request" });
  });

  it("rejects omitted customer when the existing customer has no phone on file", async () => {
    await seedExistingLineCustomer({ customerId: "cust_nophone", lineUserId: lineContext.lineUserId, phone: null });
    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest({ customer: undefined }),
      line: lineContext,
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });
    expect(result).toEqual({ ok: false, reason: "invalid_request" });
  });

  it("rejects omitted customer when the existing customer is blocked", async () => {
    await seedExistingLineCustomer({ customerId: "cust_blocked", lineUserId: lineContext.lineUserId, phone: "09011112222", blocked: true });
    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest({ customer: undefined }),
      line: lineContext,
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });
    expect(result).toEqual({ ok: false, reason: "invalid_request" });
  });

  it("keeps a stable requestHash so an omitted-customer resend replays the same reservation", async () => {
    await seedExistingLineCustomer({ customerId: "cust_replay", lineUserId: lineContext.lineUserId, phone: "09012345678", kana: "ヤマダ ハナコ" });
    const request = createRequest({ customer: undefined, idempotencyKey: "omit_replay_1" });
    const first = await createPublicReservation({ db: d1 as unknown as D1Database, request, line: lineContext, now: () => Date.parse("2026-05-09T23:00:00.000Z") });
    const second = await createPublicReservation({ db: d1 as unknown as D1Database, request, line: lineContext, now: () => Date.parse("2026-05-09T23:00:01.000Z") });
    expect(first.ok && second.ok).toBe(true);
    if (!second.ok) throw new Error(second.reason);
    expect(second.replayed).toBe(true);
    expect(count("SELECT COUNT(*) AS count FROM reservations")).toBe(1);
  });

  it("does not lock a public_submit key with idempotency_conflict once its row is past TTL (B9)", async () => {
    // The exact F-6.1 failure mode: an EXPIRED row carrying a different
    // request_hash must NOT return idempotency_conflict (which would lock the
    // key forever past its TTL). The two runs are identical except expires_at;
    // the injected 2100 clock is the booking instant (checkedAt) that the
    // read's TTL filter binds, so ONLY the TTL predicate can make them diverge.
    const storageKey = await idempotencyStorageKey("b9_ttl");
    const runWithExpiry = async (expiresAt: string) => {
      const db = createMigratedSqliteD1();
      try {
        db.sqlite
          .prepare(
            `INSERT INTO idempotency_keys (id, scope, idempotency_key, status, request_hash, expires_at)
             VALUES ('b9_ttl_row', 'public_submit', ?, 'started', 'stale-mismatch-hash', ?)`
          )
          .run(storageKey, expiresAt);
        return await createPublicReservation({
          db: db as unknown as D1Database,
          // startAt must be in the future relative to the injected 2100 clock so
          // the flow reaches the idempotency read instead of an early invalid_time.
          request: createRequest({ idempotencyKey: "b9_ttl", startAt: "2100-01-05T01:00:00.000Z" }),
          line: lineContext,
          now: () => Date.parse("2100-01-01T00:00:00.000Z")
        });
      } finally {
        db.sqlite.close();
      }
    };

    // Live row (expires AFTER the injected clock) → request_hash mismatch → conflict.
    expect(await runWithExpiry("2101-01-01T00:00:00.000Z")).toEqual({
      ok: false,
      reason: "idempotency_conflict"
    });

    // Expired row (expires BEFORE the injected clock) → hidden by the TTL
    // predicate AND reclaimed by the batch's delete-expired statement, so the
    // key is fully reusable past its TTL: the booking proceeds and succeeds
    // (no idempotency_conflict, no UNIQUE-collision write_failed lock-out).
    const expired = await runWithExpiry("2099-01-01T00:00:00.000Z");
    expect(expired.ok).toBe(true);
  });

  it("replays an already-created reservation on retry even after a consent-version env bump", async () => {
    const request = createRequest({ idempotencyKey: "consent_bump_replay_1" });
    const first = await createPublicReservation({
      db: d1 as unknown as D1Database,
      env: {},
      request,
      line: lineContext,
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.reason);
    // Owner bumps a consent version (runtime:apply) between the submit and the client
    // retry. Idempotency resolves BEFORE consent validation, so the original reservation
    // is replayed rather than rejected with consent_version_mismatch.
    const retry = await createPublicReservation({
      db: d1 as unknown as D1Database,
      env: { RESERVATION_NOTICE_VERSION: "notice-2026-07" },
      request,
      line: lineContext,
      now: () => Date.parse("2026-05-09T23:00:01.000Z")
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error(retry.reason);
    expect(retry.replayed).toBe(true);
    expect(retry.reservationId).toBe(first.reservationId);
    expect(count("SELECT COUNT(*) AS count FROM reservations")).toBe(1);
  });

  it("self-heals a stranded expired-pending customer_time_lock so the same customer can re-book", async () => {
    await seedExistingLineCustomer({ customerId: "cust_ctl_heal", lineUserId: lineContext.lineUserId, phone: "09012345678", kana: "ヤマダ ハナコ" });
    // Stranded expired-pending locks on BOTH tables for this customer at the target slot.
    d1.sqlite
      .prepare(
        `INSERT INTO slot_locks (id, store_id, resource_id, slot_at, owner_type, owner_id, lock_status, expires_at)
         VALUES ('stranded_slot_ctl', 'kyoto', 'resource_kyoto_calendar', '2026-06-01T01:00:00.000Z', 'reservation', 'old_resv_ctl', 'pending', '2023-01-01T00:00:00.000Z')`
      )
      .run();
    d1.sqlite
      .prepare(
        `INSERT INTO customer_time_locks (id, customer_id, slot_at, owner_type, owner_id, lock_status, expires_at)
         VALUES ('stranded_ctl', 'cust_ctl_heal', '2026-06-01T01:00:00.000Z', 'reservation', 'old_resv_ctl', 'pending', '2023-01-01T00:00:00.000Z')`
      )
      .run();

    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest({ customer: undefined, idempotencyKey: "ctl_heal_1" }),
      line: lineContext,
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    // The stranded customer_time_lock was cleared and re-created under the new reservation,
    // so the (customer_id, slot_at) UNIQUE no longer blocks the same customer's re-booking.
    expect(count("SELECT COUNT(*) AS count FROM customer_time_locks WHERE owner_id = 'old_resv_ctl'")).toBe(0);
    expect(
      count(
        "SELECT COUNT(*) AS count FROM customer_time_locks WHERE slot_at = '2026-06-01T01:00:00.000Z' AND customer_id = 'cust_ctl_heal' AND owner_id = ?",
        result.reservationId
      )
    ).toBe(1);
  });

  it("rejects (and persists nothing) when startAt is beyond the per-store booking window", async () => {
    // Narrow the store's window to 7 days. now = 2026-05-09T23:00Z → window is
    // 2026-05-09 .. 2026-05-16. The default request's startAt (2026-06-01, ~23 days
    // out) is well beyond it. The UI would never offer this date, but a LINE/Turnstile
    // authenticated client could POST it directly — it must be rejected server-side
    // with no reservation and no slot/customer locks left behind.
    d1.sqlite.prepare("UPDATE store_settings SET booking_window_days = 7 WHERE store_id = 'kyoto'").run();

    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest({ idempotencyKey: "window_bypass_1" }),
      line: lineContext,
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected out-of-window rejection");
    expect(result.reason).toBe("invalid_time");
    expect(count("SELECT COUNT(*) AS count FROM reservations WHERE start_at = '2026-06-01T01:00:00.000Z'")).toBe(0);
    expect(count("SELECT COUNT(*) AS count FROM slot_locks WHERE slot_at = '2026-06-01T01:00:00.000Z'")).toBe(0);
    expect(
      count("SELECT COUNT(*) AS count FROM customer_time_locks WHERE slot_at = '2026-06-01T01:00:00.000Z'")
    ).toBe(0);
  });

  it("accepts a startAt inside the narrowed booking window (boundary parity with availability)", async () => {
    d1.sqlite.prepare("UPDATE store_settings SET booking_window_days = 7 WHERE store_id = 'kyoto'").run();
    // 2026-05-14T01:00Z = 10:00 JST Thu, inside both business hours and the 7-day window.
    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest({ idempotencyKey: "window_inside_1", startAt: "2026-05-14T01:00:00.000Z" }),
      line: lineContext,
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });
    expect(result.ok).toBe(true);
  });

  it("replays an already-created reservation on retry even after the window was shortened", async () => {
    // Window enforcement runs AFTER idempotency resolution (mirroring the consent-version
    // check), so a retry of an already-created booking replays the original result rather
    // than being re-rejected when the owner has since shortened the window.
    d1.sqlite.prepare("UPDATE store_settings SET booking_window_days = 90 WHERE store_id = 'kyoto'").run();
    const req = createRequest({ idempotencyKey: "window_replay_1", startAt: "2026-06-04T01:00:00.000Z" });
    const first = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: req,
      line: lineContext,
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.reason);

    // Owner shrinks the window so 2026-06-04 (26 days out) is now beyond it.
    d1.sqlite.prepare("UPDATE store_settings SET booking_window_days = 7 WHERE store_id = 'kyoto'").run();

    const retry = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: req,
      line: lineContext,
      now: () => Date.parse("2026-05-09T23:00:01.000Z")
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error(retry.reason);
    expect(retry.reservationId).toBe(first.reservationId);
  });

  it("uses the provided customer value as the effective contact (provided phone hash drives block check)", async () => {
    await seedExistingLineCustomer({ customerId: "cust_provided", lineUserId: lineContext.lineUserId, phone: "09012345678" });
    await seedBlockedCustomerByPhone("cust_provided_block", "08099998888");
    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest({ customer: { displayName: "別名", phone: "080-9999-8888" } }),
      line: lineContext,
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });
    // The provided phone (not the on-file one) was hashed and matched a blocked customer.
    expect(result).toEqual({ ok: false, reason: "invalid_request" });
  });

  // issue #639: ブロックは phone_hash の完全一致で効くので、同じ番号を国際表記で
  // 打ち直すだけで別ハッシュになり、公開フォームから予約が通ってしまっていた。
  // normalizePhone が保存前に国内表記へ寄せることで、両表記が同じ 1 個のハッシュになる。
  it("rejects the international spelling of a phone number that is blocked in domestic form", async () => {
    await seedExistingLineCustomer({ customerId: "cust_intl", lineUserId: lineContext.lineUserId, phone: "09012345678" });
    await seedBlockedCustomerByPhone("cust_intl_block", "08099998888");
    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest({ customer: { displayName: "別名", phone: "+81 80-9999-8888" } }),
      line: lineContext,
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });
    expect(result).toEqual({ ok: false, reason: "invalid_request" });
  });

  // 逆向き。ブロックが国際表記で登録されていた場合 (正規化前に作られた行) は、
  // 国内表記の予約を弾けない — その穴は backfill (scripts/backfill-phone-canonical.mjs)
  // で保存済みの行を寄せて閉じる。ここでは「新しく保存される行は必ず国内表記」だけを固定する。
  it("stores the domestic form even when the customer types the international form", async () => {
    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest({ customer: { displayName: "国際 表記", phone: "+81 90-1111-2222" } }),
      line: lineContext,
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });
    expect(result.ok).toBe(true);
    const row = d1.sqlite
      .prepare("SELECT phone_normalized, phone_hash FROM customers WHERE display_name = '国際 表記'")
      .get() as { phone_normalized: string; phone_hash: string };
    expect(row.phone_normalized).toBe("09011112222");
    expect(row.phone_hash).toBe(await sha256Hex("09011112222"));
  });

  it("rejects a reservation whose submitted consent version does not match the server canonical version", async () => {
    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest({
        consents: {
          noticeVersion: "forged-notice-999",
          cancellationPolicyVersion: "cancel-2026-08-31",
          privacyPolicyVersion: "privacy-2026-06"
        }
      }),
      line: lineContext,
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });
    // A forged / stale consent version is rejected, not silently recorded as the
    // canonical one — the audit trail never claims consent to a policy the user
    // did not actually see.
    expect(result).toEqual({ ok: false, reason: "consent_version_mismatch" });
    expect(count("SELECT COUNT(*) AS count FROM reservations")).toBe(0);
    expect(count("SELECT COUNT(*) AS count FROM consent_records")).toBe(0);
  });

  it("self-heals a stranded expired slot_lock so the orphan-locked slot is still bookable", async () => {
    // Reproduce the orphaned-slot-locks incident class: a pending lock whose TTL lapsed
    // but whose row was never DELETEd by the expiry sweep, sitting on the slot the
    // customer is about to book. Availability already shows the slot free (getBusySlots
    // ignores expired locks); the booking path must agree and re-lock it.
    d1.sqlite
      .prepare(
        `INSERT INTO slot_locks (id, store_id, resource_id, slot_at, owner_type, owner_id, lock_status, expires_at)
         VALUES ('stranded_lock_1', 'kyoto', 'resource_kyoto_calendar', '2026-06-01T01:00:00.000Z', 'reservation', 'stranded_owner_1', 'pending', '2023-01-01T00:00:00.000Z')`
      )
      .run();

    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest(),
      line: lineContext,
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    // The orphan lock was cleared and the slot re-locked under the new reservation.
    expect(count("SELECT COUNT(*) AS count FROM slot_locks WHERE owner_id = 'stranded_owner_1'")).toBe(0);
    expect(
      count(
        "SELECT COUNT(*) AS count FROM slot_locks WHERE slot_at = '2026-06-01T01:00:00.000Z' AND owner_id = ?",
        result.reservationId
      )
    ).toBe(1);
  });

  it("creates a pending reservation, customer, locks, consents, jobs, and audit rows atomically for a new LINE customer", async () => {
    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest(),
      line: lineContext,
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });

    expect(result).toMatchObject({
      ok: true,
      status: "pending_approval",
      storeId: "kyoto",
      startAt: "2026-06-01T01:00:00.000Z",
      endAt: "2026-06-01T02:05:00.000Z",
      replayed: false
    });
    if (!result.ok) {
      throw new Error(result.reason);
    }

    expect(count("SELECT COUNT(*) AS count FROM customers")).toBe(1);
    expect(count("SELECT COUNT(*) AS count FROM line_identities WHERE line_user_id = ?", "line_user_1")).toBe(1);
    expect(count("SELECT COUNT(*) AS count FROM reservations WHERE id = ?", result.reservationId)).toBe(1);
    expect(count("SELECT COUNT(*) AS count FROM slot_locks WHERE owner_id = ?", result.reservationId)).toBe(13);
    expect(count("SELECT COUNT(*) AS count FROM customer_time_locks WHERE owner_id = ?", result.reservationId)).toBe(13);
    expect(count("SELECT COUNT(*) AS count FROM consent_records WHERE reservation_id = ?", result.reservationId)).toBe(3);
    // pending_approval skips customer LINE notification, but always enqueues one
    // owner email job even when LINE_OPERATIONS_USER_IDS is absent.
    expect(count("SELECT COUNT(*) AS count FROM notification_jobs WHERE reservation_id = ?", result.reservationId)).toBe(1);
    expect(
      count(
        "SELECT COUNT(*) AS count FROM notification_jobs WHERE reservation_id = ? AND recipient_type = 'staff'",
        result.reservationId
      )
    ).toBe(0);
    expect(count("SELECT COUNT(*) AS count FROM calendar_sync_jobs WHERE owner_id = ?", result.reservationId)).toBe(1);
    expect(count("SELECT COUNT(*) AS count FROM audit_logs WHERE target_id = ?", result.reservationId)).toBe(1);

    const idempotency = d1.sqlite
      .prepare("SELECT status, target_id FROM idempotency_keys WHERE idempotency_key = ?")
      .get(await idempotencyStorageKey("public_submit_1")) as { status: string; target_id: string };
    expect(idempotency).toEqual({
      status: "succeeded",
      target_id: result.reservationId
    });
  });

  // Valid LINE user ids: "U" + 32 hex chars.
  const OWNER_A = `U${"0".repeat(31)}a`;
  const OWNER_B = `U${"0".repeat(31)}b`;
  const OWNER_EMAIL_RECIPIENT_ID = "email:owner";

  it("enqueues one owner email job when a brand-new customer books", async () => {
    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest(),
      line: lineContext,
      env: { LINE_OPERATIONS_USER_IDS: `${OWNER_A},${OWNER_B}` },
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });
    if (!result.ok) {
      throw new Error(result.reason);
    }

    // New customer → pending_approval → one owner email job, independent of
    // the two configured LINE operations recipients.
    expect(
      count(
        "SELECT COUNT(*) AS count FROM notification_jobs WHERE reservation_id = ? AND template_key = 'reservation_new_customer' AND recipient_type = 'owner'",
        result.reservationId
      )
    ).toBe(1);
    const recipients = d1.sqlite
      .prepare(
        "SELECT recipient_id FROM notification_jobs WHERE reservation_id = ? AND template_key = 'reservation_new_customer' ORDER BY recipient_id"
      )
      .all(result.reservationId)
      .map((row) => (row as { recipient_id: string }).recipient_id);
    expect(recipients).toEqual([OWNER_EMAIL_RECIPIENT_ID]);
    expect(
      count(
        "SELECT COUNT(*) AS count FROM notification_jobs WHERE reservation_id = ? AND template_key = 'pending_approval_created'",
        result.reservationId
      )
    ).toBe(0);
    // No customer-facing push for the pending reservation (budget conservation).
    expect(
      count(
        "SELECT COUNT(*) AS count FROM notification_jobs WHERE reservation_id = ? AND recipient_type = 'customer'",
        result.reservationId
      )
    ).toBe(0);
  });

  it("enqueues pending_approval_created even with no LINE operations recipients", async () => {
    // The owner may well empty LINE_OPERATIONS_USER_IDS now that this notification
    // no longer uses LINE. It is delivered by email, so it must not depend on that
    // list — tying it to the LINE recipients would silently stop the alerts.
    d1.sqlite.exec(`
      INSERT INTO customers (id, display_name, phone_normalized, phone_hash)
      VALUES ('customer_returning', '常連 顧客', '0751234567', 'phone_hash_returning');

      INSERT INTO line_identities (id, customer_id, channel_id, line_user_id, friend_flag, official_friend_status)
      VALUES ('line_identity_returning', 'customer_returning', 'line_channel_id', 'line_user_1', 1, 'friend');

      INSERT INTO customer_visits (id, customer_id, store_id, visited_at, visit_source, status, recorded_by)
      VALUES ('visit_returning', 'customer_returning', 'kyoto', '2026-05-01T01:00:00.000Z', 'manual_import', 'valid', 'system');
    `);

    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest(),
      line: lineContext,
      env: { LINE_OPERATIONS_USER_IDS: "" },
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(
      count(
        "SELECT COUNT(*) AS count FROM notification_jobs WHERE reservation_id = ? AND template_key = 'pending_approval_created' AND recipient_id = ?",
        result.reservationId,
        OWNER_EMAIL_RECIPIENT_ID
      )
    ).toBe(1);
  });

  it("treats a customer whose only visit was voided as a new customer", async () => {
    // 訂正 (completed -> no_show) で来店実績が無効化されたら、その顧客は
    // 実来店ゼロに戻る。オーナー通知も新規客テンプレートに戻らないと、
    // 来ていない客が「常連」として扱われ続ける。
    d1.sqlite.exec(`
      INSERT INTO customers (id, display_name, phone_normalized, phone_hash)
      VALUES ('customer_returning', '常連 顧客', '0751234567', 'phone_hash_returning');

      INSERT INTO line_identities (id, customer_id, channel_id, line_user_id, friend_flag, official_friend_status)
      VALUES ('line_identity_returning', 'customer_returning', 'line_channel_id', 'line_user_1', 1, 'friend');

      INSERT INTO customer_visits (id, customer_id, store_id, visited_at, visit_source, status, recorded_by, voided_by, voided_at, void_reason)
      VALUES ('visit_returning', 'customer_returning', 'kyoto', '2026-05-01T01:00:00.000Z', 'manual_import', 'voided', 'system', 'admin_owner_1', '2026-05-02T00:00:00.000Z', 'reservation_corrected_to_no_show');
    `);

    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest(),
      line: lineContext,
      env: { LINE_OPERATIONS_USER_IDS: `${OWNER_A},${OWNER_B}` },
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });
    if (!result.ok) {
      throw new Error(result.reason);
    }
    // 既存顧客に紐づいたことを先に確認する。新規顧客行が作られていると、
    // 下の通知アサーションが「voided を数えない」以外の理由で成功してしまう。
    expect(
      (
        d1.sqlite
          .prepare("SELECT customer_id FROM reservations WHERE id = ?")
          .get(result.reservationId) as { customer_id: string }
      ).customer_id
    ).toBe("customer_returning");
    expect(
      count(
        "SELECT COUNT(*) AS count FROM notification_jobs WHERE reservation_id = ? AND template_key = 'reservation_new_customer'",
        result.reservationId
      )
    ).toBe(1);
    expect(
      count(
        "SELECT COUNT(*) AS count FROM notification_jobs WHERE reservation_id = ? AND template_key = 'pending_approval_created'",
        result.reservationId
      )
    ).toBe(0);
  });

  it("enqueues pending_approval_created for an established customer with visit history", async () => {
    d1.sqlite.exec(`
      INSERT INTO customers (id, display_name, phone_normalized, phone_hash)
      VALUES ('customer_returning', '常連 顧客', '0751234567', 'phone_hash_returning');

      INSERT INTO line_identities (id, customer_id, channel_id, line_user_id, friend_flag, official_friend_status)
      VALUES ('line_identity_returning', 'customer_returning', 'line_channel_id', 'line_user_1', 1, 'friend');

      INSERT INTO customer_visits (id, customer_id, store_id, visited_at, visit_source, status, recorded_by)
      VALUES ('visit_returning', 'customer_returning', 'kyoto', '2026-05-01T01:00:00.000Z', 'manual_import', 'valid', 'system');
    `);

    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest(),
      line: lineContext,
      env: { LINE_OPERATIONS_USER_IDS: `${OWNER_A},${OWNER_B}` },
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });
    if (!result.ok) {
      throw new Error(result.reason);
    }
    const jobs = d1.sqlite
      .prepare(
        `SELECT template_key, recipient_type, recipient_id, dedupe_key
         FROM notification_jobs
         WHERE reservation_id = ?
         ORDER BY recipient_id`
      )
      .all(result.reservationId);
    // TWO operations recipients are configured, yet exactly ONE job is queued: this
    // template is delivered by email from a single job (primary + optional ops mirror),
    // so a per-recipient fan-out would mail the same address twice.
    expect(jobs).toEqual([
      {
        template_key: "pending_approval_created",
        recipient_type: "owner",
        recipient_id: OWNER_EMAIL_RECIPIENT_ID,
        dedupe_key: `reservation:${result.reservationId}:template:pending_approval_created:recipient:${OWNER_EMAIL_RECIPIENT_ID}`
      }
    ]);
    expect(
      count(
        "SELECT COUNT(*) AS count FROM notification_jobs WHERE reservation_id = ? AND template_key = 'reservation_new_customer'",
        result.reservationId
      )
    ).toBe(0);
  });

  it("enqueues the new-customer owner email without LINE recipients for an identity with no visit", async () => {
    // Booked once before (has a LINE identity) but never visited → still needs
    // owner approval, so the owner should be alerted.
    d1.sqlite.exec(`
      INSERT INTO customers (id, display_name, phone_normalized, phone_hash)
      VALUES ('customer_novisit', '未来店 顧客', '0751234567', 'phone_hash_novisit');

      INSERT INTO line_identities (id, customer_id, channel_id, line_user_id, friend_flag, official_friend_status)
      VALUES ('line_identity_novisit', 'customer_novisit', 'line_channel_id', 'line_user_1', 1, 'friend');
    `);

    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest(),
      line: lineContext,
      env: { LINE_OPERATIONS_USER_IDS: "" },
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.status).toBe("pending_approval");
    expect(
      count(
        "SELECT COUNT(*) AS count FROM notification_jobs WHERE reservation_id = ? AND template_key = 'reservation_new_customer'",
        result.reservationId
      )
    ).toBe(1);
    const job = d1.sqlite
      .prepare(
        "SELECT recipient_id FROM notification_jobs WHERE reservation_id = ? AND template_key = 'reservation_new_customer'"
      )
      .get(result.reservationId) as { recipient_id: string };
    expect(job.recipient_id).toBe(OWNER_EMAIL_RECIPIENT_ID);
  });

  it("stores multiple selected services; a full-body hair-removal menu absorbs the サンプル 05 add-on's duration", async () => {
    // 全身脱毛（口周り・VIO込み, 45分）+ フォト光（5分）。フォト光は全身脱毛系と同時
    // 予約されると同一セッション内で行うため施術時間に加算しない（吸収）。
    // 占有 = 45（フォト光0に吸収）+ 5（清掃バッファ）= 50分。両サービスは junction に保存。
    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest({
        idempotencyKey: "public_submit_multi_menu_1",
        serviceId: "service_kyoto_hair_removal_full_60",
        serviceIds: [
          "service_kyoto_hair_removal_full_60",
          "service_kyoto_facial_photo_30"
        ]
      }),
      line: lineContext,
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });

    expect(result).toMatchObject({
      ok: true,
      startAt: "2026-06-01T01:00:00.000Z",
      endAt: "2026-06-01T01:50:00.000Z",
      replayed: false
    });
    if (!result.ok) {
      throw new Error(result.reason);
    }

    const reservation = d1.sqlite
      .prepare("SELECT service_id, duration_minutes FROM reservations WHERE id = ?")
      .get(result.reservationId) as { service_id: string; duration_minutes: number };
    expect(reservation).toEqual({
      service_id: "service_kyoto_hair_removal_full_60",
      duration_minutes: 50
    });

    const selectedServices = d1.sqlite
      .prepare(
        `
          SELECT service_id, display_order, name_snapshot, duration_minutes
          FROM reservation_services
          WHERE reservation_id = ?
          ORDER BY display_order ASC
        `
      )
      .all(result.reservationId) as Array<{
        service_id: string;
        display_order: number;
        name_snapshot: string;
        duration_minutes: number;
      }>;
    expect(selectedServices).toEqual([
      {
        service_id: "service_kyoto_hair_removal_full_60",
        display_order: 0,
        name_snapshot: "脱毛｜サンプル 11",
        duration_minutes: 45
      },
      {
        service_id: "service_kyoto_facial_photo_30",
        display_order: 1,
        name_snapshot: "フェイシャル｜サンプル 05",
        duration_minutes: 5
      }
    ]);
    expect(count("SELECT COUNT(*) AS count FROM slot_locks WHERE owner_id = ?", result.reservationId)).toBe(10);
    expect(count("SELECT COUNT(*) AS count FROM customer_time_locks WHERE owner_id = ?", result.reservationId)).toBe(10);
  });

  it("accepts public multi-service reservations totaling exactly 235 treatment minutes", async () => {
    d1.sqlite.exec(`
      INSERT INTO services (id, store_id, name, duration_minutes) VALUES
        ('service_kyoto_duration_120', 'kyoto', '上限確認 120分', 120),
        ('service_kyoto_duration_115', 'kyoto', '上限確認 115分', 115);
    `);

    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest({
        idempotencyKey: "public_submit_duration_cap_boundary_1",
        serviceId: "service_kyoto_duration_120",
        serviceIds: ["service_kyoto_duration_120", "service_kyoto_duration_115"]
      }),
      line: lineContext,
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });

    expect(result).toMatchObject({
      ok: true,
      startAt: "2026-06-01T01:00:00.000Z",
      endAt: "2026-06-01T05:00:00.000Z"
    });
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(count("SELECT COUNT(*) AS count FROM slot_locks WHERE owner_id = ?", result.reservationId)).toBe(48);
  });

  it("rejects public multi-service reservations whose treatment total exceeds 235 minutes", async () => {
    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest({
        idempotencyKey: "public_submit_duration_cap_1",
        serviceId: "service_kyoto_massage_back_long_90",
        serviceIds: [
          "service_kyoto_massage_back_long_90",
          "service_kyoto_hair_removal_kids_full_60",
          "service_kyoto_massage_kassa_60",
          "service_kyoto_foot_nail_one_color_60"
        ]
      }),
      line: lineContext,
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });

    expect(result).toEqual({ ok: false, reason: "invalid_request" });
    expect(count("SELECT COUNT(*) AS count FROM reservations")).toBe(0);
  });

  it("replays a completed reservation even when its service combination now exceeds 235 minutes", async () => {
    const serviceIds = [
      "service_kyoto_massage_back_long_90",
      "service_kyoto_hair_removal_kids_full_60",
      "service_kyoto_massage_kassa_60",
      "service_kyoto_foot_nail_one_color_60"
    ];
    const request = createRequest({
      idempotencyKey: "public_submit_over_cap_replay_1",
      serviceId: serviceIds[0],
      serviceIds
    });
    if (!request.customer) throw new Error("expected customer fixture");
    const requestHash = await sha256Hex(
      JSON.stringify({
        storeId: request.storeId,
        serviceId: request.serviceId,
        serviceIds,
        resourceId: request.resourceId,
        startAt: request.startAt,
        customer: {
          displayName: request.customer.displayName.trim(),
          displayNameKana: request.customer.displayNameKana?.trim() ?? null,
          phone: "0751234567"
        },
        consents: request.consents,
        line: lineContext
      })
    );
    d1.sqlite.exec(`
      INSERT INTO customers (id, display_name, phone_normalized, phone_hash, block_status)
      VALUES ('customer_over_cap_replay_1', '予約 太郎', '0751234567', 'phone_over_cap_replay_1', 'active');

      INSERT INTO reservations (
        id, store_id, service_id, customer_id, resource_id, source, status,
        start_at, end_at, duration_minutes, idempotency_key
      ) VALUES (
        'reservation_over_cap_replay_1', 'kyoto', '${serviceIds[0]}',
        'customer_over_cap_replay_1', 'resource_kyoto_calendar', 'web_line', 'pending_approval',
        '2026-06-01T01:00:00.000Z', '2026-06-01T05:35:00.000Z', 275,
        'public_submit_over_cap_replay_1'
      );
    `);
    d1.sqlite
      .prepare(
        `INSERT INTO idempotency_keys (
           id, scope, idempotency_key, status, target_type, target_id,
           request_hash, expires_at, updated_at
         ) VALUES (
           'idempotency_over_cap_replay_1', 'public_submit', ?, 'succeeded',
           'reservation', 'reservation_over_cap_replay_1', ?,
           '2026-06-02T00:00:00.000Z', '2026-05-09T00:00:00.000Z'
         )`
      )
      .run(await idempotencyStorageKey(request.idempotencyKey), requestHash);

    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request,
      line: lineContext,
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });

    expect(result).toEqual({
      ok: true,
      reservationId: "reservation_over_cap_replay_1",
      status: "pending_approval",
      storeId: "kyoto",
      startAt: "2026-06-01T01:00:00.000Z",
      endAt: "2026-06-01T05:35:00.000Z",
      replayed: true
    });
  });

  it("reserves the new focused full-body hair-removal menus with the full-body duration", async () => {
    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest({
        idempotencyKey: "public_submit_upper_focus_1",
        serviceId: "service_kyoto_hair_removal_upper_focus_45",
        serviceIds: ["service_kyoto_hair_removal_upper_focus_45"]
      }),
      line: lineContext,
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });

    expect(result).toMatchObject({
      ok: true,
      startAt: "2026-06-01T01:00:00.000Z",
      endAt: "2026-06-01T01:50:00.000Z",
      replayed: false
    });
    if (!result.ok) {
      throw new Error(result.reason);
    }

    const reservation = d1.sqlite
      .prepare("SELECT service_id, duration_minutes FROM reservations WHERE id = ?")
      .get(result.reservationId) as { service_id: string; duration_minutes: number };
    expect(reservation).toEqual({
      service_id: "service_kyoto_hair_removal_upper_focus_45",
      duration_minutes: 50
    });
    const selectedService = d1.sqlite
      .prepare(
        `
          SELECT service_id, name_snapshot, duration_minutes
          FROM reservation_services
          WHERE reservation_id = ?
        `
      )
      .get(result.reservationId) as { service_id: string; name_snapshot: string; duration_minutes: number };
    expect(selectedService).toEqual({
      service_id: "service_kyoto_hair_removal_upper_focus_45",
      name_snapshot: "脱毛｜サンプル 14",
      duration_minutes: 45
    });
    expect(count("SELECT COUNT(*) AS count FROM slot_locks WHERE owner_id = ?", result.reservationId)).toBe(10);
    expect(count("SELECT COUNT(*) AS count FROM customer_time_locks WHERE owner_id = ?", result.reservationId)).toBe(10);
  });

  it("keeps an existing LINE customer with visit history pending (全予約承認制: 自動確定しない)", async () => {
    d1.sqlite.exec(`
      INSERT INTO customers (id, display_name, phone_normalized, phone_hash)
      VALUES ('customer_existing', '既存 顧客', '0751234567', 'phone_hash_existing');

      INSERT INTO line_identities (id, customer_id, channel_id, line_user_id, friend_flag, official_friend_status)
      VALUES ('line_identity_existing', 'customer_existing', 'line_channel_id', 'line_user_1', 1, 'friend');

      INSERT INTO customer_visits (id, customer_id, store_id, visited_at, visit_source, status, recorded_by)
      VALUES ('visit_existing', 'customer_existing', 'kyoto', '2026-05-01T01:00:00.000Z', 'manual_import', 'valid', 'system');
    `);

    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest(),
      line: lineContext,
      env: { LINE_OPERATIONS_USER_IDS: OWNER_A },
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });

    expect(result).toMatchObject({
      ok: true,
      status: "pending_approval",
      replayed: false
    });
    if (!result.ok) {
      throw new Error(result.reason);
    }

    const reservation = d1.sqlite
      .prepare("SELECT pending_expires_at FROM reservations WHERE id = ?")
      .get(result.reservationId) as { pending_expires_at: string | null };
    expect(reservation.pending_expires_at).not.toBeNull();
    expect(count("SELECT COUNT(*) AS count FROM slot_locks WHERE owner_id = ? AND lock_status = 'pending'", result.reservationId)).toBe(13);
    // 既存客 (来店歴あり) には新規客通知ではなく、通常の承認待ち owner 通知を積む。
    expect(
      count(
        "SELECT COUNT(*) AS count FROM notification_jobs WHERE reservation_id = ? AND template_key = 'pending_approval_created' AND recipient_id = ?",
        result.reservationId,
        OWNER_EMAIL_RECIPIENT_ID
      )
    ).toBe(1);
    expect(
      count(
        "SELECT COUNT(*) AS count FROM notification_jobs WHERE reservation_id = ? AND template_key = 'reservation_new_customer'",
        result.reservationId
      )
    ).toBe(0);
  });

  // Seed the existing auto-confirm customer (line_user_1) plus `n` confirmed future
  // reservations, so a subsequent public submit exercises the per-customer cap.
  const seedExistingCustomerWithConfirmed = (n: number) => {
    d1.sqlite.exec(`
      INSERT INTO customers (id, display_name, phone_normalized, phone_hash)
      VALUES ('customer_existing', '既存 顧客', '0751234567', 'phone_hash_existing');

      INSERT INTO line_identities (id, customer_id, channel_id, line_user_id, friend_flag, official_friend_status)
      VALUES ('line_identity_existing', 'customer_existing', 'line_channel_id', 'line_user_1', 1, 'friend');

      INSERT INTO customer_visits (id, customer_id, store_id, visited_at, visit_source, status, recorded_by)
      VALUES ('visit_existing', 'customer_existing', 'kyoto', '2026-05-01T01:00:00.000Z', 'manual_import', 'valid', 'system');
    `);
    for (let i = 0; i < n; i += 1) {
      const month = String(7 + i).padStart(2, "0"); // 2026-07, -08, -09 … all future vs the 2023 submit clock
      d1.sqlite
        .prepare(
          `INSERT INTO reservations (
             id, store_id, service_id, customer_id, resource_id, source, status,
             start_at, end_at, duration_minutes, idempotency_key, updated_at
           ) VALUES (?, 'kyoto', 'service_kyoto_default_60', 'customer_existing', 'resource_kyoto_calendar',
                     'web_line', 'confirmed', ?, ?, 60, ?, '2023-11-14T00:00:00.000Z')`
        )
        .run(`seed_resv_${i}`, `2026-${month}-10T01:00:00.000Z`, `2026-${month}-10T02:00:00.000Z`, `seed_idem_${i}`);
    }
  };

  it("blocks a public submit that would exceed the per-customer cap (reservation_limit_reached → 409)", async () => {
    seedExistingCustomerWithConfirmed(1); // seeded store cap is 1

    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest({ idempotencyKey: "cap_block", startAt: "2026-06-01T01:00:00.000Z" }),
      line: lineContext,
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });

    expect(result).toEqual({ ok: false, reason: "reservation_limit_reached" });
    expect(statusForPublicReservationResult(result)).toBe(409);
    // The whole batch rolled back: no 2nd reservation, no orphaned locks or idempotency row.
    expect(count("SELECT COUNT(*) AS count FROM reservations WHERE customer_id = 'customer_existing'")).toBe(1);
    expect(count("SELECT COUNT(*) AS count FROM slot_locks")).toBe(0);
    expect(count("SELECT COUNT(*) AS count FROM idempotency_keys")).toBe(0);
  });

  it("replays a prior success without re-applying the cap, and rejects a key/content mismatch", async () => {
    seedExistingCustomerWithConfirmed(0); // one slot left under the seeded cap of 1

    const first = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest({ idempotencyKey: "cap_replay", startAt: "2026-06-01T01:00:00.000Z" }),
      line: lineContext,
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });
    expect(first).toMatchObject({ ok: true, replayed: false });

    // Same key + identical content replays the cached success even though the customer
    // is now at the cap (idempotency short-circuits before the insert/trigger).
    const replay = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest({ idempotencyKey: "cap_replay", startAt: "2026-06-01T01:00:00.000Z" }),
      line: lineContext,
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });
    expect(replay).toMatchObject({ ok: true, replayed: true });

    // Same key, different content → idempotency conflict (resolved before the cap).
    const conflict = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest({ idempotencyKey: "cap_replay", startAt: "2026-06-02T01:00:00.000Z" }),
      line: lineContext,
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });
    expect(conflict).toEqual({ ok: false, reason: "idempotency_conflict" });
  });

  it("rejects an existing blocked LINE customer before creating reservation rows", async () => {
    d1.sqlite.exec(`
      INSERT INTO customers (id, display_name, phone_normalized, phone_hash, block_status)
      VALUES ('customer_blocked', 'ブロック 顧客', '0751234567', 'phone_hash_blocked', 'blocked');

      INSERT INTO line_identities (id, customer_id, channel_id, line_user_id, friend_flag, official_friend_status)
      VALUES ('line_identity_blocked', 'customer_blocked', 'line_channel_id', 'line_user_1', 1, 'friend');
    `);

    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest(),
      line: lineContext,
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });

    expect(result).toEqual({
      ok: false,
      reason: "invalid_request"
    });
    expect(count("SELECT COUNT(*) AS count FROM reservations")).toBe(0);
    expect(count("SELECT COUNT(*) AS count FROM slot_locks")).toBe(0);
    expect(count("SELECT COUNT(*) AS count FROM audit_logs")).toBe(0);
  });

  it("rejects a blocked customer matched by phone before linking a new LINE identity", async () => {
    const phoneHash = await sha256Hex("0751234567");
    d1.sqlite
      .prepare(
        `
          INSERT INTO customers (id, display_name, phone_normalized, phone_hash, block_status)
          VALUES ('customer_blocked_phone', 'ブロック 電話', '0751234567', ?, 'blocked')
        `
      )
      .run(phoneHash);

    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest({
        idempotencyKey: "public_submit_blocked_phone"
      }),
      line: {
        lineUserId: "line_user_new_for_blocked_phone",
        channelId: "line_channel_id"
      },
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });

    expect(result).toEqual({
      ok: false,
      reason: "invalid_request"
    });
    expect(count("SELECT COUNT(*) AS count FROM reservations")).toBe(0);
    expect(count("SELECT COUNT(*) AS count FROM line_identities")).toBe(0);
    expect(count("SELECT COUNT(*) AS count FROM customers")).toBe(1);
  });

  it("rejects an existing active LINE customer when the submitted phone belongs to a blocked customer", async () => {
    const blockedPhoneHash = await sha256Hex("0759999999");
    d1.sqlite
      .prepare(
        `
          INSERT INTO customers (id, display_name, phone_normalized, phone_hash, block_status)
          VALUES ('customer_existing_active', '既存 顧客', '0751234567', 'phone_hash_existing_active', 'active')
        `
      )
      .run();
    d1.sqlite
      .prepare(
        `
          INSERT INTO line_identities (id, customer_id, channel_id, line_user_id, friend_flag, official_friend_status)
          VALUES ('line_identity_existing_active', 'customer_existing_active', 'line_channel_id', 'line_user_1', 1, 'friend')
        `
      )
      .run();
    d1.sqlite
      .prepare(
        `
          INSERT INTO customers (id, display_name, phone_normalized, phone_hash, block_status)
          VALUES ('customer_blocked_duplicate_phone', 'ブロック 重複電話', '0759999999', ?, 'blocked')
        `
      )
      .run(blockedPhoneHash);

    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest({
        idempotencyKey: "public_submit_existing_line_blocked_phone",
        customer: {
          displayName: "既存 顧客",
          displayNameKana: "キソン コキャク",
          phone: "075-999-9999"
        }
      }),
      line: lineContext,
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });

    expect(result).toEqual({
      ok: false,
      reason: "invalid_request"
    });
    expect(count("SELECT COUNT(*) AS count FROM reservations")).toBe(0);
    expect(count("SELECT COUNT(*) AS count FROM slot_locks")).toBe(0);
  });

  it("does not attach a new LINE identity to an active customer matched only by phone", async () => {
    const phoneHash = await sha256Hex("0751234567");
    d1.sqlite
      .prepare(
        `
          INSERT INTO customers (id, display_name, phone_normalized, phone_hash, block_status)
          VALUES ('customer_active_phone', '既存 電話', '0751234567', ?, 'active')
        `
      )
      .run(phoneHash);

    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest({
        idempotencyKey: "public_submit_active_phone"
      }),
      line: {
        lineUserId: "line_user_new_for_active_phone",
        channelId: "line_channel_id"
      },
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });

    expect(result).toMatchObject({
      ok: true,
      status: "pending_approval"
    });
    const lineIdentity = d1.sqlite
      .prepare("SELECT customer_id FROM line_identities WHERE line_user_id = 'line_user_new_for_active_phone'")
      .get() as { customer_id: string };
    expect(lineIdentity.customer_id).not.toBe("customer_active_phone");
    expect(count("SELECT COUNT(*) AS count FROM customers")).toBe(2);
  });

  it("rolls back the whole reservation when any resource slot is already locked", async () => {
    d1.sqlite.exec(`
      INSERT INTO slot_locks (id, store_id, resource_id, slot_at, owner_type, owner_id, lock_status)
      VALUES ('existing_lock', 'kyoto', 'resource_kyoto_calendar', '2026-06-01T01:15:00.000Z', 'admin_hold', 'admin_hold_1', 'confirmed');
    `);

    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest(),
      line: lineContext,
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });

    expect(result).toEqual({
      ok: false,
      reason: "slot_unavailable"
    });
    expect(count("SELECT COUNT(*) AS count FROM reservations")).toBe(0);
    expect(count("SELECT COUNT(*) AS count FROM customers")).toBe(0);
    expect(captureBatchWriteFailure).not.toHaveBeenCalled();
  });

  it("captures an unclassified public-submit batch failure", async () => {
    const db = d1 as unknown as D1Database;
    const batchError = new Error("simulated unexpected batch failure");
    vi.spyOn(db, "batch").mockRejectedValueOnce(batchError);

    const result = await createPublicReservation({
      db,
      request: createRequest({ idempotencyKey: "public_submit_unclassified_batch" }),
      line: lineContext,
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });

    expect(result).toEqual({ ok: false, reason: "write_failed" });
    expect(captureBatchWriteFailure).toHaveBeenCalledTimes(1);
    expect(captureBatchWriteFailure).toHaveBeenCalledWith(batchError, {
      component: "public-submit",
      op: "batch_write_failed",
      helper: "createPublicReservation"
    });
  });

  it("returns store_closed when a closure is committed after the availability precheck", async () => {
    const originalBatch = d1.batch.bind(d1);
    let injected = false;
    d1.batch = async (statements) => {
      if (!injected) {
        injected = true;
        d1.sqlite
          .prepare(
            `INSERT INTO store_closures (id, store_id, starts_at, ends_at, source)
             VALUES ('closure_public_race', 'kyoto',
                     '2026-06-01T01:00:00.000Z', '2026-06-01T02:00:00.000Z', 'admin')`
          )
          .run();
      }
      return originalBatch(statements);
    };

    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest({ idempotencyKey: "public_submit_closure_race" }),
      line: lineContext,
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });

    expect(result).toEqual({ ok: false, reason: "store_closed" });
    expect(count("SELECT COUNT(*) AS count FROM reservations")).toBe(0);
    expect(captureBatchWriteFailure).not.toHaveBeenCalled();
  });

  it("rejects closed weekdays and past start times before writing reservation rows", async () => {
    const closedDay = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest({
        startAt: "2026-06-05T01:00:00.000Z"
      }),
      line: lineContext,
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });

    expect(closedDay).toEqual({
      ok: false,
      reason: "outside_business_hours"
    });

    const pastTime = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest({
        idempotencyKey: "public_submit_past",
        startAt: "2026-06-01T01:00:00.000Z"
      }),
      line: lineContext,
      now: () => 1_790_000_000_000
    });

    expect(pastTime).toEqual({
      ok: false,
      reason: "invalid_time"
    });
    expect(count("SELECT COUNT(*) AS count FROM reservations")).toBe(0);
  });

  it("rejects overlapping bookings for the same customer even in another store", async () => {
    d1.sqlite.exec(`
      INSERT INTO customers (id, display_name)
      VALUES ('customer_existing', '既存 顧客');

      INSERT INTO line_identities (id, customer_id, channel_id, line_user_id, friend_flag, official_friend_status)
      VALUES ('line_identity_existing', 'customer_existing', 'line_channel_id', 'line_user_1', 1, 'friend');

      INSERT INTO customer_time_locks (id, customer_id, slot_at, owner_type, owner_id, lock_status)
      VALUES ('existing_customer_lock', 'customer_existing', '2026-06-01T01:30:00.000Z', 'reservation', 'reservation_other_store', 'confirmed');
    `);

    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest(),
      line: lineContext,
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });

    expect(result).toEqual({
      ok: false,
      reason: "customer_time_conflict"
    });
    expect(count("SELECT COUNT(*) AS count FROM reservations")).toBe(0);
  });

  it("returns the original reservation for a same-key idempotent replay", async () => {
    const first = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest(),
      line: lineContext,
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });
    const second = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest(),
      line: lineContext,
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });

    expect(first.ok).toBe(true);
    expect(second).toEqual({
      ...first,
      replayed: true
    });
    expect(count("SELECT COUNT(*) AS count FROM reservations")).toBe(1);
  });

  it("allows a second active pending reservation for the same LINE identity (1件制限は撤廃)", async () => {
    d1.sqlite.exec(`
      UPDATE store_settings
      SET max_active_reservations_per_customer = 2
      WHERE store_id = 'kyoto';

      INSERT INTO customers (id, display_name)
      VALUES ('customer_existing', '既存 顧客');

      INSERT INTO line_identities (id, customer_id, channel_id, line_user_id, friend_flag, official_friend_status)
      VALUES ('line_identity_existing', 'customer_existing', 'line_channel_id', 'line_user_1', 1, 'friend');

      INSERT INTO reservations (
        id,
        store_id,
        service_id,
        customer_id,
        resource_id,
        line_identity_id,
        source,
        status,
        start_at,
        end_at,
        duration_minutes,
        idempotency_key
      ) VALUES (
        'reservation_pending_existing',
        'kyoto',
        'service_kyoto_default_60',
        'customer_existing',
        'resource_kyoto_calendar',
        'line_identity_existing',
        'web_line',
        'pending_approval',
        '2026-06-02T01:00:00.000Z',
        '2026-06-02T02:00:00.000Z',
        60,
        'existing_pending_idempotency'
      );
    `);

    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest(),
      line: lineContext,
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });

    // 全予約承認制に伴い「承認待ち1人1件まで」の unique index は撤廃 (migration 0040)。
    // 上限は per-customer cap (このテストでは明示2件、confirmed + 未失効 pending 合算) が引き続き担う。
    expect(result).toMatchObject({
      ok: true,
      status: "pending_approval"
    });
    expect(count("SELECT COUNT(*) AS count FROM reservations")).toBe(2);
    expect(count("SELECT COUNT(*) AS count FROM reservations WHERE status = 'pending_approval'")).toBe(2);
  });

  it("rejects reuse of an idempotency key for a different reservation request", async () => {
    await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest(),
      line: lineContext,
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });

    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest({
        startAt: "2026-06-01T02:00:00.000Z"
      }),
      line: lineContext,
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });

    expect(result).toEqual({
      ok: false,
      reason: "idempotency_conflict"
    });
  });

  it("allows different LINE identities to use the same public idempotency key independently", async () => {
    const first = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest({
        idempotencyKey: "shared_public_key"
      }),
      line: lineContext,
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });
    const secondLine = {
      lineUserId: "line_user_2",
      channelId: "line_channel_id"
    };
    const second = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest({
        idempotencyKey: "shared_public_key",
        startAt: "2026-06-01T03:00:00.000Z"
      }),
      line: secondLine,
      now: () => Date.parse("2026-05-09T23:00:00.000Z")
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(count("SELECT COUNT(*) AS count FROM reservations")).toBe(2);
    expect(count("SELECT COUNT(*) AS count FROM idempotency_keys WHERE idempotency_key = ?", await idempotencyStorageKey("shared_public_key", lineContext))).toBe(1);
    expect(count("SELECT COUNT(*) AS count FROM idempotency_keys WHERE idempotency_key = ?", await idempotencyStorageKey("shared_public_key", secondLine))).toBe(1);
  });

  describe("Google live availability check on submit", () => {
    const GOOGLE_ENABLED_ENV: Partial<WorkerBindings> = {
      GOOGLE_IMPORT_ENABLED: "true",
      GOOGLE_LIVE_AVAILABILITY_ENABLED: "true",
      GOOGLE_SERVICE_ACCOUNT_EMAIL: "sa@example.iam.gserviceaccount.com",
      GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
    };

    const GOOGLE_DISABLED_ENV: Partial<WorkerBindings> = {
      GOOGLE_IMPORT_ENABLED: "true",
      GOOGLE_LIVE_AVAILABILITY_ENABLED: "false"
    };

    const mockAccessTokenProvider = async (_env: Partial<WorkerBindings>) => "test_access_token";

    const createGoogleMockFetcher = (
      eventsResponse: Response | "error",
      freebusyResponse: Response | "error"
    ) => {
      return vi.fn(async (url: string | URL | Request) => {
        const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
        if (urlStr.includes("/events")) {
          if (eventsResponse === "error") throw new Error("network error");
          return eventsResponse.clone();
        }
        if (urlStr.includes("/freeBusy")) {
          if (freebusyResponse === "error") throw new Error("network error");
          return freebusyResponse.clone();
        }
        throw new Error("unexpected url: " + urlStr);
      }) as unknown as typeof fetch;
    };

    beforeEach(() => {
      _resetCacheForTesting();
    });

    afterEach(() => {
      _resetCacheForTesting();
    });

    it("rejects submit when Google reports the slot as busy", async () => {
      const fetcher = createGoogleMockFetcher(
        Response.json({
          items: [
            {
              id: "blocking_event",
              status: "confirmed",
              transparency: "opaque",
              start: { dateTime: "2026-06-01T01:00:00Z" },
              end: { dateTime: "2026-06-01T02:00:00Z" }
            }
          ]
        }),
        Response.json({
          calendars: {
            "calendar-a@example.invalid": {
              busy: [{ start: "2026-06-01T01:00:00Z", end: "2026-06-01T02:00:00Z" }]
            }
          }
        })
      );

      const result = await createPublicReservation({
        db: d1 as unknown as D1Database,
        env: GOOGLE_ENABLED_ENV,
        request: createRequest({ idempotencyKey: "google_busy_reject_1" }),
        line: lineContext,
        now: () => Date.parse("2026-05-09T23:00:00.000Z"),
        fetcher,
        accessTokenProvider: mockAccessTokenProvider
      });

      expect(result).toMatchObject({
        ok: false,
        reason: "slot_unavailable"
      });
      expect(count("SELECT COUNT(*) AS count FROM reservations")).toBe(0);
    });

    it("rejects submit when Google API fails (fail-closed)", async () => {
      const fetcher = createGoogleMockFetcher("error", "error");

      const result = await createPublicReservation({
        db: d1 as unknown as D1Database,
        env: GOOGLE_ENABLED_ENV,
        request: createRequest({ idempotencyKey: "google_api_error_1" }),
        line: lineContext,
        now: () => Date.parse("2026-05-09T23:00:00.000Z"),
        fetcher,
        accessTokenProvider: mockAccessTokenProvider
      });

      expect(result).toMatchObject({
        ok: false,
        reason: "slot_unavailable"
      });
      expect(count("SELECT COUNT(*) AS count FROM reservations")).toBe(0);
    });

    it("allows submit normally when Google live check flag is disabled", async () => {
      const result = await createPublicReservation({
        db: d1 as unknown as D1Database,
        env: GOOGLE_DISABLED_ENV,
        request: createRequest({ idempotencyKey: "google_disabled_submit_1" }),
        line: lineContext,
        now: () => Date.parse("2026-05-09T23:00:00.000Z")
      });

      expect(result).toMatchObject({
        ok: true,
        status: "pending_approval"
      });
      expect(count("SELECT COUNT(*) AS count FROM reservations")).toBe(1);
    });

    it("allows submit when Google reports the slot as free", async () => {
      const fetcher = createGoogleMockFetcher(
        Response.json({ items: [] }),
        Response.json({
          calendars: { "calendar-a@example.invalid": { busy: [] } }
        })
      );

      const result = await createPublicReservation({
        db: d1 as unknown as D1Database,
        env: GOOGLE_ENABLED_ENV,
        request: createRequest({ idempotencyKey: "google_free_submit_1" }),
        line: lineContext,
        now: () => Date.parse("2026-05-09T23:00:00.000Z"),
        fetcher,
        accessTokenProvider: mockAccessTokenProvider
      });

      expect(result).toMatchObject({
        ok: true,
        status: "pending_approval"
      });
      expect(count("SELECT COUNT(*) AS count FROM reservations")).toBe(1);
    });
  });
});
