import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const CHANNEL_ID = "google_channel_1";
const RESOURCE_ID = "google_resource_1";
const CHANNEL_TOKEN = "google-channel-token-secret";
const CALENDAR_ID = "calendar-a@example.invalid";

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");
const pushDedupeKey = (channelId = CHANNEL_ID, resourceId = RESOURCE_ID, messageNumber = "2") => {
  const fingerprint = [channelId, resourceId, messageNumber].join("\u0000");
  return `google-push:${sha256Hex(fingerprint)}`;
};

const insertGoogleChannel = (db: SqliteD1Database) => {
  db.sqlite
    .prepare(
      `
        INSERT INTO calendar_auth_connections (
          id,
          store_id,
          provider,
          calendar_id,
          service_account_email,
          status
        ) VALUES (
          'calendar_auth_kyoto_1',
          'kyoto',
          'google',
          ?,
          'calendar-service@example.iam.gserviceaccount.com',
          'active'
        )
      `
    )
    .run(CALENDAR_ID);
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
          channel_token_hash_alg,
          status
        ) VALUES (
          'google_calendar_channel_1',
          'kyoto',
          'calendar_auth_kyoto_1',
          ?,
          ?,
          ?,
          ?,
          'sha256',
          'active'
        )
      `
    )
    .run(CALENDAR_ID, CHANNEL_ID, RESOURCE_ID, sha256Hex(CHANNEL_TOKEN));
};

const insertAdditionalGoogleChannel = (
  db: SqliteD1Database,
  input: {
    id: string;
    channelId: string;
    resourceId: string;
    channelToken: string;
  }
) => {
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
          channel_token_hash_alg,
          status
        ) VALUES (
          ?,
          'kyoto',
          'calendar_auth_kyoto_1',
          ?,
          ?,
          ?,
          ?,
          'sha256',
          'active'
        )
      `
    )
    .run(input.id, CALENDAR_ID, input.channelId, input.resourceId, sha256Hex(input.channelToken));
};

const postGoogleWebhook = (
  db: SqliteD1Database,
  headers: Record<string, string>,
  env: Record<string, unknown> = {}
) => {
  const app = createApp();
  return app.request(
    "/api/google/calendar/webhook",
    {
      method: "POST",
      headers
    },
    {
      DB: db as unknown as D1Database,
      ...env
    }
  );
};

const googleHeaders = (overrides: Record<string, string> = {}) => ({
  "X-Goog-Channel-ID": CHANNEL_ID,
  "X-Goog-Resource-ID": RESOURCE_ID,
  "X-Goog-Resource-State": "exists",
  "X-Goog-Message-Number": "2",
  "X-Goog-Channel-Token": CHANNEL_TOKEN,
  ...overrides
});

const createQueueMock = () => {
  return {
    send: vi.fn(async () => undefined)
  } as unknown as Queue<unknown> & { send: ReturnType<typeof vi.fn> };
};

const createExecutionContextMock = () => {
  const waitUntilPromises: Promise<unknown>[] = [];
  return {
    waitUntilPromises,
    executionCtx: {
      waitUntil: (promise: Promise<unknown>) => {
        waitUntilPromises.push(promise);
      },
      passThroughOnException: vi.fn()
    } as unknown as ExecutionContext
  };
};

