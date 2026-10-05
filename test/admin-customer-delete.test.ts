import { insertAdminUser } from "./helpers/admin-access";
import { describe, expect, it } from "vitest";

import { executeAdminCustomerDelete } from "../src/admin/customer-delete";
import type { AdminUser } from "../src/admin/access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

// Task 4: customer HARD delete. The harness runs PRAGMA foreign_keys=ON (see
// createMigratedSqliteD1), so the declared FK actions (RESTRICT/CASCADE/SET
// NULL) fire EXACTLY as in Cloudflare D1 production — these tests verify the
// FK-ordered batch both removes the RESTRICT children / no-FK orphans
// explicitly AND that CASCADE cleans the rest.

const OWNER: AdminUser = {
  id: "admin_owner_test",
  email: "owner@example.com",
  role: "owner",
  staff_member_id: null,
  store_id: null
};
const STAFF: AdminUser = {
  id: "admin_staff_test",
  email: "staff@example.com",
  role: "staff",
  staff_member_id: "staff_owner_kyoto",
  store_id: "kyoto"
};

// SqliteD1Database implements the prepare/batch surface the domain code uses
// but not the full D1Database type (exec/dump/withSession) — cast like the
// sibling domain tests do.
const asDb = (db: SqliteD1Database) => db as unknown as D1Database;

const endPlusHour = (startAt: string) => new Date(new Date(startAt).getTime() + 3_600_000).toISOString();

