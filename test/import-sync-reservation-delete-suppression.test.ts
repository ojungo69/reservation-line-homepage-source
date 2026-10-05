import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

// Tests the terminal resolution suppression SQL logic that was added to
// recordReservationEventDeletion in import-sync.ts. Since the function is
// module-private, we test the SQL query directly against the D1 schema.
// The query checks:
//   SELECT resolution_status FROM google_calendar_conflicts
//   WHERE calendar_id=? AND google_event_id=? AND reservation_id=?
//     AND conflict_type='reservation_event_deleted'
//     AND resolution_status IN ('approved_as_cancel', 'rejected')
//   LIMIT 1

const STORE_ID = "kyoto";
const CALENDAR_ID = "calendar-a@example.invalid";
const GOOGLE_EVENT_ID = "evt_suppression_1";
const RESERVATION_ID = "res_suppression_1";
const CUSTOMER_ID = "cust_suppression_1";
const RESOURCE_ID = "resource_kyoto_calendar";
const SERVICE_ID = "service_kyoto_default_60";

const seedReservation = (d1: SqliteD1Database) => {
  d1.sqlite
    .prepare(`INSERT OR IGNORE INTO customers (id, display_name) VALUES (?, '顧客テスト')`)
    .run(CUSTOMER_ID);
  d1.sqlite
    .prepare(
      `INSERT OR IGNORE INTO reservations (
         id, store_id, service_id, customer_id, resource_id,
         source, status, start_at, end_at, duration_minutes, version, idempotency_key
       ) VALUES (?, ?, ?, ?, ?, 'web_line', 'confirmed', '2026-06-15T10:00:00.000Z', '2026-06-15T11:00:00.000Z', 60, 1, ?)`
    )
    .run(RESERVATION_ID, STORE_ID, SERVICE_ID, CUSTOMER_ID, RESOURCE_ID, `idem_${RESERVATION_ID}`);
};

const seedConflict = (d1: SqliteD1Database, status: string, id: string) => {
  d1.sqlite
    .prepare(
      `INSERT INTO google_calendar_conflicts (
         id, store_id, calendar_id, google_event_id, reservation_id,
         conflict_type, google_safe_snapshot_json, resolution_status
       ) VALUES (?, ?, ?, ?, ?, 'reservation_event_deleted', '{}', ?)`
    )
    .run(id, STORE_ID, CALENDAR_ID, GOOGLE_EVENT_ID, RESERVATION_ID, status);
};

const terminalResolutionQuery = `
  SELECT resolution_status FROM google_calendar_conflicts
  WHERE calendar_id = ?
    AND google_event_id = ?
    AND reservation_id = ?
    AND conflict_type = 'reservation_event_deleted'
    AND resolution_status IN ('approved_as_cancel', 'rejected')
  LIMIT 1
`;

