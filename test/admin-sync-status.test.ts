import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import type { AdminSyncStatusResult } from "../src/admin/sync-status";
import { createAccessJwksFetchMock, createAccessJwtFixture, insertAdminUser as insertAdminUserHelper, type AdminRole } from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const TEAM_DOMAIN = "https://team.example.cloudflareaccess.com";
const ACCESS_AUD = "admin-access-aud";
const ADMIN_EMAIL = "owner@example.com";
const ADMIN_ACCESS_SUBJECT = "access-subject-sync-status";

const createAdminAccessJwtFixture = (
  claimOverrides: Record<string, unknown> = {},
  keyId = "test-access-key-sync-status"
) =>
  createAccessJwtFixture({
    issuer: TEAM_DOMAIN,
    audience: ACCESS_AUD,
    keyId,
    claims: {
      email: ADMIN_EMAIL,
      sub: ADMIN_ACCESS_SUBJECT,
      ...claimOverrides
    }
  });

const createFetchMock = (jwk: ReturnType<typeof createAdminAccessJwtFixture>["jwk"]) =>
  createAccessJwksFetchMock(TEAM_DOMAIN, jwk);

const baseEnv = (db: SqliteD1Database): Record<string, unknown> => ({
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  ACCESS_AUD,
  DB: db
});

const insertAdminUser = (db: SqliteD1Database, role: AdminRole) => {
  const staffMemberId = role === "system_admin" ? null : "staff_owner_kyoto";
  insertAdminUserHelper(db, {
    id: "admin_sync_status_1",
    email: ADMIN_EMAIL,
    accessSubject: ADMIN_ACCESS_SUBJECT,
    role,
    staffMemberId,
    updatedAt: "2026-05-09T00:00:00.000Z",
  });
};

