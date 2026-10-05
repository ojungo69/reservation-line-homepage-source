/**
 * D3: Sentry capture verification for reminder dispatcher (B1) and
 * LINE notification dispatch failures (B6/B7).
 *
 * Uses real D1 (SQLite) to verify that:
 * - B1: per-row enqueue failure calls safeCaptureException with non-PII contexts
 * - B6: line-render-failed calls safeCaptureException
 * - B7: line-push-unhandled calls safeCaptureException
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock @sentry/cloudflare
vi.mock("@sentry/cloudflare", () => ({
  captureException: vi.fn(),
  init: vi.fn()
}));

import * as Sentry from "@sentry/cloudflare";
import { dispatchReservationReminders } from "../src/notifications/reminder-dispatcher";
import { processDueLineNotificationJobs } from "../src/line/notifications";
import { createPublicReservation, type PublicReservationRequest } from "../src/reservations/public-submit";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const SUBMIT_NOW_MS = Date.parse("2026-05-09T23:00:00.000Z");
const NOTIFICATION_NOW_MS = Date.parse("2026-05-09T23:10:00.000Z");

describe("B1: reminder dispatcher per-row Sentry capture", () => {
  let d1: SqliteD1Database;

  beforeEach(() => {
    d1 = createMigratedSqliteD1();
    vi.clearAllMocks();
  });

  afterEach(() => {
    d1.sqlite.close();
  });

  it("calls captureException on enqueue failure without PII in contexts", async () => {
    // Insert a store_settings row with reminder enabled
    const db = d1 as unknown as D1Database;

    // Seed data — we need a confirmed reservation with line_identity_id
    // that falls within the reminder window. We'll make the ENQUEUE SQL
    // fail by causing a unique constraint violation through a broken
    // notification_jobs table. The simplest approach: insert data that
    // makes the dispatcher find candidates, then break the insert.
    const request: PublicReservationRequest = {
      idempotencyKey: "sentry_b1_test_1",
      storeId: "kyoto",
      serviceId: "service_kyoto_default_60",
      resourceId: "resource_kyoto_calendar",
      startAt: "2026-05-10T01:00:00.000Z",
      customer: {
        displayName: "テスト 太郎",
        displayNameKana: "テスト タロウ",
        phone: "075-123-4567"
      },
      consents: {
        noticeVersion: "notice-terms-2026-06",
        cancellationPolicyVersion: "cancel-2026-08-31",
        privacyPolicyVersion: "privacy-2026-06"
      }
    };

    const createResult = await createPublicReservation({
      db,
      request,
      line: { lineUserId: "line_user_1", channelId: "line_channel_id" },
      now: () => SUBMIT_NOW_MS
    });
    expect(createResult.ok).toBe(true);

    if (!createResult.ok) return;

    // Approve the reservation so status = 'confirmed'
    await db
      .prepare("UPDATE reservations SET status = 'confirmed' WHERE id = ?")
      .bind(createResult.reservationId)
      .run();

    // Enable reminder for the store with a 60-min offset
    await db
      .prepare(
        "UPDATE store_settings SET reservation_reminder_offset_minutes = 60 WHERE store_id = 'kyoto'"
      )
      .run();

    // Now make notification_jobs INSERT fail by dropping a required column
    // Actually, let's use a simpler approach — make the db.prepare throw
    // by using a corrupted D1 binding via spy
    const originalPrepare = db.prepare.bind(db);
    let callCount = 0;
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      // Let the SELECT (find eligible) through, but fail on INSERT
      if (sql.includes("INSERT OR IGNORE INTO notification_jobs")) {
        callCount++;
        // Return a statement that throws on bind/run
        return {
          bind: () => ({
            run: () => {
              throw new Error("simulated_d1_write_failure");
            },
            all: () => {
              throw new Error("simulated_d1_write_failure");
            },
            first: () => {
              throw new Error("simulated_d1_write_failure");
            },
            raw: () => {
              throw new Error("simulated_d1_write_failure");
            }
          }),
          run: () => {
            throw new Error("simulated_d1_write_failure");
          },
          all: () => {
            throw new Error("simulated_d1_write_failure");
          },
          first: () => {
            throw new Error("simulated_d1_write_failure");
          },
          raw: () => {
            throw new Error("simulated_d1_write_failure");
          }
        } as unknown as D1PreparedStatement;
      }
      return originalPrepare(sql);
    });

    // Dispatch at a time within the reminder window (within 60 minutes of start_at)
    const withinWindowMs = Date.parse("2026-05-10T00:30:00.000Z");
    const result = await dispatchReservationReminders(db, withinWindowMs);

    // The row was scanned but enqueue failed
    expect(result.scanned).toBeGreaterThanOrEqual(1);
    expect(result.enqueued).toBe(0);

    // B1: captureException was called
    expect(Sentry.captureException).toHaveBeenCalled();
    const captureCall = vi.mocked(Sentry.captureException).mock.calls[0];
    const [error, context] = captureCall;

    // Error is the simulated failure
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("simulated_d1_write_failure");

    // Tags include dispatcher
    expect(context).toHaveProperty("tags.dispatcher", "reminder");

    // Contexts include reservation ID and store_id (non-PII)
    expect(context).toHaveProperty("contexts.reservation.id");
    expect(context).toHaveProperty("contexts.reservation.store_id", "kyoto");

    // line_identity_id must NOT be in contexts (PII guard)
    const ctxObj = (context as Record<string, unknown>).contexts as Record<
      string,
      Record<string, unknown>
    >;
    expect(ctxObj.reservation).not.toHaveProperty("line_identity_id");
  });
});

describe("B6/B7: LINE notification Sentry capture", () => {
  let d1: SqliteD1Database;

  beforeEach(() => {
    d1 = createMigratedSqliteD1();
    vi.clearAllMocks();
  });

  afterEach(() => {
    d1.sqlite.close();
  });

  const createReservationAndNotification = async () => {
    const db = d1 as unknown as D1Database;
    const request: PublicReservationRequest = {
      idempotencyKey: "sentry_b67_test",
      storeId: "kyoto",
      serviceId: "service_kyoto_default_60",
      resourceId: "resource_kyoto_calendar",
      startAt: "2026-06-01T01:00:00.000Z",
      customer: {
        displayName: "テスト 太郎",
        displayNameKana: "テスト タロウ",
        phone: "075-123-4567"
      },
      consents: {
        noticeVersion: "notice-terms-2026-06",
        cancellationPolicyVersion: "cancel-2026-08-31",
        privacyPolicyVersion: "privacy-2026-06"
      }
    };

    const result = await createPublicReservation({
      db,
      request,
      line: { lineUserId: "line_user_1", channelId: "line_channel_id" },
      now: () => SUBMIT_NOW_MS
    });
    if (!result.ok) throw new Error(result.reason);
    // pending_approval no longer auto-enqueues a notification. Insert directly
    // so the Sentry capture tests have a job to process.
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

  // B6: line-render-failed when buildLineMessageText throws
  // Seed: corrupt store.timezone to "Invalid/Zone" after reservation creation
  // so the default reminder template renderer's formatReservationStart call
  // (Intl.DateTimeFormat with the invalid timezone) throws.
  it("B6: captures line-render-failed when message renderer throws", async () => {
    await createReservationAndNotification();
    const db = d1 as unknown as D1Database;

    // Corrupt the store timezone so formatReservationStart throws RangeError
    // ("Invalid time zone specified: Invalid/Zone") inside buildLineMessageText.
    d1.sqlite.prepare("UPDATE stores SET timezone=? WHERE id=?").run("Invalid/Zone", "kyoto");

    // fetcher should not be hit because render fails first
    const fetcher = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;

    await processDueLineNotificationJobs({
      db,
      env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "test_token" },
      fetcher,
      now: () => NOTIFICATION_NOW_MS
    });

    // B6 capture should have been called
    expect(Sentry.captureException).toHaveBeenCalled();
    const calls = vi.mocked(Sentry.captureException).mock.calls;

    const b6Call = calls.find(
      (c) => (c[1] as Record<string, Record<string, string>>)?.tags?.reason === "line-render-failed"
    );
    expect(b6Call).toBeDefined();

    // Verify non-PII context
    const context = b6Call![1] as Record<string, unknown>;
    expect(context).toHaveProperty("tags.dispatcher", "line_push");
    const ctxObj = context.contexts as Record<string, Record<string, unknown>>;
    expect(ctxObj.job).toHaveProperty("job_id");
    expect(ctxObj.job).toHaveProperty("template_key");
    // No PII fields
    expect(ctxObj.job).not.toHaveProperty("line_user_id");
    expect(ctxObj.job).not.toHaveProperty("display_name");
    expect(ctxObj.job).not.toHaveProperty("recipient_id");

    // fetcher should NOT have been called — render fails before push
    expect(fetcher).not.toHaveBeenCalled();
  });

  // B7: line-push-unhandled when fetcher throws
  it("B7: captures line-push-unhandled when fetcher throws", async () => {
    await createReservationAndNotification();
    const db = d1 as unknown as D1Database;

    // fetcher that throws an unhandled error
    const brokenFetcher = vi.fn(async () => {
      throw new Error("network_failure");
    }) as unknown as typeof fetch;

    await processDueLineNotificationJobs({
      db,
      env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "test_token" },
      fetcher: brokenFetcher,
      now: () => NOTIFICATION_NOW_MS
    });

    // B7 capture should have been called
    expect(Sentry.captureException).toHaveBeenCalled();
    const calls = vi.mocked(Sentry.captureException).mock.calls;

    // Find the B7 call (tagged with reason: line-push-unhandled)
    const b7Call = calls.find(
      (c) => (c[1] as Record<string, Record<string, string>>)?.tags?.reason === "line-push-unhandled"
    );
    expect(b7Call).toBeDefined();

    // Verify non-PII context
    const context = b7Call![1] as Record<string, unknown>;
    expect(context).toHaveProperty("tags.dispatcher", "line_push");
    const ctxObj = context.contexts as Record<string, Record<string, unknown>>;
    expect(ctxObj.job).toHaveProperty("job_id");
    expect(ctxObj.job).toHaveProperty("template_key");
    // No PII fields
    expect(ctxObj.job).not.toHaveProperty("line_user_id");
    expect(ctxObj.job).not.toHaveProperty("display_name");
    expect(ctxObj.job).not.toHaveProperty("recipient_id");
  });
});

// Mock authenticateAdmin so the staging endpoint tests can simulate admin
// roles without provisioning a real Cf-Access-Jwt-Assertion + admin_users row.
vi.mock("../src/admin/access", () => ({
  authenticateAdmin: vi.fn()
}));

describe("staging sentry-test endpoint", () => {
  function buildMockCtx(env: { ENVIRONMENT: string }, authHeader?: string) {
    return {
      env,
      req: {
        header: vi.fn((name: string) =>
          name === "Cf-Access-Jwt-Assertion" ? authHeader : undefined
        ),
        json: vi.fn(async () => ({ message: "test PII: 090-1234-5678" }))
      },
      json: vi.fn((body: unknown, status: number, headers: Record<string, string>) => {
        return new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json", ...headers }
        });
      })
    };
  }

  beforeEach(async () => {
    const access = await import("../src/admin/access");
    vi.mocked(access.authenticateAdmin).mockReset();
  });

  it("returns 404 in production environment (regardless of auth)", async () => {
    const { sentryTestHandler } = await import("../src/admin/staging-sentry-test");
    const mockCtx = buildMockCtx({ ENVIRONMENT: "production" });
    const response = await sentryTestHandler(mockCtx as never);
    expect(response.status).toBe(404);
  });

  it("returns 401 in staging when authentication fails", async () => {
    const { sentryTestHandler } = await import("../src/admin/staging-sentry-test");
    const access = await import("../src/admin/access");
    vi.mocked(access.authenticateAdmin).mockResolvedValueOnce({
      ok: false,
      reason: "missing_token"
    } as never);

    const mockCtx = buildMockCtx({ ENVIRONMENT: "staging" });
    const response = await sentryTestHandler(mockCtx as never);
    expect(response.status).toBe(401);
  });

  it("returns 403 in staging when admin role is not system_admin", async () => {
    const { sentryTestHandler } = await import("../src/admin/staging-sentry-test");
    const access = await import("../src/admin/access");
    vi.mocked(access.authenticateAdmin).mockResolvedValueOnce({
      ok: true,
      admin: { role: "staff" }
    } as never);

    const mockCtx = buildMockCtx({ ENVIRONMENT: "staging" }, "stub-jwt");
    const response = await sentryTestHandler(mockCtx as never);
    expect(response.status).toBe(403);
  });

  it("returns 200 in staging when authenticated as system_admin", async () => {
    const { sentryTestHandler } = await import("../src/admin/staging-sentry-test");
    const access = await import("../src/admin/access");
    vi.mocked(access.authenticateAdmin).mockResolvedValueOnce({
      ok: true,
      admin: { role: "system_admin" }
    } as never);

    const mockCtx = buildMockCtx({ ENVIRONMENT: "staging" }, "stub-jwt");
    const response = await sentryTestHandler(mockCtx as never);
    expect(response.status).toBe(200);
  });
});
