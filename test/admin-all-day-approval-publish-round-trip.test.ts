import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  approveAllDayAsClosure,
  rejectAllDayConflict
} from "../src/admin/conflict-resolutions";
import type { AdminUser, AdminRole } from "../src/admin/access";
import { createMigratedSqliteD1 as createBaseD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const STORE_ID = "kyoto";
const CALENDAR_ID = "calendar-a@example.invalid";
const CONFLICT_ID = "conflict_roundtrip_1";
const RESOURCE_ID = "resource_kyoto_calendar";

// Date-only snapshot (Google all-day event with start.date / end.date)
const DATE_ONLY_SNAPSHOT = JSON.stringify({
  google_event_id: "evt_allday_roundtrip",
  status: "confirmed",
  start_at: "2026-05-24T15:00:00.000Z",
  end_at: "2026-05-25T15:00:00.000Z",
  start_date: "2026-05-25",
  end_date: "2026-05-26",
  all_day: true,
  recurring: false,
  transparency: "opaque",
  summary: "店休 2026-05-25"
});

// Legacy snapshot (dateTime-based, no start_date/end_date)
const DATETIME_SNAPSHOT = JSON.stringify({
  summary: "店休 2026-06-15",
  start_at: "2026-06-15T00:00:00.000Z",
  end_at: "2026-06-16T00:00:00.000Z"
});

const seedAllDayConflict = (
  d1: SqliteD1Database,
  opts: {
    id?: string;
    storeId?: string;
    status?: string;
    snapshot?: string;
    googleEventId?: string;
  } = {}
) => {
  d1.sqlite
    .prepare(
      `INSERT INTO google_calendar_conflicts (
         id, store_id, calendar_id, google_event_id,
         conflict_type, google_safe_snapshot_json, resolution_status
       ) VALUES (?, ?, ?, ?, 'google_all_day_event', ?, ?)`
    )
    .run(
      opts.id ?? CONFLICT_ID,
      opts.storeId ?? STORE_ID,
      CALENDAR_ID,
      opts.googleEventId ?? "evt_allday_roundtrip",
      opts.snapshot ?? DATE_ONLY_SNAPSHOT,
      opts.status ?? "open"
    );
};

const fixtureAdmin = (role: AdminRole): AdminUser => ({
  id: "admin_roundtrip_test",
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

const countExternalBlocks = (d1: SqliteD1Database): number => {
  const row = d1.sqlite.prepare("SELECT count(*) AS cnt FROM external_blocks").get() as { cnt: number };
  return row.cnt;
};

const countSyncJobs = (d1: SqliteD1Database): number => {
  const row = d1.sqlite.prepare("SELECT count(*) AS cnt FROM calendar_sync_jobs").get() as {
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

type ExternalBlockRow = {
  id: string;
  store_id: string;
  resource_id: string;
  source: string;
  title_snapshot: string | null;
  start_at: string;
  end_at: string;
  status: string;
  google_event_id: string | null;
  created_by: string | null;
};

const fetchExternalBlock = (d1: SqliteD1Database): ExternalBlockRow | null => {
  const row = d1.sqlite
    .prepare(
      `SELECT id, store_id, resource_id, source, title_snapshot,
              start_at, end_at, status, google_event_id, created_by
       FROM external_blocks LIMIT 1`
    )
    .get() as ExternalBlockRow | undefined;
  return row ?? null;
};

type SyncJobRow = {
  id: string;
  dedupe_key: string;
  owner_type: string;
  owner_id: string;
  google_action: string;
  status: string;
};

const fetchSyncJob = (d1: SqliteD1Database): SyncJobRow | null => {
  const row = d1.sqlite
    .prepare(
      `SELECT id, dedupe_key, owner_type, owner_id, google_action, status
       FROM calendar_sync_jobs LIMIT 1`
    )
    .get() as SyncJobRow | undefined;
  return row ?? null;
};

type AuditRow = {
  metadata_json: string;
};

const fetchAuditMetadata = (d1: SqliteD1Database): Record<string, unknown> | null => {
  const row = d1.sqlite
    .prepare(
      `SELECT metadata_json FROM audit_logs
       WHERE action = 'all_day_conflict_approved_as_closure'
       LIMIT 1`
    )
    .get() as AuditRow | undefined;
  if (!row) return null;
  return JSON.parse(row.metadata_json) as Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("approveAllDayAsClosure — publish round-trip", () => {
  let d1: SqliteD1Database;

  beforeEach(() => {
    d1 = createMigratedSqliteD1();
  });

  afterEach(() => {
    d1.sqlite.close();
  });

  it("happy path: inserts external_blocks with correct fields", async () => {
    seedAllDayConflict(d1);

    const result = await approveAllDayAsClosure({
      db: d1 as unknown as D1Database,
      admin: fixtureAdmin("owner"),
      conflictId: CONFLICT_ID,
      request: { idempotencyKey: "key_rt_1" }
    });

    expect(result.ok).toBe(true);
    expect(countExternalBlocks(d1)).toBe(1);

    const block = fetchExternalBlock(d1)!;
    expect(block.store_id).toBe(STORE_ID);
    expect(block.resource_id).toBe(RESOURCE_ID);
    expect(block.source).toBe("admin_block");
    expect(block.status).toBe("active");
    expect(block.google_event_id).toBe("evt_allday_roundtrip");
    expect(block.created_by).toBe("admin_roundtrip_test");
    expect(block.title_snapshot).toBe("店休 2026-05-25");
    // Date-only: JST midnight → UTC ISO Z
    expect(block.start_at).toBe("2026-05-24T15:00:00.000Z");
    expect(block.end_at).toBe("2026-05-25T15:00:00.000Z");
  });

  it("happy path: inserts calendar_sync_jobs with correct dedupe_key and owner", async () => {
    seedAllDayConflict(d1);

    const result = await approveAllDayAsClosure({
      db: d1 as unknown as D1Database,
      admin: fixtureAdmin("owner"),
      conflictId: CONFLICT_ID,
      request: { idempotencyKey: "key_rt_2" }
    });

    expect(result.ok).toBe(true);
    expect(countSyncJobs(d1)).toBe(1);

    const job = fetchSyncJob(d1)!;
    expect(job.owner_type).toBe("external_block");
    expect(job.google_action).toBe("upsert");
    expect(job.status).toBe("queued");
    // owner_id should match the external_block id
    const block = fetchExternalBlock(d1)!;
    expect(job.owner_id).toBe(block.id);
    // Dedupe key must contain external_block id
    expect(job.dedupe_key).toContain("external_block:");
  });

  it("selects the representative resource: first active by created_at ASC", async () => {
    // Insert a second resource with a later creation time
    d1.sqlite
      .prepare(
        `INSERT INTO store_resources (id, store_id, name, resource_type, active, created_at)
         VALUES ('resource_kyoto_room', 'kyoto', '個室', 'staff_calendar', 1, '2099-01-01T00:00:00.000Z')`
      )
      .run();
    seedAllDayConflict(d1);

    const result = await approveAllDayAsClosure({
      db: d1 as unknown as D1Database,
      admin: fixtureAdmin("owner"),
      conflictId: CONFLICT_ID,
      request: { idempotencyKey: "key_rt_3" }
    });

    expect(result.ok).toBe(true);
    const block = fetchExternalBlock(d1)!;
    // Should pick the earliest-created resource (resource_kyoto_calendar from dev.sql)
    expect(block.resource_id).toBe(RESOURCE_ID);
  });

  it("returns no_active_resource when all resources are inactive", async () => {
    // Deactivate all resources
    d1.sqlite.prepare("UPDATE store_resources SET active = 0 WHERE store_id = ?").run(STORE_ID);
    seedAllDayConflict(d1);

    const result = await approveAllDayAsClosure({
      db: d1 as unknown as D1Database,
      admin: fixtureAdmin("owner"),
      conflictId: CONFLICT_ID,
      request: { idempotencyKey: "key_rt_4" }
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("no_active_resource");
    }
    // No closure, no external_block, no sync_job should be created
    expect(countClosures(d1)).toBe(0);
    expect(countExternalBlocks(d1)).toBe(0);
    expect(countSyncJobs(d1)).toBe(0);
    // Conflict should still be open (no_active_resource fails before claim)
    expect(fetchConflictStatus(d1, CONFLICT_ID)).toBe("open");
  });

  it("idempotency replay: does NOT duplicate external_block or sync_job", async () => {
    seedAllDayConflict(d1);

    const first = await approveAllDayAsClosure({
      db: d1 as unknown as D1Database,
      admin: fixtureAdmin("owner"),
      conflictId: CONFLICT_ID,
      request: { idempotencyKey: "key_rt_idem" }
    });
    expect(first.ok).toBe(true);

    const second = await approveAllDayAsClosure({
      db: d1 as unknown as D1Database,
      admin: fixtureAdmin("owner"),
      conflictId: CONFLICT_ID,
      request: { idempotencyKey: "key_rt_idem" }
    });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.replayed).toBe(true);

    // Only 1 of each
    expect(countClosures(d1)).toBe(1);
    expect(countExternalBlocks(d1)).toBe(1);
    expect(countSyncJobs(d1)).toBe(1);
  });

  it("date-only snapshot: store_closures and external_blocks use UTC ISO Z from JST midnight", async () => {
    seedAllDayConflict(d1);

    const result = await approveAllDayAsClosure({
      db: d1 as unknown as D1Database,
      admin: fixtureAdmin("owner"),
      conflictId: CONFLICT_ID,
      request: { idempotencyKey: "key_rt_dateonly" }
    });
    expect(result.ok).toBe(true);

    const closure = d1.sqlite
      .prepare("SELECT starts_at, ends_at FROM store_closures LIMIT 1")
      .get() as { starts_at: string; ends_at: string };

    // JST 2026-05-25 midnight → UTC 2026-05-24T15:00:00.000Z
    expect(closure.starts_at).toBe("2026-05-24T15:00:00.000Z");
    expect(closure.ends_at).toBe("2026-05-25T15:00:00.000Z");

    const block = fetchExternalBlock(d1)!;
    expect(block.start_at).toBe("2026-05-24T15:00:00.000Z");
    expect(block.end_at).toBe("2026-05-25T15:00:00.000Z");
  });

  it("audit metadata includes externalBlockId, resourceId, and syncJobDedupeKey", async () => {
    seedAllDayConflict(d1);

    await approveAllDayAsClosure({
      db: d1 as unknown as D1Database,
      admin: fixtureAdmin("owner"),
      conflictId: CONFLICT_ID,
      request: { idempotencyKey: "key_rt_audit" }
    });

    const meta = fetchAuditMetadata(d1);
    expect(meta).not.toBeNull();
    expect(meta!.externalBlockId).toBeDefined();
    expect(typeof meta!.externalBlockId).toBe("string");
    expect(meta!.resourceId).toBe(RESOURCE_ID);
    expect(meta!.syncJobDedupeKey).toBeDefined();
    expect(typeof meta!.syncJobDedupeKey).toBe("string");
    expect(meta!.closureId).toBeDefined();
  });

  it("backward compat: dateTime-based snapshot still produces correct closure", async () => {
    seedAllDayConflict(d1, { snapshot: DATETIME_SNAPSHOT });

    const result = await approveAllDayAsClosure({
      db: d1 as unknown as D1Database,
      admin: fixtureAdmin("owner"),
      conflictId: CONFLICT_ID,
      request: { idempotencyKey: "key_rt_backcompat" }
    });

    expect(result.ok).toBe(true);
    expect(countClosures(d1)).toBe(1);
    expect(countExternalBlocks(d1)).toBe(1);

    const closure = d1.sqlite
      .prepare("SELECT starts_at, ends_at FROM store_closures LIMIT 1")
      .get() as { starts_at: string; ends_at: string };
    expect(closure.starts_at).toBe("2026-06-15T00:00:00.000Z");
    expect(closure.ends_at).toBe("2026-06-16T00:00:00.000Z");
  });

  it("parseSnapshotDates fallback: date-only snapshot with start_date/end_date but no start_at/end_at", async () => {
    // Simulate a legacy snapshot that has date-only fields but no start_at/end_at
    const legacyDateOnlySnapshot = JSON.stringify({
      summary: "店休 legacy",
      start_date: "2026-07-01",
      end_date: "2026-07-02"
    });
    seedAllDayConflict(d1, { snapshot: legacyDateOnlySnapshot });

    const result = await approveAllDayAsClosure({
      db: d1 as unknown as D1Database,
      admin: fixtureAdmin("owner"),
      conflictId: CONFLICT_ID,
      request: { idempotencyKey: "key_rt_fallback" }
    });

    expect(result.ok).toBe(true);
    expect(countClosures(d1)).toBe(1);

    const closure = d1.sqlite
      .prepare("SELECT starts_at, ends_at FROM store_closures LIMIT 1")
      .get() as { starts_at: string; ends_at: string };
    // 2026-07-01 JST → 2026-06-30T15:00:00.000Z
    expect(closure.starts_at).toBe("2026-06-30T15:00:00.000Z");
    expect(closure.ends_at).toBe("2026-07-01T15:00:00.000Z");
  });

  it("store_closures overlap: JST midnight closure vs JST early-morning reservation", async () => {
    // Insert a reservation that starts at JST 00:30 on 2026-05-25
    // (UTC: 2026-05-24T15:30:00.000Z)
    d1.sqlite
      .prepare(
        `INSERT INTO customers (id, display_name)
         VALUES ('cust_overlap', 'テスト顧客')`
      )
      .run();
    d1.sqlite
      .prepare(
        `INSERT INTO reservations (
           id, store_id, customer_id, resource_id, service_id, source,
           start_at, end_at, duration_minutes, status, version, idempotency_key
         ) VALUES (
           'res_overlap', 'kyoto', 'cust_overlap', 'resource_kyoto_calendar',
           'service_kyoto_default_60', 'web_line',
           '2026-05-24T15:30:00.000Z', '2026-05-24T16:30:00.000Z',
           60, 'confirmed', 1, 'idem_overlap_test'
         )`
      )
      .run();

    seedAllDayConflict(d1);

    // The all-day window covers 2026-05-24T15:00 - 2026-05-25T15:00 UTC while the
    // reservation sits at JST 00:30 (2026-05-24T15:30Z). Detecting this overlap —
    // and refusing the approval — proves the same JST↔UTC boundary conversion the
    // old success-path assertion documented, now through the overlap guard
    // (issue #467: approving would strand the confirmed reservation inside the
    // closure).
    const result = await approveAllDayAsClosure({
      db: d1 as unknown as D1Database,
      admin: fixtureAdmin("owner"),
      conflictId: CONFLICT_ID,
      request: { idempotencyKey: "key_rt_overlap" }
    });

    expect(result).toEqual({ ok: false, reason: "overlapping_reservations" });

    const closureCount = d1.sqlite
      .prepare("SELECT COUNT(*) AS cnt FROM store_closures")
      .get() as { cnt: number };
    expect(closureCount.cnt).toBe(0);
    const blockCount = d1.sqlite
      .prepare("SELECT COUNT(*) AS cnt FROM external_blocks")
      .get() as { cnt: number };
    expect(blockCount.cnt).toBe(0);
    expect(fetchConflictStatus(d1, CONFLICT_ID)).toBe("open");
  });
});

// ---------------------------------------------------------------------------
// Existing test backward compatibility
// ---------------------------------------------------------------------------

describe("existing all-day approval regression", () => {
  let d1: SqliteD1Database;

  beforeEach(() => {
    d1 = createMigratedSqliteD1();
  });

  afterEach(() => {
    d1.sqlite.close();
  });

  it("rejects staff role with forbidden (unchanged)", async () => {
    seedAllDayConflict(d1);

    const result = await approveAllDayAsClosure({
      db: d1 as unknown as D1Database,
      admin: fixtureAdmin("staff"),
      conflictId: CONFLICT_ID,
      request: { idempotencyKey: "key_staff_rt" }
    });

    expect(result).toEqual({ ok: false, reason: "forbidden" });
    expect(countClosures(d1)).toBe(0);
    expect(countExternalBlocks(d1)).toBe(0);
  });

  it("returns invalid_snapshot for completely missing date fields", async () => {
    seedAllDayConflict(d1, { snapshot: '{"missing":"dates"}' });

    const result = await approveAllDayAsClosure({
      db: d1 as unknown as D1Database,
      admin: fixtureAdmin("owner"),
      conflictId: CONFLICT_ID,
      request: { idempotencyKey: "key_bad_snapshot_rt" }
    });

    expect(result).toEqual({ ok: false, reason: "invalid_snapshot" });
    expect(countClosures(d1)).toBe(0);
    expect(countExternalBlocks(d1)).toBe(0);
  });

  it("returns invalid_request when conflict calendar_id does not match store google_calendar_id", async () => {
    // Seed a conflict with a mismatched calendar_id
    d1.sqlite
      .prepare(
        `INSERT INTO google_calendar_conflicts (
           id, store_id, calendar_id, google_event_id,
           conflict_type, google_safe_snapshot_json, resolution_status
         ) VALUES (?, ?, 'stale_calendar@example.com', 'evt_stale', 'google_all_day_event', ?, 'open')`
      )
      .run("conflict_stale_cal", STORE_ID, DATE_ONLY_SNAPSHOT);

    const result = await approveAllDayAsClosure({
      db: d1 as unknown as D1Database,
      admin: fixtureAdmin("owner"),
      conflictId: "conflict_stale_cal",
      request: { idempotencyKey: "key_stale_cal" }
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_request");
    }
    expect(countClosures(d1)).toBe(0);
    expect(countExternalBlocks(d1)).toBe(0);
    expect(countSyncJobs(d1)).toBe(0);
  });

  it("returns invalid_snapshot when start_at >= end_at", async () => {
    const invertedSnapshot = JSON.stringify({
      summary: "Bad range",
      start_at: "2026-06-16T00:00:00.000Z",
      end_at: "2026-06-15T00:00:00.000Z"
    });
    seedAllDayConflict(d1, { snapshot: invertedSnapshot });

    const result = await approveAllDayAsClosure({
      db: d1 as unknown as D1Database,
      admin: fixtureAdmin("owner"),
      conflictId: CONFLICT_ID,
      request: { idempotencyKey: "key_inverted" }
    });

    expect(result).toEqual({ ok: false, reason: "invalid_snapshot" });
    expect(countClosures(d1)).toBe(0);
  });

  it("returns invalid_snapshot when start_at equals end_at (zero-duration)", async () => {
    const zeroDurationSnapshot = JSON.stringify({
      summary: "Zero duration",
      start_at: "2026-06-15T00:00:00.000Z",
      end_at: "2026-06-15T00:00:00.000Z"
    });
    seedAllDayConflict(d1, { snapshot: zeroDurationSnapshot });

    const result = await approveAllDayAsClosure({
      db: d1 as unknown as D1Database,
      admin: fixtureAdmin("owner"),
      conflictId: CONFLICT_ID,
      request: { idempotencyKey: "key_zero" }
    });

    expect(result).toEqual({ ok: false, reason: "invalid_snapshot" });
  });

  it("returns invalid_snapshot for date-only with JS-normalized invalid date (Feb 30)", async () => {
    const badDateSnapshot = JSON.stringify({
      summary: "Bad date",
      start_date: "2026-02-30",
      end_date: "2026-03-01"
    });
    seedAllDayConflict(d1, { snapshot: badDateSnapshot });

    const result = await approveAllDayAsClosure({
      db: d1 as unknown as D1Database,
      admin: fixtureAdmin("owner"),
      conflictId: CONFLICT_ID,
      request: { idempotencyKey: "key_feb30" }
    });

    expect(result).toEqual({ ok: false, reason: "invalid_snapshot" });
  });

  it("returns invalid_snapshot for non-canonical start_at (JS-normalized Feb 30)", async () => {
    // JS silently normalises 2026-02-30 → 2026-03-02, but
    // isValidIsoTimestamp now rejects the non-canonical input string.
    const nonCanonicalSnapshot = JSON.stringify({
      summary: "Non-canonical",
      start_at: "2026-02-30T00:00:00.000Z",
      end_at: "2026-03-10T00:00:00.000Z"
    });
    seedAllDayConflict(d1, { snapshot: nonCanonicalSnapshot });

    const result = await approveAllDayAsClosure({
      db: d1 as unknown as D1Database,
      admin: fixtureAdmin("owner"),
      conflictId: CONFLICT_ID,
      request: { idempotencyKey: "key_noncanonical" }
    });

    expect(result).toEqual({ ok: false, reason: "invalid_snapshot" });
  });

  it("returns invalid_snapshot for offset-form start_at (non-Z suffix)", async () => {
    const offsetSnapshot = JSON.stringify({
      summary: "Offset form",
      start_at: "2026-06-15T09:00:00+09:00",
      end_at: "2026-06-16T00:00:00.000Z"
    });
    seedAllDayConflict(d1, { snapshot: offsetSnapshot });

    const result = await approveAllDayAsClosure({
      db: d1 as unknown as D1Database,
      admin: fixtureAdmin("owner"),
      conflictId: CONFLICT_ID,
      request: { idempotencyKey: "key_offset" }
    });

    expect(result).toEqual({ ok: false, reason: "invalid_snapshot" });
  });
});

// Domain calls use the same persisted actor snapshot as authenticated routes.
const createMigratedSqliteD1 = () => {
  const db = createBaseD1();
  db.sqlite.exec("INSERT INTO admin_users(id,email,access_subject,role) VALUES ('admin_roundtrip_test','admin_roundtrip_test@example.test','admin_roundtrip_test','owner')");
  return db;
};
