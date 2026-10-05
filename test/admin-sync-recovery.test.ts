import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getAdminSyncStatus } from "../src/admin/sync-status";
import { createApp } from "../src/app";
import {
  acknowledgeAdminSyncJob,
  aggregateGoogleConflictsForOwner,
  resolveAdminGoogleConflict,
  retryAdminSyncJob
} from "../src/admin/sync-recovery";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";
import { createAccessJwksFetchMock, createAccessJwtFixture, insertAdminUser as insertAdminUserHelper, type AdminRole } from "./helpers/admin-access";

const TEAM_DOMAIN = "https://team.example.cloudflareaccess.com";
const ACCESS_AUD = "admin-sync-recovery-aud";
const ADMIN_EMAIL = "system-admin@example.com";
const ADMIN_ACCESS_SUBJECT = "access-subject-admin-sync-recovery";
const ACCESS_KEY_ID = "admin-sync-recovery-key-1";

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

const createTestAccessFixture = () =>
  createAccessJwtFixture({
    issuer: TEAM_DOMAIN,
    audience: ACCESS_AUD,
    keyId: ACCESS_KEY_ID,
    claims: { email: ADMIN_EMAIL, sub: ADMIN_ACCESS_SUBJECT }
  });

const createFetchMock = (jwk: ReturnType<typeof createTestAccessFixture>["jwk"]) =>
  createAccessJwksFetchMock(TEAM_DOMAIN, jwk);

const insertAdminUser = (db: SqliteD1Database, role: AdminRole) =>
  insertAdminUserHelper(db, {
    id: "admin_sync_recovery_1",
    email: ADMIN_EMAIL,
    accessSubject: ADMIN_ACCESS_SUBJECT,
    role,
    updatedAt: "2026-05-09T00:00:00.000Z",
  });

const baseEnv = (db: SqliteD1Database): Record<string, unknown> => ({
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  ACCESS_AUD,
  DB: db
});

const adminRequest = (
  db: SqliteD1Database,
  token: string,
  path: string,
  init: RequestInit = {}
) => {
  const app = createApp();
  const headers = new Headers(init.headers);
  headers.set("Cf-Access-Jwt-Assertion", token);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return app.request(path, { ...init, headers }, baseEnv(db));
};