const insertSyncFixtures = (db: SqliteD1Database) => {
  db.sqlite.exec(`
    INSERT INTO customers (id, display_name)
    VALUES ('customer_sync_status_1', '同期状態テスト顧客');

    INSERT INTO reservations (
      id, store_id, service_id, customer_id, resource_id, source, status,
      start_at, end_at, duration_minutes, idempotency_key
    ) VALUES
      (
        'reservation_sync_status_1', 'kyoto', 'service_kyoto_default_60',
        'customer_sync_status_1', 'resource_kyoto_calendar', 'admin', 'confirmed',
        '2026-06-01T01:00:00.000Z', '2026-06-01T02:00:00.000Z', 60,
        'reservation_sync_status_1'
      ),
      (
        'reservation_sync_status_processing_1', 'kyoto', 'service_kyoto_default_60',
        'customer_sync_status_1', 'resource_kyoto_calendar', 'admin', 'confirmed',
        '2026-06-01T03:00:00.000Z', '2026-06-01T04:00:00.000Z', 60,
        'reservation_sync_status_processing_1'
      );

    INSERT INTO external_blocks (
      id, store_id, resource_id, source, start_at, end_at, status
    ) VALUES (
      'external_block_sync_status_1', 'kyoto', 'resource_kyoto_calendar', 'admin_block',
      '2026-06-01T05:00:00.000Z', '2026-06-01T06:00:00.000Z', 'active'
    );
  `);

  db.sqlite
    .prepare(
      `
        INSERT INTO calendar_auth_connections (
          id,
          store_id,
          provider,
          calendar_id,
          status,
          updated_at
        ) VALUES (
          'calendar_auth_sync_status_1',
          'kyoto',
          'google',
          'calendar-a@example.invalid',
          'active',
          '2026-05-09T00:00:00.000Z'
        )
      `
    )
    .run();

  db.sqlite
    .prepare(
      `
        INSERT INTO google_calendar_channels (
          id,
          store_id,
          calendar_auth_connection_id,
          calendar_id,
          channel_id,
          resource_id,
          channel_token_hash,
          sync_token,
          status,
          expiration_at,
          last_notification_at,
          last_resource_state,
          last_message_number,
          last_incremental_sync_at,
          last_full_reconcile_at,
          updated_at
        ) VALUES (
          'google_channel_sync_status_1',
          'kyoto',
          'calendar_auth_sync_status_1',
          'calendar-a@example.invalid',
          'google_channel_id_sync_status_1',
          'google_resource_sync_status_1',
          'token_hash_not_exposed',
          'sync_token_system_admin_only_1',
          'active',
          -- Future expiration so this active channel is NOT counted as
          -- "needing attention". Kept a fixed far-future date (deterministic)
          -- after the original 2026-06-09 value tipped into the past on
          -- 2026-06-09 and broke the channelsNeedingAttention assertion.
          '2030-06-09T00:00:00.000Z',
          '2026-05-09T00:10:00.000Z',
          'exists',
          '12',
          '2026-05-09T00:10:00.000Z',
          '2026-05-08T00:00:00.000Z',
          '2026-05-09T00:10:00.000Z'
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
          reservation_id,
          status,
          attempts,
          available_at,
          last_error,
          updated_at
        ) VALUES (
          'notification_dead_sync_status_1',
          'notification_dead_sync_status_1',
          'reservation_time_changed',
          'customer',
          'line_user_sync_status_1',
          'reservation_sync_status_1',
          'dead',
          5,
          '2026-05-09T00:00:00.000Z',
          'line-http-429',
          '2026-05-09T00:11:00.000Z'
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
          reservation_id,
          status,
          attempts,
          available_at,
          locked_until,
          last_error,
          updated_at
        ) VALUES (
          'notification_processing_expired_sync_status_1',
          'notification_processing_expired_sync_status_1',
          'reservation_confirmed',
          'customer',
          'line_user_sync_status_1',
          'reservation_sync_status_1',
          'processing',
          3,
          '2026-05-09T00:00:00.000Z',
          '2020-01-01T00:00:00.000Z',
          'line-worker-crashed',
          '2026-05-09T00:19:00.000Z'
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
          reservation_id,
          status,
          attempts,
          available_at,
          last_error,
          updated_at
        ) VALUES (
          'notification_retryable_sync_status_1',
          'notification_retryable_sync_status_1',
          'reservation_reminder',
          'customer',
          'line_user_sync_status_1',
          'reservation_sync_status_1',
          'retryable',
          2,
          '2026-05-09T00:20:00.000Z',
          'line-http-503',
          '2026-05-09T00:16:00.000Z'
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
          last_error,
          updated_at
        ) VALUES (
          'calendar_sync_dead_status_1',
          'calendar_sync_dead_status_1',
          'reservation',
          'reservation_sync_status_1',
          'patch',
          'dead',
          5,
          '2026-05-09T00:00:00.000Z',
          'google-http-500',
          '2026-05-09T00:12:00.000Z'
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
          'calendar_sync_processing_expired_status_1',
          'calendar_sync_processing_expired_status_1',
          'reservation',
          'reservation_sync_status_processing_1',
          'upsert',
          'processing',
          4,
          '2026-05-09T00:00:00.000Z',
          '2020-01-01T00:00:00.000Z',
          'calendar-worker-crashed',
          '2026-05-09T00:19:00.000Z'
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
          last_error,
          updated_at
        ) VALUES (
          'calendar_sync_failed_status_1',
          'calendar_sync_failed_status_1',
          'external_block',
          'external_block_sync_status_1',
          'delete',
          'failed',
          1,
          '2026-05-09T00:00:00.000Z',
          'google-non-retryable-400',
          '2026-05-09T00:17:00.000Z'
        )
      `
    )
    .run();

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
          last_error,
          updated_at
        ) VALUES (
          'google_import_dead_status_1',
          'kyoto',
          'calendar-a@example.invalid',
          'push',
          'dead',
          '2026-05-09T00:00:00.000Z',
          5,
          'google_import_dead_status_1',
          'google-import-http-500',
          '2026-05-09T00:13:00.000Z'
        )
        `
      )
      .run();

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
          'google_import_processing_expired_status_1',
          'kyoto',
          'calendar-a@example.invalid',
          'push',
          'processing',
          '2026-05-09T00:00:00.000Z',
          4,
          'google_import_processing_expired_status_1',
          '2020-01-01T00:00:00.000Z',
          'google-import-worker-crashed',
          '2026-05-09T00:19:30.000Z'
        )
      `
    )
    .run();

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
          last_error,
          updated_at
        ) VALUES (
          'google_import_retryable_status_1',
          'kyoto',
          'calendar-a@example.invalid',
          'manual',
          'retryable',
          '2026-05-09T00:25:00.000Z',
          2,
          'google_import_retryable_status_1',
          'google-import-http-503',
          '2026-05-09T00:18:00.000Z'
        )
      `
    )
    .run();

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
          d1_safe_snapshot_json,
          resolution_status,
          created_at
        ) VALUES (
          'google_conflict_status_1',
          'kyoto',
          'calendar-a@example.invalid',
          'google_event_status_1',
          'invalid_reservation_move',
          '{"kind":"google_edit","result":"auto_reverted"}',
          '{"kind":"reservation","startAt":"2026-06-01T01:00:00.000Z"}',
          'open',
          '2026-05-09T00:14:00.000Z'
        )
      `
    )
    .run();

  db.sqlite
    .prepare(
      `
        INSERT INTO google_calendar_events (
          id,
          store_id,
          calendar_id,
          google_event_id,
          google_etag,
          google_updated_at,
          last_seen_at,
          last_imported_at,
          source_type,
          status,
          google_safe_snapshot_json
        ) VALUES (
          'google_event_status_row_1',
          'kyoto',
          'calendar-a@example.invalid',
          'google_event_status_1',
          'google_etag_system_admin_only_1',
          '2026-05-09T00:15:00.000Z',
          '2026-05-09T00:15:00.000Z',
          '2026-05-09T00:15:00.000Z',
          'unknown',
          'conflict',
          '{"kind":"safe_event","status":"conflict"}'
        )
      `
    )
    .run();
};

