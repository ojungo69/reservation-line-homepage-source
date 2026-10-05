import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { processDueLineNotificationJobs } from "../src/line/notifications";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const NOW_MS = Date.parse("2026-08-01T00:00:00.000Z");

const OWNER_EMAIL_RECIPIENT_ID = "email:owner";
const LEGACY_OWNER_LINE_USER_ID = "U" + "a".repeat(32);
const LEGACY_PENDING_APPROVAL_EMAIL_RECIPIENT_ID = "email:pending_approval_owner";
const CUSTOMER_LINE_USER_ID = "U" + "1".repeat(32);

const seedReservationAndRequest = (
  d1: SqliteD1Database,
  changeRequestStatus: "pending" | "approved" | "rejected" = "pending"
) => {
  d1.sqlite.prepare(`INSERT INTO stores (id, name, timezone) VALUES (?, ?, ?)`).run("store_owner", "Salon", "Asia/Tokyo");
  d1.sqlite.prepare(`INSERT INTO store_resources (id, store_id, name) VALUES (?, ?, ?)`).run("resource_owner", "store_owner", "R");
  d1.sqlite
    .prepare(`INSERT INTO customers (id, display_name, phone_normalized, phone_hash) VALUES (?, ?, ?, ?)`)
    .run("customer_owner", "予約 太郎", "070000111", "ph_owner");
  d1.sqlite
    .prepare(
      `INSERT INTO line_identities (id, customer_id, provider, channel_id, line_user_id) VALUES (?, ?, ?, ?, ?)`
    )
    .run("identity_owner", "customer_owner", "line", "ch_owner", CUSTOMER_LINE_USER_ID);
  d1.sqlite
    .prepare(`INSERT INTO services (id, store_id, name, duration_minutes) VALUES (?, ?, ?, ?)`)
    .run("svc_owner", "store_owner", "カット", 60);
  d1.sqlite
    .prepare(
      `INSERT INTO reservations (
         id, store_id, service_id, customer_id, resource_id, line_identity_id, source, status,
         start_at, end_at, duration_minutes, idempotency_key, version
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      "res_owner",
      "store_owner",
      "svc_owner",
      "customer_owner",
      "resource_owner",
      "identity_owner",
      "web_line",
      "confirmed",
      "2026-08-05T03:00:00.000Z",
      "2026-08-05T04:00:00.000Z",
      60,
      "idem_owner",
      1
    );
  d1.sqlite
    .prepare(
      `INSERT INTO reservation_change_requests (
         id, reservation_id, customer_id, line_identity_id, request_type, status,
         reservation_version_at_request, current_start_at, current_end_at,
         requested_start_at, requested_end_at, customer_note
       ) VALUES (?, ?, ?, ?, 'reschedule', ?, 1, ?, ?, ?, ?, ?)`
    )
    .run(
      "req_owner",
      "res_owner",
      "customer_owner",
      "identity_owner",
      changeRequestStatus,
      "2026-08-05T03:00:00.000Z",
      "2026-08-05T04:00:00.000Z",
      "2026-08-06T05:00:00.000Z",
      "2026-08-06T06:00:00.000Z",
      "別日希望"
    );
};

const seedPendingApprovalOwnerJob = (
  d1: SqliteD1Database,
  jobId: string,
  recipientUserId: string,
  templateKey: "reservation_new_customer" | "pending_approval_created" = "reservation_new_customer"
) => {
  d1.sqlite.prepare(`UPDATE reservations SET status = 'pending_approval', pending_expires_at = NULL WHERE id = 'res_owner'`).run();
  d1.sqlite
    .prepare(
      `INSERT INTO notification_jobs (
         id, dedupe_key, template_key, recipient_type, recipient_id,
         reservation_id, change_request_id, status, attempts, available_at, updated_at
       ) VALUES (?, ?, ?, 'owner', ?, 'res_owner', NULL, 'queued', 0, ?, ?)`
    )
    .run(
      jobId,
      `reservation:res_owner:template:${templateKey}:recipient:${recipientUserId}`,
      templateKey,
      recipientUserId,
      "2026-08-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z"
    );
};

const seedCustomerJob = (d1: SqliteD1Database, jobId: string) => {
  d1.sqlite
    .prepare(
      `INSERT INTO notification_jobs (
         id, dedupe_key, template_key, recipient_type, recipient_id,
         reservation_id, status, attempts, available_at, updated_at
       ) VALUES (?, ?, 'reservation_confirmed', 'customer', ?, 'res_owner', 'queued', 0, ?, ?)`
    )
    .run(
      jobId,
      `reservation:res_owner:template:reservation_confirmed:recipient:${CUSTOMER_LINE_USER_ID}`,
      CUSTOMER_LINE_USER_ID,
      "2026-08-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z"
    );
};

const seedQuotaSnapshotAtSoftCap = (d1: SqliteD1Database) => {
  d1.sqlite
    .prepare(`INSERT INTO line_quota_snapshots (year_month, total_usage, quota_value, fetched_at) VALUES (?, ?, ?, ?)`)
    .run("2026-08", 180, 200, "2026-08-01T00:00:00.000Z");
};

const seedDailyOpsSummaryOwnerJob = (d1: SqliteD1Database, jobId: string, recipientUserId: string) => {
  const payload = {
    date_jst: "2026-08-01",
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
         reservation_id, status, attempts, available_at, updated_at, payload_json
       ) VALUES (?, ?, 'daily_ops_summary', 'owner', ?, NULL, 'queued', 0, ?, ?, ?)`
    )
    .run(
      jobId,
      `daily_ops_summary:2026-08-01:${recipientUserId}`,
      recipientUserId,
      "2026-08-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
      JSON.stringify(payload)
    );
};