const insertAttentionJobs = (db: SqliteD1Database) => {
  db.sqlite
    .prepare(
      `
        INSERT INTO google_calendar_import_jobs (
          id,
          store_id,
          calendar_id,
          reason,
          status,
          next_run_at,
          attempt_count,
          dedupe_key,
          locked_until,
          last_error,
          updated_at
        ) VALUES (
          'google_import_retry_admin_1',
          'kyoto',
          'calendar-a@example.invalid',
          'manual',
          'dead',
          '2026-05-09T00:00:00.000Z',
          5,
          'google_import_retry_admin_1',
          '2026-05-09T00:30:00.000Z',
          'google-import-dead',
          '2026-05-09T00:00:00.000Z'
        )
      `
    )
    .run();

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
          attempts,
          available_at,
          locked_until,
          last_error,
          updated_at
        ) VALUES (
          'calendar_sync_retry_admin_1',
          'calendar_sync_retry_admin_1',
          'reservation',
          'reservation_retry_admin_1',
          'upsert',
          'failed',
          3,
          '2026-05-09T00:00:00.000Z',
          '2026-05-09T00:30:00.000Z',
          'calendar-sync-failed',
          '2026-05-09T00:00:00.000Z'
        )
      `
    )
    .run();

  db.sqlite
    .prepare(
      `
        INSERT INTO notification_jobs (
          id,
          dedupe_key,
          template_key,
          recipient_type,
          recipient_id,
          status,
          attempts,
          available_at,
          locked_until,
          last_error,
          updated_at
        ) VALUES (
          'notification_retry_admin_1',
          'notification_retry_admin_1',
          'reservation_confirmed',
          'customer',
          'line_user_retry_admin_1',
          'retryable',
          2,
          '2026-05-09T00:00:00.000Z',
          '2026-05-09T00:30:00.000Z',
          'line-retryable',
          '2026-05-09T00:00:00.000Z'
        )
      `
    )
    .run();
};

const insertOpenConflicts = (db: SqliteD1Database) => {
  db.sqlite
    .prepare(
      `
        INSERT INTO google_calendar_conflicts (
          id,
          store_id,
          calendar_id,
          google_event_id,
          conflict_type,
          google_safe_snapshot_json,
          resolution_status,
          created_at
        ) VALUES
          (
            'conflict_ignore_admin_1',
            'kyoto',
            'calendar-a@example.invalid',
            'google_event_ignore_admin_1',
            'google_all_day_event',
            '{"kind":"safe","event":"ignore"}',
            'open',
            '2026-05-09T00:00:00.000Z'
          ),
          (
            'conflict_manual_admin_1',
            'kyoto',
            'calendar-a@example.invalid',
            'google_event_manual_admin_1',
            'reservation_event_deleted',
            '{"kind":"safe","event":"manual"}',
            'open',
            '2026-05-09T00:01:00.000Z'
          )
      `
    )
    .run();
};

describe("admin sync recovery API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lets system_admin retry attention jobs with idempotency and audit logs", async () => {
    const db = createMigratedSqliteD1();
    const access = createTestAccessFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "system_admin");
      insertAttentionJobs(db);
      // A dead full-walk job can carry a resume checkpoint; an admin retry
      // starts a NEW walk, so the retry must wipe it (stale pageToken/timeMin
      // would be rejected by Google and a stale yield budget would dead-letter
      // the fresh walk early).
      db.sqlite
        .prepare(
          `UPDATE google_calendar_import_jobs
           SET resume_page_token = 'pt_stale',
               resume_processed_count = 42,
               resume_sweep_start_seconds = 1700000000,
               resume_time_min = '2026-04-01T00:00:00.000Z',
               resume_yield_count = 9
           WHERE id = 'google_import_retry_admin_1'`
        )
        .run();

      const jobs = [
        {
          idempotencyKey: "retry-google-import-admin-1",
          source: "google_calendar_import_jobs",
          jobId: "google_import_retry_admin_1"
        },
        {
          idempotencyKey: "retry-calendar-sync-admin-1",
          source: "calendar_sync_jobs",
          jobId: "calendar_sync_retry_admin_1"
        },
        {
          idempotencyKey: "retry-notification-admin-1",
          source: "notification_jobs",
          jobId: "notification_retry_admin_1"
        }
      ];

      for (const job of jobs) {
        const response = await adminRequest(db, access.token, "/api/admin/sync/jobs/retry", {
          method: "POST",
          body: JSON.stringify(job)
        });
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
          ok: true,
          source: job.source,
          jobId: job.jobId,
          status: "queued",
          replayed: false
        });
      }

      const replay = await adminRequest(db, access.token, "/api/admin/sync/jobs/retry", {
        method: "POST",
        body: JSON.stringify(jobs[0])
      });
      expect(replay.status).toBe(200);
      await expect(replay.json()).resolves.toMatchObject({
        ok: true,
        source: "google_calendar_import_jobs",
        jobId: "google_import_retry_admin_1",
        status: "queued",
        replayed: true
      });

      const state = db.sqlite
        .prepare(
          `
            SELECT
              (SELECT status FROM google_calendar_import_jobs WHERE id = 'google_import_retry_admin_1') AS googleImportStatus,
              (SELECT attempt_count FROM google_calendar_import_jobs WHERE id = 'google_import_retry_admin_1') AS googleImportAttemptCount,
              (SELECT last_error FROM google_calendar_import_jobs WHERE id = 'google_import_retry_admin_1') AS googleImportLastError,
              (SELECT resume_page_token FROM google_calendar_import_jobs WHERE id = 'google_import_retry_admin_1') AS googleImportResumeToken,
              (SELECT resume_processed_count + resume_yield_count FROM google_calendar_import_jobs WHERE id = 'google_import_retry_admin_1') AS googleImportResumeCounters,
              (SELECT status FROM calendar_sync_jobs WHERE id = 'calendar_sync_retry_admin_1') AS calendarSyncStatus,
              (SELECT attempts FROM calendar_sync_jobs WHERE id = 'calendar_sync_retry_admin_1') AS calendarSyncAttempts,
              (SELECT last_error FROM calendar_sync_jobs WHERE id = 'calendar_sync_retry_admin_1') AS calendarSyncLastError,
              (SELECT status FROM notification_jobs WHERE id = 'notification_retry_admin_1') AS notificationStatus,
              (SELECT attempts FROM notification_jobs WHERE id = 'notification_retry_admin_1') AS notificationAttempts,
              (SELECT last_error FROM notification_jobs WHERE id = 'notification_retry_admin_1') AS notificationLastError,
              (SELECT COUNT(*) FROM audit_logs WHERE action = 'admin_sync_job_retry_queued') AS auditCount
          `
        )
        .get() as {
        googleImportStatus: string;
        googleImportAttemptCount: number;
        googleImportLastError: string | null;
        googleImportResumeToken: string | null;
        googleImportResumeCounters: number;
        calendarSyncStatus: string;
        calendarSyncAttempts: number;
        calendarSyncLastError: string | null;
        notificationStatus: string;
        notificationAttempts: number;
        notificationLastError: string | null;
        auditCount: number;
      };
      expect(state).toEqual({
        googleImportStatus: "queued",
        // fixture was attempt_count=5 / attempts=3 / attempts=2; admin retry must
        // zero them or the next processing pass re-hits MAX and dead-letters again
        googleImportAttemptCount: 0,
        googleImportLastError: null,
        googleImportResumeToken: null,
        googleImportResumeCounters: 0,
        calendarSyncStatus: "queued",
        calendarSyncAttempts: 0,
        calendarSyncLastError: null,
        notificationStatus: "queued",
        notificationAttempts: 0,
        notificationLastError: null,
        auditCount: 3
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("refuses to retry retired change_request_* notification jobs (guard against eternal queued)", async () => {
    const db = createMigratedSqliteD1();
    const access = createTestAccessFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "system_admin");
      // 廃止 template の歴史 dead 行。requeue すると新 worker は claim せず永久滞留する
      // ため、retry は not_found で拒否され status は dead のまま残る。
      db.sqlite
        .prepare(
          `INSERT INTO notification_jobs (
             id, dedupe_key, template_key, recipient_type, recipient_id,
             status, attempts, available_at, last_error, updated_at
           ) VALUES (
             'notification_retired_cr_1', 'notification_retired_cr_1',
             'change_request_received', 'owner', 'line_user_owner_1',
             'dead', 5, '2026-07-31T00:00:00.000Z', 'line-http-429', '2026-07-31T00:00:00.000Z'
           )`
        )
        .run();

      const response = await adminRequest(db, access.token, "/api/admin/sync/jobs/retry", {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey: "retry-retired-cr-1",
          source: "notification_jobs",
          jobId: "notification_retired_cr_1"
        })
      });
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({ ok: false, reason: "not_found" });

      const row = db.sqlite
        .prepare("SELECT status, last_error FROM notification_jobs WHERE id = 'notification_retired_cr_1'")
        .get() as { status: string; last_error: string | null };
      expect(row).toEqual({ status: "dead", last_error: "line-http-429" });
    } finally {
      db.sqlite.close();
    }
  });

  it("lets system_admin acknowledge dead sync jobs without retrying them", async () => {
    const db = createMigratedSqliteD1();

    try {
      insertAdminUser(db, "system_admin");
      insertAttentionJobs(db);

      const result = await acknowledgeAdminSyncJob({
        db: db as unknown as D1Database,
        admin: {
          id: "admin_sync_recovery_1",
          email: ADMIN_EMAIL,
          role: "system_admin",
          staff_member_id: null,
          store_id: null
        },
        request: {
          idempotencyKey: "ack-google-import-dead-admin-1",
          source: "google_calendar_import_jobs",
          jobId: "google_import_retry_admin_1",
          note: "Superseded by a newer active channel sync."
        },
        now: () => Date.parse("2026-05-09T01:00:00.000Z")
      });

      expect(result).toMatchObject({
        ok: true,
        action: "acknowledge_job",
        source: "google_calendar_import_jobs",
        jobId: "google_import_retry_admin_1",
        status: "succeeded",
        replayed: false
      });

      const state = db.sqlite
        .prepare(
          `
            SELECT
              (SELECT status FROM google_calendar_import_jobs WHERE id = 'google_import_retry_admin_1') AS jobStatus,
              (SELECT locked_until FROM google_calendar_import_jobs WHERE id = 'google_import_retry_admin_1') AS lockedUntil,
              (SELECT last_error FROM google_calendar_import_jobs WHERE id = 'google_import_retry_admin_1') AS lastError,
              (SELECT COUNT(*) FROM audit_logs WHERE action = 'admin_sync_job_acknowledged') AS auditCount,
              (SELECT metadata_json FROM audit_logs WHERE action = 'admin_sync_job_acknowledged' LIMIT 1) AS metadataJson
          `
        )
        .get() as {
        jobStatus: string;
        lockedUntil: string | null;
        lastError: string | null;
        auditCount: number;
        metadataJson: string;
      };
      expect(state.jobStatus).toBe("succeeded");
      expect(state.lockedUntil).toBeNull();
      expect(state.lastError).toBeNull();
      expect(state.auditCount).toBe(1);
      expect(JSON.parse(state.metadataJson)).toEqual({
        source: "google_calendar_import_jobs",
        previousStatus: "dead",
        previousLastError: "google-import-dead",
        adminRole: "system_admin",
        note: "Superseded by a newer active channel sync."
      });

      const replay = await acknowledgeAdminSyncJob({
        db: db as unknown as D1Database,
        admin: {
          id: "admin_sync_recovery_1",
          email: ADMIN_EMAIL,
          role: "system_admin",
          staff_member_id: null,
          store_id: null
        },
        request: {
          idempotencyKey: "ack-google-import-dead-admin-1",
          source: "google_calendar_import_jobs",
          jobId: "google_import_retry_admin_1",
          note: "Superseded by a newer active channel sync."
        },
        now: () => Date.parse("2026-05-09T01:00:00.000Z")
      });
      expect(replay).toMatchObject({
        ok: true,
        action: "acknowledge_job",
        status: "succeeded",
        replayed: true
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects acknowledgement for non-dead sync jobs", async () => {
    const db = createMigratedSqliteD1();

    try {
      insertAdminUser(db, "system_admin");
      insertAttentionJobs(db);
      db.sqlite
        .prepare(
          `
            UPDATE google_calendar_import_jobs
            SET status = 'failed'
            WHERE id = 'google_import_retry_admin_1'
          `
        )
        .run();

      const result = await acknowledgeAdminSyncJob({
        db: db as unknown as D1Database,
        admin: {
          id: "admin_sync_recovery_1",
          email: ADMIN_EMAIL,
          role: "system_admin",
          staff_member_id: null,
          store_id: null
        },
        request: {
          idempotencyKey: "ack-google-import-failed-admin-1",
          source: "google_calendar_import_jobs",
          jobId: "google_import_retry_admin_1",
          note: "This failed job still needs retry."
        },
        now: () => Date.parse("2026-05-09T01:00:00.000Z")
      });

      expect(result).toEqual({
        ok: false,
        reason: "invalid_transition"
      });
      const state = db.sqlite
        .prepare(
          `
            SELECT
              (SELECT status FROM google_calendar_import_jobs WHERE id = 'google_import_retry_admin_1') AS jobStatus,
              (SELECT COUNT(*) FROM audit_logs WHERE action = 'admin_sync_job_acknowledged') AS auditCount
          `
        )
        .get() as { jobStatus: string; auditCount: number };
      expect(state).toEqual({
        jobStatus: "failed",
        auditCount: 0
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("does not write acknowledge audit logs when a concurrent transition wins first", async () => {
    const db = createMigratedSqliteD1();

    try {
      insertAdminUser(db, "system_admin");
      insertAttentionJobs(db);

      const racedDb = {
        prepare: db.prepare.bind(db),
        batch: async (statements: D1PreparedStatement[]) => {
          db.sqlite
            .prepare(
              `
                UPDATE google_calendar_import_jobs
                SET status = 'succeeded'
                WHERE id = 'google_import_retry_admin_1'
              `
            )
            .run();
          return db.batch(statements);
        }
      } as unknown as D1Database;

      const result = await acknowledgeAdminSyncJob({
        db: racedDb,
        admin: {
          id: "admin_sync_recovery_1",
          email: ADMIN_EMAIL,
          role: "system_admin",
          staff_member_id: null,
          store_id: null
        },
        request: {
          idempotencyKey: "ack-google-import-raced-admin-1",
          source: "google_calendar_import_jobs",
          jobId: "google_import_retry_admin_1",
          note: "Another admin acknowledged this first."
        },
        now: () => Date.parse("2026-05-09T01:00:00.000Z")
      });

      expect(result).toEqual({
        ok: false,
        reason: "write_failed"
      });
      const state = db.sqlite
        .prepare(
          `
            SELECT
              (SELECT status FROM google_calendar_import_jobs WHERE id = 'google_import_retry_admin_1') AS jobStatus,
              (SELECT COUNT(*) FROM audit_logs WHERE action = 'admin_sync_job_acknowledged') AS auditCount
          `
        )
        .get() as { jobStatus: string; auditCount: number };
      expect(state).toEqual({
        jobStatus: "succeeded",
        auditCount: 0
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("exposes a route for system_admin sync job acknowledgement", async () => {
    const db = createMigratedSqliteD1();
    const access = createTestAccessFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "system_admin");
      insertAttentionJobs(db);

      const response = await adminRequest(db, access.token, "/api/admin/sync/jobs/acknowledge", {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey: "ack-route-google-import-dead-admin-1",
          source: "google_calendar_import_jobs",
          jobId: "google_import_retry_admin_1",
          note: "Superseded by active channel sync."
        })
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        action: "acknowledge_job",
        source: "google_calendar_import_jobs",
        jobId: "google_import_retry_admin_1",
        status: "succeeded",
        replayed: false
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("lets system_admin retry expired processing jobs that need attention", async () => {
    const db = createMigratedSqliteD1();

    try {
      insertAdminUser(db, "system_admin");
      db.sqlite
        .prepare(
          `
            INSERT INTO notification_jobs (
              id,
              dedupe_key,
              template_key,
              recipient_type,
              recipient_id,
              status,
              attempts,
              available_at,
              locked_until,
              last_error,
              updated_at
            ) VALUES (
              'notification_processing_expired_retry_admin_1',
              'notification_processing_expired_retry_admin_1',
              'reservation_confirmed',
              'customer',
              'line_user_retry_admin_1',
              'processing',
              3,
              '2026-05-09T00:00:00.000Z',
              '2026-05-09T00:30:00.000Z',
              'line-worker-crashed',
              '2026-05-09T00:00:00.000Z'
            )
          `
        )
        .run();

      const result = await retryAdminSyncJob({
        db: db as unknown as D1Database,
        admin: {
          id: "admin_sync_recovery_1",
          email: ADMIN_EMAIL,
          role: "system_admin",
  staff_member_id: null,
        store_id: null
        },
        request: {
          idempotencyKey: "retry-expired-processing-notification-admin-1",
          source: "notification_jobs",
          jobId: "notification_processing_expired_retry_admin_1"
        },
        now: () => Date.parse("2026-05-09T01:00:00.000Z")
      });

      expect(result).toMatchObject({
        ok: true,
        source: "notification_jobs",
        jobId: "notification_processing_expired_retry_admin_1",
        status: "queued",
        replayed: false
      });
      const state = db.sqlite
        .prepare(
          `
            SELECT status, available_at, locked_until, last_error
            FROM notification_jobs
            WHERE id = 'notification_processing_expired_retry_admin_1'
          `
        )
        .get() as {
        status: string;
        available_at: string;
        locked_until: string | null;
        last_error: string | null;
      };
      expect(state).toEqual({
        status: "queued",
        available_at: "2026-05-09T01:00:00.000Z",
        locked_until: null,
        last_error: null
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("does not mark a retry idempotency key succeeded when the target job changes first", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "system_admin");
      insertAttentionJobs(db);
      const racingDb = {
        prepare(sql: string) {
          return (db as unknown as D1Database).prepare(sql);
        },
        batch(statements: D1PreparedStatement[]) {
          db.sqlite
            .prepare(
              `
                UPDATE calendar_sync_jobs
                SET status = 'processing',
                    locked_until = '2026-05-09T01:30:00.000Z',
                    updated_at = '2026-05-09T00:59:59.999Z'
                WHERE id = 'calendar_sync_retry_admin_1'
              `
            )
            .run();
          return db.batch(statements);
        }
      } as unknown as D1Database;

      const result = await retryAdminSyncJob({
        db: racingDb,
        admin: {
          id: "admin_sync_recovery_1",
          email: ADMIN_EMAIL,
          role: "system_admin",
  staff_member_id: null,
        store_id: null
        },
        request: {
          idempotencyKey: "retry-calendar-sync-race-1",
          source: "calendar_sync_jobs",
          jobId: "calendar_sync_retry_admin_1"
        },
        now: () => Date.parse("2026-05-09T01:00:00.000Z")
      });

      expect(result).toEqual({
        ok: false,
        reason: "write_failed"
      });
      const state = db.sqlite
        .prepare(
          `
            SELECT
              (SELECT status FROM calendar_sync_jobs WHERE id = 'calendar_sync_retry_admin_1') AS jobStatus,
              (SELECT COUNT(*) FROM audit_logs WHERE action = 'admin_sync_job_retry_queued') AS auditCount,
              (SELECT COUNT(*) FROM idempotency_keys WHERE idempotency_key = 'retry-calendar-sync-race-1') AS idempotencyCount
          `
        )
        .get() as { jobStatus: string; auditCount: number; idempotencyCount: number };
      expect(state).toEqual({
        jobStatus: "processing",
        auditCount: 0,
        idempotencyCount: 0
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("maps a retry idempotency insert race to in progress without retrying the job", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "system_admin");
      insertAttentionJobs(db);
      const requestHash = sha256Hex(
        JSON.stringify({
          action: "admin_sync_job_retry",
          source: "calendar_sync_jobs",
          jobId: "calendar_sync_retry_admin_1"
        })
      );
      let injectedRace = false;
      const racingDb = {
        prepare(sql: string) {
          return (db as unknown as D1Database).prepare(sql);
        },
        batch(statements: D1PreparedStatement[]) {
          if (!injectedRace) {
            injectedRace = true;
            db.sqlite
              .prepare(
                `
                  INSERT INTO idempotency_keys (
                    id,
                    scope,
                    idempotency_key,
                    status,
                    request_hash,
                    expires_at
                  ) VALUES (
                    'retry_peer_idempotency_1',
                    'admin_action',
                    'retry-calendar-sync-idempotency-race-1',
                    'started',
                    ?,
                    '2026-05-10T01:00:00.000Z'
                  )
                `
              )
              .run(requestHash);
          }
          return db.batch(statements);
        }
      } as unknown as D1Database;

      const result = await retryAdminSyncJob({
        db: racingDb,
        admin: {
          id: "admin_sync_recovery_1",
          email: ADMIN_EMAIL,
          role: "system_admin",
  staff_member_id: null,
        store_id: null
        },
        request: {
          idempotencyKey: "retry-calendar-sync-idempotency-race-1",
          source: "calendar_sync_jobs",
          jobId: "calendar_sync_retry_admin_1"
        },
        now: () => Date.parse("2026-05-09T01:00:00.000Z")
      });

      expect(result).toEqual({
        ok: false,
        reason: "idempotency_in_progress"
      });
      const state = db.sqlite
        .prepare(
          `
            SELECT
              (SELECT status FROM calendar_sync_jobs WHERE id = 'calendar_sync_retry_admin_1') AS jobStatus,
              (SELECT COUNT(*) FROM audit_logs WHERE action = 'admin_sync_job_retry_queued') AS auditCount
          `
        )
        .get() as { jobStatus: string; auditCount: number };
      expect(state).toEqual({
        jobStatus: "failed",
        auditCount: 0
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("lets system_admin ignore or manually resolve open Google conflicts", async () => {
    const db = createMigratedSqliteD1();
    const access = createTestAccessFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "system_admin");
      insertOpenConflicts(db);

      const ignore = await adminRequest(db, access.token, "/api/admin/sync/conflicts/conflict_ignore_admin_1/ignore", {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey: "ignore-conflict-admin-1",
          note: "確認済み"
        })
      });
      expect(ignore.status).toBe(200);
      await expect(ignore.json()).resolves.toMatchObject({
        ok: true,
        conflictId: "conflict_ignore_admin_1",
        resolutionStatus: "ignored",
        replayed: false
      });

      const manual = await adminRequest(
        db,
        access.token,
        "/api/admin/sync/conflicts/conflict_manual_admin_1/manual-resolve",
        {
          method: "POST",
          body: JSON.stringify({
            idempotencyKey: "manual-conflict-admin-1"
          })
        }
      );
      expect(manual.status).toBe(200);
      await expect(manual.json()).resolves.toMatchObject({
        ok: true,
        conflictId: "conflict_manual_admin_1",
        resolutionStatus: "manual_resolved",
        replayed: false
      });

      const replay = await adminRequest(db, access.token, "/api/admin/sync/conflicts/conflict_ignore_admin_1/ignore", {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey: "ignore-conflict-admin-1",
          note: "確認済み"
        })
      });
      expect(replay.status).toBe(200);
      await expect(replay.json()).resolves.toMatchObject({
        ok: true,
        conflictId: "conflict_ignore_admin_1",
        resolutionStatus: "ignored",
        replayed: true
      });

      const rows = db.sqlite
        .prepare(
          `
            SELECT id, resolution_status, resolved_by
            FROM google_calendar_conflicts
            ORDER BY id
          `
        )
        .all() as Array<{ id: string; resolution_status: string; resolved_by: string | null }>;
      expect(rows).toEqual([
        {
          id: "conflict_ignore_admin_1",
          resolution_status: "ignored",
          resolved_by: "admin_sync_recovery_1"
        },
        {
          id: "conflict_manual_admin_1",
          resolution_status: "manual_resolved",
          resolved_by: "admin_sync_recovery_1"
        }
      ]);

      const auditCount = db.sqlite
        .prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action LIKE 'admin_google_conflict_%'")
        .get() as { count: number };
      expect(auditCount.count).toBe(2);
    } finally {
      db.sqlite.close();
    }
  });

  it("does not mark conflict resolution succeeded when the conflict closes first", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "system_admin");
      insertOpenConflicts(db);
      const racingDb = {
        prepare(sql: string) {
          return (db as unknown as D1Database).prepare(sql);
        },
        batch(statements: D1PreparedStatement[]) {
          db.sqlite
            .prepare(
              `
                UPDATE google_calendar_conflicts
                SET resolution_status = 'auto_reverted',
                    resolved_at = '2026-05-09T00:59:59.999Z',
                    resolved_by = 'calendar_import'
                WHERE id = 'conflict_ignore_admin_1'
              `
            )
            .run();
          return db.batch(statements);
        }
      } as unknown as D1Database;

      const result = await resolveAdminGoogleConflict({
        db: racingDb,
        admin: {
          id: "admin_sync_recovery_1",
          email: ADMIN_EMAIL,
          role: "system_admin",
  staff_member_id: null,
        store_id: null
        },
        conflictId: "conflict_ignore_admin_1",
        resolutionStatus: "ignored",
        request: {
          idempotencyKey: "ignore-conflict-race-1"
        },
        now: () => Date.parse("2026-05-09T01:00:00.000Z")
      });

      expect(result).toEqual({
        ok: false,
        reason: "write_failed"
      });
      const state = db.sqlite
        .prepare(
          `
            SELECT
              (SELECT resolution_status FROM google_calendar_conflicts WHERE id = 'conflict_ignore_admin_1') AS resolutionStatus,
              (SELECT COUNT(*) FROM audit_logs WHERE action = 'admin_google_conflict_ignored') AS auditCount,
              (SELECT COUNT(*) FROM idempotency_keys WHERE idempotency_key = 'ignore-conflict-race-1') AS idempotencyCount
          `
        )
        .get() as { resolutionStatus: string; auditCount: number; idempotencyCount: number };
      expect(state).toEqual({
        resolutionStatus: "auto_reverted",
        auditCount: 0,
        idempotencyCount: 0
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("maps a conflict resolution idempotency insert race to in progress without resolving the conflict", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "system_admin");
      insertOpenConflicts(db);
      const requestHash = sha256Hex(
        JSON.stringify({
          action: "admin_google_conflict_resolution",
          conflictId: "conflict_ignore_admin_1",
          resolutionStatus: "ignored",
          note: null,
          cancelExternalBlock: false
        })
      );
      let injectedRace = false;
      const racingDb = {
        prepare(sql: string) {
          return (db as unknown as D1Database).prepare(sql);
        },
        batch(statements: D1PreparedStatement[]) {
          if (!injectedRace) {
            injectedRace = true;
            db.sqlite
              .prepare(
                `
                  INSERT INTO idempotency_keys (
                    id,
                    scope,
                    idempotency_key,
                    status,
                    request_hash,
                    expires_at
                  ) VALUES (
                    'conflict_peer_idempotency_1',
                    'admin_action',
                    'ignore-conflict-idempotency-race-1',
                    'started',
                    ?,
                    '2026-05-10T01:00:00.000Z'
                  )
                `
              )
              .run(requestHash);
          }
          return db.batch(statements);
        }
      } as unknown as D1Database;

      const result = await resolveAdminGoogleConflict({
        db: racingDb,
        admin: {
          id: "admin_sync_recovery_1",
          email: ADMIN_EMAIL,
          role: "system_admin",
  staff_member_id: null,
        store_id: null
        },
        conflictId: "conflict_ignore_admin_1",
        resolutionStatus: "ignored",
        request: {
          idempotencyKey: "ignore-conflict-idempotency-race-1"
        },
        now: () => Date.parse("2026-05-09T01:00:00.000Z")
      });

      expect(result).toEqual({
        ok: false,
        reason: "idempotency_in_progress"
      });
      const state = db.sqlite
        .prepare(
          `
            SELECT
              (SELECT resolution_status FROM google_calendar_conflicts WHERE id = 'conflict_ignore_admin_1') AS resolutionStatus,
              (SELECT COUNT(*) FROM audit_logs WHERE action = 'admin_google_conflict_ignored') AS auditCount
          `
        )
        .get() as { resolutionStatus: string; auditCount: number };
      expect(state).toEqual({
        resolutionStatus: "open",
        auditCount: 0
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("forbids owner from raw sync recovery operations", async () => {
    const db = createMigratedSqliteD1();
    const access = createTestAccessFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "owner");
      insertAttentionJobs(db);

      const response = await adminRequest(db, access.token, "/api/admin/sync/jobs/retry", {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey: "owner-retry-forbidden-1",
          source: "google_calendar_import_jobs",
          jobId: "google_import_retry_admin_1"
        })
      });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "forbidden"
      });
    } finally {
      db.sqlite.close();
    }
  });

  describe("aggregateGoogleConflictsForOwner (codex #19)", () => {
    const insertAggregateFixtures = (db: SqliteD1Database) => {
      db.sqlite
        .prepare(
          `
            INSERT INTO google_calendar_conflicts (
              id, store_id, calendar_id, google_event_id,
              reservation_id, external_block_id,
              conflict_type, google_safe_snapshot_json, d1_safe_snapshot_json,
              resolution_status, created_at
            ) VALUES
              -- kyoto: 2 actionable + 1 auto-handled (slot_conflict)
              ('agg_kyo_ext_deleted',  'kyoto', 'calendar-a@example.invalid', 'evt_a', NULL, NULL, 'external_block_event_deleted', '{}', NULL, 'open',    '2026-05-09T00:00:00.000Z'),
              ('agg_kyo_invalid',      'kyoto', 'calendar-a@example.invalid', 'evt_b', NULL, NULL, 'reservation_event_invalid_time','{}', NULL, 'open',    '2026-05-09T00:01:00.000Z'),
              ('agg_kyo_slot_auto',    'kyoto', 'calendar-a@example.invalid', 'evt_c', NULL, NULL, 'slot_conflict',                  '{}', NULL, 'open',    '2026-05-09T00:02:00.000Z'),
              -- osaka: 1 auto-handled only (external_block_too_long)
              ('agg_osa_too_long',     'osaka', 'calendar-b@example.invalid', 'evt_d', NULL, NULL, 'external_block_too_long',        '{}', NULL, 'open',    '2026-05-09T00:03:00.000Z'),
              -- nagoya: 1 resolved (must be excluded)
              ('agg_nag_resolved',     'nagoya', 'calendar-c@example.invalid', 'evt_e', NULL, NULL, 'reservation_event_deleted',    '{}', NULL, 'ignored', '2026-05-09T00:04:00.000Z')
          `
        )
        .run();
    };

    it("returns aggregate counts and excludes resolved rows", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAggregateFixtures(db);
        const result = await aggregateGoogleConflictsForOwner(
          db as unknown as D1Database,
          ["kyoto", "osaka", "nagoya"]
        );
        expect(result.totalConflicts).toBe(4);
        expect(result.totalRequiringAction).toBe(2);
        // perStore is sorted by storeId ascending
        expect(result.perStore).toEqual([
          { storeId: "kyoto", total: 3, actionRequired: 2 },
          { storeId: "osaka", total: 1, actionRequired: 0 }
        ]);
      } finally {
        db.sqlite.close();
      }
    });

    it("returns empty aggregate when storeIds is empty", async () => {
      const db = createMigratedSqliteD1();
      try {
        const result = await aggregateGoogleConflictsForOwner(
          db as unknown as D1Database,
          []
        );
        expect(result).toEqual({
          totalConflicts: 0,
          totalRequiringAction: 0,
          perStore: []
        });
      } finally {
        db.sqlite.close();
      }
    });

    it("scopes counts to the requested storeIds only", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAggregateFixtures(db);
        const kyotoOnly = await aggregateGoogleConflictsForOwner(
          db as unknown as D1Database,
          ["kyoto"]
        );
        expect(kyotoOnly.totalConflicts).toBe(3);
        expect(kyotoOnly.totalRequiringAction).toBe(2);
        expect(kyotoOnly.perStore).toEqual([
          { storeId: "kyoto", total: 3, actionRequired: 2 }
        ]);
      } finally {
        db.sqlite.close();
      }
    });

    it("counts the full open set, not just the most recent 100 rows", async () => {
      const db = createMigratedSqliteD1();
      try {
        // Insert 150 actionable + 30 auto-handled open conflicts in kyoto.
        // A row-listing path capped at LIMIT 100 would miscount this aggregate.
        const statements: string[] = [];
        const params: string[] = [];
        for (let i = 0; i < 150; i++) {
          statements.push("(?, 'kyoto', 'cal', ?, NULL, NULL, 'reservation_event_invalid_time', '{}', NULL, 'open', ?)");
          params.push(`agg_kyo_action_${i}`, `evt_action_${i}`, `2026-05-09T01:${String(i % 60).padStart(2, "0")}:00.000Z`);
        }
        for (let i = 0; i < 30; i++) {
          statements.push("(?, 'kyoto', 'cal', ?, NULL, NULL, 'slot_conflict', '{}', NULL, 'open', ?)");
          params.push(`agg_kyo_auto_${i}`, `evt_auto_${i}`, `2026-05-09T02:${String(i % 60).padStart(2, "0")}:00.000Z`);
        }
        db.sqlite
          .prepare(
            `INSERT INTO google_calendar_conflicts (
              id, store_id, calendar_id, google_event_id,
              reservation_id, external_block_id,
              conflict_type, google_safe_snapshot_json, d1_safe_snapshot_json,
              resolution_status, created_at
            ) VALUES ${statements.join(", ")}`
          )
          .run(...params);

        const result = await aggregateGoogleConflictsForOwner(
          db as unknown as D1Database,
          ["kyoto"]
        );
        // Full open set = 150 + 30 = 180, not capped at 100
        expect(result.totalConflicts).toBe(180);
        expect(result.totalRequiringAction).toBe(150);
        expect(result.perStore).toEqual([
          { storeId: "kyoto", total: 180, actionRequired: 150 }
        ]);
      } finally {
        db.sqlite.close();
      }
    });

    it("does not expose any row-level identifiers or timestamps in the serialized aggregate", async () => {
      const db = createMigratedSqliteD1();
      try {
        insertAggregateFixtures(db);
        const result = await aggregateGoogleConflictsForOwner(
          db as unknown as D1Database,
          ["kyoto", "osaka"]
        );
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain("agg_kyo_ext_deleted");
        expect(serialized).not.toContain("agg_kyo_invalid");
        expect(serialized).not.toContain("agg_osa_too_long");
        expect(serialized).not.toContain("external_block_event_deleted");
        expect(serialized).not.toContain("reservation_event_invalid_time");
        expect(serialized).not.toContain("2026-05-09T00:00:00.000Z");
        expect(serialized).not.toContain("google_event_id");
        expect(serialized).not.toContain("calendar_id");
      } finally {
        db.sqlite.close();
      }
    });
  });
});


describe("notification failure disposition", () => {
  let db: SqliteD1Database;
  const admin = { id: "admin_sync_recovery_1", email: ADMIN_EMAIL, role: "system_admin" as const, staff_member_id: null, store_id: null };
  const request = { idempotencyKey: "ack-notification", source: "notification_jobs" as const, jobId: "notification_retry_admin_1", note: "月間枠超過。再送せず確認済みにします。" };
  const now = () => Date.parse("2026-05-09T01:00:00.000Z");
  beforeEach(() => {
    db = createMigratedSqliteD1();
    insertAdminUser(db, "system_admin");
    insertAttentionJobs(db);
    db.sqlite.prepare("UPDATE notification_jobs SET status = 'dead', last_error = 'line-monthly-quota-exhausted'").run();
    db.sqlite.prepare(`INSERT INTO notification_logs (id, notification_job_id, template_key, recipient_type, recipient_id, attempt, status, error, sent_count)
      VALUES ('failed-log', ?, 'reservation_confirmed', 'customer', 'fixture-recipient', 1, 'failed', 'line-monthly-quota-exhausted', 0)`).run(request.jobId);
  });
  afterEach(() => { db.sqlite.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it.each(["dead", "failed"])("acknowledges %s without changing delivery history and removes only its attention", async (status) => {
    db.sqlite.prepare("UPDATE notification_jobs SET status = ?").run(status);
    const before = db.sqlite.prepare("SELECT * FROM notification_jobs WHERE id = ?").get(request.jobId);
    const beforeLogs = db.sqlite.prepare("SELECT * FROM notification_logs").all();
    const beforeStatus = await getAdminSyncStatus({ db: db as unknown as D1Database, admin, now });
    expect(beforeStatus).toMatchObject({ summary: { lineNotificationJobsNeedingAttention: 1 } });
    const result = await acknowledgeAdminSyncJob({ db: db as unknown as D1Database, admin, request, now });
    expect(result).toMatchObject({ ok: true, action: "acknowledge_job", source: "notification_jobs", status, replayed: false });
    expect(db.sqlite.prepare("SELECT * FROM notification_jobs WHERE id = ?").get(request.jobId)).toEqual(before);
    expect(db.sqlite.prepare("SELECT * FROM notification_logs").all()).toEqual(beforeLogs);
    const replay = await acknowledgeAdminSyncJob({ db: db as unknown as D1Database, admin, request, now });
    expect(replay).toMatchObject({ ok: true, replayed: true, status });
    const audits = db.sqlite.prepare("SELECT actor_id, metadata_json FROM audit_logs WHERE target_type = 'notification_jobs' AND action = 'admin_sync_job_acknowledged'").all();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_id: admin.id });
    expect(JSON.parse((audits[0] as { metadata_json: string }).metadata_json)).toEqual({ source: "notification_jobs", note: request.note, previousStatus: status, adminRole: "system_admin" });
    const afterStatus = await getAdminSyncStatus({ db: db as unknown as D1Database, admin, now });
    expect(afterStatus).toMatchObject({ summary: { lineNotificationJobsNeedingAttention: 0 } });
    if (afterStatus.role === "system_admin") expect(afterStatus.dlq.jobs.some((job) => job.id === request.jobId)).toBe(false);
    expect(await acknowledgeAdminSyncJob({ db: db as unknown as D1Database, admin, request: { ...request, note: "changed" }, now }))
      .toEqual({ ok: false, reason: "idempotency_conflict" });
  });

  it.each(["queued", "processing", "retryable"])("cannot acknowledge a %s notification", async (status) => {
    db.sqlite.prepare("UPDATE notification_jobs SET status = ?").run(status);
    expect(await acknowledgeAdminSyncJob({ db: db as unknown as D1Database, admin, request, now }))
      .toEqual({ ok: false, reason: "invalid_transition" });
  });

  it("rejects manual retries of confirmed monthly quota failures", async () => {
    expect(await retryAdminSyncJob({ db: db as unknown as D1Database, admin, request: { ...request, idempotencyKey: "retry-quota" }, now }))
      .toEqual({ ok: false, reason: "invalid_transition" });
    expect(db.sqlite.prepare("SELECT status FROM notification_jobs WHERE id = ?").get(request.jobId)).toEqual({ status: "dead" });
  });

  it("blocks replay of a former retry after the notification was acknowledged", async () => {
    db.sqlite.prepare("UPDATE notification_jobs SET last_error = 'line-http-503'").run();
    const retryRequest = { ...request, idempotencyKey: "retry-before-ack" };
    expect(await retryAdminSyncJob({ db: db as unknown as D1Database, admin, request: retryRequest, now })).toMatchObject({ ok: true });
    db.sqlite.prepare("UPDATE notification_jobs SET status = 'dead', last_error = 'line-http-503'").run();
    expect(await acknowledgeAdminSyncJob({ db: db as unknown as D1Database, admin, request, now })).toMatchObject({ ok: true });
    expect(await retryAdminSyncJob({ db: db as unknown as D1Database, admin, request: retryRequest, now }))
      .toEqual({ ok: false, reason: "invalid_transition" });
  });

  it.each(["acknowledge", "retry"])("rolls back %s when the competing action wins before the batch", async (action) => {
    db.sqlite.prepare("UPDATE notification_jobs SET last_error = 'line-http-503'").run();
    const racedDb = {
      prepare: db.prepare.bind(db),
      batch: async (statements: D1PreparedStatement[]) => {
        if (action === "acknowledge") {
          db.sqlite.prepare("UPDATE notification_jobs SET status = 'queued'").run();
        } else {
          db.sqlite.prepare("INSERT INTO audit_logs (id, actor_type, action, target_type, target_id) VALUES ('competing-ack', 'system', 'admin_sync_job_acknowledged', 'notification_jobs', ?)").run(request.jobId);
        }
        return db.batch(statements);
      }
    } as unknown as D1Database;
    const result = action === "acknowledge"
      ? await acknowledgeAdminSyncJob({ db: racedDb, admin, request, now })
      : await retryAdminSyncJob({ db: racedDb, admin, request, now });
    expect(result).toEqual({ ok: false, reason: "write_failed" });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency_keys WHERE idempotency_key = ?").get(request.idempotencyKey))
      .toEqual({ count: 0 });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE actor_id = ?").get(admin.id)).toEqual({ count: 0 });
  });

  it.each(["system_admin", "owner", "staff"] as const)("enforces the %s role at the acknowledge API", async (role) => {
    db.sqlite.prepare("UPDATE admin_users SET role = ?").run(role);
    const access = createTestAccessFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));
    const response = await adminRequest(db, access.token, "/api/admin/sync/jobs/acknowledge", { method: "POST", body: JSON.stringify(request) });
    expect(response.status).toBe(role === "system_admin" ? 200 : 403);
  });
});
