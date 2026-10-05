import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnvironment, QueueKickTarget, ConflictActionGuardResult, ConflictHttpStatus, ReservationPeriodFilter, ReservationPeriodFilterFailure } from "./types";
import type { AdminAuthResult, AdminUser } from "../admin/access";
import { authenticateAdmin } from "../admin/access";
import { isAdminMutationRateLimited } from "../admin/settings-route-helpers";
import { hasActiveCustomerGateGrant } from "../admin/customer-gate";
import type { AdminReservationActionResult } from "../admin/reservations";
import type { AdminCreateReservationResult } from "../admin/reservation-create";
import type { AdminRescheduleReservationResult } from "../admin/reservation-reschedule";
import type { AdminExternalBlockResult } from "../admin/external-blocks";
import type { AdminCustomerBlockResult } from "../admin/customer-actions";
import type { AdminSyncJobRetryResult, AdminSyncJobAcknowledgeResult, AdminSyncConflictResolutionResult } from "../admin/sync-recovery";
import type { AllDayApproveResult, AllDayRejectResult, CancelApprovalResult, RejectDeleteResult } from "../admin/conflict-resolutions";
import type {
  AdminAddCustomerVisitResult,
  AdminUpdateCustomerVisitResult,
  AdminDeleteCustomerVisitResult,
} from "../admin/customer-visits";
import type { AdminCreateCustomerResult } from "../admin/customer-create";
import type { GoogleCalendarWebhookResult } from "../google/webhook";
import type { LineWebhookResult } from "../line/webhook";
import type { PublicReservationResult } from "../reservations/public-submit";
import type { PublicAvailabilityResult } from "../reservations/public-options";
import { sendQueueKick } from "../queue/queue-kick";
import { VALID_RESERVATION_STATUSES } from "../admin/operations";
import { staffCanAccessCustomer } from "../admin/customers";
import { escapeLikePattern, exceedsLikePatternBudget, jstDayRangeFromKey } from "../admin/shared";
import type { WorkerBindings } from "../bindings";
import type { AdminReservationListRange } from "../admin/operations";

// Constants

export const PRIVATE_RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  Pragma: "no-cache"
};

export const ADMIN_PRIVATE_HEADERS = PRIVATE_RESPONSE_HEADERS;
export const PUBLIC_RESERVATION_HEADERS = PRIVATE_RESPONSE_HEADERS;

export const FORBIDDEN_BODY = { ok: false, reason: "forbidden" } as const;
// Distinct from FORBIDDEN_BODY so the SPA can tell "you may never do this" from
// "enter the owner's code and you may" — the card is rendered off this reason.
export const CUSTOMER_GATE_REQUIRED_BODY = {
  ok: false,
  reason: "customer_gate_required"
} as const;
export const MISSING_DB_BODY = { ok: false, reason: "missing_database" } as const;

export const SEARCH_LIMIT = 500;
export const SEARCH_QUERY_LIMIT = SEARCH_LIMIT + 1;

export const RRULE_PREVIEW_MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

const FILTER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const KEYWORD_MAX_CHARS = 120;
const STATUS_MAX_DISTINCT = 8;
const CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/g;

// Utility functions

export const isObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

export const getString = (body: Record<string, unknown>, key: string, maxLength: number) => {
  const value = body[key];
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : undefined;
};

export const getStringArray = (body: Record<string, unknown>, key: string, maxItems: number, maxLength: number) => {
  const value = body[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") {
      return undefined;
    }
    const normalized = item.trim();
    if (!normalized || normalized.length > maxLength || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    items.push(normalized);
    if (items.length >= maxItems) {
      break;
    }
  }
  return items.length > 0 ? items : undefined;
};

// Queue kick helper

export const scheduleQueueKicks = (
  c: Context<AppEnvironment>,
  target: QueueKickTarget
) => {
  const tasks: Promise<void>[] = [];
  if (target.google) {
    tasks.push(sendQueueKick(c.env.GOOGLE_SYNC_QUEUE, { type: "google_sync_job_available" }));
  }
  if (target.line) {
    tasks.push(sendQueueKick(c.env.LINE_NOTIFICATION_QUEUE, { type: "line_notification_job_available" }));
  }
  if (tasks.length === 0) {
    return;
  }

  const promise = Promise.all(tasks).then(() => undefined);
  try {
    c.executionCtx.waitUntil(promise);
  } catch {
    promise.catch(() => {});
  }
};

