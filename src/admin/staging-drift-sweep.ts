import type { Context } from "hono";
import { INSTANCE_CONFIG } from "../instance-config";

import { authenticateAdmin, type AdminUser } from "./access";
import {
  runStagingDriftSweep,
  type StagingDriftSweepResult
} from "../google/import-sync";
import { sendQueueKick } from "../queue/queue-kick";
import { processDueLineNotificationJobs } from "../line/notifications";
import type { WorkerBindings } from "../bindings";

const PRIVATE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  Pragma: "no-cache"
};

/**
 * Shared staging + system_admin auth gate for staging-only endpoints.
 *
 * Checks in order:
 *   1. ENVIRONMENT must be "staging" (hard 404 otherwise)
 *   2. authenticateAdmin with allowServiceToken: true
 *   3. Authenticated admin must have role "system_admin"
 *
 * @param c       Hono request context
 * @param headers Response headers to attach to error responses
 * @returns Discriminated union: `{ ok: true; admin }` or `{ ok: false; response }`
 */
export async function requireStagingSystemAdmin(
  c: Context<{ Bindings: Partial<WorkerBindings> }>,
  headers: Record<string, string>
): Promise<
  | { ok: true; admin: AdminUser }
  | { ok: false; response: Response }
> {
  if (c.env.ENVIRONMENT !== "staging") {
    return { ok: false, response: c.json({ ok: false, reason: "not_found" }, 404, headers) };
  }

  const auth = await authenticateAdmin(
    {
      token: c.req.header("Cf-Access-Jwt-Assertion") ?? undefined,
      env: c.env
    },
    { allowServiceToken: true }
  );
  if (!auth.ok) {
    return {
      ok: false,
      response: c.json(
        { ok: false, reason: auth.reason },
        auth.reason === "admin_not_registered" ? 403 : 401,
        headers
      )
    };
  }

  if (auth.admin.role !== "system_admin") {
    return { ok: false, response: c.json({ ok: false, reason: "forbidden" }, 403, headers) };
  }

  return { ok: true, admin: auth.admin };
}

const VALID_STORE_IDS = new Set(INSTANCE_CONFIG.stagingStoreIds);

type DriftSweepRequest = {
  storeId: string;
  injectCount: number;
  cleanupExisting: boolean;
  kickQueue: boolean;
  syncDispatch: boolean;
};

type DriftSweepParseFailureReason = "invalid_store_id" | "invalid_inject_count";

function parseDriftSweepRequest(
  body: Record<string, unknown>
): { ok: true; data: DriftSweepRequest } | { ok: false; reason: DriftSweepParseFailureReason } {
  const storeId = typeof body.storeId === "string" ? body.storeId : "";
  if (!VALID_STORE_IDS.has(storeId)) {
    return { ok: false, reason: "invalid_store_id" as const };
  }
  const injectCount =
    typeof body.injectCount === "number" && Number.isFinite(body.injectCount)
      ? Math.floor(body.injectCount)
      : 11;
  if (injectCount < 1 || injectCount > 100) {
    return { ok: false, reason: "invalid_inject_count" as const };
  }
  return {
    ok: true,
    data: {
      storeId,
      injectCount,
      cleanupExisting: body.cleanupExisting !== false,
      kickQueue: body.kickQueue !== false,
      syncDispatch: body.syncDispatch !== false
    }
  };
}

export async function driftSweepHandler(
  c: Context<{ Bindings: Partial<WorkerBindings> }>
): Promise<Response> {
  const gate = await requireStagingSystemAdmin(c, PRIVATE_HEADERS);
  if (!gate.ok) {
    return gate.response;
  }

  const db = c.env.DB;
  if (!db) {
    return c.json({ ok: false, reason: "missing_database" }, 500, PRIVATE_HEADERS);
  }

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ ok: false, reason: "invalid_json" }, 400, PRIVATE_HEADERS);
  }

  const parsed = parseDriftSweepRequest(body);
  if (!parsed.ok) {
    return c.json({ ok: false, reason: parsed.reason }, 400, PRIVATE_HEADERS);
  }
  const { storeId, injectCount, cleanupExisting, kickQueue, syncDispatch } = parsed.data;

  const calendarRow = await db
    .prepare(`SELECT google_calendar_id FROM stores WHERE id = ? LIMIT 1`)
    .bind(storeId)
    .first<{ google_calendar_id: string | null }>();
  const calendarId = calendarRow?.google_calendar_id;
  if (!calendarId) {
    return c.json({ ok: false, reason: "store_has_no_calendar" }, 400, PRIVATE_HEADERS);
  }

  let sweep: StagingDriftSweepResult;
  try {
    sweep = await runStagingDriftSweep({
      db,
      env: c.env as WorkerBindings,
      storeId,
      calendarId,
      injectCount,
      cleanupExisting
    });
  } catch (error) {
    return c.json(
      { ok: false, reason: "sweep_failed", detail: error instanceof Error ? error.message : "unknown" },
      500,
      PRIVATE_HEADERS
    );
  }

  const hasAlertJobs = sweep.alertEnqueued && sweep.jobIds.length > 0;

  let queueKicked = false;
  if (kickQueue && hasAlertJobs) {
    await sendQueueKick(c.env.LINE_NOTIFICATION_QUEUE, { type: "line_notification_job_available" });
    queueKicked = true;
  }

  let dispatchedCount = 0;
  let succeededJobIds: string[] = [];

  if (syncDispatch && hasAlertJobs) {
    const dispatchResult = await processDueLineNotificationJobs({
      db,
      env: c.env as WorkerBindings,
      maxJobs: sweep.jobIds.length,
      jobIdsFilter: sweep.jobIds
    });
    dispatchedCount = dispatchResult.processed;

    // status='succeeded' alone does NOT mean delivered: the cross-environment
    // guard (src/line/quota.ts LINE_SHARED_CHANNEL_ENVIRONMENTS) and the monthly
    // soft cap both terminate rows that way without sending. A real send clears
    // last_error to NULL while every suppression stamps its reason there, so
    // `last_error IS NULL` is the delivery signal — and it keeps holding for any
    // suppression reason added later, which an explicit marker list would not.
    // This endpoint is staging-only, exactly where the env guard always fires, so
    // without the filter it would report every job as delivered.
    const succeededRows = await db
      .prepare(
        `SELECT id FROM notification_jobs WHERE id IN (${sweep.jobIds.map(() => "?").join(",")}) AND status = 'succeeded'
           AND last_error IS NULL`
      )
      .bind(...sweep.jobIds)
      .all<{ id: string }>();
    succeededJobIds = (succeededRows.results ?? []).map((r) => r.id);
  }

  return c.json(
    {
      ok: true,
      storeId,
      calendarId,
      sweepStartSeconds: sweep.sweepStartSeconds,
      drift: sweep.drift,
      d1Count: sweep.d1Count,
      alertEnqueued: sweep.alertEnqueued,
      insertedCount: sweep.insertedCount,
      existingCount: sweep.existingCount,
      jobIds: sweep.jobIds,
      queueKicked,
      dispatchedCount,
      succeededJobIds
    },
    200,
    PRIVATE_HEADERS
  );
}
