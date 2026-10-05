import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createMigratedSqliteD1 } from "./helpers/sqlite-d1";

describe("initial D1 migration", () => {
  const sql = readFileSync(join(process.cwd(), "migrations/0001_initial.sql"), "utf8");
  const pendingExpiryIndexSql = readFileSync(join(process.cwd(), "migrations/0002_pending_expiry_index.sql"), "utf8");
  const seedSql = readFileSync(join(process.cwd(), "seeds/dev.sql"), "utf8");
  const createTableSql = (tableName: string) => {
    const match = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${tableName} \\([\\s\\S]*?\\n\\);`));
    expect(match).not.toBeNull();
    return match?.[0] ?? "";
  };

  it("creates the core source-of-truth tables", () => {
    for (const tableName of [
      "stores",
      "store_settings",
      "store_resources",
      "staff_members",
      "admin_users",
      "services",
      "service_stores",
      "store_business_hours",
      "store_closures",
      "customers",
      "line_identities",
      "customer_match_candidates",
      "reservations",
      "slot_locks",
      "slot_lock_history",
      "customer_time_locks",
      "customer_visits",
      "external_blocks",
      "consent_records",
      "idempotency_keys",
      "auth_states",
      "rate_limit_events",
      "job_leases",
      "notification_jobs",
      "notification_logs",
      "line_webhook_events",
      "calendar_auth_connections",
      "calendar_sync_jobs",
      "google_calendar_channels",
      "google_calendar_notifications",
      "google_calendar_events",
      "google_calendar_import_jobs",
      "google_calendar_conflicts",
      "google_calendar_outbound_writes",
      "referral_notes",
      "audit_logs"
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${tableName}`);
    }
  });

  it("keeps Google Calendar and phone reservation rules explicit", () => {
    expect(sql).toContain("google_event_id");
    expect(sql).toContain("source IN ('web_line', 'phone_admin', 'admin', 'system_import')");
    expect(sql).toContain("source IN ('google_calendar', 'admin_block', 'system_revert')");
    expect(sql).toContain("external_blocks");
    expect(sql).toContain("dedupe_key TEXT NOT NULL UNIQUE");
  });

  it("keeps the minimum reservation lock contract enforceable", () => {
    expect(sql).toContain("resource_id TEXT NOT NULL REFERENCES store_resources(id)");
    expect(sql).toContain("slot_at TEXT NOT NULL");
    expect(sql).toContain("owner_type TEXT NOT NULL CHECK (owner_type IN ('reservation', 'external_block', 'admin_hold'))");
    expect(sql).toContain("UNIQUE (store_id, resource_id, slot_at)");
    expect(sql).toContain("UNIQUE (customer_id, slot_at)");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS slot_lock_history");
    expect(sql).toContain("CHECK (length(display_name) <= 120)");
    expect(sql).toContain("line_user_id TEXT NOT NULL CHECK (length(line_user_id) <= 128)");
    expect(sql).toContain("google_event_id TEXT NOT NULL CHECK (length(google_event_id) <= 1024)");
    expect(sql).toContain("google_event_id TEXT CHECK (google_event_id IS NULL OR length(google_event_id) <= 1024)");
    expect(sql).toContain("google_event_etag TEXT CHECK (google_event_etag IS NULL OR length(google_event_etag) <= 512)");
  });

  it("keeps LINE, consent, visit, and admin security foundations explicit", () => {
    const adminUsers = createTableSql("admin_users");

    expect(sql).toContain("friend_flag INTEGER NOT NULL DEFAULT 0");
    expect(sql).toContain("followed_at TEXT");
    expect(sql).toContain("unfollowed_at TEXT");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS auth_states");
    expect(sql).toContain("used INTEGER NOT NULL DEFAULT 0 CHECK (used IN (0, 1))");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS consent_records");
    expect(sql).toContain("reservation_id TEXT UNIQUE REFERENCES reservations(id)");
    expect(adminUsers).toContain("access_subject TEXT NOT NULL UNIQUE");
    expect(adminUsers).toContain("CHECK (length(access_subject) <= 256)");
  });

  it("persists job state and dedupe anchors in D1 instead of relying on queue delivery", () => {
    expect(createTableSql("idempotency_keys")).toContain("idempotency_key TEXT NOT NULL");
    expect(createTableSql("idempotency_keys")).toContain("UNIQUE (scope, idempotency_key)");
    expect(createTableSql("job_leases")).toContain("lease_key TEXT NOT NULL UNIQUE");
    expect(createTableSql("notification_jobs")).toContain("dedupe_key TEXT NOT NULL UNIQUE");
    expect(createTableSql("calendar_sync_jobs")).toContain("dedupe_key TEXT NOT NULL UNIQUE");
    expect(createTableSql("google_calendar_import_jobs")).toContain("dedupe_key TEXT NOT NULL UNIQUE");

    expect(sql).toContain("CREATE TABLE IF NOT EXISTS google_calendar_notifications");
    expect(sql).toContain("UNIQUE (channel_id, resource_id, message_number)");
    expect(sql).toContain("locked_until TEXT");
    expect(sql).toContain("last_error TEXT");
    expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS idx_google_outbound_writes_fingerprint");
  });

  it("uses the SPEC reservation status vocabulary without a generic cancelled state", () => {
    const reservations = createTableSql("reservations");

    expect(reservations).toContain("cancelled_by_customer");
    expect(reservations).toContain("cancelled_by_admin");
    expect(reservations).not.toContain("'cancelled'");
  });

  it("stores the full Google watch channel verification and renewal state", () => {
    const channels = createTableSql("google_calendar_channels");

    expect(channels).toContain("calendar_auth_connection_id TEXT NOT NULL");
    expect(channels).toContain("channel_token_hash TEXT NOT NULL");
    expect(channels).toContain("channel_token_hash_alg TEXT NOT NULL DEFAULT 'sha256'");
    expect(channels).toContain("status IN ('active', 'renewing', 'expired', 'stopped', 'failed')");
    expect(channels).toContain("last_notification_at TEXT");
    expect(channels).toContain("last_resource_state TEXT");
    expect(channels).toContain("last_message_number TEXT");
    expect(channels).toContain("last_incremental_sync_at TEXT");
    expect(channels).toContain("last_full_reconcile_at TEXT");
  });

  it("models Google event imports, conflicts, and outbound echo suppression explicitly", () => {
    const events = createTableSql("google_calendar_events");
    const importJobs = createTableSql("google_calendar_import_jobs");
    const notifications = createTableSql("google_calendar_notifications");
    const conflicts = createTableSql("google_calendar_conflicts");
    const outboundWrites = createTableSql("google_calendar_outbound_writes");

    expect(events).toContain("reservation_id TEXT");
    expect(events).toContain("external_block_id TEXT");
    expect(events).toContain("source_type TEXT NOT NULL CHECK (source_type IN ('reservation', 'external_block', 'unknown'))");
    expect(events).toContain("status TEXT NOT NULL CHECK (status IN ('active', 'cancelled', 'deleted', 'conflict', 'ignored'))");
    expect(events).toContain("google_safe_snapshot_json TEXT");
    expect(events).not.toContain("last_google_snapshot_json");

    expect(importJobs).toContain("store_id TEXT NOT NULL");
    expect(importJobs).toContain("reason TEXT NOT NULL CHECK (reason IN ('push', 'cron_incremental', 'full_reconcile', 'manual'))");
    expect(importJobs).toContain("next_run_at TEXT NOT NULL");
    expect(importJobs).toContain("attempt_count INTEGER NOT NULL DEFAULT 0");

    expect(notifications).toContain("UNIQUE (channel_id, resource_id, message_number)");

    expect(conflicts).toContain("calendar_id TEXT NOT NULL");
    expect(conflicts).toContain("external_block_id TEXT");
    expect(conflicts).toContain("google_safe_snapshot_json TEXT NOT NULL");
    expect(conflicts).toContain("d1_safe_snapshot_json TEXT");
    expect(conflicts).toContain("resolution_status TEXT NOT NULL CHECK (resolution_status IN ('open', 'auto_reverted', 'accepted', 'ignored', 'manual_resolved'))");
    expect(conflicts).toContain("resolved_by TEXT");

    expect(outboundWrites).toContain("calendar_id TEXT NOT NULL");
    expect(outboundWrites).toContain("calendar_sync_job_id TEXT REFERENCES calendar_sync_jobs(id)");
    expect(outboundWrites).toContain("dedupe_key TEXT NOT NULL UNIQUE");
    expect(outboundWrites).toContain("expected_fingerprint TEXT NOT NULL");
    expect(outboundWrites).toContain("google_etag_after TEXT");
    expect(outboundWrites).toContain("expires_at TEXT NOT NULL");

    expect(notifications).toContain("headers_redacted_json TEXT");
    expect(notifications).not.toContain("headers_snapshot_json");
  });

  it("prevents ambiguous Google event ownership and duplicate pending LINE reservations", () => {
    const events = createTableSql("google_calendar_events");
    const lineWebhookEvents = createTableSql("line_webhook_events");

    expect(events).toContain("CHECK (");
    expect(events).toContain("source_type = 'reservation' AND reservation_id IS NOT NULL AND external_block_id IS NULL");
    expect(events).toContain("source_type = 'external_block' AND reservation_id IS NULL AND external_block_id IS NOT NULL");
    expect(events).toContain("source_type = 'unknown' AND reservation_id IS NULL AND external_block_id IS NULL");

    expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS idx_reservations_one_pending_per_line");
    expect(sql).toContain("WHERE status = 'pending_approval' AND line_identity_id IS NOT NULL");
    expect(pendingExpiryIndexSql).toContain("CREATE INDEX IF NOT EXISTS idx_reservations_pending_expiry");
    expect(pendingExpiryIndexSql).toContain("ON reservations(status, pending_expires_at, created_at)");
    expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS idx_google_events_one_active_reservation");
    expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS idx_google_events_one_active_external_block");
    expect(sql).toContain("actor_type IN ('customer', 'staff', 'system', 'google_calendar')");

    expect(lineWebhookEvents).toContain("event_timestamp TEXT NOT NULL");
    expect(lineWebhookEvents).toContain("received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP");
  });

  it("enforces blocked-customer reservation rejection at the database boundary", () => {
    expect(sql).toContain("CREATE TRIGGER IF NOT EXISTS trg_reservations_reject_blocked_customer");
    expect(sql).toContain("RAISE(ABORT, 'blocked_customer')");
  });

  it("seeds all four SPEC stores with calendars, resources, settings, hours, and services", () => {
    for (const [storeId, calendarId] of [
      ["kyoto", "calendar-a@example.invalid"],
      ["osaka", "calendar-b@example.invalid"],
      ["nagoya", "calendar-c@example.invalid"],
      ["wakayama", "calendar-d@example.invalid"]
    ] as const) {
      expect(seedSql).toContain(`'${storeId}'`);
      expect(seedSql).toContain(`'${calendarId}'`);
      expect(seedSql).toContain(`'resource_${storeId}_calendar'`);
      expect(seedSql).toContain(`'service_${storeId}_default_60'`);
    }

    expect(seedSql).toContain("INSERT OR IGNORE INTO store_settings");
    expect(seedSql).toContain("脱毛｜サンプル");
    expect(seedSql).toContain("フェイシャル｜サンプル");
    expect(seedSql).toContain("マッサージ｜サンプル");
    expect(seedSql).toContain("ネイル・フットケア｜サンプル");
    expect(seedSql).not.toContain("脱毛｜サンプル 12");
    expect(seedSql).not.toContain("フェイシャル｜サンプル 02");
    expect(seedSql).not.toContain("ネイル・フットケア｜サンプル 04");
    expect(seedSql).not.toContain("Google Calendar', 'staff_calendar'");
    expect(seedSql).toContain("10:00");
    expect(seedSql).toContain("20:00");
    expect(seedSql).not.toContain("store_salon_de_jouet");
  });

  it("stores multi-menu selections and corrected service treatment times", () => {
    const d1 = createMigratedSqliteD1();
    try {
      const table = d1.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reservation_services'")
        .get() as { name: string } | undefined;
      expect(table?.name).toBe("reservation_services");
      const mensMenuColumn = d1.sqlite
        .prepare("SELECT name FROM pragma_table_info('services') WHERE name = 'mens_menu'")
        .get() as { name: string } | undefined;
      expect(mensMenuColumn?.name).toBe("mens_menu");

      const serviceCount = d1.sqlite
        .prepare("SELECT COUNT(*) AS count FROM services WHERE active = 1")
        .get() as { count: number };
      expect(serviceCount.count).toBe(129);

      const mensMenus = d1.sqlite
        .prepare(
          `SELECT id, name, duration_minutes, price_amount, mens_menu
           FROM services
           WHERE store_id = 'kyoto'
             AND id LIKE 'service_kyoto_mens_%'
           ORDER BY id`
        )
        .all() as Array<{
          id: string;
          name: string;
          duration_minutes: number;
          price_amount: number;
          mens_menu: number;
        }>;
      expect(mensMenus).toEqual([
        { id: "service_kyoto_mens_hair_removal_arms_15", name: "メンズ｜サンプル 09", duration_minutes: 15, price_amount: 3000, mens_menu: 1 },
        { id: "service_kyoto_mens_hair_removal_beard_30", name: "メンズ｜サンプル 03", duration_minutes: 10, price_amount: 2000, mens_menu: 1 },
        { id: "service_kyoto_mens_hair_removal_face_photo_45", name: "メンズ｜サンプル 02", duration_minutes: 10, price_amount: 3000, mens_menu: 1 },
        { id: "service_kyoto_mens_hair_removal_full_60", name: "メンズ｜サンプル 05", duration_minutes: 55, price_amount: 6000, mens_menu: 1 },
        { id: "service_kyoto_mens_hair_removal_full_photo", name: "メンズ｜サンプル 04", duration_minutes: 55, price_amount: 7000, mens_menu: 1 },
        { id: "service_kyoto_mens_hair_removal_growth_45", name: "メンズ｜サンプル 06", duration_minutes: 55, price_amount: 6000, mens_menu: 1 },
        { id: "service_kyoto_mens_hair_removal_legs_45", name: "メンズ｜サンプル 10", duration_minutes: 15, price_amount: 3000, mens_menu: 1 },
        { id: "service_kyoto_mens_hair_removal_lower_focus_45", name: "メンズ｜サンプル 08", duration_minutes: 55, price_amount: 6000, mens_menu: 1 },
        { id: "service_kyoto_mens_hair_removal_partial_armpits_5", name: "メンズ｜サンプル 15", duration_minutes: 10, price_amount: 2000, mens_menu: 1 },
        { id: "service_kyoto_mens_hair_removal_partial_back_5", name: "メンズ｜サンプル 17", duration_minutes: 10, price_amount: 2000, mens_menu: 1 },
        { id: "service_kyoto_mens_hair_removal_partial_chest_5", name: "メンズ｜サンプル 18", duration_minutes: 10, price_amount: 2000, mens_menu: 1 },
        { id: "service_kyoto_mens_hair_removal_partial_forearms_10", name: "メンズ｜サンプル 14", duration_minutes: 10, price_amount: 2000, mens_menu: 1 },
        { id: "service_kyoto_mens_hair_removal_partial_lower_legs_10", name: "メンズ｜サンプル 13", duration_minutes: 10, price_amount: 2000, mens_menu: 1 },
        { id: "service_kyoto_mens_hair_removal_partial_nape_5", name: "メンズ｜サンプル 11", duration_minutes: 10, price_amount: 2000, mens_menu: 1 },
        { id: "service_kyoto_mens_hair_removal_partial_stomach_5", name: "メンズ｜サンプル 12", duration_minutes: 10, price_amount: 2000, mens_menu: 1 },
        { id: "service_kyoto_mens_hair_removal_partial_thigh_10", name: "メンズ｜サンプル 16", duration_minutes: 10, price_amount: 2000, mens_menu: 1 },
        { id: "service_kyoto_mens_hair_removal_upper_focus_45", name: "メンズ｜サンプル 07", duration_minutes: 55, price_amount: 6000, mens_menu: 1 }
      ]);

      const mensMenuStoreLinks = d1.sqlite
        .prepare(
          `SELECT COUNT(*) AS count
           FROM service_stores
           WHERE store_id = 'kyoto'
             AND service_id LIKE 'service_kyoto_mens_%'`
        )
        .get() as { count: number };
      expect(mensMenuStoreLinks.count).toBe(17);

      const existingMensVio = d1.sqlite
        .prepare(
          `SELECT id, name, duration_minutes, mens_menu
           FROM services
           WHERE id = 'service_kyoto_hair_removal_vio_men_45'`
        )
        .get() as {
          id: string;
          name: string;
          duration_minutes: number;
          mens_menu: number;
        };
      expect(existingMensVio).toEqual({
        id: "service_kyoto_hair_removal_vio_men_45",
        name: "メンズ｜サンプル 01",
        duration_minutes: 15,
        mens_menu: 1
      });

      const durations = d1.sqlite
        .prepare(
          `
            SELECT id, name, duration_minutes
            FROM services
            WHERE store_id = 'kyoto'
              AND id IN (
                'service_kyoto_hair_removal_full_60',
                'service_kyoto_hair_removal_upper_focus_45',
                'service_kyoto_hair_removal_lower_focus_45',
                'service_kyoto_hair_removal_growth_45',
                'service_kyoto_hair_removal_beard_30',
                'service_kyoto_hair_removal_face_photo_45',
                'service_kyoto_hair_removal_arms_15',
                'service_kyoto_hair_removal_partial_forearms_10',
                'service_kyoto_hair_removal_partial_lower_legs_10',
                'service_kyoto_facial_hydra_photo_60',
                'service_kyoto_facial_hydra_45',
                'service_kyoto_facial_photo_30'
              )
            ORDER BY id
          `
        )
        .all() as Array<{ id: string; name: string; duration_minutes: number }>;
      expect(
        Object.fromEntries(durations.map((service) => [service.id, service.duration_minutes]))
      ).toMatchObject({
        service_kyoto_hair_removal_full_60: 45,
        service_kyoto_hair_removal_upper_focus_45: 45,
        service_kyoto_hair_removal_lower_focus_45: 45,
        service_kyoto_hair_removal_growth_45: 45,
        service_kyoto_hair_removal_beard_30: 5,
        service_kyoto_hair_removal_face_photo_45: 5,
        service_kyoto_hair_removal_arms_15: 15,
        service_kyoto_hair_removal_partial_forearms_10: 10,
        service_kyoto_hair_removal_partial_lower_legs_10: 10,
        service_kyoto_facial_hydra_photo_60: 15,
        service_kyoto_facial_hydra_45: 10,
        service_kyoto_facial_photo_30: 5
      });
      const newMenuStoreLinks = d1.sqlite
        .prepare(
          `
            SELECT COUNT(*) AS count
            FROM service_stores
            WHERE service_id IN (
              'service_kyoto_hair_removal_upper_focus_45',
              'service_kyoto_hair_removal_lower_focus_45',
              'service_kyoto_hair_removal_growth_45'
            )
              AND store_id = 'kyoto'
          `
        )
        .get() as { count: number };
      expect(newMenuStoreLinks.count).toBe(3);
      const allStoreNewMenuLinks = d1.sqlite
        .prepare(
          `
            SELECT COUNT(*) AS count
            FROM service_stores
            WHERE service_id LIKE 'service_%_hair_removal_upper_focus_45'
               OR service_id LIKE 'service_%_hair_removal_lower_focus_45'
               OR service_id LIKE 'service_%_hair_removal_growth_45'
          `
        )
        .get() as { count: number };
      expect(allStoreNewMenuLinks.count).toBe(15);
      expect(durations.map((service) => service.name).join("\n")).not.toMatch(/[ 　][0-9]+分/);
    } finally {
      d1.sqlite.close();
    }
  });
});

