import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dispatchDailyOpsSummary } from "../src/notifications/daily-ops-summary";
import type { DailyOpsPayload } from "../src/notifications/daily-ops-summary";
import { processDueLineNotificationJobs } from "../src/line/notifications";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

// ── Time anchors ──────────────────────────────────────────────────────
// 20:00 JST = 11:00 UTC (the cron spec). Use a fixed date for deterministic tests.
const NOW_MS = Date.parse("2026-06-15T11:00:00.000Z"); // 20:00 JST

// JST day boundaries for 2026-06-15 JST:
//   JST 00:00 = 2026-06-14T15:00:00.000Z
//   JST 24:00 = 2026-06-15T15:00:00.000Z
// Tomorrow (2026-06-16 JST):
//   JST 00:00 = 2026-06-15T15:00:00.000Z
//   JST 24:00 = 2026-06-16T15:00:00.000Z

const LINE_USER_A = "U00000000000000000000000000000001";
const LINE_USER_B = "U00000000000000000000000000000002";
const OWNER_EMAIL_RECIPIENT_ID = "email:owner";

const STORE_ID = "kyoto";
const CUSTOMER_ID = "customer_ops_1";
const LINE_IDENTITY_ID = "line_identity_ops_1";

const enabledEnv = (userIds?: string) => ({
  DAILY_OPS_SUMMARY_DISPATCH_ENABLED: "true" as const,
  LINE_OPERATIONS_USER_IDS: userIds ?? LINE_USER_A
});

const disabledEnv = () => ({
  DAILY_OPS_SUMMARY_DISPATCH_ENABLED: "false" as const,
  LINE_OPERATIONS_USER_IDS: LINE_USER_A
});

const seedCustomer = (d1: SqliteD1Database) => {
  d1.sqlite
    .prepare(
      `INSERT OR IGNORE INTO customers (id, display_name, display_name_kana, phone_hash, block_status)
       VALUES (?, 'Ops Customer', 'オプスカスタマー', 'hash_ops_1', 'active')`
    )
    .run(CUSTOMER_ID);
};

const seedLineIdentity = (d1: SqliteD1Database) => {
  d1.sqlite
    .prepare(
      `INSERT OR IGNORE INTO line_identities (id, customer_id, provider, channel_id, line_user_id)
       VALUES (?, ?, 'line', 'ch_1', ?)`
    )
    .run(LINE_IDENTITY_ID, CUSTOMER_ID, LINE_USER_A);
};

const seedReservation = (
  d1: SqliteD1Database,
  opts: {
    id: string;
    startAt: string;
    endAt?: string;
    status?: string;
    storeId?: string;
  }
) => {
  const status = opts.status ?? "confirmed";
  const storeId = opts.storeId ?? STORE_ID;
  const endAt = opts.endAt ?? new Date(Date.parse(opts.startAt) + 60 * 60 * 1000).toISOString();
  d1.sqlite
    .prepare(
      `INSERT INTO reservations (
         id, store_id, service_id, customer_id, resource_id, line_identity_id,
         source, status, start_at, end_at, duration_minutes,
         idempotency_key, version
       ) VALUES (?, ?, ?, ?, ?, ?, 'web_line', ?, ?, ?, 60, ?, 1)`
    )
    .run(
      opts.id,
      storeId,
      `service_${storeId}_default_60`,
      CUSTOMER_ID,
      `resource_${storeId}_calendar`,
      LINE_IDENTITY_ID,
      status,
      opts.startAt,
      endAt,
      `idem_${opts.id}`
    );
};

const seedOpenConflict = (d1: SqliteD1Database, id: string) => {
  d1.sqlite
    .prepare(
      `INSERT INTO google_calendar_conflicts (
         id, store_id, calendar_id, google_event_id,
         conflict_type, google_safe_snapshot_json, resolution_status
       ) VALUES (?, ?, 'cal@gmail.com', ?, 'reservation_event_deleted', '{}', 'open')`
    )
    .run(id, STORE_ID, `evt_${id}`);
};

