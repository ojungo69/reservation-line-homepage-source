import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/sentry-helpers", () => ({
  safeCaptureException: vi.fn(),
  captureBatchWriteFailure: vi.fn()
}));

import { processDueLineNotificationJobs } from "../src/line/notifications";
import { safeCaptureException } from "../src/sentry-helpers";
import { createPublicReservation, type PublicReservationRequest } from "../src/reservations/public-submit";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const SUBMIT_NOW_MS = Date.parse("2026-05-09T23:00:00.000Z");
const ACTIVE_NOTIFICATION_NOW_MS = Date.parse("2026-05-09T23:10:00.000Z");
const EXPIRED_NOTIFICATION_NOW_MS = Date.parse("2026-05-11T00:00:00.000Z");

describe("LINE notification jobs", () => {
  let d1: SqliteD1Database;

  beforeEach(() => {
    vi.clearAllMocks();
    d1 = createMigratedSqliteD1();
  });

  afterEach(() => {
    d1.sqlite.close();
  });

  const createRequest = (): PublicReservationRequest => ({
    idempotencyKey: "public_submit_line_1",
    storeId: "kyoto",
    serviceId: "service_kyoto_default_60",
    resourceId: "resource_kyoto_calendar",
    startAt: "2026-06-01T01:00:00.000Z",
    customer: {
      displayName: "予約 太郎",
      displayNameKana: "ヨヤク タロウ",
      phone: "075-123-4567"
    },
    consents: {
      noticeVersion: "notice-terms-2026-06",
      cancellationPolicyVersion: "cancel-2026-08-31",
      privacyPolicyVersion: "privacy-2026-06"
    }
  });

  const removeOwnerJobsFromCustomerLineFixture = (reservationId: string) => {
    d1.sqlite
      .prepare("DELETE FROM notification_jobs WHERE reservation_id = ? AND recipient_type = 'owner'")
      .run(reservationId);
  };

  const createReservationWithNotifications = async () => {
    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest(),
      line: {
        lineUserId: "line_user_1",
        channelId: "line_channel_id"
      },
      now: () => SUBMIT_NOW_MS
    });
    if (!result.ok) {
      throw new Error(result.reason);
    }
    removeOwnerJobsFromCustomerLineFixture(result.reservationId);
    // pending_approval no longer auto-enqueues a customer notification (free-tier
    // budget conservation). Insert a notification job directly so the dispatcher
    // tests exercise the full send/retry/supersede lifecycle.
    const customerId = (
      d1.sqlite
        .prepare("SELECT customer_id FROM reservations WHERE id = ?")
        .get(result.reservationId) as { customer_id: string }
    ).customer_id;
    d1.sqlite
      .prepare(
        `INSERT INTO notification_jobs (
           id, dedupe_key, template_key, recipient_type, recipient_id,
           reservation_id, status, available_at
         ) VALUES (?, ?, 'reservation_pending_received', 'customer', ?, ?, 'queued', ?)`
      )
      .run(
        crypto.randomUUID(),
        `reservation:${result.reservationId}:template:reservation_pending_received:revision:1`,
        customerId,
        result.reservationId,
        new Date(SUBMIT_NOW_MS).toISOString()
      );
    return result.reservationId;
  };

  const seedRejectedReservation = async (rejectionReason: string | null) => {
    const reservation = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest(),
      line: { lineUserId: "line_user_1", channelId: "line_channel_id" },
      now: () => SUBMIT_NOW_MS
    });
    if (!reservation.ok) {
      throw new Error(reservation.reason);
    }
    removeOwnerJobsFromCustomerLineFixture(reservation.reservationId);
    const customerId = (
      d1.sqlite
        .prepare("SELECT customer_id FROM reservations WHERE id = ?")
        .get(reservation.reservationId) as { customer_id: string }
    ).customer_id;
    // reservation_rejected は status='rejected' のときのみ eligible。
    d1.sqlite
      .prepare("UPDATE reservations SET status = 'rejected', rejection_reason = ? WHERE id = ?")
      .run(rejectionReason, reservation.reservationId);
    d1.sqlite
      .prepare(
        `INSERT INTO notification_jobs (
           id, dedupe_key, template_key, recipient_type, recipient_id,
           reservation_id, status, available_at
         ) VALUES (?, ?, 'reservation_rejected', 'customer', ?, ?, 'queued', ?)`
      )
      .run(
        crypto.randomUUID(),
        `reservation:${reservation.reservationId}:template:reservation_rejected:revision:1`,
        customerId,
        reservation.reservationId,
        new Date(SUBMIT_NOW_MS).toISOString()
      );
    return reservation.reservationId;
  };

  const dispatchOneAndReadText = async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ sentMessages: [{ id: "line_message_reject_1" }] })
    ) as unknown as typeof fetch;
    const dispatch = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "line_channel_access_token" },
      fetcher: fetchMock,
      now: () => ACTIVE_NOTIFICATION_NOW_MS
    });
    expect(dispatch).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    const [, init] = vi.mocked(fetchMock).mock.calls[0] ?? [];
    const body = (await new Response(init?.body).json()) as {
      to: string;
      messages: Array<{ type: string; text: string }>;
    };
    return body;
  };

  it("includes the rejection reason in the customer reservation_rejected push", async () => {
    await seedRejectedReservation("ご希望の日時は満席のためお取りできませんでした");
    const body = await dispatchOneAndReadText();
    expect(body.to).toBe("line_user_1");
    expect(body.messages[0].text).toContain("予約をお取りできませんでした。");
    expect(body.messages[0].text).toContain("理由: ご希望の日時は満席のためお取りできませんでした");
  });

  it("omits the reason line when reservation_rejected has no rejection_reason", async () => {
    await seedRejectedReservation(null);
    const body = await dispatchOneAndReadText();
    expect(body.messages[0].text).toContain("予約をお取りできませんでした。");
    expect(body.messages[0].text).not.toContain("理由:");
  });

  it("never claims retired change_request_* jobs left from before the retirement", async () => {
    const reservationId = await createReservationWithNotifications();
    // 廃止前の残骸を模した queued 行。claim SQL の template リストから外れているため
    // dispatcher は拾わず、送信もステータス遷移も起きない (歴史行の安全な放置)。
    d1.sqlite
      .prepare(
        `INSERT INTO notification_jobs (
           id, dedupe_key, template_key, recipient_type, recipient_id,
           reservation_id, status, available_at
         ) VALUES (?, ?, 'change_request_rejected', 'customer', 'line_user_1', ?, 'queued', ?)`
      )
      .run(
        crypto.randomUUID(),
        `change_request:legacy:template:change_request_rejected`,
        reservationId,
        new Date(SUBMIT_NOW_MS).toISOString()
      );
    // 通常 template (reservation_pending_received) だけが処理される。
    const fetchMock = vi.fn(async () =>
      Response.json({ sentMessages: [{ id: "line_message_legacy_1" }] })
    ) as unknown as typeof fetch;
    const dispatch = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "line_channel_access_token" },
      fetcher: fetchMock,
      now: () => ACTIVE_NOTIFICATION_NOW_MS
    });
    expect(dispatch).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    const legacy = d1.sqlite
      .prepare("SELECT status FROM notification_jobs WHERE template_key = 'change_request_rejected'")
      .get() as { status: string };
    expect(legacy.status).toBe("queued");
  });

  it("renders the customer reservation_confirmed push as a Flex card with a single message", async () => {
    const reservation = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest(),
      line: { lineUserId: "line_user_1", channelId: "line_channel_id" },
      now: () => SUBMIT_NOW_MS
    });
    if (!reservation.ok) {
      throw new Error(reservation.reason);
    }
    removeOwnerJobsFromCustomerLineFixture(reservation.reservationId);
    const customerId = (
      d1.sqlite
        .prepare("SELECT customer_id FROM reservations WHERE id = ?")
        .get(reservation.reservationId) as { customer_id: string }
    ).customer_id;
    // A reservation_confirmed push is only eligible once the reservation is
    // actually confirmed (isLineNotificationStillEligible), so promote it.
    d1.sqlite
      .prepare("UPDATE reservations SET status = 'confirmed' WHERE id = ?")
      .run(reservation.reservationId);
    d1.sqlite
      .prepare(
        `INSERT INTO notification_jobs (
           id, dedupe_key, template_key, recipient_type, recipient_id,
           reservation_id, status, available_at
         ) VALUES (?, ?, 'reservation_confirmed', 'customer', ?, ?, 'queued', ?)`
      )
      .run(
        crypto.randomUUID(),
        `reservation:${reservation.reservationId}:template:reservation_confirmed:revision:1`,
        customerId,
        reservation.reservationId,
        new Date(SUBMIT_NOW_MS).toISOString()
      );

    const fetchMock = vi.fn(async () =>
      Response.json({ sentMessages: [{ id: "line_message_flex_1" }] })
    ) as unknown as typeof fetch;

    const dispatch = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: {
        LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "line_channel_access_token",
        LINE_LIFF_ID: "1656000000-abcDEF12"
      },
      fetcher: fetchMock,
      now: () => ACTIVE_NOTIFICATION_NOW_MS
    });
    expect(dispatch).toEqual({ processed: 1, succeeded: 1, failed: 0 });

    const [, init] = vi.mocked(fetchMock).mock.calls[0] ?? [];
    const body = (await new Response(init?.body).json()) as {
      to: string;
      messages: Array<Record<string, unknown>>;
    };
    expect(body.to).toBe("line_user_1");
    // A Flex push is still ONE message → one monthly-quota unit, same as text.
    expect(body.messages).toHaveLength(1);
    const msg = body.messages[0] as {
      type: string;
      altText: string;
      contents: Record<string, any>;
    };
    expect(msg.type).toBe("flex");
    expect(typeof msg.altText).toBe("string");
    expect(msg.contents.type).toBe("bubble");
    expect(msg.contents.header.contents[1].text).toBe("ご予約が確定しました");
    // Self-service button deep-links into the configured reservation LIFF.
    expect(msg.contents.footer.contents[0].action.uri).toBe("https://liff.line.me/1656000000-abcDEF12/customer/reservations");

    const log = d1.sqlite
      .prepare("SELECT sent_count FROM notification_logs WHERE reservation_id = ?")
      .get(reservation.reservationId) as { sent_count: number };
    expect(log.sent_count).toBe(1);
  });

  it("sends customer LINE push notifications with no phone numbers or internal details in the message", async () => {
    const reservationId = await createReservationWithNotifications();
    const fetchMock = vi.fn(async () =>
      Response.json({
        sentMessages: [
          {
            id: "line_message_1"
          }
        ]
      })
    ) as unknown as typeof fetch;

    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: {
        LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "line_channel_access_token"
      },
      fetcher: fetchMock,
      now: () => ACTIVE_NOTIFICATION_NOW_MS
    });

    expect(result).toEqual({
      processed: 1,
      succeeded: 1,
      failed: 0
    });
    const [url, init] = vi.mocked(fetchMock).mock.calls[0] ?? [];
    expect(url).toBe("https://api.line.me/v2/bot/message/push");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer line_channel_access_token",
      "Content-Type": "application/json"
    });
    expect(init?.headers).toHaveProperty("X-Line-Retry-Key");

    const payloadText = String(init?.body);
    expect(payloadText).not.toContain("075");
    expect(payloadText).not.toContain("syncToken");
    await expect(new Response(init?.body).json()).resolves.toMatchObject({
      to: "line_user_1",
      messages: [
        {
          type: "text"
        }
      ],
      notificationDisabled: false
    });

    const job = d1.sqlite
      .prepare("SELECT status, last_error FROM notification_jobs WHERE recipient_type = 'customer'")
      .get() as { status: string; last_error: string | null };
    expect(job).toEqual({
      status: "succeeded",
      last_error: null
    });
    const log = d1.sqlite
      .prepare("SELECT status, provider_message_id, sent_count FROM notification_logs WHERE reservation_id = ?")
      .get(reservationId) as { status: string; provider_message_id: string; sent_count: number };
    expect(log).toEqual({
      status: "succeeded",
      provider_message_id: "line_message_1",
      sent_count: 1
    });
  });

  it("does not send a LINE push when another worker claims the job first", async () => {
    await createReservationWithNotifications();
    const fetchMock = vi.fn(async () =>
      Response.json({
        sentMessages: [
          {
            id: "line_message_lost_claim"
          }
        ]
      })
    ) as unknown as typeof fetch;
    const claimLossDb = {
      prepare(sql: string) {
        const statement = (d1 as unknown as D1Database).prepare(sql);
        if (sql.includes("UPDATE notification_jobs") && sql.includes("SET status = 'processing'")) {
          return {
            bind(...values: unknown[]) {
              const bound = statement.bind(...values);
              return {
                async run() {
                  d1.sqlite
                    .prepare(
                      `
                        UPDATE notification_jobs
                        SET status = 'processing',
                            attempts = attempts + 1,
                            locked_until = '2026-05-09T23:20:00.000Z'
                        WHERE id = ?
                      `
                    )
                    .run(String(values[2]));
                  return bound.run();
                }
              } as unknown as D1PreparedStatement;
            }
          } as unknown as D1PreparedStatement;
        }
        return statement;
      },
      batch(statements: D1PreparedStatement[]) {
        return d1.batch(statements);
      }
    } as unknown as D1Database;

    const result = await processDueLineNotificationJobs({
      db: claimLossDb,
      env: {
        LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "line_channel_access_token"
      },
      fetcher: fetchMock,
      now: () => ACTIVE_NOTIFICATION_NOW_MS,
      maxJobs: 1
    });

    expect(result).toEqual({
      processed: 0,
      succeeded: 0,
      failed: 0
    });
    expect(fetchMock).not.toHaveBeenCalled();
    const logs = d1.sqlite.prepare("SELECT COUNT(*) AS count FROM notification_logs").get() as { count: number };
    expect(logs.count).toBe(0);
  });

  it("does not finalize a LINE notification when its processing claim is lost after provider send", async () => {
    await createReservationWithNotifications();
    const fetchMock = vi.fn(async () =>
      Response.json({
        sentMessages: [
          {
            id: "line_message_stale_worker_1"
          }
        ]
      })
    ) as unknown as typeof fetch;
    const claimLossDb = {
      prepare: d1.prepare.bind(d1),
      batch: async (statements: D1PreparedStatement[]) => {
        d1.sqlite
          .prepare(
            `
              UPDATE notification_jobs
              SET status = 'queued',
                  locked_until = NULL,
                  updated_at = '2026-05-09T23:10:00.001Z'
              WHERE recipient_type = 'customer'
            `
          )
          .run();
        return d1.batch(statements);
      }
    } as unknown as D1Database;

    const result = await processDueLineNotificationJobs({
      db: claimLossDb,
      env: {
        LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "line_channel_access_token"
      },
      fetcher: fetchMock,
      now: () => ACTIVE_NOTIFICATION_NOW_MS,
      maxJobs: 1
    });

    expect(result).toEqual({
      processed: 1,
      succeeded: 0,
      failed: 0
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const job = d1.sqlite
      .prepare("SELECT status, locked_until, last_error FROM notification_jobs WHERE recipient_type = 'customer'")
      .get() as { status: string; locked_until: string | null; last_error: string | null };
    expect(job).toEqual({
      status: "queued",
      locked_until: null,
      last_error: null
    });
    const logs = d1.sqlite.prepare("SELECT COUNT(*) AS count FROM notification_logs").get() as { count: number };
    expect(logs.count).toBe(0);
  });

  it("auto-reclaims stale processing LINE notification jobs whose locked_until has expired (codex #9)", async () => {
    const reservationId = await createReservationWithNotifications();
    d1.sqlite
      .prepare(
        `
          UPDATE notification_jobs
          SET status = 'processing',
              attempts = 1,
              locked_until = '2026-05-09T23:09:00.000Z'
          WHERE recipient_type = 'customer'
        `
      )
      .run();
    const fetchMock = vi.fn(async () =>
      Response.json({
        sentMessages: [
          {
            id: "line_message_recovered_processing_1"
          }
        ]
      })
    ) as unknown as typeof fetch;

    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: {
        LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "line_channel_access_token"
      },
      fetcher: fetchMock,
      now: () => ACTIVE_NOTIFICATION_NOW_MS
    });

    // The dequeue + claim now reclaim stale `status=processing AND locked_until<now`
    // rows (codex #9). attempts increments to 2, the push succeeds, and the job
    // finishes as `succeeded` instead of being orphaned for manual recovery.
    expect(result).toEqual({
      processed: 1,
      succeeded: 1,
      failed: 0
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const job = d1.sqlite
      .prepare("SELECT status, attempts, locked_until FROM notification_jobs WHERE recipient_type = 'customer'")
      .get() as { status: string; attempts: number; locked_until: string | null };
    expect(job.status).toBe("succeeded");
    expect(job.attempts).toBe(2);
    expect(job.locked_until).toBeNull();
    const logs = d1.sqlite
      .prepare("SELECT COUNT(*) AS count FROM notification_logs WHERE reservation_id = ?")
      .get(reservationId) as { count: number };
    expect(logs.count).toBe(1);
  });

  it("dead-letters stale processing LINE notification jobs that already hit MAX_ATTEMPTS instead of reclaiming again (codex #9)", async () => {
    const reservationId = await createReservationWithNotifications();
    // attempts = 5 = MAX_ATTEMPTS. A worker crashed after markJobProcessing pushed
    // attempts to the cap, so we must NOT reclaim and increment further — instead
    // the row must be transitioned to `dead` for explicit admin attention.
    d1.sqlite
      .prepare(
        `
          UPDATE notification_jobs
          SET status = 'processing',
              attempts = 5,
              locked_until = '2026-05-09T23:09:00.000Z'
          WHERE recipient_type = 'customer'
        `
      )
      .run();
    const fetchMock = vi.fn() as unknown as typeof fetch;

    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: {
        LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "line_channel_access_token"
      },
      fetcher: fetchMock,
      now: () => ACTIVE_NOTIFICATION_NOW_MS
    });

    expect(result).toEqual({
      processed: 0,
      succeeded: 0,
      failed: 0
    });
    expect(fetchMock).not.toHaveBeenCalled();
    const job = d1.sqlite
      .prepare("SELECT status, attempts, locked_until, last_error FROM notification_jobs WHERE recipient_type = 'customer'")
      .get() as { status: string; attempts: number; locked_until: string | null; last_error: string | null };
    expect(job.status).toBe("dead");
    expect(job.attempts).toBe(5);
    expect(job.locked_until).toBeNull();
    expect(job.last_error).toBe("exhausted_after_repeated_crash");
    const logs = d1.sqlite
      .prepare("SELECT COUNT(*) AS count FROM notification_logs WHERE reservation_id = ?")
      .get(reservationId) as { count: number };
    expect(logs.count).toBe(0);
    // Crash-loop dead-lettering never reaches a per-job catch, so the sweep is
    // the sole capture point for these silent deaths.
    expect(safeCaptureException).toHaveBeenCalledTimes(1);
    expect(safeCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "line notification jobs dead-lettered after repeated crash: 1" }),
      expect.objectContaining({
        tags: { dispatcher: "line_push", reason: "exhausted_after_repeated_crash" }
      })
    );
  });

  it("keeps the owner email marker when the crash-loop sweep dead-letters a job", async () => {
    const reservationId = await createReservationWithNotifications();
    d1.sqlite
      .prepare(
        `UPDATE notification_jobs
         SET status = 'processing',
             attempts = 5,
             locked_until = '2026-05-09T23:09:00.000Z',
             email_inflight_at = '2026-05-09T23:08:00.000Z'
         WHERE recipient_type = 'customer'`
      )
      .run();
    d1.sqlite
      .prepare(
        `INSERT INTO notification_jobs (
           id, dedupe_key, template_key, recipient_type, recipient_id,
           reservation_id, status, attempts, available_at, locked_until, email_inflight_at
         ) VALUES (?, ?, 'reservation_confirmed', 'owner', ?, ?, 'processing', 5, ?, ?, ?)`
      )
      .run(
        "job_owner_crash_loop",
        `reservation:${reservationId}:template:reservation_confirmed:owner-crash-loop`,
        "owner_line_user",
        reservationId,
        new Date(SUBMIT_NOW_MS).toISOString(),
        "2026-05-09T23:09:00.000Z",
        "2026-05-09T23:08:00.000Z"
      );

    await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "line_channel_access_token" },
      fetcher: vi.fn() as unknown as typeof fetch,
      now: () => ACTIVE_NOTIFICATION_NOW_MS
    });

    expect(
      d1.sqlite
        .prepare(
          `SELECT recipient_type, status, email_inflight_at
           FROM notification_jobs
           ORDER BY recipient_type`
        )
        .all()
    ).toEqual([
      {
        recipient_type: "customer",
        status: "dead",
        email_inflight_at: "2026-05-09T23:08:00.000Z"
      },
      {
        recipient_type: "owner",
        status: "dead",
        email_inflight_at: "2026-05-09T23:08:00.000Z"
      }
    ]);
  });

  it("marks LINE notification jobs retryable without storing the channel access token when push fails", async () => {
    await createReservationWithNotifications();
    const fetchMock = vi.fn(async () => Response.json({ message: "rate limited" }, { status: 429 })) as unknown as typeof fetch;

    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: {
        LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "secret_line_token"
      },
      fetcher: fetchMock,
      now: () => ACTIVE_NOTIFICATION_NOW_MS
    });

    expect(result).toEqual({
      processed: 1,
      succeeded: 0,
      failed: 1
    });
    const job = d1.sqlite
      .prepare("SELECT status, last_error FROM notification_jobs WHERE recipient_type = 'customer'")
      .get() as { status: string; last_error: string };
    expect(job.status).toBe("retryable");
    expect(job.last_error).toBe("line-http-429");
    expect(job.last_error).not.toContain("secret_line_token");
    // Retryable value-based failures are expected retry traffic — capture
    // happens only on the dead transition (see the test below).
    expect(safeCaptureException).not.toHaveBeenCalled();
  });

  it.each([0, 4])("leaves quota-stop monitoring to operations without reporting an exception (prior attempts %i)", async (attempts) => {
    await createReservationWithNotifications();
    d1.sqlite.prepare("UPDATE notification_jobs SET attempts = ? WHERE recipient_type = 'customer'").run(attempts);
    await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "secret_line_token" },
      fetcher: vi.fn(async () => Response.json({ message: "You have reached your monthly limit." }, { status: 429 })),
      now: () => ACTIVE_NOTIFICATION_NOW_MS
    });
    expect(d1.sqlite.prepare("SELECT status, last_error FROM notification_jobs WHERE recipient_type = 'customer'").get())
      .toEqual({ status: "dead", last_error: "line-monthly-quota-exhausted" });
    expect(safeCaptureException).not.toHaveBeenCalled();
  });

  it("captures a value-based push failure exactly once — on the attempt that kills the job", async () => {
    await createReservationWithNotifications();
    // Next claim increments attempts to MAX_ATTEMPTS (5) = the dead transition.
    d1.sqlite
      .prepare("UPDATE notification_jobs SET attempts = 4 WHERE recipient_type = 'customer'")
      .run();
    const fetchMock = vi.fn(async () => Response.json({ message: "rate limited" }, { status: 429 })) as unknown as typeof fetch;

    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: {
        LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "secret_line_token"
      },
      fetcher: fetchMock,
      now: () => ACTIVE_NOTIFICATION_NOW_MS
    });

    expect(result.failed).toBe(1);
    const job = d1.sqlite
      .prepare("SELECT status FROM notification_jobs WHERE recipient_type = 'customer'")
      .get() as { status: string };
    expect(job.status).toBe("dead");
    expect(safeCaptureException).toHaveBeenCalledTimes(1);
    expect(safeCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "line push failed permanently: line-http-429" }),
      expect.objectContaining({ tags: { dispatcher: "line_push", reason: "line-http-429" } })
    );
  });

  it("does not capture when a raced claim loses the markJobFailure CAS on the dead attempt", async () => {
    await createReservationWithNotifications();
    d1.sqlite
      .prepare("UPDATE notification_jobs SET attempts = 4 WHERE recipient_type = 'customer'")
      .run();
    // Simulate a rival worker re-claiming the row mid-push: the fetch mock
    // bumps locked_until, so this worker's markJobFailure CAS matches 0 rows.
    // The dead-transition capture must then NOT fire — the rival claim owns
    // the job's outcome (and its capture) now.
    const fetchMock = vi.fn(async () => {
      d1.sqlite
        .prepare("UPDATE notification_jobs SET locked_until = '2026-05-09T23:59:00.000Z' WHERE recipient_type = 'customer'")
        .run();
      return Response.json({ message: "rate limited" }, { status: 429 });
    }) as unknown as typeof fetch;

    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: {
        LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "line_channel_access_token"
      },
      fetcher: fetchMock,
      now: () => ACTIVE_NOTIFICATION_NOW_MS
    });

    expect(result.failed).toBe(0);
    const job = d1.sqlite
      .prepare("SELECT status FROM notification_jobs WHERE recipient_type = 'customer'")
      .get() as { status: string };
    expect(job.status).toBe("processing");
    expect(safeCaptureException).not.toHaveBeenCalled();
  });

  it("captures a thrown push failure once (original exception) on the dead attempt — no synthetic re-capture", async () => {
    // attemptLinePush's catch already captures the ORIGINAL exception as
    // line-push-unhandled; the dead-transition capture must not add a second
    // synthetic event for the same failure.
    await createReservationWithNotifications();
    d1.sqlite
      .prepare("UPDATE notification_jobs SET attempts = 4 WHERE recipient_type = 'customer'")
      .run();
    const fetchError = new Error("network reset");
    const fetchMock = vi.fn(async () => {
      throw fetchError;
    }) as unknown as typeof fetch;

    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: {
        LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "secret_line_token"
      },
      fetcher: fetchMock,
      now: () => ACTIVE_NOTIFICATION_NOW_MS
    });

    expect(result.failed).toBe(1);
    const job = d1.sqlite
      .prepare("SELECT status, last_error FROM notification_jobs WHERE recipient_type = 'customer'")
      .get() as { status: string; last_error: string };
    expect(job.status).toBe("dead");
    expect(job.last_error).toBe("line-push-unhandled");
    expect(safeCaptureException).toHaveBeenCalledTimes(1);
    expect(safeCaptureException).toHaveBeenCalledWith(
      fetchError,
      expect.objectContaining({ tags: { dispatcher: "line_push", reason: "line-push-unhandled" } })
    );
  });

  it("treats 409 (retry key already accepted) as success — delivered on a prior timed-out attempt", async () => {
    // With the 30s outbound timeout, LINE can accept a push while the Worker
    // aborts the response. The retry carries the same X-Line-Retry-Key and
    // LINE answers 409 = "already accepted, do not retry". That MUST resolve
    // the job as succeeded (not retryable/dead) or an already-delivered
    // notification would be re-sent or dead-lettered.
    await createReservationWithNotifications();
    const fetchMock = vi.fn(async () =>
      new Response(null, {
        status: 409,
        headers: { "x-line-accepted-request-id": "req-prior-accept" }
      })
    ) as unknown as typeof fetch;

    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: {
        LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "secret_line_token"
      },
      fetcher: fetchMock,
      now: () => ACTIVE_NOTIFICATION_NOW_MS
    });

    expect(result).toEqual({
      processed: 1,
      succeeded: 1,
      failed: 0
    });
    const job = d1.sqlite
      .prepare("SELECT status FROM notification_jobs WHERE recipient_type = 'customer'")
      .get() as { status: string };
    expect(job.status).toBe("succeeded");
    const log = d1.sqlite
      .prepare("SELECT status, provider_message_id FROM notification_logs ORDER BY rowid DESC LIMIT 1")
      .get() as { status: string; provider_message_id: string | null };
    expect(log.status).toBe("succeeded");
    expect(log.provider_message_id).toBe("accepted:req-prior-accept");
  });

  it("marks LINE notification jobs retryable when LINE returns malformed JSON", async () => {
    await createReservationWithNotifications();
    const fetchMock = vi.fn(async () =>
      new Response("{", {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      })
    ) as unknown as typeof fetch;

    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: {
        LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "line_channel_access_token"
      },
      fetcher: fetchMock,
      now: () => ACTIVE_NOTIFICATION_NOW_MS
    });

    expect(result).toEqual({
      processed: 1,
      succeeded: 0,
      failed: 1
    });
    const state = d1.sqlite
      .prepare(
        `
          SELECT
            (SELECT status FROM notification_jobs WHERE recipient_type = 'customer') AS jobStatus,
            (SELECT last_error FROM notification_jobs WHERE recipient_type = 'customer') AS lastError,
            (SELECT status FROM notification_logs WHERE recipient_type = 'customer') AS logStatus
        `
      )
      .get() as { jobStatus: string; lastError: string; logStatus: string };
    expect(state).toEqual({
      jobStatus: "retryable",
      lastError: "line-invalid-json",
      logStatus: "failed"
    });
  });

  it("keeps dead LINE notification jobs and last_error in D1 after final retry failure", async () => {
    await createReservationWithNotifications();
    d1.sqlite
      .prepare(
        `
          UPDATE notification_jobs
          SET attempts = 4
          WHERE recipient_type = 'customer'
        `
      )
      .run();
    const fetchMock = vi.fn(async () => Response.json({ message: "rate limited" }, { status: 429 })) as unknown as typeof fetch;

    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: {
        LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "secret_line_token"
      },
      fetcher: fetchMock,
      now: () => ACTIVE_NOTIFICATION_NOW_MS
    });

    expect(result).toEqual({
      processed: 1,
      succeeded: 0,
      failed: 1
    });
    const job = d1.sqlite
      .prepare("SELECT status, attempts, last_error FROM notification_jobs WHERE recipient_type = 'customer'")
      .get() as { status: string; attempts: number; last_error: string };
    expect(job).toEqual({
      status: "dead",
      attempts: 5,
      last_error: "line-http-429"
    });
    expect(job.last_error).not.toContain("secret_line_token");
  });

  it("supersedes overdue pending notifications before sending LINE push", async () => {
    await createReservationWithNotifications();
    const fetchMock = vi.fn(async () =>
      Response.json({
        sentMessages: [
          {
            id: "line_message_should_not_send"
          }
        ]
      })
    ) as unknown as typeof fetch;

    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: {
        LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "line_channel_access_token"
      },
      fetcher: fetchMock,
      now: () => EXPIRED_NOTIFICATION_NOW_MS
    });

    expect(result).toEqual({
      processed: 1,
      succeeded: 1,
      failed: 0
    });
    expect(fetchMock).not.toHaveBeenCalled();
    const job = d1.sqlite
      .prepare("SELECT status, last_error FROM notification_jobs WHERE recipient_type = 'customer'")
      .get() as { status: string; last_error: string | null };
    expect(job).toEqual({
      status: "succeeded",
      last_error: "superseded_by_reservation_state"
    });
    const logs = d1.sqlite.prepare("SELECT COUNT(*) AS count FROM notification_logs").get() as { count: number };
    expect(logs.count).toBe(0);
  });

  it("supersedes pending notifications when the deadline passes after fetching the job", async () => {
    await createReservationWithNotifications();
    const fetchMock = vi.fn(async () =>
      Response.json({
        sentMessages: [
          {
            id: "line_message_should_not_send_after_boundary"
          }
        ]
      })
    ) as unknown as typeof fetch;
    const now = vi.fn()
      .mockReturnValueOnce(ACTIVE_NOTIFICATION_NOW_MS)
      .mockReturnValue(EXPIRED_NOTIFICATION_NOW_MS);

    const result = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: {
        LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "line_channel_access_token"
      },
      fetcher: fetchMock,
      now,
      maxJobs: 1
    });

    expect(result).toEqual({
      processed: 1,
      succeeded: 1,
      failed: 0
    });
    expect(fetchMock).not.toHaveBeenCalled();
    const job = d1.sqlite
      .prepare("SELECT status, last_error FROM notification_jobs WHERE recipient_type = 'customer'")
      .get() as { status: string; last_error: string | null };
    expect(job).toEqual({
      status: "succeeded",
      last_error: "superseded_by_reservation_state"
    });
    const logs = d1.sqlite.prepare("SELECT COUNT(*) AS count FROM notification_logs").get() as { count: number };
    expect(logs.count).toBe(0);
  });

  it("sends every customer-facing admin notification template created by reservation workflows", async () => {
    const reservationId = await createReservationWithNotifications();
    const customer = d1.sqlite
      .prepare("SELECT customer_id FROM reservations WHERE id = ?")
      .get(reservationId) as { customer_id: string };
    const templates = [
      {
        key: "reservation_rejected",
        status: "rejected",
        lead: "予約をお取りできませんでした。"
      },
      {
        key: "reservation_time_changed",
        status: "confirmed",
        lead: "予約日時が変更されました。"
      },
      {
        key: "reservation_cancelled_by_admin",
        status: "cancelled_by_admin",
        lead: "予約がキャンセルされました。"
      }
    ];
    const fetchMock = vi.fn(async () =>
      Response.json({
        sentMessages: [
          {
            id: "line_message_admin_template"
          }
        ]
      })
    ) as unknown as typeof fetch;

    d1.sqlite.prepare("DELETE FROM notification_jobs").run();
    for (const template of templates) {
      d1.sqlite
        .prepare("UPDATE reservations SET status = ?, updated_at = '2026-05-09T23:10:00.000Z' WHERE id = ?")
        .run(template.status, reservationId);
      d1.sqlite
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
              available_at
            ) VALUES (?, ?, ?, 'customer', ?, ?, 'queued', '2026-05-09T00:00:00.000Z')
          `
        )
        .run(
          `line_job_${template.key}`,
          `reservation:${reservationId}:template:${template.key}:test`,
          template.key,
          customer.customer_id,
          reservationId
        );

      const result = await processDueLineNotificationJobs({
        db: d1 as unknown as D1Database,
        env: {
          LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "line_channel_access_token"
        },
        fetcher: fetchMock,
        maxJobs: 1,
        now: () => ACTIVE_NOTIFICATION_NOW_MS
      });

      expect(result).toEqual({
        processed: 1,
        succeeded: 1,
        failed: 0
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const sentTexts = vi.mocked(fetchMock).mock.calls.map(([, init]) => {
      const body = JSON.parse(String(init?.body)) as { messages: { text: string }[] };
      return body.messages[0]?.text ?? "";
    });
    for (const template of templates) {
      expect(sentTexts.join("\n")).toContain(template.lead);
    }
    expect(sentTexts.join("\n")).not.toContain("075");

    const succeeded = d1.sqlite
      .prepare("SELECT COUNT(*) AS count FROM notification_jobs WHERE status = 'succeeded'")
      .get() as { count: number };
    expect(succeeded.count).toBe(3);
  });

  it("does not send a second LINE push when the same queue job is processed again after success", async () => {
    await createReservationWithNotifications();
    const fetchMock = vi.fn(async () =>
      Response.json({
        sentMessages: [
          {
            id: "line_message_redelivery_1"
          }
        ]
      })
    ) as unknown as typeof fetch;

    const first = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: {
        LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "line_channel_access_token"
      },
      fetcher: fetchMock,
      now: () => ACTIVE_NOTIFICATION_NOW_MS
    });
    const redelivery = await processDueLineNotificationJobs({
      db: d1 as unknown as D1Database,
      env: {
        LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "line_channel_access_token"
      },
      fetcher: fetchMock,
      now: () => ACTIVE_NOTIFICATION_NOW_MS + 10_000
    });

    expect(first).toEqual({
      processed: 1,
      succeeded: 1,
      failed: 0
    });
    expect(redelivery).toEqual({
      processed: 0,
      succeeded: 0,
      failed: 0
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const logs = d1.sqlite.prepare("SELECT COUNT(*) AS count FROM notification_logs").get() as { count: number };
    expect(logs.count).toBe(1);
  });
});

const DAILY_OPS_RENDER_NOW_MS = Date.parse("2026-06-15T11:00:00.000Z");
const OWNER_EMAIL_RECIPIENT_ID = "email:owner";

const emptyDailyOpsStats = (dailyCleanupLastRunAt: string | null) => ({
  today_reservations: [],
  tomorrow_reservations: [],
  open_conflicts: 0,
  dead_notification_jobs_24h: 0,
  dead_calendar_sync_jobs_24h: 0,
  past_end_still_confirmed: [],
  unswept_past_grace: [],
  auto_completed_today: 0,
  daily_cleanup_last_run_at: dailyCleanupLastRunAt
});

describe("daily ops summary daily-cleanup heartbeat rendering", () => {
  let d1: SqliteD1Database;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(DAILY_OPS_RENDER_NOW_MS);
    d1 = createMigratedSqliteD1();
  });

  afterEach(() => {
    vi.useRealTimers();
    d1.sqlite.close();
  });

  const seedDailyOpsJob = (stats: ReturnType<typeof emptyDailyOpsStats>) => {
    d1.sqlite
      .prepare(
        `INSERT INTO notification_jobs (
           id, dedupe_key, template_key, recipient_type, recipient_id,
           reservation_id, status, attempts, available_at, payload_json
         ) VALUES (?, ?, 'daily_ops_summary', 'owner', ?, NULL, 'queued', 0, ?, ?)`
      )
      .run(
        "job_daily_cleanup_render",
        `daily_ops_summary:2026-06-15:${OWNER_EMAIL_RECIPIENT_ID}`,
        OWNER_EMAIL_RECIPIENT_ID,
        "2026-06-15T11:00:00.000Z",
        JSON.stringify({ date_jst: "2026-06-15", stats })
      );
  };

  const renderDailyOpsEmail = async (): Promise<string> => {
    const emailSend = vi.fn(async (_message: { to: string; subject: string; text: string }) => ({
      messageId: "email_daily_cleanup"
    }));
    const fetchMock = vi.fn(async () =>
      Response.json({ sentMessages: [{ id: "unexpected" }] })
    ) as unknown as typeof fetch;
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
      now: () => DAILY_OPS_RENDER_NOW_MS + 5000,
      maxJobs: 5
    });
    expect(dispatchResult.succeeded).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    return emailSend.mock.calls[0]?.[0].text ?? "";
  };

  it("renders 実行済み for a run inside the report's JST day and adds no attention item", async () => {
    seedDailyOpsJob(emptyDailyOpsStats("2026-06-14T16:05:00.000Z"));
    const text = await renderDailyOpsEmail();
    expect(text).toContain("日次クリーンアップ（01:05 JST）: 実行済み 01:05");
    expect(text).not.toContain("記録なし");
    expect(text).not.toContain("【注意事項】");
    expect(text).not.toContain("日次クリーンアップが前夜に実行された記録がありません");
  });

  it("renders 記録なし and an attention item when last run is null", async () => {
    seedDailyOpsJob(emptyDailyOpsStats(null));
    const text = await renderDailyOpsEmail();
    expect(text).toContain("日次クリーンアップ（01:05 JST）: 記録なし");
    expect(text).toContain("【注意事項】");
    expect(text).toContain("日次クリーンアップが前夜に実行された記録がありません");
  });

  it("renders 記録なし and an attention item when the newest run predates the report's JST day", async () => {
    // 2026-06-13T16:05Z = 2026-06-14 01:05 JST — the night before last.
    seedDailyOpsJob(emptyDailyOpsStats("2026-06-13T16:05:00.000Z"));
    const text = await renderDailyOpsEmail();
    expect(text).toContain("日次クリーンアップ（01:05 JST）: 記録なし");
    expect(text).toContain("【注意事項】");
    expect(text).toContain("日次クリーンアップが前夜に実行された記録がありません");
  });

  it("treats the JST day start itself as inside the day", async () => {
    // 2026-06-14T15:00Z is exactly 2026-06-15 00:00 JST — the boundary is inclusive,
    // so an unusually early cron still counts as last night's run.
    seedDailyOpsJob(emptyDailyOpsStats("2026-06-14T15:00:00.000Z"));
    const text = await renderDailyOpsEmail();
    expect(text).toContain("日次クリーンアップ（01:05 JST）: 実行済み 00:00");
    expect(text).not.toContain("記録なし");
  });

  it("renders 記録なし for an unparseable timestamp instead of NaN", async () => {
    seedDailyOpsJob(emptyDailyOpsStats("not-a-timestamp"));
    const text = await renderDailyOpsEmail();
    expect(text).toContain("日次クリーンアップ（01:05 JST）: 記録なし");
    expect(text).toContain("日次クリーンアップが前夜に実行された記録がありません");
  });

  it("does not depend on the wall clock: a job rendered a day late still reads the same", async () => {
    seedDailyOpsJob(emptyDailyOpsStats("2026-06-14T16:05:00.000Z"));
    vi.setSystemTime(DAILY_OPS_RENDER_NOW_MS + 3 * 24 * 60 * 60 * 1000);
    const text = await renderDailyOpsEmail();
    expect(text).toContain("日次クリーンアップ（01:05 JST）: 実行済み 01:05");
    expect(text).not.toContain("記録なし");
  });

  it("keeps daily_cleanup_last_run_at through the safeStats whitelist", async () => {
    seedDailyOpsJob(emptyDailyOpsStats("2026-06-14T16:17:00.000Z"));
    const text = await renderDailyOpsEmail();
    expect(text).toContain("日次クリーンアップ（01:05 JST）: 実行済み 01:17");
    expect(text).not.toContain("記録なし");
  });
});
