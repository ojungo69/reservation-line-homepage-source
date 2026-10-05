import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createPublicReservation,
  getUpcomingReservations,
  type PublicReservationRequest,
  type VerifiedLineContext
} from "../src/reservations/public-submit";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

// "Now" for these tests. Reservations/locks bind updated_at and the duplicate lookup
// compares start_at / pending_expires_at against this instant — exactly like the cap
// trigger — so behaviour is deterministic regardless of the wall clock.
const NOW = "2026-05-31T00:00:00.000Z";
const FUTURE_FAR = "2026-08-01T03:00:00.000Z"; // > 24h ahead → soft
const FUTURE_FAR_2 = "2026-08-02T03:00:00.000Z";
const FUTURE_NEAR = "2026-05-31T18:00:00.000Z"; // < 24h ahead → hard
const PAST = "2026-01-01T03:00:00.000Z";

let seq = 0;
const uid = (prefix: string) => `${prefix}_${(seq += 1)}`;

const sha256Hex = (value: string) =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(value))
    .then((bytes) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join(""));

const seedStore = (d1: SqliteD1Database, storeId: string) => {
  d1.sqlite.prepare(`INSERT INTO stores (id, name, timezone) VALUES (?, ?, 'Asia/Tokyo')`).run(storeId, `店舗${storeId}`);
  d1.sqlite
    .prepare(
      `INSERT INTO store_settings (store_id, reservation_approval_mode, max_active_reservations_per_customer)
       VALUES (?, 'manual', 50)`
    )
    .run(storeId);
  d1.sqlite.prepare(`INSERT INTO store_resources (id, store_id, name) VALUES (?, ?, 'R')`).run(`res_${storeId}`, storeId);
  d1.sqlite
    .prepare(`INSERT INTO services (id, store_id, name, duration_minutes) VALUES (?, ?, 'カット', 60)`)
    .run(`svc_${storeId}`, storeId);
};

const seedCustomer = (d1: SqliteD1Database, customerId: string) => {
  d1.sqlite
    .prepare(
      `INSERT INTO customers (id, display_name, phone_normalized, phone_hash, block_status)
       VALUES (?, '太郎', ?, ?, 'active')`
    )
    .run(customerId, `070${customerId}`, customerId);
};

type ResOpts = {
  storeId: string;
  customerId: string;
  status?: string;
  startAt?: string;
  pendingExpiresAt?: string | null;
};

const insertReservation = (d1: SqliteD1Database, opts: ResOpts) => {
  const id = uid("resv");
  const start = opts.startAt ?? FUTURE_FAR;
  d1.sqlite
    .prepare(
      `INSERT INTO reservations (
         id, store_id, service_id, customer_id, resource_id, source, status,
         start_at, end_at, duration_minutes, pending_expires_at, idempotency_key, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'web_line', ?, ?, ?, 60, ?, ?, ?)`
    )
    .run(
      id,
      opts.storeId,
      `svc_${opts.storeId}`,
      opts.customerId,
      `res_${opts.storeId}`,
      opts.status ?? "confirmed",
      start,
      start.replace("T03:", "T04:").replace("T18:", "T19:"),
      opts.pendingExpiresAt ?? null,
      uid("idem"),
      NOW
    );
  return id;
};