const seedDeadNotificationJob = (d1: SqliteD1Database, id: string, updatedAt: string) => {
  d1.sqlite
    .prepare(
      `INSERT INTO notification_jobs (
         id, dedupe_key, template_key, recipient_type, recipient_id,
         reservation_id, status, attempts, updated_at
       ) VALUES (?, ?, 'reservation_confirmed', 'customer', ?, NULL, 'dead', 5, ?)`
    )
    .run(id, `dead_${id}`, LINE_IDENTITY_ID, updatedAt);
};

const seedDeadCalendarSyncJob = (d1: SqliteD1Database, id: string, updatedAt: string) => {
  d1.sqlite
    .prepare(
      `INSERT INTO calendar_sync_jobs (
         id, dedupe_key, owner_type, owner_id, google_action, status, updated_at
       ) VALUES (?, ?, 'reservation', 'res_x', 'upsert', 'dead', ?)`
    )
    .run(id, `dead_sync_${id}`, updatedAt);
};

const seedMaintenanceRun = (
  d1: SqliteD1Database,
  opts: { taskKey: string; dayBucket: string; completedAt: string }
) => {
  d1.sqlite
    .prepare(
      `INSERT INTO google_calendar_history_maintenance_runs (task_key, day_bucket, completed_at)
       VALUES (?, ?, ?)`
    )
    .run(opts.taskKey, opts.dayBucket, opts.completedAt);
};

const countNotificationJobs = (d1: SqliteD1Database, templateKey: string): number => {
  const row = d1.sqlite
    .prepare("SELECT count(*) AS cnt FROM notification_jobs WHERE template_key = ?")
    .get(templateKey) as { cnt: number };
  return row.cnt;
};

const getNotificationJobDedupeKeys = (d1: SqliteD1Database, templateKey: string): string[] => {
  const rows = d1.sqlite
    .prepare("SELECT dedupe_key FROM notification_jobs WHERE template_key = ? ORDER BY created_at")
    .all(templateKey) as Array<{ dedupe_key: string }>;
  return rows.map((r) => r.dedupe_key);
};

const getNotificationJobPayload = (d1: SqliteD1Database, templateKey: string): DailyOpsPayload | null => {
  const row = d1.sqlite
    .prepare("SELECT payload_json FROM notification_jobs WHERE template_key = ? LIMIT 1")
    .get(templateKey) as { payload_json: string } | undefined;
  if (!row?.payload_json) return null;
  return JSON.parse(row.payload_json) as DailyOpsPayload;
};

