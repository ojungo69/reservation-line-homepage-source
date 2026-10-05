import type { WorkerBindings } from "../bindings";
import { safeCaptureException } from "../sentry-helpers";

export type LineWebhookResult =
  | {
      ok: true;
      processed: number;
    }
  | {
      ok: false;
      reason: "invalid_signature" | "invalid_request" | "missing_database" | "event_processing_failed";
    };

type LineWebhookFailure = Extract<LineWebhookResult, { ok: false }>;

type LineWebhookBody = {
  events?: unknown;
};

type ParsedLineWebhookBody = {
  events: unknown[];
};

// Only the fields this Worker actually reads. Message text, postback payloads
// and replyToken were consumed by the retired booking bot; they are left off so
// the type does not imply the webhook still inspects message content.
type LineWebhookEvent = {
  type?: unknown;
  webhookEventId?: unknown;
  timestamp?: unknown;
  source?: unknown;
};

type LineWebhookSource = {
  type?: unknown;
  userId?: unknown;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const isObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const isNonEmptyString = (value: unknown, maxLength: number): value is string => {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
};

const base64ToBytes = (value: string) => {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.codePointAt(index) ?? 0;
    }
    return bytes;
  } catch {
    return undefined;
  }
};

const constantTimeEqual = (left: Uint8Array, right: Uint8Array) => {
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
};

const verifyLineWebhookSignature = async (input: {
  body: ArrayBuffer;
  signature: string | undefined;
  channelSecret: string | undefined;
}) => {
  if (!isNonEmptyString(input.signature, 1024) || !isNonEmptyString(input.channelSecret, 256)) {
    return false;
  }

  const receivedSignature = base64ToBytes(input.signature);
  if (!receivedSignature) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(input.channelSecret),
    {
      name: "HMAC",
      hash: "SHA-256"
    },
    false,
    ["sign"]
  );
  const computed = new Uint8Array(await crypto.subtle.sign("HMAC", key, input.body));
  return constantTimeEqual(computed, receivedSignature);
};

const parseWebhookBody = (rawBody: ArrayBuffer): LineWebhookBody | undefined => {
  try {
    const body = JSON.parse(textDecoder.decode(rawBody)) as LineWebhookBody;
    return isObject(body) && Array.isArray(body.events) ? body : undefined;
  } catch {
    return undefined;
  }
};

const eventTimestampIso = (timestamp: unknown) => {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return undefined;
  }
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) {
    return undefined;
  }
  return date.toISOString();
};

const getLineUserId = (source: unknown) => {
  if (!isObject(source)) {
    return undefined;
  }
  const lineSource = source as LineWebhookSource;
  if (lineSource.type !== "user" || !isNonEmptyString(lineSource.userId, 128)) {
    return undefined;
  }
  return lineSource.userId;
};

const getDedupeKey = (event: LineWebhookEvent, lineUserId: string | undefined, timestampIso: string | undefined) => {
  if (isNonEmptyString(event.webhookEventId, 256)) {
    return event.webhookEventId;
  }
  if (isNonEmptyString(event.type, 64) && lineUserId && timestampIso) {
    return `${event.type}:${lineUserId}:${timestampIso}`;
  }
  return undefined;
};

const persistWebhookEvent = async (input: {
  db: D1Database;
  dedupeKey: string;
  eventType: string;
  lineUserId: string | null;
  eventTimestampIso: string;
  receivedAtIso: string;
}) => {
  await input.db
    .prepare(
      `
        INSERT OR IGNORE INTO line_webhook_events (
          id,
          dedupe_key,
          event_type,
          line_user_id,
          event_timestamp,
          received_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `
    )
    .bind(
      crypto.randomUUID(),
      input.dedupeKey,
      input.eventType,
      input.lineUserId,
      input.eventTimestampIso,
      input.receivedAtIso
    )
    .run();
};

// Records WHEN an event finished handling. Nothing in the request path reads it
// back (the retired booking bot was the only reader): redelivery safety comes
// from INSERT OR IGNORE on dedupe_key plus the timestamp guard in
// updateLineIdentityFriendState, both idempotent. Kept as the operational
// signal that separates "received" from "handled" when auditing the table.
const markWebhookEventProcessed = async (input: {
  db: D1Database;
  dedupeKey: string;
  processedAtIso: string;
}) => {
  await input.db
    .prepare(
      `
        UPDATE line_webhook_events
        SET processed_at = ?
        WHERE dedupe_key = ?
          AND processed_at IS NULL
      `
    )
    .bind(input.processedAtIso, input.dedupeKey)
    .run();
};

