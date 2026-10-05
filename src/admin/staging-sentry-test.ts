/**
 * Staging-only synthetic Sentry test endpoint.
 *
 * POST /api/admin/staging/sentry-test
 *
 * Fires a safeCaptureException with the request body as the error message,
 * allowing staging verification that:
 *   1. Events reach Sentry when DSN is configured
 *   2. PII in the error message is redacted by beforeSend
 *
 * Hard-guarded: returns 404 on non-staging environments so the endpoint
 * is never reachable in production even if the code deploys everywhere.
 */
import type { Context } from "hono";

import { requireStagingSystemAdmin } from "./staging-drift-sweep";
import { safeCaptureException } from "../sentry-helpers";
import type { WorkerBindings } from "../bindings";

const PRIVATE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  Pragma: "no-cache"
};

export async function sentryTestHandler(
  c: Context<{ Bindings: Partial<WorkerBindings> }>
): Promise<Response> {
  const gate = await requireStagingSystemAdmin(c, PRIVATE_HEADERS);
  if (!gate.ok) {
    return gate.response;
  }

  let body: { message?: string } = {};
  try {
    body = await c.req.json<{ message?: string }>();
  } catch {
    // empty body is fine — use default message
  }

  const message = typeof body.message === "string" && body.message.length > 0
    ? body.message.slice(0, 1024)
    : "sentry-test: synthetic error from staging endpoint";

  const syntheticError = new Error(message);
  safeCaptureException(syntheticError, {
    tags: { source: "staging-sentry-test" },
    contexts: {
      test: { triggered_at: new Date().toISOString() }
    }
  });

  return c.json(
    { ok: true, message: "Sentry test event dispatched (check Sentry dashboard)" },
    200,
    PRIVATE_HEADERS
  );
}