// Workflow trigger helper

const isDuplicateWorkflowInstanceError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return msg.includes("already exists") || msg.includes("duplicate");
};

export const triggerReservationWorkflow = (
  c: Context<AppEnvironment>,
  reservationId: string,
  version: number
) => {
  const workflow = c.env.RESERVATION_WORKFLOW;
  if (!workflow) {
    scheduleQueueKicks(c, { google: true, line: true });
    return;
  }

  const instanceId = `approve-${reservationId}-v${version}`;
  const promise = workflow.create({
    id: instanceId,
    params: { reservationId, version }
  }).catch((error: unknown) => {
    if (isDuplicateWorkflowInstanceError(error)) return;
    console.error("workflow_create_failed", { instanceId, error: String(error) });
    scheduleQueueKicks(c, { google: true, line: true });
  });

  try {
    c.executionCtx.waitUntil(promise);
  } catch {
    promise.catch(() => {});
  }
};

// Period filter parsing

function parseFilterStatuses(url: URL): Set<string> | { reason: "invalid_status" } {
  const rawStatuses = url.searchParams.getAll("status");
  const statuses = new Set<string>();
  for (const value of rawStatuses) {
    if (!VALID_RESERVATION_STATUSES.has(value)) {
      return { reason: "invalid_status" };
    }
    statuses.add(value);
    if (statuses.size > STATUS_MAX_DISTINCT) {
      return { reason: "invalid_status" };
    }
  }
  return statuses;
}

function parseFilterKeyword(
  url: URL
): string | undefined | { reason: "invalid_keyword" } {
  const rawKeyword = url.searchParams.get("keyword");
  if (rawKeyword === null) return undefined;
  const cleaned = rawKeyword.replace(CONTROL_CHAR_RE, "").trim();
  if (cleaned.length === 0) return undefined;
  if (cleaned.length > KEYWORD_MAX_CHARS) return { reason: "invalid_keyword" };
  const pattern = `%${escapeLikePattern(cleaned)}%`;
  if (exceedsLikePatternBudget(pattern)) {
    return { reason: "invalid_keyword" };
  }
  return cleaned;
}

export const parseReservationPeriodFilter = (
  url: URL
): { ok: true; filter: ReservationPeriodFilter } | ReservationPeriodFilterFailure => {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (typeof from !== "string" || typeof to !== "string") {
    return { ok: false, reason: "invalid_date" };
  }
  if (!jstDayRangeFromKey(from) || !jstDayRangeFromKey(to)) {
    return { ok: false, reason: "invalid_date" };
  }

  const storeId = url.searchParams.get("storeId") ?? undefined;
  if (storeId !== undefined && !FILTER_ID_RE.test(storeId)) {
    return { ok: false, reason: "invalid_filter" };
  }
  const serviceId = url.searchParams.get("serviceId") ?? undefined;
  if (serviceId !== undefined && !FILTER_ID_RE.test(serviceId)) {
    return { ok: false, reason: "invalid_filter" };
  }

  const statusesResult = parseFilterStatuses(url);
  if (!(statusesResult instanceof Set)) {
    return { ok: false, reason: statusesResult.reason };
  }
  const statuses = statusesResult;

  const keywordResult = parseFilterKeyword(url);
  if (typeof keywordResult === "object" && keywordResult !== null) {
    return { ok: false, reason: keywordResult.reason };
  }
  const keyword = keywordResult;

  return {
    ok: true,
    filter: { from, to, storeId, serviceId, statuses, keyword }
  };
};

export const parseReservationListRange = (value: string | undefined): AdminReservationListRange => {
  if (value === "tomorrow") return "tomorrow";
  if (value === "date") return "date";
  return "today";
};

// Admin period handler prelude

export const prepareAdminPeriodHandler = async (
  c: Context<{ Bindings: Partial<WorkerBindings> }>,
  options: { allowServiceToken?: boolean } = {}
): Promise<
  | { ok: true; db: D1Database; admin: AdminUser; filter: ReservationPeriodFilter }
  | { ok: false; response: Response }
