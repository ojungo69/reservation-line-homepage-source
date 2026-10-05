import { beforeEach, describe, expect, it, vi } from "vitest";

import { processDueLineNotificationJobs } from "../src/line/notifications";
import { expirePendingReservations } from "../src/reservations/expiration";
import { safeCaptureException } from "../src/sentry-helpers";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

vi.mock("../src/sentry-helpers", () => ({
  safeCaptureException: vi.fn()
}));

beforeEach(() => {
  vi.mocked(safeCaptureException).mockClear();
});

const CUSTOMER_ID = "customer_expiry_1";
const LINE_IDENTITY_ID = "line_identity_expiry_1";
const RESERVATION_ID = "reservation_expiry_1";
const START_AT = "2026-06-01T01:00:00.000Z";
const END_AT = "2026-06-01T02:00:00.000Z";
const DEFAULT_SLOT_TIMES = [
  "2026-06-01T01:00:00.000Z",
  "2026-06-01T01:15:00.000Z",
  "2026-06-01T01:30:00.000Z",
  "2026-06-01T01:45:00.000Z"
];

type TestSqlValue = string | number | null;

const insertBaseCustomer = (db: SqliteD1Database) => {
  db.sqlite
    .prepare(
      "UPDATE store_settings SET max_active_reservations_per_customer = 50 WHERE store_id = 'kyoto'"
    )
    .run();
  db.sqlite
    .prepare(
      `
        INSERT INTO customers (
          id,
          display_name,
          display_name_kana,
          phone_normalized,
          phone_hash,
          block_status,
          updated_at
        ) VALUES (?, '期限 太郎', 'キゲン タロウ', '0751234567', 'phone_hash_expiry_1', 'active', '2026-05-09T00:00:00.000Z')
      `
    )
    .run(CUSTOMER_ID);
  db.sqlite
    .prepare(
      `
        INSERT INTO line_identities (
          id,
          customer_id,
          channel_id,
          line_user_id,
          friend_flag,
          official_friend_status,
          last_friend_checked_at,
          updated_at
        ) VALUES (?, ?, 'line_channel_id', 'line_user_expiry_1', 1, 'friend', '2026-05-09T00:00:00.000Z', '2026-05-09T00:00:00.000Z')
      `
    )
    .run(LINE_IDENTITY_ID, CUSTOMER_ID);
};

const insertReservationWithLocks = (
  db: SqliteD1Database,
  input: {
    reservationId?: string;
    status?: "pending_approval" | "confirmed";
    pendingExpiresAt: string | null;
    startAt?: string;
    endAt?: string;
    slotTimes?: string[];
    customerId?: string;
    lineIdentityId?: string | null;
  }
) => {
  const reservationId = input.reservationId ?? RESERVATION_ID;
  const slotTimes = input.slotTimes ?? DEFAULT_SLOT_TIMES;
  const customerId = input.customerId ?? CUSTOMER_ID;
  const lineIdentityId = input.lineIdentityId === undefined ? LINE_IDENTITY_ID : input.lineIdentityId;
  db.sqlite
    .prepare(
      `
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
          pending_expires_at,
          created_by,
          updated_by,
          idempotency_key,
          google_sync_state,
          version,
          updated_at
        ) VALUES (?, 'kyoto', 'service_kyoto_default_60', ?, 'resource_kyoto_calendar', ?, 'web_line', ?, ?, ?, 60, ?, ?, ?, ?, 'pending', 1, '2026-05-09T00:00:00.000Z')
      `
    )
    .run(
      reservationId,
      customerId,
      lineIdentityId,
      input.status ?? "pending_approval",
      input.startAt ?? START_AT,
      input.endAt ?? END_AT,
      input.pendingExpiresAt,
      lineIdentityId,
      lineIdentityId,
      `public_submit_expiry_${reservationId}`
    );

  for (const [index, slotAt] of slotTimes.entries()) {
    db.sqlite
      .prepare(
        `
          INSERT INTO slot_locks (
            id,
            store_id,
            resource_id,
            slot_at,
            owner_type,
            owner_id,
            lock_status,
            expires_at
          ) VALUES (?, 'kyoto', 'resource_kyoto_calendar', ?, 'reservation', ?, ?, ?)
        `
      )
      .run(
        `slot_lock_expiry_${reservationId}_${index}`,
        slotAt,
        reservationId,
        input.status === "confirmed" ? "confirmed" : "pending",
        input.pendingExpiresAt
      );
    db.sqlite
      .prepare(
        `
          INSERT INTO customer_time_locks (
            id,
            customer_id,
            slot_at,
            owner_type,
            owner_id,
            lock_status,
            expires_at
          ) VALUES (?, ?, ?, 'reservation', ?, ?, ?)
        `
      )
      .run(
        `customer_lock_expiry_${reservationId}_${index}`,
        customerId,
        slotAt,
        reservationId,
        input.status === "confirmed" ? "confirmed" : "pending",
        input.pendingExpiresAt
      );
  }
};

