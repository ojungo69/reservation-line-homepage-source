import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import { processLineWebhook } from "../src/line/webhook";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const channelSigningFixture = () => ["line", "channel", "fixture", "value", "for", "hmac"].join("_");
const CHANNEL_ID = "line_channel_id";
const LINE_USER_ID = "line_user_webhook_1";
const CUSTOMER_ID = "customer_line_webhook_1";
const LINE_IDENTITY_ID = "line_identity_webhook_1";

const signatureForBody = (body: string) => {
  return createHmac("sha256", channelSigningFixture()).update(body).digest("base64");
};

const lineWebhookRequest = (db: SqliteD1Database, body: string, signature = signatureForBody(body)) => {
  const app = createApp();
  return app.request(
    "/api/line/webhook",
    {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "x-line-signature": signature
      }
    },
    {
      LINE_CHANNEL_SECRET: channelSigningFixture(),
      LINE_CHANNEL_ID: CHANNEL_ID,
      DB: db as unknown as D1Database
    }
  );
};

// Bypasses the Hono route to call processLineWebhook directly. Same signature
// verification as the HTTP path since resolveLineWebhookContext still runs
// unchanged.
const callLineWebhook = (input: {
  db: SqliteD1Database;
  body: string;
  env?: Record<string, string>;
  now?: () => number;
}) => {
  const rawBody = new TextEncoder().encode(input.body).buffer;
  return processLineWebhook({
    rawBody,
    signature: signatureForBody(input.body),
    env: {
      LINE_CHANNEL_SECRET: channelSigningFixture(),
      LINE_CHANNEL_ID: CHANNEL_ID,
      DB: input.db as unknown as D1Database,
      ...input.env
    },
    now: input.now
  });
};

