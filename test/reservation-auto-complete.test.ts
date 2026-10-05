import { beforeEach, describe, expect, it, vi } from "vitest";

import { autoCompleteReservations, runAutoCompleteForCron } from "../src/reservations/auto-complete";
import { safeCaptureException } from "../src/sentry-helpers";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

vi.mock("../src/sentry-helpers", () => ({
  safeCaptureException: vi.fn()
}));

beforeEach(() => {
  vi.mocked(safeCaptureException).mockClear();
});

const CUSTOMER_ID = "customer_auto_complete_1";
const LINE_IDENTITY_ID = "line_identity_auto_complete_1";
const NOW_ISO = "2026-06-10T00:00:00.000Z";
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
const START_AT = "2026-06-07T01:00:00.000Z";
const END_AT = "2026-06-07T02:00:00.000Z";
const DEFAULT_SLOT_TIMES = [
  "2026-06-07T01:00:00.000Z",
  "2026-06-07T01:15:00.000Z",
  "2026-06-07T01:30:00.000Z",
  "2026-06-07T01:45:00.000Z"
];

type ReservationStatus =
  | "pending_approval"
  | "confirmed"
  | "rejected"
  | "expired"
  | "cancelled_by_customer"
  | "cancelled_by_admin"
  | "completed"
  | "no_show";
type TestSqlValue = string | number | null;

const insertBaseCustomer = (db: SqliteD1Database) => {
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
        ) VALUES (?, '自動 完了', 'ジドウ カンリョウ', '0751234567', 'phone_hash_auto_complete_1', 'active', '2026-06-01T00:00:00.000Z')
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
        ) VALUES (?, ?, 'line_channel_id', 'line_user_auto_complete_1', 1, 'friend', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')
      `
    )
    .run(LINE_IDENTITY_ID, CUSTOMER_ID);
};

const insertReservation = (
  db: SqliteD1Database,
  input: {
    id: string;
    status?: ReservationStatus;
    source?: "web_line" | "phone_admin" | "system_import";
    startAt?: string;
    endAt?: string;
    checkedInAt?: string | null;
  }
) => {
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
          checked_in_at,
          created_by,
          updated_by,
          idempotency_key,
          google_sync_state,
          version,
          updated_at
        ) VALUES (?, 'kyoto', 'service_kyoto_default_60', ?, 'resource_kyoto_calendar', ?, ?, ?, ?, ?, 60, NULL, ?, ?, ?, ?, 'pending', 1, '2026-06-01T00:00:00.000Z')
      `
    )
    .run(
      input.id,
      CUSTOMER_ID,
      LINE_IDENTITY_ID,
      input.source ?? "web_line",
      input.status ?? "confirmed",
      input.startAt ?? START_AT,
      input.endAt ?? END_AT,
      input.checkedInAt ?? null,
      LINE_IDENTITY_ID,
      LINE_IDENTITY_ID,
      `public_submit_auto_complete_${input.id}`
    );
};

const insertReservationLocks = (
  db: SqliteD1Database,
  reservationId: string,
  slotTimes = DEFAULT_SLOT_TIMES
) => {
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
          ) VALUES (?, 'kyoto', 'resource_kyoto_calendar', ?, 'reservation', ?, 'confirmed', NULL)
        `
      )
      .run(`slot_lock_auto_complete_${reservationId}_${index}`, slotAt, reservationId);
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
          ) VALUES (?, ?, ?, 'reservation', ?, 'confirmed', NULL)
        `
      )
      .run(`customer_lock_auto_complete_${reservationId}_${index}`, CUSTOMER_ID, slotAt, reservationId);
  }
};

const count = (db: SqliteD1Database, sql: string, ...bindings: TestSqlValue[]) => {
  const row = db.sqlite.prepare(sql).get(...bindings) as { count: number };
  return row.count;
};

const runSweep = (
  db: SqliteD1Database,
  options: { graceMs?: number; maxReservations?: number; drain?: boolean } = {}
) =>
  autoCompleteReservations({
    db: db as unknown as D1Database,
    now: () => Date.parse(NOW_ISO),
    graceMs: options.graceMs ?? TWO_DAYS_MS,
    maxReservations: options.maxReservations,
    drain: options.drain
  });

