import { describe, expect, it, vi } from "vitest";

import { processDueLineNotificationJobs } from "../src/line/notifications";
import { createMigratedSqliteD1 } from "./helpers/sqlite-d1";

const STORE_ID = "store_kyoto";
const STORE_NAME = "ExampleStore A";
const OWNER_EMAIL_RECIPIENT_ID = "email:owner";
const NOW_ISO = "2026-05-19T19:00:00.000Z";

const seedStore = (d1: ReturnType<typeof createMigratedSqliteD1>) => {
  d1.sqlite
    .prepare(`INSERT INTO stores (id, name, timezone) VALUES (?, ?, ?)`)
    .run(STORE_ID, STORE_NAME, "Asia/Tokyo");
};

const seedDriftAlertJob = (
  d1: ReturnType<typeof createMigratedSqliteD1>,
  options: {
    recipientId: string;
    dedupeSuffix: string;
    payload: Record<string, unknown>;
  }
) => {
  const payloadJson = JSON.stringify(options.payload);
  d1.sqlite
    .prepare(
      `INSERT INTO notification_jobs (
         id, dedupe_key, template_key, recipient_type, recipient_id,
         reservation_id, status, payload_json, available_at
       ) VALUES (?, ?, 'google_drift_alert', 'owner', ?, NULL, 'queued', ?, ?)`
    )
    .run(
      `job_${options.dedupeSuffix}`,
      `dedupe_${options.dedupeSuffix}`,
      options.recipientId,
      payloadJson,
      "2026-05-19T18:55:00.000Z"
    );
};