// Seeds one fully-wired customer 'c_del' touching every table that references
// customers / its reservations / its line identity. Reservation status +
// google-event status are parameterised so a single seeder drives both the
// happy path (historical, deletable) and each guard case.
const seedCustomer = (
  db: SqliteD1Database,
  opts: { reservationStatus?: string; googleEventStatus?: string; syncStatus?: string } = {}
) => {
  insertAdminUser(db, { id: OWNER.id, email: OWNER.email, accessSubject: OWNER.id });
  const resvStatus = opts.reservationStatus ?? "cancelled_by_admin";
  const eventStatus = opts.googleEventStatus ?? "cancelled";
  const syncStatus = opts.syncStatus ?? "succeeded";
  const start = "2026-04-01T10:00:00Z";

  db.sqlite.exec(`
    INSERT INTO customers (id, display_name, display_name_kana, phone_normalized, phone_hash, block_status, created_at, updated_at)
    VALUES ('c_del', '削除 対象', 'サクジョ タイショウ', '08099990000', 'hash_del', 'active', '2026-03-01T00:00:00Z', '2026-03-01T00:00:00Z');

    INSERT INTO line_identities (id, customer_id, provider, channel_id, line_user_id, friend_flag, official_friend_status)
    VALUES ('li_del', 'c_del', 'line', 'chan_test', 'U_del_0001', 1, 'friend');

    INSERT INTO referral_notes (id, customer_id, note, created_by)
    VALUES ('ref_del', 'c_del', '紹介メモ', 'admin_test');

    INSERT INTO customer_match_candidates (id, customer_id, line_identity_id, match_key, confidence_score, status)
    VALUES ('mc_del', 'c_del', 'li_del', 'phone:hash_del', 0.9, 'pending');
  `);

  db.sqlite
    .prepare(
      `INSERT INTO reservations (id, store_id, service_id, customer_id, resource_id, line_identity_id, source, status, duration_minutes, idempotency_key, start_at, end_at, version, created_at, updated_at)
       VALUES ('r_del', 'kyoto', 'service_kyoto_default_60', 'c_del', 'resource_kyoto_calendar', 'li_del', 'web_line', ?, 60, 'ik_r_del', ?, ?, 1, '2026-03-01T00:00:00Z', '2026-03-01T00:00:00Z')`
    )
    .run(resvStatus, start, endPlusHour(start));

  db.sqlite.exec(`
    INSERT INTO reservation_services (reservation_id, service_id, display_order, name_snapshot, duration_minutes)
    VALUES ('r_del', 'service_kyoto_default_60', 0, '脱毛コース', 60);

    INSERT INTO customer_visits (id, customer_id, reservation_id, store_id, visited_at, visit_source, status, recorded_by)
    VALUES ('v_del', 'c_del', 'r_del', 'kyoto', '2026-04-01', 'reservation_completed', 'valid', 'admin_test');

    INSERT INTO consent_records (id, customer_id, reservation_id, consent_type, version, consented_at)
    VALUES ('cons_del', 'c_del', 'r_del', 'privacy_policy', 'v1', '2026-03-01T00:00:00Z');

    INSERT INTO customer_time_locks (id, customer_id, slot_at, owner_type, owner_id, lock_status, expires_at)
    VALUES ('ctl_del', 'c_del', '2026-04-01T10:00:00Z', 'reservation', 'r_del', 'confirmed', NULL);

    INSERT INTO slot_locks (id, store_id, resource_id, slot_at, owner_type, owner_id, lock_status, expires_at)
    VALUES ('sl_del', 'kyoto', 'resource_kyoto_calendar', '2026-04-01T10:00:00Z', 'reservation', 'r_del', 'confirmed', NULL);

    INSERT INTO reservation_change_requests (id, reservation_id, customer_id, line_identity_id, request_type, status, reservation_version_at_request, current_start_at, current_end_at)
    VALUES ('crq_del', 'r_del', 'c_del', 'li_del', 'cancel', 'approved', 1, '2026-04-01T10:00:00Z', '2026-04-01T11:00:00Z');

    INSERT INTO notification_jobs (id, dedupe_key, template_key, recipient_type, recipient_id, reservation_id, status)
    VALUES ('nj_resv', 'dk_nj_resv', 'reminder', 'customer', 'c_del', 'r_del', 'succeeded');

    INSERT INTO notification_jobs (id, dedupe_key, template_key, recipient_type, recipient_id, change_request_id, status)
    VALUES ('nj_crq', 'dk_nj_crq', 'change', 'owner', 'owner_recipient', 'crq_del', 'succeeded');

    INSERT INTO notification_logs (id, notification_job_id, template_key, recipient_type, recipient_id, reservation_id, attempt, status, sent_count)
    VALUES ('nl_del', 'nj_resv', 'reminder', 'customer', 'c_del', 'r_del', 1, 'succeeded', 1);

    INSERT INTO calendar_sync_jobs (id, dedupe_key, owner_type, owner_id, google_action, status)
    VALUES ('csj_del', 'dk_csj_del', 'reservation', 'r_del', 'delete', '${syncStatus}');

    INSERT INTO google_calendar_outbound_writes (id, calendar_sync_job_id, dedupe_key, calendar_id, google_event_id, owner_type, owner_id, action, expected_fingerprint, expires_at)
    VALUES ('gow_del', 'csj_del', 'dk_gow_del', 'cal_kyoto', 'gev_del', 'reservation', 'r_del', 'delete', 'fp_del', '2026-05-01T00:00:00Z');

    INSERT INTO google_calendar_events (id, store_id, calendar_id, google_event_id, reservation_id, source_type, status, last_seen_at)
    VALUES ('gce_del', 'kyoto', 'cal_kyoto', 'gev_del', 'r_del', 'reservation', '${eventStatus}', '2026-04-01T00:00:00Z');

    INSERT INTO google_calendar_conflicts (id, store_id, calendar_id, google_event_id, reservation_id, conflict_type, google_safe_snapshot_json, resolution_status)
    VALUES ('gcc_del', 'kyoto', 'cal_kyoto', 'gev_del', 'r_del', 'mismatch', '{}', 'manual_resolved');
  `);
};