const count = (db: SqliteD1Database, sql: string, ...bindings: TestSqlValue[]) => {
  const row = db.sqlite.prepare(sql).get(...bindings) as { count: number };
  return row.count;
};

const insertQueuedSideEffectJobs = (db: SqliteD1Database, reservationId = RESERVATION_ID) => {
  db.sqlite
    .prepare(
      `
        INSERT INTO calendar_sync_jobs (
          id,
          dedupe_key,
          owner_type,
          owner_id,
          google_action,
          status
        ) VALUES (?, ?, 'reservation', ?, 'upsert', 'queued')
      `
    )
    .run(
      `calendar_upsert_expiry_${reservationId}`,
      `reservation:${reservationId}:google:upsert:revision:1`,
      reservationId
    );
  db.sqlite
    .prepare(
      `
        INSERT INTO notification_jobs (
          id,
          dedupe_key,
          template_key,
          recipient_type,
          recipient_id,
          reservation_id,
          status
        ) VALUES (?, ?, 'reservation_pending_received', 'customer', ?, ?, 'queued')
      `
    )
    .run(
      `notification_customer_expiry_${reservationId}`,
      `reservation:${reservationId}:template:reservation_pending_received:revision:1`,
      CUSTOMER_ID,
      reservationId
    );
  db.sqlite
    .prepare(
      `
        INSERT INTO notification_jobs (
          id,
          dedupe_key,
          template_key,
          recipient_type,
          recipient_id,
          reservation_id,
          status
        ) VALUES (?, ?, 'pending_approval_created', 'staff', 'kyoto', ?, 'retryable')
      `
    )
    .run(
      `notification_staff_expiry_${reservationId}`,
      `reservation:${reservationId}:template:pending_approval_created:revision:1`,
      reservationId
    );
  db.sqlite
    .prepare(
      `
        INSERT INTO notification_jobs (
          id,
          dedupe_key,
          template_key,
          recipient_type,
          recipient_id,
          reservation_id,
          status
        ) VALUES (?, ?, 'reservation_new_customer', 'owner', 'U${"a".repeat(32)}', ?, 'queued')
      `
    )
    .run(
      `notification_owner_expiry_${reservationId}`,
      `reservation:${reservationId}:template:reservation_new_customer:revision:1`,
      reservationId
    );
};

const insertStaleProcessingSideEffectJobs = (db: SqliteD1Database, reservationId = RESERVATION_ID) => {
  db.sqlite
    .prepare(
      `
        INSERT INTO calendar_sync_jobs (
          id,
          dedupe_key,
          owner_type,
          owner_id,
          google_action,
          status,
          locked_until
        ) VALUES (?, ?, 'reservation', ?, 'upsert', 'processing', '2026-05-10T00:05:00.000Z')
      `
    )
    .run(
      `calendar_processing_expiry_${reservationId}`,
      `reservation:${reservationId}:google:upsert:processing`,
      reservationId
    );
  db.sqlite
    .prepare(
      `
        INSERT INTO notification_jobs (
          id,
          dedupe_key,
          template_key,
          recipient_type,
          recipient_id,
          reservation_id,
          status,
          locked_until
        ) VALUES (?, ?, 'reservation_pending_received', 'customer', ?, ?, 'processing', '2026-05-10T00:05:00.000Z')
      `
    )
    .run(
      `notification_customer_processing_expiry_${reservationId}`,
      `reservation:${reservationId}:template:reservation_pending_received:processing`,
      CUSTOMER_ID,
      reservationId
    );
  db.sqlite
    .prepare(
      `
        INSERT INTO notification_jobs (
          id,
          dedupe_key,
          template_key,
          recipient_type,
          recipient_id,
          reservation_id,
          status,
          locked_until
        ) VALUES (?, ?, 'pending_approval_created', 'staff', 'kyoto', ?, 'processing', '2026-05-10T00:05:00.000Z')
      `
    )
    .run(
      `notification_staff_processing_expiry_${reservationId}`,
      `reservation:${reservationId}:template:pending_approval_created:processing`,
      reservationId
    );
  db.sqlite
    .prepare(
      `
        INSERT INTO notification_jobs (
          id,
          dedupe_key,
          template_key,
          recipient_type,
          recipient_id,
          reservation_id,
          status,
          locked_until
        ) VALUES (?, ?, 'reservation_new_customer', 'owner', 'U${"a".repeat(32)}', ?, 'processing', '2026-05-10T00:05:00.000Z')
      `
    )
    .run(
      `notification_owner_processing_expiry_${reservationId}`,
      `reservation:${reservationId}:template:reservation_new_customer:processing`,
      reservationId
    );
};