const updateLineIdentityFriendState = async (input: {
  db: D1Database;
  channelId: string;
  lineUserId: string;
  eventType: "follow" | "unfollow";
  eventTimestampIso: string;
  processedAtIso: string;
}) => {
  if (input.eventType === "follow") {
    await input.db
      .prepare(
        `
          UPDATE line_identities
          SET friend_flag = 1,
              official_friend_status = 'friend',
              followed_at = ?,
              unfollowed_at = NULL,
              last_friend_checked_at = ?,
              updated_at = ?
          WHERE provider = 'line'
            AND channel_id = ?
            AND line_user_id = ?
            AND (
              last_friend_checked_at IS NULL
              OR last_friend_checked_at <= ?
            )
        `
      )
      .bind(
        input.eventTimestampIso,
        input.eventTimestampIso,
        input.processedAtIso,
        input.channelId,
        input.lineUserId,
        input.eventTimestampIso
      )
      .run();
    return;
  }

  await input.db
    .prepare(
      `
        UPDATE line_identities
        SET friend_flag = 0,
            official_friend_status = 'blocked',
            unfollowed_at = ?,
            last_friend_checked_at = ?,
            updated_at = ?
        WHERE provider = 'line'
          AND channel_id = ?
          AND line_user_id = ?
          AND (
            last_friend_checked_at IS NULL
            OR last_friend_checked_at <= ?
          )
      `
    )
    .bind(
      input.eventTimestampIso,
      input.eventTimestampIso,
      input.processedAtIso,
      input.channelId,
      input.lineUserId,
      input.eventTimestampIso
    )
    .run();
};

const resolveLineWebhookContext = async (input: {
  rawBody: ArrayBuffer;
  signature: string | undefined;
  env: Partial<WorkerBindings>;
}): Promise<
  | {
      ok: true;
      db: D1Database;
      channelId: string;
      body: ParsedLineWebhookBody;
    }
  | LineWebhookFailure
> => {
  const signatureValid = await verifyLineWebhookSignature({
    body: input.rawBody,
    signature: input.signature,
    channelSecret: input.env.LINE_CHANNEL_SECRET
  });
  if (!signatureValid) {
    return {
      ok: false,
      reason: "invalid_signature"
    };
  }

  const db = input.env.DB;
  if (!db) {
    return {
      ok: false,
      reason: "missing_database"
    };
  }

  const channelId = input.env.LINE_CHANNEL_ID;
  if (!isNonEmptyString(channelId, 128)) {
    return {
      ok: false,
      reason: "invalid_request"
    };
  }

  const body = parseWebhookBody(input.rawBody);
  if (!body || !Array.isArray(body.events)) {
    return {
      ok: false,
      reason: "invalid_request"
    };
  }

  return {
    ok: true,
    db,
    channelId,
    body: {
      events: body.events
    }
  };
};

const processLineWebhookEvent = async (input: {
  db: D1Database;
  channelId: string;
  rawEvent: unknown;
  processedAtIso: string;
}): Promise<boolean> => {
  if (!isObject(input.rawEvent)) {
    return false;
  }

  const event = input.rawEvent as LineWebhookEvent;
  if (!isNonEmptyString(event.type, 64)) {
    return false;
  }

  const timestampIso = eventTimestampIso(event.timestamp);
  if (!timestampIso) {
    return false;
  }

  const lineUserId = getLineUserId(event.source);
  const dedupeKey = getDedupeKey(event, lineUserId, timestampIso);
  if (!dedupeKey) {
    return false;
  }

  await persistWebhookEvent({
    db: input.db,
    dedupeKey,
    eventType: event.type,
    lineUserId: lineUserId ?? null,
    eventTimestampIso: timestampIso,
    receivedAtIso: input.processedAtIso
  });

  if ((event.type === "follow" || event.type === "unfollow") && lineUserId) {
    await updateLineIdentityFriendState({
      db: input.db,
      channelId: input.channelId,
      lineUserId,
      eventType: event.type,
      eventTimestampIso: timestampIso,
      processedAtIso: input.processedAtIso
    });
  }

  await markWebhookEventProcessed({
    db: input.db,
    dedupeKey,
    processedAtIso: input.processedAtIso
  });
  return true;
};

export async function processLineWebhook(input: {
  rawBody: ArrayBuffer;
  signature: string | undefined;
  env: Partial<WorkerBindings>;
  now?: () => number;
}): Promise<LineWebhookResult> {
  const context = await resolveLineWebhookContext(input);
  if (!context.ok) {
    return context;
  }

  const processedAtIso = new Date((input.now ?? Date.now)()).toISOString();
  let processed = 0;

  for (const rawEvent of context.body.events) {
    try {
      if (
        await processLineWebhookEvent({
          db: context.db,
          channelId: context.channelId,
          rawEvent,
          processedAtIso
        })
      ) {
        processed += 1;
      }
    } catch (error) {
      // Unexpected failure mid-batch. Answer non-200 so LINE redelivers the
      // whole batch; replaying the events that already completed is harmless
      // because both the insert (OR IGNORE on dedupe_key) and the friend-state
      // update (guarded by last_friend_checked_at) are idempotent.
      safeCaptureException(error, { tags: { feature: "line_webhook" } });
      return {
        ok: false,
        reason: "event_processing_failed"
      };
    }
  }

  return {
    ok: true,
    processed
  };
}