> => {
  const auth = await authenticateAdmin(
    {
      token: c.req.header("Cf-Access-Jwt-Assertion") ?? undefined,
      env: c.env
    },
    options.allowServiceToken ? { allowServiceToken: true } : undefined
  );
  if (!auth.ok) {
    return {
      ok: false,
      response: c.json(
        { ok: false, reason: auth.reason },
        statusForAdminAuthResult(auth)
      )
    };
  }
  if (!c.env.DB) {
    return {
      ok: false,
      response: c.json({ ok: false, reason: "missing_database" }, 500)
    };
  }
  const filterParse = parseReservationPeriodFilter(new URL(c.req.url));
  if (!filterParse.ok) {
    return {
      ok: false,
      response: c.json(filterParse, 400, ADMIN_PRIVATE_HEADERS)
    };
  }
  // For staff, enforce store_id filter to their own store. This replaces
  // the previous blanket staff denial and scopes period search to their store.
  const filter = filterParse.filter;
  if (auth.admin.role === "staff") {
    if (auth.admin.store_id) {
      filter.storeId = auth.admin.store_id;
    } else {
      return {
        ok: false,
        response: c.json(FORBIDDEN_BODY, 403, ADMIN_PRIVATE_HEADERS)
      };
    }
  }
  return { ok: true, db: c.env.DB, admin: auth.admin, filter };
};

// Owner + DB gate

export const requireOwnerWithDb = (
  c: Context<AppEnvironment>,
  auth: { admin: { role: string } }
): Response | null => {
  if (!c.env.DB) return c.json(MISSING_DB_BODY, 500);
  if (auth.admin.role === "staff") return c.json(FORBIDDEN_BODY, 403, ADMIN_PRIVATE_HEADERS);
  return null;
};

// Store scope check

/**
 * Staff without a store_id (staff_member_id NULL or staff_members deleted)
 * must be denied on all store-scoped endpoints. Fail closed.
 *
 * Blank counts as "no store". `""` is not null, so it used to pass here while
 * the scope builders (storeScopeMembership / listAllCustomers) read a blank
 * store as "no scope = every store" — the two halves disagreeing is what let a
 * `store_id = ''` staff row list all customers (issue #640 B-1). Both halves now
 * treat blank as no store; the builders bind it and match nothing.
 */
export const staffHasStore = (
  admin: { role: string; store_id: string | null }
): admin is { role: string; store_id: string } => {
  if (admin.role !== "staff") return true;
  return admin.store_id !== null && admin.store_id.trim() !== "";
};

/**
 * Per-customer store-scope gate for staff. Owner / system_admin always pass
 * (returns null). A staff user is allowed ONLY when they have a store binding and
 * the customer is canonical (not merged/archived) with a reservation or VALID visit
 * at that store; otherwise returns a 403 response. Fail closed for staff with no
 * store_id. Use on per-customer mutation/detail routes that staff may now reach
 * (memo / profile / detail) but only for their own-store customers.
 */
export const assertStaffCustomerStoreScope = async (
  c: Context<AppEnvironment>,
  db: D1Database,
  customerId: string,
  admin: { role: string; store_id: string | null }
): Promise<Response | null> => {
  if (admin.role !== "staff") return null;
  if (!admin.store_id) return c.json(FORBIDDEN_BODY, 403, ADMIN_PRIVATE_HEADERS);
  const allowed = await staffCanAccessCustomer(db, customerId, admin.store_id);
  return allowed ? null : c.json(FORBIDDEN_BODY, 403, ADMIN_PRIVATE_HEADERS);
};

/**
 * Owner-approval gate for the customer tab (spec 008). Owner / system_admin always
 * pass. A staff user passes only while holding a grant from a verified one-time code.
 *
 * Called inline right after the caller is resolved, NOT as path middleware: the
 * customer routes and the schedule's reservation detail share the `/customers/*`
 * prefix, and the owner's decision was to gate the customer tab only.
 */
