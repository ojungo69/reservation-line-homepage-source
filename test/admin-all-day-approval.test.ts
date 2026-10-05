import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  approveAllDayAsClosure,
  rejectAllDayConflict
} from "../src/admin/conflict-resolutions";
import type { AdminUser, AdminRole } from "../src/admin/access";
import { statusForAllDayResult } from "../src/routes/shared";
import { createMigratedSqliteD1 as createBaseD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const STORE_ID = "kyoto";
const CALENDAR_ID = "calendar-a@example.invalid";
const CONFLICT_ID = "conflict_all_day_1";

const SNAPSHOT = JSON.stringify({
  summary: "店休 2026-06-15",
  start_at: "2026-06-15T00:00:00.000Z",
  end_at: "2026-06-16T00:00:00.000Z"
});

const seedAllDayConflict = (
  d1: SqliteD1Database,
  opts: {
    id?: string;
    status?: string;
    conflictType?: string;
    snapshot?: string;
  } = {}
) => {
  d1.sqlite
    .prepare(
      `INSERT INTO google_calendar_conflicts (
         id, store_id, calendar_id, google_event_id,
         conflict_type, google_safe_snapshot_json, resolution_status
       ) VALUES (?, ?, ?, 'evt_all_day_1', ?, ?, ?)`
    )
    .run(
      opts.id ?? CONFLICT_ID,
      STORE_ID,
      CALENDAR_ID,
      opts.conflictType ?? "google_all_day_event",
      opts.snapshot ?? SNAPSHOT,
      opts.status ?? "open"
    );
};

const fixtureAdmin = (role: AdminRole): AdminUser => ({
  id: role === "system_admin" ? "admin_test_system" : "admin_test",
  email: "admin@example.com",
  role
,
  staff_member_id: null,
store_id: null
});

const countClosures = (d1: SqliteD1Database): number => {
  const row = d1.sqlite.prepare("SELECT count(*) AS cnt FROM store_closures").get() as { cnt: number };
  return row.cnt;
};

const countSyncJobs = (d1: SqliteD1Database): number => {
  const row = d1.sqlite.prepare("SELECT count(*) AS cnt FROM calendar_sync_jobs").get() as {
    cnt: number;
  };
  return row.cnt;
};

const countExternalBlocks = (d1: SqliteD1Database): number => {
  const row = d1.sqlite.prepare("SELECT count(*) AS cnt FROM external_blocks").get() as {
    cnt: number;
  };
  return row.cnt;
};

const fetchConflictStatus = (d1: SqliteD1Database, id: string): string | null => {
  const row = d1.sqlite
    .prepare("SELECT resolution_status FROM google_calendar_conflicts WHERE id = ?")
    .get(id) as { resolution_status: string } | undefined;
  return row ? row.resolution_status : null;
};

const seedReservationInAllDayWindow = (
  d1: SqliteD1Database,
  status: "pending_approval" | "confirmed" | "cancelled_by_customer"
) => {
  d1.sqlite
    .prepare("INSERT INTO customers (id, display_name) VALUES ('customer_overlap', '重複 予約')")
    .run();
  d1.sqlite
    .prepare(
      `INSERT INTO reservations (
         id, store_id, service_id, customer_id, resource_id, source,
         status, start_at, end_at, duration_minutes, idempotency_key
       ) VALUES (
         'reservation_overlap', ?, 'service_kyoto_default_60', 'customer_overlap',
         'resource_kyoto_calendar', 'admin', ?,
         '2026-06-15T01:00:00.000Z', '2026-06-15T02:00:00.000Z', 60, ?
       )`
    )
    .run(STORE_ID, status, `reservation-overlap-${status}`);
};

describe("approveAllDayAsClosure", () => {
  let d1: SqliteD1Database;

  beforeEach(() => {
    d1 = createMigratedSqliteD1();
  });

  afterEach(() => {
    d1.sqlite.close();
  });

  it("approves an open all-day conflict and creates closure + sync_job", async () => {
    seedAllDayConflict(d1);

    const result = await approveAllDayAsClosure({
      db: d1 as unknown as D1Database,
      admin: fixtureAdmin("owner"),
      conflictId: CONFLICT_ID,
      request: { idempotencyKey: "key_approve_1", closureScope: { reason: "テスト承認" } }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.closureId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.replayed).toBe(false);

    expect(countClosures(d1)).toBe(1);
    // Publish round-trip: external_block + calendar_sync_job are created
    // to round-trip the approved closure back to Google Calendar.
    expect(countSyncJobs(d1)).toBe(1);
    expect(fetchConflictStatus(d1, CONFLICT_ID)).toBe("approved_as_closure");
  });

  it.each(["pending_approval", "confirmed"] as const)(
    "rejects approval when a %s reservation overlaps the all-day window",
    async (status) => {
      seedAllDayConflict(d1);
      seedReservationInAllDayWindow(d1, status);

      const result = await approveAllDayAsClosure({
        db: d1 as unknown as D1Database,
        admin: fixtureAdmin("owner"),
        conflictId: CONFLICT_ID,
        request: { idempotencyKey: `key_overlap_${status}` }
      });

      expect(result).toEqual({ ok: false, reason: "overlapping_reservations" });
      expect(countClosures(d1)).toBe(0);
      expect(countExternalBlocks(d1)).toBe(0);
      expect(fetchConflictStatus(d1, CONFLICT_ID)).toBe("open");
    }
  );

  it("reopens the conflict when a reservation wins the race after the overlap precheck", async () => {
    seedAllDayConflict(d1);
    d1.sqlite
      .prepare("INSERT INTO customers (id, display_name) VALUES ('customer_overlap_race', '競合 予約')")
      .run();
    const originalBatch = d1.batch.bind(d1);
    let injected = false;
    d1.batch = async (statements) => {
      if (!injected) {
        injected = true;
        d1.sqlite
          .prepare(
            `INSERT INTO reservations (
               id, store_id, service_id, customer_id, resource_id, source,
               status, start_at, end_at, duration_minutes, idempotency_key
             ) VALUES (
               'reservation_overlap_race', ?, 'service_kyoto_default_60', 'customer_overlap_race',
               'resource_kyoto_calendar', 'admin', 'confirmed',
               '2026-06-15T01:00:00.000Z', '2026-06-15T02:00:00.000Z', 60,
               'reservation-overlap-race'
             )`
          )
          .run(STORE_ID);
      }
      return originalBatch(statements);
    };

    const result = await approveAllDayAsClosure({
      db: d1 as unknown as D1Database,
      admin: fixtureAdmin("owner"),
      conflictId: CONFLICT_ID,
      request: { idempotencyKey: "key_overlap_race" }
    });

    expect(result).toEqual({ ok: false, reason: "overlapping_reservations" });
    expect(fetchConflictStatus(d1, CONFLICT_ID)).toBe("open");
    expect(countClosures(d1)).toBe(0);
    expect(countExternalBlocks(d1)).toBe(0);
    expect(countSyncJobs(d1)).toBe(0);
  });

  it("does not block approval for a cancelled reservation in the all-day window", async () => {
    seedAllDayConflict(d1);
    seedReservationInAllDayWindow(d1, "cancelled_by_customer");

    const result = await approveAllDayAsClosure({
      db: d1 as unknown as D1Database,
      admin: fixtureAdmin("owner"),
      conflictId: CONFLICT_ID,
      request: { idempotencyKey: "key_overlap_cancelled" }
    });

    expect(result.ok).toBe(true);
    expect(countClosures(d1)).toBe(1);
    expect(countExternalBlocks(d1)).toBe(1);
    expect(fetchConflictStatus(d1, CONFLICT_ID)).toBe("approved_as_closure");
  });

  it("maps overlapping_reservations to HTTP 409", () => {
    expect(statusForAllDayResult({ ok: false, reason: "overlapping_reservations" })).toBe(409);
  });

  it("rejects staff role with forbidden", async () => {
    seedAllDayConflict(d1);

    const result = await approveAllDayAsClosure({
      db: d1 as unknown as D1Database,
      admin: fixtureAdmin("staff"),
      conflictId: CONFLICT_ID,
      request: { idempotencyKey: "key_staff_1" }
    });

    expect(result).toEqual({ ok: false, reason: "forbidden" });
    expect(countClosures(d1)).toBe(0);
    expect(fetchConflictStatus(d1, CONFLICT_ID)).toBe("open");
  });

  it("returns not_found for missing conflict", async () => {
    const result = await approveAllDayAsClosure({
      db: d1 as unknown as D1Database,
      admin: fixtureAdmin("owner"),
      conflictId: "missing",
      request: { idempotencyKey: "key_nope" }
    });

    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("returns invalid_conflict_type when conflict is not google_all_day_event", async () => {
    seedAllDayConflict(d1, { conflictType: "slot_conflict" });

    const result = await approveAllDayAsClosure({
      db: d1 as unknown as D1Database,
      admin: fixtureAdmin("owner"),
      conflictId: CONFLICT_ID,
      request: { idempotencyKey: "key_wrong_type" }
    });

    expect(result).toEqual({ ok: false, reason: "invalid_conflict_type" });
    expect(countClosures(d1)).toBe(0);
  });

  it("returns already_resolved when conflict is not open", async () => {
    seedAllDayConflict(d1, { status: "manual_resolved" });

    const result = await approveAllDayAsClosure({
      db: d1 as unknown as D1Database,
      admin: fixtureAdmin("owner"),
      conflictId: CONFLICT_ID,
      request: { idempotencyKey: "key_already" }
    });

    expect(result).toEqual({ ok: false, reason: "already_resolved" });
  });

  it("returns invalid_snapshot when JSON is malformed", async () => {
    seedAllDayConflict(d1, { snapshot: '{"missing":"dates"}' });

    const result = await approveAllDayAsClosure({
      db: d1 as unknown as D1Database,
      admin: fixtureAdmin("owner"),
      conflictId: CONFLICT_ID,
      request: { idempotencyKey: "key_bad_snapshot" }
    });

    expect(result).toEqual({ ok: false, reason: "invalid_snapshot" });
    expect(countClosures(d1)).toBe(0);
  });

  it("replays a succeeded request with the same idempotency key", async () => {
    seedAllDayConflict(d1);

    const first = await approveAllDayAsClosure({
      db: d1 as unknown as D1Database,
      admin: fixtureAdmin("owner"),
      conflictId: CONFLICT_ID,
      request: { idempotencyKey: "key_idem" }
    });
    expect(first.ok).toBe(true);

    const second = await approveAllDayAsClosure({
      db: d1 as unknown as D1Database,
      admin: fixtureAdmin("owner"),
      conflictId: CONFLICT_ID,
      request: { idempotencyKey: "key_idem" }
    });

    expect(second.ok).toBe(true);
    if (!second.ok || !first.ok) return;
    expect(second.replayed).toBe(true);
    expect(second.closureId).toBe(first.closureId);
    expect(countClosures(d1)).toBe(1);
  });

  it("guards against duplicate side effects when two different idempotency keys race the same conflict", async () => {
    seedAllDayConflict(d1);

    const [first, second] = await Promise.all([
      approveAllDayAsClosure({
        db: d1 as unknown as D1Database,
        admin: fixtureAdmin("owner"),
        conflictId: CONFLICT_ID,
        request: { idempotencyKey: "key_race_1" }
      }),
      approveAllDayAsClosure({
        db: d1 as unknown as D1Database,
        admin: fixtureAdmin("owner"),
        conflictId: CONFLICT_ID,
        request: { idempotencyKey: "key_race_2" }
      })
    ]);

    const winners = [first, second].filter((r): r is { ok: true; closureId: string; replayed: boolean } => r.ok);
    const losers = [first, second].filter((r) => !r.ok);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    if (!losers[0].ok) {
      expect(losers[0].reason).toBe("already_resolved");
    }
    expect(countClosures(d1)).toBe(1);
    expect(fetchConflictStatus(d1, CONFLICT_ID)).toBe("approved_as_closure");
  });

  it("returns idempotency_conflict on key reuse with different request payload", async () => {
    seedAllDayConflict(d1);

    const first = await approveAllDayAsClosure({
      db: d1 as unknown as D1Database,
      admin: fixtureAdmin("owner"),
      conflictId: CONFLICT_ID,
      request: { idempotencyKey: "key_collide", closureScope: { reason: "first" } }
    });
    expect(first.ok).toBe(true);

    const second = await approveAllDayAsClosure({
      db: d1 as unknown as D1Database,
      admin: fixtureAdmin("owner"),
      conflictId: CONFLICT_ID,
      request: { idempotencyKey: "key_collide", closureScope: { reason: "second" } }
    });

    expect(second).toEqual({ ok: false, reason: "idempotency_conflict" });
  });
});

describe("rejectAllDayConflict", () => {
  let d1: SqliteD1Database;

  beforeEach(() => {
    d1 = createMigratedSqliteD1();
  });

  afterEach(() => {
    d1.sqlite.close();
  });

  it("rejects an open all-day conflict and marks resolution_status='rejected'", async () => {
    seedAllDayConflict(d1);

    const result = await rejectAllDayConflict({
      db: d1 as unknown as D1Database,
      admin: fixtureAdmin("system_admin"),
      conflictId: CONFLICT_ID,
      request: { idempotencyKey: "key_reject_1", reason: "別店舗での休業" }
    });

    expect(result.ok).toBe(true);
    expect(countClosures(d1)).toBe(0);
    expect(countSyncJobs(d1)).toBe(0);
    expect(fetchConflictStatus(d1, CONFLICT_ID)).toBe("rejected");
  });

  it("rejects staff role with forbidden", async () => {
    seedAllDayConflict(d1);

    const result = await rejectAllDayConflict({
      db: d1 as unknown as D1Database,
      admin: fixtureAdmin("staff"),
      conflictId: CONFLICT_ID,
      request: { idempotencyKey: "key_reject_staff" }
    });

    expect(result).toEqual({ ok: false, reason: "forbidden" });
    expect(fetchConflictStatus(d1, CONFLICT_ID)).toBe("open");
  });

  it("returns invalid_conflict_type for non-all-day conflict", async () => {
    seedAllDayConflict(d1, { conflictType: "slot_conflict" });

    const result = await rejectAllDayConflict({
      db: d1 as unknown as D1Database,
      admin: fixtureAdmin("owner"),
      conflictId: CONFLICT_ID,
      request: { idempotencyKey: "key_reject_wrong_type" }
    });

    expect(result).toEqual({ ok: false, reason: "invalid_conflict_type" });
  });

  it("replays a succeeded reject with same idempotency key", async () => {
    seedAllDayConflict(d1);

    const first = await rejectAllDayConflict({
      db: d1 as unknown as D1Database,
      admin: fixtureAdmin("owner"),
      conflictId: CONFLICT_ID,
      request: { idempotencyKey: "key_reject_idem" }
    });
    expect(first.ok).toBe(true);

    const second = await rejectAllDayConflict({
      db: d1 as unknown as D1Database,
      admin: fixtureAdmin("owner"),
      conflictId: CONFLICT_ID,
      request: { idempotencyKey: "key_reject_idem" }
    });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.replayed).toBe(true);
    expect(fetchConflictStatus(d1, CONFLICT_ID)).toBe("rejected");
  });
});

// Domain calls use the same persisted actor snapshot as authenticated routes.
const createMigratedSqliteD1 = () => {
  const db = createBaseD1();
  db.sqlite.exec("INSERT INTO admin_users(id,email,access_subject,role) VALUES ('admin_test','admin_test@example.test','admin_test','owner'), ('admin_test_system','admin_test_system@example.test','admin_test_system','system_admin')");
  return db;
};