const insertOtherStoreAttentionFixtures = (db: SqliteD1Database) => {
  db.sqlite.exec(`
    INSERT INTO customers (id, display_name)
    VALUES ('customer_sync_status_osaka', '他店舗同期状態テスト顧客');

    INSERT INTO reservations (
      id, store_id, service_id, customer_id, resource_id, source, status,
      start_at, end_at, duration_minutes, idempotency_key
    ) VALUES (
      'reservation_sync_status_osaka', 'osaka', 'service_osaka_default_60',
      'customer_sync_status_osaka', 'resource_osaka_calendar', 'admin', 'confirmed',
      '2026-06-01T01:00:00.000Z', '2026-06-01T02:00:00.000Z', 60,
      'reservation_sync_status_osaka'
    );

    INSERT INTO calendar_auth_connections (
      id, store_id, provider, calendar_id, status, updated_at
    ) VALUES (
      'calendar_auth_sync_status_osaka', 'osaka', 'google',
      'calendar-b@example.invalid', 'active', '2026-05-09T00:00:00.000Z'
    );

    INSERT INTO google_calendar_channels (
      id, store_id, calendar_auth_connection_id, calendar_id, channel_id,
      resource_id, channel_token_hash, status, updated_at
    ) VALUES (
      'google_channel_sync_status_osaka', 'osaka', 'calendar_auth_sync_status_osaka',
      'calendar-b@example.invalid', 'google_channel_id_sync_status_osaka',
      'google_resource_sync_status_osaka', 'token_hash_osaka_not_exposed',
      'failed', '2026-05-09T00:00:00.000Z'
    );

    INSERT INTO google_calendar_conflicts (
      id, store_id, calendar_id, google_event_id, conflict_type,
      google_safe_snapshot_json, resolution_status, created_at
    ) VALUES (
      'google_conflict_status_osaka', 'osaka', 'calendar-b@example.invalid',
      'google_event_status_osaka', 'invalid_reservation_move', '{}', 'open',
      '2026-05-09T00:00:00.000Z'
    );

    INSERT INTO google_calendar_import_jobs (
      id, store_id, calendar_id, reason, status, next_run_at, attempt_count,
      dedupe_key, last_error, updated_at
    ) VALUES (
      'google_import_status_osaka', 'osaka', 'calendar-b@example.invalid', 'push',
      'failed', '2026-05-09T00:00:00.000Z', 1, 'google_import_status_osaka',
      'other-store-google-error', '2026-05-09T00:00:00.000Z'
    );

    INSERT INTO calendar_sync_jobs (
      id, dedupe_key, owner_type, owner_id, google_action, status, attempts,
      available_at, last_error, updated_at
    ) VALUES (
      'calendar_sync_status_osaka', 'calendar_sync_status_osaka', 'reservation',
      'reservation_sync_status_osaka', 'patch', 'failed', 1,
      '2026-05-09T00:00:00.000Z', 'other-store-calendar-error',
      '2026-05-09T00:00:00.000Z'
    );

    INSERT INTO notification_jobs (
      id, dedupe_key, template_key, recipient_type, recipient_id, reservation_id,
      status, attempts, available_at, last_error, updated_at
    ) VALUES (
      'notification_status_osaka', 'notification_status_osaka',
      'reservation_confirmed', 'customer', 'line_user_sync_status_osaka',
      'reservation_sync_status_osaka', 'dead', 1, '2026-05-09T00:00:00.000Z',
      'other-store-line-error', '2026-05-09T00:00:00.000Z'
    );
  `);
};

const adminRequest = async (db: SqliteD1Database, token: string, path = "/api/admin/sync/status") => {
  const app = createApp();
  return app.request(
    path,
    {
      headers: {
        "Cf-Access-Jwt-Assertion": token
      }
    },
    baseEnv(db)
  );
};

