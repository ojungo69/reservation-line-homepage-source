import { Hono } from "hono";
import type { AppEnvironment } from "./types";
import { statusForLineWebhookResult } from "./shared";
import { processLineWebhook } from "../line/webhook";

export const lineRoutes = new Hono<AppEnvironment>();

lineRoutes.post("/webhook", async (c) => {
  const rawBody = await c.req.arrayBuffer();
  const result = await processLineWebhook({
    rawBody,
    signature: c.req.header("x-line-signature") ?? undefined,
    env: c.env
  });

  if (result.ok) {
    return c.json(result);
  }

  return c.json(result, statusForLineWebhookResult(result));
});
