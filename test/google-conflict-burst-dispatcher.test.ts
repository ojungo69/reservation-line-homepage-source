import { describe, expect, it, vi } from "vitest";

import { processDueLineNotificationJobs } from "../src/line/notifications";
import { createMigratedSqliteD1 } from "./helpers/sqlite-d1";

const STORE_ID = "store_kyoto";
const STORE_NAME = "ExampleStore A";
const CALENDAR_ID = "calendar-a@example.invalid";
const OWNER_EMAIL_RECIPIENT_ID = "email:owner";
const NOW_ISO = "2026-05-19T19:00:00.000Z";

const seedStore = (d1: ReturnType<typeof createMigratedSqliteD1>) => {
  d1.sqlite
    .prepare(`INSERT INTO stores (id, name, timezone) VALUES (?, ?, ?)`)
    .run(STORE_ID, STORE_NAME, "Asia/Tokyo");
};

const seedConflictBurstJob = (
  d1: ReturnType<typeof createMigratedSqliteD1>,
  options: { recipientId: string; dedupeSuffix: string; payload: Record<string, unknown> }
) => {
  const payloadJson = JSON.stringify(options.payload);
  d1.sqlite
    .prepare(
      `INSERT INTO notification_jobs (
         id, dedupe_key, template_key, recipient_type, recipient_id,
         reservation_id, status, payload_json, available_at
       ) VALUES (?, ?, 'google_conflict_burst_alert', 'owner', ?, NULL, 'queued', ?, ?)`
    )
    .run(
      `job_${options.dedupeSuffix}`,
      `dedupe_${options.dedupeSuffix}`,
      options.recipientId,
      payloadJson,
      "2026-05-19T18:55:00.000Z"
    );
};