describe("admin sync status API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows only own-store sync warning counts to staff without raw internals", async () => {
    const db = createMigratedSqliteD1();
    const access = createAdminAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "staff");
      insertSyncFixtures(db);
      insertOtherStoreAttentionFixtures(db);

      const response = await adminRequest(db, access.token);
      const body = await response.json();
      const serialized = JSON.stringify(body);

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("pragma")).toBe("no-cache");
      expect(body).toEqual({
        ok: true,
        role: "staff",
        warnings: [
          {
            kind: "google_edit_error",
            count: 1,
            message: "Google編集エラーがあります。確認してください。"
          },
            {
              kind: "google_sync_attention",
              count: 6,
              message: "Google反映で確認が必要です。管理者に確認してください。"
            },
            {
              kind: "line_notification_error",
              count: 3,
              message: "LINE未達があります。確認してください。"
            }
        ]
      });
      expect(serialized).not.toContain("sync_token_system_admin_only_1");
      expect(serialized).not.toContain("google_etag_system_admin_only_1");
      expect(serialized).not.toContain("lastError");
      expect(serialized).not.toContain("deadJobs");
      expect(serialized).not.toContain("safeSnapshotJson");
      expect(serialized).not.toContain("token_hash_not_exposed");
    } finally {
      db.sqlite.close();
    }
  });

  it("counts own-store NULL-reservation notification jobs and excludes other stores for staff", async () => {
    const db = createMigratedSqliteD1();
    const access = createAdminAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "staff");
      db.sqlite.exec(`
        INSERT INTO notification_jobs (
          id, dedupe_key, template_key, recipient_type, recipient_id,
          status, attempts, available_at, last_error, payload_json, updated_at
        ) VALUES
          (
            'notification_drift_kyoto', 'notification_drift_kyoto',
            'google_drift_alert', 'owner', 'line_owner_kyoto',
            'dead', 1, '2026-05-09T00:00:00.000Z', 'kyoto-drift-alert-failed',
            '{"store_id":"kyoto"}', '2026-05-09T00:00:00.000Z'
          ),
          (
            'notification_drift_osaka', 'notification_drift_osaka',
            'google_drift_alert', 'owner', 'line_owner_osaka',
            'dead', 1, '2026-05-09T00:00:00.000Z', 'osaka-drift-alert-failed',
            '{"store_id":"osaka"}', '2026-05-09T00:00:00.000Z'
          );
      `);

      const response = await adminRequest(db, access.token);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        role: "staff",
        warnings: [
          {
            kind: "line_notification_error",
            count: 1,
            message: "LINE未達があります。確認してください。"
          }
        ]
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("ignores malformed notification payload JSON in staff warning counts", async () => {
    const db = createMigratedSqliteD1();
    const access = createAdminAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "staff");
      db.sqlite.exec(`
        INSERT INTO notification_jobs (
          id, dedupe_key, template_key, recipient_type, recipient_id,
          status, attempts, available_at, last_error, payload_json, updated_at
        ) VALUES (
          'notification_malformed_payload', 'notification_malformed_payload',
          'google_drift_alert', 'owner', 'line_owner_unknown',
          'dead', 1, '2026-05-09T00:00:00.000Z', 'malformed-payload',
          '{not-json', '2026-05-09T00:00:00.000Z'
        );
      `);

      const response = await adminRequest(db, access.token);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        role: "staff",
        warnings: []
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("returns empty warnings for staff without a store_id", async () => {
    const db = createMigratedSqliteD1();
    const access = createAdminAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "staff");
      db.sqlite
        .prepare("UPDATE admin_users SET staff_member_id = NULL WHERE id = 'admin_sync_status_1'")
        .run();
      insertSyncFixtures(db);

      const response = await adminRequest(db, access.token);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        role: "staff",
        warnings: []
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("includes other-store attention counts in the system_admin summary", async () => {
    const db = createMigratedSqliteD1();
    const access = createAdminAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "system_admin");
      insertSyncFixtures(db);
      insertOtherStoreAttentionFixtures(db);

      const response = await adminRequest(db, access.token);
      const body = (await response.json()) as {
        role: string;
        summary: { lineNotificationJobsNeedingAttention: number };
      };

      expect(response.status).toBe(200);
      expect(body.role).toBe("system_admin");
      expect(body.summary.lineNotificationJobsNeedingAttention).toBe(4);
    } finally {
      db.sqlite.close();
    }
  });

  it("does not count intentionally stopped Google channels as needing attention after expiration", async () => {
    const db = createMigratedSqliteD1();
    const access = createAdminAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "system_admin");
      db.sqlite.exec(`
        INSERT INTO calendar_auth_connections (
          id,
          store_id,
          provider,
          calendar_id,
          status,
          updated_at
        ) VALUES (
          'calendar_auth_stopped_channel_1',
          'kyoto',
          'google',
          'calendar-a@example.invalid',
          'active',
          '2026-05-09T00:00:00.000Z'
        );

        INSERT INTO google_calendar_channels (
          id,
          store_id,
          calendar_auth_connection_id,
          calendar_id,
          channel_id,
          resource_id,
          channel_token_hash,
          sync_token,
          status,
          expiration_at,
          updated_at
        ) VALUES (
          'google_channel_stopped_expired_1',
          'kyoto',
          'calendar_auth_stopped_channel_1',
          'calendar-a@example.invalid',
          'google_channel_stopped_expired_1',
          'google_resource_stopped_expired_1',
          'token_hash_stopped_not_exposed',
          'sync_token_stopped_not_attention',
          'stopped',
          '2026-05-08T00:00:00.000Z',
          '2026-05-09T00:00:00.000Z'
        );
      `);

      const response = await adminRequest(db, access.token);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        ok: true,
        summary: {
          channelsNeedingAttention: 0
        },
        channels: [
          {
            id: "google_channel_stopped_expired_1",
            status: "stopped"
          }
        ]
      });
    } finally {
      db.sqlite.close();
    }
  });

  const insertChannelAttentionFixture = (
    db: SqliteD1Database,
    opts: { idSuffix: string; status: string; expirationAt: string }
  ) => {
    db.sqlite.exec(`
      INSERT INTO calendar_auth_connections (
        id,
        store_id,
        provider,
        calendar_id,
        status,
        updated_at
      ) VALUES (
        'calendar_auth_channel_attn_${opts.idSuffix}',
        'kyoto',
        'google',
        'calendar-a@example.invalid',
        'active',
        '2026-06-01T00:00:00.000Z'
      );

      INSERT INTO google_calendar_channels (
        id,
        store_id,
        calendar_auth_connection_id,
        calendar_id,
        channel_id,
        resource_id,
        channel_token_hash,
        status,
        expiration_at,
        updated_at
      ) VALUES (
        'google_channel_attn_${opts.idSuffix}',
        'kyoto',
        'calendar_auth_channel_attn_${opts.idSuffix}',
        'calendar-a@example.invalid',
        'google_channel_attn_${opts.idSuffix}',
        'google_resource_attn_${opts.idSuffix}',
        'token_hash_attn_not_exposed',
        '${opts.status}',
        '${opts.expirationAt}',
        '2026-06-01T00:00:00.000Z'
      );
    `);
  };

  // The warning lead is CHANNEL_RENEWAL_WINDOW_MS / 2 = 12h before expiry, so
  // "counted" is decided purely by where expirationAt sits relative to 12h from
  // the frozen clock (2026-06-01T12:00:00Z).
  it.each([
    {
      label: "expiring in 6h (inside the 12h warning lead)",
      idSuffix: "exp_6h",
      expirationAt: "2026-06-01T18:00:00.000Z",
      expected: 1
    },
    {
      label: "expiring in 20h (still outside the 12h warning lead)",
      idSuffix: "exp_20h",
      expirationAt: "2026-06-02T08:00:00.000Z",
      expected: 0
    },
    {
      label: "already expired",
      idSuffix: "exp_past",
      expirationAt: "2026-06-01T06:00:00.000Z",
      expected: 1
    }
  ])(
    "counts $expected active channel(s) as needing attention when $label",
    async ({ idSuffix, expirationAt, expected }) => {
      // Clock first so JWT iat/exp align with verification time.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-06-01T12:00:00.000Z"));
      const db = createMigratedSqliteD1();
      const access = createAdminAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      try {
        insertAdminUser(db, "system_admin");
        insertChannelAttentionFixture(db, {
          idSuffix,
          status: "active",
          expirationAt
        });

        const response = await adminRequest(db, access.token);
        const body = (await response.json()) as {
          summary: { channelsNeedingAttention: number };
        };

        expect(response.status).toBe(200);
        expect(body.summary.channelsNeedingAttention).toBe(expected);
      } finally {
        vi.useRealTimers();
        db.sqlite.close();
      }
    }
  );
  it("shows owner operational summaries without syncToken etag payload or DLQ internals", async () => {
    const db = createMigratedSqliteD1();
    const access = createAdminAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "owner");
      insertSyncFixtures(db);

      const response = await adminRequest(db, access.token);
      const body = await response.json();
      const serialized = JSON.stringify(body);

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("pragma")).toBe("no-cache");
      expect(body).toEqual({
        ok: true,
        role: "owner",
          summary: {
            openGoogleConflicts: 1,
            googleSyncJobsNeedingAttention: 6,
            lineNotificationJobsNeedingAttention: 3,
            channelsNeedingAttention: 0
          },
        recoveryTasks: [
          {
            kind: "google_edit_conflict",
            count: 1,
            message: "Google編集エラーがあります。予約画面で確認してください。"
          },
            {
              kind: "google_sync_attention_jobs",
              count: 6,
              message: "Google反映で管理者確認が必要な処理があります。"
            },
            {
              kind: "line_notification_attention_jobs",
              count: 3,
              message: "LINE未達の確認が必要です。"
            }
        ],
        conflictAggregate: {
          totalConflicts: 1,
          totalRequiringAction: 1,
          perStore: [
            { storeId: "kyoto", total: 1, actionRequired: 1 }
          ]
        },
        actionableConflicts: []
      });
      expect(serialized).not.toContain("sync_token_system_admin_only_1");
      expect(serialized).not.toContain("google_etag_system_admin_only_1");
      expect(serialized).not.toContain("lastError");
      expect(serialized).not.toContain("dlq");
      expect(serialized).not.toContain("safeSnapshotJson");
      expect(serialized).not.toContain("token_hash_not_exposed");
      // codex #19 — row-level conflict identifiers / timestamps must not leak in owner response
      expect(serialized).not.toContain("google_conflict_status_1");
      expect(serialized).not.toContain("invalid_reservation_move");
      expect(serialized).not.toContain("2026-05-09T00:14:00.000Z");
      expect(serialized).not.toContain("ownerConflictSummaries");
    } finally {
      db.sqlite.close();
    }
  });

  it.each([
    { binding: "linked", ownFixtures: true, expected: { openGoogleConflicts: 1, googleSyncJobsNeedingAttention: 6, lineNotificationJobsNeedingAttention: 3, channelsNeedingAttention: 0 }, taskCounts: [1, 6, 3] },
    { binding: "linked", ownFixtures: false, expected: { openGoogleConflicts: 0, googleSyncJobsNeedingAttention: 0, lineNotificationJobsNeedingAttention: 0, channelsNeedingAttention: 0 }, taskCounts: [] },
    { binding: "unbound", ownFixtures: true, expected: { openGoogleConflicts: 2, googleSyncJobsNeedingAttention: 8, lineNotificationJobsNeedingAttention: 4, channelsNeedingAttention: 1 }, taskCounts: [2, 9, 4] },
    { binding: "inactive", ownFixtures: true, expected: { openGoogleConflicts: 0, googleSyncJobsNeedingAttention: 0, lineNotificationJobsNeedingAttention: 0, channelsNeedingAttention: 0 }, taskCounts: [] },
  ])("scopes every owner attention count for $binding (own fixtures: $ownFixtures)", async ({ binding, ownFixtures, expected, taskCounts }) => {
    const db = createMigratedSqliteD1();
    const access = createAdminAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));
    try {
      insertAdminUser(db, "owner");
      if (binding === "unbound") {
        db.sqlite.exec("UPDATE admin_users SET staff_member_id = NULL WHERE id = 'admin_sync_status_1'");
      } else if (binding === "inactive") {
        db.sqlite.exec("UPDATE staff_members SET active = 0 WHERE id = 'staff_owner_kyoto'");
      }
      if (ownFixtures) insertSyncFixtures(db);
      insertOtherStoreAttentionFixtures(db);

      const response = await adminRequest(db, access.token);
      const body = await response.json() as Extract<AdminSyncStatusResult, { role: "owner" }>;

      expect(response.status).toBe(200);
      expect(body.summary).toEqual(expected);
      expect(body.recoveryTasks.map((task) => task.count)).toEqual(taskCounts);
      expect(body.conflictAggregate.totalConflicts).toBe(expected.openGoogleConflicts);
      expect(body).not.toHaveProperty("channels");
      expect(body).not.toHaveProperty("dlq");
    } finally {
      db.sqlite.close();
    }
  });

  it("exposes only owner-actionable conflict details from the owner's store without provider internals", async () => {
    const db = createMigratedSqliteD1();
    const access = createAdminAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));
    try {
      insertAdminUser(db, "owner");
      insertSyncFixtures(db);
      for (const [id, store, kind] of [["owner_day", "kyoto", "google_all_day_event"], ["other_day", "osaka", "google_all_day_event"], ["owner_deleted", "kyoto", "reservation_event_deleted"]]) {
        db.sqlite.prepare(`INSERT INTO google_calendar_conflicts (id,store_id,calendar_id,google_event_id,conflict_type,google_safe_snapshot_json,resolution_status,created_at)
          VALUES (?,?,'private-calendar','private-event',?,?, 'open','2026-05-09T00:00:00.000Z')`)
          .run(id, store, kind, JSON.stringify({ start_at: "2026-06-01T01:00:00.000Z", end_at: "2026-06-01T02:00:00.000Z", summary: "休業候補", extra: "provider-internal" }));
      }
      // Google's real deletion notification can contain only an ID and status.
      db.sqlite.exec(`UPDATE google_calendar_conflicts SET reservation_id='reservation_sync_status_1', google_safe_snapshot_json='{"status":"cancelled"}' WHERE id='owner_deleted'`);
      const response = await adminRequest(db, access.token);
      const body = await response.json();
      const ownerBody = body as Extract<AdminSyncStatusResult, { role: "owner" }>;
      expect(ownerBody.actionableConflicts.map((item) => item.id).sort()).toEqual(["owner_day", "owner_deleted"]);
      expect(ownerBody.actionableConflicts[0]).toMatchObject({ storeId: "kyoto", startAt: "2026-06-01T01:00:00.000Z", endAt: "2026-06-01T02:00:00.000Z" });
      expect(ownerBody.actionableConflicts.find((item) => item.id === "owner_deleted")).toMatchObject({
        customerDisplayName: "同期状態テスト顧客", storeName: "ExampleStore A",
        startAt: "2026-06-01T01:00:00.000Z", endAt: "2026-06-01T02:00:00.000Z"
      });
      const exposed = JSON.stringify(ownerBody.actionableConflicts);
      for (const value of ["private-calendar", "private-event", "provider-internal", "google_conflict_status_1", "other_day", "googleSafeSnapshotJson"]) expect(exposed).not.toContain(value);
    } finally {
      db.sqlite.close();
    }
  });

  it.each([
    { label: "malformed", snapshot: { start_at: "not-a-date", end_at: "tomorrow" }, expectedStart: null },
    { label: "nonexistent day", snapshot: { start_at: "2026-02-30T01:00:00.000Z", end_at: "2026-03-03T01:00:00.000Z" }, expectedStart: null },
    { label: "reversed", snapshot: { start_at: "2026-06-01T02:00:00.000Z", end_at: "2026-06-01T01:00:00.000Z" }, expectedStart: null },
    { label: "empty", snapshot: { start_at: "2026-06-01T01:00:00.000Z", end_at: "2026-06-01T01:00:00.000Z" }, expectedStart: null },
    { label: "noncanonical", snapshot: { start_at: "2026-06-01T01:00:00Z", end_at: "2026-06-01T02:00:00Z" }, expectedStart: null },
    { label: "legacy all-day", snapshot: { start_date: "2026-06-01", end_date: "2026-06-02" }, expectedStart: "2026-05-31T15:00:00.000Z" }
  ])("validates the owner's $label target before offering a decision", async ({ snapshot, expectedStart }) => {
    const db = createMigratedSqliteD1();
    const access = createAdminAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));
    try {
      insertAdminUser(db, "owner");
      db.sqlite.prepare(`INSERT INTO google_calendar_conflicts
        (id,store_id,calendar_id,google_event_id,conflict_type,google_safe_snapshot_json,resolution_status,created_at)
        VALUES ('owner-range','kyoto','private-calendar','private-event','google_all_day_event',?,'open','2026-05-09T00:00:00.000Z')`)
        .run(JSON.stringify(snapshot));
      const response = await adminRequest(db, access.token);
      expect(response.status).toBe(200);
      const body = await response.json() as Extract<AdminSyncStatusResult, { role: "owner" }>;
      expect(body.actionableConflicts).toHaveLength(1);
      expect(body.actionableConflicts[0].startAt).toBe(expectedStart);
      if (expectedStart === null) expect(body.actionableConflicts[0].endAt).toBeNull();
    } finally {
      db.sqlite.close();
    }
  });

  it.each([
    { binding: "unbound", expectedIds: ["global_day", "global_deleted"], expectedTotal: 3 },
    { binding: "inactive", expectedIds: [], expectedTotal: 0 }
  ])("keeps the existing owner scope for a $binding staff binding", async ({ binding, expectedIds, expectedTotal }) => {
    const db = createMigratedSqliteD1();
    const access = createAdminAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));
    try {
      insertAdminUser(db, "owner");
      if (binding === "unbound") {
        db.sqlite.exec("UPDATE admin_users SET staff_member_id = NULL WHERE id = 'admin_sync_status_1'");
      } else {
        db.sqlite.exec("UPDATE staff_members SET active = 0 WHERE id = 'staff_owner_kyoto'");
      }
      for (const [id, store, kind] of [
        ["global_day", "kyoto", "google_all_day_event"],
        ["global_deleted", "osaka", "reservation_event_deleted"],
        ["global_technical", "osaka", "invalid_reservation_move"]
      ]) {
        db.sqlite.prepare(`INSERT INTO google_calendar_conflicts
          (id,store_id,calendar_id,google_event_id,conflict_type,google_safe_snapshot_json,resolution_status,created_at)
          VALUES (?,?,'private-calendar','private-event',?,?,'open','2026-05-09T00:00:00.000Z')`)
          .run(id, store, kind, JSON.stringify({ start_at: "2026-06-01T01:00:00.000Z", end_at: "2026-06-01T02:00:00.000Z" }));
      }
      const response = await adminRequest(db, access.token);
      expect(response.status).toBe(200);
      const body = await response.json() as Extract<AdminSyncStatusResult, { role: "owner" }>;
      expect(body.actionableConflicts.map((item) => item.id).sort()).toEqual(expectedIds);
      expect(body.summary.openGoogleConflicts).toBe(expectedTotal);
      expect(body.conflictAggregate.totalConflicts).toBe(expectedTotal);
      for (const secret of ["private-calendar", "private-event", "global_technical", "googleSafeSnapshotJson"]) {
        expect(JSON.stringify(body.actionableConflicts)).not.toContain(secret);
      }
    } finally {
      db.sqlite.close();
    }
  });

  it("B5: owner conflict headline is store-scoped — a conflict in another store does not inflate openGoogleConflicts", async () => {
    const db = createMigratedSqliteD1();
    const access = createAdminAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "owner"); // owner manages kyoto (staff_owner_kyoto)
      insertSyncFixtures(db); // seeds 1 open conflict in kyoto
      // An open conflict in a DIFFERENT store the owner does NOT manage. Store-wide
      // there are now 2 open conflicts; the owner view must report only kyoto's 1.
      db.sqlite
        .prepare(
          `
            INSERT INTO google_calendar_conflicts (
              id, store_id, calendar_id, google_event_id, conflict_type,
              google_safe_snapshot_json, d1_safe_snapshot_json, resolution_status, created_at
            ) VALUES (
              'google_conflict_other_store_1', 'osaka', 'osaka@example.com',
              'google_event_other_1', 'invalid_reservation_move',
              '{"kind":"google_edit"}', NULL, 'open', '2026-05-09T00:20:00.000Z'
            )
          `
        )
        .run();

      const response = await adminRequest(db, access.token);
      const body = (await response.json()) as {
        role: string;
        summary: { openGoogleConflicts: number };
        conflictAggregate: {
          totalConflicts: number;
          perStore: Array<{ storeId: string; total: number; actionRequired: number }>;
        };
        recoveryTasks: Array<{ kind: string; count: number }>;
      };

      expect(response.status).toBe(200);
      expect(body.role).toBe("owner");
      // Headline + aggregate are both store-scoped (1, not the store-wide 2).
      expect(body.summary.openGoogleConflicts).toBe(1);
      expect(body.conflictAggregate.totalConflicts).toBe(1);
      expect(body.conflictAggregate.perStore).toEqual([
        { storeId: "kyoto", total: 1, actionRequired: 1 }
      ]);
      // recoveryTasks derives from the same store-scoped summary.
      const conflictTask = body.recoveryTasks.find((t) => t.kind === "google_edit_conflict");
      expect(conflictTask?.count).toBe(1);
    } finally {
      db.sqlite.close();
    }
  });

  it("excludes retired change_request_* templates from attention counts and DLQ details", async () => {
    const db = createMigratedSqliteD1();
    const access = createAdminAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "system_admin");
      insertSyncFixtures(db);
      // キャンセル申請機能の廃止 (2026-08-01) 前に dead 化した歴史行。retry 不能かつ
      // 配信もされないため、attention 件数と DLQ 一覧の両方から見えなくする。
      db.sqlite
        .prepare(
          `INSERT INTO notification_jobs (
             id, dedupe_key, template_key, recipient_type, recipient_id,
             reservation_id, status, attempts, available_at, last_error, updated_at
           ) VALUES (
             'notification_retired_cr_status_1', 'notification_retired_cr_status_1',
             'change_request_approved', 'customer', 'line_user_sync_status_1',
             'reservation_sync_status_1', 'dead', 5,
             '2026-07-31T00:00:00.000Z', 'line-http-429', '2026-07-31T00:00:00.000Z'
           )`
        )
        .run();

      const response = await adminRequest(db, access.token);
      const body = (await response.json()) as {
        summary: { lineNotificationJobsNeedingAttention: number };
        dlq: { jobs: Array<{ id: string }> };
      };

      expect(response.status).toBe(200);
      // 3 = insertSyncFixtures の非廃止 template 3 件のみ。廃止行はカウントされない。
      expect(body.summary.lineNotificationJobsNeedingAttention).toBe(3);
      expect(body.dlq.jobs.map((job) => job.id)).not.toContain("notification_retired_cr_status_1");
    } finally {
      db.sqlite.close();
    }
  });

  it("shows syncToken etag safe payloads and D1 attention job DLQ details to system_admin", async () => {
    const db = createMigratedSqliteD1();
    const access = createAdminAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "system_admin");
      insertSyncFixtures(db);

      const response = await adminRequest(db, access.token);
      const body = await response.json();
      const serialized = JSON.stringify(body);

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("pragma")).toBe("no-cache");
      expect(body).toMatchObject({
        ok: true,
        role: "system_admin",
          summary: {
            openGoogleConflicts: 1,
            googleSyncJobsNeedingAttention: 6,
            lineNotificationJobsNeedingAttention: 3,
            channelsNeedingAttention: 0
          },
        channels: [
          {
            id: "google_channel_sync_status_1",
            storeId: "kyoto",
            calendarId: "calendar-a@example.invalid",
            status: "active",
            syncToken: "sync_token_system_admin_only_1",
            syncTokenPresent: true,
            expirationAt: "2030-06-09T00:00:00.000Z",
            lastMessageNumber: "12"
          }
        ],
        dlq: {
          source: "d1_attention_jobs",
          jobs: expect.arrayContaining([
            expect.objectContaining({
              source: "google_calendar_import_jobs",
              id: "google_import_dead_status_1",
              status: "dead",
              attemptCount: 5,
              lastError: "google-import-http-500"
            }),
            expect.objectContaining({
              source: "calendar_sync_jobs",
              id: "calendar_sync_dead_status_1",
              status: "dead",
              attemptCount: 5,
              lastError: "google-http-500"
            }),
            expect.objectContaining({
              source: "calendar_sync_jobs",
              id: "calendar_sync_failed_status_1",
              status: "failed",
              attemptCount: 1,
              lastError: "google-non-retryable-400"
            }),
              expect.objectContaining({
                source: "google_calendar_import_jobs",
                id: "google_import_retryable_status_1",
                status: "retryable",
                attemptCount: 2,
                lastError: "google-import-http-503"
              }),
              expect.objectContaining({
                source: "google_calendar_import_jobs",
                id: "google_import_processing_expired_status_1",
                status: "processing",
                attemptCount: 4,
                lastError: "google-import-worker-crashed"
              }),
              expect.objectContaining({
                source: "calendar_sync_jobs",
                id: "calendar_sync_processing_expired_status_1",
                status: "processing",
                attemptCount: 4,
                lastError: "calendar-worker-crashed"
              }),
              expect.objectContaining({
                source: "notification_jobs",
                id: "notification_dead_sync_status_1",
                status: "dead",
                attemptCount: 5,
                lastError: "line-http-429"
              }),
            expect.objectContaining({
              source: "notification_jobs",
                id: "notification_retryable_sync_status_1",
                status: "retryable",
                attemptCount: 2,
                lastError: "line-http-503"
              }),
              expect.objectContaining({
                source: "notification_jobs",
                id: "notification_processing_expired_sync_status_1",
                status: "processing",
                attemptCount: 3,
                lastError: "line-worker-crashed"
              })
            ])
        },
        conflicts: [
          expect.objectContaining({
            id: "google_conflict_status_1",
            conflictType: "invalid_reservation_move",
            googleSafeSnapshotJson: '{"kind":"google_edit","result":"auto_reverted"}',
            d1SafeSnapshotJson: '{"kind":"reservation","startAt":"2026-06-01T01:00:00.000Z"}'
          })
        ],
        googleEvents: [
          expect.objectContaining({
            id: "google_event_status_row_1",
            googleEventId: "google_event_status_1",
            googleEtag: "google_etag_system_admin_only_1",
            googleSafeSnapshotJson: '{"kind":"safe_event","status":"conflict"}'
          })
        ]
      });
      expect(serialized).toContain("sync_token_system_admin_only_1");
      expect(serialized).toContain("google_etag_system_admin_only_1");
      expect(serialized).not.toContain("token_hash_not_exposed");
    } finally {
      db.sqlite.close();
    }
  });

  it("returns owner API conflictAggregate counts only (no per-row metadata, codex #19)", async () => {
    const db = createMigratedSqliteD1();
    const access = createAdminAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "owner");
      insertSyncFixtures(db);

      const response = await adminRequest(db, access.token);
      const body = (await response.json()) as {
        role: string;
        conflictAggregate?: {
          totalConflicts: number;
          totalRequiringAction: number;
          perStore: Array<{ storeId: string; total: number; actionRequired: number }>;
        };
        ownerConflictSummaries?: unknown;
      };

      expect(response.status).toBe(200);
      expect(body.role).toBe("owner");

      // The legacy row-level field must be gone entirely
      expect(body.ownerConflictSummaries).toBeUndefined();
      const keys = Object.keys(body as Record<string, unknown>);
      expect(keys).not.toContain("ownerConflictSummaries");

      // conflictAggregate is the only conflict-related shape now
      expect(body.conflictAggregate).toBeDefined();
      expect(body.conflictAggregate).toEqual({
        totalConflicts: 1,
        totalRequiringAction: 1,
        perStore: [{ storeId: "kyoto", total: 1, actionRequired: 1 }]
      });

      // Row-level conflict identifiers, timestamps, snapshot fields, and Google internals
      // must not appear anywhere in the owner JSON body.
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("google_conflict_status_1");
      expect(serialized).not.toContain("invalid_reservation_move");
      expect(serialized).not.toContain("2026-05-09T00:14:00.000Z");
      expect(serialized).not.toContain("google_event_id");
      expect(serialized).not.toContain("google_safe_snapshot_json");
      expect(serialized).not.toContain("d1_safe_snapshot_json");
      expect(serialized).not.toContain("google_etag");
      expect(serialized).not.toContain("sync_token");
    } finally {
      db.sqlite.close();
    }
  });

});
