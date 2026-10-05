import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnvironment } from "./types";
import { readLineQuotaStatus } from "../line/quota";
import {
  ADMIN_PRIVATE_HEADERS,
  FORBIDDEN_BODY,
  MISSING_DB_BODY,
  SEARCH_LIMIT,
  SEARCH_QUERY_LIMIT,
  RRULE_PREVIEW_MAX_WINDOW_MS,
  isObject,
  getString,
  scheduleQueueKicks,
  triggerReservationWorkflow,
  prepareAdminPeriodHandler,
  parseReservationListRange,
  requireOwnerWithDb,
  staffHasStore,
  assertStaffCustomerStoreScope,
  assertCustomerTabGate,
  CUSTOMER_GATE_REQUIRED_BODY,
  guardConflictAction,
  statusForAdminAuthResult,
  statusForAdminActionResult,
  statusForAdminCreateReservationResult,
  statusForAdminRescheduleReservationResult,
  statusForAdminExternalBlockResult,
  statusForAdminProtectedWorkflowResult,
  statusForAllDayResult,
  statusForCancelApprovalResult,
  statusForAdminAddCustomerVisitResult,
  statusForAdminUpdateCustomerVisitResult,
  statusForAdminDeleteCustomerVisitResult,
  statusForAdminCreateCustomerResult
} from "./shared";
import { isWorkflowEnabled } from "../runtime-config";
import { authenticateAdmin } from "../admin/access";
import { adminWriteGuard, adminWriteWasRevoked } from "../admin/write-authorization";
import {
  deletePushSubscription,
  adminPushPublicKey,
  normalizePushEndpoint,
  parsePushSubscription,
  savePushSubscription,
  sendAdminPushTest
} from "../notifications/admin-push";
import {
  listPendingReservations,
  listUnpaidCancellationFees,
  runAdminReservationAction,
  type AdminReservationAction
} from "../admin/reservations";
import {
  createAdminReservation,
  type AdminCreateReservationRequest
} from "../admin/reservation-create";
import { MAX_TOTAL_SERVICE_DURATION_MINUTES, RESERVATION_INTERVAL_MINUTES } from "../reservations/slot-times";
import { autoCompleteReservations } from "../reservations/auto-complete";
import { isNonEmptyString } from "../admin/reservation-time-utils";
import {
  rescheduleAdminReservation,
  isReschedulableReservation,
  type AdminRescheduleReservationRequest
} from "../admin/reservation-reschedule";
import {
  cancelAdminExternalBlock,
  createAdminExternalBlock,
  type AdminCreateExternalBlockRequest
} from "../admin/external-blocks";
import {
  setAdminCustomerBlockStatus,
  setAdminCustomerArchiveStatus,
  type AdminCustomerArchiveResult,
} from "../admin/customer-actions";
import {
  addAdminCustomerVisit,
  updateAdminCustomerVisit,
  deleteAdminCustomerVisit,
  type AdminAddCustomerVisitRequest,
  type AdminUpdateCustomerVisitRequest
} from "../admin/customer-visits";
import {
  createAdminCustomer,
  type AdminCreateCustomerRequest
} from "../admin/customer-create";
import {
  executeAdminCustomerMerge,
  parseAdminCustomerMergeRequest,
  type AdminCustomerMergeError
} from "../admin/customer-merge";
import {
  executeAdminCustomerDelete,
  type CustomerDeleteReason
} from "../admin/customer-delete";
import {
  createAdminService,
  parseAdminServiceCreateRequest,
  parseAdminServiceUpdateRequest,
  softDeleteAdminService,
  updateAdminService
} from "../admin/settings-services";
import {
  createAdminResource,
  parseAdminResourceCreateRequest,
  parseAdminResourceUpdateRequest,
  softDeleteAdminResource,
  updateAdminResource
} from "../admin/settings-resources";
import {
  createAdminStaff,
  parseAdminStaffCreateRequest,
  parseAdminStaffUpdateRequest,
  softDeleteAdminStaff,
  updateAdminStaff
} from "../admin/settings-staff";
import { isAdminPrivileged, sha256Hex } from "../admin/settings-common";
import { escapeLikePattern, exceedsLikePatternBudget, normalizePhone } from "../admin/shared";
import {
  listStoreLogins,
  parseStoreLoginUpsertRequest,
  revokeStoreLogin,
  upsertStoreLogin
} from "../admin/settings-store-login";
import {
  createAdminClosure,
  deleteAdminClosure,
  parseAdminClosureCreateRequest,
  parseAdminClosureUpdateRequest,
  updateAdminClosure
} from "../admin/settings-closures";
import {
  parseAdminReminderUpdateRequest,
  updateAdminReminderSettings
} from "../admin/settings-reminder";
import {
  parseReservationCapUpdateRequest,
  updateAdminReservationCapSettings
} from "../admin/settings-reservation-cap";
import {
  parseBookingWindowUpdateRequest,
  updateAdminBookingWindowSettings
} from "../admin/settings-booking-window";
import {
  parseCustomerNoticeUpdateRequest,
  updateAdminCustomerNoticeSettings
} from "../admin/settings-customer-notice";
import {
  parseLinkLineFriendRequest,
  syncLineFriendDirectory,
  listLineFriends,
  linkLineFriend
} from "../admin/line-friends";
import {
  parseAdminGoogleEditModeUpdateRequest,
  updateAdminGoogleEditMode
} from "../admin/settings-google-edit";
import { getBusinessHours, putBusinessHours } from "../admin/settings-business-hours";
import type { BusinessHourRow } from "../admin/settings-business-hours";
import { withOutboundTimeout } from "../outbound-timeout";
import { parseStrictIsoInstantMs, parseStrictIsoOffsetInstantMs } from "../admin/parse-iso-instant";
import {
  commitAdminRecurring,
  parseAdminRecurringCommitRequest,
  type AdminRecurringCommitError
} from "../admin/recurring-commit";
import {
  isAdminMutationRateLimited,
  isRouteFailure,
  parseAdminJsonBody,
  requireAdminContext,
  respondAdminMutation
} from "../admin/settings-route-helpers";
import {
  getAdminCustomerDetail,
  listAdminCustomerConsents,
  listAdminCustomerVisits,
  listAdminCustomerReservations,
  getAdminReservationDetail,
  getAdminSettingsSnapshot,
  getAvailableSlots,
  listAdminAuditLogs,
  listAdminExternalBlocks,
  listAdminReservations,
  listAdminReservationsForPeriod,
  ADMIN_AUDIT_ACTOR_TYPES,
  type AdminAuditActorType
} from "../admin/operations";
import {
  reservationsCsvFilename,
  reservationsCsvStreamPaged,
  PAGED_ROWS_PER_PAGE,
  PAGED_MAX_PAGES
} from "../admin/csv";
import { archiveCsvToR2 } from "../storage/r2-helpers";
import { safeCaptureException } from "../sentry-helpers";
import { expandRrule } from "../google/rrule-expander";
import { JST_OFFSET_MS } from "../time-utils";
import { searchAdminCustomers, listAllCustomers, listCustomerMergeCandidates, OWN_STORE_MEMBERSHIP_ARMS } from "../admin/customers";
import {
  hasActiveCustomerGateGrant,
  requestCustomerGateCode,
  verifyCustomerGateCode
} from "../admin/customer-gate";
import {
  acknowledgeAdminSyncJob,
  isAdminSyncJobSource,
  resolveAdminGoogleConflict,
  retryAdminSyncJob,
  type AdminSyncJobAcknowledgeRequest,
  type AdminSyncJobRetryRequest,
  type AdminSyncConflictResolutionRequest
} from "../admin/sync-recovery";
import { getAdminSyncStatus } from "../admin/sync-status";
import {
  approveAllDayAsClosure,
  rejectAllDayConflict,
  approveReservationDeleteAsCancel,
  rejectReservationDeleteConflict,
  type AllDayApproveRequest,
  type AllDayRejectRequest
} from "../admin/conflict-resolutions";
import { driftSweepHandler } from "../admin/staging-drift-sweep";
import { sentryTestHandler } from "../admin/staging-sentry-test";

export const adminApiRoutes = new Hono<AppEnvironment>();

// CSRF / cross-origin defense for state-changing admin requests.
//
// Admin auth trusts the Cloudflare Access-injected `Cf-Access-Jwt-Assertion`,
// which proves the caller is an authenticated admin but does NOT stop a
// logged-in admin's browser from being induced into issuing a cross-site
// request (the Access cookie rides along). For unsafe methods we therefore
// reject requests the browser itself labels cross-site/cross-origin via the
// `Sec-Fetch-Site` metadata header, and reject any request whose `Origin`
// host does not match the request `Host`.
//
// A genuine CSRF attack is necessarily browser-driven, and modern browsers
// always send `Sec-Fetch-Site` — so allowing the header's *absence*
// (non-browser clients such as server-to-server callers and the test harness,
// which cannot be CSRF victims) is safe and avoids breaking those callers.
// Mirrors the Sec-Fetch-Site guard already used on the public customer routes
// (`src/routes/public.ts` `passedSecFetchSiteGuard`).
const ADMIN_UNSAFE_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const hostOf = (value: string): string | null => {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
};

adminApiRoutes.use("*", async (c, next) => {
  if (ADMIN_UNSAFE_METHODS.has(c.req.method)) {
    const site = c.req.header("Sec-Fetch-Site");
    if (site === "cross-site" || site === "cross-origin") {
      return c.json({ ok: false, error: "forbidden" }, 403, ADMIN_PRIVATE_HEADERS);
    }
    const origin = c.req.header("Origin");
    if (origin) {
      const originHost = hostOf(origin);
      const reqHost = c.req.header("Host") ?? hostOf(c.req.url);
      if (!originHost || originHost !== reqHost) {
        return c.json({ ok: false, error: "forbidden" }, 403, ADMIN_PRIVATE_HEADERS);
      }
    }
  }
  await next();
});

// Auth info endpoint for SPA bootstrap

adminApiRoutes.get("/me", async (c) => {
  if (c.env.ENVIRONMENT === "local") {
    return c.json({
      ok: true,
      admin: { email: "dev@local", role: "owner" as const, staffMemberId: null, storeId: null },
      vapidPublicKey: adminPushPublicKey(c.env),
    }, 200, ADMIN_PRIVATE_HEADERS);
  }

  const auth = await authenticateAdmin({
    token: c.req.header("Cf-Access-Jwt-Assertion") ?? undefined,
    env: c.env,
  });

  if (!auth.ok) {
    return c.json({ ok: false, error: auth.reason }, statusForAdminAuthResult(auth), ADMIN_PRIVATE_HEADERS);
  }

  return c.json({
    ok: true,
    admin: {
      email: auth.admin.email,
      role: auth.admin.role,
      staffMemberId: auth.admin.staff_member_id,
      storeId: auth.admin.store_id,
    },
    // Public half of the Web Push key pair. Empty unless this environment can
    // actually send (all of key pair + VAPID contact) — the SPA then hides the
    // notification controls instead of registering a device that hears nothing.
    vapidPublicKey: adminPushPublicKey(c.env),
  }, 200, ADMIN_PRIVATE_HEADERS);
});

// Local parsers (admin-only)

const parseAdminIdempotentReasonRequest = (body: unknown) => {
  if (!isObject(body)) {
    return undefined;
  }

  const idempotencyKey = getString(body, "idempotencyKey", 256);
  const reason = getString(body, "reason", 500);
  if (!idempotencyKey) {
    return undefined;
  }

  return {
    idempotencyKey,
    reason
  };
};

const ADMIN_RESERVATION_ORIGINS = new Set(["minimo", "phone", "walk_in", "other"]);

const parseAdminCreateServiceIds = (body: Record<string, unknown>): string[] | undefined => {
  const rawServiceIds = Object.hasOwn(body, "serviceIds")
    ? body.serviceIds
    : [body.serviceId];
  if (!Array.isArray(rawServiceIds) || rawServiceIds.length === 0) {
    return undefined;
  }
  for (const serviceId of rawServiceIds) {
    if (
      typeof serviceId !== "string" ||
      serviceId.length > 128 ||
      serviceId.trim().length === 0
    ) {
      return undefined;
    }
  }
  return rawServiceIds;
};

const parseAdminCreateReservationRequest = (body: unknown): AdminCreateReservationRequest | undefined => {
  if (!isObject(body)) {
    return undefined;
  }

  const idempotencyKey = getString(body, "idempotencyKey", 256);
  const source = body.source === "phone_admin" || body.source === "admin" ? body.source : undefined;
  const storeId = getString(body, "storeId", 64);
  const serviceIds = parseAdminCreateServiceIds(body);
  const resourceId = getString(body, "resourceId", 128);
  const startAt = getString(body, "startAt", 64);

  if (!idempotencyKey || !source || !storeId || !serviceIds || !resourceId || !startAt) {
    return undefined;
  }

  const origin =
    typeof body.origin === "string" && ADMIN_RESERVATION_ORIGINS.has(body.origin)
      ? (body.origin as AdminCreateReservationRequest["origin"])
      : undefined;
  if (body.origin !== undefined && origin === undefined) {
    return undefined;
  }

  const customerId = getString(body, "customerId", 64);

  // Existing-customer mode: customerId present, customer absent.
  if (customerId) {
    if (isObject(body.customer)) {
      return undefined;
    }
    return {
      idempotencyKey,
      source,
      storeId,
      serviceIds,
      resourceId,
      startAt,
      customerId,
      origin,
    };
  }

  // New-customer mode: customer object required.
  if (!isObject(body.customer)) {
    return undefined;
  }
  const displayName = getString(body.customer, "displayName", 120);
  const displayNameKana = getString(body.customer, "displayNameKana", 120);
  const phone = getString(body.customer, "phone", 32);
  if (!displayName || !phone) {
    return undefined;
  }
  return {
    idempotencyKey,
    source,
    storeId,
    serviceIds,
    resourceId,
    startAt,
    customer: {
      displayName,
      displayNameKana,
      phone,
    },
    origin,
  };
};

const parseAdminRescheduleReservationRequest = (
  body: unknown
): AdminRescheduleReservationRequest | undefined => {
  if (!isObject(body)) {
    return undefined;
  }

  const idempotencyKey = getString(body, "idempotencyKey", 256);
  const startAt = getString(body, "startAt", 64);
  if (!idempotencyKey || !startAt) {
    return undefined;
  }

  // treatmentMinutes は任意。存在時のみ number として受ける(範囲/刻みの厳密検証は
  // reservation-reschedule.ts の validateRescheduleRequest が担う)。非 number は
  // undefined 扱いにせず invalid_request にしたいので、型不一致は明示 reject する。
  const raw = (body as Record<string, unknown>).treatmentMinutes;
  let treatmentMinutes: number | undefined;
  if (raw !== undefined) {
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return undefined;
    }
    treatmentMinutes = raw;
  }

  return {
    idempotencyKey,
    startAt,
    treatmentMinutes
  };
};

const parseAdminCreateExternalBlockRequest = (body: unknown): AdminCreateExternalBlockRequest | undefined => {
  if (!isObject(body)) {
    return undefined;
  }

  const idempotencyKey = getString(body, "idempotencyKey", 256);
  const storeId = getString(body, "storeId", 64);
  const resourceId = getString(body, "resourceId", 128);
  const startAt = getString(body, "startAt", 64);
  const endAt = getString(body, "endAt", 64);
  const title = getString(body, "title", 120);

  if (!idempotencyKey || !storeId || !resourceId || !startAt || !endAt) {
    return undefined;
  }

  return {
    idempotencyKey,
    storeId,
    resourceId,
    startAt,
    endAt,
    title
  };
};

const parseAdminSyncJobRetryRequest = (body: unknown): AdminSyncJobRetryRequest | undefined => {
  if (!isObject(body)) {
    return undefined;
  }

  const idempotencyKey = getString(body, "idempotencyKey", 256);
  const jobId = getString(body, "jobId", 256);
  const source = body.source;

  if (!idempotencyKey || !jobId || !isAdminSyncJobSource(source)) {
    return undefined;
  }

  return {
    idempotencyKey,
    source,
    jobId
  };
};

const parseAdminSyncJobAcknowledgeRequest = (
  body: unknown
): AdminSyncJobAcknowledgeRequest | undefined => {
  if (!isObject(body)) {
    return undefined;
  }

  const idempotencyKey = getString(body, "idempotencyKey", 256);
  const jobId = getString(body, "jobId", 256);
  const note = getString(body, "note", 500);
  const source = body.source;

  if (!idempotencyKey || !jobId || !note ||
    (source !== "google_calendar_import_jobs" && source !== "notification_jobs")) {
    return undefined;
  }

  return {
    idempotencyKey,
    source,
    jobId,
    note
  };
};

const parseAdminSyncConflictResolutionRequest = (
  body: unknown
): AdminSyncConflictResolutionRequest | undefined => {
  if (!isObject(body)) {
    return undefined;
  }

  const idempotencyKey = getString(body, "idempotencyKey", 256);
  const note = getString(body, "note", 500);
  if (!idempotencyKey) {
    return undefined;
  }

  // Optional cancelExternalBlock flag for Step 5 atomic resolve. Reject
  // non-boolean values rather than silently coercing — admin tools should
  // send `true`/`false`, not `"true"`/`1`.
  const rawCancelExternalBlock = body.cancelExternalBlock;
  let cancelExternalBlock: boolean | undefined;
  if (rawCancelExternalBlock === undefined) {
    cancelExternalBlock = undefined;
  } else if (typeof rawCancelExternalBlock === "boolean") {
    cancelExternalBlock = rawCancelExternalBlock;
  } else {
    return undefined;
  }

  return {
    idempotencyKey,
    note,
    ...(cancelExternalBlock === undefined ? {} : { cancelExternalBlock })
  };
};

// Local helpers — auth / DB / JSON-body gates

import type { AdminUser } from "../admin/access";

type AdminAuthGateResult =
  | { ok: true; admin: AdminUser }
  | { ok: false; response: Response };

