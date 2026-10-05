import { describe, expect, it, vi } from "vitest";

import { processDueLineNotificationJobs } from "../src/line/notifications";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const STORE_ID = "store_kyoto";
const OWNER_EMAIL_RECIPIENT_ID = "email:owner";

const seedStore = (d1: SqliteD1Database) => {
  d1.sqlite
    .prepare(`INSERT INTO stores (id, name, timezone) VALUES (?, ?, ?)`)
    .run(STORE_ID, "ExampleStore A", "Asia/Tokyo");
};

const seedDriftAlertJob = (
  d1: SqliteD1Database,
  options: { id: string; dedupeSuffix: string }
) => {
  const payloadJson = JSON.stringify({
    store_id: STORE_ID,
    google_count: 30,
    d1_count: 45,
    drift: 15,
    threshold: 10
  });
  d1.sqlite
    .prepare(
      `INSERT INTO notification_jobs (
         id, dedupe_key, template_key, recipient_type, recipient_id,
         reservation_id, status, payload_json, available_at
       ) VALUES (?, ?, 'google_drift_alert', 'owner', ?, NULL, 'queued', ?, ?)`
    )
    .run(
      options.id,
      `dedupe_${options.dedupeSuffix}`,
      OWNER_EMAIL_RECIPIENT_ID,
      payloadJson,
      "2026-05-19T18:55:00.000Z"
    );
};

const acceptingFetcher = () =>
  (async () =>
    new Response(JSON.stringify({ sentMessages: [{ id: "M1" }] }), { status: 200 })) as unknown as typeof fetch;

const env = {
  LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "test-token",
  GOOGLE_DRIFT_ALERT_LIVE: "true",
  PENDING_APPROVAL_OWNER_EMAIL: "owner@example.com",
  OPERATIONS_NOTIFICATION_EMAIL: "",
  EMAIL: { send: async () => ({ messageId: "email_job_filter" }) } as unknown as SendEmail
} as const;

const NOW_MS = Date.parse("2026-05-19T19:00:00.000Z");

describe("processDueLineNotificationJobs jobIdsFilter three-state contract", () => {
  it("undefined: behaves as global FIFO (processes all due jobs)", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      seedStore(d1);
      seedDriftAlertJob(d1, { id: "job_a", dedupeSuffix: "a" });
      seedDriftAlertJob(d1, { id: "job_b", dedupeSuffix: "b" });

      const result = await processDueLineNotificationJobs({
        db: d1 as unknown as D1Database,
        env,
        fetcher: acceptingFetcher(),
        now: () => NOW_MS,
        maxJobs: 5
      });
      expect(result.processed).toBe(2);
      expect(result.succeeded).toBe(2);
    } finally {
      d1.sqlite.close();
    }
  });

  it("non-empty filter: only listed jobs processed even when other due jobs exist", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      seedStore(d1);
      seedDriftAlertJob(d1, { id: "job_target_1", dedupeSuffix: "t1" });
      seedDriftAlertJob(d1, { id: "job_target_2", dedupeSuffix: "t2" });
      seedDriftAlertJob(d1, { id: "job_skip_1", dedupeSuffix: "s1" });
      seedDriftAlertJob(d1, { id: "job_skip_2", dedupeSuffix: "s2" });

      const result = await processDueLineNotificationJobs({
        db: d1 as unknown as D1Database,
        env,
        fetcher: acceptingFetcher(),
        now: () => NOW_MS,
        maxJobs: 10,
        jobIdsFilter: ["job_target_1", "job_target_2"]
      });
      expect(result.processed).toBe(2);
      expect(result.succeeded).toBe(2);

      const targetStatuses = d1.sqlite
        .prepare(`SELECT id, status FROM notification_jobs WHERE id LIKE 'job_target_%' ORDER BY id`)
        .all() as Array<{ id: string; status: string }>;
      expect(targetStatuses.map((r) => r.status)).toEqual(["succeeded", "succeeded"]);

      const skipStatuses = d1.sqlite
        .prepare(`SELECT id, status FROM notification_jobs WHERE id LIKE 'job_skip_%' ORDER BY id`)
        .all() as Array<{ id: string; status: string }>;
      expect(skipStatuses.map((r) => r.status)).toEqual(["queued", "queued"]);
    } finally {
      d1.sqlite.close();
    }
  });

  it("empty array []: short-circuits with zero processed and no SQL issued", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      seedStore(d1);
      seedDriftAlertJob(d1, { id: "job_should_not_process", dedupeSuffix: "x" });

      const prepareSpy = vi.spyOn(d1, "prepare");

      const result = await processDueLineNotificationJobs({
        db: d1 as unknown as D1Database,
        env,
        fetcher: acceptingFetcher(),
        now: () => NOW_MS,
        maxJobs: 10,
        jobIdsFilter: []
      });
      expect(result.processed).toBe(0);
      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(0);
      expect(prepareSpy).not.toHaveBeenCalled();

      const job = d1.sqlite
        .prepare(`SELECT status FROM notification_jobs WHERE id = 'job_should_not_process'`)
        .get() as { status: string };
      expect(job.status).toBe("queued");
    } finally {
      d1.sqlite.close();
    }
  });
});