describe("Google Calendar webhook API", () => {
  it("ignores Google webhook requests without D1 writes when import is disabled", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertGoogleChannel(db);

      const response = await postGoogleWebhook(
        db,
        googleHeaders({
          "X-Goog-Channel-Token": "old-watch-token"
        }),
        {
          GOOGLE_IMPORT_ENABLED: "false"
        }
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBeNull();
      expect(response.headers.get("pragma")).toBeNull();
      await expect(response.json()).resolves.toEqual({
        ok: true,
        importJobCreated: false,
        ignored: true,
        reason: "google_import_disabled"
      });
      const counts = db.sqlite
        .prepare(
          `
            SELECT
              (SELECT COUNT(*) FROM google_calendar_notifications) AS notificationCount,
              (SELECT COUNT(*) FROM google_calendar_import_jobs) AS jobCount
          `
        )
        .get() as { notificationCount: number; jobCount: number };
      expect(counts).toEqual({
        notificationCount: 0,
        jobCount: 0
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects invalid channel tokens without persisting notifications", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertGoogleChannel(db);

      const response = await postGoogleWebhook(
        db,
        googleHeaders({
          "X-Goog-Channel-Token": "wrong-token"
        })
      );

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "invalid_channel"
      });
      const notifications = db.sqlite.prepare("SELECT COUNT(*) AS count FROM google_calendar_notifications").get() as {
        count: number;
      };
      expect(notifications.count).toBe(0);
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 500 when webhook persistence cannot access D1", async () => {
    const app = createApp();
    const response = await app.request(
      "/api/google/calendar/webhook",
      {
        method: "POST",
        headers: googleHeaders()
      },
      {}
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      reason: "missing_database"
    });
  });

  it("records sync notifications without creating import jobs", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertGoogleChannel(db);

      const response = await postGoogleWebhook(
        db,
        googleHeaders({
          "X-Goog-Resource-State": "sync",
          "X-Goog-Message-Number": "1"
        })
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        importJobCreated: false
      });
      const counts = db.sqlite
        .prepare(
          `
            SELECT
              (SELECT COUNT(*) FROM google_calendar_notifications) AS notificationCount,
              (SELECT COUNT(*) FROM google_calendar_import_jobs) AS jobCount
          `
        )
        .get() as { notificationCount: number; jobCount: number };
      expect(counts).toEqual({
        notificationCount: 1,
        jobCount: 0
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("creates one import job for valid change notifications and redacts the channel token", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertGoogleChannel(db);

      const response = await postGoogleWebhook(db, googleHeaders());

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        importJobCreated: true
      });
      const notification = db.sqlite
        .prepare("SELECT headers_redacted_json FROM google_calendar_notifications WHERE channel_id = ?")
        .get(CHANNEL_ID) as { headers_redacted_json: string };
      const job = db.sqlite
        .prepare("SELECT store_id, calendar_id, reason, status, dedupe_key FROM google_calendar_import_jobs")
        .get() as {
          store_id: string;
          calendar_id: string;
          reason: string;
          status: string;
          dedupe_key: string;
        };

      expect(notification.headers_redacted_json).not.toContain(CHANNEL_TOKEN);
      expect(JSON.parse(notification.headers_redacted_json)).toEqual({
        channelId: CHANNEL_ID,
        resourceId: RESOURCE_ID,
        resourceState: "exists",
        messageNumber: "2"
      });
      expect(job).toEqual({
        store_id: "kyoto",
        calendar_id: CALENDAR_ID,
        reason: "push",
        status: "queued",
        dedupe_key: pushDedupeKey()
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("kicks the Google queue after valid change notifications create import jobs", async () => {
    const db = createMigratedSqliteD1();
    const googleQueue = createQueueMock();
    const { executionCtx, waitUntilPromises } = createExecutionContextMock();
    const app = createApp();
    try {
      insertGoogleChannel(db);

      const response = await app.fetch(
        new Request("https://reservation.test/api/google/calendar/webhook", {
          method: "POST",
          headers: googleHeaders()
        }),
        {
          DB: db as unknown as D1Database,
          GOOGLE_SYNC_QUEUE: googleQueue
        },
        executionCtx
      );

      expect(response.status).toBe(200);
      await Promise.all(waitUntilPromises);
      expect(googleQueue.send).toHaveBeenCalledWith({ type: "google_sync_job_available" });
    } finally {
      db.sqlite.close();
    }
  });

  it("deduplicates repeated Google notification messages", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertGoogleChannel(db);

      const first = await postGoogleWebhook(db, googleHeaders());
      const second = await postGoogleWebhook(db, googleHeaders());

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const counts = db.sqlite
        .prepare(
          `
            SELECT
              (SELECT COUNT(*) FROM google_calendar_notifications) AS notificationCount,
              (SELECT COUNT(*) FROM google_calendar_import_jobs) AS jobCount
          `
        )
        .get() as { notificationCount: number; jobCount: number };
      expect(counts).toEqual({
        notificationCount: 1,
        jobCount: 1
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("does not treat non-sequential Google message numbers as delivery failures", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertGoogleChannel(db);

      const first = await postGoogleWebhook(
        db,
        googleHeaders({
          "X-Goog-Message-Number": "2"
        })
      );
      const later = await postGoogleWebhook(
        db,
        googleHeaders({
          "X-Goog-Message-Number": "10"
        })
      );

      expect(first.status).toBe(200);
      expect(later.status).toBe(200);
      const jobs = db.sqlite
        .prepare("SELECT dedupe_key FROM google_calendar_import_jobs ORDER BY dedupe_key")
        .all() as { dedupe_key: string }[];
      expect(new Set(jobs.map((job) => job.dedupe_key))).toEqual(new Set([
        pushDedupeKey(CHANNEL_ID, RESOURCE_ID, "10"),
        pushDedupeKey(CHANNEL_ID, RESOURCE_ID, "2")
      ]));
    } finally {
      db.sqlite.close();
    }
  });

  it("scopes push import dedupe keys by Google watch channel identity", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertGoogleChannel(db);
      insertAdditionalGoogleChannel(db, {
        id: "google_calendar_channel_2",
        channelId: "google_channel_2",
        resourceId: "google_resource_2",
        channelToken: "google-channel-token-secret-2"
      });

      const first = await postGoogleWebhook(db, googleHeaders());
      const second = await postGoogleWebhook(
        db,
        googleHeaders({
          "X-Goog-Channel-ID": "google_channel_2",
          "X-Goog-Resource-ID": "google_resource_2",
          "X-Goog-Channel-Token": "google-channel-token-secret-2"
        })
      );

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const jobs = db.sqlite
        .prepare("SELECT dedupe_key FROM google_calendar_import_jobs ORDER BY dedupe_key")
        .all() as { dedupe_key: string }[];
      expect(new Set(jobs.map((job) => job.dedupe_key))).toEqual(new Set([
        pushDedupeKey(),
        pushDedupeKey("google_channel_2", "google_resource_2", "2")
      ]));
    } finally {
      db.sqlite.close();
    }
  });
});