const createEmailSendMock = (impl?: (message: { to: string; subject: string; text: string; html?: string }) => Promise<unknown>) =>
  vi.fn(impl ?? (async () => ({ messageId: "email_1" })));

const envWithOpsEmail = (
  emailSend: ReturnType<typeof createEmailSendMock>,
  extra?: Record<string, string>
) => ({
  LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token_owner",
  OPERATIONS_NOTIFICATION_EMAIL: "dev@example.com",
  EMAIL: { send: emailSend } as unknown as SendEmail,
  ...extra
});

describe("LINE notification queue — owner recipient path", () => {
  let d1: SqliteD1Database;

  beforeEach(() => {
    d1 = createMigratedSqliteD1();
  });

  afterEach(() => {
    d1.sqlite.close();
  });

  it("emails reservation_new_customer to the owner without calling LINE", async () => {
    seedReservationAndRequest(d1, "pending");
    // The new-customer alert is only eligible while the reservation awaits approval.
    d1.sqlite.prepare(`UPDATE reservations SET status = 'pending_approval', pending_expires_at = NULL WHERE id = 'res_owner'`).run();
    // New-customer owner job: reservation-backed, NO change_request_id.
    d1.sqlite
      .prepare(
        `INSERT INTO notification_jobs (
           id, dedupe_key, template_key, recipient_type, recipient_id,
           reservation_id, change_request_id, status, attempts, available_at, updated_at
         ) VALUES (?, ?, 'reservation_new_customer', 'owner', ?, 'res_owner', NULL, 'queued', 0, ?, ?)`
      )
      .run(
        "job_new_customer",
        `reservation:res_owner:template:reservation_new_customer:recipient:${OWNER_EMAIL_RECIPIENT_ID}`,
        OWNER_EMAIL_RECIPIENT_ID,
        "2026-08-01T00:00:00.000Z",
        "2026-08-01T00:00:00.000Z"
      );

    const emailSend = createEmailSendMock();
    const fetchMock = vi.fn(async () => Response.json({ sentMessages: [{ id: "unexpected" }] })) as unknown as typeof fetch;
    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: envWithOpsEmail(emailSend, {
        PENDING_APPROVAL_OWNER_EMAIL: "owner@example.com",
        OPERATIONS_NOTIFICATION_EMAIL: ""
      }),
      fetcher: fetchMock,
      now: () => NOW_MS
    });
    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(emailSend).toHaveBeenCalledTimes(1);
    const email = emailSend.mock.calls[0]?.[0];
    expect(email.to).toBe("owner@example.com");
    expect(email.subject).toBe("【予約通知】新規のご予約申込");
    const text = email.text;
    expect(text).toContain("新規のお客様の予約です");
    expect(text).toContain("店舗: Salon");
    expect(text).toContain("顧客: 予約 太郎");
    expect(text).toContain("管理画面で承認してください");
    // PII-minimised: no phone number leaked to the owner.
    expect(text).not.toMatch(/\+81[0-9]+/);

    const log = d1.sqlite
      .prepare(`SELECT sent_count FROM notification_logs WHERE notification_job_id = ?`)
      .get("job_new_customer") as { sent_count: number };
    expect(log.sent_count).toBe(0);
  });

  it("keeps legacy LINE-recipient owner rows on LINE during rollout", async () => {
    seedReservationAndRequest(d1, "pending");
    seedPendingApprovalOwnerJob(
      d1,
      "job_legacy_owner_line",
      LEGACY_OWNER_LINE_USER_ID,
      "reservation_new_customer"
    );

    const emailSend = createEmailSendMock();
    const fetchMock = vi.fn(async () => Response.json({ sentMessages: [{ id: "legacy_line" }] })) as unknown as typeof fetch;
    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: envWithOpsEmail(emailSend, { PENDING_APPROVAL_OWNER_EMAIL: "owner@example.com" }),
      fetcher: fetchMock,
      now: () => NOW_MS
    });

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    expect(emailSend).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = vi.mocked(fetchMock).mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body)) as { to: string };
    expect(body.to).toBe(LEGACY_OWNER_LINE_USER_ID);
  });

  it("emails pending_approval_created to primary and mirrors ops on first attempt without calling LINE", async () => {
    seedReservationAndRequest(d1, "pending");
    seedPendingApprovalOwnerJob(
      d1,
      "job_pending_approval_created",
      LEGACY_PENDING_APPROVAL_EMAIL_RECIPIENT_ID,
      "pending_approval_created"
    );

    const emailSend = createEmailSendMock();
    const fetchMock = vi.fn(async () => Response.json({ sentMessages: [{ id: "unexpected" }] })) as unknown as typeof fetch;
    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: envWithOpsEmail(emailSend, {
        PENDING_APPROVAL_OWNER_EMAIL: " owner@example.com "
      }),
      fetcher: fetchMock,
      now: () => NOW_MS
    });

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    // primary + always-on first-attempt mirror (same body). Call ORDER is part
    // of the contract: the primary must reach the provider before the mirror so
    // the in-flight marker's reclaim path never covers a mirror-only handoff.
    expect(emailSend).toHaveBeenCalledTimes(2);
    const recipients = emailSend.mock.calls.map(([message]) => message.to);
    expect(recipients).toEqual(["owner@example.com", "dev@example.com"]);
    const primary = emailSend.mock.calls.find(([message]) => message.to === "owner@example.com")?.[0];
    const mirror = emailSend.mock.calls.find(([message]) => message.to === "dev@example.com")?.[0];
    expect(primary?.subject).toBe("【予約通知】ご予約の申込があります");
    expect(mirror?.subject).toBe(primary?.subject);
    expect(mirror?.text).toBe(primary?.text);
    const text = primary?.text ?? "";
    expect(text.split("\n")[0]).toBe("ご予約の申込があります。");
    expect(text).toContain("予約: res_owne…");
    expect(text).toContain("店舗: Salon");
    expect(text).toContain("日時:");
    expect(text).toContain("顧客: 予約 太郎");
    expect(text).toContain("管理画面で承認してください。");
    expect(text).not.toMatch(/\+81[0-9]+/);

    const log = d1.sqlite
      .prepare(`SELECT sent_count FROM notification_logs WHERE notification_job_id = ?`)
      .get("job_pending_approval_created") as { sent_count: number };
    expect(log.sent_count).toBe(0);
  });

  it("still mirrors ops when primary send fails; job outcome follows primary only", async () => {
    seedReservationAndRequest(d1, "pending");
    seedPendingApprovalOwnerJob(d1, "job_pending_primary_fail", OWNER_EMAIL_RECIPIENT_ID, "pending_approval_created");

    const emailSend = createEmailSendMock(async (message) => {
      if (message.to === "owner@example.com") throw new Error("primary down");
      return { messageId: "email_mirror" };
    });
    const fetchMock = vi.fn(async () => Response.json({ sentMessages: [{ id: "unexpected" }] })) as unknown as typeof fetch;
    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: envWithOpsEmail(emailSend, {
        PENDING_APPROVAL_OWNER_EMAIL: "owner@example.com"
      }),
      fetcher: fetchMock,
      now: () => NOW_MS
    });

    // primary failed → retryable; mirror success must not flip the job to succeeded
    expect(result).toEqual({ processed: 1, succeeded: 0, failed: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(emailSend).toHaveBeenCalledTimes(2);
    // Primary handoff first, mirror second (in-flight marker ordering contract).
    expect(emailSend.mock.calls.map(([message]) => message.to)).toEqual([
      "owner@example.com",
      "dev@example.com"
    ]);
    const row = d1.sqlite
      .prepare(`SELECT status, last_error, email_inflight_at FROM notification_jobs WHERE id = ?`)
      .get("job_pending_primary_fail") as {
      status: string;
      last_error: string;
      email_inflight_at: string | null;
    };
    expect(row).toEqual({
      status: "retryable",
      last_error: "primary down",
      email_inflight_at: null
    });
  });

  it("does not mirror pending_approval_created on retry attempts", async () => {
    seedReservationAndRequest(d1, "pending");
    seedPendingApprovalOwnerJob(d1, "job_pending_retry_no_mirror", OWNER_EMAIL_RECIPIENT_ID, "pending_approval_created");
    // claim.attempts = row.attempts + 1 → seed 1 so this is attempt 2
    d1.sqlite
      .prepare(`UPDATE notification_jobs SET attempts = 1, status = 'retryable' WHERE id = ?`)
      .run("job_pending_retry_no_mirror");

    const emailSend = createEmailSendMock();
    const fetchMock = vi.fn(async () => Response.json({ sentMessages: [{ id: "unexpected" }] })) as unknown as typeof fetch;
    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: envWithOpsEmail(emailSend, {
        PENDING_APPROVAL_OWNER_EMAIL: "owner@example.com"
      }),
      fetcher: fetchMock,
      now: () => NOW_MS
    });

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    expect(emailSend).toHaveBeenCalledTimes(1);
    expect(emailSend.mock.calls[0]?.[0].to).toBe("owner@example.com");
  });

  it("keeps the job succeeded when the ops mirror send fails", async () => {
    seedReservationAndRequest(d1, "pending");
    seedPendingApprovalOwnerJob(d1, "job_pending_mirror_fail", OWNER_EMAIL_RECIPIENT_ID, "pending_approval_created");

    const emailSend = createEmailSendMock(async (message) => {
      if (message.to === "dev@example.com") throw new Error("mirror down");
      return { messageId: "email_primary" };
    });
    const fetchMock = vi.fn(async () => Response.json({ sentMessages: [{ id: "unexpected" }] })) as unknown as typeof fetch;
    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: envWithOpsEmail(emailSend, {
        PENDING_APPROVAL_OWNER_EMAIL: "owner@example.com"
      }),
      fetcher: fetchMock,
      now: () => NOW_MS
    });

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    expect(emailSend).toHaveBeenCalledTimes(2);
    const row = d1.sqlite
      .prepare(`SELECT status, last_error FROM notification_jobs WHERE id = ?`)
      .get("job_pending_mirror_fail") as { status: string; last_error: string | null };
    expect(row.status).toBe("succeeded");
    expect(row.last_error).toBeNull();
  });

  it("writes the primary's terminal D1 outcome without waiting for the mirror to settle", async () => {
    seedReservationAndRequest(d1, "pending");
    seedPendingApprovalOwnerJob(d1, "job_pending_mirror_deferred", OWNER_EMAIL_RECIPIENT_ID, "pending_approval_created");

    // Mirror send blocks on a manually released promise; the primary resolves
    // immediately. The job's terminal write must land while the mirror is still
    // pending — a regression that awaits the mirror before markJobSuccess would
    // hang this test past vi.waitFor's timeout.
    let releaseMirror: (() => void) | undefined;
    const emailSend = createEmailSendMock((message) => {
      if (message.to === "dev@example.com") {
        return new Promise((resolve) => {
          releaseMirror = () => resolve({ messageId: "email_mirror" });
        });
      }
      return Promise.resolve({ messageId: "email_primary" });
    });
    const fetchMock = vi.fn(async () => Response.json({ sentMessages: [{ id: "unexpected" }] })) as unknown as typeof fetch;
    const pending = processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: envWithOpsEmail(emailSend, {
        PENDING_APPROVAL_OWNER_EMAIL: "owner@example.com"
      }),
      fetcher: fetchMock,
      now: () => NOW_MS
    });
    let runSettled = false;
    void pending.then(() => {
      runSettled = true;
    });

    await vi.waitFor(() => {
      const row = d1.sqlite
        .prepare(`SELECT status FROM notification_jobs WHERE id = ?`)
        .get("job_pending_mirror_deferred") as { status: string };
      expect(row.status).toBe("succeeded");
    });
    // The run must still be awaiting the mirror here: returning before the
    // mirror settles (fire-and-forget) would let the Workers runtime cancel the
    // in-flight send once the invocation ends.
    expect(runSettled).toBe(false);
    expect(releaseMirror).toBeDefined();
    releaseMirror?.();

    expect(await pending).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    expect(runSettled).toBe(true);
    expect(emailSend).toHaveBeenCalledTimes(2);
  });

  it("uses the operations address as primary only (no mirror) when PENDING_APPROVAL_OWNER_EMAIL is blank", async () => {
    seedReservationAndRequest(d1, "pending");
    seedPendingApprovalOwnerJob(d1, "job_pending_blank_primary", OWNER_EMAIL_RECIPIENT_ID, "pending_approval_created");

    const emailSend = createEmailSendMock();
    const fetchMock = vi.fn(async () => Response.json({ sentMessages: [{ id: "unexpected" }] })) as unknown as typeof fetch;
    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: envWithOpsEmail(emailSend, {
        PENDING_APPROVAL_OWNER_EMAIL: "   "
      }),
      fetcher: fetchMock,
      now: () => NOW_MS
    });

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    // primary === operations → no second destination
    expect(emailSend).toHaveBeenCalledTimes(1);
    expect(emailSend.mock.calls[0]?.[0].to).toBe("dev@example.com");
  });

  it("files the batch metric under the email channel, not line", async () => {
    seedReservationAndRequest(d1, "pending");
    seedPendingApprovalOwnerJob(d1, "job_pending_metric", OWNER_EMAIL_RECIPIENT_ID, "pending_approval_created");

    const writeDataPoint = vi.fn();
    const emailSend = createEmailSendMock();
    await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: {
        ...envWithOpsEmail(emailSend, { PENDING_APPROVAL_OWNER_EMAIL: "owner@example.com" }),
        METRICS: { writeDataPoint } as unknown as AnalyticsEngineDataset
      },
      fetcher: vi.fn(async () => Response.json({ sentMessages: [] })) as unknown as typeof fetch,
      now: () => NOW_MS
    });

    // channel is the last blob. A sweep that only sent email must not report a
    // successful LINE notification.
    const channels = writeDataPoint.mock.calls.map(([point]) => [point.blobs[0], point.blobs[4]]);
    expect(channels).toEqual([["notification_sent", "email"]]);
    expect(writeDataPoint.mock.calls[0]?.[0].doubles).toEqual([1, 1]);
  });

  it("does not resend a new-customer owner email left in flight", async () => {
    // Worker died (or the D1 write failed) between EMAIL.send() resolving and
    // markJobSuccess. Email carries no retry key, so re-sending would very likely
    // duplicate the owner's mail: terminate with a greppable last_error instead.
    seedReservationAndRequest(d1, "pending");
    seedPendingApprovalOwnerJob(d1, "job_owner_inflight", OWNER_EMAIL_RECIPIENT_ID, "reservation_new_customer");
    d1.sqlite
      .prepare(`UPDATE notification_jobs SET email_inflight_at = ? WHERE id = ?`)
      .run("2026-08-01T00:00:00.000Z", "job_owner_inflight");

    const emailSend = createEmailSendMock();
    const fetchMock = vi.fn(async () => Response.json({ sentMessages: [] })) as unknown as typeof fetch;
    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: envWithOpsEmail(emailSend, { PENDING_APPROVAL_OWNER_EMAIL: "owner@example.com" }),
      fetcher: fetchMock,
      now: () => NOW_MS
    });

    expect(result).toEqual({ processed: 1, succeeded: 0, failed: 0 });
    expect(emailSend).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    const row = d1.sqlite
      .prepare(`SELECT status, last_error FROM notification_jobs WHERE id = ?`)
      .get("job_owner_inflight") as { status: string; last_error: string };
    expect(row).toEqual({
      status: "succeeded",
      last_error: "email_send_outcome_unknown_inflight"
    });
  });

  it("clears the in-flight marker after a definitive send failure so the retry can send", async () => {
    seedReservationAndRequest(d1, "pending");
    seedPendingApprovalOwnerJob(d1, "job_pending_clear", OWNER_EMAIL_RECIPIENT_ID, "pending_approval_created");

    const emailSend = createEmailSendMock(async () => {
      throw new Error("primary down");
    });
    const fetchMock = vi.fn(async () => Response.json({ sentMessages: [] })) as unknown as typeof fetch;
    await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: envWithOpsEmail(emailSend, { PENDING_APPROVAL_OWNER_EMAIL: "owner@example.com" }),
      fetcher: fetchMock,
      now: () => NOW_MS
    });

    const row = d1.sqlite
      .prepare(`SELECT status, email_inflight_at FROM notification_jobs WHERE id = ?`)
      .get("job_pending_clear") as { status: string; email_inflight_at: string | null };
    expect(row).toEqual({ status: "retryable", email_inflight_at: null });
  });

  it("fails pending_approval_created when both email addresses are blank", async () => {
    seedReservationAndRequest(d1, "pending");
    seedPendingApprovalOwnerJob(d1, "job_pending_no_address", OWNER_EMAIL_RECIPIENT_ID, "pending_approval_created");

    const emailSend = createEmailSendMock();
    const fetchMock = vi.fn(async () => Response.json({ sentMessages: [{ id: "unexpected" }] })) as unknown as typeof fetch;
    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: envWithOpsEmail(emailSend, {
        PENDING_APPROVAL_OWNER_EMAIL: " ",
        OPERATIONS_NOTIFICATION_EMAIL: ""
      }),
      fetcher: fetchMock,
      now: () => NOW_MS
    });

    // Retryable, NOT succeeded: the owner can still set the address, and until they
    // do the job dead-letters where the dead-job count makes the loss visible.
    expect(result).toEqual({ processed: 1, succeeded: 0, failed: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(emailSend).not.toHaveBeenCalled();
    const row = d1.sqlite
      .prepare(`SELECT status, last_error FROM notification_jobs WHERE id = ?`)
      .get("job_pending_no_address") as { status: string; last_error: string };
    expect(row).toEqual({
      status: "retryable",
      last_error: "owner_notification_email_unconfigured"
    });
  });

  it("treats a timed-out primary pending approval email as terminal without retry", async () => {
    vi.useFakeTimers();
    try {
      seedReservationAndRequest(d1, "pending");
      seedPendingApprovalOwnerJob(d1, "job_pending_timeout", OWNER_EMAIL_RECIPIENT_ID, "pending_approval_created");

      const emailSend = createEmailSendMock(() => new Promise(() => {}));
      const fetchMock = vi.fn(async () => Response.json({ sentMessages: [{ id: "unexpected" }] })) as unknown as typeof fetch;
      const pending = processDueLineNotificationJobs({
        db: d1 as unknown as D1Database,
        env: envWithOpsEmail(emailSend, {
          PENDING_APPROVAL_OWNER_EMAIL: "owner@example.com"
        }),
        fetcher: fetchMock,
        now: () => NOW_MS
      });
      // primary + concurrent first-attempt mirror each race a 15s send timeout
      await vi.advanceTimersByTimeAsync(15_000);
      const result = await pending;

      expect(result).toEqual({ processed: 1, succeeded: 0, failed: 0 });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(emailSend).toHaveBeenCalledTimes(2);
      // Primary handoff first, mirror second (in-flight marker ordering contract).
      expect(emailSend.mock.calls.map(([message]) => message.to)).toEqual([
        "owner@example.com",
        "dev@example.com"
      ]);
      const row = d1.sqlite
        .prepare(`SELECT status, attempts, last_error FROM notification_jobs WHERE id = ?`)
        .get("job_pending_timeout") as { status: string; attempts: number; last_error: string };
      // Terminal on primary timeout (unknown delivery); last_error is primary's reason
      expect(row).toEqual({
        status: "succeeded",
        attempts: 1,
        last_error: "email_send_timeout:15000ms"
      });

      const retry = await processDueLineNotificationJobs({
        db: d1 as unknown as D1Database,
        env: envWithOpsEmail(emailSend, {
          PENDING_APPROVAL_OWNER_EMAIL: "owner@example.com"
        }),
        fetcher: fetchMock,
        now: () => NOW_MS + 5 * 60 * 1000
      });
      expect(retry).toEqual({ processed: 0, succeeded: 0, failed: 0 });
      expect(emailSend).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dead-letters pending approval email failures at MAX_ATTEMPTS", async () => {
    seedReservationAndRequest(d1, "pending");
    seedPendingApprovalOwnerJob(d1, "job_pending_email_dead", OWNER_EMAIL_RECIPIENT_ID, "pending_approval_created");
    // claim.attempts = 5 → no ops mirror (first-attempt only)
    d1.sqlite.prepare(`UPDATE notification_jobs SET attempts = 4 WHERE id = ?`).run("job_pending_email_dead");

    const emailSend = createEmailSendMock(async () => {
      throw new Error("primary down");
    });
    const fetchMock = vi.fn(async () => Response.json({ sentMessages: [{ id: "unexpected" }] })) as unknown as typeof fetch;
    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: envWithOpsEmail(emailSend, {
        PENDING_APPROVAL_OWNER_EMAIL: "owner@example.com"
      }),
      fetcher: fetchMock,
      now: () => NOW_MS
    });

    expect(result).toEqual({ processed: 1, succeeded: 0, failed: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(emailSend).toHaveBeenCalledTimes(1);
    expect(emailSend.mock.calls[0]?.[0].to).toBe("owner@example.com");
    const row = d1.sqlite
      .prepare(`SELECT status, attempts, last_error FROM notification_jobs WHERE id = ?`)
      .get("job_pending_email_dead") as { status: string; attempts: number; last_error: string };
    expect(row).toEqual({
      status: "dead",
      attempts: 5,
      last_error: "primary down"
    });
  });

  it("uses the owner primary and first-attempt mirror for reservation_new_customer", async () => {
    seedReservationAndRequest(d1, "pending");
    seedPendingApprovalOwnerJob(d1, "job_new_customer_email", OWNER_EMAIL_RECIPIENT_ID);

    const emailSend = createEmailSendMock();
    const fetchMock = vi.fn(async () => Response.json({ sentMessages: [{ id: "unexpected" }] })) as unknown as typeof fetch;
    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: envWithOpsEmail(emailSend, { PENDING_APPROVAL_OWNER_EMAIL: "owner@example.com" }),
      fetcher: fetchMock,
      now: () => NOW_MS
    });

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(emailSend.mock.calls.map(([message]) => message.to)).toEqual([
      "owner@example.com",
      "dev@example.com"
    ]);
    expect(emailSend.mock.calls[0]?.[0].subject).toBe("【予約通知】新規のご予約申込");
    expect(emailSend.mock.calls[1]?.[0].text).toBe(emailSend.mock.calls[0]?.[0].text);
  });

  it("does not suppress owner email when staging shares the production LINE channel", async () => {
    seedReservationAndRequest(d1, "pending");
    seedPendingApprovalOwnerJob(d1, "job_new_customer_staging", OWNER_EMAIL_RECIPIENT_ID);

    const emailSend = createEmailSendMock();
    const fetchMock = vi.fn(async () => Response.json({ sentMessages: [{ id: "unexpected" }] })) as unknown as typeof fetch;
    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: envWithOpsEmail(emailSend, {
        ENVIRONMENT: "staging",
        PENDING_APPROVAL_OWNER_EMAIL: "owner@example.com",
        OPERATIONS_NOTIFICATION_EMAIL: ""
      }),
      fetcher: fetchMock,
      now: () => NOW_MS
    });

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(emailSend).toHaveBeenCalledTimes(1);
    expect(emailSend.mock.calls[0]?.[0].subject).toBe("[staging] 【予約通知】新規のご予約申込");
  });

  it("does not mirror reservation_new_customer again on retry", async () => {
    seedReservationAndRequest(d1, "pending");
    seedPendingApprovalOwnerJob(d1, "job_owner_retry_email", OWNER_EMAIL_RECIPIENT_ID);
    d1.sqlite
      .prepare(`UPDATE notification_jobs SET attempts = 1, status = 'retryable' WHERE id = ?`)
      .run("job_owner_retry_email");

    const emailSend = createEmailSendMock();
    const fetchMock = vi.fn(async () => Response.json({ sentMessages: [{ id: "unexpected" }] })) as unknown as typeof fetch;
    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: envWithOpsEmail(emailSend, { PENDING_APPROVAL_OWNER_EMAIL: "owner@example.com" }),
      fetcher: fetchMock,
      now: () => NOW_MS
    });

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(emailSend).toHaveBeenCalledTimes(1);
    expect(emailSend.mock.calls[0]?.[0].to).toBe("owner@example.com");
  });

  it("does not email customer notification jobs", async () => {
    seedReservationAndRequest(d1, "pending");
    seedCustomerJob(d1, "job_customer_no_email");

    const emailSend = createEmailSendMock();
    const fetchMock = vi.fn(async () => Response.json({ sentMessages: [{ id: "mid_customer" }] })) as unknown as typeof fetch;
    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: envWithOpsEmail(emailSend),
      fetcher: fetchMock,
      now: () => NOW_MS
    });

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(emailSend).not.toHaveBeenCalled();
  });

  it("fails a non-pending owner template when both email addresses are blank", async () => {
    seedReservationAndRequest(d1, "pending");
    seedPendingApprovalOwnerJob(d1, "job_owner_email_unset", OWNER_EMAIL_RECIPIENT_ID, "reservation_new_customer");

    const emailSend = createEmailSendMock();
    const fetchMock = vi.fn(async () => Response.json({ sentMessages: [{ id: "unexpected" }] })) as unknown as typeof fetch;
    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: envWithOpsEmail(emailSend, {
        PENDING_APPROVAL_OWNER_EMAIL: "",
        OPERATIONS_NOTIFICATION_EMAIL: ""
      }),
      fetcher: fetchMock,
      now: () => NOW_MS
    });

    expect(result).toEqual({ processed: 1, succeeded: 0, failed: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(emailSend).not.toHaveBeenCalled();
    const row = d1.sqlite.prepare(`SELECT status, last_error FROM notification_jobs WHERE id = ?`).get("job_owner_email_unset") as {
      status: string;
      last_error: string;
    };
    expect(row).toEqual({
      status: "retryable",
      last_error: "owner_notification_email_unconfigured"
    });
  });

  it.each([180, 200])("emails owner jobs even at LINE usage %i", async (usage) => {
    seedQuotaSnapshotAtSoftCap(d1);
    d1.sqlite.prepare("UPDATE line_quota_snapshots SET total_usage = ?").run(usage);
    seedDailyOpsSummaryOwnerJob(d1, "job_daily_email_suppressed", OWNER_EMAIL_RECIPIENT_ID);

    const emailSend = createEmailSendMock();
    const fetchMock = vi.fn(async () => Response.json({ sentMessages: [{ id: "unexpected" }] })) as unknown as typeof fetch;
    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: envWithOpsEmail(emailSend, {
        DAILY_OPS_SUMMARY_DISPATCH_ENABLED: "true",
        PENDING_APPROVAL_OWNER_EMAIL: "owner@example.com",
        OPERATIONS_NOTIFICATION_EMAIL: ""
      }),
      fetcher: fetchMock,
      now: () => NOW_MS
    });

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    expect(emailSend).toHaveBeenCalledTimes(1);
    expect(emailSend.mock.calls[0]?.[0].text).toContain("営業日報");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(emailSend.mock.calls[0]?.[0].to).toBe("owner@example.com");
    expect(emailSend.mock.calls[0]?.[0].subject).toBe("【予約通知】日次サマリー");
    const row = d1.sqlite.prepare(`SELECT status, last_error FROM notification_jobs WHERE id = ?`).get("job_daily_email_suppressed") as {
      status: string;
      last_error: string | null;
    };
    expect(row.status).toBe("succeeded");
    expect(row.last_error).toBeNull();
  });

  it("does not resend a system owner email left in flight", async () => {
    seedDailyOpsSummaryOwnerJob(d1, "job_daily_inflight", OWNER_EMAIL_RECIPIENT_ID);
    d1.sqlite
      .prepare(`UPDATE notification_jobs SET email_inflight_at = ? WHERE id = ?`)
      .run("2026-08-01T00:00:00.000Z", "job_daily_inflight");

    const emailSend = createEmailSendMock();
    const fetchMock = vi.fn(async () => Response.json({ sentMessages: [{ id: "unexpected" }] })) as unknown as typeof fetch;
    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: envWithOpsEmail(emailSend, {
        DAILY_OPS_SUMMARY_DISPATCH_ENABLED: "true",
        PENDING_APPROVAL_OWNER_EMAIL: "owner@example.com",
        OPERATIONS_NOTIFICATION_EMAIL: ""
      }),
      fetcher: fetchMock,
      now: () => NOW_MS
    });

    expect(result).toEqual({ processed: 1, succeeded: 0, failed: 0 });
    expect(emailSend).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    const row = d1.sqlite
      .prepare(`SELECT status, last_error FROM notification_jobs WHERE id = ?`)
      .get("job_daily_inflight") as { status: string; last_error: string };
    expect(row).toEqual({
      status: "succeeded",
      last_error: "email_send_outcome_unknown_inflight"
    });
  });

  it("does not claim staff-recipient pending_approval_created jobs (dispatcher is customer/owner only)", async () => {
    seedReservationAndRequest(d1, "pending");
    d1.sqlite
      .prepare(`UPDATE reservations SET status = 'pending_approval', pending_expires_at = NULL WHERE id = 'res_owner'`)
      .run();
    d1.sqlite
      .prepare(
        `INSERT INTO notification_jobs (
           id, dedupe_key, template_key, recipient_type, recipient_id,
           reservation_id, status, attempts, available_at, updated_at
         ) VALUES ('job_staff_pending', 'reservation:res_owner:template:pending_approval_created:recipient:staff_kyoto',
                   'pending_approval_created', 'staff', 'staff_kyoto', 'res_owner', 'queued', 0, ?, ?)`
      )
      .run("2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z");

    const fetchMock = vi.fn(async () => Response.json({ sentMessages: [] })) as unknown as typeof fetch;
    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token_owner" },
      fetcher: fetchMock,
      now: () => NOW_MS
    });

    expect(result).toEqual({ processed: 0, succeeded: 0, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    const row = d1.sqlite
      .prepare(`SELECT status FROM notification_jobs WHERE id = 'job_staff_pending'`)
      .get() as { status: string };
    expect(row.status).toBe("queued");
  });

  it("does NOT send a new-customer owner alert for an expired pending reservation", async () => {
    // Seed a pending_approval reservation whose pending window has already lapsed
    // (status not yet swept to 'expired'). The owner must not be prompted to
    // approve it.
    d1.sqlite.prepare(`INSERT INTO stores (id, name, timezone) VALUES (?, ?, ?)`).run("store_exp", "Salon", "Asia/Tokyo");
    d1.sqlite.prepare(`INSERT INTO store_resources (id, store_id, name) VALUES (?, ?, ?)`).run("res_exp", "store_exp", "R");
    d1.sqlite
      .prepare(`INSERT INTO customers (id, display_name, phone_normalized, phone_hash) VALUES (?, ?, ?, ?)`)
      .run("cust_exp", "新規 太郎", "070000222", "ph_exp");
    d1.sqlite
      .prepare(`INSERT INTO services (id, store_id, name, duration_minutes) VALUES (?, ?, ?, ?)`)
      .run("svc_exp", "store_exp", "カット", 60);
    d1.sqlite
      .prepare(
        `INSERT INTO reservations (
           id, store_id, service_id, customer_id, resource_id, source, status,
           start_at, end_at, duration_minutes, idempotency_key, version, pending_expires_at
         ) VALUES ('resv_exp', 'store_exp', 'svc_exp', 'cust_exp', 'res_exp', 'web_line', 'pending_approval',
                   '2026-08-05T03:00:00.000Z', '2026-08-05T04:00:00.000Z', 60, 'idem_exp', 1, '2026-07-31T00:00:00.000Z')`
      )
      .run();
    d1.sqlite
      .prepare(
        `INSERT INTO notification_jobs (
           id, dedupe_key, template_key, recipient_type, recipient_id, reservation_id,
           status, attempts, available_at, updated_at
         ) VALUES ('job_exp', 'resv_exp:new_customer', 'reservation_new_customer', 'owner', ?, 'resv_exp', 'queued', 0, ?, ?)`
      )
      .run(OWNER_EMAIL_RECIPIENT_ID, "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z");

    const fetchMock = vi.fn(async () => Response.json({ sentMessages: [] })) as unknown as typeof fetch;
    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "token_owner" },
      fetcher: fetchMock,
      now: () => NOW_MS
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    const row = d1.sqlite.prepare(`SELECT status, last_error FROM notification_jobs WHERE id = 'job_exp'`).get() as {
      status: string;
      last_error: string;
    };
    expect(row.last_error).toBe("superseded_by_reservation_state");
  });

  it("skips pending_approval_created when the reservation is no longer pending", async () => {
    seedReservationAndRequest(d1, "pending");
    seedPendingApprovalOwnerJob(
      d1,
      "job_pending_approval_confirmed",
      OWNER_EMAIL_RECIPIENT_ID,
      "pending_approval_created"
    );
    d1.sqlite.prepare(`UPDATE reservations SET status = 'confirmed' WHERE id = 'res_owner'`).run();

    const emailSend = createEmailSendMock();
    const fetchMock = vi.fn(async () => Response.json({ sentMessages: [] })) as unknown as typeof fetch;
    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: envWithOpsEmail(emailSend),
      fetcher: fetchMock,
      now: () => NOW_MS
    });

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(emailSend).not.toHaveBeenCalled();
    const row = d1.sqlite
      .prepare(`SELECT status, last_error FROM notification_jobs WHERE id = ?`)
      .get("job_pending_approval_confirmed") as { status: string; last_error: string };
    expect(row).toEqual({
      status: "succeeded",
      last_error: "superseded_by_reservation_state"
    });
  });

  it("processes both customer and owner rows in the same sweep", async () => {
    seedReservationAndRequest(d1, "pending");
    // pending_approval に揃えると owner (reservation_new_customer) と customer
    // (reservation_pending_received) の両方が同時に eligible になる。
    seedPendingApprovalOwnerJob(d1, "job_owner_a", OWNER_EMAIL_RECIPIENT_ID);
    d1.sqlite
      .prepare(
        `INSERT INTO notification_jobs (
           id, dedupe_key, template_key, recipient_type, recipient_id,
           reservation_id, status, attempts, available_at, updated_at
         ) VALUES ('job_customer', 'reservation:res_owner:template:reservation_pending_received',
                  'reservation_pending_received', 'customer', ?, 'res_owner', 'queued', 0, ?, ?)`
      )
      .run(CUSTOMER_LINE_USER_ID, "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z");

    const emailSend = createEmailSendMock();
    const fetchMock = vi.fn(async () => Response.json({ sentMessages: [{ id: "mid" }] })) as unknown as typeof fetch;
    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: envWithOpsEmail(emailSend, {
        PENDING_APPROVAL_OWNER_EMAIL: "owner@example.com",
        OPERATIONS_NOTIFICATION_EMAIL: ""
      }),
      fetcher: fetchMock,
      now: () => NOW_MS,
      maxJobs: 5
    });
    expect(result).toEqual({ processed: 2, succeeded: 2, failed: 0 });
    const calls = vi.mocked(fetchMock).mock.calls;
    const customerCall = calls.find(([, init]) => init?.body && String(init.body).includes(CUSTOMER_LINE_USER_ID));
    expect(customerCall).toBeDefined();
    expect(calls).toHaveLength(1);
    expect(emailSend).toHaveBeenCalledTimes(1);
    expect(emailSend.mock.calls[0]?.[0].to).toBe("owner@example.com");
  });

  it("records recipient_type='owner' in notification_logs on success", async () => {
    seedReservationAndRequest(d1, "pending");
    seedPendingApprovalOwnerJob(d1, "job_owner_log", OWNER_EMAIL_RECIPIENT_ID);

    const emailSend = createEmailSendMock();
    const fetchMock = vi.fn(async () => Response.json({ sentMessages: [{ id: "unexpected" }] })) as unknown as typeof fetch;
    await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: envWithOpsEmail(emailSend, {
        PENDING_APPROVAL_OWNER_EMAIL: "owner@example.com",
        OPERATIONS_NOTIFICATION_EMAIL: ""
      }),
      fetcher: fetchMock,
      now: () => NOW_MS
    });

    expect(fetchMock).not.toHaveBeenCalled();

    const log = d1.sqlite
      .prepare(`SELECT recipient_type, recipient_id, sent_count FROM notification_logs WHERE notification_job_id = ?`)
      .get("job_owner_log") as { recipient_type: string; recipient_id: string; sent_count: number };
    expect(log.recipient_type).toBe("owner");
    expect(log.recipient_id).toBe(OWNER_EMAIL_RECIPIENT_ID);
    expect(log.sent_count).toBe(0);
  });
});