describe("getUpcomingReservations — active-future definition matches trg_reservations_web_cap", () => {
  let d1: SqliteD1Database;
  beforeEach(() => {
    d1 = createMigratedSqliteD1();
    seq = 0;
    seedStore(d1, "s1");
    seedCustomer(d1, "c1");
  });
  afterEach(() => d1.sqlite.close());

  const list = (customerId: string | null | undefined = "c1", now = NOW, limit?: number) =>
    getUpcomingReservations(d1 as unknown as D1Database, customerId, now, limit);

  it("returns confirmed future reservations", async () => {
    const id = insertReservation(d1, { storeId: "s1", customerId: "c1", startAt: FUTURE_FAR });
    const result = await list();
    expect(result.map((r) => r.reservationId)).toEqual([id]);
    expect(result[0].storeName).toBe("店舗s1");
    expect(result[0].serviceName).toBe("カット");
    // LIFF の重複警告文言分岐 (「既に確定している」と断定してよいか) に使う。
    expect(result[0].status).toBe("confirmed");
  });

  it("includes a live (un-expired / NULL-expiry) pending_approval reservation", async () => {
    insertReservation(d1, { storeId: "s1", customerId: "c1", status: "pending_approval", pendingExpiresAt: null });
    insertReservation(d1, {
      storeId: "s1",
      customerId: "c1",
      status: "pending_approval",
      startAt: FUTURE_FAR_2,
      pendingExpiresAt: "2026-06-01T00:00:00.000Z"
    });
    const result = await list();
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.status)).toEqual(["pending_approval", "pending_approval"]);
  });

  it("excludes a pending_approval reservation whose window has expired (the trigger's distinguishing rule)", async () => {
    insertReservation(d1, {
      storeId: "s1",
      customerId: "c1",
      status: "pending_approval",
      pendingExpiresAt: PAST
    });
    expect(await list()).toHaveLength(0);
  });

  it("excludes past, cancelled, rejected, expired, completed and no_show reservations", async () => {
    insertReservation(d1, { storeId: "s1", customerId: "c1", startAt: PAST, status: "confirmed" });
    for (const status of ["cancelled_by_customer", "rejected", "expired", "completed", "no_show"]) {
      insertReservation(d1, { storeId: "s1", customerId: "c1", startAt: FUTURE_FAR, status });
    }
    expect(await list()).toHaveLength(0);
  });

  it("counts reservations across all stores", async () => {
    seedStore(d1, "s2");
    insertReservation(d1, { storeId: "s1", customerId: "c1", startAt: FUTURE_FAR });
    insertReservation(d1, { storeId: "s2", customerId: "c1", startAt: FUTURE_FAR_2 });
    const result = await list();
    expect(result).toHaveLength(2);
    expect(new Set(result.map((r) => r.storeId))).toEqual(new Set(["s1", "s2"]));
  });

  it("does not return another customer's reservations (customer_id scope)", async () => {
    seedCustomer(d1, "c2");
    insertReservation(d1, { storeId: "s1", customerId: "c2", startAt: FUTURE_FAR });
    expect(await list("c1")).toHaveLength(0);
  });

  it("returns [] for a null/undefined customerId (new customer, no customer_id yet)", async () => {
    insertReservation(d1, { storeId: "s1", customerId: "c1", startAt: FUTURE_FAR });
    // Call directly (not via the `list` helper) so an explicit `undefined` is not
    // swallowed by the helper's default-parameter value.
    expect(await getUpcomingReservations(d1 as unknown as D1Database, null, NOW)).toHaveLength(0);
    expect(await getUpcomingReservations(d1 as unknown as D1Database, undefined, NOW)).toHaveLength(0);
  });

  it("respects the limit", async () => {
    for (let i = 0; i < 5; i += 1) {
      insertReservation(d1, { storeId: "s1", customerId: "c1", startAt: `2026-08-0${i + 1}T03:00:00.000Z` });
    }
    expect(await list("c1", NOW, 3)).toHaveLength(3);
  });

  it("flags isWithinLeadTime for reservations starting within the 24h change-request lead time", async () => {
    insertReservation(d1, { storeId: "s1", customerId: "c1", startAt: FUTURE_NEAR }); // 18h ahead → hard
    insertReservation(d1, { storeId: "s1", customerId: "c1", startAt: FUTURE_FAR }); // far → soft
    const byStart = (await list()).sort((a, b) => a.startAt.localeCompare(b.startAt));
    expect(byStart[0].isWithinLeadTime).toBe(true);
    expect(byStart[1].isWithinLeadTime).toBe(false);
  });

  it("always reports cancelBlocked=true and keeps the 24h hard-warning boundary in isWithinLeadTime", async () => {
    // キャンセル申請機能の廃止 (2026-08-01) 後、顧客の自己キャンセル手段は無い。
    // cancelBlocked は旧クライアント互換のフィールドとして常に true。
    const near = insertReservation(d1, { storeId: "s1", customerId: "c1", startAt: FUTURE_NEAR });
    const far = insertReservation(d1, { storeId: "s1", customerId: "c1", startAt: FUTURE_FAR });
    const byId = new Map((await list()).map((row) => [row.reservationId, row]));
    expect(byId.get(near)?.cancelBlocked).toBe(true);
    expect(byId.get(near)?.isWithinLeadTime).toBe(true);
    expect(byId.get(far)?.cancelBlocked).toBe(true);
    expect(byId.get(far)?.isWithinLeadTime).toBe(false);
  });

  it("matches the trigger: count equals what trg_reservations_web_cap would count for the same customer/now", async () => {
    // Mix of active-future, expired pending, and terminal rows. getUpcomingReservations
    // must agree with the trigger's COUNT(*) (3 active-future here).
    insertReservation(d1, { storeId: "s1", customerId: "c1", startAt: FUTURE_FAR, status: "confirmed" });
    insertReservation(d1, { storeId: "s1", customerId: "c1", startAt: FUTURE_NEAR, status: "pending_approval", pendingExpiresAt: null });
    insertReservation(d1, { storeId: "s1", customerId: "c1", startAt: FUTURE_FAR_2, status: "confirmed" });
    insertReservation(d1, { storeId: "s1", customerId: "c1", startAt: FUTURE_FAR, status: "pending_approval", pendingExpiresAt: PAST });
    insertReservation(d1, { storeId: "s1", customerId: "c1", startAt: PAST, status: "confirmed" });
    const triggerCount = (
      d1.sqlite
        .prepare(
          `SELECT COUNT(*) AS count FROM reservations r
           WHERE r.customer_id = 'c1'
             AND datetime(r.start_at) > datetime(?)
             AND ( r.status = 'confirmed'
                   OR ( r.status = 'pending_approval'
                        AND (r.pending_expires_at IS NULL OR datetime(r.pending_expires_at) > datetime(?)) ) )`
        )
        .get(NOW, NOW) as { count: number }
    ).count;
    expect(await list()).toHaveLength(triggerCount);
    expect(triggerCount).toBe(3);
  });
});