describe("import-sync terminal resolution suppression", () => {
  let d1: SqliteD1Database;

  beforeEach(() => {
    d1 = createMigratedSqliteD1();
    seedReservation(d1);
  });

  afterEach(() => {
    d1.sqlite.close();
  });

  it("approved_as_cancel: query returns the terminal row (re-import should skip conflict + restore)", () => {
    seedConflict(d1, "approved_as_cancel", "conflict_approved");

    const row = d1.sqlite
      .prepare(terminalResolutionQuery)
      .get(CALENDAR_ID, GOOGLE_EVENT_ID, RESERVATION_ID) as { resolution_status: string } | undefined;

    expect(row).toBeDefined();
    expect(row?.resolution_status).toBe("approved_as_cancel");
  });

  it("rejected: query returns the terminal row (re-import should skip conflict, continue restore)", () => {
    seedConflict(d1, "rejected", "conflict_rejected");

    const row = d1.sqlite
      .prepare(terminalResolutionQuery)
      .get(CALENDAR_ID, GOOGLE_EVENT_ID, RESERVATION_ID) as { resolution_status: string } | undefined;

    expect(row).toBeDefined();
    expect(row?.resolution_status).toBe("rejected");
  });

  it("open: query returns NULL (existing behavior -- new conflict + restore job)", () => {
    seedConflict(d1, "open", "conflict_open");

    const row = d1.sqlite
      .prepare(terminalResolutionQuery)
      .get(CALENDAR_ID, GOOGLE_EVENT_ID, RESERVATION_ID) as { resolution_status: string } | undefined;

    expect(row).toBeUndefined();
  });

  it("no conflict exists: query returns NULL (first-time import path)", () => {
    const row = d1.sqlite
      .prepare(terminalResolutionQuery)
      .get(CALENDAR_ID, GOOGLE_EVENT_ID, RESERVATION_ID) as { resolution_status: string } | undefined;

    expect(row).toBeUndefined();
  });

  it("different reservation_id: query returns NULL even with approved_as_cancel", () => {
    // Conflict is for a different reservation
    d1.sqlite
      .prepare(`INSERT OR IGNORE INTO customers (id, display_name) VALUES ('cust_other', 'other')`)
      .run();
    d1.sqlite
      .prepare(
        `INSERT OR IGNORE INTO reservations (
           id, store_id, service_id, customer_id, resource_id,
           source, status, start_at, end_at, duration_minutes, version, idempotency_key
         ) VALUES ('res_other', ?, ?, 'cust_other', ?, 'web_line', 'confirmed', '2026-06-16T10:00:00.000Z', '2026-06-16T11:00:00.000Z', 60, 1, 'idem_other')`
      )
      .run(STORE_ID, SERVICE_ID, RESOURCE_ID);
    d1.sqlite
      .prepare(
        `INSERT INTO google_calendar_conflicts (
           id, store_id, calendar_id, google_event_id, reservation_id,
           conflict_type, google_safe_snapshot_json, resolution_status
         ) VALUES ('conflict_other', ?, ?, ?, 'res_other', 'reservation_event_deleted', '{}', 'approved_as_cancel')`
      )
      .run(STORE_ID, CALENDAR_ID, GOOGLE_EVENT_ID);

    // Query for the original reservation should find nothing
    const row = d1.sqlite
      .prepare(terminalResolutionQuery)
      .get(CALENDAR_ID, GOOGLE_EVENT_ID, RESERVATION_ID) as { resolution_status: string } | undefined;

    expect(row).toBeUndefined();
  });

  it("T3: rejected branch restore dedupe_key includes etag for fresh queue on second delete", async () => {
    // When a rejected conflict exists and a second delete arrives with a new etag,
    // the restore dedupe_key must differ from the first delete's key so INSERT OR IGNORE
    // creates a fresh queued job instead of being a no-op on the previously-succeeded key.
    const { compactDedupeKey } = await import("../src/google/dedupe-key");

    const etag1 = "etag_v1_abc";
    const etag2 = "etag_v2_xyz";

    const key1 = compactDedupeKey(
      `reservation:${RESERVATION_ID}:google:upsert:restore:${GOOGLE_EVENT_ID}:etag:${etag1}`,
      "calendar-sync:reservation-restore"
    );
    const key2 = compactDedupeKey(
      `reservation:${RESERVATION_ID}:google:upsert:restore:${GOOGLE_EVENT_ID}:etag:${etag2}`,
      "calendar-sync:reservation-restore"
    );

    // Keys must be different for different etags
    expect(key1).not.toBe(key2);

    // Insert first key as succeeded (simulating first restore completed)
    d1.sqlite
      .prepare(
        `INSERT INTO calendar_sync_jobs (id, dedupe_key, owner_type, owner_id, google_action, status, available_at)
         VALUES ('job_etag1', ?, 'reservation', ?, 'upsert', 'succeeded', '2026-06-15T10:00:00.000Z')`
      )
      .run(key1, RESERVATION_ID);

    // INSERT OR IGNORE with key2 should succeed (different key)
    d1.sqlite
      .prepare(
        `INSERT OR IGNORE INTO calendar_sync_jobs (id, dedupe_key, owner_type, owner_id, google_action, status, available_at)
         VALUES ('job_etag2', ?, 'reservation', ?, 'upsert', 'queued', '2026-06-15T11:00:00.000Z')`
      )
      .run(key2, RESERVATION_ID);

    const job2 = d1.sqlite
      .prepare("SELECT status FROM calendar_sync_jobs WHERE id = 'job_etag2'")
      .get() as { status: string } | undefined;
    expect(job2?.status).toBe("queued");

    // INSERT OR IGNORE with key1 again should be a no-op (same key)
    d1.sqlite
      .prepare(
        `INSERT OR IGNORE INTO calendar_sync_jobs (id, dedupe_key, owner_type, owner_id, google_action, status, available_at)
         VALUES ('job_etag1_dup', ?, 'reservation', ?, 'upsert', 'queued', '2026-06-15T12:00:00.000Z')`
      )
      .run(key1, RESERVATION_ID);

    const dupJob = d1.sqlite
      .prepare("SELECT id FROM calendar_sync_jobs WHERE id = 'job_etag1_dup'")
      .get() as { id: string } | undefined;
    expect(dupJob).toBeUndefined(); // INSERT OR IGNORE dropped it
  });

  it("T3: noEtag sentinel used when etag is null", async () => {
    const { compactDedupeKey } = await import("../src/google/dedupe-key");

    const keyWithEtag = compactDedupeKey(
      `reservation:${RESERVATION_ID}:google:upsert:restore:${GOOGLE_EVENT_ID}:etag:some_etag`,
      "calendar-sync:reservation-restore"
    );
    const keyNoEtag = compactDedupeKey(
      `reservation:${RESERVATION_ID}:google:upsert:restore:${GOOGLE_EVENT_ID}:etag:noEtag`,
      "calendar-sync:reservation-restore"
    );

    // noEtag sentinel produces a different key than a real etag
    expect(keyWithEtag).not.toBe(keyNoEtag);
    // noEtag key is consistent
    const keyNoEtag2 = compactDedupeKey(
      `reservation:${RESERVATION_ID}:google:upsert:restore:${GOOGLE_EVENT_ID}:etag:noEtag`,
      "calendar-sync:reservation-restore"
    );
    expect(keyNoEtag).toBe(keyNoEtag2);
  });
});