describe("google_drift_alert dispatcher (UNION ALL Branch B)", () => {
  it("renders the drift message, emails the owner, and marks the job succeeded", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      seedStore(d1);
      seedDriftAlertJob(d1, {
        recipientId: OWNER_EMAIL_RECIPIENT_ID,
        dedupeSuffix: "primary",
        payload: {
          store_id: STORE_ID,
          google_count: 30,
          d1_count: 45,
          drift: 15,
          threshold: 10
        }
      });

      const emailSend = vi.fn(async (_message: { to: string; subject: string; text: string }) => ({ messageId: "email_drift" }));
      const fetcher = vi.fn(async () => Response.json({ sentMessages: [{ id: "unexpected" }] })) as unknown as typeof fetch;

      const result = await processDueLineNotificationJobs({
        db: d1 as unknown as D1Database,
        env: {
          LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "test-token",
          GOOGLE_DRIFT_ALERT_LIVE: "true",
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
      expect(email.subject).toBe("【予約通知】カレンダー同期ずれ検出");
      const messageText = email.text;
      expect(messageText).toContain("Calendar sync drift detected");
      expect(messageText).toContain(STORE_NAME);
      expect(messageText).toContain("Google: 30 events");
      expect(messageText).toContain("D1: 45 events");
      expect(messageText).toContain("Drift: 15 (threshold 10)");

      const job = d1.sqlite
        .prepare(`SELECT status FROM notification_jobs WHERE id = 'job_primary'`)
        .get() as { status: string };
      expect(job.status).toBe("succeeded");
    } finally {
      d1.sqlite.close();
    }
  });

  it("uses payload.store_id as the store name when D1 has no matching store row", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      // No store seeded — renderer must fall back to payload.store_id.
      seedDriftAlertJob(d1, {
        recipientId: OWNER_EMAIL_RECIPIENT_ID,
        dedupeSuffix: "no_store",
        payload: {
          store_id: "store_missing",
          google_count: 5,
          d1_count: 12,
          drift: 7,
          threshold: 5
        }
      });

      const emailSend = vi.fn(async (_message: { to: string; subject: string; text: string }) => ({ messageId: "email_no_store" }));
      const fetcher = vi.fn(async () => Response.json({ sentMessages: [{ id: "unexpected" }] })) as unknown as typeof fetch;

      await processDueLineNotificationJobs({
        db: d1 as unknown as D1Database,
        env: {
          LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "test-token",
          GOOGLE_DRIFT_ALERT_LIVE: "true",
          PENDING_APPROVAL_OWNER_EMAIL: "owner@example.com",
          OPERATIONS_NOTIFICATION_EMAIL: "",
          EMAIL: { send: emailSend } as unknown as SendEmail
        },
        fetcher,
        now: () => Date.parse(NOW_ISO)
      });

      expect(fetcher).not.toHaveBeenCalled();
      expect(emailSend.mock.calls[0]?.[0].text).toContain("店舗: store_missing (store_missing)");
    } finally {
      d1.sqlite.close();
    }
  });

  it("falls back to a generic message when payload_json is malformed", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      seedStore(d1);
      seedDriftAlertJob(d1, {
        recipientId: OWNER_EMAIL_RECIPIENT_ID,
        dedupeSuffix: "malformed",
        payload: {
          // Missing the numeric counts.
          store_id: STORE_ID
        }
      });

      const emailSend = vi.fn(async (_message: { to: string; subject: string; text: string }) => ({ messageId: "email_malformed" }));
      const fetcher = vi.fn(async () => Response.json({ sentMessages: [{ id: "unexpected" }] })) as unknown as typeof fetch;

      await processDueLineNotificationJobs({
        db: d1 as unknown as D1Database,
        env: {
          LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "test-token",
          GOOGLE_DRIFT_ALERT_LIVE: "true",
          PENDING_APPROVAL_OWNER_EMAIL: "owner@example.com",
          OPERATIONS_NOTIFICATION_EMAIL: "",
          EMAIL: { send: emailSend } as unknown as SendEmail
        },
        fetcher,
        now: () => Date.parse(NOW_ISO)
      });

      expect(fetcher).not.toHaveBeenCalled();
      expect(emailSend.mock.calls[0]?.[0].text).toContain(
        "Calendar drift detected (details unavailable, payload malformed)"
      );
    } finally {
      d1.sqlite.close();
    }
  });

  it("dispatches both branches independently — drift_alert row alongside an orphan customer row not picked up", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      seedStore(d1);
      seedDriftAlertJob(d1, {
        recipientId: OWNER_EMAIL_RECIPIENT_ID,
        dedupeSuffix: "branchB",
        payload: {
          store_id: STORE_ID,
          google_count: 100,
          d1_count: 110,
          drift: 10,
          threshold: 10
        }
      });

      // Orphan customer row with NULL reservation_id — must NOT be picked
      // up by Branch A because the INNER JOIN reservations excludes it.
      // This is exactly the regression Branch A's INNER JOIN protects against.
      d1.sqlite
        .prepare(
          `INSERT INTO notification_jobs (
             id, dedupe_key, template_key, recipient_type, recipient_id,
             reservation_id, status, available_at
           ) VALUES (?, ?, 'reservation_confirmed', 'customer', ?, NULL, 'queued', ?)`
        )
        .run(
          "job_orphan",
          "dedupe_orphan",
          "U" + "c".repeat(32),
          "2026-05-19T18:50:00.000Z"
        );

      const emailSend = vi.fn(async (_message: { to: string; subject: string; text: string }) => ({ messageId: "email_branch_b" }));
      const fetcher = vi.fn(async () => Response.json({ sentMessages: [{ id: "unexpected" }] })) as unknown as typeof fetch;

      const result = await processDueLineNotificationJobs({
        db: d1 as unknown as D1Database,
        env: {
          LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "test-token",
          GOOGLE_DRIFT_ALERT_LIVE: "true",
          PENDING_APPROVAL_OWNER_EMAIL: "owner@example.com",
          OPERATIONS_NOTIFICATION_EMAIL: "",
          EMAIL: { send: emailSend } as unknown as SendEmail
        },
        fetcher,
        now: () => Date.parse(NOW_ISO),
        maxJobs: 5
      });

      // Only Branch B (drift) row dispatched; orphan customer row stays queued.
      expect(result.succeeded).toBe(1);
      expect(fetcher).not.toHaveBeenCalled();
      expect(emailSend).toHaveBeenCalledTimes(1);
      const orphan = d1.sqlite
        .prepare(`SELECT status FROM notification_jobs WHERE id = 'job_orphan'`)
        .get() as { status: string };
      expect(orphan.status).toBe("queued");
    } finally {
      d1.sqlite.close();
    }
  });
});
