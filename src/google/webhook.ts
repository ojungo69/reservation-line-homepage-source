import { sha256Hex } from "../crypto-utils";
import { logGoogleEvent } from "../logging";
import { captureBatchWriteFailure } from "../sentry-helpers";

export type GoogleCalendarWebhookHeaders = {
  channelId?: string;
  resourceId?: string;
  resourceState?: string;
  messageNumber?: string;
  channelToken?: string;
};

export type GoogleCalendarWebhookResult =
  | {
      ok: true;
      importJobCreated: boolean;
    }
  | {
      ok: false;
      reason: "invalid_request" | "invalid_channel" | "missing_database" | "write_failed";
    };

type GoogleChannelRow = {
  id: string;
  store_id: string;
  calendar_id: string;
  channel_id: string;
  resource_id: string;
  channel_token_hash: string;
  channel_token_hash_alg: "sha256";
};

const isNonEmptyString = (value: unknown, maxLength: number): value is string => {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
};

const buildPushImportDedupeKey = async (input: {
  channelId: string;
  resourceId: string;
  messageNumber: string;
}) => {
  const fingerprint = [input.channelId, input.resourceId, input.messageNumber].join("\u0000");
  return `google-push:${await sha256Hex(fingerprint)}`;
};

const constantTimeStringEqual = (left: string, right: string) => {
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (left.codePointAt(index) || 0) ^ (right.codePointAt(index) || 0);
  }
  return diff === 0;
};

const validateHeaders = (headers: GoogleCalendarWebhookHeaders) => {
  return (
    isNonEmptyString(headers.channelId, 256) &&
    isNonEmptyString(headers.resourceId, 512) &&
    isNonEmptyString(headers.resourceState, 64) &&
    isNonEmptyString(headers.messageNumber, 64) &&
    isNonEmptyString(headers.channelToken, 1024)
  );
};

const fetchChannel = async (db: D1Database, headers: GoogleCalendarWebhookHeaders) => {
  return db
    .prepare(
      `
        SELECT
          id,
          store_id,
          calendar_id,
          channel_id,
          resource_id,
          channel_token_hash,
          channel_token_hash_alg
        FROM google_calendar_channels
        WHERE channel_id = ?
          AND resource_id = ?
          AND status IN ('active', 'renewing')
        LIMIT 1
      `
    )
    .bind(headers.channelId, headers.resourceId)
    .first<GoogleChannelRow>();
};

const verifyChannelToken = async (channel: GoogleChannelRow, token: string) => {
  if (channel.channel_token_hash_alg !== "sha256") {
    return false;
  }
  const tokenHash = await sha256Hex(token);
  return constantTimeStringEqual(tokenHash, channel.channel_token_hash);
};

export async function handleGoogleCalendarWebhook(input: {
  db: D1Database | undefined;
  headers: GoogleCalendarWebhookHeaders;
  now?: () => number;
}): Promise<GoogleCalendarWebhookResult> {
  if (!input.db) {
    return {
      ok: false,
      reason: "missing_database"
    };
  }
  if (!validateHeaders(input.headers)) {
    return {
      ok: false,
      reason: "invalid_request"
    };
  }

  const channel = await fetchChannel(input.db, input.headers);
  if (!channel) {
    logGoogleEvent({
      event_type: "webhook_unknown_channel",
      outcome: "failure",
      dedupe_key: input.headers.channelId
    });
    return {
      ok: false,
      reason: "invalid_channel"
    };
  }

  const channelToken = input.headers.channelToken!;

  const tokenValid = await verifyChannelToken(channel, channelToken);
  if (!tokenValid) {
    logGoogleEvent({
      event_type: "webhook_unauthenticated",
      outcome: "failure",
      error_class: "webhook_unauthenticated",
      dedupe_key: channel.channel_id
    });
    return {
      ok: false,
      reason: "invalid_channel"
    };
  }

  const channelId = input.headers.channelId!;
  const resourceId = input.headers.resourceId!;
  const resourceState = input.headers.resourceState!;
  const messageNumber = input.headers.messageNumber!;

  logGoogleEvent({
    event_type: "webhook_received",
    outcome: "success",
    calendar_id: channel.calendar_id,
    store_id: channel.store_id,
    dedupe_key: channelId
  });

  const nowIso = new Date((input.now ?? Date.now)()).toISOString();
  const redactedHeaders = JSON.stringify({
    channelId,
    resourceId,
    resourceState,
    messageNumber
  });
  const importJobCreated = resourceState !== "sync";

  if (!importJobCreated) {
    logGoogleEvent({
      event_type: "webhook_duplicate",
      outcome: "noop",
      calendar_id: channel.calendar_id,
      dedupe_key: messageNumber
    });
  }
  const importJobDedupeKey = importJobCreated
    ? await buildPushImportDedupeKey({
      channelId,
      resourceId,
      messageNumber
    })
    : undefined;
  const statements: D1PreparedStatement[] = [
    input.db
      .prepare(
        `
          INSERT OR IGNORE INTO google_calendar_notifications (
            id,
            channel_id,
            resource_id,
            message_number,
            resource_state,
            received_at,
            headers_redacted_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `
      )
      .bind(
        crypto.randomUUID(),
        channelId,
        resourceId,
        messageNumber,
        resourceState,
        nowIso,
        redactedHeaders
      ),
    input.db
      .prepare(
        `
          UPDATE google_calendar_channels
          SET last_notification_at = ?,
              last_resource_state = ?,
              last_message_number = ?,
              updated_at = ?
          WHERE id = ?
        `
      )
      .bind(nowIso, resourceState, messageNumber, nowIso, channel.id)
  ];

  if (importJobCreated) {
    statements.push(
      input.db
        .prepare(
          `
            INSERT OR IGNORE INTO google_calendar_import_jobs (
              id,
              store_id,
              calendar_id,
              reason,
              status,
              next_run_at,
              dedupe_key,
              updated_at
            ) VALUES (?, ?, ?, 'push', 'queued', ?, ?, ?)
          `
        )
        .bind(
          crypto.randomUUID(),
          channel.store_id,
          channel.calendar_id,
          nowIso,
          importJobDedupeKey,
          nowIso
        )
    );
  }

  try {
    await input.db.batch(statements);
  } catch (error) {
    // Structured write_failed → 500; Google retries the push on 5xx, so this
    // never reaches app.onError. Surface it so a genuine enqueue failure is observable.
    // No storeId/calendarId in tags: Sentry tags are not scrubbed (unlike contexts),
    // and the email-shaped calendar ID must not reach telemetry. The failing store is
    // recoverable from the event timestamp + channel table.
    captureBatchWriteFailure(error, {
      component: "google-webhook",
      op: "batch_write_failed"
    });
    return {
      ok: false,
      reason: "write_failed"
    };
  }

  return {
    ok: true,
    importJobCreated
  };
}