const insertLineIdentity = (
  db: SqliteD1Database,
  status: "friend" | "blocked" = "blocked",
  lastCheckedAt = "2026-05-09T00:00:00.000Z"
) => {
  db.sqlite
    .prepare(
      `
        INSERT INTO customers (
          id,
          display_name,
          display_name_kana,
          phone_normalized,
          phone_hash,
          block_status,
          updated_at
        ) VALUES (?, 'LINE 顧客', 'ライン コキャク', '0750000000', 'line_webhook_phone_hash', 'active', ?)
      `
    )
    .run(CUSTOMER_ID, lastCheckedAt);
  db.sqlite
    .prepare(
      `
        INSERT INTO line_identities (
          id,
          customer_id,
          channel_id,
          line_user_id,
          friend_flag,
          official_friend_status,
          followed_at,
          unfollowed_at,
          last_friend_checked_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      LINE_IDENTITY_ID,
      CUSTOMER_ID,
      CHANNEL_ID,
      LINE_USER_ID,
      status === "friend" ? 1 : 0,
      status,
      status === "friend" ? lastCheckedAt : null,
      status === "blocked" ? lastCheckedAt : null,
      lastCheckedAt,
      lastCheckedAt
    );
};

const webhookBody = (event: Record<string, unknown>) => {
  return JSON.stringify({
    destination: "U8e742f61d673b39c7fff3cecb7536ef0",
    events: [event]
  });
};

const expectNoAdminPrivateHeaders = (response: Response) => {
  expect(response.headers.get("cache-control")).toBeNull();
  expect(response.headers.get("pragma")).toBeNull();
};

describe("LINE webhook API", () => {
  it("rejects invalid signatures before persisting webhook events", async () => {
    const db = createMigratedSqliteD1();
    try {
      const body = webhookBody({
        type: "follow",
        webhookEventId: "line-webhook-invalid-1",
        timestamp: 1_780_000_000_000,
        source: {
          type: "user",
          userId: LINE_USER_ID
        }
      });

      const response = await lineWebhookRequest(db, body, "invalid-signature");

      expect(response.status).toBe(401);
      expectNoAdminPrivateHeaders(response);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "invalid_signature"
      });
      const events = db.sqlite.prepare("SELECT COUNT(*) AS count FROM line_webhook_events").get() as { count: number };
      expect(events.count).toBe(0);
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 200 for LINE webhook URL verification requests with no events", async () => {
    const db = createMigratedSqliteD1();
    try {
      const body = JSON.stringify({
        destination: "U8e742f61d673b39c7fff3cecb7536ef0",
        events: []
      });

      const response = await lineWebhookRequest(db, body);

      expect(response.status).toBe(200);
      expectNoAdminPrivateHeaders(response);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        processed: 0
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 500 when LINE webhook persistence cannot access D1", async () => {
    const app = createApp();
    const body = JSON.stringify({
      destination: "U8e742f61d673b39c7fff3cecb7536ef0",
      events: []
    });

    const response = await app.request(
      "/api/line/webhook",
      {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "x-line-signature": signatureForBody(body)
        }
      },
      {
        LINE_CHANNEL_SECRET: channelSigningFixture(),
        LINE_CHANNEL_ID: CHANNEL_ID
      }
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      reason: "missing_database"
    });
  });

  it("updates existing LINE identities on follow events after signature validation", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertLineIdentity(db, "blocked");
      const body = webhookBody({
        type: "follow",
        webhookEventId: "line-follow-1",
        timestamp: Date.parse("2026-05-09T01:00:00.000Z"),
        source: {
          type: "user",
          userId: LINE_USER_ID
        },
        follow: {
          isUnblocked: true
        }
      });

      const response = await lineWebhookRequest(db, body);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        processed: 1
      });
      const identity = db.sqlite
        .prepare(
          `
            SELECT friend_flag, official_friend_status, followed_at, unfollowed_at, last_friend_checked_at
            FROM line_identities
            WHERE id = ?
          `
        )
        .get(LINE_IDENTITY_ID) as {
          friend_flag: number;
          official_friend_status: string;
          followed_at: string;
          unfollowed_at: string | null;
          last_friend_checked_at: string;
        };
      expect(identity).toEqual({
        friend_flag: 1,
        official_friend_status: "friend",
        followed_at: "2026-05-09T01:00:00.000Z",
        unfollowed_at: null,
        last_friend_checked_at: "2026-05-09T01:00:00.000Z"
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("does not let older unfollow redeliveries overwrite a newer friend state", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertLineIdentity(db, "friend", "2026-05-09T02:00:00.000Z");
      const body = webhookBody({
        type: "unfollow",
        webhookEventId: "line-unfollow-stale-1",
        timestamp: Date.parse("2026-05-09T01:00:00.000Z"),
        source: {
          type: "user",
          userId: LINE_USER_ID
        }
      });

      const response = await lineWebhookRequest(db, body);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        processed: 1
      });
      const identity = db.sqlite
        .prepare("SELECT friend_flag, official_friend_status, last_friend_checked_at FROM line_identities WHERE id = ?")
        .get(LINE_IDENTITY_ID) as {
          friend_flag: number;
          official_friend_status: string;
          last_friend_checked_at: string;
        };
      expect(identity).toEqual({
        friend_flag: 1,
        official_friend_status: "friend",
        last_friend_checked_at: "2026-05-09T02:00:00.000Z"
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("deduplicates redelivered webhook events by webhookEventId", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertLineIdentity(db, "blocked");
      const body = webhookBody({
        type: "follow",
        webhookEventId: "line-follow-dedupe-1",
        timestamp: Date.parse("2026-05-09T01:00:00.000Z"),
        source: {
          type: "user",
          userId: LINE_USER_ID
        }
      });

      const first = await lineWebhookRequest(db, body);
      const second = await lineWebhookRequest(db, body);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const eventCount = db.sqlite
        .prepare("SELECT COUNT(*) AS count FROM line_webhook_events WHERE dedupe_key = 'line-follow-dedupe-1'")
        .get() as { count: number };
      expect(eventCount.count).toBe(1);
    } finally {
      db.sqlite.close();
    }
  });

  // Malformed events must be dropped before they reach D1. LINE is the only
  // caller, but the payload is attacker-shaped once the signature is stripped
  // from consideration, so each guard gets its own case.
  it.each([
    ["a non-object event", "not-an-object"],
    ["an event with no type", { webhookEventId: "skip-no-type", timestamp: 1_780_000_000_000 }],
    ["an unparsable timestamp", { type: "follow", webhookEventId: "skip-bad-ts", timestamp: "nope" }],
    [
      "an event with nothing to dedupe on",
      { type: "follow", timestamp: 1_780_000_000_000, source: { type: "group", groupId: "g1" } }
    ]
  ])("skips %s without persisting it", async (_label, event) => {
    const db = createMigratedSqliteD1();
    try {
      const result = await callLineWebhook({
        db,
        body: JSON.stringify({ destination: "U8e742f61d673b39c7fff3cecb7536ef0", events: [event] })
      });

      expect(result).toEqual({ ok: true, processed: 0 });
      const events = db.sqlite
        .prepare("SELECT COUNT(*) AS count FROM line_webhook_events")
        .get() as { count: number };
      expect(events.count).toBe(0);
    } finally {
      db.sqlite.close();
    }
  });

  it("answers event_processing_failed when persistence throws mid-batch", async () => {
    const db = createMigratedSqliteD1();
    try {
      const unavailable = new Proxy(db as object, {
        get(target, prop, receiver) {
          if (prop === "prepare") {
            return () => {
              throw new Error("d1 unavailable");
            };
          }
          return Reflect.get(target, prop, receiver);
        }
      }) as SqliteD1Database;

      const result = await callLineWebhook({
        db: unavailable,
        body: webhookBody({
          type: "follow",
          webhookEventId: "line-persist-failure-1",
          timestamp: Date.parse("2026-05-09T01:00:00.000Z"),
          source: { type: "user", userId: LINE_USER_ID }
        })
      });

      // Non-200 makes LINE redeliver the batch rather than dropping the event.
      expect(result).toEqual({ ok: false, reason: "event_processing_failed" });
    } finally {
      db.sqlite.close();
    }
  });

  // The LINE talk-based booking bot was retired: message and postback events
  // must be recorded and marked processed, and must NEVER produce an outbound
  // call to the LINE reply API. This is the load-bearing check for that
  // removal — 「予約」 is the exact keyword that used to start the flow.
  describe("talk-based booking bot removal", () => {
    it.each([
      [
        "message",
        {
          type: "message",
          webhookEventId: "line-retired-bot-message-1",
          replyToken: "reply-token-message-1",
          message: { type: "text", text: "予約" }
        }
      ],
      [
        "postback",
        {
          type: "postback",
          webhookEventId: "line-retired-bot-postback-1",
          replyToken: "reply-token-postback-1",
          postback: { data: "b1|a=start" }
        }
      ]
    ])("records a %s event without replying", async (_label, event) => {
      const db = createMigratedSqliteD1();
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      try {
        insertLineIdentity(db, "friend");
        const result = await callLineWebhook({
          db,
          body: webhookBody({
            ...event,
            timestamp: Date.parse("2026-05-09T01:00:00.000Z"),
            source: { type: "user", userId: LINE_USER_ID }
          }),
          env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "unused-token-fixture" }
        });

        expect(result).toEqual({ ok: true, processed: 1 });
        expect(fetchSpy).not.toHaveBeenCalled();
        const row = db.sqlite
          .prepare("SELECT event_type, processed_at FROM line_webhook_events WHERE dedupe_key = ?")
          .get(event.webhookEventId) as { event_type: string; processed_at: string | null };
        expect(row.event_type).toBe(event.type);
        expect(row.processed_at).not.toBeNull();
      } finally {
        fetchSpy.mockRestore();
        db.sqlite.close();
      }
    });
  });
});