/**
 * Authenticate the admin user from Cf-Access-Jwt-Assertion.
 * Returns `{ ok: true, admin }` on success, or `{ ok: false, response }` with
 * the appropriate HTTP error already built.
 *
 * @param headers — pass `ADMIN_PRIVATE_HEADERS` for routes that include
 *   cache-control on auth errors, or `undefined` for routes that omit them.
 */
const authenticateAdminRoute = async (
  c: Context<AppEnvironment>,
  headers?: Record<string, string>
): Promise<AdminAuthGateResult> => {
  const auth = await authenticateAdmin({
    token: c.req.header("Cf-Access-Jwt-Assertion") ?? undefined,
    env: c.env
  });
  if (!auth.ok) {
    return {
      ok: false,
      response: headers
        ? c.json({ ok: false, reason: auth.reason }, statusForAdminAuthResult(auth), headers)
        : c.json({ ok: false, reason: auth.reason }, statusForAdminAuthResult(auth))
    };
  }
  // Per-admin throttle on state-changing methods, applied at THIS single
  // chokepoint so every admin-api auth path — authenticateAdminWithDb,
  // authenticateOwnerWithJsonBody, and the direct authenticateAdminRoute callers
  // — is covered (no-op for reads). Bounds the blast radius of a stolen
  // Cloudflare Access cookie, which otherwise passes auth + the CSRF guard and
  // could drive unbounded destructive mutations. DB absent here ⇒ skip; the
  // downstream missing-database guard returns 500 and the write can't proceed.
  const db = c.env.DB;
  if (db && (await isAdminMutationRateLimited(c, db, auth.admin.id))) {
    return {
      ok: false,
      response: headers
        ? c.json({ ok: false, reason: "rate_limited" }, 429, headers)
        : c.json({ ok: false, reason: "rate_limited" }, 429)
    };
  }
  return { ok: true, admin: auth.admin };
};

type AdminAuthDbResult =
  | { ok: true; admin: AdminUser; db: D1Database }
  | { ok: false; response: Response };

/**
 * Auth + DB null-check combined. Most routes use this pattern.
 *
 * @param headers — pass `ADMIN_PRIVATE_HEADERS` for routes that include
 *   cache-control on error responses, or `undefined` for routes that omit them.
 */
const authenticateAdminWithDb = async (
  c: Context<AppEnvironment>,
  headers?: Record<string, string>
): Promise<AdminAuthDbResult> => {
  // Rate-limit is enforced inside authenticateAdminRoute (the shared chokepoint),
  // so it is NOT repeated here — doing so would double-count and halve the limit.
  const auth = await authenticateAdminRoute(c, headers);
  if (!auth.ok) return auth;
  if (!c.env.DB) {
    return {
      ok: false,
      response: headers
        ? c.json(MISSING_DB_BODY, 500, headers)
        : c.json({ ok: false, reason: "missing_database" }, 500)
    };
  }
  return { ok: true, admin: auth.admin, db: c.env.DB };
};

/**
 * Parse JSON body with error handling.
 *
 * @param headers — pass `ADMIN_PRIVATE_HEADERS` for routes that include
 *   cache-control on parse errors, or `undefined` for routes that omit them.
 */