describe("pending reservation expiration", () => {
  it("expires overdue pending reservations and releases their locks", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      insertBaseCustomer(d1);
      insertReservationWithLocks(d1, {
        pendingExpiresAt: "2026-05-10T00:00:00.000Z"
      });
      insertQueuedSideEffectJobs(d1);

      const result = await expirePendingReservations({
        db: d1 as unknown as D1Database,
        now: () => new Date("2026-05-10T00:00:01.000Z").getTime()
      });

      expect(result).toEqual({
        ok: true,
        expiredCount: 1
      });
      const reservation = d1.sqlite
        .prepare("SELECT status, pending_expires_at, version, updated_by FROM reservations WHERE id = ?")
        .get(RESERVATION_ID) as {
        status: string;
        pending_expires_at: string | null;
        version: number;
        updated_by: string;
      };
      expect(reservation).toEqual({
        status: "expired",
        pending_expires_at: null,
        version: 2,
        updated_by: "system"
      });
      expect(count(d1, "SELECT COUNT(*) AS count FROM slot_locks WHERE owner_id = ?", RESERVATION_ID)).toBe(0);
      expect(count(d1, "SELECT COUNT(*) AS count FROM customer_time_locks WHERE owner_id = ?", RESERVATION_ID)).toBe(0);
      expect(
        count(
          d1,
          "SELECT COUNT(*) AS count FROM slot_lock_history WHERE old_owner_id = ? AND action = 'expired' AND actor_type = 'system'",
          RESERVATION_ID
        )
      ).toBe(4);
      expect(
        count(
          d1,
          "SELECT COUNT(*) AS count FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'delete'",
          RESERVATION_ID
        )
      ).toBe(1);
      expect(
        count(
          d1,
          "SELECT COUNT(*) AS count FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'upsert' AND status = 'succeeded' AND last_error = 'superseded_by_reservation_expiry'",
          RESERVATION_ID
        )
      ).toBe(1);
      expect(
        count(
          d1,
          "SELECT COUNT(*) AS count FROM notification_jobs WHERE reservation_id = ? AND status = 'succeeded' AND last_error = 'superseded_by_reservation_expiry'",
          RESERVATION_ID
        )
      ).toBe(3);
      const fetcher = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;
      await expect(
        processDueLineNotificationJobs({
          db: d1 as unknown as D1Database,
          env: {
            LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "line-token"
          },
          fetcher
        })
      ).resolves.toEqual({
        processed: 0,
        succeeded: 0,
        failed: 0
      });
      expect(fetcher).not.toHaveBeenCalled();
      expect(
        count(
          d1,
          "SELECT COUNT(*) AS count FROM audit_logs WHERE target_id = ? AND action = 'system_reservation_expired'",
          RESERVATION_ID
        )
      ).toBe(1);
      expect(count(d1, "SELECT COUNT(*) AS count FROM customer_visits WHERE reservation_id = ?", RESERVATION_ID)).toBe(0);
    } finally {
      d1.sqlite.close();
    }
  });

  it("supersedes processing side-effect jobs while expiring a reservation", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      insertBaseCustomer(d1);
      insertReservationWithLocks(d1, {
        pendingExpiresAt: "2026-05-10T00:00:00.000Z"
      });
      insertStaleProcessingSideEffectJobs(d1);

      const result = await expirePendingReservations({
        db: d1 as unknown as D1Database,
        now: () => new Date("2026-05-10T00:00:01.000Z").getTime()
      });

      expect(result).toEqual({
        ok: true,
        expiredCount: 1
      });
      expect(
        count(
          d1,
          "SELECT COUNT(*) AS count FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'upsert' AND status = 'succeeded' AND locked_until IS NULL AND last_error = 'superseded_by_reservation_expiry'",
          RESERVATION_ID
        )
      ).toBe(1);
      expect(
        count(
          d1,
          "SELECT COUNT(*) AS count FROM notification_jobs WHERE reservation_id = ? AND status = 'succeeded' AND locked_until IS NULL AND last_error = 'superseded_by_reservation_expiry'",
          RESERVATION_ID
        )
      ).toBe(3);
    } finally {
      d1.sqlite.close();
    }
  });

  it("expires a pending reservation whose appointment has ended even if its TTL has not", async () => {
    // Short-lead booking: appointment already ended (end_at < now) but the 24h
    // approval TTL (pending_expires_at) is still in the future. This defunct
    // reservation must still expire so it stops blocking the customer's next
    // booking via the one-pending-per-line UNIQUE index.
    const d1 = createMigratedSqliteD1();
    try {
      insertBaseCustomer(d1);
      insertReservationWithLocks(d1, {
        startAt: "2026-05-09T22:00:00.000Z",
        endAt: "2026-05-09T23:00:00.000Z",
        pendingExpiresAt: "2026-05-10T12:00:00.000Z",
        slotTimes: [
          "2026-05-09T22:00:00.000Z",
          "2026-05-09T22:15:00.000Z",
          "2026-05-09T22:30:00.000Z",
          "2026-05-09T22:45:00.000Z"
        ]
      });

      const result = await expirePendingReservations({
        db: d1 as unknown as D1Database,
        now: () => new Date("2026-05-10T00:00:01.000Z").getTime()
      });

      expect(result).toEqual({ ok: true, expiredCount: 1 });
      const reservation = d1.sqlite
        .prepare("SELECT status, pending_expires_at FROM reservations WHERE id = ?")
        .get(RESERVATION_ID) as { status: string; pending_expires_at: string | null };
      expect(reservation).toEqual({ status: "expired", pending_expires_at: null });
      expect(count(d1, "SELECT COUNT(*) AS count FROM slot_locks WHERE owner_id = ?", RESERVATION_ID)).toBe(0);
      expect(
        count(d1, "SELECT COUNT(*) AS count FROM customer_time_locks WHERE owner_id = ?", RESERVATION_ID)
      ).toBe(0);
    } finally {
      d1.sqlite.close();
    }
  });

  it("closes a pending change request as 'expired' when its reservation expires", async () => {
    // 失効した予約に pending の変更申請が残ると、staff の変更申請キューに永久
    // 滞留し、reject すると既に消えた予約について顧客へ却下 LINE が飛ぶ。
    const d1 = createMigratedSqliteD1();
    try {
      insertBaseCustomer(d1);
      insertReservationWithLocks(d1, {
        pendingExpiresAt: "2026-05-10T00:00:00.000Z"
      });
      d1.sqlite
        .prepare(
          `INSERT INTO reservation_change_requests (
              id, reservation_id, customer_id, request_type, status,
              reservation_version_at_request, current_start_at, current_end_at
            ) VALUES ('change_request_expiry_1', ?, ?, 'cancel', 'pending', 1, ?, ?)`
        )
        .run(RESERVATION_ID, CUSTOMER_ID, START_AT, END_AT);
      // 既に決着済みの申請 (withdrawn) は書き換えない。
      d1.sqlite
        .prepare(
          `INSERT INTO reservation_change_requests (
              id, reservation_id, customer_id, request_type, status,
              reservation_version_at_request, current_start_at, current_end_at
            ) VALUES ('change_request_expiry_2', ?, ?, 'cancel', 'withdrawn', 1, ?, ?)`
        )
        .run(RESERVATION_ID, CUSTOMER_ID, START_AT, END_AT);

      const result = await expirePendingReservations({
        db: d1 as unknown as D1Database,
        now: () => new Date("2026-05-10T00:00:01.000Z").getTime()
      });

      expect(result).toEqual({ ok: true, expiredCount: 1 });
      const statuses = d1.sqlite
        .prepare(
          "SELECT id, status FROM reservation_change_requests WHERE reservation_id = ? ORDER BY id"
        )
        .all(RESERVATION_ID) as Array<{ id: string; status: string }>;
      expect(statuses).toEqual([
        { id: "change_request_expiry_1", status: "expired" },
        { id: "change_request_expiry_2", status: "withdrawn" }
      ]);
    } finally {
      d1.sqlite.close();
    }
  });

  it("leaves future pending and confirmed reservations unchanged", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      insertBaseCustomer(d1);
      insertReservationWithLocks(d1, {
        reservationId: "reservation_expiry_future_1",
        pendingExpiresAt: "2026-05-10T01:00:00.000Z"
      });
      insertReservationWithLocks(d1, {
        reservationId: "reservation_expiry_confirmed_1",
        status: "confirmed",
        pendingExpiresAt: null,
        startAt: "2026-06-01T02:00:00.000Z",
        endAt: "2026-06-01T03:00:00.000Z",
        slotTimes: [
          "2026-06-01T02:00:00.000Z",
          "2026-06-01T02:15:00.000Z",
          "2026-06-01T02:30:00.000Z",
          "2026-06-01T02:45:00.000Z"
        ]
      });

      const result = await expirePendingReservations({
        db: d1 as unknown as D1Database,
        now: () => new Date("2026-05-10T00:00:01.000Z").getTime()
      });

      expect(result).toEqual({
        ok: true,
        expiredCount: 0
      });
      expect(count(d1, "SELECT COUNT(*) AS count FROM slot_locks")).toBe(8);
      expect(count(d1, "SELECT COUNT(*) AS count FROM calendar_sync_jobs WHERE google_action = 'delete'")).toBe(0);
      expect(count(d1, "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'system_reservation_expired'")).toBe(0);
    } finally {
      d1.sqlite.close();
    }
  });

  it("is idempotent after a reservation has already expired", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      insertBaseCustomer(d1);
      insertReservationWithLocks(d1, {
        pendingExpiresAt: "2026-05-10T00:00:00.000Z"
      });

      const input = {
        db: d1 as unknown as D1Database,
        now: () => new Date("2026-05-10T00:00:01.000Z").getTime()
      };
      await expirePendingReservations(input);
      const replay = await expirePendingReservations(input);

      expect(replay).toEqual({
        ok: true,
        expiredCount: 0
      });
      expect(count(d1, "SELECT COUNT(*) AS count FROM calendar_sync_jobs WHERE owner_id = ?", RESERVATION_ID)).toBe(1);
      expect(count(d1, "SELECT COUNT(*) AS count FROM audit_logs WHERE target_id = ?", RESERVATION_ID)).toBe(1);
    } finally {
      d1.sqlite.close();
    }
  });

  it("drains multiple expiration batches before scheduled side effects run", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      insertBaseCustomer(d1);
      insertReservationWithLocks(d1, {
        pendingExpiresAt: "2026-05-10T00:00:00.000Z"
      });
      insertReservationWithLocks(d1, {
        reservationId: "reservation_expiry_batch_2",
        lineIdentityId: null,
        pendingExpiresAt: "2026-05-10T00:00:00.000Z",
        startAt: "2026-06-01T03:00:00.000Z",
        endAt: "2026-06-01T04:00:00.000Z",
        slotTimes: [
          "2026-06-01T03:00:00.000Z",
          "2026-06-01T03:15:00.000Z",
          "2026-06-01T03:30:00.000Z",
          "2026-06-01T03:45:00.000Z"
        ]
      });

      const result = await expirePendingReservations({
        db: d1 as unknown as D1Database,
        now: () => new Date("2026-05-10T00:00:01.000Z").getTime(),
        maxReservations: 1,
        drain: true
      });

      expect(result).toEqual({
        ok: true,
        expiredCount: 2
      });
      expect(count(d1, "SELECT COUNT(*) AS count FROM reservations WHERE status = 'expired'")).toBe(2);
      expect(count(d1, "SELECT COUNT(*) AS count FROM reservations WHERE status = 'pending_approval'")).toBe(0);
      expect(count(d1, "SELECT COUNT(*) AS count FROM slot_locks")).toBe(0);
      expect(count(d1, "SELECT COUNT(*) AS count FROM calendar_sync_jobs WHERE google_action = 'delete'")).toBe(2);
    } finally {
      d1.sqlite.close();
    }
  });

  it("with drain:false processes at most one batch (bounded cron-prelude behavior)", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      insertBaseCustomer(d1);
      insertReservationWithLocks(d1, {
        pendingExpiresAt: "2026-05-10T00:00:00.000Z"
      });
      insertReservationWithLocks(d1, {
        reservationId: "reservation_expiry_batch_2",
        lineIdentityId: null,
        pendingExpiresAt: "2026-05-10T00:00:00.000Z",
        startAt: "2026-06-01T03:00:00.000Z",
        endAt: "2026-06-01T04:00:00.000Z",
        slotTimes: [
          "2026-06-01T03:00:00.000Z",
          "2026-06-01T03:15:00.000Z",
          "2026-06-01T03:30:00.000Z",
          "2026-06-01T03:45:00.000Z"
        ]
      });

      // The cron prelude calls this with drain:false so a scheduled tick stays
      // BOUNDED to a single batch and cannot loop over an unbounded backlog under
      // its fixed PRELUDE_TASK_TIMEOUT_MS budget (which would false-kill a
      // large-but-legitimate backlog). With maxReservations:1, only ONE of the
      // two due reservations expires this run; the remainder drains on a later
      // tick or via the on-read request path (which still uses drain:true).
      const result = await expirePendingReservations({
        db: d1 as unknown as D1Database,
        now: () => new Date("2026-05-10T00:00:01.000Z").getTime(),
        maxReservations: 1,
        drain: false
      });

      expect(result).toEqual({ ok: true, expiredCount: 1 });
      expect(
        count(d1, "SELECT COUNT(*) AS count FROM reservations WHERE status = 'expired'")
      ).toBe(1);
      expect(
        count(d1, "SELECT COUNT(*) AS count FROM reservations WHERE status = 'pending_approval'")
      ).toBe(1);
    } finally {
      d1.sqlite.close();
    }
  });

  it("fails closed when the D1 binding is missing", async () => {
    await expect(expirePendingReservations({})).resolves.toEqual({
      ok: false,
      reason: "missing_database"
    });
  });

  it("captures the underlying D1 error when the expire batch fails", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      insertBaseCustomer(d1);
      insertReservationWithLocks(d1, {
        pendingExpiresAt: "2026-05-10T00:00:00.000Z"
      });

      const batchError = new Error("injected_expire_batch_failure");
      // Wrap the migrated D1 so the expire batch rejects while the overdue
      // reservation lookup (prepare/run) still succeeds — this exercises the
      // catch in expirePendingReservations without faking the whole binding.
      const failingDb = new Proxy(d1, {
        get(target, prop, receiver) {
          if (prop === "batch") {
            return () => Promise.reject(batchError);
          }
          return Reflect.get(target, prop, receiver);
        }
      });

      const result = await expirePendingReservations({
        db: failingDb as unknown as D1Database,
        now: () => new Date("2026-05-10T00:00:01.000Z").getTime()
      });

      // The return contract is preserved: the caller still sees write_failed.
      expect(result).toEqual({
        ok: false,
        reason: "write_failed"
      });
      // The diagnostic improvement: the original D1 error reaches Sentry.
      expect(safeCaptureException).toHaveBeenCalledWith(
        batchError,
        expect.objectContaining({
          tags: expect.objectContaining({
            operation: "pending_reservation_expiration"
          })
        })
      );
    } finally {
      d1.sqlite.close();
    }
  });

  it("classifies a D1 long-running-export error as the transient soft-skip reason", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      insertBaseCustomer(d1);
      insertReservationWithLocks(d1, {
        pendingExpiresAt: "2026-05-10T00:00:00.000Z"
      });

      // The backup-verify export makes the expire batch reject. The result must
      // carry the DISTINCT `d1_export_locked` reason so expireReservationsBeforeSideEffects
      // soft-skips (returns) instead of throwing a generic wrapper that would lose
      // the transient classification and get re-captured at the cron / queue
      // boundary. Sentry RESERVATION-LINE-HOMEPAGE-D.
      const exportError = new Error("D1_ERROR: Currently processing a long-running export.");
      const failingDb = new Proxy(d1, {
        get(target, prop, receiver) {
          if (prop === "batch") {
            return () => Promise.reject(exportError);
          }
          return Reflect.get(target, prop, receiver);
        }
      });

      const result = await expirePendingReservations({
        db: failingDb as unknown as D1Database,
        now: () => new Date("2026-05-10T00:00:01.000Z").getTime()
      });

      expect(result).toEqual({
        ok: false,
        reason: "d1_export_locked"
      });
    } finally {
      d1.sqlite.close();
    }
  });

  it("classifies a retryable D1 internal SELECT error without hiding it from Sentry", async () => {
    const internalError = new Error("D1_ERROR: internal error; reference = x");
    const statement = {
      bind: () => statement,
      all: async () => {
        throw internalError;
      }
    };
    const failingDb = {
      prepare: () => statement
    } as unknown as D1Database;

    const result = await expirePendingReservations({ db: failingDb });

    expect(result).toEqual({
      ok: false,
      reason: "transient_d1"
    });
    expect(safeCaptureException).toHaveBeenCalledWith(internalError, {
      tags: { operation: "pending_reservation_expiration" }
    });
  });
});
