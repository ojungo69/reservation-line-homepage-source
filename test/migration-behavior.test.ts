import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const applyCurrentSeedServiceColumns = (db: DatabaseSync) => {
  db.exec(readFileSync(join(process.cwd(), "migrations/0042_service_price_amounts.sql"), "utf8"));
  db.exec(readFileSync(join(process.cwd(), "migrations/0046_kyoto_mens_menus.sql"), "utf8"));
};

describe("initial D1 migration behavior", () => {
  let db: DatabaseSync;
  const adminUsersAccessSubjectRepairSql = readFileSync(
    join(process.cwd(), "migrations/0003_admin_users_access_subject_repair.sql"),
    "utf8"
  );

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(readFileSync(join(process.cwd(), "migrations/0001_initial.sql"), "utf8"));
    // The current dev seed explicitly initializes columns introduced after 0001.
    db.exec(readFileSync(join(process.cwd(), "migrations/0024_store_settings_reservation_cap.sql"), "utf8"));
    applyCurrentSeedServiceColumns(db);
    db.exec(readFileSync(join(process.cwd(), "seeds/dev.sql"), "utf8"));
  });

  afterEach(() => {
    db.close();
  });

  const exec = (sql: string) => {
    db.exec(sql);
  };

  const adminUserColumns = () =>
    db.prepare("PRAGMA table_info(admin_users)").all() as Array<{
      name: string;
      notnull: number;
    }>;

  const insertCustomer = () => {
    exec(`
      INSERT INTO customers (id, display_name, phone_normalized, phone_hash)
      VALUES ('customer_1', 'Test Customer', '0751234567', 'phone_hash_1');

      INSERT INTO line_identities (
        id,
        customer_id,
        channel_id,
        line_user_id,
        friend_flag
      ) VALUES (
        'line_identity_1',
        'customer_1',
        'line_channel_1',
        'line_user_1',
        1
      );
    `);
  };

  const insertReservation = () => {
    insertCustomer();
    exec(`
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
        'reservation_1',
        'kyoto',
        'service_kyoto_default_60',
        'customer_1',
        'resource_kyoto_calendar',
        'line_identity_1',
        'web_line',
        'confirmed',
        '2026-06-01T01:00:00.000Z',
        '2026-06-01T02:00:00.000Z',
        60,
        'reservation_idempotency_1'
      );
    `);
  };

  const insertExternalBlock = () => {
    exec(`
      INSERT INTO external_blocks (
        id,
        store_id,
        resource_id,
        source,
        title_snapshot,
        start_at,
        end_at,
        status,
        google_event_id,
        created_by
      ) VALUES (
        'external_block_1',
        'kyoto',
        'resource_kyoto_calendar',
        'google_calendar',
        '休憩',
        '2026-06-01T03:00:00.000Z',
        '2026-06-01T04:00:00.000Z',
        'active',
        'google_block_event_1',
        'google_calendar'
      );
    `);
  };

  it("applies the migration and seed data with valid foreign keys", () => {
    const foreignKeyIssues = db.prepare("PRAGMA foreign_key_check").all();
    const storeCount = db.prepare("SELECT COUNT(*) AS count FROM stores").get() as { count: number };
    const serviceCount = db.prepare("SELECT COUNT(*) AS count FROM services").get() as { count: number };
    const businessHourCount = db.prepare("SELECT COUNT(*) AS count FROM store_business_hours").get() as { count: number };
    const googleResourceCount = db
      .prepare("SELECT COUNT(*) AS count FROM store_resources WHERE name LIKE '%Google Calendar%'")
      .get() as { count: number };
    const publicNonMassageMinuteCount = db
      .prepare(
        "SELECT COUNT(*) AS count FROM services WHERE (name LIKE '脱毛｜%' OR name LIKE 'フェイシャル｜%' OR name LIKE 'ネイル・フットケア｜%') AND name LIKE '%分'"
      )
      .get() as { count: number };

    expect(foreignKeyIssues).toEqual([]);
    expect(storeCount.count).toBe(4);
    expect(serviceCount.count).toBe(129);
    expect(businessHourCount.count).toBe(24);
    expect(googleResourceCount.count).toBe(0);
    expect(publicNonMassageMinuteCount.count).toBe(0);
  });

  it("repairs empty legacy admin_users tables that are missing Access subject binding", () => {
    db.close();
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    exec(`
      CREATE TABLE staff_members (
        id TEXT PRIMARY KEY,
        store_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE admin_users (
        id TEXT PRIMARY KEY,
        staff_member_id TEXT REFERENCES staff_members(id) ON DELETE SET NULL,
        email TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL CHECK (role IN ('owner', 'staff', 'system_admin')),
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        last_seen_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    exec(adminUsersAccessSubjectRepairSql);

    const columns = adminUserColumns();

    expect(columns.some((column) => column.name === "access_subject" && column.notnull === 1)).toBe(true);
    exec(`
      INSERT INTO admin_users (
        id,
        email,
        access_subject,
        role,
        active
      ) VALUES (
        'admin_legacy_1',
        'legacy-admin@example.com',
        'legacy-access-subject-1',
        'system_admin',
        1
      );
    `);
  });

  it("keeps fresh admin_users tables usable after the Access subject repair migration", () => {
    exec(adminUsersAccessSubjectRepairSql);

    exec(`
      INSERT INTO admin_users (
        id,
        email,
        access_subject,
        role,
        active
      ) VALUES (
        'admin_fresh_1',
        'fresh-admin@example.com',
        'access-subject-fresh-1',
        'system_admin',
        1
      );
    `);

    const admin = db.prepare("SELECT access_subject FROM admin_users WHERE id = 'admin_fresh_1'").get() as {
      access_subject: string;
    };
    const foreignKeyIssues = db.prepare("PRAGMA foreign_key_check").all();

    expect(admin.access_subject).toBe("access-subject-fresh-1");
    expect(foreignKeyIssues).toEqual([]);
  });

  it("does not clobber registered admin Access subjects on populated admin_users tables", () => {
    exec(`
      INSERT INTO admin_users (
        id,
        email,
        access_subject,
        role,
        active
      ) VALUES (
        'admin_registered_1',
        'registered-admin@example.com',
        'real-access-subject-1',
        'system_admin',
        1
      );
    `);

    expect(() => exec(adminUsersAccessSubjectRepairSql)).toThrow();

    const admin = db.prepare("SELECT access_subject FROM admin_users WHERE id = 'admin_registered_1'").get() as {
      access_subject: string;
    };
    expect(admin.access_subject).toBe("real-access-subject-1");
  });

  it("enforces Google event ownership, active-event uniqueness, and soft-delete behavior", () => {
    insertReservation();
    insertExternalBlock();

    exec(`
      INSERT INTO google_calendar_events (
        id,
        store_id,
        calendar_id,
        google_event_id,
        reservation_id,
        source_type,
        status
      ) VALUES (
        'google_event_reservation_1',
        'kyoto',
        'calendar-a@example.invalid',
        'google_reservation_event_1',
        'reservation_1',
        'reservation',
        'active'
      );
    `);

    expect(() =>
      exec(`
        INSERT INTO google_calendar_events (
          id,
          store_id,
          calendar_id,
          google_event_id,
          reservation_id,
          source_type,
          status
        ) VALUES (
          'google_event_reservation_2',
          'kyoto',
          'calendar-a@example.invalid',
          'google_reservation_event_2',
          'reservation_1',
          'reservation',
          'active'
        );
      `)
    ).toThrow();

    exec(`
      INSERT INTO google_calendar_events (
        id,
        store_id,
        calendar_id,
        google_event_id,
        external_block_id,
        source_type,
        status
      ) VALUES (
        'google_event_block_1',
        'kyoto',
        'calendar-a@example.invalid',
        'google_block_event_1',
        'external_block_1',
        'external_block',
        'active'
      );
    `);

    expect(() =>
      exec(`
        INSERT INTO google_calendar_events (
          id,
          store_id,
          calendar_id,
          google_event_id,
          source_type,
          status
        ) VALUES (
          'google_event_invalid_owner',
          'kyoto',
          'calendar-a@example.invalid',
          'google_invalid_owner',
          'reservation',
          'active'
        );
      `)
    ).toThrow();

    expect(() => exec("DELETE FROM external_blocks WHERE id = 'external_block_1';")).toThrow();

    exec("UPDATE external_blocks SET status = 'cancelled' WHERE id = 'external_block_1';");
    const block = db.prepare("SELECT status FROM external_blocks WHERE id = 'external_block_1'").get() as {
      status: string;
    };
    expect(block.status).toBe("cancelled");
  });

  it("enforces queue idempotency, outbound echo uniqueness, and Google audit actors", () => {
    insertReservation();

    exec(`
      INSERT INTO calendar_sync_jobs (
        id,
        dedupe_key,
        owner_type,
        owner_id,
        google_action,
        status
      ) VALUES (
        'calendar_sync_job_1',
        'reservation:reservation_1:google:patch:revision:1',
        'reservation',
        'reservation_1',
        'patch',
        'queued'
      );

      INSERT INTO google_calendar_outbound_writes (
        id,
        calendar_sync_job_id,
        dedupe_key,
        calendar_id,
        google_event_id,
        owner_type,
        owner_id,
        action,
        expected_fingerprint,
        expires_at
      ) VALUES (
        'outbound_write_1',
        'calendar_sync_job_1',
        'reservation:reservation_1:google:patch:revision:1',
        'calendar-a@example.invalid',
        'google_reservation_event_1',
        'reservation',
        'reservation_1',
        'patch',
        'fingerprint_1',
        '2026-06-01T03:00:00.000Z'
      );
    `);

    expect(() =>
      exec(`
        INSERT INTO google_calendar_outbound_writes (
          id,
          dedupe_key,
          calendar_id,
          google_event_id,
          owner_type,
          owner_id,
          action,
          expected_fingerprint,
          expires_at
        ) VALUES (
          'outbound_write_2',
          'reservation:reservation_1:google:patch:revision:2',
          'calendar-a@example.invalid',
          'google_reservation_event_1',
          'reservation',
          'reservation_1',
          'patch',
          'fingerprint_1',
          '2026-06-01T03:00:00.000Z'
        );
      `)
    ).toThrow();

    exec(`
      INSERT INTO audit_logs (
        id,
        actor_type,
        actor_id,
        action,
        target_type,
        target_id
      ) VALUES (
        'audit_google_1',
        'google_calendar',
        'calendar-a@example.invalid',
        'google_event_imported',
        'reservation',
        'reservation_1'
      );
    `);
  });

  it("scopes idempotency keys by operation family", () => {
    exec(`
      INSERT INTO idempotency_keys (
        id,
        scope,
        idempotency_key,
        status,
        expires_at,
        updated_at
      ) VALUES (
        'idempotency_public_1',
        'public_submit',
        'shared-client-key-1',
        'started',
        '2026-06-01T00:00:00.000Z',
        '2026-05-09T00:00:00.000Z'
      );

      INSERT INTO idempotency_keys (
        id,
        scope,
        idempotency_key,
        status,
        expires_at,
        updated_at
      ) VALUES (
        'idempotency_admin_1',
        'admin_action',
        'shared-client-key-1',
        'started',
        '2026-06-01T00:00:00.000Z',
        '2026-05-09T00:00:00.000Z'
      );
    `);

    expect(() =>
      exec(`
        INSERT INTO idempotency_keys (
          id,
          scope,
          idempotency_key,
          status,
          expires_at,
          updated_at
        ) VALUES (
          'idempotency_admin_duplicate',
          'admin_action',
          'shared-client-key-1',
          'started',
          '2026-06-01T00:00:00.000Z',
          '2026-05-09T00:00:00.000Z'
        );
      `)
    ).toThrow();
  });

  it("rejects overlong external identifiers before they reach business logic", () => {
    insertCustomer();
    const overlongLineUserId = "u".repeat(129);

    expect(() =>
      db
        .prepare(
          `
            INSERT INTO line_identities (
              id,
              customer_id,
              channel_id,
              line_user_id
            ) VALUES (?, 'customer_1', 'line_channel_1', ?)
          `
        )
        .run("line_identity_overlong", overlongLineUserId)
    ).toThrow();
  });
});

describe("0011 admin_users.is_service_token migration", () => {
  let db: DatabaseSync;

  const allMigrationFiles = () =>
    readdirSync(join(process.cwd(), "migrations"))
      .filter((fileName) => fileName.endsWith(".sql"))
      .sort();

  const applyMigrations = (sqliteDb: DatabaseSync, until?: string) => {
    const dir = join(process.cwd(), "migrations");
    for (const fileName of allMigrationFiles()) {
      if (until && fileName >= until) {
        break;
      }
      sqliteDb.exec(readFileSync(join(dir, fileName), "utf8"));
    }
  };

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    applyMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("adds is_service_token as NOT NULL DEFAULT 0 with CHECK (0,1)", () => {
    const columns = db.prepare("PRAGMA table_info(admin_users)").all() as Array<{
      name: string;
      notnull: number;
      dflt_value: unknown;
    }>;
    const column = columns.find((c) => c.name === "is_service_token");
    expect(column).toBeDefined();
    expect(column?.notnull).toBe(1);
    expect(String(column?.dflt_value)).toBe("0");
  });

  it("creates idx_admin_users_service_token index", () => {
    const indexes = db.prepare("PRAGMA index_list(admin_users)").all() as Array<{ name: string }>;
    expect(indexes.some((idx) => idx.name === "idx_admin_users_service_token")).toBe(true);
  });

  it("rejects is_service_token values outside of (0, 1)", () => {
    db.prepare(
      `
        INSERT INTO admin_users (id, email, access_subject, role, active, is_service_token, updated_at)
        VALUES ('admin_ok', 'ok@example.com', 'sub-ok', 'staff', 1, 0, '2026-05-16T00:00:00.000Z')
      `
    ).run();

    expect(() =>
      db
        .prepare(
          `
            INSERT INTO admin_users (id, email, access_subject, role, active, is_service_token, updated_at)
            VALUES ('admin_bad', 'bad@example.com', 'sub-bad', 'staff', 1, 2, '2026-05-16T00:00:00.000Z')
          `
        )
        .run()
    ).toThrow();
  });

  it("backfills pre-existing admin rows with is_service_token = 0 when applied incrementally", () => {
    const sandbox = new DatabaseSync(":memory:");
    sandbox.exec("PRAGMA foreign_keys = ON;");
    applyMigrations(sandbox, "0011");

    sandbox
      .prepare(
        `
          INSERT INTO admin_users (id, email, access_subject, role, active, updated_at)
          VALUES ('admin_pre', 'pre@example.com', 'sub-pre', 'staff', 1, '2026-05-16T00:00:00.000Z')
        `
      )
      .run();

    sandbox.exec(
      readFileSync(join(process.cwd(), "migrations/0011_admin_users_is_service_token.sql"), "utf8")
    );

    const row = sandbox
      .prepare("SELECT is_service_token FROM admin_users WHERE id = 'admin_pre'")
      .get() as { is_service_token: number };
    expect(row.is_service_token).toBe(0);
    sandbox.close();
  });
});

describe("0027 reservations.reservation_origin migration", () => {
  const applyAllMigrations = (sqliteDb: DatabaseSync) => {
    const dir = join(process.cwd(), "migrations");
    for (const fileName of readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      sqliteDb.exec(readFileSync(join(dir, fileName), "utf8"));
    }
  };

  const seedReservationDeps = (sqliteDb: DatabaseSync) => {
    sqliteDb
      .prepare(`INSERT INTO stores (id, name, timezone) VALUES (?, ?, ?)`)
      .run("store_o", "Origin Store", "Asia/Tokyo");
    sqliteDb
      .prepare(`INSERT INTO store_resources (id, store_id, name) VALUES (?, ?, ?)`)
      .run("resource_o", "store_o", "Room");
    sqliteDb
      .prepare(
        `INSERT INTO customers (id, display_name, phone_normalized, phone_hash) VALUES (?, ?, ?, ?)`
      )
      .run("customer_o", "Origin Customer", "0700000099", "hash_o");
    sqliteDb
      .prepare(
        `INSERT INTO services (id, store_id, name, duration_minutes) VALUES (?, ?, ?, ?)`
      )
      .run("service_o", "store_o", "Service O", 60);
  };

  const insertReservation = (
    sqliteDb: DatabaseSync,
    id: string,
    origin: string | null
  ) => {
    sqliteDb
      .prepare(
        `INSERT INTO reservations (
          id, store_id, service_id, customer_id, resource_id, source, status,
          start_at, end_at, duration_minutes, idempotency_key, reservation_origin
        ) VALUES (?, 'store_o', 'service_o', 'customer_o', 'resource_o', 'phone_admin', 'confirmed',
          '2026-06-01T01:00:00.000Z', '2026-06-01T02:00:00.000Z', 60, ?, ?)`
      )
      .run(id, `idem_${id}`, origin);
  };

  it("adds reservation_origin as a nullable column", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = ON;");
      applyAllMigrations(db);
      const columns = db.prepare("PRAGMA table_info(reservations)").all() as Array<{
        name: string;
        notnull: number;
      }>;
      const column = columns.find((c) => c.name === "reservation_origin");
      expect(column).toBeDefined();
      expect(column?.notnull).toBe(0);
    } finally {
      db.close();
    }
  });

  it("accepts NULL and the four allowed origin values", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = ON;");
      applyAllMigrations(db);
      seedReservationDeps(db);
      insertReservation(db, "res_null", null);
      insertReservation(db, "res_minimo", "minimo");
      insertReservation(db, "res_phone", "phone");
      insertReservation(db, "res_walk", "walk_in");
      insertReservation(db, "res_other", "other");
      const count = db
        .prepare("SELECT COUNT(*) AS count FROM reservations")
        .get() as { count: number };
      expect(count.count).toBe(5);
    } finally {
      db.close();
    }
  });

  it("rejects an unknown origin value via CHECK constraint", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = ON;");
      applyAllMigrations(db);
      seedReservationDeps(db);
      expect(() => insertReservation(db, "res_bad", "instagram")).toThrow();
    } finally {
      db.close();
    }
  });
});

describe("0028 customers.archived_at migration", () => {
  const allMigrationFiles = () =>
    readdirSync(join(process.cwd(), "migrations"))
      .filter((fileName) => fileName.endsWith(".sql"))
      .sort();

  const applyMigrations = (sqliteDb: DatabaseSync, until?: string) => {
    const dir = join(process.cwd(), "migrations");
    for (const fileName of allMigrationFiles()) {
      if (until && fileName >= until) break;
      sqliteDb.exec(readFileSync(join(dir, fileName), "utf8"));
    }
  };

  it("adds archived_at as a nullable TEXT column", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    applyMigrations(db);
    try {
      const columns = db.prepare("PRAGMA table_info(customers)").all() as Array<{
        name: string;
        notnull: number;
        type: string;
      }>;
      const column = columns.find((c) => c.name === "archived_at");
      expect(column).toBeDefined();
      expect(column?.notnull).toBe(0);
      expect(column?.type.toUpperCase()).toContain("TEXT");
    } finally {
      db.close();
    }
  });

  it("creates the idx_customers_archived partial index", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    applyMigrations(db);
    try {
      const row = db
        .prepare(
          "SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = 'idx_customers_archived' LIMIT 1"
        )
        .get() as { present: number } | undefined;
      expect(row?.present).toBe(1);
    } finally {
      db.close();
    }
  });

  it("backfills pre-existing customer rows to archived_at = NULL when applied incrementally", () => {
    const sandbox = new DatabaseSync(":memory:");
    sandbox.exec("PRAGMA foreign_keys = ON;");
    applyMigrations(sandbox, "0028");
    sandbox
      .prepare(
        `INSERT INTO customers (id, display_name, block_status, updated_at)
         VALUES ('cust_pre_archive', 'アーカイブ前', 'active', '2026-05-16T00:00:00.000Z')`
      )
      .run();
    sandbox.exec(
      readFileSync(join(process.cwd(), "migrations/0028_customers_archived_at.sql"), "utf8")
    );
    const row = sandbox
      .prepare("SELECT archived_at FROM customers WHERE id = 'cust_pre_archive'")
      .get() as { archived_at: string | null };
    expect(row.archived_at).toBeNull();
    sandbox.close();
  });

  it("rejects an archived_at value longer than 32 chars (CHECK guard)", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    applyMigrations(db);
    try {
      expect(() =>
        db
          .prepare(
            `INSERT INTO customers (id, display_name, block_status, archived_at, updated_at)
             VALUES ('cust_bad_archive', 'x', 'active', ?, '2026-05-16T00:00:00.000Z')`
          )
          .run("X".repeat(33))
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it("0030 backfills reservation-sourced visit dates to the appointment time, leaving manual imports untouched", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    // Apply 0001..0029 (everything before the backfill), then seed dev stores/
    // services/resources so the reservation FKs resolve.
    applyMigrations(db, "0030");
    applyCurrentSeedServiceColumns(db);
    db.exec(readFileSync(join(process.cwd(), "seeds/dev.sql"), "utf8"));
    try {
      // Two completed reservations whose customer_visits.visited_at was recorded
      // at the (drifted) admin complete-click time, plus a manual paper-chart
      // import that must be left alone.
      db.exec(`
        INSERT INTO customers (id, display_name, block_status, updated_at)
        VALUES ('cust_bf_1', '来店 太郎', 'active', '2026-05-09T00:00:00.000Z');

        INSERT INTO reservations (id, store_id, service_id, customer_id, resource_id, source, status, start_at, end_at, duration_minutes, idempotency_key, version)
        VALUES
          ('res_bf_web', 'kyoto', 'service_kyoto_default_60', 'cust_bf_1', 'resource_kyoto_calendar', 'web_line', 'completed', '2026-05-20T01:00:00.000Z', '2026-05-20T02:00:00.000Z', 60, 'ik_bf_web', 1),
          ('res_bf_phone', 'kyoto', 'service_kyoto_default_60', 'cust_bf_1', 'resource_kyoto_calendar', 'phone_admin', 'completed', '2026-05-22T03:00:00.000Z', '2026-05-22T04:00:00.000Z', 60, 'ik_bf_phone', 1),
          ('res_bf_void', 'kyoto', 'service_kyoto_default_60', 'cust_bf_1', 'resource_kyoto_calendar', 'web_line', 'completed', '2026-05-23T05:00:00.000Z', '2026-05-23T06:00:00.000Z', 60, 'ik_bf_void', 1),
          ('res_bf_ok', 'kyoto', 'service_kyoto_default_60', 'cust_bf_1', 'resource_kyoto_calendar', 'web_line', 'completed', '2026-05-24T07:00:00.000Z', '2026-05-24T08:00:00.000Z', 60, 'ik_bf_ok', 1);

        INSERT INTO customer_visits (id, customer_id, reservation_id, store_id, visited_at, visit_source, status, recorded_by)
        VALUES
          ('cv_bf_web', 'cust_bf_1', 'res_bf_web', 'kyoto', '2026-05-25T09:30:00.000Z', 'reservation_completed', 'valid', 'admin_bf'),
          ('cv_bf_phone', 'cust_bf_1', 'res_bf_phone', 'kyoto', '2026-05-26T10:15:00.000Z', 'phone_admin_completed', 'valid', 'admin_bf'),
          ('cv_bf_manual', 'cust_bf_1', NULL, 'kyoto', '2026-03-10', 'manual_import', 'valid', 'admin_bf'),
          ('cv_bf_ok', 'cust_bf_1', 'res_bf_ok', 'kyoto', '2026-05-24T07:00:00.000Z', 'reservation_completed', 'valid', 'admin_bf');

        INSERT INTO customer_visits (id, customer_id, reservation_id, store_id, visited_at, visit_source, status, recorded_by, voided_by, voided_at, void_reason)
        VALUES
          ('cv_bf_void', 'cust_bf_1', 'res_bf_void', 'kyoto', '2026-05-27T11:00:00.000Z', 'reservation_completed', 'voided', 'admin_bf', 'admin_bf', '2026-05-28T00:00:00.000Z', 'recorded in error');
      `);

      db.exec(readFileSync(join(process.cwd(), "migrations/0030_backfill_visit_date_to_appointment_time.sql"), "utf8"));

      const rows = db
        .prepare("SELECT id, visited_at FROM customer_visits WHERE customer_id = 'cust_bf_1' ORDER BY id")
        .all() as Array<{ id: string; visited_at: string }>;
      const byId = Object.fromEntries(rows.map((r) => [r.id, r.visited_at]));

      // Valid reservation-sourced rows reset to their reservation's start_at.
      expect(byId["cv_bf_web"]).toBe("2026-05-20T01:00:00.000Z");
      expect(byId["cv_bf_phone"]).toBe("2026-05-22T03:00:00.000Z");
      // Manual import (reservation_id NULL) keeps the operator-entered date.
      expect(byId["cv_bf_manual"]).toBe("2026-03-10");
      // Voided/audit row is left untouched.
      expect(byId["cv_bf_void"]).toBe("2026-05-27T11:00:00.000Z");
      // Already-correct row (visited_at == start_at) is unchanged and was skipped.
      expect(byId["cv_bf_ok"]).toBe("2026-05-24T07:00:00.000Z");

      // The pre-update snapshot captured EXACTLY the two genuinely-changed rows
      // (not the already-correct, voided, or manual rows) — for rollback.
      const backup = db
        .prepare("SELECT customer_visit_id, old_visited_at FROM _backfill_0030_visit_dates_backup ORDER BY customer_visit_id")
        .all() as Array<{ customer_visit_id: string; old_visited_at: string }>;
      expect(backup).toEqual([
        { customer_visit_id: "cv_bf_phone", old_visited_at: "2026-05-26T10:15:00.000Z" },
        { customer_visit_id: "cv_bf_web", old_visited_at: "2026-05-25T09:30:00.000Z" },
      ]);
    } finally {
      db.close();
    }
  });
});

describe("0033 line_identities.linked_by_admin migration", () => {
  const allMigrationFiles = () =>
    readdirSync(join(process.cwd(), "migrations"))
      .filter((fileName) => fileName.endsWith(".sql"))
      .sort();

  const applyMigrations = (sqliteDb: DatabaseSync, until?: string) => {
    const dir = join(process.cwd(), "migrations");
    for (const fileName of allMigrationFiles()) {
      if (until && fileName >= until) break;
      sqliteDb.exec(readFileSync(join(dir, fileName), "utf8"));
    }
  };

  it("adds linked_by_admin as NOT NULL DEFAULT 0 with a 0/1 CHECK", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    applyMigrations(db);
    try {
      const column = (
        db.prepare("PRAGMA table_info(line_identities)").all() as Array<{
          name: string;
          notnull: number;
          dflt_value: string | null;
        }>
      ).find((c) => c.name === "linked_by_admin");
      expect(column).toBeDefined();
      expect(column?.notnull).toBe(1);
      expect(String(column?.dflt_value)).toContain("0");

      // CHECK (linked_by_admin IN (0,1)) rejects out-of-range values.
      expect(() =>
        db
          .prepare(
            `INSERT INTO line_identities (id, customer_id, provider, channel_id, line_user_id, linked_by_admin, updated_at)
             VALUES ('li_bad', NULL, 'line', 'ch', 'Ubad', 2, '2026-06-09T00:00:00.000Z')`
          )
          .run()
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it("backfills linked_by_admin=1 for identities whose customer has a paper_chart_import valid visit (incremental)", () => {
    const sandbox = new DatabaseSync(":memory:");
    sandbox.exec("PRAGMA foreign_keys = ON;");
    applyMigrations(sandbox, "0033");
    applyCurrentSeedServiceColumns(sandbox);
    sandbox.exec(readFileSync(join(process.cwd(), "seeds/dev.sql"), "utf8"));
    sandbox.exec(`
      -- A: pre-existing admin-linked paper-chart customer (has the legacy seed visit).
      INSERT INTO customers (id, display_name, block_status, updated_at)
      VALUES ('cust_a', '紙カルテ客', 'active', '2026-05-09T00:00:00.000Z');
      INSERT INTO customer_visits (id, customer_id, store_id, visited_at, visit_source, status, recorded_by)
      VALUES ('cv_a', 'cust_a', 'kyoto', '2026-05-09', 'paper_chart_import', 'valid', 'admin_x');
      INSERT INTO line_identities (id, customer_id, provider, channel_id, line_user_id, updated_at)
      VALUES ('li_a', 'cust_a', 'line', 'login-channel-1', 'Ua', '2026-05-09T00:00:00.000Z');

      -- B: a normal web booker (real visit, no paper-chart seed) must NOT be flagged.
      INSERT INTO customers (id, display_name, block_status, updated_at)
      VALUES ('cust_b', 'Web客', 'active', '2026-05-09T00:00:00.000Z');
      INSERT INTO customer_visits (id, customer_id, store_id, visited_at, visit_source, status, recorded_by)
      VALUES ('cv_b', 'cust_b', 'kyoto', '2026-05-09', 'reservation_completed', 'valid', 'admin_x');
      INSERT INTO line_identities (id, customer_id, provider, channel_id, line_user_id, updated_at)
      VALUES ('li_b', 'cust_b', 'line', 'login-channel-1', 'Ub', '2026-05-09T00:00:00.000Z');
    `);

    sandbox.exec(
      readFileSync(join(process.cwd(), "migrations/0033_line_identities_linked_by_admin.sql"), "utf8")
    );

    const rows = sandbox
      .prepare("SELECT id, linked_by_admin FROM line_identities WHERE id IN ('li_a', 'li_b') ORDER BY id")
      .all() as Array<{ id: string; linked_by_admin: number }>;
    expect(rows).toEqual([
      { id: "li_a", linked_by_admin: 1 }, // paper-chart seed → flagged
      { id: "li_b", linked_by_admin: 0 }, // normal web booker → not flagged
    ]);
    sandbox.close();
  });
});

describe("0040 drop of idx_reservations_one_pending_per_line", () => {
  it("removes the one-pending-per-line unique index from the final schema (全予約承認制)", () => {
    // 全 migration 適用後のスキーマで直接検証する (migration の取りこぼし検出)。
    const full = new DatabaseSync(":memory:");
    full.exec("PRAGMA foreign_keys = ON;");
    const migrationsDir = join(process.cwd(), "migrations");
    for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
      full.exec(readFileSync(join(migrationsDir, file), "utf8"));
    }
    const indexes = full
      .prepare("PRAGMA index_list('reservations')")
      .all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).not.toContain("idx_reservations_one_pending_per_line");
    full.close();
  });
});

describe("0041 services.price_label migration", () => {
  it("backfills existing rows to NULL and enforces the 80-character limit", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    const migrationsDir = join(process.cwd(), "migrations");
    const migrationFiles = readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort();

    try {
      for (const file of migrationFiles.filter((file) => file < "0041_service_price_label.sql")) {
        db.exec(readFileSync(join(migrationsDir, file), "utf8"));
      }
      db.exec(`
        INSERT INTO stores (id, name) VALUES ('store_price_label', '料金テスト店舗');
        INSERT INTO services (id, store_id, name, duration_minutes)
        VALUES ('service_price_label', 'store_price_label', '料金テスト', 60);
      `);

      const migrationFile = migrationFiles.find((file) => file === "0041_service_price_label.sql");
      expect(migrationFile).toBe("0041_service_price_label.sql");
      if (!migrationFile) return;
      db.exec(readFileSync(join(migrationsDir, migrationFile), "utf8"));

      const existing = db
        .prepare("SELECT price_label FROM services WHERE id = 'service_price_label'")
        .get() as { price_label: string | null };
      expect(existing.price_label).toBeNull();

      const eightyCharacters = "料".repeat(80);
      db.prepare("UPDATE services SET price_label = ? WHERE id = 'service_price_label'").run(eightyCharacters);
      expect(
        (db.prepare("SELECT price_label FROM services WHERE id = 'service_price_label'").get() as { price_label: string }).price_label
      ).toBe(eightyCharacters);

      expect(() =>
        db.prepare("UPDATE services SET price_label = ? WHERE id = 'service_price_label'").run("料".repeat(81))
      ).toThrow();
    } finally {
      db.close();
    }
  });
});

describe("0042 services price amounts migration", () => {
  it("backfills NULL and enforces amount and prefix column checks", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    const migrationsDir = join(process.cwd(), "migrations");
    const migrationFiles = readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort();

    try {
      for (const file of migrationFiles.filter((file) => file < "0042_service_price_amounts.sql")) {
        db.exec(readFileSync(join(migrationsDir, file), "utf8"));
      }
      db.exec(`
        INSERT INTO stores (id, name) VALUES ('store_price_amounts', '数値料金テスト店舗');
        INSERT INTO services (id, store_id, name, duration_minutes)
        VALUES ('service_price_amounts', 'store_price_amounts', '数値料金テスト', 60);
      `);

      const migrationFile = migrationFiles.find((file) => file === "0042_service_price_amounts.sql");
      expect(migrationFile).toBe("0042_service_price_amounts.sql");
      if (!migrationFile) return;
      db.exec(readFileSync(join(migrationsDir, migrationFile), "utf8"));

      expect(db.prepare("SELECT price_amount, combo_price_amount, combo_with_prefix FROM services WHERE id = 'service_price_amounts'").get()).toEqual({
        price_amount: null,
        combo_price_amount: null,
        combo_with_prefix: null
      });

      for (const amount of [0, 1_000_000]) {
        db.prepare("UPDATE services SET price_amount = ?, combo_price_amount = ? WHERE id = 'service_price_amounts'").run(amount, amount);
      }
      for (const prefix of ["脱", "脱".repeat(40)]) {
        db.prepare("UPDATE services SET combo_with_prefix = ? WHERE id = 'service_price_amounts'").run(prefix);
      }

      for (const column of ["price_amount", "combo_price_amount"]) {
        for (const amount of [1_500.5, -1, 1_000_001]) {
          expect(() => db.prepare(`UPDATE services SET ${column} = ? WHERE id = 'service_price_amounts'`).run(amount)).toThrow();
        }
      }
      for (const prefix of ["", "脱".repeat(41)]) {
        expect(() => db.prepare("UPDATE services SET combo_with_prefix = ? WHERE id = 'service_price_amounts'").run(prefix)).toThrow();
      }

      // DDL only checks stored length; API/UI normalization rejects whitespace-only prefixes.
      expect(() => db.prepare("UPDATE services SET combo_with_prefix = '　' WHERE id = 'service_price_amounts'").run()).not.toThrow();
    } finally {
      db.close();
    }
  });
});

describe("0045 reservation cap default-one migration", () => {
  it("updates existing store settings to 1 without explicit transaction control", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    const migrationsDir = join(process.cwd(), "migrations");
    const migrationFiles = readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort();

    try {
      for (const file of migrationFiles.filter((file) => file < "0045_reservation_cap_default_one.sql")) {
        db.exec(readFileSync(join(migrationsDir, file), "utf8"));
      }
      db.exec(`
        INSERT INTO stores (id, name) VALUES ('store_cap_migration', '上限移行テスト店舗');
        INSERT INTO store_settings (store_id, max_active_reservations_per_customer)
        VALUES ('store_cap_migration', 7);
      `);

      const migrationFile = migrationFiles.find(
        (file) => file === "0045_reservation_cap_default_one.sql"
      );
      expect(migrationFile).toBe("0045_reservation_cap_default_one.sql");
      if (!migrationFile) return;
      const sql = readFileSync(join(migrationsDir, migrationFile), "utf8");
      expect(sql).not.toMatch(/^\s*BEGIN(?:\s+TRANSACTION)?\s*;/im);
      expect(sql).not.toMatch(/^\s*COMMIT\s*;/im);
      db.exec(sql);

      const row = db
        .prepare(
          "SELECT max_active_reservations_per_customer AS cap FROM store_settings WHERE store_id = 'store_cap_migration'"
        )
        .get() as { cap: number };
      expect(row.cap).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe("0046 Kyoto men's menu migration", () => {
  it("inserts the men's menus INACTIVE so the pre-deploy Worker cannot serve them", () => {
    // Deploy applies D1 migrations before publishing the new Worker, so an active
    // row would be bookable for the length of that gap (and indefinitely if the
    // deploy step fails) by a Worker that does not enforce the men's booking
    // window. A follow-up migration activates them once the new Worker is live.
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    const migrationsDir = join(process.cwd(), "migrations");
    const migrationFiles = readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort();
    const target = "0046_kyoto_mens_menus.sql";

    try {
      for (const file of migrationFiles.filter((file) => file < target)) {
        db.exec(readFileSync(join(migrationsDir, file), "utf8"));
      }
      db.exec("INSERT INTO stores (id, name) VALUES ('kyoto', '京都店');");
      db.exec(readFileSync(join(migrationsDir, target), "utf8"));

      const rows = db
        .prepare(
          `SELECT active, mens_menu FROM services
             WHERE store_id = 'kyoto' AND id LIKE 'service_kyoto_mens_%'`
        )
        .all() as Array<{ active: number; mens_menu: number }>;
      expect(rows).toHaveLength(17);
      expect(rows.every((row) => row.active === 0)).toBe(true);
      expect(rows.every((row) => row.mens_menu === 1)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("0047 activates exactly those 17 menus once the enforcing Worker is live", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    const migrationsDir = join(process.cwd(), "migrations");
    const migrationFiles = readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort();

    try {
      for (const file of migrationFiles.filter((file) => file < "0046_kyoto_mens_menus.sql")) {
        db.exec(readFileSync(join(migrationsDir, file), "utf8"));
      }
      db.exec("INSERT INTO stores (id, name) VALUES ('kyoto', '京都店');");
      db.exec(readFileSync(join(migrationsDir, "0046_kyoto_mens_menus.sql"), "utf8"));
      // A non-men's Kyoto menu that happens to be inactive: 0047 must leave it alone.
      db.exec(
        `INSERT INTO services (id, store_id, name, duration_minutes, price_amount, active, mens_menu)
           VALUES ('service_kyoto_retired', 'kyoto', '廃止メニュー', 30, 1000, 0, 0);`
      );
      db.exec(readFileSync(join(migrationsDir, "0047_activate_kyoto_mens_menus.sql"), "utf8"));

      const active = db
        .prepare(
          `SELECT COUNT(*) AS count FROM services
             WHERE id LIKE 'service_kyoto_mens_%' AND active = 1`
        )
        .get() as { count: number };
      expect(active.count).toBe(17);
      const untouched = db
        .prepare(`SELECT active FROM services WHERE id = 'service_kyoto_retired'`)
        .get() as { active: number };
      expect(untouched.active).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("0050 issue #600 self-delete tombstone backfill", () => {
  const MIGRATION = "0050_backfill_issue_600_self_delete_tombstone.sql";
  const CALENDAR = "calendar-a@example.invalid";

  const applyMigrationsBefore = (sqliteDb: DatabaseSync) => {
    const dir = join(process.cwd(), "migrations");
    for (const fileName of readdirSync(dir)
      .filter((name) => name.endsWith(".sql") && name < MIGRATION)
      .sort()) {
      sqliteDb.exec(readFileSync(join(dir, fileName), "utf8"));
    }
  };

  const seedDeps = (sqliteDb: DatabaseSync) => {
    sqliteDb.prepare(`INSERT INTO stores (id, name, timezone) VALUES (?, ?, ?)`).run("store_b", "Backfill Store", "Asia/Tokyo");
    sqliteDb.prepare(`INSERT INTO store_resources (id, store_id, name) VALUES (?, ?, ?)`).run("resource_b", "store_b", "Room");
    sqliteDb
      .prepare(`INSERT INTO customers (id, display_name, phone_normalized, phone_hash) VALUES (?, ?, ?, ?)`)
      .run("customer_b", "Backfill Customer", "0700000050", "hash_b");
    sqliteDb.prepare(`INSERT INTO services (id, store_id, name, duration_minutes) VALUES (?, ?, ?, ?)`).run("service_b", "store_b", "Service B", 60);
  };

  const insertReservation = (sqliteDb: DatabaseSync, id: string, status: string, googleEventId: string | null) => {
    sqliteDb
      .prepare(
        `INSERT INTO reservations (
          id, store_id, service_id, customer_id, resource_id, source, status,
          start_at, end_at, duration_minutes, idempotency_key, google_event_id
        ) VALUES (?, 'store_b', 'service_b', 'customer_b', 'resource_b', 'web_line', ?,
          '2026-08-01T01:00:00.000Z', '2026-08-01T02:00:00.000Z', 60, ?, ?)`
      )
      .run(id, status, `idem_${id}`, googleEventId);
  };

  // The mangled shape every one of these rows is in: recordGoogleEventConflict
  // re-upserted the ledger row when the conflict opened, so source_type and
  // reservation_id are gone alongside the status.
  // The snapshot is what proves the event is a tombstone on Google's side; the
  // internal status alone cannot tell a deleted event from a live one whose marker
  // did not match.
  const snapshot = (googleEventId: string, googleStatus: string) =>
    JSON.stringify({
      google_event_id: googleEventId,
      status: googleStatus,
      start_at: "2026-08-01T01:00:00.000Z",
      end_at: "2026-08-01T02:00:00.000Z",
      transparency: "opaque",
      all_day: false,
      recurring: false
    });

  const insertMangledLedgerRow = (
    sqliteDb: DatabaseSync,
    id: string,
    googleEventId: string,
    status: string,
    snapshotJson: string | null = snapshot(googleEventId, "cancelled")
  ) => {
    sqliteDb
      .prepare(
        `INSERT INTO google_calendar_events (id, store_id, calendar_id, google_event_id, source_type, status, google_safe_snapshot_json)
         VALUES (?, 'store_b', ?, ?, 'unknown', ?, ?)`
      )
      .run(id, CALENDAR, googleEventId, status, snapshotJson);
  };

  const insertConflict = (
    sqliteDb: DatabaseSync,
    id: string,
    googleEventId: string,
    reservationId: string,
    resolutionStatus: string,
    conflictType = "reservation_marker_mismatch",
    snapshotJson: string | null = null
  ) => {
    sqliteDb
      .prepare(
        `INSERT INTO google_calendar_conflicts (
           id, store_id, calendar_id, google_event_id, reservation_id, conflict_type,
           google_safe_snapshot_json, resolution_status
         ) VALUES (?, 'store_b', ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        CALENDAR,
        googleEventId,
        reservationId,
        conflictType,
        snapshotJson ?? snapshot(googleEventId, "cancelled"),
        resolutionStatus
      );
  };

  const ledgerRow = (sqliteDb: DatabaseSync, googleEventId: string) =>
    sqliteDb
      .prepare(`SELECT status, source_type, reservation_id FROM google_calendar_events WHERE google_event_id = ?`)
      .get(googleEventId) as { status: string; source_type: string; reservation_id: string | null };

  const conflictRow = (sqliteDb: DatabaseSync, id: string) =>
    sqliteDb
      .prepare(`SELECT resolution_status, resolved_by FROM google_calendar_conflicts WHERE id = ?`)
      .get(id) as { resolution_status: string; resolved_by: string | null };

  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    applyMigrationsBefore(db);
    seedDeps(db);

    // (1) the false positive: terminal reservation that has let go of the event id.
    insertReservation(db, "res_fp", "cancelled_by_admin", null);
    insertMangledLedgerRow(db, "gce_fp", "gev_fp", "conflict");
    insertConflict(db, "conf_fp", "gev_fp", "res_fp", "open");

    // (2) same shape, but the conflict was already cleared by hand and the orphan
    //     sweep has since flipped the ledger row to 'deleted'.
    insertReservation(db, "res_swept", "expired", null);
    insertMangledLedgerRow(db, "gce_swept", "gev_swept", "deleted");
    insertConflict(db, "conf_swept", "gev_swept", "res_swept", "manual_resolved");

    // (3) live reservation whose event went missing — a real, actionable mismatch.
    insertReservation(db, "res_live", "confirmed", null);
    insertMangledLedgerRow(db, "gce_live", "gev_live", "conflict");
    insertConflict(db, "conf_live", "gev_live", "res_live", "open");

    // (4) terminal reservation that still points AT this event id: no proof we deleted it.
    insertReservation(db, "res_linked", "cancelled_by_customer", "gev_linked");
    insertMangledLedgerRow(db, "gce_linked", "gev_linked", "conflict");
    insertConflict(db, "conf_linked", "gev_linked", "res_linked", "open");

    // (5) two different reservations name the same event: the repair value is ambiguous.
    insertReservation(db, "res_amb_a", "rejected", null);
    insertReservation(db, "res_amb_b", "expired", null);
    insertMangledLedgerRow(db, "gce_amb", "gev_amb", "conflict");
    insertConflict(db, "conf_amb_a", "gev_amb", "res_amb_a", "open");
    insertConflict(db, "conf_amb_b", "gev_amb", "res_amb_b", "open");

    // (6) qualifies, but another conflict type is still open on the same event.
    insertReservation(db, "res_other", "rejected", null);
    insertMangledLedgerRow(db, "gce_other", "gev_other", "conflict");
    insertConflict(db, "conf_other_mm", "gev_other", "res_other", "open");
    insertConflict(db, "conf_other_del", "gev_other", "res_other", "open", "reservation_event_deleted");

    // (7) the named reservation let go of the event, but a DIFFERENT reservation
    //     is holding that same event id — the event is live for someone else.
    insertReservation(db, "res_giver", "rejected", null);
    insertReservation(db, "res_holder", "confirmed", "gev_shared");
    insertMangledLedgerRow(db, "gce_shared", "gev_shared", "conflict");
    insertConflict(db, "conf_shared", "gev_shared", "res_giver", "open");

    // (8) the named reservation is terminal but still carries an event id (a
    //     different one) — it never let go, so we have no delete to point at.
    insertReservation(db, "res_elsewhere", "expired", "gev_elsewhere");
    insertMangledLedgerRow(db, "gce_moved", "gev_moved", "conflict");
    insertConflict(db, "conf_moved", "gev_moved", "res_elsewhere", "open");

    // (9) an external block is holding this event id. Anyone with calendar write
    //     access can put a terminal reservation's marker on a live block's event
    //     and land it in exactly the shape this backfill repairs.
    insertReservation(db, "res_spoofed", "rejected", null);
    db.prepare(
      `INSERT INTO external_blocks (id, store_id, resource_id, source, title_snapshot, start_at, end_at, status, google_event_id, created_by)
       VALUES ('block_b', 'store_b', 'resource_b', 'google_calendar', 'Staff block',
               '2026-08-02T01:00:00.000Z', '2026-08-02T02:00:00.000Z', 'active', 'gev_block', 'system')`
    ).run();
    insertMangledLedgerRow(db, "gce_block", "gev_block", "conflict");
    insertConflict(db, "conf_block", "gev_block", "res_spoofed", "open");

    // (10) a ledger row that ALREADY looks like our own delete, but wasn't put there
    //      by this backfill: the orphan sweep keeps reservation_id/source_type and
    //      only flips status, so a live reservation can still be holding the event.
    insertReservation(db, "res_swept_live", "confirmed", "gev_swept_live");
    db.prepare(
      `INSERT INTO google_calendar_events (id, store_id, calendar_id, google_event_id, reservation_id, source_type, status, google_safe_snapshot_json)
       VALUES ('gce_swept_live', 'store_b', ?, 'gev_swept_live', 'res_swept_live', 'reservation', 'deleted', ?)`
    ).run(CALENDAR, snapshot("gev_swept_live", "cancelled"));
    insertConflict(db, "conf_swept_live", "gev_swept_live", "res_swept_live", "open");

    // (11) ledger row is healthy (active, owned) — statement 1 never touches it, so
    //      its conflict has no repair to ride on.
    insertReservation(db, "res_active_led", "rejected", null);
    db.prepare(
      `INSERT INTO google_calendar_events (id, store_id, calendar_id, google_event_id, reservation_id, source_type, status, google_safe_snapshot_json)
       VALUES ('gce_active', 'store_b', ?, 'gev_active', 'res_active_led', 'reservation', 'active', ?)`
    ).run(CALENDAR, snapshot("gev_active", "cancelled"));
    insertConflict(db, "conf_active", "gev_active", "res_active_led", "open");

    // (12) sweep-shaped ledger row for a reservation that is still LIVE (it just is
    //      not holding this event id) — the mismatch is real and must stay visible.
    insertReservation(db, "res_live_swept", "confirmed", null);
    db.prepare(
      `INSERT INTO google_calendar_events (id, store_id, calendar_id, google_event_id, reservation_id, source_type, status, google_safe_snapshot_json)
       VALUES ('gce_live_swept', 'store_b', ?, 'gev_live_swept', 'res_live_swept', 'reservation', 'deleted', ?)`
    ).run(CALENDAR, snapshot("gev_live_swept", "cancelled"));
    insertConflict(db, "conf_live_swept", "gev_live_swept", "res_live_swept", "open");

    // (13) sweep-shaped ledger row naming a terminal reservation, but a different
    //      live reservation is holding that event id.
    insertReservation(db, "res_giver2", "rejected", null);
    insertReservation(db, "res_holder2", "confirmed", "gev_shared2");
    db.prepare(
      `INSERT INTO google_calendar_events (id, store_id, calendar_id, google_event_id, reservation_id, source_type, status, google_safe_snapshot_json)
       VALUES ('gce_shared2', 'store_b', ?, 'gev_shared2', 'res_giver2', 'reservation', 'deleted', ?)`
    ).run(CALENDAR, snapshot("gev_shared2", "cancelled"));
    insertConflict(db, "conf_shared2", "gev_shared2", "res_giver2", "open");

    // (14) the marker names a terminal reservation belonging to ANOTHER store.
    db.prepare(`INSERT INTO stores (id, name, timezone) VALUES ('store_x', 'Other Store', 'Asia/Tokyo')`).run();
    db.prepare(`INSERT INTO store_resources (id, store_id, name) VALUES ('resource_x', 'store_x', 'Room')`).run();
    db.prepare(`INSERT INTO services (id, store_id, name, duration_minutes) VALUES ('service_x', 'store_x', 'Service X', 60)`).run();
    db.prepare(
      `INSERT INTO reservations (
         id, store_id, service_id, customer_id, resource_id, source, status,
         start_at, end_at, duration_minutes, idempotency_key
       ) VALUES ('res_other_store', 'store_x', 'service_x', 'customer_b', 'resource_x', 'web_line', 'rejected',
         '2026-08-03T01:00:00.000Z', '2026-08-03T02:00:00.000Z', 60, 'idem_res_other_store')`
    ).run();
    insertMangledLedgerRow(db, "gce_xstore", "gev_xstore", "conflict");
    insertConflict(db, "conf_xstore", "gev_xstore", "res_other_store", "open");

    // (15) same cross-store marker, but the ledger row is already in the repaired
    //      shape — so only the second statement's own store check can stop it.
    db.prepare(
      `INSERT INTO reservations (
         id, store_id, service_id, customer_id, resource_id, source, status,
         start_at, end_at, duration_minutes, idempotency_key
       ) VALUES ('res_other_store2', 'store_x', 'service_x', 'customer_b', 'resource_x', 'web_line', 'rejected',
         '2026-08-04T01:00:00.000Z', '2026-08-04T02:00:00.000Z', 60, 'idem_res_other_store2')`
    ).run();
    db.prepare(
      `INSERT INTO google_calendar_events (id, store_id, calendar_id, google_event_id, reservation_id, source_type, status, google_safe_snapshot_json)
       VALUES ('gce_xstore2', 'store_b', ?, 'gev_xstore2', 'res_other_store2', 'reservation', 'deleted', ?)`
    ).run(CALENDAR, snapshot("gev_xstore2", "cancelled"));
    insertConflict(db, "conf_xstore2", "gev_xstore2", "res_other_store2", "open");

    // (16) the event is still LIVE on Google — a terminal reservation's marker was
    //      put on it. Same broken ledger shape, but nothing was ever deleted.
    insertReservation(db, "res_marker_live", "rejected", null);
    insertMangledLedgerRow(db, "gce_livegoogle", "gev_livegoogle", "conflict", snapshot("gev_livegoogle", "confirmed"));
    insertConflict(db, "conf_livegoogle", "gev_livegoogle", "res_marker_live", "open");

    // (17) same, but the ledger row is already in the repaired shape, so only the
    //      second statement's own snapshot check can stop it.
    insertReservation(db, "res_marker_live2", "rejected", null);
    db.prepare(
      `INSERT INTO google_calendar_events (id, store_id, calendar_id, google_event_id, reservation_id, source_type, status, google_safe_snapshot_json)
       VALUES ('gce_livegoogle2', 'store_b', ?, 'gev_livegoogle2', 'res_marker_live2', 'reservation', 'deleted', ?)`
    ).run(CALENDAR, snapshot("gev_livegoogle2", "confirmed"));
    insertConflict(db, "conf_livegoogle2", "gev_livegoogle2", "res_marker_live2", "open");

    // (18) unreadable snapshot: fail closed rather than guess.
    insertReservation(db, "res_badjson", "expired", null);
    insertMangledLedgerRow(db, "gce_badjson", "gev_badjson", "conflict", "not json at all");
    insertConflict(db, "conf_badjson", "gev_badjson", "res_badjson", "open");

    // (19) the conflict was opened while the event was still live; the ledger
    //      snapshot has since been overwritten with the tombstone, but the conflict
    //      row keeps its original one (the insert is skipped while one is open).
    insertReservation(db, "res_late_delete", "expired", null);
    insertMangledLedgerRow(db, "gce_late", "gev_late", "conflict");
    insertConflict(
      db,
      "conf_late",
      "gev_late",
      "res_late_delete",
      "open",
      "reservation_marker_mismatch",
      snapshot("gev_late", "confirmed")
    );

    // (20) same timeline, but the ledger row is already in the repaired shape — only
    //      the second statement's own conflict-snapshot check can stop it.
    insertReservation(db, "res_late2", "expired", null);
    db.prepare(
      `INSERT INTO google_calendar_events (id, store_id, calendar_id, google_event_id, reservation_id, source_type, status, google_safe_snapshot_json)
       VALUES ('gce_late2', 'store_b', ?, 'gev_late2', 'res_late2', 'reservation', 'deleted', ?)`
    ).run(CALENDAR, snapshot("gev_late2", "cancelled"));
    insertConflict(
      db,
      "conf_late2",
      "gev_late2",
      "res_late2",
      "open",
      "reservation_marker_mismatch",
      snapshot("gev_late2", "confirmed")
    );
  });

  afterEach(() => {
    db.close();
  });

  const runMigration = () => {
    const sql = readFileSync(join(process.cwd(), "migrations", MIGRATION), "utf8");
    expect(sql).not.toMatch(/^\s*BEGIN(?:\s+TRANSACTION)?\s*;/im);
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/im);
    db.exec(sql);
  };

  it("repairs the ledger row and closes the conflict for a delete we issued ourselves", () => {
    runMigration();

    expect(ledgerRow(db, "gev_fp")).toEqual({
      status: "deleted",
      source_type: "reservation",
      reservation_id: "res_fp"
    });
    const conflict = conflictRow(db, "conf_fp");
    expect(conflict.resolution_status).toBe("ignored");
    expect(conflict.resolved_by).toBe("system:issue_600_self_delete_tombstone");
  });

  it("repairs an already-swept ledger row so the suppression can match it next walk", () => {
    runMigration();

    expect(ledgerRow(db, "gev_swept")).toEqual({
      status: "deleted",
      source_type: "reservation",
      reservation_id: "res_swept"
    });
    expect(conflictRow(db, "conf_swept").resolution_status).toBe("manual_resolved");
  });

  // Everything the backfill must NOT touch. Same assertion shape for all of them:
  // the broken ledger row (when there is one) stays broken, and every listed conflict
  // stays open — a conflict is the only signal a human ever sees about these events.
  const BROKEN = { status: "conflict", source_type: "unknown", reservation_id: null };

  it.each([
    { label: "the reservation is still live", ledger: { event: "gev_live", expect: BROKEN }, openConflicts: ["conf_live"] },
    { label: "the reservation still points at the event id", ledger: { event: "gev_linked", expect: BROKEN }, openConflicts: ["conf_linked"] },
    { label: "two reservations name the same event", ledger: { event: "gev_amb", expect: BROKEN }, openConflicts: ["conf_amb_a", "conf_amb_b"] },
    { label: "another conflict type is open on the event", ledger: { event: "gev_other", expect: BROKEN }, openConflicts: ["conf_other_mm", "conf_other_del"] },
    { label: "an external block holds the event id", ledger: { event: "gev_block", expect: BROKEN }, openConflicts: ["conf_block"] },
    { label: "a different reservation holds the event id", ledger: { event: "gev_shared", expect: BROKEN }, openConflicts: ["conf_shared"] },
    { label: "the named reservation still carries some event id", ledger: { event: "gev_moved", expect: BROKEN }, openConflicts: ["conf_moved"] },
    { label: "the marker names another store's reservation", ledger: { event: "gev_xstore", expect: BROKEN }, openConflicts: ["conf_xstore", "conf_xstore2"] },
    { label: "the event is still live on Google", ledger: { event: "gev_livegoogle", expect: BROKEN }, openConflicts: ["conf_livegoogle", "conf_livegoogle2"] },
    { label: "the conflict was opened against a live event", ledger: { event: "gev_late", expect: BROKEN }, openConflicts: ["conf_late", "conf_late2"] },
    { label: "the snapshot is unreadable", ledger: { event: "gev_badjson", expect: BROKEN }, openConflicts: ["conf_badjson"] },
    {
      label: "the ledger row was never in the broken shape",
      ledger: { event: "gev_active", expect: { status: "active", source_type: "reservation", reservation_id: "res_active_led" } },
      openConflicts: ["conf_active"]
    },
    {
      // The sweep leaves reservation_id/source_type in place and only flips status, so
      // these already look like the backfill's output without ever having been repaired.
      label: "the repaired shape came from the orphan sweep, not from this backfill",
      ledger: null,
      openConflicts: ["conf_swept_live", "conf_live_swept", "conf_shared2"]
    }
  ])("leaves everything alone when $label", ({ ledger, openConflicts }) => {
    runMigration();

    if (ledger) {
      expect(ledgerRow(db, ledger.event)).toEqual(ledger.expect);
    }
    for (const id of openConflicts) {
      expect(conflictRow(db, id).resolution_status).toBe("open");
    }
  });


  it("is idempotent", () => {
    runMigration();
    runMigration();

    expect(ledgerRow(db, "gev_fp")).toEqual({
      status: "deleted",
      source_type: "reservation",
      reservation_id: "res_fp"
    });
    expect(conflictRow(db, "conf_fp").resolution_status).toBe("ignored");
    expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
  });
});