const parseJsonBody = async (
  c: Context<AppEnvironment>,
  headers?: Record<string, string>
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> => {
  try {
    return { ok: true, body: await c.req.json() };
  } catch {
    return {
      ok: false,
      response: headers
        ? c.json({ ok: false, reason: "invalid_request" }, 400, headers)
        : c.json({ ok: false, reason: "invalid_request" }, 400)
    };
  }
};

type OwnerJsonBodyResult =
  | { ok: true; body: Record<string, unknown>; admin: AdminUser }
  | { ok: false; response: Response };

/**
 * Parse a JSON *object* body with the admin error contract
 * (`invalid_json` for unparsable input, `invalid_request` for null/array/scalar).
 * Shared by the owner gate below and by store-scoped routes that authenticate
 * with `authenticateAdminWithDb` instead, so both keep the same reason strings.
 */
const parseJsonObjectBody = async (
  c: Context<AppEnvironment>
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> => {
  let bodyRaw: unknown;
  try {
    bodyRaw = await c.req.json();
  } catch {
    return { ok: false, response: c.json({ ok: false, reason: "invalid_json" }, 400, ADMIN_PRIVATE_HEADERS) };
  }
  if (bodyRaw === null || typeof bodyRaw !== "object" || Array.isArray(bodyRaw)) {
    return { ok: false, response: c.json({ ok: false, reason: "invalid_request" }, 400, ADMIN_PRIVATE_HEADERS) };
  }
  return { ok: true, body: bodyRaw as Record<string, unknown> };
};

const authenticateOwnerWithJsonBody = async (
  c: Context<AppEnvironment>
): Promise<OwnerJsonBodyResult> => {
  const authGate = await authenticateAdminRoute(c, ADMIN_PRIVATE_HEADERS);
  if (!authGate.ok) return authGate;
  const ownerGate = requireOwnerWithDb(c, authGate);
  if (ownerGate) return { ok: false, response: ownerGate };
  const parsed = await parseJsonObjectBody(c);
  if (!parsed.ok) return parsed;
  return { ok: true, body: parsed.body, admin: authGate.admin };
};

// Reservation action helper

const runReservationActionRoute = async (
  c: Context<AppEnvironment>,
  action: AdminReservationAction,
  options?: { ownerOnly?: boolean }
) => {
  const gate = await authenticateAdminWithDb(c);
  if (!gate.ok) return gate.response;
  // owner ゲートは認証直後・body を読む前に置く。呼び出し側で先に
  // requireOwnerWithDb を通してからこの helper を呼ぶ形にすると、認証と body
  // 読み取りが二重に走る。staff の拒否は body 処理より前に成立させる。
  if (options?.ownerOnly) {
    const ownerDenied = requireOwnerWithDb(c, gate);
    if (ownerDenied) return ownerDenied;
  }
  const parsed = await parseJsonBody(c);
  if (!parsed.ok) return parsed.response;

  const request = parseAdminIdempotentReasonRequest(parsed.body);
  const reservationId = c.req.param("id");
  if (!request || !reservationId) {
    return c.json({ ok: false, reason: "invalid_request" }, 400);
  }

  // 一括承認の楽観ロック (任意)。型不正を黙って無視するとクライアントはガード済みと
  // 誤認するため 400 で明示的に弾く。値の範囲検証は validateAdminActionInput が行う。
  const expectedVersion = (parsed.body as Record<string, unknown>).expectedVersion;
  if (expectedVersion !== undefined && typeof expectedVersion !== "number") {
    return c.json({ ok: false, reason: "invalid_request" }, 400);
  }

  const result = await runAdminReservationAction({
    db: gate.db,
    env: c.env,
    admin: gate.admin,
    reservationId,
    action,
    request: expectedVersion !== undefined ? { ...request, expectedVersion } : request
  });

  if (result.ok) {
    if (result.status === "confirmed" && !result.replayed && isWorkflowEnabled(c.env)) {
      triggerReservationWorkflow(c, result.reservationId, result.version);
    } else {
      scheduleQueueKicks(c, { google: true, line: true });
    }
  }

  return c.json(result, statusForAdminActionResult(result));
};

// Status maps

// already_merged / target_already_merged / source_blocked → 409 Conflict:
// these are state conflicts (target/source row moved underneath the caller),
// not malformed input. Admin UI should retry from refreshed candidates (409)
// rather than fix the payload (400).
const CUSTOMER_MERGE_STATUS_BY_ERROR = {
  forbidden: 403,
  same_customer: 400,
  not_found: 404,
  already_merged: 409,
  target_already_merged: 409,
  source_blocked: 409,
  phone_hash_mismatch: 400,
  invalid_request: 400,
  missing_database: 500
} as const satisfies Record<AdminCustomerMergeError, ContentfulStatusCode>;

const SETTINGS_CREATE_STATUS_BY_ERROR = {
  forbidden: 403,
  forbidden_role_escalation: 403,
  invalid_request: 400,
  not_found: 404,
  store_not_found: 404,
  missing_database: 500,
  idempotency_conflict: 409,
  idempotency_in_progress: 409,
  write_failed: 500
} as const;
const createSuccessStatus = (result: { replayed: boolean }) => (result.replayed ? 200 : 201);

// Tier D.4 — recurring commit status map.
const RECURRING_COMMIT_STATUS_BY_ERROR = {
  forbidden: 403,
  invalid_request: 400,
  missing_database: 500,
  idempotency_conflict: 409,
  idempotency_in_progress: 409,
  invalid_rrule: 400,
  unsupported_freq: 400,
  write_failed: 500,
} as const satisfies Record<AdminRecurringCommitError, ContentfulStatusCode>;

// Routes (in order matching current app.ts registration)

// 1. POST /reservations — create admin reservation
adminApiRoutes.post("/reservations", async (c) => {
  const gate = await authenticateAdminWithDb(c);
  if (!gate.ok) return gate.response;
  const parsed = await parseJsonBody(c);
  if (!parsed.ok) return parsed.response;

  const request = parseAdminCreateReservationRequest(parsed.body);
  if (!request) {
    return c.json({ ok: false, reason: "invalid_request" }, 400);
  }

  const result = await createAdminReservation({
    db: gate.db,
    admin: gate.admin,
    lineChannelId: c.env.LINE_CHANNEL_ID,
    request
  });

  if (result.ok) {
    scheduleQueueKicks(c, { google: true, line: true });
  }

  return c.json(result, statusForAdminCreateReservationResult(result));
});

// 2. GET /reservations/pending — list pending
adminApiRoutes.get("/reservations/pending", async (c) => {
  const gate = await authenticateAdminWithDb(c);
  if (!gate.ok) return gate.response;

  const reservations = await listPendingReservations({
    db: gate.db,
    admin: gate.admin
  });

  return c.json({
    ok: true,
    reservations
  });
});

// 3. GET /reservations — list by range (today/tomorrow/date)
adminApiRoutes.get("/reservations", async (c) => {
  const gate = await authenticateAdminWithDb(c);
  if (!gate.ok) return gate.response;
  if (!staffHasStore(gate.admin)) return c.json(FORBIDDEN_BODY, 403, ADMIN_PRIVATE_HEADERS);

  const range = parseReservationListRange(c.req.query("range"));
  const dateParam = c.req.query("date");
  const result = await listAdminReservations({
    db: gate.db,
    range,
    admin: gate.admin,
    date: dateParam
  });

  if (!result.ok) {
    return c.json(result, 400, ADMIN_PRIVATE_HEADERS);
  }
  return c.json(result, 200, ADMIN_PRIVATE_HEADERS);
});

// 4. GET /reservations/search — period search (BEFORE /:id parametric!)
adminApiRoutes.get("/reservations/search", async (c) => {
  const prep = await prepareAdminPeriodHandler(c);
  if (!prep.ok) return prep.response;
  const { db, filter } = prep;
  const isStaff = prep.admin.role === "staff";

  const result = await listAdminReservationsForPeriod({
    db,
    from: filter.from,
    to: filter.to,
    storeId: filter.storeId,
    serviceId: filter.serviceId,
    statuses: filter.statuses,
    keyword: filter.keyword,
    limit: SEARCH_QUERY_LIMIT,
    isStaff
  });

  if (!result.ok) {
    return c.json(result, 400, ADMIN_PRIVATE_HEADERS);
  }

  const truncated = result.rows.length > SEARCH_LIMIT;
  const visible = truncated ? result.rows.slice(0, SEARCH_LIMIT) : result.rows;
  return c.json(
    {
      ok: true,
      from: filter.from,
      to: filter.to,
      reservations: visible,
      truncated,
      totalCount: truncated ? null : visible.length
    },
    200,
    ADMIN_PRIVATE_HEADERS
  );
});

// 5. GET /reservations/export.csv — CSV export with allowServiceToken: true
adminApiRoutes.get("/reservations/export.csv", async (c) => {
  const prep = await prepareAdminPeriodHandler(c, { allowServiceToken: true });
  if (!prep.ok) return prep.response;
  const { db, filter } = prep;
  const isStaff = prep.admin.role === "staff";

  // Validate the filter up-front (date range, keyword length, status enum)
  // before opening the stream, so 4xx errors return JSON instead of a
  // truncated CSV body. We pull the first page only — subsequent pages
  // are fetched lazily by the streamer as it drains.
  const firstPage = await listAdminReservationsForPeriod({
    db,
    from: filter.from,
    to: filter.to,
    storeId: filter.storeId,
    serviceId: filter.serviceId,
    statuses: filter.statuses,
    keyword: filter.keyword,
    limit: PAGED_ROWS_PER_PAGE,
    offset: 0,
    isStaff
  });

  if (!firstPage.ok) {
    return c.json(firstPage, 400, ADMIN_PRIVATE_HEADERS);
  }

  // Overflow guard: if there's at least one row beyond the paged streamer's
  // hard cap (PAGED_MAX_PAGES * PAGED_ROWS_PER_PAGE = 30K), return HTTP 413
  // BEFORE opening the stream. Without this check the streamer would close
  // silently at 30K rows and the operator would believe the truncated CSV
  // is the full export — strictly worse than the old 413 behavior. Probing
  // OFFSET 30K with LIMIT 1 is cheap because D1 can short-circuit once it
  // finds the boundary row.
  const overflowCap = PAGED_ROWS_PER_PAGE * PAGED_MAX_PAGES;
  if (firstPage.rows.length === PAGED_ROWS_PER_PAGE) {
    // Only worth checking if the first page filled up; otherwise the result
    // set is < pageSize and definitely under the cap.
    const overflowProbe = await listAdminReservationsForPeriod({
      db,
      from: filter.from,
      to: filter.to,
      storeId: filter.storeId,
      serviceId: filter.serviceId,
      statuses: filter.statuses,
      keyword: filter.keyword,
      limit: 1,
      offset: overflowCap,
      isStaff
    });
    if (overflowProbe.ok && overflowProbe.rows.length > 0) {
      return c.json(
        { ok: false, reason: "result_too_large", limit: overflowCap } as const,
        413,
        ADMIN_PRIVATE_HEADERS
      );
    }
  }

  // Wrap the first page in a fetchPage closure so the streamer's pull()
  // doesn't re-query D1 for offset=0. Subsequent offsets hit D1 fresh.
  let firstPageConsumed = false;
  const fetchPage = async (offset: number, limit: number) => {
    if (!firstPageConsumed && offset === 0) {
      firstPageConsumed = true;
      return { ok: true as const, rows: firstPage.rows };
    }
    const page = await listAdminReservationsForPeriod({
      db,
      from: filter.from,
      to: filter.to,
      storeId: filter.storeId,
      serviceId: filter.serviceId,
      statuses: filter.statuses,
      keyword: filter.keyword,
      limit,
      offset,
      isStaff
    });
    if (!page.ok) {
      return { ok: false as const, reason: page.reason };
    }
    return { ok: true as const, rows: page.rows };
  };

  const rawStream = reservationsCsvStreamPaged({
    fetchPage,
    pageSize: PAGED_ROWS_PER_PAGE,
    maxPages: PAGED_MAX_PAGES
  });

  let responseStream: ReadableStream = rawStream;
  if (c.env.STORAGE && c.env.CSV_ARCHIVE_ENABLED === "true" && c.executionCtx?.waitUntil) {
    try {
      const { clientStream, archivePromise } = archiveCsvToR2(
        c.env,
        rawStream,
        filter.storeId,
        filter.from,
        filter.to
      );
      responseStream = clientStream;
      c.executionCtx.waitUntil(archivePromise);
    } catch {
      // R2 archive failure must not break CSV download
    }
  }

  const filename = reservationsCsvFilename(filter.from, filter.to, Math.floor(Date.now() / 1000));
  return new Response(responseStream, {
    status: 200,
    headers: {
      ...ADMIN_PRIVATE_HEADERS,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`
    }
  });
});

// 5b. GET /reservations/available-slots

// Register before /reservations/:id; otherwise :id captures this static segment
// and the detail handler returns 404.
// Reschedule-mode reservation probe. Everything the picker needs is derived
// server-side from this row so the displayed availability always matches what
// rescheduleAdminReservation will actually accept (client-supplied resource /
// duration cannot skew it), and so a caller cannot use excludeReservationId as
// a reservation-id⇄customer relation oracle: every failure — missing row,
// cross-store id, non-reschedulable state — collapses into the same 403.
type AvailableSlotsReservationRow = {
  store_id: string;
  customer_id: string;
  resource_id: string;
  duration_minutes: number;
  status: string;
  checked_in_at: string | null;
};

// duration_minutes stores the OCCUPIED span (treatment + cleanup buffer, see
// calculateReservationDuration); getAvailableSlots re-adds the buffer, so the
// picker gets the raw treatment time back. Returns null when the reservation
// cannot anchor a reschedule query: missing row, cross-store id, state the
// write path would reject (isReschedulableReservation), or a stored duration
// outside the envelope every write path enforces (integer, 5-min grid, and
// the same 48×5 occupancy cap as MAX_TOTAL_SERVICE_DURATION_MINUTES + buffer).
const resolveRescheduleAvailabilityContext = async (
  db: D1Database,
  storeId: string,
  excludeReservationId: string
): Promise<{ durationMinutes: number; resourceId: string; customerId: string } | null> => {
  const row = await db
    .prepare(
      "SELECT store_id, customer_id, resource_id, duration_minutes, status, checked_in_at FROM reservations WHERE id = ?"
    )
    .bind(excludeReservationId)
    .first<AvailableSlotsReservationRow>();
  if (row?.store_id !== storeId || !isReschedulableReservation(row)) {
    return null;
  }
  // derived may be 0: a legacy/imported row can store the write-path minimum
  // duration_minutes = 5 (one lock slot, no treatment beyond the buffer) and
  // rescheduleAdminReservation accepts it — rejecting it here would 403 a
  // reservation the write path happily moves. (chatgpt-codex-connector)
  const derivedTreatmentMinutes = row.duration_minutes - RESERVATION_INTERVAL_MINUTES;
  const storedDurationValid =
    Number.isInteger(row.duration_minutes) &&
    row.duration_minutes % 5 === 0 &&
    derivedTreatmentMinutes >= 0 &&
    row.duration_minutes <= MAX_TOTAL_SERVICE_DURATION_MINUTES + RESERVATION_INTERVAL_MINUTES;
  if (!storedDurationValid) {
    return null;
  }
  return {
    durationMinutes: derivedTreatmentMinutes,
    resourceId: row.resource_id,
    customerId: row.customer_id,
  };
};

const isValidClientDurationMinutes = (value: number | undefined): boolean =>
  value === undefined ||
  (Number.isInteger(value) &&
    value >= 5 &&
    value <= MAX_TOTAL_SERVICE_DURATION_MINUTES &&
    value % 5 === 0);

type AvailableSlotsQueryResolution =
  | {
      ok: true;
      durationMinutes?: number;
      resourceId?: string;
      customerId?: string;
      excludeReservationId?: string;
    }
  | { ok: false; response: Response };

// Mode split (excludeReservationId wins): both extras present is a client bug —
// reject rather than guess which customer the caller meant. Reschedule mode
// ignores client durationMinutes / resourceId entirely (before parsing — a
// bogus duration alongside a valid exclude id is not a 400) and derives them
// from the reservation row; every derivation failure collapses into the same
// non-disclosing 403. Create mode gates a supplied customerId through the same
// store-scope predicate as booking itself (mayBookCustomerId) so the picker
// cannot leak a customer's busy times to a staff who could not book them anyway.
const resolveAvailableSlotsQuery = async (
  c: Context<AppEnvironment>,
  db: D1Database,
  admin: AdminUser,
  storeId: string
): Promise<AvailableSlotsQueryResolution> => {
  const invalid = () => ({
    ok: false as const,
    response: c.json({ ok: false, reason: "invalid_request" }, 400, ADMIN_PRIVATE_HEADERS),
  });

  const excludeReservationId = c.req.query("excludeReservationId") || undefined;
  const customerIdParam = c.req.query("customerId") || undefined;
  if (excludeReservationId && customerIdParam) {
    return invalid();
  }
  if (excludeReservationId !== undefined && !isNonEmptyString(excludeReservationId, 128)) {
    return invalid();
  }
  if (customerIdParam !== undefined && !isNonEmptyString(customerIdParam, 64)) {
    return invalid();
  }

  if (excludeReservationId) {
    const context = await resolveRescheduleAvailabilityContext(db, storeId, excludeReservationId);
    if (context === null) {
      return { ok: false, response: c.json(FORBIDDEN_BODY, 403, ADMIN_PRIVATE_HEADERS) };
    }
    return { ok: true, ...context, excludeReservationId };
  }

  const durationStr = c.req.query("durationMinutes");
  const durationMinutes = durationStr ? Number(durationStr) : undefined;
  if (!isValidClientDurationMinutes(durationMinutes)) {
    return invalid();
  }
  const resourceId = c.req.query("resourceId") || undefined;

  if (customerIdParam) {
    const scope = await assertStaffCustomerStoreScope(c, db, customerIdParam, admin);
    if (scope) return { ok: false, response: scope };
  }
  return { ok: true, durationMinutes, resourceId, customerId: customerIdParam };
};

adminApiRoutes.get("/reservations/available-slots", async (c) => {
  const gate = await authenticateAdminWithDb(c, ADMIN_PRIVATE_HEADERS);
  if (!gate.ok) return gate.response;

  const storeId = c.req.query("storeId");
  const date = c.req.query("date");
  if (!storeId || !date) {
    return c.json({ ok: false, reason: "invalid_request" }, 400, ADMIN_PRIVATE_HEADERS);
  }

  if (gate.admin.role === "staff" && gate.admin.store_id !== storeId) {
    return c.json(FORBIDDEN_BODY, 403, ADMIN_PRIVATE_HEADERS);
  }

  const query = await resolveAvailableSlotsQuery(c, gate.db, gate.admin, storeId);
  if (!query.ok) {
    return query.response;
  }

  const result = await getAvailableSlots({
    db: gate.db,
    storeId,
    date,
    durationMinutes: query.durationMinutes,
    resourceId: query.resourceId,
    excludeReservationId: query.excludeReservationId,
    customerId: query.customerId,
  });

  if (!result.ok) {
    return c.json(result, 400, ADMIN_PRIVATE_HEADERS);
  }
  return c.json(result, 200, ADMIN_PRIVATE_HEADERS);
});

// 5c. GET /reservations/unpaid-cancellation-fees — list unpaid cancellation fees
// (BEFORE /:id parametric!)
adminApiRoutes.get("/reservations/unpaid-cancellation-fees", async (c) => {
  const gate = await authenticateAdminWithDb(c, ADMIN_PRIVATE_HEADERS);
  if (!gate.ok) return gate.response;

  const { reservations, truncated } = await listUnpaidCancellationFees({
    db: gate.db,
    admin: gate.admin
  });

  return c.json({ ok: true, reservations, truncated }, 200, ADMIN_PRIVATE_HEADERS);
});

// 6. GET /reservations/:id — detail (staff: store-scoped)
adminApiRoutes.get("/reservations/:id", async (c) => {
  const gate = await authenticateAdminWithDb(c);
  if (!gate.ok) return gate.response;

  // Staff store scope is enforced INSIDE the operation, before any customer-notes
  // PII is read from D1 — it surfaces here as reason:"forbidden" (403).
  const result = await getAdminReservationDetail({
    db: gate.db,
    reservationId: c.req.param("id"),
    admin: gate.admin
  });

  let status: ContentfulStatusCode = 404;
  if (result.ok) {
    status = 200;
  } else if (result.reason === "forbidden") {
    status = 403;
  }
  return c.json(result, status, ADMIN_PRIVATE_HEADERS);
});

// Resolve the store scope for the customer list/search. Staff are hard-scoped to their
// own store (the ?store= param is ignored — no scope widening). Owner / system_admin see
// all stores by default and may narrow to one via ?store=<id>; any other value (absent,
// "all", unknown id) falls back to all-stores. The id is bound as a SQL parameter
// downstream, so an unknown id just returns no rows (no injection, no cross-store leak).
function resolveCustomerStoreScope(
  admin: AdminUser,
  isStaff: boolean,
  storeParam: string | undefined
): string | null {
  if (isStaff) return admin.store_id;
  return storeParam && storeParam !== "all" ? storeParam : null;
}

// 6b. POST /customer-gate/request, POST /customer-gate/verify — the owner-approval
// one-time code for the customer tab (spec 008). Both are covered by the sub-app-wide
// CSRF / Sec-Fetch-Site guard (the `use("*")` above, which applies regardless of where a
// route is registered) and by the per-admin mutation throttle inside
// authenticateAdminRoute, which authenticateAdminWithDb goes through.
adminApiRoutes.post("/customer-gate/request", async (c) => {
  const gate = await authenticateAdminWithDb(c, ADMIN_PRIVATE_HEADERS);
  if (!gate.ok) return gate.response;
  // owner / system_admin never hold a grant, so asking for a code is meaningless
  // rather than forbidden.
  if (gate.admin.role !== "staff") {
    return c.json({ ok: false, reason: "not_applicable" }, 400, ADMIN_PRIVATE_HEADERS);
  }
  // 店舗の紐付けが無い staff は GET /customers 自体が 403 なので、承認を得ても使い道が
  // 無い。ここを開けたままにすると「オーナー宛メールを 1 時間に 10 通投げられるだけの
  // 口」になるので、顧客タブと同じ fail-closed をコードの発行の前に置く。
  if (!staffHasStore(gate.admin)) {
    return c.json(FORBIDDEN_BODY, 403, ADMIN_PRIVATE_HEADERS);
  }

  const result = await requestCustomerGateCode({ db: gate.db, env: c.env, admin: gate.admin });
  if (result.ok) return c.json(result, 200, ADMIN_PRIVATE_HEADERS);

  if (result.reason === "rate_limited") return c.json(result, 429, ADMIN_PRIVATE_HEADERS);
  if (result.reason === "gate_email_failed") return c.json(result, 502, ADMIN_PRIVATE_HEADERS);
  if (result.reason === "forbidden") return c.json(result, 403, ADMIN_PRIVATE_HEADERS);
  return c.json(result, 500, ADMIN_PRIVATE_HEADERS);
});

adminApiRoutes.post("/customer-gate/verify", async (c) => {
  const gate = await authenticateAdminWithDb(c, ADMIN_PRIVATE_HEADERS);
  if (!gate.ok) return gate.response;
  if (gate.admin.role !== "staff") {
    return c.json({ ok: false, reason: "not_applicable" }, 400, ADMIN_PRIVATE_HEADERS);
  }
  if (!staffHasStore(gate.admin)) {
    return c.json(FORBIDDEN_BODY, 403, ADMIN_PRIVATE_HEADERS);
  }
  const parsed = await parseJsonObjectBody(c);
  if (!parsed.ok) return parsed.response;

  const body = parsed.body as { challengeId?: unknown; code?: unknown };
  // The code is exactly 6 digits; anything else never reaches the hash comparison.
  if (typeof body.challengeId !== "string" || typeof body.code !== "string" || !/^\d{6}$/.test(body.code)) {
    return c.json({ ok: false, reason: "invalid_request" }, 400, ADMIN_PRIVATE_HEADERS);
  }

  const result = await verifyCustomerGateCode({
    db: gate.db,
    admin: gate.admin,
    challengeId: body.challengeId,
    code: body.code
  });
  if (result.ok) return c.json(result, 200, ADMIN_PRIVATE_HEADERS);
  if (result.reason === "forbidden") return c.json(result, 403, ADMIN_PRIVATE_HEADERS);
  return c.json(result, result.reason === "rate_limited" ? 429 : 400, ADMIN_PRIVATE_HEADERS);
});

// 7. GET /customers — search or list all.
// Staff may now read customers, but ONLY their own store's (own-store = a
// reservation, a VALID visit, or a manual registration at the staff's store).
// They are scoped via storeScope; fail closed without a store binding. The
// archived view is scoped the same way (not owner-only since 2026-08-26).
// Owner / system_admin keep the full, all-store view.
adminApiRoutes.get("/customers", async (c) => {
  const authGate = await authenticateAdminRoute(c);
  if (!authGate.ok) return authGate.response;
  if (!c.env.DB) return c.json(MISSING_DB_BODY, 500, ADMIN_PRIVATE_HEADERS);

  const admin = authGate.admin;
  const isStaff = admin.role === "staff";
  if (isStaff && !staffHasStore(admin)) {
    return c.json(FORBIDDEN_BODY, 403, ADMIN_PRIVATE_HEADERS);
  }
  const storeScope = resolveCustomerStoreScope(admin, isStaff, c.req.query("store"));

  const db = c.env.DB;
  // 顧客タブのオーナー承認ゲート (spec 008)。名簿の閲覧・列挙は承認が要るが、`?q=` の
  // 名前検索は予約作成の顧客ピッカーと LINE 友だち紐付けが同じ URL を叩くので止めず、
  // memo を落として返す。承認の有無はサーバーが決め、クライアント申告では分岐しない。
  const gateGranted = isStaff ? await hasActiveCustomerGateGrant(db, admin.id) : true;
  const mode = c.req.query("mode");
  if (mode === "list") {
    if (!gateGranted) {
      return c.json(CUSTOMER_GATE_REQUIRED_BODY, 403, ADMIN_PRIVATE_HEADERS);
    }
    const offset = Number.parseInt(c.req.query("offset") ?? "0", 10);
    const archivedOnly = c.req.query("view") === "archived";
    // The archived view is open to staff too (2026-08-26): they can archive their
    // own-store customers, and this list is the only way back to the restore action.
    // storeScope below still limits the rows to their own store.
    const result = await listAllCustomers(
      db,
      200,
      Number.isNaN(offset) ? 0 : offset,
      { archivedOnly, storeScope }
    );
    return c.json(result, 200, ADMIN_PRIVATE_HEADERS);
  }

  const q = c.req.query("q") ?? "";
  const result = await searchAdminCustomers({
    db,
    query: q,
    storeScope,
    isStaff,
    redactMemo: !gateGranted
  });
  if (!result.ok) {
    return c.json(result, 400, ADMIN_PRIVATE_HEADERS);
  }
  return c.json(result, 200, ADMIN_PRIVATE_HEADERS);
});

// GET /customers/merge-candidates — duplicate-customer groups for the merge UI (owner+)
adminApiRoutes.get("/customers/merge-candidates", async (c) => {
  const authGate = await authenticateAdminRoute(c);
  if (!authGate.ok) return authGate.response;

  const ownerGate = requireOwnerWithDb(c, authGate);
  if (ownerGate) return ownerGate;

  const result = await listCustomerMergeCandidates({ db: c.env.DB! });
  // Don't ship phone_hash (SHA-256 of the phone) to the client — it's only
  // needed server-side for grouping and the UI never displays it. Expose an
  // opaque, stable groupId derived from member ids (which the client already
  // has) so the list can be keyed without leaking the phone identifier. Mirrors
  // the merge audit path, which stores only an 8-char hash prefix.
  const groups = result.groups.map((g) => ({
    groupId: g.customers.map((cust) => cust.id).sort((a, b) => a.localeCompare(b)).join(":"),
    customers: g.customers
  }));
  return c.json({ ok: true, groups, truncated: result.truncated }, 200, ADMIN_PRIVATE_HEADERS);
});

// GET /line-quota — this month's LINE push usage vs the free-plan 200 cap (owner+).
// Reads the persisted snapshot (no LINE API call); `quota` is null until the cron
// has fetched it at least once this month.

// 管理画面 Web Push の購読管理
//
// Every role may subscribe: a push is how a staff member on the floor learns
// about a new booking, and the payload is scoped to their own store by
// loadStoreSubscriptions. CSRF / Sec-Fetch-Site come from the route-wide
// middleware above; the admin mutation rate limit comes from the
// authenticateAdminWithDb chokepoint each handler starts with.
//
// No `:id` route lives under this prefix — a dynamic segment registered before
// these would shadow them (the available-slots 404 incident).

adminApiRoutes.post("/notifications/push/subscriptions", async (c) => {
  const gate = await authenticateAdminWithDb(c, ADMIN_PRIVATE_HEADERS);
  if (!gate.ok) return gate.response;

  const parsed = await parseJsonBody(c, ADMIN_PRIVATE_HEADERS);
  if (!parsed.ok) return parsed.response;

  const body = parsed.body as Record<string, unknown> | null;
  // The endpoint is a URL this Worker will POST to later, so it is validated
  // against the push-service allow-list here rather than at send time — a
  // rejected registration is visible to the person doing it, a rejected send is
  // not.
  const subscription = await parsePushSubscription({
    endpoint: body?.endpoint,
    p256dh: body?.p256dh,
    auth: body?.auth
  });
  if (!subscription) {
    return c.json({ ok: false, reason: "invalid_request" }, 400, ADMIN_PRIVATE_HEADERS);
  }

  const result = await savePushSubscription(gate.db, gate.admin, subscription);
  return c.json(result, result.ok ? 200 : 403, ADMIN_PRIVATE_HEADERS);
});

adminApiRoutes.post("/notifications/push/unsubscribe", async (c) => {
  const gate = await authenticateAdminWithDb(c, ADMIN_PRIVATE_HEADERS);
  if (!gate.ok) return gate.response;

  const parsed = await parseJsonBody(c, ADMIN_PRIVATE_HEADERS);
  if (!parsed.ok) return parsed.response;

  const body = parsed.body as Record<string, unknown> | null;
  // Normalized the same way it was on the way in, so the stored row is the one
  // that gets deleted.
  const endpoint =
    typeof body?.endpoint === "string" ? normalizePushEndpoint(body.endpoint) : null;
  if (!endpoint) {
    return c.json({ ok: false, reason: "invalid_request" }, 400, ADMIN_PRIVATE_HEADERS);
  }

  // Scoped to the caller: deleting by endpoint alone would let any signed-in
  // admin silence another admin's device.
  const result = await deletePushSubscription(gate.db, gate.admin, endpoint);
  return c.json(result, result.ok ? 200 : 403, ADMIN_PRIVATE_HEADERS);
});

adminApiRoutes.post("/notifications/push/test", async (c) => {
  const gate = await authenticateAdminWithDb(c, ADMIN_PRIVATE_HEADERS);
  if (!gate.ok) return gate.response;

  const result = await sendAdminPushTest(c.env, gate.db, gate.admin);
  return c.json(result, result.ok ? 200 : 403, ADMIN_PRIVATE_HEADERS);
});

adminApiRoutes.get("/line-quota", async (c) => {
  const authGate = await authenticateAdminRoute(c);
  if (!authGate.ok) return authGate.response;

  const ownerGate = requireOwnerWithDb(c, authGate);
  if (ownerGate) return ownerGate;

  const quota = await readLineQuotaStatus({ db: c.env.DB!, env: c.env });
  return c.json({ ok: true, quota }, 200, ADMIN_PRIVATE_HEADERS);
});

// 8. GET /customers/:id — detail. Staff may view ONLY their own-store customers;
// getAdminCustomerDetail returns reason:"forbidden" for an out-of-scope /
// archived / merged customer (staff) and scopes the visits/reservations history to
// the staff's store. Owner / system_admin see the full record.
adminApiRoutes.get("/customers/:id", async (c) => {
  const authGate = await authenticateAdminRoute(c);
  if (!authGate.ok) return authGate.response;
  if (!c.env.DB) return c.json(MISSING_DB_BODY, 500, ADMIN_PRIVATE_HEADERS);
  const gate = await assertCustomerTabGate(c, c.env.DB, authGate.admin);
  if (gate) return gate;

  const result = await getAdminCustomerDetail({
    db: c.env.DB,
    customerId: c.req.param("id"),
    admin: authGate.admin
  });

  let status: ContentfulStatusCode = 404;
  if (result.ok) {
    status = 200;
  } else if (result.reason === "forbidden") {
    status = 403;
  }
  return c.json(result, status, ADMIN_PRIVATE_HEADERS);
});

// 8b. GET /customers/:id/visits?offset=N — 来店履歴の続き。顧客詳細が返すのは先頭
// 50 件だけなので、それより古い施術メモはここから引く (issue #650)。認可は
// getAdminCustomerDetail と同じ (Access → 顧客タブのゲート → staff は自店舗のみ)。
adminApiRoutes.get("/customers/:id/visits", async (c) => {
  const authGate = await authenticateAdminRoute(c);
  if (!authGate.ok) return authGate.response;
  if (!c.env.DB) return c.json(MISSING_DB_BODY, 500, ADMIN_PRIVATE_HEADERS);
  const gate = await assertCustomerTabGate(c, c.env.DB, authGate.admin);
  if (gate) return gate;

  const rawOffset = c.req.query("offset");
  const offset = rawOffset === undefined ? 0 : Number(rawOffset);

  const result = await listAdminCustomerVisits({
    db: c.env.DB,
    customerId: c.req.param("id"),
    offset,
    admin: authGate.admin
  });

  let status: ContentfulStatusCode = 404;
  if (result.ok) {
    status = 200;
  } else if (result.reason === "forbidden") {
    status = 403;
  } else if (result.reason === "invalid_request") {
    status = 400;
  }
  return c.json(result, status, ADMIN_PRIVATE_HEADERS);
});

adminApiRoutes.get("/customers/:id/reservations", async (c) => {
  const authGate = await authenticateAdminRoute(c);
  if (!authGate.ok) return authGate.response;
  if (!c.env.DB) return c.json(MISSING_DB_BODY, 500, ADMIN_PRIVATE_HEADERS);
  const gate = await assertCustomerTabGate(c, c.env.DB, authGate.admin);
  if (gate) return gate;
  const rawOffset = c.req.query("offset");
  const result = await listAdminCustomerReservations({
    db: c.env.DB,
    customerId: c.req.param("id"),
    offset: rawOffset === undefined ? 0 : Number(rawOffset),
    admin: authGate.admin
  });
  let status: ContentfulStatusCode = 404;
  if (result.ok) {
    status = 200;
  } else if (result.reason === "forbidden") {
    status = 403;
  } else if (result.reason === "invalid_request") {
    status = 400;
  }
  return c.json(result, status, ADMIN_PRIVATE_HEADERS);
});

adminApiRoutes.get("/customers/:id/consents", async (c) => {
  const authGate = await authenticateAdminRoute(c);
  if (!authGate.ok) return authGate.response;
  if (!c.env.DB) return c.json(MISSING_DB_BODY, 500, ADMIN_PRIVATE_HEADERS);
  const gate = await assertCustomerTabGate(c, c.env.DB, authGate.admin);
  if (gate) return gate;

  const rawOffset = c.req.query("offset");
  const offset = rawOffset === undefined ? 0 : Number(rawOffset);
  const result = await listAdminCustomerConsents({
    db: c.env.DB,
    customerId: c.req.param("id"),
    offset,
    admin: authGate.admin
  });

  let status: ContentfulStatusCode = 404;
  if (result.ok) {
    status = 200;
  } else if (result.reason === "forbidden") {
    status = 403;
  } else if (result.reason === "invalid_request") {
    status = 400;
  }
  return c.json(result, status, ADMIN_PRIVATE_HEADERS);
});

// 9-10. POST /customers/:id/block, /customers/:id/unblock
const handleCustomerBlockAction = async (c: Context<AppEnvironment>, action: "block" | "unblock") => {
  const gate = await authenticateAdminWithDb(c, ADMIN_PRIVATE_HEADERS);
  if (!gate.ok) return gate.response;
  const tabGate = await assertCustomerTabGate(c, gate.db, gate.admin);
  if (tabGate) return tabGate;
  const parsed = await parseJsonBody(c, ADMIN_PRIVATE_HEADERS);
  if (!parsed.ok) return parsed.response;

  const request = parseAdminIdempotentReasonRequest(parsed.body);
  const customerId = c.req.param("id");
  if (!request || !customerId) {
    return c.json({ ok: false, reason: "invalid_request" }, 400, ADMIN_PRIVATE_HEADERS);
  }

  const result = await setAdminCustomerBlockStatus({
    db: gate.db,
    admin: gate.admin,
    customerId,
    action,
    request
  });

  return c.json(result, statusForAdminProtectedWorkflowResult(result), ADMIN_PRIVATE_HEADERS);
};
adminApiRoutes.post("/customers/:id/block", (c) => handleCustomerBlockAction(c, "block"));
adminApiRoutes.post("/customers/:id/unblock", (c) => handleCustomerBlockAction(c, "unblock"));

// 10b. POST /customers/:id/archive, /customers/:id/unarchive — every admin role
// (staff are limited to their own-store scope inside setAdminCustomerArchiveStatus).
// Soft-delete: hides the customer from every list/search/lookup by stamping
// customers.archived_at (archive) or clearing it (unarchive). Mirrors the
// block/unblock idempotency + audit machinery. A local status map mirrors
// ADMIN_PROTECTED_WORKFLOW_FAILURE_STATUS (we do NOT widen the shared union).
const ARCHIVE_FAILURE_STATUS: Record<string, ContentfulStatusCode> = {
  forbidden: 403,
  not_found: 404,
  invalid_transition: 409,
  idempotency_conflict: 409,
  idempotency_in_progress: 409,
  write_failed: 500,
  invalid_request: 400,
};

const statusForArchiveResult = (result: AdminCustomerArchiveResult): ContentfulStatusCode =>
  result.ok ? 200 : (ARCHIVE_FAILURE_STATUS[result.reason] ?? 400);

const handleCustomerArchiveAction = async (
  c: Context<AppEnvironment>,
  action: "archive" | "unarchive"
) => {
  const gate = await authenticateAdminWithDb(c, ADMIN_PRIVATE_HEADERS);
  if (!gate.ok) return gate.response;
  const tabGate = await assertCustomerTabGate(c, gate.db, gate.admin);
  if (tabGate) return tabGate;
  const parsed = await parseJsonBody(c, ADMIN_PRIVATE_HEADERS);
  if (!parsed.ok) return parsed.response;

  const request = parseAdminIdempotentReasonRequest(parsed.body);
  const customerId = c.req.param("id");
  if (!request || !customerId) {
    return c.json({ ok: false, reason: "invalid_request" }, 400, ADMIN_PRIVATE_HEADERS);
  }

  const result = await setAdminCustomerArchiveStatus({
    db: gate.db,
    admin: gate.admin,
    customerId,
    action,
    request
  });

  return c.json(result, statusForArchiveResult(result), ADMIN_PRIVATE_HEADERS);
};
adminApiRoutes.post("/customers/:id/archive", (c) => handleCustomerArchiveAction(c, "archive"));
adminApiRoutes.post("/customers/:id/unarchive", (c) => handleCustomerArchiveAction(c, "unarchive"));

// Shared prologue for the staff-scoped customer mutation routes (memo PUT,
// profile PATCH): authenticate + DB null-check, resolve :id, enforce the staff
// own-store scope, then parse a JSON object body. Returns an early Response on any
// failure, or the resolved { db, admin, customerId, rawBody } on success. Extracted
// to remove the identical 17-line prologue these two handlers shared (SonarCloud
// duplication); behaviour and check order are preserved exactly.
type CustomerMutationPrep =
  | { ok: true; db: D1Database; admin: AdminUser; customerId: string; rawBody: Record<string, unknown> }
  | { ok: false; response: Response };

const prepareCustomerMutation = async (c: Context<AppEnvironment>): Promise<CustomerMutationPrep> => {
  const gate = await authenticateAdminWithDb(c, ADMIN_PRIVATE_HEADERS);
  if (!gate.ok) return { ok: false, response: gate.response };

  const tabGate = await assertCustomerTabGate(c, gate.db, gate.admin);
  if (tabGate) return { ok: false, response: tabGate };

  const customerId = c.req.param("id");
  if (!customerId) {
    return { ok: false, response: c.json({ ok: false, reason: "invalid_request" }, 400, ADMIN_PRIVATE_HEADERS) };
  }

  const scope = await assertStaffCustomerStoreScope(c, gate.db, customerId, gate.admin);
  if (scope) return { ok: false, response: scope };

  const parsed = await parseJsonBody(c, ADMIN_PRIVATE_HEADERS);
  if (!parsed.ok) return { ok: false, response: parsed.response };
  const rawBody = parsed.body;
  if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return { ok: false, response: c.json({ ok: false, reason: "invalid_request" }, 400, ADMIN_PRIVATE_HEADERS) };
  }

  return { ok: true, db: gate.db, admin: gate.admin, customerId, rawBody: rawBody as Record<string, unknown> };
};

const customerTextWriteFailure = async (
  c: Context<AppEnvironment>,
  input: { db: D1Database; admin: AdminUser; customerId: string },
  hasExpected: boolean
) => {
  const { db, admin, customerId } = input;
  const scope = await assertStaffCustomerStoreScope(c, db, customerId, admin);
  if (scope) return scope;
  const exists = await db.prepare("SELECT id FROM customers WHERE id = ? AND merged_into_id IS NULL AND archived_at IS NULL")
    .bind(customerId).first();
  const stale = hasExpected && exists !== null;
  return c.json({ ok: false, reason: stale ? "stale_snapshot" : "not_found" }, stale ? 409 : 404, ADMIN_PRIVATE_HEADERS);
};

// Both customer-level text editors share the same atomic authorization/CAS/audit.
const writeCustomerText = async (
  c: Context<AppEnvironment>,
  input: { db: D1Database; admin: AdminUser; customerId: string },
  field: "memo" | "referrer_name",
  value: string | null,
  expected: string | null | undefined
) => {
  const { db, admin, customerId } = input;
  let results: D1Result[];
  try {
    results = await db.batch([
      adminWriteGuard(db, admin),
      db.prepare(`UPDATE customers AS c SET ${field} = ?, updated_at = CURRENT_TIMESTAMP
        WHERE c.id = ? AND c.merged_into_id IS NULL AND c.archived_at IS NULL
          AND (? != 'staff' OR ${OWN_STORE_MEMBERSHIP_ARMS})
          AND (? = 0 OR c.${field} IS ?)`)
        .bind(value, customerId, admin.role, admin.store_id, admin.store_id, admin.store_id, expected === undefined ? 0 : 1, expected ?? null),
      db.prepare(`INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, metadata_json)
        SELECT ?, 'staff', ?, ?, 'customer', ?, ? WHERE changes() = 1`)
        .bind(crypto.randomUUID(), admin.id, field === "memo" ? "customer.memo_update" : "customer.referrer_update", customerId,
          JSON.stringify({ [`${field}_length`]: value?.length ?? 0 }))
    ]);
  } catch (error) {
    if (await adminWriteWasRevoked(db, admin, error)) return c.json(FORBIDDEN_BODY, 403, ADMIN_PRIVATE_HEADERS);
    throw error;
  }
  if (Number(results[1]?.meta?.changes ?? 0) !== 1) return customerTextWriteFailure(c, input, expected !== undefined);
  return c.json({ ok: true }, 200, ADMIN_PRIVATE_HEADERS);
};

// 11. PUT /customers/:id/memo — all admin roles, but staff only for their own-store
// customers (assertStaffCustomerStoreScope). Direct D1 UPDATE + audit batch.
adminApiRoutes.put("/customers/:id/memo", async (c) => {
  const prep = await prepareCustomerMutation(c);
  if (!prep.ok) return prep.response;
  const { db, customerId, rawBody } = prep;
  const body = rawBody as { memo?: unknown; expectedMemo?: unknown };
  const hasExpected = Object.hasOwn(body, "expectedMemo");

  if ((body.memo !== null && typeof body.memo !== "string") ||
      (hasExpected && body.expectedMemo !== null && typeof body.expectedMemo !== "string")) {
    return c.json({ ok: false, reason: "invalid_request" }, 400, ADMIN_PRIVATE_HEADERS);
  }
  const memo = typeof body.memo === "string" ? (body.memo.trim() || null) : null;
  if (memo !== null && memo.length > 1000) {
    return c.json({ ok: false, reason: "memo_too_long" }, 400, ADMIN_PRIVATE_HEADERS);
  }

  const exists = await db
    .prepare("SELECT 1 AS hit FROM customers WHERE id = ? AND merged_into_id IS NULL AND archived_at IS NULL")
    .bind(customerId)
    .first<{ hit: number }>();
  if (!exists) {
    return c.json({ ok: false, reason: "not_found" }, 404, ADMIN_PRIVATE_HEADERS);
  }

  return writeCustomerText(c, prep, "memo", memo, body.expectedMemo as string | null | undefined);
});

adminApiRoutes.put("/customers/:id/referrer", async (c) => {
  const prep = await prepareCustomerMutation(c);
  if (!prep.ok) return prep.response;
  const { rawBody: body } = prep;
  if (!Object.hasOwn(body, "referrerName") || !Object.hasOwn(body, "expectedReferrerName") ||
      (body.referrerName !== null && typeof body.referrerName !== "string") ||
      (body.expectedReferrerName !== null && typeof body.expectedReferrerName !== "string")) {
    return c.json({ ok: false, reason: "invalid_request" }, 400, ADMIN_PRIVATE_HEADERS);
  }
  const name = typeof body.referrerName === "string" ? body.referrerName.trim() || null : null;
  if (name !== null && name.length > 120) {
    return c.json({ ok: false, reason: "referrer_name_too_long" }, 400, ADMIN_PRIVATE_HEADERS);
  }
  return writeCustomerText(c, prep, "referrer_name", name, body.expectedReferrerName);
});

// 12. PATCH /customers/:id/profile — all admin roles, but staff only for their
// own-store customers (assertStaffCustomerStoreScope). Partial CRM field update.
const VALID_GENDERS = new Set(["male", "female", "other", "unspecified"]);
const BIRTH_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

type ProfileFieldsResult =
  | { ok: true; setClauses: string[]; bindValues: (string | null)[]; changes: Record<string, unknown> }
  | { ok: false; reason: string };

type FieldResult = { value: string | null } | { error: string };

function validateBirthDateField(v: unknown): FieldResult {
  if (v !== null && (typeof v !== "string" || !BIRTH_DATE_PATTERN.test(v))) {
    return { error: "invalid_birth_date" };
  }
  if (typeof v === "string") {
    const [y, m, d] = v.split("-").map(Number);
    const parsed = new Date(Date.UTC(y, m - 1, d));
    if (parsed.getUTCFullYear() !== y || parsed.getUTCMonth() !== m - 1 || parsed.getUTCDate() !== d) {
      return { error: "invalid_birth_date" };
    }
    return { value: v };
  }
  return { value: null };
}

function validateGenderField(v: unknown): FieldResult {
  if (v !== null && (typeof v !== "string" || !VALID_GENDERS.has(v))) {
    return { error: "invalid_gender" };
  }
  return { value: typeof v === "string" ? v : null };
}

function validateAllergyNotesField(v: unknown): FieldResult {
  if (v !== null && (typeof v !== "string" || v.length > 2000)) {
    return { error: "invalid_allergy_notes" };
  }
  return { value: typeof v === "string" ? (v.trim() || null) : null };
}

// display_name is NOT NULL with a CHECK length<=120 (migrations/0001) — required,
// non-empty when present.
function validateDisplayNameField(v: unknown): FieldResult {
  if (typeof v !== "string") return { error: "invalid_display_name" };
  const trimmed = v.trim();
  if (trimmed.length === 0 || trimmed.length > 120) return { error: "invalid_display_name" };
  return { value: trimmed };
}

// display_name_kana is nullable (CHECK length<=120). Blank/whitespace → null.
function validateDisplayNameKanaField(v: unknown): FieldResult {
  if (v === null) return { value: null };
  if (typeof v !== "string") return { error: "invalid_display_name_kana" };
  const trimmed = v.trim();
  if (trimmed.length === 0) return { value: null };
  if (trimmed.length > 120) return { error: "invalid_display_name_kana" };
  return { value: trimmed };
}

// Field-application table for PATCH /customers/:id/profile. Each entry maps a request
// key → its column, validator, and the audit metadata it contributes. validateProfileFields
// iterates this instead of repeating one if-block per field (keeps cognitive complexity low).
// All fields record only a *_updated flag in the audit metadata — never the value.
// Sensitive PII (birth_date / gender / allergy_notes) must not be persisted in
// audit_logs, which is retained indefinitely (out of scope for the retention sweep).
// Phone is handled separately in the route handler (async hash + two columns), so it
// is not in this table.
const PROFILE_FIELD_SPECS: ReadonlyArray<{
  key: string;
  column: string;
  validate: (v: unknown) => FieldResult;
  // Every field now records only a *_updated flag (post-H31), so audit ignores the
  // body/value — the narrower () signature keeps the declared contract honest.
  audit: () => Record<string, unknown>;
}> = [
  { key: "birthDate", column: "birth_date", validate: validateBirthDateField, audit: () => ({ birth_date_updated: true }) },
  { key: "gender", column: "gender", validate: validateGenderField, audit: () => ({ gender_updated: true }) },
  { key: "allergyNotes", column: "allergy_notes", validate: validateAllergyNotesField, audit: () => ({ allergy_notes_updated: true }) },
  { key: "displayName", column: "display_name", validate: validateDisplayNameField, audit: () => ({ display_name_updated: true }) },
  { key: "displayNameKana", column: "display_name_kana", validate: validateDisplayNameKanaField, audit: () => ({ display_name_kana_updated: true }) },
];

function validateProfileFields(body: Record<string, unknown>): ProfileFieldsResult {
  const setClauses: string[] = [];
  const bindValues: (string | null)[] = [];
  const changes: Record<string, unknown> = {};

  for (const spec of PROFILE_FIELD_SPECS) {
    if (!(spec.key in body)) continue;
    const r = spec.validate(body[spec.key]);
    if ("error" in r) return { ok: false, reason: r.error };
    setClauses.push(`${spec.column} = ?`);
    bindValues.push(r.value);
    Object.assign(changes, spec.audit());
  }

  // The "no fields" check moved to the route handler: phone is validated there
  // (async hash + two columns), so an update that supplies ONLY phone must not be
  // rejected here as empty.
  return { ok: true, setClauses, bindValues, changes };
}

// Phone editing sets TWO columns — phone_normalized + phone_hash — and the hash is
// async, so it lives here rather than in validateProfileFields. phone_hash is
// SHA-256(normalized) and intentionally non-unique (duplicates surface via the merge
// UI), so recomputing it on edit keeps merge-candidate grouping correct. Blank → both
// null (clears the phone). The profile batch also updates the phone-scoped locks
// atomically, so changing a number cannot split the same-phone overlap guard.
// Returns null when the body has no "phone" field, an error code when invalid, or the
// SQL fragments + binds to apply.
async function buildPhoneUpdate(
  rawBody: Record<string, unknown>
): Promise<{ set: string[]; binds: (string | null)[] } | { error: "invalid_phone" } | null> {
  if (!("phone" in rawBody)) return null;
  const rawPhone = rawBody.phone;
  if (rawPhone !== null && typeof rawPhone !== "string") return { error: "invalid_phone" };
  // A masked phone (contains '*') is the read-only value staff now see (⑥). When a
  // client echoes the prefilled masked value back unchanged — e.g. a staff name-only
  // edit re-submits `***-****-1234` — treat it as "no phone change", NOT a value to
  // store: normalizePhone would reject it (invalid_phone), and blanking it would wipe
  // the real number. A genuine edit sends real digits (no '*') and is processed below.
  if (typeof rawPhone === "string" && rawPhone.includes("*")) return null;
  let phoneNormalized: string | null = null;
  if (typeof rawPhone === "string" && rawPhone.trim().length > 0) {
    const normalized = normalizePhone(rawPhone);
    if (!normalized) return { error: "invalid_phone" };
    phoneNormalized = normalized;
  }
  const phoneHash = phoneNormalized ? await sha256Hex(phoneNormalized) : null;
  return { set: ["phone_normalized = ?", "phone_hash = ?"], binds: [phoneNormalized, phoneHash] };
}

// A Google Calendar event title embeds the customer's display name (calendar-sync.ts
// builds `${services} | ${customerName}` from customers.display_name), so renaming a
// customer leaves their existing event titles stale until the reservation is next
// touched. Enqueue an 'upsert' per reservation so the next sync pass refreshes the
// titles — mirrors the customer-merge flow (src/admin/customer-merge.ts). Gated on the
// audit row (EXISTS) so it only fires when the UPDATE actually changed a row;
// cancelled/expired reservations are filtered out at processing time by
// isReservationStillUpsertable (no event resurrection). Only the display name affects
// the title, so phone / kana / email-only edits skip this.
//
// storeScope: when non-null (a STAFF actor) the enqueue is restricted to that store's
// reservations. A staff member may edit a customer who ALSO has reservations at other
// stores (staffCanAccessCustomer is true if the customer has any reservation/visit at
// the staff's store), and must not trigger Google Calendar writes on those other stores'
// reservations. null (owner / system_admin) refreshes every store's events — they hold
// cross-store authority, and matches the customer-merge precedent (owner-only).
//
// dedupe_key format: cpu:<auditId>:r:<reservationId>  ("cpu" = customer profile update).
// auditId is a per-request UUID (36 chars), so the key is deterministic per (edit,
// reservation). Length = 4 + 36 + 3 + 36 = 79, well under the 256-char CHECK; the
// substr(...,1,256) cap guards any non-UUID reservation id (matches customer-merge.ts).
//
// ponytail: enqueues whenever displayName is submitted, not on a true old/new diff (the
// edit form always sends displayName). Redundant upserts are fingerprint-deduped
// downstream via google_calendar_outbound_writes and prod volume is tiny; add an
// old-value diff if Google write volume ever matters.
function buildCustomerRenameCalendarUpsert(
  db: D1Database,
  args: { auditId: string; nowIso: string; customerId: string; storeScope: string | null }
): D1PreparedStatement {
  const storeFilter = args.storeScope ? "AND store_id = ?" : "";
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO calendar_sync_jobs (
       id, dedupe_key, owner_type, owner_id, google_action, status, available_at
     )
     SELECT
       lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
             substr(hex(randomblob(2)),2) || '-' ||
             substr('89ab', abs(random()) % 4 + 1, 1) ||
             substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))),
       substr('cpu:' || ? || ':r:' || id, 1, 256),
       'reservation',
       id,
       'upsert',
       'queued',
       ?
     FROM reservations
     WHERE customer_id = ?
       ${storeFilter}
       AND EXISTS (SELECT 1 FROM audit_logs WHERE id = ?)`
  );
  return args.storeScope
    ? stmt.bind(args.auditId, args.nowIso, args.customerId, args.storeScope, args.auditId)
    : stmt.bind(args.auditId, args.nowIso, args.customerId, args.auditId);
}

const handleCustomerProfileWriteError = async (
  c: Context<AppEnvironment>, db: D1Database, admin: AdminUser, error: unknown
) => {
  if (await adminWriteWasRevoked(db, admin, error)) {
    return c.json(FORBIDDEN_BODY, 403, ADMIN_PRIVATE_HEADERS);
  }
  // A schema/infrastructure error mentioning this table is not an overlap.
  if (/UNIQUE constraint failed: customer_time_locks\./.test(String(error))) {
    return c.json({ ok: false, reason: "customer_time_conflict" }, 409, ADMIN_PRIVATE_HEADERS);
  }
  throw error;
};

adminApiRoutes.patch("/customers/:id/profile", async (c) => {
  const prep = await prepareCustomerMutation(c);
  if (!prep.ok) return prep.response;
  const { db, admin, customerId, rawBody } = prep;

  const fields = validateProfileFields(rawBody);
  if (!fields.ok) {
    return c.json({ ok: false, reason: fields.reason }, 400, ADMIN_PRIVATE_HEADERS);
  }

  const setClauses = [...fields.setClauses];
  const bindValues: (string | null)[] = [...fields.bindValues];
  const changes: Record<string, unknown> = { ...fields.changes };

  const phone = await buildPhoneUpdate(rawBody);
  if (phone && "error" in phone) {
    return c.json({ ok: false, reason: phone.error }, 400, ADMIN_PRIVATE_HEADERS);
  }
  if (phone) {
    setClauses.push(...phone.set);
    bindValues.push(...phone.binds);
    // Never store the raw phone in audit metadata (no-PII-in-audit convention).
    changes.phone_updated = true;
  }

  if (setClauses.length === 0) {
    return c.json({ ok: false, reason: "no_fields" }, 400, ADMIN_PRIVATE_HEADERS);
  }

  const exists = await db
    .prepare("SELECT 1 AS hit FROM customers WHERE id = ? AND merged_into_id IS NULL AND archived_at IS NULL")
    .bind(customerId)
    .first<{ hit: number }>();
  if (!exists) {
    return c.json({ ok: false, reason: "not_found" }, 404, ADMIN_PRIVATE_HEADERS);
  }

  setClauses.push("updated_at = CURRENT_TIMESTAMP");
  const auditId = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  const customerScopeSql = `(? != 'staff' OR ${OWN_STORE_MEMBERSHIP_ARMS})`;
  const customerScopeBindings = [admin.role, admin.store_id, admin.store_id, admin.store_id];
  const statements = [adminWriteGuard(db, admin)];
  if (phone) {
    statements.push(db.prepare(`
      UPDATE customer_time_locks SET phone_hash = ?
      WHERE customer_id = ? AND owner_type = 'reservation'
        AND EXISTS (
          SELECT 1 FROM reservations r
          WHERE r.id = customer_time_locks.owner_id
            AND r.customer_id = customer_time_locks.customer_id
            AND r.source IN ('phone_admin', 'admin')
        )
        AND EXISTS (
          SELECT 1 FROM customers c
          WHERE c.id = customer_time_locks.customer_id
            AND c.merged_into_id IS NULL AND c.archived_at IS NULL
            AND c.phone_hash IS NOT ?
            AND ${customerScopeSql}
        )
    `).bind(phone.binds[1], customerId, phone.binds[1], ...customerScopeBindings));
  }
  const customerUpdateIndex = statements.length;
  statements.push(
    db
      .prepare(`UPDATE customers AS c SET ${setClauses.join(", ")}
        WHERE c.id = ? AND c.merged_into_id IS NULL AND c.archived_at IS NULL AND ${customerScopeSql}`)
      .bind(...bindValues, customerId, ...customerScopeBindings),
    db
      .prepare(
        `INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, metadata_json)
         SELECT ?, 'staff', ?, 'customer.profile_update', 'customer', ?, ?
         WHERE changes() = 1`
      )
      .bind(auditId, admin.id, customerId, JSON.stringify(changes))
  );

  // Refresh Google Calendar event titles after a rename — see
  // buildCustomerRenameCalendarUpsert. Staff edits stay within their own store;
  // owner / system_admin refresh every store's events.
  if (changes.display_name_updated === true) {
    const renameStoreScope = admin.role === "staff" ? admin.store_id : null;
    statements.push(
      buildCustomerRenameCalendarUpsert(db, { auditId, nowIso, customerId, storeScope: renameStoreScope })
    );
  }

  let results: D1Result[];
  try {
    results = await db.batch(statements);
  } catch (error) {
    return handleCustomerProfileWriteError(c, db, admin, error);
  }

  if (Number(results[customerUpdateIndex]?.meta?.changes ?? 0) !== 1) {
    return (await assertStaffCustomerStoreScope(c, db, customerId, admin))
      ?? c.json({ ok: false, reason: "not_found" }, 404, ADMIN_PRIVATE_HEADERS);
  }

  return c.json({ ok: true }, 200, ADMIN_PRIVATE_HEADERS);
});

/**
 * 施術メモ本体の検証。ルートから切り出してあるのは、顧客タブのゲート (spec 008) を足した
 * 時点でハンドラの認知的複雑度が Sonar の上限を超えたため (S3776)。判定の中身も順序も
 * 変えていない。
 */
const readTreatmentNotes = (
  body: { treatmentNotes?: unknown; expectedTreatmentNotes?: unknown }
): { ok: true; notes: string | null; hasExpected: boolean; expected: string | null } | { ok: false; reason: string } => {
  if (!("treatmentNotes" in body)) return { ok: false, reason: "missing_treatment_notes" };
  if (body.treatmentNotes !== null && typeof body.treatmentNotes !== "string") {
    return { ok: false, reason: "invalid_request" };
  }
  const notes = typeof body.treatmentNotes === "string" ? body.treatmentNotes.trim() || null : null;
  if (notes !== null && notes.length > 2000) return { ok: false, reason: "notes_too_long" };
  const hasExpected = Object.hasOwn(body, "expectedTreatmentNotes");
  if (hasExpected && body.expectedTreatmentNotes !== null && typeof body.expectedTreatmentNotes !== "string") {
    return { ok: false, reason: "invalid_request" };
  }
  return { ok: true, notes, hasExpected, expected: typeof body.expectedTreatmentNotes === "string" ? body.expectedTreatmentNotes : null };
};

const customerVisitNotesWriteFailure = async (
  c: Context<AppEnvironment>,
  input: { db: D1Database; admin: AdminUser; customerId: string; visitId: string },
  hasExpected: boolean
) => {
  const { db, admin, customerId, visitId } = input;
  const scope = await assertStaffCustomerStoreScope(c, db, customerId, admin);
  if (scope) return scope;
  const current = await db.prepare(`SELECT cv.id FROM customer_visits cv
    JOIN customers c ON c.id = cv.customer_id
    WHERE cv.id = ? AND cv.customer_id = ? AND cv.status = 'valid'
      AND (? != 'staff' OR cv.store_id = ?)
      AND c.merged_into_id IS NULL AND c.archived_at IS NULL`)
    .bind(visitId, customerId, admin.role, admin.store_id).first();
  if (current && hasExpected) {
    return c.json({ ok: false, reason: "stale_snapshot" }, 409, ADMIN_PRIVATE_HEADERS);
  }
  return c.json({ ok: false, reason: "not_found" }, 404, ADMIN_PRIVATE_HEADERS);
};

// 13. PUT /customers/:id/visits/:visitId/notes — all admin roles, treatment notes update
adminApiRoutes.put("/customers/:id/visits/:visitId/notes", async (c) => {
  const gate = await authenticateAdminWithDb(c, ADMIN_PRIVATE_HEADERS);
  if (!gate.ok) return gate.response;
  // Gated even though the reservation-detail panel edits karte through this same
  // route: the panel's exemption (FR-012 / NG-001) is about what it DISPLAYS. This
  // is a write, and without the gate an unapproved staff member could overwrite or
  // erase any of their store's treatment notes — visit ids are handed out by the
  // ungated GET /reservations/:id.
  const tabGate = await assertCustomerTabGate(c, gate.db, gate.admin);
  if (tabGate) return tabGate;
  const parsed = await parseJsonBody(c, ADMIN_PRIVATE_HEADERS);
  if (!parsed.ok) return parsed.response;
  const rawBody = parsed.body;
  if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return c.json({ ok: false, reason: "invalid_request" }, 400, ADMIN_PRIVATE_HEADERS);
  }
  const body = rawBody as { treatmentNotes?: unknown; expectedTreatmentNotes?: unknown };

  const customerId = c.req.param("id");
  const visitId = c.req.param("visitId");
  if (!customerId || !visitId) {
    return c.json({ ok: false, reason: "invalid_request" }, 400, ADMIN_PRIVATE_HEADERS);
  }

  // Canonical own-store customer gate for staff (same as detail/memo/profile): a
  // staff must not edit treatment notes on an archived/merged/other-store customer
  // even if they know its visitId. The visit-specific store_id check below remains
  // (a staff's own-store customer can still have a visit at a different store).
  const scope = await assertStaffCustomerStoreScope(c, gate.db, customerId, gate.admin);
  if (scope) return scope;

  const notesBody = readTreatmentNotes(body);
  if (!notesBody.ok) {
    return c.json({ ok: false, reason: notesBody.reason }, 400, ADMIN_PRIVATE_HEADERS);
  }
  const notes = notesBody.notes;

  // 無効化された来店実績は履歴として読めるだけで、書き換えは受け付けない。
  // 事前 SELECT と UPDATE の WHERE の両方で絞る (確認から書き込みまでの間に
  // 訂正が走って void 化される競合があるため)。
  const visit = await gate.db
    .prepare("SELECT store_id FROM customer_visits WHERE id = ? AND customer_id = ? AND status = 'valid'")
    .bind(visitId, customerId)
    .first<{ store_id: string }>();
  if (!visit) {
    return c.json({ ok: false, reason: "not_found" }, 404, ADMIN_PRIVATE_HEADERS);
  }
  if (gate.admin.role === "staff" && gate.admin.store_id !== visit.store_id) {
    return c.json({ ok: false, reason: "forbidden" }, 403, ADMIN_PRIVATE_HEADERS);
  }

  const auditId = crypto.randomUUID();
  let results: D1Result[];
  try {
    results = await gate.db.batch([
      adminWriteGuard(gate.db, gate.admin),
      gate.db
        .prepare(
          `UPDATE customer_visits
           SET treatment_notes = ?
           WHERE id = ?
             AND customer_id = ?
             AND status = 'valid'
             AND (? != 'staff' OR store_id = ?)
             AND (? = 0 OR treatment_notes IS ?)
             AND EXISTS (
               SELECT 1 FROM customers
               WHERE id = ? AND merged_into_id IS NULL AND archived_at IS NULL
             )`
        )
        .bind(notes, visitId, customerId, gate.admin.role, gate.admin.store_id, notesBody.hasExpected ? 1 : 0, notesBody.expected, customerId),
      gate.db
        .prepare(
          `INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, metadata_json)
           SELECT ?, 'staff', ?, 'customer.visit_notes_update', 'customer_visit', ?, ?
           WHERE changes() = 1`
        )
        .bind(auditId, gate.admin.id, visitId, JSON.stringify({ customer_id: customerId, notes_length: notes?.length ?? 0 }))
    ]);
  } catch (error) {
    if (await adminWriteWasRevoked(gate.db, gate.admin, error)) {
      return c.json(FORBIDDEN_BODY, 403, ADMIN_PRIVATE_HEADERS);
    }
    throw error;
  }

  if (Number(results[1]?.meta?.changes ?? 0) !== 1) {
    return customerVisitNotesWriteFailure(c, { db: gate.db, admin: gate.admin, customerId, visitId }, notesBody.hasExpected);
  }

  return c.json({ ok: true }, 200, ADMIN_PRIVATE_HEADERS);
});

// 13b. POST /customers/:id/visits — owner+ only, manual past-visit (紙カルテ) add.
// Inserts ONE customer_visits row with visit_source='manual_import',
// status='valid', reservation_id=NULL, recorded_by=admin.id. Idempotent +
// audited. Goes through the global admin CSRF/Sec-Fetch-Site guard. Raises
// valid_visit_count (does NOT touch the Google-title self-exclusion subquery,
// which only excludes the reservation's own non-null reservation_id visit).
adminApiRoutes.post("/customers/:id/visits", async (c) => {
  const gate = await authenticateOwnerWithJsonBody(c);
  if (!gate.ok) return gate.response;

  const customerId = c.req.param("id");
  if (!customerId) {
    return c.json({ ok: false, reason: "invalid_request" }, 400, ADMIN_PRIVATE_HEADERS);
  }

  const body = gate.body as {
    idempotencyKey?: unknown;
    visitedAt?: unknown;
    storeId?: unknown;
    treatmentNotes?: unknown;
  };
  if (
    typeof body.idempotencyKey !== "string" ||
    typeof body.visitedAt !== "string" ||
    typeof body.storeId !== "string" ||
    (body.treatmentNotes !== undefined &&
      body.treatmentNotes !== null &&
      typeof body.treatmentNotes !== "string")
  ) {
    return c.json({ ok: false, reason: "invalid_request" }, 400, ADMIN_PRIVATE_HEADERS);
  }

  const request: AdminAddCustomerVisitRequest = {
    idempotencyKey: body.idempotencyKey,
    visitedAt: body.visitedAt,
    storeId: body.storeId,
    treatmentNotes: typeof body.treatmentNotes === "string" ? body.treatmentNotes : null
  };

  const result = await addAdminCustomerVisit({
    db: c.env.DB!,
    admin: gate.admin,
    customerId,
    request
  });

  return c.json(result, statusForAdminAddCustomerVisitResult(result), ADMIN_PRIVATE_HEADERS);
});

// 13c. PATCH /customers/:id/visits/:visitId — owner+ only, edit a manual visit's
// 来店日 (visited_at). Reservation-derived visits (reservation_id NOT NULL) are
// immutable here → reservation_linked (409). Round-trip date validated, idempotent,
// audited. (The treatment-notes edit stays on the separate staff-allowed PUT route.)
adminApiRoutes.patch("/customers/:id/visits/:visitId", async (c) => {
  const gate = await authenticateOwnerWithJsonBody(c);
  if (!gate.ok) return gate.response;

  const customerId = c.req.param("id");
  const visitId = c.req.param("visitId");
  if (!customerId || !visitId) {
    return c.json({ ok: false, reason: "invalid_request" }, 400, ADMIN_PRIVATE_HEADERS);
  }

  const body = gate.body as { idempotencyKey?: unknown; visitedAt?: unknown };
  if (typeof body.idempotencyKey !== "string" || typeof body.visitedAt !== "string") {
    return c.json({ ok: false, reason: "invalid_request" }, 400, ADMIN_PRIVATE_HEADERS);
  }

  const request: AdminUpdateCustomerVisitRequest = {
    idempotencyKey: body.idempotencyKey,
    visitedAt: body.visitedAt
  };

  const result = await updateAdminCustomerVisit({
    db: c.env.DB!,
    admin: gate.admin,
    customerId,
    visitId,
    request
  });

  return c.json(result, statusForAdminUpdateCustomerVisitResult(result), ADMIN_PRIVATE_HEADERS);
});

// 13d. DELETE /customers/:id/visits/:visitId — owner+ only, delete a manual visit.
// DELETE carries no JSON body, so authenticateOwnerWithJsonBody (which 400s on an
// empty body) is unusable; gate with authenticateAdminRoute + requireOwnerWithDb.
adminApiRoutes.delete("/customers/:id/visits/:visitId", async (c) => {
  const authGate = await authenticateAdminRoute(c, ADMIN_PRIVATE_HEADERS);
  if (!authGate.ok) return authGate.response;
  const ownerGate = requireOwnerWithDb(c, authGate);
  if (ownerGate) return ownerGate;

  const customerId = c.req.param("id");
  const visitId = c.req.param("visitId");
  if (!customerId || !visitId) {
    return c.json({ ok: false, reason: "invalid_request" }, 400, ADMIN_PRIVATE_HEADERS);
  }

  const result = await deleteAdminCustomerVisit({
    db: c.env.DB!,
    admin: authGate.admin,
    customerId,
    visitId
  });

  return c.json(result, statusForAdminDeleteCustomerVisitResult(result), ADMIN_PRIVATE_HEADERS);
});

// 8b. POST /customers — every admin role, manually register a customer (紙カルテの
// お客様) so the "既存客に紐付け" LINE flow has a record to attach to. Idempotent +
// audited. Duplicate phones are allowed (surfaced/resolved via the merge UI, by
// design). Staff are scoped inside createAdminCustomer: the new row is stamped
// with THEIR store (from the JWT, never the body) and a staff account with no
// store binding is refused.
adminApiRoutes.post("/customers", async (c) => {
  const gate = await authenticateAdminWithDb(c, ADMIN_PRIVATE_HEADERS);
  if (!gate.ok) return gate.response;
  const tabGate = await assertCustomerTabGate(c, gate.db, gate.admin);
  if (tabGate) return tabGate;
  const parsed = await parseJsonObjectBody(c);
  if (!parsed.ok) return parsed.response;

  const body = parsed.body as {
    idempotencyKey?: unknown;
    displayName?: unknown;
    displayNameKana?: unknown;
    phone?: unknown;
  };
  if (
    typeof body.idempotencyKey !== "string" ||
    typeof body.displayName !== "string" ||
    (body.displayNameKana !== undefined &&
      body.displayNameKana !== null &&
      typeof body.displayNameKana !== "string") ||
    (body.phone !== undefined && body.phone !== null && typeof body.phone !== "string")
  ) {
    return c.json({ ok: false, reason: "invalid_request" }, 400, ADMIN_PRIVATE_HEADERS);
  }

  const request: AdminCreateCustomerRequest = {
    idempotencyKey: body.idempotencyKey,
    displayName: body.displayName,
    displayNameKana: typeof body.displayNameKana === "string" ? body.displayNameKana : null,
    phone: typeof body.phone === "string" ? body.phone : null
  };

  const result = await createAdminCustomer({
    db: gate.db,
    admin: gate.admin,
    request
  });

  return c.json(result, statusForAdminCreateCustomerResult(result), ADMIN_PRIVATE_HEADERS);
});

// 14. POST /customers/:id/merge — via requireAdminContext + respondAdminMutation
adminApiRoutes.post("/customers/:id/merge", async (c) => {
  const ctx = await requireAdminContext(c);
  if (isRouteFailure(ctx)) return ctx.response;
  const parsed = await parseAdminJsonBody(c, parseAdminCustomerMergeRequest);
  if (isRouteFailure(parsed)) return parsed.response;
  const sourceId = c.req.param("id");
  if (!sourceId) {
    return c.json({ ok: false, error: "invalid_request" }, 400, ADMIN_PRIVATE_HEADERS);
  }
  const result = await executeAdminCustomerMerge({
    db: ctx.db,
    admin: ctx.admin,
    sourceId,
    targetId: parsed.targetId
  });
  return respondAdminMutation(c, result, 200, CUSTOMER_MERGE_STATUS_BY_ERROR);
});

// 14b. POST /customers/:id/delete — owner / system_admin only. IRREVERSIBLE
// hard delete of a customer and every record hanging off it (reservations,
// visits, LINE identities, locks, sync/notification jobs, …) via an
// FK-ordered batch. The owner-only gate + business guards (no active/upcoming
// reservation, no live Google event, no in-flight Google sync) live inside
// executeAdminCustomerDelete; a guard hit maps to 409. Goes through the global
// admin CSRF/Sec-Fetch-Site guard.
const CUSTOMER_DELETE_FAILURE_STATUS: Record<CustomerDeleteReason, ContentfulStatusCode> = {
  forbidden: 403,
  not_found: 404,
  integrity_conflict: 409,
  has_active_reservations: 409,
  has_active_google_events: 409,
  has_open_google_conflicts: 409,
  has_pending_google_sync: 409,
  has_pending_notifications: 409,
  conflict: 409,
};
adminApiRoutes.post("/customers/:id/delete", async (c) => {
  const gate = await authenticateAdminWithDb(c, ADMIN_PRIVATE_HEADERS);
  if (!gate.ok) return gate.response;

  const customerId = c.req.param("id");
  if (!customerId) {
    return c.json({ ok: false, reason: "invalid_request" }, 400, ADMIN_PRIVATE_HEADERS);
  }

  const result = await executeAdminCustomerDelete({
    db: gate.db,
    admin: gate.admin,
    customerId
  });

  const status = result.ok ? 200 : (CUSTOMER_DELETE_FAILURE_STATUS[result.reason] ?? 400);
  return c.json(result, status, ADMIN_PRIVATE_HEADERS);
});

// 13. Settings CRUD (services, resources, staff, closures, reminder, business-hours)

// Services
adminApiRoutes.post("/settings/services", async (c) => {
  const ctx = await requireAdminContext(c);
  if (isRouteFailure(ctx)) return ctx.response;
  const request = await parseAdminJsonBody(c, parseAdminServiceCreateRequest);
  if (isRouteFailure(request)) return request.response;
  const result = await createAdminService({ db: ctx.db, admin: ctx.admin, request });
  return respondAdminMutation(c, result, createSuccessStatus, SETTINGS_CREATE_STATUS_BY_ERROR);
});

adminApiRoutes.put("/settings/services/:id", async (c) => {
  const ctx = await requireAdminContext(c);
  if (isRouteFailure(ctx)) return ctx.response;
  const request = await parseAdminJsonBody(c, parseAdminServiceUpdateRequest);
  if (isRouteFailure(request)) return request.response;
  const serviceId = c.req.param("id");
  if (!serviceId) {
    return c.json({ ok: false, error: "invalid_request" }, 400, ADMIN_PRIVATE_HEADERS);
  }
  const result = await updateAdminService({ db: ctx.db, admin: ctx.admin, serviceId, request });
  return respondAdminMutation(c, result, 200, {
    forbidden: 403,
    invalid_request: 400,
    not_found: 404,
    store_not_found: 404,
    has_future_reservations: 409,
    immutable_store: 409,
    missing_database: 500,
    write_failed: 500
  });
});

adminApiRoutes.delete("/settings/services/:id", async (c) => {
  const ctx = await requireAdminContext(c);
  if (isRouteFailure(ctx)) return ctx.response;
  const serviceId = c.req.param("id");
  if (!serviceId) {
    return c.json({ ok: false, error: "invalid_request" }, 400, ADMIN_PRIVATE_HEADERS);
  }
  const result = await softDeleteAdminService({ db: ctx.db, admin: ctx.admin, serviceId });
  return respondAdminMutation(c, result, 200, {
    forbidden: 403,
    invalid_request: 400,
    not_found: 404,
    has_future_reservations: 409,
    missing_database: 500,
    write_failed: 500
  });
});

// Resources
adminApiRoutes.post("/settings/resources", async (c) => {
  const ctx = await requireAdminContext(c);
  if (isRouteFailure(ctx)) return ctx.response;
  const request = await parseAdminJsonBody(c, parseAdminResourceCreateRequest);
  if (isRouteFailure(request)) return request.response;
  const result = await createAdminResource({ db: ctx.db, admin: ctx.admin, request });
  return respondAdminMutation(c, result, createSuccessStatus, SETTINGS_CREATE_STATUS_BY_ERROR);
});

adminApiRoutes.put("/settings/resources/:id", async (c) => {
  const ctx = await requireAdminContext(c);
  if (isRouteFailure(ctx)) return ctx.response;
  const request = await parseAdminJsonBody(c, parseAdminResourceUpdateRequest);
  if (isRouteFailure(request)) return request.response;
  const resourceId = c.req.param("id");
  if (!resourceId) {
    return c.json({ ok: false, error: "invalid_request" }, 400, ADMIN_PRIVATE_HEADERS);
  }
  const result = await updateAdminResource({ db: ctx.db, admin: ctx.admin, resourceId, request });
  return respondAdminMutation(c, result, 200, {
    forbidden: 403,
    invalid_request: 400,
    not_found: 404,
    store_not_found: 404,
    has_future_reservations: 409,
    immutable_store: 409,
    missing_database: 500,
    write_failed: 500
  });
});

adminApiRoutes.delete("/settings/resources/:id", async (c) => {
  const ctx = await requireAdminContext(c);
  if (isRouteFailure(ctx)) return ctx.response;
  const resourceId = c.req.param("id");
  if (!resourceId) {
    return c.json({ ok: false, error: "invalid_request" }, 400, ADMIN_PRIVATE_HEADERS);
  }
  const result = await softDeleteAdminResource({ db: ctx.db, admin: ctx.admin, resourceId });
  return respondAdminMutation(c, result, 200, {
    forbidden: 403,
    invalid_request: 400,
    not_found: 404,
    has_future_reservations: 409,
    missing_database: 500,
    write_failed: 500
  });
});

// Staff
adminApiRoutes.post("/settings/staff", async (c) => {
  const ctx = await requireAdminContext(c);
  if (isRouteFailure(ctx)) return ctx.response;
  const request = await parseAdminJsonBody(c, parseAdminStaffCreateRequest);
  if (isRouteFailure(request)) return request.response;
  const result = await createAdminStaff({ db: ctx.db, admin: ctx.admin, request });
  return respondAdminMutation(c, result, createSuccessStatus, SETTINGS_CREATE_STATUS_BY_ERROR);
});

adminApiRoutes.put("/settings/staff/:id", async (c) => {
  const ctx = await requireAdminContext(c);
  if (isRouteFailure(ctx)) return ctx.response;
  const request = await parseAdminJsonBody(c, parseAdminStaffUpdateRequest);
  if (isRouteFailure(request)) return request.response;
  const staffId = c.req.param("id");
  if (!staffId) {
    return c.json({ ok: false, error: "invalid_request" }, 400, ADMIN_PRIVATE_HEADERS);
  }
  const result = await updateAdminStaff({ db: ctx.db, admin: ctx.admin, staffId, request });
  return respondAdminMutation(c, result, 200, {
    forbidden: 403,
    forbidden_self_deactivation: 403,
    forbidden_role_escalation: 403,
    invalid_request: 400,
    not_found: 404,
    store_not_found: 404,
    immutable_store: 409,
    stale_snapshot: 409,
    missing_database: 500,
    write_failed: 500
  });
});

adminApiRoutes.delete("/settings/staff/:id", async (c) => {
  const ctx = await requireAdminContext(c);
  if (isRouteFailure(ctx)) return ctx.response;
  const staffId = c.req.param("id");
  if (!staffId) {
    return c.json({ ok: false, error: "invalid_request" }, 400, ADMIN_PRIVATE_HEADERS);
  }
  const result = await softDeleteAdminStaff({ db: ctx.db, admin: ctx.admin, staffId });
  return respondAdminMutation(c, result, 200, {
    forbidden: 403,
    forbidden_self_deactivation: 403,
    forbidden_role_escalation: 403,
    invalid_request: 400,
    not_found: 404,
    missing_database: 500,
    write_failed: 500
  });
});

// Store logins (owner+) — an owner pre-registers each store's shared login by
// email. The domain layer (src/admin/settings-store-login.ts) owns the
// fail-closed resolver, email_in_use hijack guard, and self-deactivation guard;
// these routes only gate by privilege and map the domain error union to HTTP.
adminApiRoutes.get("/store-logins", async (c) => {
  const ctx = await requireAdminContext(c);
  if (isRouteFailure(ctx)) return ctx.response;
  if (!isAdminPrivileged(ctx.admin.role)) {
    return c.json({ ok: false, error: "forbidden" }, 403, ADMIN_PRIVATE_HEADERS);
  }
  const storeLogins = await listStoreLogins(ctx.db);
  return c.json({ ok: true, storeLogins }, 200, ADMIN_PRIVATE_HEADERS);
});

adminApiRoutes.post("/store-logins", async (c) => {
  const ctx = await requireAdminContext(c);
  if (isRouteFailure(ctx)) return ctx.response;
  const request = await parseAdminJsonBody(c, parseStoreLoginUpsertRequest);
  if (isRouteFailure(request)) return request.response;
  const result = await upsertStoreLogin({ db: ctx.db, admin: ctx.admin, request });
  return respondAdminMutation(c, result, createSuccessStatus, {
    forbidden: 403,
    forbidden_self_deactivation: 403,
    invalid_request: 400,
    store_not_found: 404,
    email_in_use: 409,
    idempotency_conflict: 409,
    idempotency_in_progress: 409,
    missing_database: 500,
    write_failed: 500
  });
});

adminApiRoutes.delete("/store-logins/:storeId", async (c) => {
  const ctx = await requireAdminContext(c);
  if (isRouteFailure(ctx)) return ctx.response;
  const storeId = c.req.param("storeId");
  if (!storeId) {
    return c.json({ ok: false, error: "invalid_request" }, 400, ADMIN_PRIVATE_HEADERS);
  }
  const result = await revokeStoreLogin({ db: ctx.db, admin: ctx.admin, storeId });
  return respondAdminMutation(c, result, 200, {
    forbidden: 403,
    forbidden_self_deactivation: 403,
    invalid_request: 400,
    not_found: 404,
    missing_database: 500,
    write_failed: 500
  });
});

// Closures
adminApiRoutes.post("/settings/closures", async (c) => {
  const ctx = await requireAdminContext(c);
  if (isRouteFailure(ctx)) return ctx.response;
  const request = await parseAdminJsonBody(c, parseAdminClosureCreateRequest);
  if (isRouteFailure(request)) return request.response;
  const result = await createAdminClosure({ db: ctx.db, admin: ctx.admin, request });
  return respondAdminMutation(c, result, createSuccessStatus, {
    forbidden: 403,
    invalid_request: 400,
    store_not_found: 404,
    overlapping_reservations: 409,
    missing_database: 500,
    idempotency_conflict: 409,
    idempotency_in_progress: 409,
    write_failed: 500
  });
});

adminApiRoutes.put("/settings/closures/:id", async (c) => {
  const ctx = await requireAdminContext(c);
  if (isRouteFailure(ctx)) return ctx.response;
  const request = await parseAdminJsonBody(c, parseAdminClosureUpdateRequest);
  if (isRouteFailure(request)) return request.response;
  const closureId = c.req.param("id");
  if (!closureId) {
    return c.json({ ok: false, error: "invalid_request" }, 400, ADMIN_PRIVATE_HEADERS);
  }
  const result = await updateAdminClosure({ db: ctx.db, admin: ctx.admin, closureId, request });
  return respondAdminMutation(c, result, 200, {
    forbidden: 403,
    invalid_request: 400,
    not_found: 404,
    store_not_found: 404,
    immutable_source: 409,
    immutable_store: 409,
    overlapping_reservations: 409,
    missing_database: 500,
    write_failed: 500
  });
});

adminApiRoutes.delete("/settings/closures/:id", async (c) => {
  const ctx = await requireAdminContext(c);
  if (isRouteFailure(ctx)) return ctx.response;
  const closureId = c.req.param("id");
  if (!closureId) {
    return c.json({ ok: false, error: "invalid_request" }, 400, ADMIN_PRIVATE_HEADERS);
  }
  const result = await deleteAdminClosure({ db: ctx.db, admin: ctx.admin, closureId });
  return respondAdminMutation(c, result, 200, {
    forbidden: 403,
    invalid_request: 400,
    not_found: 404,
    immutable_source: 409,
    missing_database: 500,
    write_failed: 500
  });
});

// Reminder
adminApiRoutes.put("/settings/reminder", async (c) => {
  const ctx = await requireAdminContext(c);
  if (isRouteFailure(ctx)) return ctx.response;
  const request = await parseAdminJsonBody(c, parseAdminReminderUpdateRequest);
  if (isRouteFailure(request)) return request.response;
  const result = await updateAdminReminderSettings({
    db: ctx.db,
    admin: ctx.admin,
    request
  });
  return respondAdminMutation(c, result, 200, {
    forbidden: 403,
    invalid_request: 400,
    store_not_found: 404,
    missing_database: 500,
    write_failed: 500
  });
});

adminApiRoutes.put("/settings/reservation-cap", async (c) => {
  const ctx = await requireAdminContext(c);
  if (isRouteFailure(ctx)) return ctx.response;
  const request = await parseAdminJsonBody(c, parseReservationCapUpdateRequest);
  if (isRouteFailure(request)) return request.response;
  const result = await updateAdminReservationCapSettings({
    db: ctx.db,
    admin: ctx.admin,
    request
  });
  return respondAdminMutation(c, result, 200, {
    forbidden: 403,
    invalid_request: 400,
    store_not_found: 404,
    missing_database: 500,
    write_failed: 500
  });
});

adminApiRoutes.put("/settings/booking-window", async (c) => {
  const ctx = await requireAdminContext(c);
  if (isRouteFailure(ctx)) return ctx.response;
  const request = await parseAdminJsonBody(c, parseBookingWindowUpdateRequest);
  if (isRouteFailure(request)) return request.response;
  const result = await updateAdminBookingWindowSettings({
    db: ctx.db,
    admin: ctx.admin,
    request
  });
  return respondAdminMutation(c, result, 200, {
    forbidden: 403,
    invalid_request: 400,
    store_not_found: 404,
    missing_database: 500,
    write_failed: 500
  });
});

adminApiRoutes.put("/settings/customer-notice", async (c) => {
  const ctx = await requireAdminContext(c);
  if (isRouteFailure(ctx)) return ctx.response;
  const request = await parseAdminJsonBody(c, parseCustomerNoticeUpdateRequest);
  if (isRouteFailure(request)) return request.response;
  const result = await updateAdminCustomerNoticeSettings({
    db: ctx.db,
    admin: ctx.admin,
    request
  });
  return respondAdminMutation(c, result, 200, {
    forbidden: 403,
    invalid_request: 400,
    store_not_found: 404,
    missing_database: 500,
    write_failed: 500
  });
});

// ── LINE友だち ↔ 紙カルテ顧客 手動紐付け（owner+ のみ）─────────────────
adminApiRoutes.post("/line-friends/sync", async (c) => {
  const ctx = await requireAdminContext(c);
  if (isRouteFailure(ctx)) return ctx.response;
  const result = await syncLineFriendDirectory({
    db: ctx.db,
    admin: ctx.admin,
    channelId: c.env.LINE_CHANNEL_ID ?? "",
    token: c.env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN ?? "",
    // Bound every LINE followers/profile fetch so a stalled upstream cannot hang
    // the owner's admin sync request up to the Worker wall-clock limit.
    fetcher: withOutboundTimeout(fetch.bind(globalThis))
  });
  return respondAdminMutation(c, result, 200, { forbidden: 403, line_api_error: 502 });
});

adminApiRoutes.get("/line-friends", async (c) => {
  const ctx = await requireAdminContext(c);
  if (isRouteFailure(ctx)) return ctx.response;
  const filterParam = c.req.query("filter");
  const filter = filterParam === "linked" || filterParam === "all" ? filterParam : "unlinked";
  const pageParam = c.req.query("page");
  const result = await listLineFriends({
    db: ctx.db,
    admin: ctx.admin,
    channelId: c.env.LINE_CHANNEL_ID ?? "",
    filter,
    query: c.req.query("q") ?? undefined,
    page: pageParam ? Number.parseInt(pageParam, 10) : undefined
  });
  return respondAdminMutation(c, result, 200, { forbidden: 403, invalid_request: 400 });
});

adminApiRoutes.post("/line-friends/:lineUserId/link", async (c) => {
  const ctx = await requireAdminContext(c);
  if (isRouteFailure(ctx)) return ctx.response;
  const request = await parseAdminJsonBody(c, parseLinkLineFriendRequest);
  if (isRouteFailure(request)) return request.response;
  const result = await linkLineFriend({
    db: ctx.db,
    admin: ctx.admin,
    channelId: c.env.LINE_CHANNEL_ID ?? "",
    lineUserId: c.req.param("lineUserId"),
    request
  });
  return respondAdminMutation(c, result, 200, {
    forbidden: 403,
    invalid_request: 400,
    store_not_found: 404,
    customer_not_found: 404,
    friend_not_found: 404,
    friend_not_fetched: 409,
    customer_blocked: 409,
    already_linked: 409,
    write_failed: 500
  });
});

adminApiRoutes.put("/settings/google-edit-mode", async (c) => {
  const ctx = await requireAdminContext(c);
  if (isRouteFailure(ctx)) return ctx.response;
  const request = await parseAdminJsonBody(c, parseAdminGoogleEditModeUpdateRequest);
  if (isRouteFailure(request)) return request.response;
  const result = await updateAdminGoogleEditMode({
    db: ctx.db,
    admin: ctx.admin,
    request
  });
  return respondAdminMutation(c, result, 200, {
    forbidden: 403,
    invalid_request: 400,
    store_not_found: 404,
    missing_database: 500,
    write_failed: 500
  });
});

// Business hours
adminApiRoutes.get("/settings/business-hours/:storeId", async (c) => {
  const ctx = await requireAdminContext(c);
  if (isRouteFailure(ctx)) return ctx.response;
  const storeId = c.req.param("storeId");
  if (ctx.admin.role === "staff" && (!ctx.admin.store_id || ctx.admin.store_id !== storeId)) {
    return c.json(FORBIDDEN_BODY, 403, ADMIN_PRIVATE_HEADERS);
  }
  const result = await getBusinessHours(ctx.db, storeId);
  return result.ok
    ? c.json(result, 200, ADMIN_PRIVATE_HEADERS)
    : c.json({ ok: false, error: "query_failed" }, 400, ADMIN_PRIVATE_HEADERS);
});

adminApiRoutes.put("/settings/business-hours/:storeId", async (c) => {
  const ctx = await requireAdminContext(c);
  if (isRouteFailure(ctx)) return ctx.response;
  const storeId = c.req.param("storeId");
  const body = await c.req.json<{ hours: unknown }>().catch(() => null);
  if (!body) return c.json({ ok: false, error: "invalid_json" }, 400, ADMIN_PRIVATE_HEADERS);
  const result = await putBusinessHours({
    db: ctx.db,
    storeId,
    actor: ctx.admin,
    hours: body.hours as BusinessHourRow[]
  });
  if (!result.ok) {
    let status: 400 | 403 | 404 | 500 = 400;
    if (result.error === "forbidden") status = 403;
    else if (result.error === "store_not_found") status = 404;
    else if (result.error === "write_failed") status = 500;
    return c.json({ ok: false, error: result.error }, status, ADMIN_PRIVATE_HEADERS);
  }
  return c.json({ ok: true }, 200, ADMIN_PRIVATE_HEADERS);
});

// 14. GET /external-blocks

adminApiRoutes.get("/external-blocks", async (c) => {
  const gate = await authenticateAdminWithDb(c);
  if (!gate.ok) return gate.response;

  const result = await listAdminExternalBlocks({
    db: gate.db,
    admin: gate.admin
  });

  return c.json(result, 200, ADMIN_PRIVATE_HEADERS);
});

// 15. POST /external-blocks
adminApiRoutes.post("/external-blocks", async (c) => {
  const gate = await authenticateAdminWithDb(c);
  if (!gate.ok) return gate.response;
  const parsed = await parseJsonBody(c);
  if (!parsed.ok) return parsed.response;

  const request = parseAdminCreateExternalBlockRequest(parsed.body);
  if (!request) {
    return c.json({ ok: false, reason: "invalid_request" }, 400);
  }

  const result = await createAdminExternalBlock({
    db: gate.db,
    admin: gate.admin,
    request
  });

  if (result.ok) {
    scheduleQueueKicks(c, { google: true });
  }

  return c.json(result, statusForAdminExternalBlockResult(result));
});

// 16. POST /external-blocks/:id/cancel
adminApiRoutes.post("/external-blocks/:id/cancel", async (c) => {
  const gate = await authenticateAdminWithDb(c);
  if (!gate.ok) return gate.response;
  const parsed = await parseJsonBody(c);
  if (!parsed.ok) return parsed.response;

  const request = parseAdminIdempotentReasonRequest(parsed.body);
  const externalBlockId = c.req.param("id");
  if (!request || !externalBlockId) {
    return c.json({ ok: false, reason: "invalid_request" }, 400);
  }

  const result = await cancelAdminExternalBlock({
    db: gate.db,
    admin: gate.admin,
    externalBlockId,
    request
  });

  if (result.ok) {
    scheduleQueueKicks(c, { google: true });
  }

  return c.json(result, result.ok ? 200 : statusForAdminExternalBlockResult(result));
});

// 17. GET /settings — snapshot (staff gets allowlist)

adminApiRoutes.get("/settings", async (c) => {
  const gate = await authenticateAdminWithDb(c);
  if (!gate.ok) return gate.response;

  // Staff role gets an explicit allowlist of settings fields:
  // stores, resources, services, businessHours, closures. Using an
  // allowlist (not a denylist via destructure rest) ensures new fields
  // added to AdminSettingsSnapshot in future PRs do not silently leak
  // to staff. Staff data (roles, active status) is owner/system_admin
  // only per docs/admin-authz-matrix.md — privilege escalation risk.
  // Pass storeId into the snapshot so store_closures LIMIT applies after
  // store scope (issue #536) instead of truncating globally then filtering.
  if (gate.admin.role === "staff") {
    if (!staffHasStore(gate.admin)) return c.json(FORBIDDEN_BODY, 403, ADMIN_PRIVATE_HEADERS);
    const sid = gate.admin.store_id;
    const result = await getAdminSettingsSnapshot({
      db: gate.db,
      storeId: sid
    });
    const byStore = <T extends { storeId: string }>(arr: T[]): T[] =>
      sid ? arr.filter((item) => item.storeId === sid) : arr;
    return c.json({
      ok: true,
      settings: {
        stores: sid ? result.settings.stores.filter((s: { id: string }) => s.id === sid) : result.settings.stores,
        resources: byStore(result.settings.resources),
        services: byStore(result.settings.services),
        businessHours: sid ? result.settings.businessHours.filter((h: { storeId: string }) => h.storeId === sid) : result.settings.businessHours,
        closures: byStore(result.settings.closures)
      }
    }, 200, ADMIN_PRIVATE_HEADERS);
  }

  const result = await getAdminSettingsSnapshot({
    db: gate.db
  });
  return c.json(result, 200, ADMIN_PRIVATE_HEADERS);
});

// 18. GET /audit-logs

// Pure query-validation helpers for GET /audit-logs, extracted to keep the
// route handler's cognitive complexity in budget (SonarCloud S3776). Each
// returns `{ ok: false }` on an invalid parameter; the handler maps any
// failure to the same 400 invalid_filter response as before — no behavior
// change.

/** from/to must individually parse as strict ISO instants, and from < to. */
const parseAuditLogTimeRange = (
  from: string | undefined,
  to: string | undefined
): { ok: boolean } => {
  let fromMs: number | null = null;
  if (from !== undefined) {
    fromMs = parseStrictIsoOffsetInstantMs(from);
    if (fromMs === null) return { ok: false };
  }

  let toMs: number | null = null;
  if (to !== undefined) {
    toMs = parseStrictIsoOffsetInstantMs(to);
    if (toMs === null) return { ok: false };
  }

  if (fromMs !== null && toMs !== null && fromMs >= toMs) {
    return { ok: false };
  }
  return { ok: true };
};

/** limit, when present, must be a plain integer within 1..200. */
const parseAuditLogLimit = (
  limitRaw: string | undefined
): { ok: false } | { ok: true; limit: number | undefined } => {
  if (limitRaw === undefined) return { ok: true, limit: undefined };
  if (!/^\d+$/.test(limitRaw)) return { ok: false };
  const limit = Number.parseInt(limitRaw, 10);
  if (limit < 1 || limit > 200) return { ok: false };
  return { ok: true, limit };
};

/** keyword, when present, must fit the D1 LIKE byte budget once escaped. */
const parseAuditLogKeyword = (
  keyword: string | undefined
): { ok: false } | { ok: true; keyword: string | undefined } => {
  if (!keyword) return { ok: true, keyword: undefined };
  const pattern = `%${escapeLikePattern(keyword)}%`;
  if (exceedsLikePatternBudget(pattern)) {
    return { ok: false };
  }
  return { ok: true, keyword };
};

adminApiRoutes.get("/audit-logs", async (c) => {
  const gate = await authenticateAdminWithDb(c);
  if (!gate.ok) return gate.response;

  if (gate.admin.role === "staff") {
    return c.json(FORBIDDEN_BODY, 403, ADMIN_PRIVATE_HEADERS);
  }

  const from = c.req.query("from");
  const to = c.req.query("to");
  const actorTypeRaw = c.req.query("actorType");

  if (actorTypeRaw !== undefined && !(ADMIN_AUDIT_ACTOR_TYPES as readonly string[]).includes(actorTypeRaw)) {
    return c.json({ ok: false, reason: "invalid_filter" }, 400, ADMIN_PRIVATE_HEADERS);
  }
  const actorType = actorTypeRaw as AdminAuditActorType | undefined;

  const range = parseAuditLogTimeRange(from, to);
  const limitParse = parseAuditLogLimit(c.req.query("limit"));
  const keywordParse = parseAuditLogKeyword(c.req.query("keyword"));
  if (!range.ok || !limitParse.ok || !keywordParse.ok) {
    return c.json({ ok: false, reason: "invalid_filter" }, 400, ADMIN_PRIVATE_HEADERS);
  }

  const result = await listAdminAuditLogs({
    db: gate.db,
    admin: gate.admin,
    filter: {
      createdAtFrom: from || undefined,
      createdAtToExclusive: to || undefined,
      actorType,
      keyword: keywordParse.keyword,
      limit: limitParse.limit,
    },
  });

  return c.json(result, result.ok ? 200 : 403, ADMIN_PRIVATE_HEADERS);
});

// 19-21. Change requests — キャンセル申請機能は 2026-08-01 に全廃 (reschedule は
// 2026-07-24 廃止済み)。旧 /change-requests 系ルートは未登録となり 404。
// 歴史データ (reservation_change_requests) は保持し、audit 表示互換のみ残す。

// 22-25. Sync status and jobs

// 22. GET /sync/status
adminApiRoutes.get("/sync/status", async (c) => {
  const gate = await authenticateAdminWithDb(c);
  if (!gate.ok) return gate.response;

  const result = await getAdminSyncStatus({
    db: gate.db,
    admin: gate.admin
  });

  return c.json(result, 200, ADMIN_PRIVATE_HEADERS);
});

// 23. POST /sync/jobs/retry
adminApiRoutes.post("/sync/jobs/retry", async (c) => {
  const gate = await authenticateAdminWithDb(c, ADMIN_PRIVATE_HEADERS);
  if (!gate.ok) return gate.response;
  const parsed = await parseJsonBody(c, ADMIN_PRIVATE_HEADERS);
  if (!parsed.ok) return parsed.response;

  const request = parseAdminSyncJobRetryRequest(parsed.body);
  if (!request) {
    return c.json({ ok: false, reason: "invalid_request" }, 400, ADMIN_PRIVATE_HEADERS);
  }

  const result = await retryAdminSyncJob({
    db: gate.db,
    admin: gate.admin,
    request
  });

  if (result.ok) {
    scheduleQueueKicks(c, {
      google: result.source === "google_calendar_import_jobs" || result.source === "calendar_sync_jobs",
      line: result.source === "notification_jobs"
    });
  }

  return c.json(result, statusForAdminProtectedWorkflowResult(result), ADMIN_PRIVATE_HEADERS);
});

// 24. POST /sync/jobs/acknowledge
adminApiRoutes.post("/sync/jobs/acknowledge", async (c) => {
  const gate = await authenticateAdminWithDb(c, ADMIN_PRIVATE_HEADERS);
  if (!gate.ok) return gate.response;
  const parsed = await parseJsonBody(c, ADMIN_PRIVATE_HEADERS);
  if (!parsed.ok) return parsed.response;

  const request = parseAdminSyncJobAcknowledgeRequest(parsed.body);
  if (!request) {
    return c.json({ ok: false, reason: "invalid_request" }, 400, ADMIN_PRIVATE_HEADERS);
  }

  const result = await acknowledgeAdminSyncJob({
    db: gate.db,
    admin: gate.admin,
    request
  });

  return c.json(result, statusForAdminProtectedWorkflowResult(result), ADMIN_PRIVATE_HEADERS);
});

// 25-26. POST /sync/conflicts/:id/ignore, /sync/conflicts/:id/manual-resolve
const handleConflictResolution = async (c: Context<AppEnvironment>, resolutionStatus: "ignored" | "manual_resolved") => {
  const gate = await authenticateAdminWithDb(c, ADMIN_PRIVATE_HEADERS);
  if (!gate.ok) return gate.response;
  const parsed = await parseJsonBody(c, ADMIN_PRIVATE_HEADERS);
  if (!parsed.ok) return parsed.response;

  const request = parseAdminSyncConflictResolutionRequest(parsed.body);
  const conflictId = c.req.param("id");
  if (!request || !conflictId) {
    return c.json({ ok: false, reason: "invalid_request" }, 400, ADMIN_PRIVATE_HEADERS);
  }

  const result = await resolveAdminGoogleConflict({
    db: gate.db,
    admin: gate.admin,
    conflictId,
    resolutionStatus,
    request
  });

  return c.json(result, statusForAdminProtectedWorkflowResult(result), ADMIN_PRIVATE_HEADERS);
};
adminApiRoutes.post("/sync/conflicts/:id/ignore", (c) => handleConflictResolution(c, "ignored"));
adminApiRoutes.post("/sync/conflicts/:id/manual-resolve", (c) => handleConflictResolution(c, "manual_resolved"));

// 26-29. All-day candidates and conflict approval/rejection

// 26. POST /sync/all-day-candidates/:conflictId/approve
adminApiRoutes.post("/sync/all-day-candidates/:conflictId/approve", async (c) => {
  const guard = await guardConflictAction(c);
  if (!guard.ok) return guard.response;
  const { admin, db, body, idempotencyKey, conflictId } = guard.ctx;

  const closureScope = isObject(body.closureScope)
    ? { reason: getString(body.closureScope, "reason", 500) ?? undefined }
    : undefined;

  const request: AllDayApproveRequest = {
    idempotencyKey,
    ...(closureScope ? { closureScope } : {})
  };

  const result = await approveAllDayAsClosure({ db, admin, conflictId, request });
  return c.json(result, statusForAllDayResult(result), ADMIN_PRIVATE_HEADERS);
});

// 27. POST /sync/all-day-candidates/:conflictId/reject
adminApiRoutes.post("/sync/all-day-candidates/:conflictId/reject", async (c) => {
  const guard = await guardConflictAction(c);
  if (!guard.ok) return guard.response;
  const { admin, db, body, idempotencyKey, conflictId } = guard.ctx;

  const reason = getString(body, "reason", 500);
  const request: AllDayRejectRequest = {
    idempotencyKey,
    ...(reason === undefined ? {} : { reason })
  };

  const result = await rejectAllDayConflict({ db, admin, conflictId, request });
  return c.json(result, statusForAllDayResult(result), ADMIN_PRIVATE_HEADERS);
});

// 28. POST /sync/conflicts/:conflictId/approve-cancel
adminApiRoutes.post("/sync/conflicts/:conflictId/approve-cancel", async (c) => {
  const guard = await guardConflictAction(c);
  if (!guard.ok) return guard.response;
  const { admin, db, body, idempotencyKey, conflictId } = guard.ctx;

  const reason = getString(body, "reason", 500) ?? null;
  const result = await approveReservationDeleteAsCancel({
    db,
    admin,
    conflictId,
    request: { idempotencyKey, reason }
  });
  return c.json(result, statusForCancelApprovalResult(result), ADMIN_PRIVATE_HEADERS);
});

// 29. POST /sync/conflicts/:conflictId/reject-delete
adminApiRoutes.post("/sync/conflicts/:conflictId/reject-delete", async (c) => {
  const guard = await guardConflictAction(c);
  if (!guard.ok) return guard.response;
  const { admin, db, body, idempotencyKey, conflictId } = guard.ctx;

  const reason = getString(body, "reason", 500) ?? null;
  const result = await rejectReservationDeleteConflict({
    db,
    admin,
    conflictId,
    request: { idempotencyKey, reason }
  });
  return c.json(result, statusForCancelApprovalResult(result), ADMIN_PRIVATE_HEADERS);
});

// 30-31. Recurring

// 30. POST /recurring/preview — RRULE expansion (no DB write)
adminApiRoutes.post("/recurring/preview", async (c) => {
  // Auth error intentionally omits ADMIN_PRIVATE_HEADERS (original behavior).
  const authGate = await authenticateAdminRoute(c);
  if (!authGate.ok) return authGate.response;
  if (authGate.admin.role === "staff") {
    return c.json(
      { ok: false, reason: "forbidden" } as const,
      403,
      ADMIN_PRIVATE_HEADERS
    );
  }

  const parsed = await parseJsonBody(c, ADMIN_PRIVATE_HEADERS);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  if (!isObject(body)) {
    return c.json(
      { ok: false, reason: "invalid_request" } as const,
      400,
      ADMIN_PRIVATE_HEADERS
    );
  }
  const rrule = typeof body.rrule === "string" ? body.rrule.slice(0, 1024) : null;
  const dtstartIso = typeof body.dtstart === "string" ? body.dtstart : null;
  const windowEndIso = typeof body.windowEnd === "string" ? body.windowEnd : null;
  if (rrule === null || dtstartIso === null || windowEndIso === null) {
    return c.json(
      { ok: false, reason: "invalid_request" } as const,
      400,
      ADMIN_PRIVATE_HEADERS
    );
  }
  const dtstartMs = parseStrictIsoInstantMs(dtstartIso);
  const windowEndMs = parseStrictIsoInstantMs(windowEndIso);
  if (dtstartMs === null || windowEndMs === null) {
    return c.json(
      { ok: false, reason: "invalid_request" } as const,
      400,
      ADMIN_PRIVATE_HEADERS
    );
  }
  // Align with commitAdminRecurring and SSR form: anchor the 90-day cap
  // at max(dtstart, now) so old-DTSTART RRULEs produce the same
  // occurrences as the commit endpoint. Date.now() is used directly —
  // tests control it via vi.useFakeTimers() + vi.setSystemTime().
  const nowMs = Date.now();
  const windowAnchorMs = Math.max(dtstartMs, nowMs);
  const cappedWindowEndMs = Math.min(windowEndMs, windowAnchorMs + RRULE_PREVIEW_MAX_WINDOW_MS);

  const result = expandRrule({
    rrule,
    dtstartMs,
    windowEndMs: cappedWindowEndMs,
    maxOccurrences: 200,
    // Wizard BYDAY / BYMONTHDAY are JST wall-calendar; dtstart is a UTC
    // instant of a JST local time. Expand against the JST calendar.
    localOffsetMs: JST_OFFSET_MS
  });

  if (!result.ok) {
    return c.json(result, 400, ADMIN_PRIVATE_HEADERS);
  }

  return c.json(
    {
      ok: true as const,
      occurrences: result.occurrences.map((d) => d.toISOString()),
      truncatedByWindow: result.truncatedByWindow,
      truncatedByCap: result.truncatedByCap,
      windowCapped: cappedWindowEndMs < windowEndMs
    },
    200,
    ADMIN_PRIVATE_HEADERS
  );
});

// 31. POST /recurring/commit — materialise RRULE into external_blocks
adminApiRoutes.post("/recurring/commit", async (c) => {
  const ctx = await requireAdminContext(c);
  if (isRouteFailure(ctx)) return ctx.response;
  const parsed = await parseAdminJsonBody(c, parseAdminRecurringCommitRequest);
  if (isRouteFailure(parsed)) return parsed.response;
  const result = await commitAdminRecurring({ db: ctx.db, admin: ctx.admin, request: parsed });
  if (result.ok) {
    // Kick the Google queue on every successful result — not just
    // createdCount > 0. A resumed replay can have createdCount=0 +
    // replayedCount>0 because the crashed first attempt already wrote
    // the external_blocks (and their calendar_sync_jobs) but never
    // reached its own kick. Without the kick on replay those jobs sit
    // until cron picks them up.
    scheduleQueueKicks(c, { google: true });
    return c.json(result, 200, ADMIN_PRIVATE_HEADERS);
  }
  return c.json(result, RECURRING_COMMIT_STATUS_BY_ERROR[result.error], ADMIN_PRIVATE_HEADERS);
});

// 32-37. Reservation actions

// 32. POST /reservations/:id/approve
adminApiRoutes.post("/reservations/:id/approve", (c) => {
  return runReservationActionRoute(c, "approve");
});

// 33. POST /reservations/:id/reschedule (direct, not via action helper)
adminApiRoutes.post("/reservations/:id/reschedule", async (c) => {
  // Intentionally omits ADMIN_PRIVATE_HEADERS on error responses (original behavior).
  const gate = await authenticateAdminWithDb(c);
  if (!gate.ok) return gate.response;
  const parsed = await parseJsonBody(c);
  if (!parsed.ok) return parsed.response;

  const request = parseAdminRescheduleReservationRequest(parsed.body);
  const reservationId = c.req.param("id");
  if (!request || !reservationId) {
    return c.json({ ok: false, reason: "invalid_request" }, 400);
  }

  const result = await rescheduleAdminReservation({
    db: gate.db,
    admin: gate.admin,
    reservationId,
    request
  });

  if (result.ok) {
    scheduleQueueKicks(c, { google: true, line: true });
  }

  return c.json(result, statusForAdminRescheduleReservationResult(result));
});

// D1 の一過性障害は operator が再実行できる 503、それ以外は従来どおり 500。
// export ロックと internal error の観測上の区別は result.reason に残す。
const AUTO_COMPLETE_RETRYABLE_REASONS = new Set(["d1_export_locked", "transient_d1"]);

// 33b. POST /reservations/auto-complete-overdue — owner-only one-shot backfill.
// Completes every past confirmed reservation NOW (graceMs=0) by reusing the exact
// sweep the daily-cleanup cron runs on a 2-day delay: same side effects as the
// manual "完了" action (customer_visits row, slot-lock release, pending change-request
// closure, audit log) with NO customer LINE notification and the Google Calendar
// event kept. Idempotent — already-completed rows leave the 'confirmed' set, so a
// re-run is a no-op. Registered as a distinct single-segment POST path, so it is not
// shadowed by the GET /reservations/:id detail route. Goes through the global admin
// CSRF/Sec-Fetch-Site guard via authenticateAdminWithDb.
adminApiRoutes.post("/reservations/auto-complete-overdue", async (c) => {
  const gate = await authenticateAdminWithDb(c, ADMIN_PRIVATE_HEADERS);
  if (!gate.ok) return gate.response;
  const ownerDenied = requireOwnerWithDb(c, gate);
  if (ownerDenied) return ownerDenied;

  // Bounded single batch (drain:false), NOT a full drain: the historical backlog can
  // be large and this runs synchronously inside one Workers request — an unbounded
  // drain could exceed the subrequest/time budget. The caller re-invokes until
  // completedCount is 0 (idempotent). A backlog of ≤200 clears in one call. Bounding
  // also caps the request-path pending-expiration sweep that every
  // /api/admin/reservations/* request triggers.
  const result = await autoCompleteReservations({
    db: gate.db,
    admin: gate.admin,
    graceMs: 0,
    drain: false,
    maxReservations: 200
  });
  if (result.ok) {
    return c.json(result, 200, ADMIN_PRIVATE_HEADERS);
  }
  // retryable D1 障害は hard 500 と区別し、operator が再実行できる 503 にする。
  if (result.reason === "forbidden") return c.json(result, 403, ADMIN_PRIVATE_HEADERS);
  const status = AUTO_COMPLETE_RETRYABLE_REASONS.has(result.reason) ? 503 : 500;
  return c.json(result, status, ADMIN_PRIVATE_HEADERS);
});

// 34-37b. POST /reservations/:id/{action}
for (const action of ["reject", "cancel", "complete", "no-show", "correct-no-show"] as const) {
  adminApiRoutes.post(`/reservations/:id/${action}`, (c) =>
    runReservationActionRoute(c, action)
  );
}

// 37b-2. 完了への復元は owner+ 限定。来店なしへの訂正は上の自店舗staff経路を使う。
adminApiRoutes.post("/reservations/:id/restore-completed", (c) =>
  runReservationActionRoute(c, "restore-completed", { ownerOnly: true })
);

// 37c. PUT /reservations/:id/cancellation-fee — set/clear the "キャンセル料未納"
// (cancellation fee unpaid) flag. The flag is set automatically on no_show; this
// endpoint clears it once the fee is collected (unpaid:false) or sets it manually
// (unpaid:true). It is an annotation, not a state transition, so it does NOT bump
// the reservation version. Setting is idempotent (COALESCE keeps the original
// timestamp). Goes through the global admin CSRF/Sec-Fetch-Site guard.
//
// Authorization: owner / system_admin on any store; a staff member ONLY on their
// own store's reservation. This mirrors the no_show action that sets the flag in
// the first place (src/admin/reservations.ts — store-scoped, not owner-gated), so
// the staff member who marked the no-show can also record the payment. Staff with
// no store binding fail closed on the store comparison below.
//
// Scope guard: a manual SET (unpaid:true) is only allowed on a reservation whose
// status is 'no_show' — the feature is no-show-only and the UI only exposes the
// set action for no_show, so the API must not let a fee badge be attached to
// pending/confirmed/completed/cancelled reservations. CLEAR (unpaid:false) is
// allowed on any status so an existing flag can always be removed.
//
// Timestamp: bind an application-generated ISO-8601 value (matching the no_show
// transition's nowIso) rather than SQLite CURRENT_TIMESTAMP, so this column has a
// single consistent format regardless of which path wrote it.
const prepareCancellationFeeTarget = async (
  c: Context<AppEnvironment>, db: D1Database, admin: AdminUser, reservationId: string
) => {
  const reservation = await db
    .prepare("SELECT status, store_id FROM reservations WHERE id = ?")
    .bind(reservationId)
    .first<{ status: string; store_id: string }>();
  if (!reservation) {
    return { ok: false as const, response: c.json({ ok: false, reason: "not_found" }, 404, ADMIN_PRIVATE_HEADERS) };
  }
  // Store scope before the status gate: a staff member of another store must be
  // rejected identically whatever the reservation's status is.
  //
  // Written as an allowlist (owner / system_admin pass, everyone else must match
  // the store) rather than `role === "staff" && ...`, so an unexpected role — a
  // future one, or an inconsistent admin_users row — fails closed instead of
  // silently getting every store. Staff with no store binding get null !== store_id
  // and are rejected too.
  if (!isAdminPrivileged(admin.role) && admin.store_id !== reservation.store_id) {
    return { ok: false as const, response: c.json(FORBIDDEN_BODY, 403, ADMIN_PRIVATE_HEADERS) };
  }
  return { ok: true as const, status: reservation.status };
};

adminApiRoutes.put("/reservations/:id/cancellation-fee", async (c) => {
  const gate = await authenticateAdminWithDb(c, ADMIN_PRIVATE_HEADERS);
  if (!gate.ok) return gate.response;
  const parsed = await parseJsonObjectBody(c);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body as { unpaid?: unknown };

  const reservationId = c.req.param("id");
  if (!reservationId) {
    return c.json({ ok: false, reason: "invalid_request" }, 400, ADMIN_PRIVATE_HEADERS);
  }
  if (typeof body.unpaid !== "boolean") {
    return c.json({ ok: false, reason: "invalid_request" }, 400, ADMIN_PRIVATE_HEADERS);
  }

  const target = await prepareCancellationFeeTarget(c, gate.db, gate.admin, reservationId);
  if (!target.ok) return target.response;
  if (body.unpaid && target.status !== "no_show") {
    return c.json({ ok: false, reason: "not_no_show" }, 409, ADMIN_PRIVATE_HEADERS);
  }

  const nowIso = new Date().toISOString();
  const auditId = crypto.randomUUID();
  let batchResults: D1Result[];
  try {
    batchResults = await gate.db.batch([
      adminWriteGuard(gate.db, gate.admin),
      gate.db
        .prepare(
          // 未納を立てる側は WHERE にも status を書く。事前 SELECT からこの UPDATE の
          // 間に「完了に戻す」訂正が成功すると、完了済みの予約へ未納を書き戻せてしまう
          // (未納一覧は status を絞らない)。クリア側は全状態で許可したままにする。
          `UPDATE reservations
           SET cancellation_fee_unpaid_at = CASE WHEN ? = 1 THEN COALESCE(cancellation_fee_unpaid_at, ?) ELSE NULL END,
               updated_at = ?
           WHERE id = ? AND (? = 0 OR status = 'no_show')
             AND (? IN ('owner', 'system_admin') OR store_id = ?)`
        )
        .bind(Number(body.unpaid), nowIso, nowIso, reservationId, Number(body.unpaid), gate.admin.role, gate.admin.store_id),
      gate.db
        .prepare(
          `INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, metadata_json)
           SELECT ?, 'staff', ?, 'reservation.cancellation_fee_update', 'reservation', ?, ?
           WHERE changes() = 1`
        )
        .bind(auditId, gate.admin.id, reservationId, JSON.stringify({ unpaid: body.unpaid }))
    ]);
  } catch (error) {
    // A thrown D1 batch must surface as the structured write_failed contract the
    // rest of admin-api uses, not an unstructured 500 from the global handler.
    // Catching here would otherwise rob Sentry of the signal, so capture explicitly.
    if (await adminWriteWasRevoked(gate.db, gate.admin, error)) {
      return c.json(FORBIDDEN_BODY, 403, ADMIN_PRIVATE_HEADERS);
    }
    safeCaptureException(error, {
      tags: { admin_route: "cancellation_fee_update" },
      contexts: { d1_query: { reservation_id: reservationId } }
    });
    return c.json({ ok: false, reason: "write_failed" }, 500, ADMIN_PRIVATE_HEADERS);
  }

  // A skipped write has no audit. Recheck only to classify target loss/store
  // movement before the existing no_show conflict; this never authorizes a write.
  if (Number(batchResults[1]?.meta?.changes ?? 0) !== 1) {
    const current = await prepareCancellationFeeTarget(c, gate.db, gate.admin, reservationId);
    if (!current.ok) return current.response;
    return c.json({ ok: false, reason: "not_no_show" }, 409, ADMIN_PRIVATE_HEADERS);
  }

  return c.json({ ok: true }, 200, ADMIN_PRIVATE_HEADERS);
});

// 38-39. Staging-only endpoints

// 38. POST /staging/drift-sweep
adminApiRoutes.post("/staging/drift-sweep", (c) => {
  return driftSweepHandler(c);
});

// 39. POST /staging/sentry-test
adminApiRoutes.post("/staging/sentry-test", (c) => {
  return sentryTestHandler(c);
});