// ── Tests ─────────────────────────────────────────────────────────────
describe("daily ops summary dispatch", () => {
  let d1: SqliteD1Database;

  beforeEach(() => {
    d1 = createMigratedSqliteD1();
    seedCustomer(d1);
    seedLineIdentity(d1);
  });

  afterEach(() => {
    d1.sqlite.close();
  });

  // 1. flag-off
  it("returns enqueued=0 when DAILY_OPS_SUMMARY_DISPATCH_ENABLED is false", async () => {
    const result = await dispatchDailyOpsSummary({
      db: d1 as unknown as D1Database,
      env: disabledEnv(),
      nowMs: NOW_MS
    });
    expect(result).toEqual({ enqueued: 0 });
    expect(countNotificationJobs(d1, "daily_ops_summary")).toBe(0);
  });

  // 2. LINE recipients do not gate owner email
  it("enqueues one owner email job when LINE_OPERATIONS_USER_IDS is empty", async () => {
    const result = await dispatchDailyOpsSummary({
      db: d1 as unknown as D1Database,
      env: enabledEnv(""),
      nowMs: NOW_MS
    });
    expect(result).toEqual({ enqueued: 1 });
    expect(countNotificationJobs(d1, "daily_ops_summary")).toBe(1);
  });

  // 3. multiple LINE recipients still produce one email
  it("enqueues one row with multiple LINE operations recipients", async () => {
    const result = await dispatchDailyOpsSummary({
      db: d1 as unknown as D1Database,
      env: enabledEnv(`${LINE_USER_A},${LINE_USER_B}`),
      nowMs: NOW_MS
    });
    expect(result).toEqual({ enqueued: 1 });
    expect(countNotificationJobs(d1, "daily_ops_summary")).toBe(1);
  });

  // 4. dedupe_key idempotency
  it("does not duplicate rows on repeated dispatch for the same JST day", async () => {
    const env = enabledEnv();
    await dispatchDailyOpsSummary({ db: d1 as unknown as D1Database, env, nowMs: NOW_MS });
    // Second dispatch 30 minutes later, same JST day
    const result = await dispatchDailyOpsSummary({
      db: d1 as unknown as D1Database,
      env,
      nowMs: NOW_MS + 30 * 60 * 1000
    });
    expect(result).toEqual({ enqueued: 0 });
    expect(countNotificationJobs(d1, "daily_ops_summary")).toBe(1);
  });

  // 5. email sentinel and dedupe
  it("uses one email sentinel in the daily dedupe key", async () => {
    await dispatchDailyOpsSummary({
      db: d1 as unknown as D1Database,
      env: enabledEnv(`${LINE_USER_A},${LINE_USER_B}`),
      nowMs: NOW_MS
    });
    const keys = getNotificationJobDedupeKeys(d1, "daily_ops_summary");
    expect(keys).toEqual([`daily_ops_summary:2026-06-15:${OWNER_EMAIL_RECIPIENT_ID}`]);
    const row = d1.sqlite
      .prepare("SELECT recipient_id FROM notification_jobs WHERE template_key = 'daily_ops_summary'")
      .get() as { recipient_id: string };
    expect(row.recipient_id).toBe(OWNER_EMAIL_RECIPIENT_ID);
  });

  // 6. JST boundary: 23:59 JST (14:59 UTC) still counts as today
  it("uses correct JST day at 23:59 JST", async () => {
    const lateNowMs = Date.parse("2026-06-15T14:59:00.000Z"); // 23:59 JST on 2026-06-15
    await dispatchDailyOpsSummary({
      db: d1 as unknown as D1Database,
      env: enabledEnv(),
      nowMs: lateNowMs
    });
    const keys = getNotificationJobDedupeKeys(d1, "daily_ops_summary");
    expect(keys[0]).toContain("2026-06-15");
  });

  // 7. JST boundary: 00:01 JST (15:01 UTC previous day) counts as new day
  it("uses correct JST day at 00:01 JST (crosses midnight)", async () => {
    const earlyNowMs = Date.parse("2026-06-15T15:01:00.000Z"); // 00:01 JST on 2026-06-16
    await dispatchDailyOpsSummary({
      db: d1 as unknown as D1Database,
      env: enabledEnv(),
      nowMs: earlyNowMs
    });
    const keys = getNotificationJobDedupeKeys(d1, "daily_ops_summary");
    expect(keys[0]).toContain("2026-06-16");
  });

  // 8. stats: today reservation count
  it("includes correct today and tomorrow reservation counts", async () => {
    // Reservation during JST day 2026-06-15 (UTC: 2026-06-14T15:00 to 2026-06-15T15:00)
    seedReservation(d1, { id: "res_today_1", startAt: "2026-06-14T23:00:00.000Z" }); // 08:00 JST
    seedReservation(d1, { id: "res_today_2", startAt: "2026-06-15T05:00:00.000Z" }); // 14:00 JST
    // Reservation for tomorrow (outside today's range)
    seedReservation(d1, { id: "res_tomorrow_1", startAt: "2026-06-15T23:00:00.000Z" }); // 08:00 JST tomorrow

    await dispatchDailyOpsSummary({
      db: d1 as unknown as D1Database,
      env: enabledEnv(),
      nowMs: NOW_MS
    });

    const payload = getNotificationJobPayload(d1, "daily_ops_summary");
    expect(payload).not.toBeNull();
    const todayTotal = payload!.stats.today_reservations.reduce((s, r) => s + r.count, 0);
    expect(todayTotal).toBe(2);
    const tomorrowTotal = payload!.stats.tomorrow_reservations.reduce((s, r) => s + r.count, 0);
    expect(tomorrowTotal).toBe(1);
  });

  // 9. payload_json contains stats + date_jst
  it("keeps unacknowledged quota failures visible and excludes acknowledged failures", async () => {
    const failedAt = new Date(NOW_MS - 3600_000).toISOString();
    seedDeadNotificationJob(d1, "quota_open", failedAt);
    seedDeadNotificationJob(d1, "quota_ack", failedAt);
    d1.sqlite.prepare("UPDATE notification_jobs SET last_error = 'line-monthly-quota-exhausted' WHERE id IN ('quota_open', 'quota_ack')").run();
    d1.sqlite.prepare(`INSERT INTO audit_logs (id, actor_type, action, target_type, target_id)
      VALUES ('ack_quota', 'system', 'admin_sync_job_acknowledged', 'notification_jobs', 'quota_ack')`).run();
    await dispatchDailyOpsSummary({ db: d1 as unknown as D1Database, env: enabledEnv(), nowMs: NOW_MS });
    expect(getNotificationJobPayload(d1, "daily_ops_summary")!.stats.dead_notification_jobs_24h).toBe(1);
    expect(d1.sqlite.prepare("SELECT updated_at FROM notification_jobs WHERE id = 'quota_ack'").get()).toEqual({ updated_at: failedAt });
  });

  it("stores correct payload_json structure with conflict and dead job counts", async () => {
    seedOpenConflict(d1, "conflict_1");
    seedDeadNotificationJob(d1, "dead_notif_1", new Date(NOW_MS - 3600_000).toISOString());
    seedDeadCalendarSyncJob(d1, "dead_sync_1", new Date(NOW_MS - 3600_000).toISOString());

    await dispatchDailyOpsSummary({
      db: d1 as unknown as D1Database,
      env: enabledEnv(),
      nowMs: NOW_MS
    });

    const payload = getNotificationJobPayload(d1, "daily_ops_summary");
    expect(payload).not.toBeNull();
    expect(payload!.date_jst).toBe("2026-06-15");
    expect(payload!.stats.open_conflicts).toBe(1);
    expect(payload!.stats.dead_notification_jobs_24h).toBe(1);
    expect(payload!.stats.dead_calendar_sync_jobs_24h).toBe(1);
    expect(Array.isArray(payload!.stats.today_reservations)).toBe(true);
    expect(Array.isArray(payload!.stats.tomorrow_reservations)).toBe(true);
    expect(payload!.stats.daily_cleanup_last_run_at).toBeNull();
  });

  // 10. does not count cancelled reservations
  it("excludes cancelled reservations from stats", async () => {
    seedReservation(d1, { id: "res_cancelled", startAt: "2026-06-14T23:00:00.000Z", status: "cancelled_by_customer" });
    seedReservation(d1, { id: "res_active", startAt: "2026-06-14T23:00:00.000Z", status: "confirmed" });

    await dispatchDailyOpsSummary({
      db: d1 as unknown as D1Database,
      env: enabledEnv(),
      nowMs: NOW_MS
    });

    const payload = getNotificationJobPayload(d1, "daily_ops_summary");
    const todayTotal = payload!.stats.today_reservations.reduce((s, r) => s + r.count, 0);
    expect(todayTotal).toBe(1);
  });

  // 11. dead jobs outside 24h window are not counted
  it("does not count dead jobs older than 24h", async () => {
    // 25 hours ago
    const oldTime = new Date(NOW_MS - 25 * 3600_000).toISOString();
    seedDeadNotificationJob(d1, "old_dead_1", oldTime);

    await dispatchDailyOpsSummary({
      db: d1 as unknown as D1Database,
      env: enabledEnv(),
      nowMs: NOW_MS
    });

    const payload = getNotificationJobPayload(d1, "daily_ops_summary");
    expect(payload!.stats.dead_notification_jobs_24h).toBe(0);
  });

  // 12. Branch B integration: queued daily_ops_summary is delivered by email
  it("daily_ops_summary job is dispatched by email without LINE", async () => {
    // Enqueue the summary
    await dispatchDailyOpsSummary({
      db: d1 as unknown as D1Database,
      env: enabledEnv(),
      nowMs: NOW_MS
    });
    expect(countNotificationJobs(d1, "daily_ops_summary")).toBe(1);

    const emailSend = vi.fn(async (_message: { to: string; subject: string; text: string }) => ({ messageId: "email_daily" }));
    const fetchMock = vi.fn(async () => Response.json({ sentMessages: [{ id: "unexpected" }] })) as unknown as typeof fetch;

    // Process via the LINE notification dispatcher with Branch B enabled
    const dispatchResult = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: {
        LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "test_token",
        DAILY_OPS_SUMMARY_DISPATCH_ENABLED: "true",
        PENDING_APPROVAL_OWNER_EMAIL: "owner@example.com",
        OPERATIONS_NOTIFICATION_EMAIL: "",
        EMAIL: { send: emailSend } as unknown as SendEmail
      },
      fetcher: fetchMock,
      now: () => NOW_MS + 5000,
      maxJobs: 5
    });

    expect(dispatchResult.processed).toBe(1);
    expect(dispatchResult.succeeded).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(emailSend).toHaveBeenCalledTimes(1);
    expect(emailSend.mock.calls[0]?.[0].to).toBe("owner@example.com");
    expect(emailSend.mock.calls[0]?.[0].subject).toBe("【予約通知】日次サマリー");
    expect(emailSend.mock.calls[0]?.[0].text).toContain("営業日報");

    // Job should be marked succeeded
    const job = d1.sqlite
      .prepare("SELECT status FROM notification_jobs WHERE template_key = 'daily_ops_summary' LIMIT 1")
      .get() as { status: string };
    expect(job.status).toBe("succeeded");
  });

  // ── Auto-complete observability (N / M / K) ──────────────────────
  // NOW_MS = 2026-06-15T11:00:00.000Z = 20:00 JST.
  // Morning sweep cutoff = 01:05 JST today − 48h = 2026-06-12T16:05:00.000Z.
  // `nowMs − 48h` (= 2026-06-13T11:00:00.000Z) is the wrong M bound: a
  // healthy sweep still leaves those rows confirmed (still in grace).
  const SWEEP_CUTOFF_ISO = "2026-06-12T16:05:00.000Z";
  const WRONG_TWENTY_HUNDRED_MINUS_GRACE_ISO = "2026-06-13T11:00:00.000Z";
  const OSAKA_STORE_ID = "osaka";

  const EMPTY_AUTOCOMPLETE_SUMMARY = [
    "📊 2026-06-15 営業日報",
    "",
    "【本日の予約】なし",
    "",
    "【明日の予約】なし",
    "",
    "【終了済み・完了待ちの予約】なし",
    "",
    "【猶予期限切れで未処理の予約】なし",
    "",
    "自動完了（手動補完を含む）: 0 件",
    "日次クリーンアップ（01:05 JST）: 実行済み 01:05"
  ].join("\n");

  const MISSING_DAILY_CLEANUP_SUMMARY = [
    "📊 2026-06-15 営業日報",
    "",
    "【本日の予約】なし",
    "",
    "【明日の予約】なし",
    "",
    "【終了済み・完了待ちの予約】なし",
    "",
    "【猶予期限切れで未処理の予約】なし",
    "",
    "自動完了（手動補完を含む）: 0 件",
    "日次クリーンアップ（01:05 JST）: 記録なし",
    "",
    "【注意事項】",
    "  ⚠️ 日次クリーンアップが前夜に実行された記録がありません"
  ].join("\n");

  const seedAutoCompleteAudit = (
    target: SqliteD1Database,
    opts: { id: string; createdAt: string; action?: string }
  ) => {
    target.sqlite
      .prepare(
        `INSERT INTO audit_logs (
           id, actor_type, actor_id, action, target_type, target_id, metadata_json, created_at
         ) VALUES (?, 'system', 'system', ?, 'reservation', ?, '{}', ?)`
      )
      .run(opts.id, opts.action ?? "system_reservation_auto_completed", opts.id, opts.createdAt);
  };

  const renderQueuedDailyOpsEmail = async (target: SqliteD1Database): Promise<string> => {
    const emailSend = vi.fn(async (_message: { to: string; subject: string; text: string }) => ({
      messageId: "email_daily"
    }));
    const fetchMock = vi.fn(async () =>
      Response.json({ sentMessages: [{ id: "unexpected" }] })
    ) as unknown as typeof fetch;
    const dispatchResult = await processDueLineNotificationJobs({
      db: target as unknown as D1Database,
      env: {
        LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "test_token",
        DAILY_OPS_SUMMARY_DISPATCH_ENABLED: "true",
        PENDING_APPROVAL_OWNER_EMAIL: "owner@example.com",
        OPERATIONS_NOTIFICATION_EMAIL: "",
        EMAIL: { send: emailSend } as unknown as SendEmail
      },
      fetcher: fetchMock,
      now: () => NOW_MS + 5000,
      maxJobs: 5
    });
    expect(dispatchResult.succeeded).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    return emailSend.mock.calls[0]?.[0].text ?? "";
  };

  const dispatchAndRenderDailyOpsEmail = async (target: SqliteD1Database): Promise<string> => {
    await dispatchDailyOpsSummary({
      db: target as unknown as D1Database,
      env: enabledEnv(),
      nowMs: NOW_MS
    });
    return renderQueuedDailyOpsEmail(target);
  };

  describe("auto-complete observability in the daily ops summary", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW_MS);
      seedMaintenanceRun(d1, {
        taskKey: "retention_sweep_phase1_completed",
        dayBucket: "2026-06-14",
        completedAt: "2026-06-14T16:05:00.000Z"
      });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("renders N/M as なし and K as 0 件 when nothing applies", async () => {
      const text = await dispatchAndRenderDailyOpsEmail(d1);
      expect(text).toBe(EMPTY_AUTOCOMPLETE_SUMMARY);
    });

    it("renders N as a single store line when one store has ended-but-confirmed reservations", async () => {
      seedReservation(d1, {
        id: "res_n_kyoto_1",
        startAt: "2026-06-14T09:00:00.000Z",
        endAt: "2026-06-14T10:00:00.000Z"
      });

      const text = await dispatchAndRenderDailyOpsEmail(d1);
      expect(text).toBe(
        [
          "📊 2026-06-15 営業日報",
          "",
          "【本日の予約】なし",
          "",
          "【明日の予約】なし",
          "",
          "【終了済み・完了待ちの予約】",
          "  ExampleStore A: 1件",
          "",
          "【猶予期限切れで未処理の予約】なし",
          "",
          "自動完了（手動補完を含む）: 0 件",
          "日次クリーンアップ（01:05 JST）: 実行済み 01:05"
        ].join("\n")
      );
    });

    it("renders N with one line per store, ordered by store name", async () => {
      seedReservation(d1, {
        id: "res_n_kyoto_a",
        startAt: "2026-06-14T07:00:00.000Z",
        endAt: "2026-06-14T08:00:00.000Z"
      });
      seedReservation(d1, {
        id: "res_n_kyoto_b",
        startAt: "2026-06-14T08:00:00.000Z",
        endAt: "2026-06-14T09:00:00.000Z"
      });
      seedReservation(d1, {
        id: "res_n_osaka_1",
        startAt: "2026-06-14T07:30:00.000Z",
        endAt: "2026-06-14T08:30:00.000Z",
        storeId: OSAKA_STORE_ID
      });

      const text = await dispatchAndRenderDailyOpsEmail(d1);
      expect(text).toBe(
        [
          "📊 2026-06-15 営業日報",
          "",
          "【本日の予約】なし",
          "",
          "【明日の予約】なし",
          "",
          "【終了済み・完了待ちの予約】",
          "  ExampleStore A: 2件",
          "  ExampleStore B: 1件",
          "",
          "【猶予期限切れで未処理の予約】なし",
          "",
          "自動完了（手動補完を含む）: 0 件",
          "日次クリーンアップ（01:05 JST）: 実行済み 01:05"
        ].join("\n")
      );
    });

    it("includes M at the sweep cutoff and excludes the instant after it", async () => {
      seedReservation(d1, {
        id: "res_m_on_cutoff",
        startAt: "2026-06-12T15:05:00.000Z",
        endAt: SWEEP_CUTOFF_ISO
      });
      seedReservation(d1, {
        id: "res_m_after_cutoff",
        startAt: "2026-06-12T15:05:00.001Z",
        endAt: "2026-06-12T16:05:00.001Z"
      });

      const text = await dispatchAndRenderDailyOpsEmail(d1);
      expect(text).toBe(
        [
          "📊 2026-06-15 営業日報",
          "",
          "【本日の予約】なし",
          "",
          "【明日の予約】なし",
          "",
          "【終了済み・完了待ちの予約】",
          "  ExampleStore A: 2件",
          "",
          "【猶予期限切れで未処理の予約】",
          "  ExampleStore A: 1件",
          "",
          "自動完了（手動補完を含む）: 0 件",
          "日次クリーンアップ（01:05 JST）: 実行済み 01:05"
        ].join("\n")
      );
    });

    it("renders M as なし on a healthy night (in-grace row that 20:00−48h would flag)", async () => {
      // end_at sits after this morning's real cutoff but on the 20:00−48h
      // bound. The sweep correctly left it confirmed (still in grace); using
      // `nowMs - 48h` as M would page the owner every night.
      const endAt = WRONG_TWENTY_HUNDRED_MINUS_GRACE_ISO;

      seedReservation(d1, {
        id: "res_m_in_grace",
        startAt: "2026-06-13T10:00:00.000Z",
        endAt
      });

      const text = await dispatchAndRenderDailyOpsEmail(d1);
      expect(text).toBe(
        [
          "📊 2026-06-15 営業日報",
          "",
          "【本日の予約】なし",
          "",
          "【明日の予約】なし",
          "",
          "【終了済み・完了待ちの予約】",
          "  ExampleStore A: 1件",
          "",
          "【猶予期限切れで未処理の予約】なし",
          "",
          "自動完了（手動補完を含む）: 0 件",
          "日次クリーンアップ（01:05 JST）: 実行済み 01:05"
        ].join("\n")
      );
    });

    it("counts K from both CURRENT_TIMESTAMP and ISO audit rows in the JST day window", async () => {
      // JST day start 2026-06-15 = 2026-06-14T15:00:00.000Z.
      // Space-separated at the bound is dropped by lexical >= ISO because
      // ' ' < 'T'; datetime() must keep it.
      seedAutoCompleteAudit(d1, { id: "audit_space_in", createdAt: "2026-06-14 15:00:00" });
      seedAutoCompleteAudit(d1, { id: "audit_iso_in", createdAt: "2026-06-15T02:00:00.000Z" });
      seedAutoCompleteAudit(d1, { id: "audit_space_before", createdAt: "2026-06-14 14:59:59" });
      seedAutoCompleteAudit(d1, { id: "audit_iso_before", createdAt: "2026-06-14T14:59:59.000Z" });
      seedAutoCompleteAudit(d1, {
        id: "audit_other_action",
        createdAt: "2026-06-14 16:00:00",
        action: "reservation_completed"
      });

      const text = await dispatchAndRenderDailyOpsEmail(d1);
      expect(text).toBe(
        [
          "📊 2026-06-15 営業日報",
          "",
          "【本日の予約】なし",
          "",
          "【明日の予約】なし",
          "",
          "【終了済み・完了待ちの予約】なし",
          "",
          "【猶予期限切れで未処理の予約】なし",
          "",
          "自動完了（手動補完を含む）: 2 件",
          "日次クリーンアップ（01:05 JST）: 実行済み 01:05"
        ].join("\n")
      );
    });

    it("renders N/M as なし and K as 0 件 for a pre-field payload", async () => {
      const legacyPayload = {
        date_jst: "2026-06-15",
        stats: {
          today_reservations: [],
          tomorrow_reservations: [],
          open_conflicts: 0,
          dead_notification_jobs_24h: 0,
          dead_calendar_sync_jobs_24h: 0
        }
      };
      d1.sqlite
        .prepare(
          `INSERT INTO notification_jobs (
             id, dedupe_key, template_key, recipient_type, recipient_id,
             reservation_id, status, attempts, available_at, payload_json
           ) VALUES (?, ?, 'daily_ops_summary', 'owner', ?, NULL, 'queued', 0, ?, ?)`
        )
        .run(
          "job_legacy_daily_ops",
          `daily_ops_summary:2026-06-15:${OWNER_EMAIL_RECIPIENT_ID}`,
          OWNER_EMAIL_RECIPIENT_ID,
          "2026-06-15T11:00:00.000Z",
          JSON.stringify(legacyPayload)
        );

      const text = await renderQueuedDailyOpsEmail(d1);
      expect(text).toBe(MISSING_DAILY_CLEANUP_SUMMARY);
    });
  });

  describe("daily-cleanup heartbeat collector", () => {
    it("returns the latest completion marker's completed_at", async () => {
      seedMaintenanceRun(d1, {
        taskKey: "retention_sweep_phase1_completed",
        dayBucket: "2026-06-13",
        completedAt: "2026-06-13T16:05:00.000Z"
      });
      seedMaintenanceRun(d1, {
        taskKey: "retention_sweep_phase1_completed",
        dayBucket: "2026-06-14",
        completedAt: "2026-06-14T16:05:00.000Z"
      });

      await dispatchDailyOpsSummary({
        db: d1 as unknown as D1Database,
        env: enabledEnv(),
        nowMs: NOW_MS
      });

      const payload = getNotificationJobPayload(d1, "daily_ops_summary");
      expect(payload!.stats.daily_cleanup_last_run_at).toBe("2026-06-14T16:05:00.000Z");
    });

    it("returns null when no completion marker exists", async () => {
      await dispatchDailyOpsSummary({
        db: d1 as unknown as D1Database,
        env: enabledEnv(),
        nowMs: NOW_MS
      });

      const payload = getNotificationJobPayload(d1, "daily_ops_summary");
      expect(payload!.stats.daily_cleanup_last_run_at).toBeNull();
    });

    it("ignores the pre-work lock row and only reads the completion marker", async () => {
      // 前作業ロックそのものをデコイにする。ハングした sweep はこの行だけを
      // 残すので、これを拾ってしまうと心拍が止まった cron を成功と報告する。
      seedMaintenanceRun(d1, {
        taskKey: "retention_sweep_phase1",
        dayBucket: "2026-06-15",
        completedAt: "2026-06-15T10:59:00.000Z"
      });
      seedMaintenanceRun(d1, {
        taskKey: "retention_sweep_phase1_completed",
        dayBucket: "2026-06-14",
        completedAt: "2026-06-14T16:05:00.000Z"
      });

      await dispatchDailyOpsSummary({
        db: d1 as unknown as D1Database,
        env: enabledEnv(),
        nowMs: NOW_MS
      });

      const payload = getNotificationJobPayload(d1, "daily_ops_summary");
      expect(payload!.stats.daily_cleanup_last_run_at).toBe("2026-06-14T16:05:00.000Z");
    });
  });
});