describe("google_conflict_burst_alert dispatcher (PR #59 follow-up)", () => {
  it("flag=true → dispatcher renders conflict_burst and emails the owner", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      seedStore(d1);
      seedConflictBurstJob(d1, {
        recipientId: OWNER_EMAIL_RECIPIENT_ID,
        dedupeSuffix: "burst_1",
        payload: {
          store_id: STORE_ID,
          calendar_id: CALENDAR_ID,
          conflict_count: 15,
          threshold: 10,
          window_minutes: 5
        }
      });

      const emailSend = vi.fn(async (_message: { to: string; subject: string; text: string }) => ({ messageId: "email_burst" }));
      const fetcher = vi.fn(async () => Response.json({ sentMessages: [{ id: "unexpected" }] })) as unknown as typeof fetch;

      const result = await processDueLineNotificationJobs({
        db: d1 as unknown as D1Database,
        env: {
          LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "test-token",
          GOOGLE_CONFLICT_BURST_ALERT_LIVE: "true",
          PENDING_APPROVAL_OWNER_EMAIL: "owner@example.com",
          OPERATIONS_NOTIFICATION_EMAIL: "",
          EMAIL: { send: emailSend } as unknown as SendEmail
        },
        fetcher,
        now: () => Date.parse(NOW_ISO)
      });
      expect(result.succeeded).toBe(1);
      expect(result.failed).toBe(0);

      expect(fetcher).not.toHaveBeenCalled();
      expect(emailSend).toHaveBeenCalledTimes(1);
      const email = emailSend.mock.calls[0]?.[0];
      expect(email.to).toBe("owner@example.com");
      expect(email.subject).toBe("【予約通知】カレンダー競合検出");
      const messageText = email.text;
      expect(messageText).toContain("Calendar conflict burst detected");
      expect(messageText).toContain(STORE_NAME);
      expect(messageText).toContain("15");
      expect(messageText).toContain("10");
      expect(messageText).toContain("5 min");

      const job = d1.sqlite
        .prepare(`SELECT status FROM notification_jobs WHERE id = 'job_burst_1'`)
        .get() as { status: string };
      expect(job.status).toBe("succeeded");
    } finally {
      d1.sqlite.close();
    }
  });

  it("malformed payload → fallback generic message, still emails", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      seedStore(d1);
      seedConflictBurstJob(d1, {
        recipientId: OWNER_EMAIL_RECIPIENT_ID,
        dedupeSuffix: "malformed",
        payload: { store_id: STORE_ID } // missing required fields
      });

      const emailSend = vi.fn(async (_message: { to: string; subject: string; text: string }) => ({ messageId: "email_malformed" }));
      const fetcher = vi.fn(async () => Response.json({ sentMessages: [{ id: "unexpected" }] })) as unknown as typeof fetch;

      await processDueLineNotificationJobs({
        db: d1 as unknown as D1Database,
        env: {
          LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "test-token",
          GOOGLE_CONFLICT_BURST_ALERT_LIVE: "true",
          PENDING_APPROVAL_OWNER_EMAIL: "owner@example.com",
          OPERATIONS_NOTIFICATION_EMAIL: "",
          EMAIL: { send: emailSend } as unknown as SendEmail
        },
        fetcher,
        now: () => Date.parse(NOW_ISO)
      });

      expect(fetcher).not.toHaveBeenCalled();
      expect(emailSend.mock.calls[0]?.[0].text).toContain(
        "Conflict burst detected (details unavailable, payload malformed)"
      );
    } finally {
      d1.sqlite.close();
    }
  });

  it("both flags off → conflict_burst row NOT picked up, stays queued", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      seedStore(d1);
      seedConflictBurstJob(d1, {
        recipientId: OWNER_EMAIL_RECIPIENT_ID,
        dedupeSuffix: "unflipped",
        payload: {
          store_id: STORE_ID,
          calendar_id: CALENDAR_ID,
          conflict_count: 12,
          threshold: 10,
          window_minutes: 5
        }
      });

      const fetcher = (async () => {
        throw new Error("unexpected push when both flags are off");
      }) as unknown as typeof fetch;

      const result = await processDueLineNotificationJobs({
        db: d1 as unknown as D1Database,
        env: {
          LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "test-token",
          GOOGLE_CONFLICT_BURST_ALERT_LIVE: "false"
        },
        fetcher,
        now: () => Date.parse(NOW_ISO)
      });

      expect(result.processed).toBe(0);
      const job = d1.sqlite
        .prepare(`SELECT status FROM notification_jobs WHERE id = 'job_unflipped'`)
        .get() as { status: string };
      expect(job.status).toBe("queued");
    } finally {
      d1.sqlite.close();
    }
  });

  it("only GOOGLE_DRIFT_ALERT_LIVE=true (conflict_burst flag off) → conflict_burst row still picked up since Branch B is included", async () => {
    // Branch B's inclusion is OR-gated on either flag. With drift=on +
    // conflict_burst=off, the conflict_burst enqueue path is dormant
    // (producer-side) so no conflict_burst rows should exist in
    // production. But if a row IS present (e.g. flag was on then flipped
    // off), the dispatcher will still pick it up because Branch B is
    // included. This test exercises that path so the rollback runbook
    // requirement to drain queued conflict_burst rows is enforced.
    const d1 = createMigratedSqliteD1();
    try {
      seedStore(d1);
      seedConflictBurstJob(d1, {
        recipientId: OWNER_EMAIL_RECIPIENT_ID,
        dedupeSuffix: "rolled_back",
        payload: {
          store_id: STORE_ID,
          calendar_id: CALENDAR_ID,
          conflict_count: 11,
          threshold: 10,
          window_minutes: 5
        }
      });

      const emailSend = vi.fn(async (_message: { to: string; subject: string; text: string }) => ({ messageId: "email_rollback" }));
      const fetcher = vi.fn(async () => Response.json({ sentMessages: [{ id: "unexpected" }] })) as unknown as typeof fetch;

      const result = await processDueLineNotificationJobs({
        db: d1 as unknown as D1Database,
        env: {
          LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "test-token",
          GOOGLE_DRIFT_ALERT_LIVE: "true",
          GOOGLE_CONFLICT_BURST_ALERT_LIVE: "false",
          PENDING_APPROVAL_OWNER_EMAIL: "owner@example.com",
          OPERATIONS_NOTIFICATION_EMAIL: "",
          EMAIL: { send: emailSend } as unknown as SendEmail
        },
        fetcher,
        now: () => Date.parse(NOW_ISO)
      });
      expect(result.succeeded).toBe(1);
      expect(fetcher).not.toHaveBeenCalled();
      expect(emailSend).toHaveBeenCalledTimes(1);
    } finally {
      d1.sqlite.close();
    }
  });
});