describe("reservation auto-completion", () => {
  it("completes a confirmed reservation before the cutoff and records one visit at start_at", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      insertBaseCustomer(d1);
      insertReservation(d1, { id: "reservation_auto_complete_1" });

      const result = await runSweep(d1);

      expect(result).toEqual({ ok: true, completedCount: 1 });
      const reservation = d1.sqlite
        .prepare(
          "SELECT status, completed_at, pending_expires_at, version, updated_by FROM reservations WHERE id = ?"
        )
        .get("reservation_auto_complete_1") as {
        status: string;
        completed_at: string | null;
        pending_expires_at: string | null;
        version: number;
        updated_by: string;
      };
      expect(reservation).toEqual({
        status: "completed",
        completed_at: NOW_ISO,
        pending_expires_at: null,
        version: 2,
        updated_by: "system"
      });
      const visit = d1.sqlite
        .prepare(
          "SELECT visited_at, visit_source, recorded_by FROM customer_visits WHERE reservation_id = ?"
        )
        .get("reservation_auto_complete_1") as {
        visited_at: string;
        visit_source: string;
        recorded_by: string;
      };
      expect(visit).toEqual({
        visited_at: START_AT,
        visit_source: "reservation_completed",
        recorded_by: "system"
      });
      expect(
        count(
          d1,
          "SELECT COUNT(*) AS count FROM customer_visits WHERE reservation_id = ?",
          "reservation_auto_complete_1"
        )
      ).toBe(1);
    } finally {
      d1.sqlite.close();
    }
  });

  it("closes a stale pending change request as 'expired' when the reservation auto-completes", async () => {
    // 廃止済み申請機能の歴史的 pending 行が予約の terminal 遷移で取り残される
    // と、掃除経路が無いまま永久滞留する。auto-complete も
    // buildClosePendingChangeRequestsStatement の caller であり続けることの回帰。
    const d1 = createMigratedSqliteD1();
    try {
      insertBaseCustomer(d1);
      insertReservation(d1, { id: "reservation_auto_complete_cr_1" });
      d1.sqlite
        .prepare(
          `INSERT INTO reservation_change_requests (
              id, reservation_id, customer_id, request_type, status,
              reservation_version_at_request, current_start_at, current_end_at
            ) VALUES ('change_request_auto_complete_1', ?, ?, 'cancel', 'pending', 1, ?, ?)`
        )
        .run("reservation_auto_complete_cr_1", CUSTOMER_ID, START_AT, END_AT);
      // 既に決着済みの申請 (withdrawn) は書き換えない。
      d1.sqlite
        .prepare(
          `INSERT INTO reservation_change_requests (
              id, reservation_id, customer_id, request_type, status,
              reservation_version_at_request, current_start_at, current_end_at
            ) VALUES ('change_request_auto_complete_2', ?, ?, 'cancel', 'withdrawn', 1, ?, ?)`
        )
        .run("reservation_auto_complete_cr_1", CUSTOMER_ID, START_AT, END_AT);

      const result = await runSweep(d1);

      expect(result).toEqual({ ok: true, completedCount: 1 });
      const statuses = d1.sqlite
        .prepare(
          "SELECT id, status FROM reservation_change_requests WHERE reservation_id = ? ORDER BY id"
        )
        .all("reservation_auto_complete_cr_1") as Array<{ id: string; status: string }>;
      expect(statuses).toEqual([
        { id: "change_request_auto_complete_1", status: "expired" },
        { id: "change_request_auto_complete_2", status: "withdrawn" }
      ]);
    } finally {
      d1.sqlite.close();
    }
  });

  it("records phone-admin completions with phone_admin_completed visit source", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      insertBaseCustomer(d1);
      insertReservation(d1, {
        id: "reservation_auto_complete_phone",
        source: "phone_admin"
      });

      await runSweep(d1);

      const visit = d1.sqlite
        .prepare("SELECT visit_source FROM customer_visits WHERE reservation_id = ?")
        .get("reservation_auto_complete_phone") as { visit_source: string };
      expect(visit.visit_source).toBe("phone_admin_completed");
    } finally {
      d1.sqlite.close();
    }
  });

  it("leaves a confirmed reservation inside the grace window untouched", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      insertBaseCustomer(d1);
      insertReservation(d1, {
        id: "reservation_auto_complete_grace",
        startAt: "2026-06-09T01:00:00.000Z",
        endAt: "2026-06-09T02:00:00.000Z"
      });

      const result = await runSweep(d1);

      expect(result).toEqual({ ok: true, completedCount: 0 });
      expect(
        d1.sqlite.prepare("SELECT status FROM reservations WHERE id = ?").get(
          "reservation_auto_complete_grace"
        )
      ).toEqual({ status: "confirmed" });
      expect(count(d1, "SELECT COUNT(*) AS count FROM customer_visits")).toBe(0);
    } finally {
      d1.sqlite.close();
    }
  });

  it("leaves non-confirmed reservations untouched without recording visits", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      insertBaseCustomer(d1);
      const statuses = [
        "pending_approval",
        "cancelled_by_admin",
        "completed",
        "no_show"
      ] as const;
      for (const status of statuses) {
        insertReservation(d1, {
          id: `reservation_auto_complete_${status}`,
          status
        });
      }

      const result = await runSweep(d1);

      expect(result).toEqual({ ok: true, completedCount: 0 });
      expect(
        d1.sqlite
          .prepare("SELECT status FROM reservations ORDER BY status")
          .all() as Array<{ status: string }>
      ).toEqual(statuses.map((status) => ({ status })).sort((a, b) => a.status.localeCompare(b.status)));
      expect(count(d1, "SELECT COUNT(*) AS count FROM customer_visits")).toBe(0);
    } finally {
      d1.sqlite.close();
    }
  });

  it("releases reservation locks and records released slot-lock history", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      insertBaseCustomer(d1);
      insertReservation(d1, { id: "reservation_auto_complete_locks" });
      insertReservationLocks(d1, "reservation_auto_complete_locks");

      await runSweep(d1);

      expect(
        count(
          d1,
          "SELECT COUNT(*) AS count FROM slot_locks WHERE owner_id = ?",
          "reservation_auto_complete_locks"
        )
      ).toBe(0);
      expect(
        count(
          d1,
          "SELECT COUNT(*) AS count FROM customer_time_locks WHERE owner_id = ?",
          "reservation_auto_complete_locks"
        )
      ).toBe(0);
      expect(
        count(
          d1,
          "SELECT COUNT(*) AS count FROM slot_lock_history WHERE old_owner_id = ? AND action = 'released' AND actor_type = 'system' AND actor_id = 'system' AND reason = 'auto_complete'",
          "reservation_auto_complete_locks"
        )
      ).toBe(DEFAULT_SLOT_TIMES.length);
    } finally {
      d1.sqlite.close();
    }
  });

  it("creates no notification or calendar-sync jobs", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      insertBaseCustomer(d1);
      insertReservation(d1, { id: "reservation_auto_complete_no_jobs" });

      await runSweep(d1);

      expect(count(d1, "SELECT COUNT(*) AS count FROM notification_jobs")).toBe(0);
      expect(count(d1, "SELECT COUNT(*) AS count FROM calendar_sync_jobs")).toBe(0);
    } finally {
      d1.sqlite.close();
    }
  });

  it("is idempotent when run twice", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      insertBaseCustomer(d1);
      insertReservation(d1, { id: "reservation_auto_complete_idempotent" });

      await runSweep(d1);
      const replay = await runSweep(d1);

      expect(replay).toEqual({ ok: true, completedCount: 0 });
      expect(
        count(
          d1,
          "SELECT COUNT(*) AS count FROM customer_visits WHERE reservation_id = ?",
          "reservation_auto_complete_idempotent"
        )
      ).toBe(1);
    } finally {
      d1.sqlite.close();
    }
  });

  it("supports graceMs zero for backfill mode", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      insertBaseCustomer(d1);
      insertReservation(d1, {
        id: "reservation_auto_complete_backfill",
        startAt: "2026-06-09T23:00:00.000Z",
        endAt: "2026-06-09T23:59:00.000Z"
      });

      const result = await runSweep(d1, { graceMs: 0 });

      expect(result).toEqual({ ok: true, completedCount: 1 });
      expect(
        d1.sqlite.prepare("SELECT status FROM reservations WHERE id = ?").get(
          "reservation_auto_complete_backfill"
        )
      ).toEqual({ status: "completed" });
    } finally {
      d1.sqlite.close();
    }
  });

  it("drains all eligible reservations across multiple batches", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      insertBaseCustomer(d1);
      for (let index = 0; index < 5; index += 1) {
        insertReservation(d1, {
          id: `reservation_auto_complete_batch_${index}`,
          source: "system_import",
          startAt: `2026-06-07T0${index}:00:00.000Z`,
          endAt: `2026-06-07T0${index}:30:00.000Z`
        });
      }

      const result = await runSweep(d1, {
        maxReservations: 2,
        drain: true
      });

      expect(result).toEqual({ ok: true, completedCount: 5 });
      expect(
        count(d1, "SELECT COUNT(*) AS count FROM reservations WHERE status = 'completed'")
      ).toBe(5);
      expect(count(d1, "SELECT COUNT(*) AS count FROM customer_visits")).toBe(5);
    } finally {
      d1.sqlite.close();
    }
  });

  it("records checked_in as the audit previousStatus", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      insertBaseCustomer(d1);
      insertReservation(d1, {
        id: "reservation_auto_complete_checked_in",
        checkedInAt: "2026-06-07T00:55:00.000Z"
      });

      const result = await runSweep(d1);

      expect(result).toEqual({ ok: true, completedCount: 1 });
      const audit = d1.sqlite
        .prepare(
          "SELECT metadata_json FROM audit_logs WHERE target_id = ? AND action = 'system_reservation_auto_completed'"
        )
        .get("reservation_auto_complete_checked_in") as { metadata_json: string };
      expect(JSON.parse(audit.metadata_json)).toEqual({
        previousStatus: "checked_in",
        nextStatus: "completed"
      });
    } finally {
      d1.sqlite.close();
    }
  });

  it("completes the reservation and records a visit for an archived customer", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      insertBaseCustomer(d1);
      insertReservation(d1, { id: "reservation_auto_complete_archived" });
      d1.sqlite
        .prepare("UPDATE customers SET archived_at = ? WHERE id = ?")
        .run("2026-06-08T00:00:00.000Z", CUSTOMER_ID);

      const result = await runSweep(d1);

      expect(result).toEqual({ ok: true, completedCount: 1 });
      expect(
        d1.sqlite
          .prepare("SELECT status FROM reservations WHERE id = ?")
          .get("reservation_auto_complete_archived")
      ).toEqual({ status: "completed" });
      expect(
        count(
          d1,
          "SELECT COUNT(*) AS count FROM customer_visits WHERE reservation_id = ?",
          "reservation_auto_complete_archived"
        )
      ).toBe(1);
    } finally {
      d1.sqlite.close();
    }
  });

  it("completes the reservation and records a visit for a merged-away customer", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      insertBaseCustomer(d1);
      d1.sqlite
        .prepare(
          `INSERT INTO customers (id, display_name, display_name_kana, phone_normalized, phone_hash, block_status, updated_at)
           VALUES ('customer_merge_target', '統合 先', 'トウゴウ サキ', '0759999999', 'phone_hash_merge_target', 'active', '2026-06-01T00:00:00.000Z')`
        )
        .run();
      insertReservation(d1, { id: "reservation_auto_complete_merged" });
      d1.sqlite
        .prepare("UPDATE customers SET merged_into_id = 'customer_merge_target' WHERE id = ?")
        .run(CUSTOMER_ID);

      const result = await runSweep(d1);

      expect(result).toEqual({ ok: true, completedCount: 1 });
      expect(
        d1.sqlite
          .prepare("SELECT status FROM reservations WHERE id = ?")
          .get("reservation_auto_complete_merged")
      ).toEqual({ status: "completed" });
      expect(
        count(
          d1,
          "SELECT COUNT(*) AS count FROM customer_visits WHERE reservation_id = ?",
          "reservation_auto_complete_merged"
        )
      ).toBe(1);
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

    const result = await autoCompleteReservations({ db: failingDb });

    expect(result).toEqual({
      ok: false,
      reason: "transient_d1"
    });
    expect(safeCaptureException).toHaveBeenCalledWith(internalError, {
      tags: { operation: "reservation_auto_completion" }
    });
  });
});