describe("0010 reservation_change_requests migration", () => {
  const expectColumnExists = (
    d1: ReturnType<typeof createMigratedSqliteD1>,
    table: string,
    column: string
  ) => {
    const row = d1.sqlite
      .prepare(
        `SELECT 1 AS present FROM pragma_table_info(?) WHERE name = ? LIMIT 1`
      )
      .get(table, column) as { present: number } | undefined;
    expect(row?.present).toBe(1);
  };

  const expectIndexExists = (
    d1: ReturnType<typeof createMigratedSqliteD1>,
    indexName: string
  ) => {
    const row = d1.sqlite
      .prepare(
        `SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = ? LIMIT 1`
      )
      .get(indexName) as { present: number } | undefined;
    expect(row?.present).toBe(1);
  };

  const seedReservationFixture = (d1: ReturnType<typeof createMigratedSqliteD1>) => {
    d1.sqlite
      .prepare(`INSERT INTO stores (id, name, timezone) VALUES (?, ?, ?)`)
      .run("store_test", "Test Store", "Asia/Tokyo");
    d1.sqlite
      .prepare(`INSERT INTO store_resources (id, store_id, name) VALUES (?, ?, ?)`)
      .run("resource_test", "store_test", "Test Room");
    d1.sqlite
      .prepare(
        `INSERT INTO customers (id, display_name, phone_normalized, phone_hash) VALUES (?, ?, ?, ?)`
      )
      .run("customer_test", "Test Customer", "0700000000", "hash_test");
    d1.sqlite
      .prepare(
        `INSERT INTO services (id, store_id, name, duration_minutes) VALUES (?, ?, ?, ?)`
      )
      .run("service_test", "store_test", "Service A", 60);
    d1.sqlite
      .prepare(
        `INSERT INTO reservations (
          id, store_id, service_id, customer_id, resource_id, source, status,
          start_at, end_at, duration_minutes, idempotency_key, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "reservation_test",
        "store_test",
        "service_test",
        "customer_test",
        "resource_test",
        "web_line",
        "confirmed",
        "2026-06-01T01:00:00.000Z",
        "2026-06-01T02:00:00.000Z",
        60,
        "idempotency_test",
        1
      );
  };

  it("creates reservation_change_requests table with the documented columns", () => {
    const d1 = createMigratedSqliteD1();
    try {
      for (const column of [
        "id",
        "reservation_id",
        "customer_id",
        "line_identity_id",
        "request_type",
        "status",
        "reservation_version_at_request",
        "current_start_at",
        "current_end_at",
        "requested_start_at",
        "requested_end_at",
        "customer_note",
        "admin_decision_note",
        "decided_by_admin_id",
        "decided_at",
        "created_at",
        "updated_at"
      ]) {
        expectColumnExists(d1, "reservation_change_requests", column);
      }
    } finally {
      d1.sqlite.close();
    }
  });

  it("creates the partial UNIQUE pending index and rejects a second pending request for the same reservation", () => {
    const d1 = createMigratedSqliteD1();
    try {
      expectIndexExists(d1, "idx_change_requests_one_pending");
      seedReservationFixture(d1);

      d1.sqlite
        .prepare(
          `INSERT INTO reservation_change_requests (
            id, reservation_id, customer_id, request_type, status,
            reservation_version_at_request, current_start_at, current_end_at
          ) VALUES (?, 'reservation_test', 'customer_test', 'cancel', 'pending', 1, '2026-06-01T01:00:00.000Z', '2026-06-01T02:00:00.000Z')`
        )
        .run("request_one");

      expect(() =>
        d1.sqlite
          .prepare(
            `INSERT INTO reservation_change_requests (
              id, reservation_id, customer_id, request_type, status,
              reservation_version_at_request, current_start_at, current_end_at,
              requested_start_at, requested_end_at
            ) VALUES (?, 'reservation_test', 'customer_test', 'reschedule', 'pending', 1, '2026-06-01T01:00:00.000Z', '2026-06-01T02:00:00.000Z',
                      '2026-06-02T01:00:00.000Z', '2026-06-02T02:00:00.000Z')`
          )
          .run("request_two")
      ).toThrow();
    } finally {
      d1.sqlite.close();
    }
  });

  it("enforces CHECK constraints on request_type / requested_* combinations", () => {
    const d1 = createMigratedSqliteD1();
    try {
      seedReservationFixture(d1);

      expect(() =>
        d1.sqlite
          .prepare(
            `INSERT INTO reservation_change_requests (
              id, reservation_id, customer_id, request_type, status,
              reservation_version_at_request, current_start_at, current_end_at,
              requested_start_at, requested_end_at
            ) VALUES ('bad_cancel', 'reservation_test', 'customer_test', 'cancel', 'pending', 1, '2026-06-01T01:00:00.000Z', '2026-06-01T02:00:00.000Z',
                      '2026-06-02T01:00:00.000Z', '2026-06-02T02:00:00.000Z')`
          )
          .run()
      ).toThrow();

      expect(() =>
        d1.sqlite
          .prepare(
            `INSERT INTO reservation_change_requests (
              id, reservation_id, customer_id, request_type, status,
              reservation_version_at_request, current_start_at, current_end_at
            ) VALUES ('bad_reschedule', 'reservation_test', 'customer_test', 'reschedule', 'pending', 1, '2026-06-01T01:00:00.000Z', '2026-06-01T02:00:00.000Z')`
          )
          .run()
      ).toThrow();
    } finally {
      d1.sqlite.close();
    }
  });

  it("adds change_request_id column to notification_jobs and indexes it", () => {
    const d1 = createMigratedSqliteD1();
    try {
      expectColumnExists(d1, "notification_jobs", "change_request_id");
      expectIndexExists(d1, "idx_notification_jobs_change_request");
    } finally {
      d1.sqlite.close();
    }
  });
});
