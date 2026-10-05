import { Hono } from "hono";
import type { AppEnvironment } from "./types";
import { statusForGoogleCalendarWebhookResult, scheduleQueueKicks } from "./shared";
import { handleGoogleCalendarWebhook } from "../google/webhook";
import { isGoogleImportEnabled } from "../runtime-config";

export const googleRoutes = new Hono<AppEnvironment>();

googleRoutes.post("/calendar/webhook", async (c) => {
  if (!isGoogleImportEnabled(c.env)) {
    // Channels can stay registered with Google while import is toggled off, so a
    // push notification can still arrive and be dropped. Surface it in Tail logs
    // (config-drift signal). Distinct event_type from the scheduled-handler noop
    // (buildImportDisabledLog) so dashboards don't conflate the two code paths.
    console.warn(
      JSON.stringify({
        event_type: "google_calendar_webhook_import_disabled",
        outcome: "ignored",
        reason: "google_import_disabled"
      })
    );
    return c.json({
      ok: true,
      importJobCreated: false,
      ignored: true,
      reason: "google_import_disabled"
    });
  }

  const result = await handleGoogleCalendarWebhook({
    db: c.env.DB,
    headers: {
      channelId: c.req.header("X-Goog-Channel-ID") ?? undefined,
      resourceId: c.req.header("X-Goog-Resource-ID") ?? undefined,
      resourceState: c.req.header("X-Goog-Resource-State") ?? undefined,
      messageNumber: c.req.header("X-Goog-Message-Number") ?? undefined,
      channelToken: c.req.header("X-Goog-Channel-Token") ?? undefined
    }
  });

  if (result.ok) {
    if (result.importJobCreated) {
      scheduleQueueKicks(c, { google: true });
    }
    return c.json(result);
  }

  return c.json(result, statusForGoogleCalendarWebhookResult(result));
});