describe("runAutoCompleteForCron", () => {
  const oneRowFailingDb = (err: unknown): D1Database => {
    const stmt = {
      bind: () => stmt,
      all: async () => ({
        results: [
          {
            id: "reservation_cron_fail",
            customer_id: CUSTOMER_ID,
            store_id: "kyoto",
            start_at: START_AT,
            source: "web_line",
            checked_in_at: null
          }
        ]
      })
    };
    return {
      prepare: () => stmt,
      batch: async () => {
        throw err;
      }
    } as unknown as D1Database;
  };

  it("rethrows non-transient failures so the cron monitor surfaces them", async () => {
    await expect(
      runAutoCompleteForCron({ db: oneRowFailingDb(new Error("disk full")), graceMs: 0 })
    ).rejects.toThrow(/reservation_auto_completion_write_failed/);
  });

  it("soft-skips the D1 export-lock transient without throwing", async () => {
    await expect(
      runAutoCompleteForCron({
        db: oneRowFailingDb(new Error("Currently processing a long-running export.")),
        graceMs: 0
      })
    ).resolves.toBeUndefined();
  });

  it("soft-skips a retryable D1 internal error without throwing", async () => {
    await expect(
      runAutoCompleteForCron({
        db: oneRowFailingDb(new Error("D1_ERROR: internal error; reference = x")),
        graceMs: 0
      })
    ).resolves.toBeUndefined();
  });

  it("rethrows when the database binding is missing", async () => {
    await expect(runAutoCompleteForCron({ db: undefined, graceMs: 0 })).rejects.toThrow(
      /reservation_auto_completion_missing_database/
    );
  });

  it("resolves without throwing on a successful sweep", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      insertBaseCustomer(d1);
      insertReservation(d1, { id: "reservation_cron_ok" });
      await expect(
        runAutoCompleteForCron({
          db: d1 as unknown as D1Database,
          graceMs: TWO_DAYS_MS,
          now: () => Date.parse(NOW_ISO)
        })
      ).resolves.toBeUndefined();
      expect(
        d1.sqlite.prepare("SELECT status FROM reservations WHERE id = ?").get("reservation_cron_ok")
      ).toEqual({ status: "completed" });
    } finally {
      d1.sqlite.close();
    }
  });
});