describe("createPublicReservation — duplicate-reservation acknowledgement gate", () => {
  let d1: SqliteD1Database;
  beforeEach(() => {
    d1 = createMigratedSqliteD1();
    seq = 0;
  });
  afterEach(() => d1.sqlite.close());

  const lineContext: VerifiedLineContext = { lineUserId: "line_user_1", channelId: "line_channel_id" };
  const DUP_VERSION = "dup-warning-2026-08-31";

  // Seeds an existing LINE customer with one ACTIVE FUTURE reservation in the kyoto store
  // (which seeds/dev.sql provides), so the customer already "holds" a reservation.
  const seedExistingWithReservation = async (customerId = "cust_dup", phone = "09012345678") => {
    d1.sqlite
      .prepare(
        "UPDATE store_settings SET max_active_reservations_per_customer = 2 WHERE store_id = 'kyoto'"
      )
      .run();
    const phoneHash = await sha256Hex(phone);
    d1.sqlite
      .prepare(
        `INSERT INTO customers (id, display_name, display_name_kana, phone_normalized, phone_hash, block_status, updated_at)
         VALUES (?, '山田 花子', 'ヤマダ ハナコ', ?, ?, 'active', '2026-01-01T00:00:00.000Z')`
      )
      .run(customerId, phone, phoneHash);
    d1.sqlite
      .prepare(
        `INSERT INTO line_identities (id, customer_id, provider, channel_id, line_user_id, friend_flag, official_friend_status, last_friend_checked_at, updated_at)
         VALUES (?, ?, 'line', ?, ?, 1, 'friend', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run(`li-${customerId}`, customerId, lineContext.channelId, lineContext.lineUserId);
    d1.sqlite
      .prepare(
        `INSERT INTO reservations (
           id, store_id, service_id, customer_id, resource_id, source, status,
           start_at, end_at, duration_minutes, idempotency_key, updated_at
         ) VALUES ('existing_resv', 'kyoto', 'service_kyoto_default_60', ?, 'resource_kyoto_calendar', 'web_line', 'confirmed',
                   '2026-08-01T03:00:00.000Z', '2026-08-01T04:00:00.000Z', 60, 'existing_idem', '2026-05-09T00:00:00.000Z')`
      )
      .run(customerId);
  };

  const NOW_SUBMIT = () => Date.parse("2026-05-09T23:00:00.000Z");

  const createRequest = (overrides: Partial<PublicReservationRequest> = {}): PublicReservationRequest => ({
    idempotencyKey: "dup_submit_1",
    storeId: "kyoto",
    serviceId: "service_kyoto_default_60",
    resourceId: "resource_kyoto_calendar",
    startAt: "2026-06-01T01:00:00.000Z",
    customer: { displayName: "予約 太郎", displayNameKana: "ヨヤク タロウ", phone: "075-123-4567" },
    consents: {
      noticeVersion: "notice-terms-2026-06",
      cancellationPolicyVersion: "cancel-2026-08-31",
      privacyPolicyVersion: "privacy-2026-06"
    },
    ...overrides
  });

  const count = (sql: string, ...values: (string | number)[]) =>
    (d1.sqlite.prepare(sql).get(...values) as { count: number }).count;

  it("rejects a new booking with duplicate_reservation_consent_required when the customer already holds a reservation and the acknowledgement is missing", async () => {
    await seedExistingWithReservation();
    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      env: {},
      request: createRequest({ customer: undefined }),
      line: lineContext,
      now: NOW_SUBMIT
    });
    expect(result).toEqual({ ok: false, reason: "duplicate_reservation_consent_required" });
    // Nothing written: no new reservation, no lock, no idempotency, no audit row.
    expect(count("SELECT COUNT(*) AS count FROM reservations")).toBe(1); // only the pre-seeded one
    expect(count("SELECT COUNT(*) AS count FROM slot_locks")).toBe(0);
    expect(count("SELECT COUNT(*) AS count FROM idempotency_keys")).toBe(0);
    expect(count("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'public_reservation_duplicate_consent'")).toBe(0);
  });

  it("creates the booking and records a duplicate-consent audit row when the acknowledgement version is correct", async () => {
    await seedExistingWithReservation();
    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      env: {},
      request: createRequest({
        customer: undefined,
        consents: {
          noticeVersion: "notice-terms-2026-06",
          cancellationPolicyVersion: "cancel-2026-08-31",
          privacyPolicyVersion: "privacy-2026-06",
          duplicateReservationWarningVersion: DUP_VERSION
        }
      }),
      line: lineContext,
      now: NOW_SUBMIT
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(count("SELECT COUNT(*) AS count FROM reservations")).toBe(2);
    const audit = d1.sqlite
      .prepare(
        `SELECT actor_type, actor_id, target_id, metadata_json
         FROM audit_logs WHERE action = 'public_reservation_duplicate_consent'`
      )
      .get() as { actor_type: string; actor_id: string; target_id: string; metadata_json: string };
    expect(audit.actor_type).toBe("customer");
    expect(audit.actor_id).toBe("li-cust_dup");
    expect(audit.target_id).toBe(result.reservationId);
    const meta = JSON.parse(audit.metadata_json);
    expect(meta.stage).toBe("soft"); // existing reservation is 2026-08-01, far beyond 24h
    expect(meta.warningVersion).toBe(DUP_VERSION);
    expect(meta.consentedAt).toBe("2026-05-09T23:00:00.000Z");
    expect(meta.customerId).toBe("cust_dup");
    expect(meta.existingReservations).toEqual([
      // status は同意時点のスナップショット (どちらの警告文言を見たかの証跡)。
      { reservationId: "existing_resv", storeId: "kyoto", startAt: "2026-08-01T03:00:00.000Z", status: "confirmed" }
    ]);
    // PII-minimal: evidence must not leak contact details.
    expect(audit.metadata_json).not.toContain("09012345678");
    expect(audit.metadata_json).not.toContain("花子");
  });

  it("rejects a forged/stale acknowledgement version (consent forge guard)", async () => {
    await seedExistingWithReservation();
    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      env: {},
      request: createRequest({
        customer: undefined,
        consents: {
          noticeVersion: "notice-terms-2026-06",
          cancellationPolicyVersion: "cancel-2026-08-31",
          privacyPolicyVersion: "privacy-2026-06",
          duplicateReservationWarningVersion: "dup-warning-1999-01-01"
        }
      }),
      line: lineContext,
      now: NOW_SUBMIT
    });
    expect(result).toEqual({ ok: false, reason: "duplicate_reservation_consent_required" });
  });

  it("does not require an acknowledgement when the customer holds no active future reservation (no dup audit row)", async () => {
    // Existing customer, but their only reservation is in the past → not "upcoming".
    const phone = "09012345678";
    d1.sqlite
      .prepare(
        `INSERT INTO customers (id, display_name, display_name_kana, phone_normalized, phone_hash, block_status, updated_at)
         VALUES ('cust_clean', '山田 花子', 'ヤマダ ハナコ', ?, ?, 'active', '2026-01-01T00:00:00.000Z')`
      )
      .run(phone, await sha256Hex(phone));
    d1.sqlite
      .prepare(
        `INSERT INTO line_identities (id, customer_id, provider, channel_id, line_user_id, friend_flag, official_friend_status, last_friend_checked_at, updated_at)
         VALUES ('li-clean', 'cust_clean', 'line', ?, ?, 1, 'friend', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run(lineContext.channelId, lineContext.lineUserId);
    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      env: {},
      request: createRequest({ customer: undefined }),
      line: lineContext,
      now: NOW_SUBMIT
    });
    expect(result.ok).toBe(true);
    expect(count("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'public_reservation_duplicate_consent'")).toBe(0);
  });

  it("replays an already-created booking on retry without re-evaluating the duplicate gate", async () => {
    await seedExistingWithReservation();
    const request = createRequest({
      customer: undefined,
      idempotencyKey: "dup_replay_1",
      consents: {
        noticeVersion: "notice-terms-2026-06",
        cancellationPolicyVersion: "cancel-2026-08-31",
        privacyPolicyVersion: "privacy-2026-06",
        duplicateReservationWarningVersion: DUP_VERSION
      }
    });
    const first = await createPublicReservation({ db: d1 as unknown as D1Database, env: {}, request, line: lineContext, now: NOW_SUBMIT });
    const second = await createPublicReservation({
      db: d1 as unknown as D1Database,
      env: {},
      request,
      line: lineContext,
      now: () => Date.parse("2026-05-09T23:00:01.000Z")
    });
    expect(first.ok && second.ok).toBe(true);
    if (!second.ok) throw new Error(second.reason);
    expect(second.replayed).toBe(true);
    // Only one new booking + one dup-consent audit row (no duplication on replay).
    expect(count("SELECT COUNT(*) AS count FROM reservations")).toBe(2);
    expect(count("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'public_reservation_duplicate_consent'")).toBe(1);
  });

  it("fails CLOSED (write_failed) when the duplicate lookup errors, never waving the booking through", async () => {
    await seedExistingWithReservation();
    // Proxy the db so the duplicate-reservation query throws, while every other prepared
    // statement runs normally. The distinctive pending_expires_at clause is unique to
    // getUpcomingReservations among prepared (non-migration) statements.
    const throwingDb = new Proxy(d1 as unknown as D1Database, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql.includes("r.pending_expires_at IS NULL OR datetime(r.pending_expires_at)")) {
              throw new Error("simulated lookup failure");
            }
            return (target as unknown as { prepare: (s: string) => unknown }).prepare(sql);
          };
        }
        return Reflect.get(target, prop, receiver);
      }
    });
    const result = await createPublicReservation({
      db: throwingDb,
      env: {},
      request: createRequest({
        customer: undefined,
        consents: {
          noticeVersion: "notice-terms-2026-06",
          cancellationPolicyVersion: "cancel-2026-08-31",
          privacyPolicyVersion: "privacy-2026-06",
          duplicateReservationWarningVersion: DUP_VERSION
        }
      }),
      line: lineContext,
      now: NOW_SUBMIT
    });
    expect(result).toEqual({ ok: false, reason: "write_failed" });
    expect(count("SELECT COUNT(*) AS count FROM reservations")).toBe(1); // only pre-seeded
  });
});