const countAll = (db: SqliteD1Database): Record<string, number> => {
  const tables = [
    "customers", "line_identities", "referral_notes", "customer_match_candidates",
    "reservations", "reservation_services", "customer_visits", "consent_records",
    "customer_time_locks", "slot_locks", "reservation_change_requests",
    "notification_jobs", "notification_logs", "calendar_sync_jobs",
    "google_calendar_outbound_writes", "google_calendar_events", "google_calendar_conflicts"
  ];
  const out: Record<string, number> = {};
  for (const t of tables) {
    out[t] = (db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  }
  return out;
};

describe("executeAdminCustomerDelete", () => {
  it("hard-deletes a historical customer and every related row (RESTRICT + CASCADE + no-FK orphans)", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedCustomer(db);
      const before = countAll(db);
      // every seeded table starts non-empty
      for (const [t, n] of Object.entries(before)) expect(n, `${t} seeded`).toBeGreaterThan(0);

      const result = await executeAdminCustomerDelete({ db: asDb(db), admin: OWNER, customerId: "c_del" });
      expect(result).toEqual({
        ok: true,
        removed: { reservations: 1, visits: 1, lineIdentities: 1 }
      });

      const after = countAll(db);
      for (const [t, n] of Object.entries(after)) expect(n, `${t} after delete`).toBe(0);

      const audit = db.sqlite
        .prepare("SELECT action, target_id FROM audit_logs WHERE action = 'customer.delete'")
        .all() as Array<{ action: string; target_id: string }>;
      expect(audit).toEqual([{ action: "customer.delete", target_id: "c_del" }]);
    } finally {
      db.sqlite.close();
    }
  });

  it("deletes the same way when the customer's visit was voided (削除可否は void で変わらない)", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedCustomer(db);
      db.sqlite
        .prepare(
          `UPDATE customer_visits
           SET status = 'voided', voided_by = 'admin_test', voided_at = '2026-04-05T00:00:00Z',
               void_reason = 'reservation_corrected_to_no_show'
           WHERE id = 'v_del'`
        )
        .run();

      const result = await executeAdminCustomerDelete({ db: asDb(db), admin: OWNER, customerId: "c_del" });
      // voided 行も物理削除の対象。件数の数え方も valid と同じ。
      expect(result).toEqual({
        ok: true,
        removed: { reservations: 1, visits: 1, lineIdentities: 1 }
      });
      for (const [t, n] of Object.entries(countAll(db))) expect(n, `${t} after delete`).toBe(0);
    } finally {
      db.sqlite.close();
    }
  });

  it("refuses when an active/upcoming reservation exists (has_active_reservations) — no row removed", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedCustomer(db, { reservationStatus: "confirmed" });
      const before = countAll(db);
      const result = await executeAdminCustomerDelete({ db: asDb(db), admin: OWNER, customerId: "c_del" });
      expect(result).toEqual({ ok: false, reason: "has_active_reservations" });
      expect(countAll(db)).toEqual(before); // atomic guard → nothing deleted
      const audit = db.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action='customer.delete'").get() as { n: number };
      expect(audit.n).toBe(0);
    } finally {
      db.sqlite.close();
    }
  });

  it("refuses when a live Google event exists (has_active_google_events) — no row removed", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedCustomer(db, { googleEventStatus: "active" });
      const before = countAll(db);
      const result = await executeAdminCustomerDelete({ db: asDb(db), admin: OWNER, customerId: "c_del" });
      expect(result).toEqual({ ok: false, reason: "has_active_google_events" });
      expect(countAll(db)).toEqual(before);
    } finally {
      db.sqlite.close();
    }
  });

  it("refuses when a Google sync job is in flight (has_pending_google_sync) — no row removed", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedCustomer(db, { syncStatus: "queued" });
      const before = countAll(db);
      const result = await executeAdminCustomerDelete({ db: asDb(db), admin: OWNER, customerId: "c_del" });
      expect(result).toEqual({ ok: false, reason: "has_pending_google_sync" });
      expect(countAll(db)).toEqual(before);
    } finally {
      db.sqlite.close();
    }
  });

  it("returns not_found for an unknown customer", async () => {
    const db = createMigratedSqliteD1();
    try {
      const result = await executeAdminCustomerDelete({ db: asDb(db), admin: OWNER, customerId: "nope" });
      expect(result).toEqual({ ok: false, reason: "not_found" });
    } finally {
      db.sqlite.close();
    }
  });

  it("forbids staff (owner / system_admin only)", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedCustomer(db);
      const result = await executeAdminCustomerDelete({ db: asDb(db), admin: STAFF, customerId: "c_del" });
      expect(result).toEqual({ ok: false, reason: "forbidden" });
      // staff gate is first → nothing touched
      expect((db.sqlite.prepare("SELECT COUNT(*) AS n FROM customers WHERE id='c_del'").get() as { n: number }).n).toBe(1);
    } finally {
      db.sqlite.close();
    }
  });

  it("a concurrent reservation INSERT after delete fails with a FK error (no orphan possible)", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedCustomer(db);
      await executeAdminCustomerDelete({ db: asDb(db), admin: OWNER, customerId: "c_del" });
      // customers row is gone; reservations.customer_id REFERENCES customers
      // ON DELETE RESTRICT → inserting against the deleted id must throw.
      expect(() =>
        db.sqlite
          .prepare(
            `INSERT INTO reservations (id, store_id, service_id, customer_id, resource_id, source, status, duration_minutes, idempotency_key, start_at, end_at)
             VALUES ('r_race', 'kyoto', 'service_kyoto_default_60', 'c_del', 'resource_kyoto_calendar', 'web_line', 'confirmed', 60, 'ik_race', '2026-04-10T10:00:00Z', '2026-04-10T11:00:00Z')`
          )
          .run()
      ).toThrow(/FOREIGN KEY/i);
    } finally {
      db.sqlite.close();
    }
  });

  it("refuses (integrity_conflict) when ANOTHER customer's visit references the target's reservation — fail-closed, no collateral delete", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedCustomer(db);
      // A second customer whose visit row points at c_del's reservation (a
      // schema-valid but app-invariant-violating anomaly). Deleting c_del by
      // reservation_id would destroy c_other's data, so the step-0 guard must
      // refuse with integrity_conflict and leave EVERYTHING intact.
      // customer_visits.reservation_id is UNIQUE, so re-point r_del's single
      // visit to c_other (replacing the seed's c_del visit) to form the anomaly.
      db.sqlite.exec(`
        INSERT INTO customers (id, display_name, block_status) VALUES ('c_other', '他 顧客', 'active');
        DELETE FROM customer_visits WHERE id='v_del';
        INSERT INTO customer_visits (id, customer_id, reservation_id, store_id, visited_at, visit_source, status, recorded_by)
        VALUES ('v_anom', 'c_other', 'r_del', 'kyoto', '2026-04-01', 'reservation_completed', 'valid', 'admin_test');
      `);
      const before = countAll(db);

      const result = await executeAdminCustomerDelete({ db: asDb(db), admin: OWNER, customerId: "c_del" });
      expect(result).toEqual({ ok: false, reason: "integrity_conflict" });
      // nothing deleted — target customer + the other customer's visit intact
      expect(countAll(db)).toEqual(before);
      expect((db.sqlite.prepare("SELECT COUNT(*) AS n FROM customers WHERE id='c_other'").get() as { n: number }).n).toBe(1);
      expect((db.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action='customer.delete'").get() as { n: number }).n).toBe(0);
    } finally {
      db.sqlite.close();
    }
  });

  it("refuses (integrity_conflict) when another customer's time-lock references the target's reservation", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedCustomer(db);
      db.sqlite.exec(`
        INSERT INTO customers (id, display_name, block_status) VALUES ('c_other', '他 顧客', 'active');
        INSERT INTO customer_time_locks (id, customer_id, slot_at, owner_type, owner_id, lock_status, expires_at)
        VALUES ('ctl_anom', 'c_other', '2026-04-01T10:00:00Z', 'reservation', 'r_del', 'confirmed', NULL);
      `);
      const before = countAll(db);
      const result = await executeAdminCustomerDelete({ db: asDb(db), admin: OWNER, customerId: "c_del" });
      expect(result).toEqual({ ok: false, reason: "integrity_conflict" });
      expect(countAll(db)).toEqual(before);
    } finally {
      db.sqlite.close();
    }
  });

  // ── Reverse-direction anomalies: the target's OWN row references ANOTHER
  // owner's entity. Symmetric fail-closed must catch these too. ──
  it("refuses (integrity_conflict) when the target's visit references another customer's reservation (reverse)", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedCustomer(db);
      // another customer + their reservation; then a c_del visit pointing at it
      db.sqlite.exec(`
        INSERT INTO customers (id, display_name, block_status) VALUES ('c_other', '他 顧客', 'active');
        INSERT INTO reservations (id, store_id, service_id, customer_id, resource_id, source, status, duration_minutes, idempotency_key, start_at, end_at)
        VALUES ('r_other', 'kyoto', 'service_kyoto_default_60', 'c_other', 'resource_kyoto_calendar', 'web_line', 'completed', 60, 'ik_r_other', '2026-04-02T10:00:00Z', '2026-04-02T11:00:00Z');
        INSERT INTO customer_visits (id, customer_id, reservation_id, store_id, visited_at, visit_source, status, recorded_by)
        VALUES ('v_rev', 'c_del', 'r_other', 'kyoto', '2026-04-02', 'reservation_completed', 'valid', 'admin_test');
      `);
      const before = countAll(db);
      const result = await executeAdminCustomerDelete({ db: asDb(db), admin: OWNER, customerId: "c_del" });
      expect(result).toEqual({ ok: false, reason: "integrity_conflict" });
      expect(countAll(db)).toEqual(before);
    } finally {
      db.sqlite.close();
    }
  });

  it("refuses (integrity_conflict) when the target's time-lock owner_id points to a non-target reservation (reverse)", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedCustomer(db);
      db.sqlite.exec(`
        INSERT INTO customer_time_locks (id, customer_id, slot_at, owner_type, owner_id, lock_status, expires_at)
        VALUES ('ctl_rev', 'c_del', '2026-04-09T10:00:00Z', 'reservation', 'r_not_target', 'confirmed', NULL);
      `);
      const before = countAll(db);
      const result = await executeAdminCustomerDelete({ db: asDb(db), admin: OWNER, customerId: "c_del" });
      expect(result).toEqual({ ok: false, reason: "integrity_conflict" });
      expect(countAll(db)).toEqual(before);
    } finally {
      db.sqlite.close();
    }
  });

  it("refuses (integrity_conflict) when the target's outbound write links a non-target sync job (reverse)", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedCustomer(db);
      // a sync job owned by some other reservation (owner_id has no FK), then a
      // c_del-reservation outbound write linking it.
      db.sqlite.exec(`
        INSERT INTO calendar_sync_jobs (id, dedupe_key, owner_type, owner_id, google_action, status)
        VALUES ('csj_other', 'dk_csj_other', 'reservation', 'r_not_target', 'delete', 'succeeded');
        INSERT INTO google_calendar_outbound_writes (id, calendar_sync_job_id, dedupe_key, calendar_id, google_event_id, owner_type, owner_id, action, expected_fingerprint, expires_at)
        VALUES ('gow_rev', 'csj_other', 'dk_gow_rev', 'cal_kyoto', 'gev_rev', 'reservation', 'r_del', 'delete', 'fp_rev', '2026-05-01T00:00:00Z');
      `);
      const before = countAll(db);
      const result = await executeAdminCustomerDelete({ db: asDb(db), admin: OWNER, customerId: "c_del" });
      expect(result).toEqual({ ok: false, reason: "integrity_conflict" });
      expect(countAll(db)).toEqual(before);
    } finally {
      db.sqlite.close();
    }
  });

  it("refuses (integrity_conflict) when an outbound write links the target's sync job but owns a different reservation", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedCustomer(db);
      // outbound write whose calendar_sync_job_id IS the target's sync job
      // (csj_del) but whose owner_id is a different reservation → narrowing
      // alone wouldn't delete it, and the step-3 sync-job delete would SET NULL
      // its calendar_sync_job_id. Fail-closed instead.
      db.sqlite.exec(`
        INSERT INTO google_calendar_outbound_writes (id, calendar_sync_job_id, dedupe_key, calendar_id, google_event_id, owner_type, owner_id, action, expected_fingerprint, expires_at)
        VALUES ('gow_anom', 'csj_del', 'dk_gow_anom', 'cal_kyoto', 'gev_other', 'reservation', 'r_other', 'delete', 'fp_anom', '2026-05-01T00:00:00Z');
      `);
      const before = countAll(db);
      const result = await executeAdminCustomerDelete({ db: asDb(db), admin: OWNER, customerId: "c_del" });
      expect(result).toEqual({ ok: false, reason: "integrity_conflict" });
      expect(countAll(db)).toEqual(before);
    } finally {
      db.sqlite.close();
    }
  });

  it("refuses (integrity_conflict) when a change-request's customer_id mismatches its reservation owner", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedCustomer(db);
      // change-request labeled another customer but pointing at c_del's reservation
      db.sqlite.exec(`
        INSERT INTO customers (id, display_name, block_status) VALUES ('c_other', '他 顧客', 'active');
        INSERT INTO reservation_change_requests (id, reservation_id, customer_id, request_type, status, reservation_version_at_request, current_start_at, current_end_at)
        VALUES ('crq_anom', 'r_del', 'c_other', 'cancel', 'pending', 1, '2026-04-01T10:00:00Z', '2026-04-01T11:00:00Z');
      `);
      const before = countAll(db);
      const result = await executeAdminCustomerDelete({ db: asDb(db), admin: OWNER, customerId: "c_del" });
      expect(result).toEqual({ ok: false, reason: "integrity_conflict" });
      expect(countAll(db)).toEqual(before);
    } finally {
      db.sqlite.close();
    }
  });

  it("refuses (integrity_conflict) when a consent record's customer_id mismatches its reservation owner", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedCustomer(db);
      db.sqlite.exec(`
        INSERT INTO customers (id, display_name, block_status) VALUES ('c_other', '他 顧客', 'active');
        INSERT INTO consent_records (id, customer_id, reservation_id, consent_type, version, consented_at)
        VALUES ('cons_anom', 'c_other', 'r_del', 'privacy_policy', 'v1', '2026-03-01T00:00:00Z');
      `);
      const before = countAll(db);
      const result = await executeAdminCustomerDelete({ db: asDb(db), admin: OWNER, customerId: "c_del" });
      expect(result).toEqual({ ok: false, reason: "integrity_conflict" });
      expect(countAll(db)).toEqual(before);
    } finally {
      db.sqlite.close();
    }
  });

  it("refuses (integrity_conflict) when another customer's reservation references the target's line identity", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedCustomer(db);
      // another customer's reservation pointing at c_del's line identity li_del
      db.sqlite.exec(`
        INSERT INTO customers (id, display_name, block_status) VALUES ('c_other', '他 顧客', 'active');
        INSERT INTO reservations (id, store_id, service_id, customer_id, resource_id, line_identity_id, source, status, duration_minutes, idempotency_key, start_at, end_at)
        VALUES ('r_other_li', 'kyoto', 'service_kyoto_default_60', 'c_other', 'resource_kyoto_calendar', 'li_del', 'web_line', 'completed', 60, 'ik_r_other_li', '2026-04-03T10:00:00Z', '2026-04-03T11:00:00Z');
      `);
      const before = countAll(db);
      const result = await executeAdminCustomerDelete({ db: asDb(db), admin: OWNER, customerId: "c_del" });
      expect(result).toEqual({ ok: false, reason: "integrity_conflict" });
      expect(countAll(db)).toEqual(before);
    } finally {
      db.sqlite.close();
    }
  });

  it("refuses (integrity_conflict) when the target is the canonical of a previous merge (dangling merged_into_id)", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedCustomer(db);
      // a tombstone merged INTO c_del → merged_into_id has no FK, so deleting
      // c_del would leave it dangling. Refuse.
      db.sqlite.exec(`
        INSERT INTO customers (id, display_name, block_status, merged_into_id) VALUES ('c_tomb', '統合元', 'blocked', 'c_del');
      `);
      const before = countAll(db);
      const result = await executeAdminCustomerDelete({ db: asDb(db), admin: OWNER, customerId: "c_del" });
      expect(result).toEqual({ ok: false, reason: "integrity_conflict" });
      expect(countAll(db)).toEqual(before);
    } finally {
      db.sqlite.close();
    }
  });

  it("refuses (has_open_google_conflicts) when a target reservation has an unresolved Google conflict", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedCustomer(db, { /* default historical, but flip the conflict to open */ });
      db.sqlite.exec(`UPDATE google_calendar_conflicts SET resolution_status = 'open' WHERE id = 'gcc_del';`);
      const before = countAll(db);
      const result = await executeAdminCustomerDelete({ db: asDb(db), admin: OWNER, customerId: "c_del" });
      expect(result).toEqual({ ok: false, reason: "has_open_google_conflicts" });
      expect(countAll(db)).toEqual(before);
    } finally {
      db.sqlite.close();
    }
  });

  // ── Round-2 guards (bot follow-up) ──
  it("refuses (integrity_conflict) when a change-request references the target's line identity but is owned by another customer", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedCustomer(db);
      db.sqlite.exec(`
        INSERT INTO customers (id, display_name, block_status) VALUES ('c_other', '他 顧客', 'active');
        INSERT INTO reservations (id, store_id, service_id, customer_id, resource_id, source, status, duration_minutes, idempotency_key, start_at, end_at)
        VALUES ('r_other_cr', 'kyoto', 'service_kyoto_default_60', 'c_other', 'resource_kyoto_calendar', 'web_line', 'completed', 60, 'ik_r_other_cr', '2026-04-05T10:00:00Z', '2026-04-05T11:00:00Z');
        INSERT INTO reservation_change_requests (id, reservation_id, customer_id, line_identity_id, request_type, status, reservation_version_at_request, current_start_at, current_end_at)
        VALUES ('crq_li', 'r_other_cr', 'c_other', 'li_del', 'cancel', 'pending', 1, '2026-04-05T10:00:00Z', '2026-04-05T11:00:00Z');
      `);
      const before = countAll(db);
      const result = await executeAdminCustomerDelete({ db: asDb(db), admin: OWNER, customerId: "c_del" });
      expect(result).toEqual({ ok: false, reason: "integrity_conflict" });
      expect(countAll(db)).toEqual(before);
    } finally {
      db.sqlite.close();
    }
  });

  it.each(["active", "conflict", "ignored"])(
    "refuses (has_active_google_events) when a target Google event is non-terminal (%s)",
    async (status) => {
      const db = createMigratedSqliteD1();
      try {
        seedCustomer(db, { googleEventStatus: status });
        const before = countAll(db);
        const result = await executeAdminCustomerDelete({ db: asDb(db), admin: OWNER, customerId: "c_del" });
        expect(result).toEqual({ ok: false, reason: "has_active_google_events" });
        expect(countAll(db)).toEqual(before);
      } finally {
        db.sqlite.close();
      }
    }
  );

  it("refuses (has_pending_notifications) when a LINE notification job is in flight (processing)", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedCustomer(db);
      db.sqlite.exec(`UPDATE notification_jobs SET status = 'processing' WHERE id = 'nj_resv';`);
      const before = countAll(db);
      const result = await executeAdminCustomerDelete({ db: asDb(db), admin: OWNER, customerId: "c_del" });
      expect(result).toEqual({ ok: false, reason: "has_pending_notifications" });
      expect(countAll(db)).toEqual(before);
    } finally {
      db.sqlite.close();
    }
  });
});