export const assertCustomerTabGate = async (
  c: Context<AppEnvironment>,
  db: D1Database,
  admin: { id: string; role: string }
): Promise<Response | null> => {
  if (admin.role !== "staff") return null;
  const granted = await hasActiveCustomerGateGrant(db, admin.id);
  return granted ? null : c.json(CUSTOMER_GATE_REQUIRED_BODY, 403, ADMIN_PRIVATE_HEADERS);
};

// Conflict action guard

export const guardConflictAction = async (
  c: Context<AppEnvironment>
): Promise<ConflictActionGuardResult> => {
  const auth = await authenticateAdmin({
    token: c.req.header("Cf-Access-Jwt-Assertion") ?? undefined,
    env: c.env
  });
  if (!auth.ok) {
    return {
      ok: false,
      response: c.json(
        { ok: false, reason: auth.reason },
        statusForAdminAuthResult(auth),
        ADMIN_PRIVATE_HEADERS
      )
    };
  }
  if (!c.env.DB) {
    return {
      ok: false,
      response: c.json({ ok: false, reason: "missing_database" }, 500, ADMIN_PRIVATE_HEADERS)
    };
  }
  // Conflict-resolution routes are state-changing admin mutations gated by their
  // own auth primitive (not authenticateAdminRoute), so apply the same per-admin
  // rate-limit chokepoint here too — otherwise a stolen Access cookie could spam
  // sync conflict approvals / reservation cancel-delete without the 300/10min cap.
  if (await isAdminMutationRateLimited(c, c.env.DB, auth.admin.id)) {
    return {
      ok: false,
      response: c.json({ ok: false, reason: "rate_limited" }, 429, ADMIN_PRIVATE_HEADERS)
    };
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return {
      ok: false,
      response: c.json({ ok: false, reason: "invalid_request" }, 400, ADMIN_PRIVATE_HEADERS)
    };
  }
  if (!isObject(body)) {
    return {
      ok: false,
      response: c.json({ ok: false, reason: "invalid_request" }, 400, ADMIN_PRIVATE_HEADERS)
    };
  }
  const idempotencyKey = getString(body, "idempotencyKey", 256);
  if (!idempotencyKey) {
    return {
      ok: false,
      response: c.json({ ok: false, reason: "invalid_request" }, 400, ADMIN_PRIVATE_HEADERS)
    };
  }
  const conflictId = c.req.param("conflictId");
  if (!conflictId) {
    return {
      ok: false,
      response: c.json({ ok: false, reason: "invalid_request" }, 400, ADMIN_PRIVATE_HEADERS)
    };
  }
  return {
    ok: true,
    ctx: { admin: auth.admin, db: c.env.DB, body, idempotencyKey, conflictId }
  };
};

// Status mappers

export const statusForAdminAuthResult = (result: AdminAuthResult) => {
  return result.ok ? 200 : 403;
};

export const statusForPublicReservationResult = (result: PublicReservationResult) => {
  if (result.ok) {
    return result.replayed ? 200 : 201;
  }

  if (
    result.reason === "idempotency_conflict" ||
    result.reason === "idempotency_in_progress" ||
    result.reason === "slot_unavailable" ||
    result.reason === "customer_time_conflict" ||
    result.reason === "reservation_limit_reached" ||
    result.reason === "duplicate_reservation_consent_required"
  ) {
    return 409;
  }

  if (result.reason === "write_failed") {
    return 500;
  }

  return 400;
};

export const statusForPublicAvailabilityResult = (result: PublicAvailabilityResult) => {
  if (result.ok) {
    return 200;
  }
  return result.reason === "invalid_request" || result.reason === "duration_limit_exceeded" ? 400 : 404;
};

const ADMIN_ACTION_FAILURE_STATUS = {
  forbidden: 403,
  not_found: 404,
  invalid_transition: 409,
  // 楽観ロック不一致 (expectedVersion 指定時)。状態競合なので 409 — UI は最新を
  // 再読み込みして再確認する。
  stale_snapshot: 409,
  idempotency_conflict: 409,
  idempotency_in_progress: 409,
  line_not_reachable: 409,
  store_closed: 400,
  write_failed: 500,
  invalid_request: 400,
} as const satisfies Record<string, ContentfulStatusCode>;
export const statusForAdminActionResult = (result: AdminReservationActionResult): ContentfulStatusCode =>
  result.ok ? 200 : ADMIN_ACTION_FAILURE_STATUS[result.reason];

