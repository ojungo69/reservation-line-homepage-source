import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runRetentionSweepPhase1 } from "../src/retention-sweep";
import { safeCaptureException } from "../src/sentry-helpers";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

// Spy on Sentry reporting: the maintenance cron call-site swallows sweep
// rejections on the premise that every failure path self-reports, so the
// tests must pin that premise.
vi.mock("../src/sentry-helpers", () => ({
  safeCaptureException: vi.fn()
}));

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Fixed wall-clock reference for deterministic cutoff math. The sweep uses
// `now()` only for cutoff computation + the day-bucket marker, so a fixed value
// keeps every assertion stable regardless of when the suite runs.
const NOW_MS = Date.UTC(2026, 5, 7, 12, 0, 0); // 2026-06-07T12:00:00Z
const now = () => NOW_MS;
const iso = (ms: number) => new Date(ms).toISOString();
const daysAgo = (days: number) => iso(NOW_MS - days * MS_PER_DAY);

// Seed parent rows present in seeds/dev.sql, so FK constraints (PRAGMA
// foreign_keys = ON in the helper) are satisfied for lock fixtures.
const STORE_ID = "kyoto";
const RESOURCE_ID = "resource_kyoto_calendar";
const CUSTOMER_ID = "cust_retention_test";

describe("runRetentionSweepPhase1", () => {
  let d1: SqliteD1Database;

  const exec = (sql: string, params: Array<string | number | null> = []) => {
    d1.sqlite.prepare(sql).run(...params);
  };

  const count = (table: string): number => {
    const row = d1.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
      n: number | bigint;
    };
    return Number(row.n);
  };

  const exists = (table: string, id: string): boolean => {
    const row = d1.sqlite
      .prepare(`SELECT 1 AS hit FROM ${table} WHERE id = ?`)
      .get(id) as { hit: number } | undefined;
    return Boolean(row);
  };

  beforeEach(() => {
    vi.mocked(safeCaptureException).mockClear();
    d1 = createMigratedSqliteD1();
    // A customer is required for customer_time_locks (FK ON DELETE CASCADE).
    exec("INSERT INTO customers (id, display_name) VALUES (?, ?)", [
      CUSTOMER_ID,
      "保持テスト顧客"
    ]);
  });

  afterEach(() => {
    d1.sqlite.close();
  });

  const seedIdempotencyKey = (id: string, expiresAt: string) => {
    exec(
      `INSERT INTO idempotency_keys (id, scope, idempotency_key, status, expires_at)
       VALUES (?, 'public_submit', ?, 'succeeded', ?)`,
      [id, id, expiresAt]
    );
  };

  const seedAuthState = (id: string, expiresAt: string) => {
    exec(
      `INSERT INTO auth_states (id, state_hash, nonce_hash, pkce_verifier_hash, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      [id, `state-${id}`, `nonce-${id}`, `pkce-${id}`, expiresAt]
    );
  };

  const seedSlotLock = (
    id: string,
    expiresAt: string | null,
    lockStatus: "pending" | "confirmed" = "pending"
  ) => {
    exec(
      `INSERT INTO slot_locks
         (id, store_id, resource_id, slot_at, owner_type, owner_id, lock_status, expires_at)
       VALUES (?, ?, ?, ?, 'reservation', ?, ?, ?)`,
      [id, STORE_ID, RESOURCE_ID, `${id}-slot`, `owner-${id}`, lockStatus, expiresAt]
    );
  };

  const seedCustomerTimeLock = (
    id: string,
    expiresAt: string | null,
    lockStatus: "pending" | "confirmed" = "pending"
  ) => {
    exec(
      `INSERT INTO customer_time_locks
         (id, customer_id, slot_at, owner_type, owner_id, lock_status, expires_at)
       VALUES (?, ?, ?, 'reservation', ?, ?, ?)`,
      [id, CUSTOMER_ID, `${id}-slot`, `owner-${id}`, lockStatus, expiresAt]
    );
  };

  const seedOutboundWrite = (id: string, expiresAt: string) => {
    exec(
      `INSERT INTO google_calendar_outbound_writes
         (id, dedupe_key, calendar_id, google_event_id, owner_type, owner_id, action,
          expected_fingerprint, expires_at)
       VALUES (?, ?, 'cal-1', ?, 'reservation', ?, 'insert', 'fp', ?)`,
      [id, `dedupe-${id}`, `evt-${id}`, `owner-${id}`, expiresAt]
    );
  };

  const seedWebhookEvent = (id: string, createdAt: string) => {
    exec(
      `INSERT INTO line_webhook_events
         (id, dedupe_key, event_type, event_timestamp, created_at)
       VALUES (?, ?, 'message', ?, ?)`,
      [id, `dedupe-${id}`, createdAt, createdAt]
    );
  };

  const seedGoogleNotification = (id: string, receivedAt: string) => {
    exec(
      `INSERT INTO google_calendar_notifications
         (id, channel_id, resource_id, message_number, resource_state, received_at)
       VALUES (?, ?, ?, ?, 'exists', ?)`,
      [id, `chan-${id}`, `res-${id}`, `msg-${id}`, receivedAt]
    );
  };

  const seedRateLimitEvent = (id: string, occurredAt: string) => {
    exec(
      `INSERT INTO rate_limit_events (id, rate_limit_key, action, occurred_at)
       VALUES (?, ?, 'submit', ?)`,
      [id, `key-${id}`, occurredAt]
    );
  };

  const seedConflict = (
    id: string,
    createdAt: string,
    resolutionStatus: "open" | "manual_resolved"
  ) => {
    exec(
      `INSERT INTO google_calendar_conflicts
         (id, store_id, calendar_id, google_event_id, conflict_type,
          google_safe_snapshot_json, resolution_status, created_at)
       VALUES (?, ?, 'cal-1', ?, 'overlap', '{}', ?, ?)`,
      [id, STORE_ID, `evt-${id}`, resolutionStatus, createdAt]
    );
  };

  const seedCalendarSyncJob = (
    id: string,
    status: string,
    createdAt: string,
    updatedAt: string = createdAt
  ) => {
    exec(
      `INSERT INTO calendar_sync_jobs
         (id, dedupe_key, owner_type, owner_id, google_action, status, created_at, updated_at)
       VALUES (?, ?, 'reservation', ?, 'insert', ?, ?, ?)`,
      [id, `dedupe-${id}`, `owner-${id}`, status, createdAt, updatedAt]
    );
  };

  const seedImportJob = (
    id: string,
    status: string,
    createdAt: string,
    updatedAt: string = createdAt
  ) => {
    exec(
      `INSERT INTO google_calendar_import_jobs
         (id, store_id, calendar_id, reason, status, dedupe_key, created_at, updated_at)
       VALUES (?, ?, 'cal-1', 'cron_incremental', ?, ?, ?, ?)`,
      [id, STORE_ID, status, `dedupe-${id}`, createdAt, updatedAt]
    );
  };

  const SERVICE_ID = "service_kyoto_default_60";

  // A reservation backing a lock/change-request. status drives the orphan predicate
  // (active = 'pending_approval'|'confirmed'); updated_at drives the grace window.
  const seedReservation = (id: string, status: string, updatedAt: string) => {
    exec(
      `INSERT INTO reservations
         (id, store_id, service_id, customer_id, resource_id, source, status,
          start_at, end_at, duration_minutes, idempotency_key, version, updated_at)
       VALUES (?, ?, ?, ?, ?, 'web_line', ?, ?, ?, 60, ?, 1, ?)`,
      [
        id,
        STORE_ID,
        SERVICE_ID,
        CUSTOMER_ID,
        RESOURCE_ID,
        status,
        "2026-06-01T01:00:00.000Z",
        "2026-06-01T02:00:00.000Z",
        `idem-${id}`,
        updatedAt
      ]
    );
  };

  const seedGoogleEvent = (id: string, status: string, lastSeenAt: string) => {
    exec(
      `INSERT INTO google_calendar_events
         (id, store_id, calendar_id, google_event_id, source_type, status, last_seen_at)
       VALUES (?, ?, 'cal-1', ?, 'unknown', ?, ?)`,
      [id, STORE_ID, `gevt-${id}`, status, lastSeenAt]
    );
  };

  it("deletes expired transient rows past the 7-day grace and keeps fresh ones", async () => {
    // expires_at + 7d grace tables: expired (10 days ago) should go, recent
    // (1 day ago — still inside the 7-day grace) should stay.
    seedIdempotencyKey("idem-old", daysAgo(10));
    seedIdempotencyKey("idem-fresh", daysAgo(1));
    seedAuthState("auth-old", daysAgo(10));
    seedAuthState("auth-fresh", daysAgo(1));
    seedOutboundWrite("out-old", daysAgo(10));
    seedOutboundWrite("out-fresh", daysAgo(1));

    const result = await runRetentionSweepPhase1({
      db: d1 as unknown as D1Database,
      now
    });

    expect(result.skipped).toBe(false);
    if (result.skipped) return;
    expect(result.deleted.idempotency_keys).toBe(1);
    expect(result.deleted.auth_states).toBe(1);
    expect(result.deleted.google_calendar_outbound_writes).toBe(1);

    expect(exists("idempotency_keys", "idem-old")).toBe(false);
    expect(exists("idempotency_keys", "idem-fresh")).toBe(true);
    expect(exists("auth_states", "auth-old")).toBe(false);
    expect(exists("auth_states", "auth-fresh")).toBe(true);
    expect(exists("google_calendar_outbound_writes", "out-old")).toBe(false);
    expect(exists("google_calendar_outbound_writes", "out-fresh")).toBe(true);
  });

  it("purges only expired PENDING locks — never confirmed or NULL-expiry locks", async () => {
    // pending + past grace → purged; pending inside grace → kept.
    seedSlotLock("lock-expired", daysAgo(10));
    seedSlotLock("lock-fresh", daysAgo(1));
    // confirmed locks block bookings regardless of expires_at: a NULL expiry
    // (the normal confirmed shape) and an anomalous stale non-NULL expiry
    // (data-anomaly case the booking path defends against) must BOTH survive the
    // pending-expiry rule. Each is backed by an ACTIVE reservation so the orphan
    // sweep (⑩) also leaves them alone — this test isolates the pending rule.
    seedReservation("owner-lock-confirmed-null", "confirmed", daysAgo(1));
    seedReservation("owner-lock-confirmed-stale", "confirmed", daysAgo(1));
    seedReservation("owner-ctl-confirmed-null", "confirmed", daysAgo(1));
    seedReservation("owner-ctl-confirmed-stale", "confirmed", daysAgo(1));
    seedSlotLock("lock-confirmed-null", null, "confirmed");
    seedSlotLock("lock-confirmed-stale", daysAgo(10), "confirmed");
    seedCustomerTimeLock("ctl-expired", daysAgo(10));
    seedCustomerTimeLock("ctl-fresh", daysAgo(1));
    seedCustomerTimeLock("ctl-confirmed-null", null, "confirmed");
    seedCustomerTimeLock("ctl-confirmed-stale", daysAgo(10), "confirmed");

    const result = await runRetentionSweepPhase1({
      db: d1 as unknown as D1Database,
      now
    });
    if (result.skipped) throw new Error("unexpected skip");

    expect(result.deleted.slot_locks).toBe(1);
    expect(result.deleted.customer_time_locks).toBe(1);
    expect(exists("slot_locks", "lock-expired")).toBe(false);
    expect(exists("slot_locks", "lock-fresh")).toBe(true);
    expect(exists("slot_locks", "lock-confirmed-null")).toBe(true);
    expect(exists("slot_locks", "lock-confirmed-stale")).toBe(true);
    expect(exists("customer_time_locks", "ctl-expired")).toBe(false);
    expect(exists("customer_time_locks", "ctl-fresh")).toBe(true);
    expect(exists("customer_time_locks", "ctl-confirmed-null")).toBe(true);
    expect(exists("customer_time_locks", "ctl-confirmed-stale")).toBe(true);
  });

  it("never sweeps reservation_change_requests (予約履歴 — out of Phase 1 per data-retention.md)", async () => {
    // Owner decision 2026-06-24: change requests are reservation history with an
    // unresolved accounting/tax window (§3.2), so they are NOT auto-deleted. Seed an
    // ancient terminal request and assert it survives + isn't even in the deleted map.
    seedReservation("cr-res-old", "completed", daysAgo(400));
    exec(
      `INSERT INTO reservation_change_requests
         (id, reservation_id, customer_id, request_type, status,
          reservation_version_at_request, current_start_at, current_end_at, updated_at)
       VALUES ('cr-ancient', 'cr-res-old', ?, 'cancel', 'approved', 1, ?, ?, ?)`,
      [CUSTOMER_ID, "2026-06-01T01:00:00.000Z", "2026-06-01T02:00:00.000Z", daysAgo(400)]
    );

    const result = await runRetentionSweepPhase1({ db: d1 as unknown as D1Database, now });
    if (result.skipped) throw new Error("unexpected skip");

    expect(exists("reservation_change_requests", "cr-ancient")).toBe(true);
    expect(result.deleted.reservation_change_requests).toBeUndefined();
  });

  it("purges cancelled/deleted google events past 90 days; keeps active/conflict/ignored and recent", async () => {
    seedGoogleEvent("ge-old-cancelled", "cancelled", daysAgo(91));
    seedGoogleEvent("ge-old-deleted", "deleted", daysAgo(91));
    seedGoogleEvent("ge-recent-cancelled", "cancelled", daysAgo(1)); // recent tombstone → keep
    seedGoogleEvent("ge-old-active", "active", daysAgo(365)); // backs sync dedup → never swept
    seedGoogleEvent("ge-old-conflict", "conflict", daysAgo(365)); // conflict tracking → never swept
    seedGoogleEvent("ge-old-ignored", "ignored", daysAgo(365)); // noise suppression → never swept

    const result = await runRetentionSweepPhase1({ db: d1 as unknown as D1Database, now });
    if (result.skipped) throw new Error("unexpected skip");

    expect(result.deleted.google_calendar_events).toBe(2);
    expect(exists("google_calendar_events", "ge-old-cancelled")).toBe(false);
    expect(exists("google_calendar_events", "ge-old-deleted")).toBe(false);
    expect(exists("google_calendar_events", "ge-recent-cancelled")).toBe(true);
    expect(exists("google_calendar_events", "ge-old-active")).toBe(true);
    expect(exists("google_calendar_events", "ge-old-conflict")).toBe(true);
    expect(exists("google_calendar_events", "ge-old-ignored")).toBe(true);
  });

  it("releases orphaned confirmed locks (terminal/dangling past grace) with history; keeps active and in-grace", async () => {
    // (1) terminal reservation, last touched past the 1-day grace → orphan → swept.
    seedReservation("owner-lock-orphan-terminal", "cancelled_by_customer", daysAgo(5));
    seedSlotLock("lock-orphan-terminal", null, "confirmed");
    // (2) active reservation → NOT an orphan → kept.
    seedReservation("owner-lock-active", "confirmed", daysAgo(5));
    seedSlotLock("lock-active", null, "confirmed");
    // (3) terminal but cancelled WITHIN the grace window → kept (race protection).
    seedReservation("owner-lock-grace", "cancelled_by_customer", daysAgo(0));
    seedSlotLock("lock-grace", null, "confirmed");
    // (4) dangling: no reservation row at all → orphan → swept immediately.
    seedSlotLock("lock-dangling", null, "confirmed");
    // customer_time_locks: terminal-backed orphan → swept (no history table).
    seedReservation("owner-ctl-orphan", "rejected", daysAgo(5));
    seedCustomerTimeLock("ctl-orphan", null, "confirmed");

    const result = await runRetentionSweepPhase1({ db: d1 as unknown as D1Database, now });
    if (result.skipped) throw new Error("unexpected skip");

    // Pending-expiry rule counts are unaffected (no pending locks seeded here).
    expect(result.deleted.slot_locks).toBe(0);
    expect(result.deleted.slot_locks_orphaned).toBe(2);
    expect(result.deleted.customer_time_locks_orphaned).toBe(1);

    expect(exists("slot_locks", "lock-orphan-terminal")).toBe(false);
    expect(exists("slot_locks", "lock-dangling")).toBe(false);
    expect(exists("slot_locks", "lock-active")).toBe(true);
    expect(exists("slot_locks", "lock-grace")).toBe(true);
    expect(exists("customer_time_locks", "ctl-orphan")).toBe(false);

    // Each released slot_lock is audited (action=released, reason=orphaned_confirmed_lock).
    const history = d1.sqlite
      .prepare(
        "SELECT old_owner_id FROM slot_lock_history WHERE action = 'released' AND reason = 'orphaned_confirmed_lock' ORDER BY old_owner_id"
      )
      .all() as Array<{ old_owner_id: string }>;
    expect(history.map((h) => h.old_owner_id)).toEqual([
      "owner-lock-dangling",
      "owner-lock-orphan-terminal"
    ]);
  });

  it("treats the orphan grace boundary as inclusive (>=): exactly-at-cutoff kept, past-cutoff swept", async () => {
    // graceCutoff = NOW - 1 day. A terminal reservation last touched EXACTLY at the
    // cutoff is still protected (>=); one a second earlier is released.
    seedReservation("owner-lock-at-cutoff", "cancelled_by_customer", iso(NOW_MS - MS_PER_DAY));
    seedSlotLock("lock-at-cutoff", null, "confirmed");
    seedReservation("owner-lock-past-cutoff", "cancelled_by_customer", iso(NOW_MS - MS_PER_DAY - 1000));
    seedSlotLock("lock-past-cutoff", null, "confirmed");

    const result = await runRetentionSweepPhase1({ db: d1 as unknown as D1Database, now });
    if (result.skipped) throw new Error("unexpected skip");

    expect(result.deleted.slot_locks_orphaned).toBe(1);
    expect(exists("slot_locks", "lock-at-cutoff")).toBe(true);
    expect(exists("slot_locks", "lock-past-cutoff")).toBe(false);
  });

  it("caps orphan slot_lock release at DELETE_BATCH_LIMIT with history exactly matching deletes", async () => {
    // 501 dangling confirmed locks → only 500 released this run (cap), with EXACTLY
    // 500 audit rows (history == delete, the data-loss-sensitive invariant) and 1
    // left to drain on the next daily run.
    for (let i = 0; i < 501; i++) {
      seedSlotLock(`bulk-${String(i).padStart(4, "0")}`, null, "confirmed");
    }

    const result = await runRetentionSweepPhase1({ db: d1 as unknown as D1Database, now });
    if (result.skipped) throw new Error("unexpected skip");

    expect(result.deleted.slot_locks_orphaned).toBe(500);

    const released = d1.sqlite
      .prepare("SELECT COUNT(*) AS n FROM slot_lock_history WHERE reason = 'orphaned_confirmed_lock'")
      .get() as { n: number | bigint };
    expect(Number(released.n)).toBe(500);

    // Identity (not just count): the audited rows must BE the deleted rows. The one
    // survivor (rowid-LIMIT excludes the last-inserted bulk-0500) must NOT appear in
    // history — proving the batch's history-INSERT and DELETE selected the SAME
    // ORDER BY rowid LIMIT set, not two different 500-row slices with equal counts.
    const survivors = d1.sqlite
      .prepare("SELECT id, owner_id FROM slot_locks")
      .all() as Array<{ id: string; owner_id: string }>;
    expect(survivors).toHaveLength(1);
    expect(survivors[0].id).toBe("bulk-0500");
    const survivorAudited = d1.sqlite
      .prepare("SELECT 1 FROM slot_lock_history WHERE old_owner_id = ? AND reason = 'orphaned_confirmed_lock'")
      .get(survivors[0].owner_id);
    expect(survivorAudited).toBeUndefined();
  });

  it("applies fixed-age windows on the correct timestamp column per table", async () => {
    // line_webhook_events / google_calendar_notifications: 90 days.
    seedWebhookEvent("wh-old", daysAgo(91));
    seedWebhookEvent("wh-fresh", daysAgo(89));
    seedGoogleNotification("gn-old", daysAgo(91));
    seedGoogleNotification("gn-fresh", daysAgo(89));
    // rate_limit_events: 60 days.
    seedRateLimitEvent("rl-old", daysAgo(61));
    seedRateLimitEvent("rl-fresh", daysAgo(59));

    const result = await runRetentionSweepPhase1({
      db: d1 as unknown as D1Database,
      now
    });
    if (result.skipped) throw new Error("unexpected skip");

    expect(result.deleted.line_webhook_events).toBe(1);
    expect(result.deleted.google_calendar_notifications).toBe(1);
    expect(result.deleted.rate_limit_events).toBe(1);
    expect(exists("line_webhook_events", "wh-old")).toBe(false);
    expect(exists("line_webhook_events", "wh-fresh")).toBe(true);
    expect(exists("google_calendar_notifications", "gn-old")).toBe(false);
    expect(exists("google_calendar_notifications", "gn-fresh")).toBe(true);
    expect(exists("rate_limit_events", "rl-old")).toBe(false);
    expect(exists("rate_limit_events", "rl-fresh")).toBe(true);
  });

  it("purges only resolved conflicts older than 180 days; keeps open ones", async () => {
    seedConflict("cf-open-old", daysAgo(200), "open");
    seedConflict("cf-resolved-old", daysAgo(200), "manual_resolved");
    seedConflict("cf-resolved-recent", daysAgo(100), "manual_resolved");

    const result = await runRetentionSweepPhase1({
      db: d1 as unknown as D1Database,
      now
    });
    if (result.skipped) throw new Error("unexpected skip");

    expect(result.deleted.google_calendar_conflicts).toBe(1);
    expect(exists("google_calendar_conflicts", "cf-open-old")).toBe(true);
    expect(exists("google_calendar_conflicts", "cf-resolved-old")).toBe(false);
    expect(exists("google_calendar_conflicts", "cf-resolved-recent")).toBe(true);
  });

  it("is idempotent within the same UTC day (second run is skipped)", async () => {
    seedIdempotencyKey("idem-old", daysAgo(10));

    const first = await runRetentionSweepPhase1({
      db: d1 as unknown as D1Database,
      now
    });
    expect(first.skipped).toBe(false);

    // Insert another expired row; the same-day second run must NOT delete it.
    seedIdempotencyKey("idem-old-2", daysAgo(10));

    const second = await runRetentionSweepPhase1({
      db: d1 as unknown as D1Database,
      now
    });
    expect(second.skipped).toBe(true);
    if (!second.skipped) return;
    expect(second.reason).toBe("already_ran_today");
    // The row added after the first run survives because the second run skipped.
    expect(exists("idempotency_keys", "idem-old-2")).toBe(true);
  });

  it("runs again on a different UTC day", async () => {
    seedIdempotencyKey("idem-day1", daysAgo(10));
    const first = await runRetentionSweepPhase1({
      db: d1 as unknown as D1Database,
      now
    });
    expect(first.skipped).toBe(false);

    seedIdempotencyKey("idem-day2", daysAgo(20));
    const nextDay = () => NOW_MS + MS_PER_DAY;
    const second = await runRetentionSweepPhase1({
      db: d1 as unknown as D1Database,
      now: nextDay
    });
    expect(second.skipped).toBe(false);
    if (second.skipped) return;
    expect(second.deleted.idempotency_keys).toBe(1);
    expect(exists("idempotency_keys", "idem-day2")).toBe(false);
  });

  it("caps each table at 500 rows per run and drains the remainder next day", async () => {
    for (let index = 0; index < 600; index += 1) {
      seedAuthState(`auth-bulk-${index}`, daysAgo(30));
    }
    expect(count("auth_states")).toBe(600);

    const first = await runRetentionSweepPhase1({
      db: d1 as unknown as D1Database,
      now
    });
    if (first.skipped) throw new Error("unexpected skip");
    expect(first.deleted.auth_states).toBe(500);
    expect(count("auth_states")).toBe(100);

    // Next-day run drains the remaining 100.
    const nextDay = () => NOW_MS + MS_PER_DAY;
    const second = await runRetentionSweepPhase1({
      db: d1 as unknown as D1Database,
      now: nextDay
    });
    if (second.skipped) throw new Error("unexpected skip");
    expect(second.deleted.auth_states).toBe(100);
    expect(count("auth_states")).toBe(0);
  });

  it("leaves out-of-scope tables (customers) untouched", async () => {
    const result = await runRetentionSweepPhase1({
      db: d1 as unknown as D1Database,
      now
    });
    if (result.skipped) throw new Error("unexpected skip");
    // Phase 1 must never touch customers / reservations / audit logs.
    expect(result.deleted).not.toHaveProperty("customers");
    expect(exists("customers", CUSTOMER_ID)).toBe(true);
  });

  it("compares CURRENT_TIMESTAMP-format rows correctly (no premature deletion)", async () => {
    // Production INSERTs often rely on the column DEFAULT CURRENT_TIMESTAMP,
    // which stores 'YYYY-MM-DD HH:MM:SS' (space, no T/Z). A raw TEXT '<'
    // against an ISO cutoff would treat same-day space-format rows as older
    // (' ' < 'T') and delete them up to ~a day early. datetime() on both
    // sides normalizes the comparison.
    const nowMs = Date.UTC(2026, 5, 7, 12, 0, 0);
    const cutoffDays = 90;
    const freshMs = nowMs - (cutoffDays - 1) * 24 * 60 * 60 * 1000;
    const oldMs = nowMs - (cutoffDays + 1) * 24 * 60 * 60 * 1000;
    const toCurrentTimestamp = (ms: number) =>
      new Date(ms).toISOString().slice(0, 19).replace("T", " ");

    seedWebhookEvent("evt-fresh-space", toCurrentTimestamp(freshMs));
    seedWebhookEvent("evt-old-space", toCurrentTimestamp(oldMs));

    const result = await runRetentionSweepPhase1({
      db: d1 as unknown as D1Database,
      now: () => nowMs
    });
    expect(result.skipped).toBe(false);

    const rows = d1.sqlite
      .prepare("SELECT id FROM line_webhook_events ORDER BY id")
      .all() as { id: string }[];
    // The 89-day-old space-format row MUST survive; the 91-day-old one is purged.
    expect(rows.map((r) => r.id)).toContain("evt-fresh-space");
    expect(rows.map((r) => r.id)).not.toContain("evt-old-space");
  });

  it("releases the daily marker on a DELETE failure so a same-day retry runs", async () => {
    seedIdempotencyKey("idem-old", daysAgo(10));

    // Fault injection: fail the line_webhook_events DELETE (a mid-sequence
    // rule), leaving earlier tables already swept.
    const failingDb = {
      prepare: (sql: string) => {
        if (sql.includes("line_webhook_events")) {
          return {
            bind: () => ({
              run: () => Promise.reject(new Error("injected_d1_failure"))
            })
          };
        }
        return d1.prepare(sql);
      }
    } as unknown as D1Database;

    await expect(
      runRetentionSweepPhase1({ db: failingDb, now })
    ).rejects.toThrow("injected_d1_failure");
    // Earlier rules in the sequence already ran (partial progress preserved).
    expect(exists("idempotency_keys", "idem-old")).toBe(false);

    // The marker was released, so the SAME-DAY retry must run (not skip) and
    // complete against a healthy db.
    const retry = await runRetentionSweepPhase1({
      db: d1 as unknown as D1Database,
      now
    });
    expect(retry.skipped).toBe(false);
  });

  it("writes a completion marker only after the sweep finishes", async () => {
    const markers = (taskKey: string): Array<{ day_bucket: string; completed_at: string }> =>
      d1.sqlite
        .prepare(
          "SELECT day_bucket, completed_at FROM google_calendar_history_maintenance_runs WHERE task_key = ?"
        )
        .all(taskKey) as Array<{ day_bucket: string; completed_at: string }>;

    const result = await runRetentionSweepPhase1({ db: d1 as unknown as D1Database, now });

    expect(result.skipped).toBe(false);
    expect(markers("retention_sweep_phase1_completed")).toEqual([
      { day_bucket: "2026-06-07", completed_at: iso(NOW_MS) }
    ]);
  });

  it("writes NO completion marker when the sweep fails, even though the lock was taken", async () => {
    // The lock is written before the work and released by the failure handler.
    // The completion marker must never appear for a run that did not finish —
    // it is what the daily-ops heartbeat reads.
    const failingDb = {
      prepare: (sql: string) => {
        if (sql.includes("line_webhook_events")) {
          return {
            bind: () => ({
              run: () => Promise.reject(new Error("injected_d1_failure"))
            })
          };
        }
        return d1.prepare(sql);
      }
    } as unknown as D1Database;

    await expect(runRetentionSweepPhase1({ db: failingDb, now })).rejects.toThrow(
      "injected_d1_failure"
    );

    const completed = d1.sqlite
      .prepare(
        "SELECT COUNT(*) AS n FROM google_calendar_history_maintenance_runs WHERE task_key = ?"
      )
      .get("retention_sweep_phase1_completed") as { n: number | bigint };
    expect(Number(completed.n)).toBe(0);
  });

  it("keeps the sweep successful when only the completion marker write fails", async () => {
    // A marker write failure must not undo deletes that already happened; it is
    // reported to Sentry and surfaces as one night missing from the report.
    seedIdempotencyKey("idem-old", daysAgo(10));
    const failingDb = {
      // `batch` is delegated because this test reaches further into the sweep
      // than the DELETE-failure one above: the orphan-lock release uses it.
      batch: (statements: unknown[]) => d1.batch(statements as never),
      prepare: (sql: string) => {
        if (sql.includes("INSERT OR REPLACE INTO google_calendar_history_maintenance_runs")) {
          return {
            bind: () => ({
              run: () => Promise.reject(new Error("injected_completion_marker_failure"))
            })
          };
        }
        return d1.prepare(sql);
      }
    } as unknown as D1Database;

    const result = await runRetentionSweepPhase1({ db: failingDb, now });

    expect(result.skipped).toBe(false);
    expect(exists("idempotency_keys", "idem-old")).toBe(false);
    expect(safeCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "injected_completion_marker_failure" }),
      expect.objectContaining({
        contexts: expect.objectContaining({
          retention_sweep: expect.objectContaining({ stage: "completion_marker" })
        })
      })
    );
  });

  it("reports a marker INSERT failure to Sentry before rethrowing", async () => {
    // The marker INSERT runs before the main try/catch; without its own
    // capture, a D1 failure here would be swallowed silently by the cron
    // call-site (which assumes every failure path self-reports).
    const failingDb = {
      prepare: (sql: string) => {
        if (sql.includes("INSERT OR IGNORE INTO google_calendar_history_maintenance_runs")) {
          return {
            bind: () => ({
              run: () => Promise.reject(new Error("injected_marker_insert_failure"))
            })
          };
        }
        return d1.prepare(sql);
      }
    } as unknown as D1Database;

    await expect(
      runRetentionSweepPhase1({ db: failingDb, now })
    ).rejects.toThrow("injected_marker_insert_failure");
    expect(safeCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "injected_marker_insert_failure" }),
      expect.objectContaining({
        contexts: expect.objectContaining({
          retention_sweep: expect.objectContaining({ stage: "marker_insert" })
        })
      })
    );
  });

  it("purges only terminal Google sync/import job rows past retention; keeps in-flight and fresh", async () => {
    // calendar_sync_jobs: 90-day retention; import_jobs: 180. Only terminal
    // statuses ('succeeded'/'failed'/'dead') are eligible; in-flight rows
    // ('queued'/'processing'/'retryable') must NEVER be purged, even when old,
    // so a job mid-retry is never deleted out from under its processor.
    seedCalendarSyncJob("cs-terminal-old", "failed", daysAgo(91));
    seedCalendarSyncJob("cs-inflight-old", "processing", daysAgo(91));
    seedCalendarSyncJob("cs-terminal-fresh", "succeeded", daysAgo(89));
    seedImportJob("ij-terminal-old", "succeeded", daysAgo(181));
    seedImportJob("ij-inflight-old", "queued", daysAgo(181));
    seedImportJob("ij-terminal-fresh", "dead", daysAgo(179));

    const result = await runRetentionSweepPhase1({
      db: d1 as unknown as D1Database,
      now
    });
    if (result.skipped) throw new Error("unexpected skip");

    expect(result.deleted.calendar_sync_jobs).toBe(1);
    expect(result.deleted.google_calendar_import_jobs).toBe(1);

    // Terminal + past cutoff → purged.
    expect(exists("calendar_sync_jobs", "cs-terminal-old")).toBe(false);
    expect(exists("google_calendar_import_jobs", "ij-terminal-old")).toBe(false);
    // In-flight → never purged, even when older than the cutoff.
    expect(exists("calendar_sync_jobs", "cs-inflight-old")).toBe(true);
    expect(exists("google_calendar_import_jobs", "ij-inflight-old")).toBe(true);
    // Terminal but inside the retention window → kept.
    expect(exists("calendar_sync_jobs", "cs-terminal-fresh")).toBe(true);
    expect(exists("google_calendar_import_jobs", "ij-terminal-fresh")).toBe(true);
  });

  it("never sweeps notification_jobs — reserved for Phase 2 per data-retention policy", async () => {
    // notification_jobs / notification_logs are 送達証跡 (delivery evidence) with a
    // 1–2yr reference window; data-retention.md §4 defers their automatic deletion
    // to Phase 2 pending an owner-approved window. Phase 1 must leave even a
    // long-terminal row untouched (no rule, so no deleted-count key either).
    exec(
      `INSERT INTO notification_jobs
         (id, dedupe_key, template_key, recipient_type, recipient_id, status, created_at, updated_at)
       VALUES ('nj-policy', 'dedupe-nj-policy', 'reservation_confirmed', 'customer', 'rcpt-nj-policy', 'dead', ?, ?)`,
      [daysAgo(400), daysAgo(400)]
    );

    const result = await runRetentionSweepPhase1({
      db: d1 as unknown as D1Database,
      now
    });
    if (result.skipped) throw new Error("unexpected skip");

    expect(result.deleted.notification_jobs).toBeUndefined();
    expect(exists("notification_jobs", "nj-policy")).toBe(true);
  });

  it("keeps an old job that only just reached a terminal state (updated_at within window)", async () => {
    // A job created long ago can be dead-lettered or retried-then-failed
    // *recently*. Retention is keyed off updated_at, so the fresh failure stays
    // visible to the admin attention list / 24h ops counts until it ages out by
    // last activity — it is NOT swept just because created_at is past the window.
    seedCalendarSyncJob("cs-old-fresh-fail", "failed", daysAgo(120), daysAgo(1));
    seedImportJob("ij-old-fresh-fail", "dead", daysAgo(300), daysAgo(1));
    // Control: old by both timestamps → still swept.
    seedCalendarSyncJob("cs-old-stale", "failed", daysAgo(120), daysAgo(120));

    const result = await runRetentionSweepPhase1({
      db: d1 as unknown as D1Database,
      now
    });
    if (result.skipped) throw new Error("unexpected skip");

    expect(exists("calendar_sync_jobs", "cs-old-fresh-fail")).toBe(true);
    expect(exists("google_calendar_import_jobs", "ij-old-fresh-fail")).toBe(true);
    expect(exists("calendar_sync_jobs", "cs-old-stale")).toBe(false);
  });
});