const ADMIN_CREATE_RESERVATION_FAILURE_STATUS = {
  invalid_request: 400,
  idempotency_conflict: 409,
  idempotency_in_progress: 409,
  store_not_found: 400,
  service_not_available: 400,
  resource_not_available: 400,
  invalid_time: 400,
  outside_business_hours: 400,
  store_closed: 400,
  slot_unavailable: 409,
  customer_time_conflict: 409,
  customer_blocked: 400,
  customer_not_found: 404,
  forbidden: 403,
  write_failed: 500,
} as const satisfies Record<string, ContentfulStatusCode>;
export const statusForAdminCreateReservationResult = (result: AdminCreateReservationResult): ContentfulStatusCode => {
  if (result.ok) return result.replayed ? 200 : 201;
  return ADMIN_CREATE_RESERVATION_FAILURE_STATUS[result.reason];
};

const ADMIN_RESCHEDULE_FAILURE_STATUS = {
  invalid_request: 400,
  forbidden: 400,
  not_found: 404,
  invalid_transition: 409,
  idempotency_conflict: 409,
  idempotency_in_progress: 409,
  invalid_time: 400,
  outside_business_hours: 400,
  store_closed: 400,
  slot_unavailable: 409,
  customer_time_conflict: 409,
  write_failed: 500,
} as const satisfies Record<string, ContentfulStatusCode>;
export const statusForAdminRescheduleReservationResult = (result: AdminRescheduleReservationResult): ContentfulStatusCode =>
  result.ok ? 200 : ADMIN_RESCHEDULE_FAILURE_STATUS[result.reason];

const ADMIN_EXTERNAL_BLOCK_FAILURE_STATUS = {
  invalid_request: 400,
  forbidden: 403,
  not_found: 404,
  invalid_transition: 409,
  idempotency_conflict: 409,
  idempotency_in_progress: 409,
  store_not_found: 400,
  resource_not_available: 400,
  invalid_time: 400,
  slot_unavailable: 409,
  write_failed: 500,
} as const satisfies Record<string, ContentfulStatusCode>;
export const statusForAdminExternalBlockResult = (result: AdminExternalBlockResult): ContentfulStatusCode => {
  if (result.ok) return result.replayed ? 200 : 201;
  return ADMIN_EXTERNAL_BLOCK_FAILURE_STATUS[result.reason];
};

const GOOGLE_WEBHOOK_FAILURE_STATUS = {
  invalid_request: 400,
  invalid_channel: 401,
  missing_database: 500,
  write_failed: 500,
} as const satisfies Record<string, ContentfulStatusCode>;
export const statusForGoogleCalendarWebhookResult = (result: GoogleCalendarWebhookResult): ContentfulStatusCode =>
  result.ok ? 200 : GOOGLE_WEBHOOK_FAILURE_STATUS[result.reason];

const LINE_WEBHOOK_FAILURE_STATUS = {
  invalid_signature: 401,
  invalid_request: 400,
  missing_database: 500,
  // Unexpected event-processing failure: non-200 makes LINE redeliver the
  // batch, which is safe because event handling is idempotent.
  event_processing_failed: 500,
} as const satisfies Record<string, ContentfulStatusCode>;
export const statusForLineWebhookResult = (result: LineWebhookResult): ContentfulStatusCode =>
  result.ok ? 200 : LINE_WEBHOOK_FAILURE_STATUS[result.reason];

const ADMIN_PROTECTED_WORKFLOW_FAILURE_STATUS = {
  forbidden: 403,
  not_found: 404,
  invalid_transition: 409,
  idempotency_conflict: 409,
  idempotency_in_progress: 409,
  write_failed: 500,
  invalid_request: 400,
} as const satisfies Record<string, ContentfulStatusCode>;
export const statusForAdminProtectedWorkflowResult = (
  result:
    | AdminCustomerBlockResult
    | AdminSyncJobRetryResult
    | AdminSyncJobAcknowledgeResult
    | AdminSyncConflictResolutionResult
): ContentfulStatusCode => {
  if (result.ok) return 200;
  return ADMIN_PROTECTED_WORKFLOW_FAILURE_STATUS[result.reason];
};

const ADMIN_ADD_CUSTOMER_VISIT_FAILURE_STATUS = {
  forbidden: 403,
  invalid_request: 400,
  invalid_visit_date: 400,
  future_visit_date: 400,
  notes_too_long: 400,
  invalid_store: 400,
  not_found: 404,
  idempotency_conflict: 409,
  idempotency_in_progress: 409,
  write_failed: 500,
} as const satisfies Record<string, ContentfulStatusCode>;
export const statusForAdminAddCustomerVisitResult = (
  result: AdminAddCustomerVisitResult
): ContentfulStatusCode => {
  if (result.ok) return result.replayed ? 200 : 201;
  return ADMIN_ADD_CUSTOMER_VISIT_FAILURE_STATUS[result.reason];
};

// Manual visit DATE edit. Success is always 200 (mutation, not a create). A
// visit whose reservation_id is non-null is immutable here → reservation_linked
// (409, conflict with immutable state — consistent with idempotency_conflict).
const ADMIN_UPDATE_CUSTOMER_VISIT_FAILURE_STATUS = {
  forbidden: 403,
  invalid_request: 400,
  invalid_visit_date: 400,
  future_visit_date: 400,
  not_found: 404,
  reservation_linked: 409,
  idempotency_conflict: 409,
  idempotency_in_progress: 409,
  write_failed: 500,
} as const satisfies Record<string, ContentfulStatusCode>;
export const statusForAdminUpdateCustomerVisitResult = (
  result: AdminUpdateCustomerVisitResult
): ContentfulStatusCode => {
  if (result.ok) return 200;
  return ADMIN_UPDATE_CUSTOMER_VISIT_FAILURE_STATUS[result.reason];
};

// Manual visit delete (owner+). Same reservation_linked guard.
const ADMIN_DELETE_CUSTOMER_VISIT_FAILURE_STATUS = {
  forbidden: 403,
  invalid_request: 400,
  not_found: 404,
  reservation_linked: 409,
  write_failed: 500,
} as const satisfies Record<string, ContentfulStatusCode>;
export const statusForAdminDeleteCustomerVisitResult = (
  result: AdminDeleteCustomerVisitResult
): ContentfulStatusCode => {
  if (result.ok) return 200;
  return ADMIN_DELETE_CUSTOMER_VISIT_FAILURE_STATUS[result.reason];
};

// Manual customer create (owner+). Fresh create → 201; idempotent replay → 200.
const ADMIN_CREATE_CUSTOMER_FAILURE_STATUS = {
  forbidden: 403,
  invalid_request: 400,
  idempotency_conflict: 409,
  idempotency_in_progress: 409,
  write_failed: 500,
} as const satisfies Record<string, ContentfulStatusCode>;
export const statusForAdminCreateCustomerResult = (
  result: AdminCreateCustomerResult
): ContentfulStatusCode => {
  if (result.ok) return result.replayed ? 200 : 201;
  return ADMIN_CREATE_CUSTOMER_FAILURE_STATUS[result.reason];
};

type AllDayResult = AllDayApproveResult | AllDayRejectResult;
export const statusForAllDayResult = (result: AllDayResult): ConflictHttpStatus => {
  if (result.ok) return 200;
  switch (result.reason) {
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "already_resolved":
    case "idempotency_conflict":
    case "idempotency_in_progress":
    case "overlapping_reservations":
      return 409;
    case "write_failed":
      return 500;
    case "invalid_request":
    case "invalid_conflict_type":
    case "invalid_snapshot":
    default:
      return 400;
  }
};

export const statusForCancelApprovalResult = (
  result: CancelApprovalResult | RejectDeleteResult
): ConflictHttpStatus => {
  if (result.ok) return 200;
  switch (result.reason) {
    case "forbidden":
      return 403;
    case "not_found":
    case "reservation_not_found":
      return 404;
    case "already_resolved":
    case "idempotency_conflict":
    case "idempotency_in_progress":
      return 409;
    case "write_failed":
      return 500;
    case "invalid_request":
    case "invalid_conflict_type":
    case "invalid_state":
    default:
      return 400;
  }
};
