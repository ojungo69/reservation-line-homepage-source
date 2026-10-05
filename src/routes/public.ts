import { Hono } from "hono";
import type { AppEnvironment } from "./types";
import {
  PUBLIC_RESERVATION_HEADERS,
  isObject,
  getString,
  getStringArray,
  scheduleQueueKicks,
  statusForPublicReservationResult,
  statusForPublicAvailabilityResult
} from "./shared";
import { evaluateReservationGate, type ReservationGateRequest } from "../auth/reservation-gate";
import {
  verifyCustomerLineAuth,
  type CustomerLineAuthAction,
  type CustomerLineAuthFailure
} from "../auth/customer-line-auth";
import { listMyReservations } from "../reservations/my-reservations";
import {
  listPublicAvailability,
  listPublicReservationOptions
} from "../reservations/public-options";
import { createPublicReservation, type PublicReservationRequest } from "../reservations/public-submit";
import { MAX_SERVICE_SELECTIONS } from "../reservations/slot-times";
import { notifyAdminPush } from "../notifications/admin-push";

export const publicRoutes = new Hono<AppEnvironment>();

// Parsers (public routes only)

const parseServiceIdsQuery = (value: string | undefined) => {
  if (!value) {
    return undefined;
  }
  const items: string[] = [];
  const seen = new Set<string>();
  for (const item of value.split(",")) {
    const normalized = item.trim();
    if (!normalized || normalized.length > 128 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    items.push(normalized);
    if (items.length >= MAX_SERVICE_SELECTIONS) {
      break;
    }
  }
  return items.length > 0 ? items : undefined;
};

const parseReservationGateRequest = (
  body: unknown,
  remoteIp: string | undefined
): ReservationGateRequest | undefined => {
  if (!isObject(body)) {
    return undefined;
  }

  const stage = body.stage === "form" || body.stage === "submit" ? body.stage : undefined;
  const idToken = getString(body, "idToken", 8192);
  const lineAccessToken = getString(body, "lineAccessToken", 4096);
  const nonce = getString(body, "nonce", 256);
  const turnstileToken = getString(body, "turnstileToken", 2048);

  if (!stage || !idToken || !lineAccessToken) {
    return undefined;
  }

  return {
    stage,
    idToken,
    lineAccessToken,
    nonce,
    turnstileToken,
    remoteIp
  };
};

const parsePublicReservationSubmitRequest = (
  body: unknown,
  remoteIp: string | undefined
): { gate: ReservationGateRequest; reservation: PublicReservationRequest } | undefined => {
  if (!isObject(body) || !isObject(body.consents)) {
    return undefined;
  }
  // customer is optional: a LINE-recognized existing customer may omit it so the
  // server reuses their on-file record. But if customer IS present it must be an
  // object (reject null/string/number to keep the input boundary explicit).
  const hasCustomer = Object.hasOwn(body, "customer");
  if (hasCustomer && !isObject(body.customer)) {
    return undefined;
  }
  const customerObj = hasCustomer && isObject(body.customer) ? body.customer : undefined;

  const idToken = getString(body, "idToken", 8192);
  const nonce = getString(body, "nonce", 256);
  const lineAccessToken = getString(body, "lineAccessToken", 4096);
  const turnstileToken = getString(body, "turnstileToken", 2048);
  const idempotencyKey = getString(body, "idempotencyKey", 256);
  const storeId = getString(body, "storeId", 64);
  const serviceId = getString(body, "serviceId", 128);
  const serviceIds = getStringArray(body, "serviceIds", MAX_SERVICE_SELECTIONS, 128);
  const resourceId = getString(body, "resourceId", 128);
  const startAt = getString(body, "startAt", 64);
  const displayName = customerObj ? getString(customerObj, "displayName", 120) : undefined;
  const displayNameKana = customerObj ? getString(customerObj, "displayNameKana", 120) : undefined;
  const phone = customerObj ? getString(customerObj, "phone", 32) : undefined;
  const noticeVersion = getString(body.consents, "noticeVersion", 64);
  const cancellationPolicyVersion = getString(body.consents, "cancellationPolicyVersion", 64);
  const privacyPolicyVersion = getString(body.consents, "privacyPolicyVersion", 64);
  const minorGuardianVersion = getString(body.consents, "minorGuardianVersion", 64);
  // Optional: present only when the duplicate-reservation warning was shown. Not part
  // of the required-field guard below — the server independently decides whether the
  // acknowledgement is needed (and validates the version) on the submit path.
  const duplicateReservationWarningVersion = getString(body.consents, "duplicateReservationWarningVersion", 64);

  if (
    !idToken ||
    !lineAccessToken ||
    !turnstileToken ||
    !idempotencyKey ||
    !storeId ||
    !serviceId ||
    !resourceId ||
    !startAt ||
    !noticeVersion ||
    !cancellationPolicyVersion ||
    !privacyPolicyVersion
  ) {
    return undefined;
  }
  // When a customer object is supplied, it must carry a usable name + phone.
  if (customerObj && (!displayName || !phone)) {
    return undefined;
  }

  return {
    gate: {
      stage: "submit",
      idToken,
      nonce,
      lineAccessToken,
      turnstileToken,
      remoteIp
    },
    reservation: {
      idempotencyKey,
      storeId,
      serviceId,
      serviceIds,
      resourceId,
      startAt,
      ...(customerObj && displayName && phone
        ? { customer: { displayName, displayNameKana, phone } }
        : {}),
      consents: {
        noticeVersion,
        cancellationPolicyVersion,
        privacyPolicyVersion,
        minorGuardianVersion,
        // Omit entirely when absent so it stays out of the consents object (and the
        // idempotency hash) for bookings where no duplicate warning was shown.
        ...(duplicateReservationWarningVersion
          ? { duplicateReservationWarningVersion }
          : {})
      }
    }
  };
};

// Customer LIFF helpers

type CustomerLiffStatus = 400 | 401 | 403 | 404 | 409 | 429 | 500;
const customerLiffForbidden = (
  c: import("hono").Context,
  reason: string,
  status: CustomerLiffStatus = 403
) => c.json({ ok: false, reason }, status, PUBLIC_RESERVATION_HEADERS);

const passedSecFetchSiteGuard = (c: import("hono").Context): boolean => {
  const site = c.req.header("Sec-Fetch-Site");
  return site === "same-origin";
};

const customerLineAuthErrorStatus = (reason: CustomerLineAuthFailure): CustomerLiffStatus => {
  switch (reason) {
    case "rate_limited":
      return 429;
    case "customer_blocked":
      return 403;
    case "line_identity_not_found":
      return 404;
    default:
      return 401;
  }
};

const authenticateCustomerLiff = async (
  c: import("hono").Context,
  action: CustomerLineAuthAction,
  tokens: { idToken: string; lineAccessToken: string; nonce?: string }
) => {
  if (!c.env.DB) {
    return { error: customerLiffForbidden(c, "missing_database", 500) } as const;
  }
  const result = await verifyCustomerLineAuth(c.env.DB, c.env, {
    action,
    idToken: tokens.idToken,
    lineAccessToken: tokens.lineAccessToken,
    nonce: tokens.nonce,
    remoteIp: c.req.header("CF-Connecting-IP") ?? undefined
  });
  if (!result.ok) {
    return {
      error: customerLiffForbidden(c, result.reason, customerLineAuthErrorStatus(result.reason))
    } as const;
  }
  return { auth: result } as const;
};

// Sec-Fetch + LINE-header token gate for the authed customer GET route
// (my-reservations). Returns the auth context on success or a Response to
// return as-is on origin/token/auth failure.
const authenticateCustomerLiffFromHeaders = async (
  c: import("hono").Context,
  action: CustomerLineAuthAction
) => {
  if (!passedSecFetchSiteGuard(c)) {
    return { error: customerLiffForbidden(c, "origin_blocked") } as const;
  }
  const idToken = c.req.header("X-LINE-IdToken") ?? "";
  const lineAccessToken = c.req.header("X-LINE-AccessToken") ?? "";
  const nonce = c.req.header("X-LINE-Nonce") ?? undefined;
  if (!idToken || !lineAccessToken) {
    return { error: customerLiffForbidden(c, "missing_tokens", 401) } as const;
  }
  return authenticateCustomerLiff(c, action, { idToken, lineAccessToken, nonce });
};

// Routes

publicRoutes.get("/reservation-options", async (c) => {
  const result = await listPublicReservationOptions({
    db: c.env.DB,
    kv: c.env.CACHE,
    env: c.env
  });

  return c.json(result, result.ok ? 200 : 500, PUBLIC_RESERVATION_HEADERS);
});

publicRoutes.get("/availability", async (c) => {
  const result = await listPublicAvailability({
    db: c.env.DB,
    env: c.env,
    storeId: c.req.query("storeId"),
    serviceId: c.req.query("serviceId"),
    serviceIds: parseServiceIdsQuery(c.req.query("serviceIds")),
    resourceId: c.req.query("resourceId"),
    date: c.req.query("date")
  });

  return c.json(result, statusForPublicAvailabilityResult(result), PUBLIC_RESERVATION_HEADERS);
});

publicRoutes.post("/reservation-gate", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_request" }, 400);
  }

  const gateRequest = parseReservationGateRequest(
    body,
    c.req.header("CF-Connecting-IP") ?? undefined
  );
  if (!gateRequest) {
    return c.json({ error: "invalid_request" }, 400);
  }

  const result = await evaluateReservationGate({
    request: gateRequest,
    env: c.env
  });

  // The form-stage result may carry the recognized customer's masked contact (PII).
  // no-store is also applied globally for private paths; set it explicitly here too,
  // consistent with the sibling public reservation routes.
  return c.json(result, result.allowed ? 200 : 403, PUBLIC_RESERVATION_HEADERS);
});

publicRoutes.post("/reservations", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_request" }, 400);
  }

  const parsed = parsePublicReservationSubmitRequest(
    body,
    c.req.header("CF-Connecting-IP") ?? undefined
  );
  if (!parsed) {
    return c.json({ error: "invalid_request" }, 400);
  }

  const gate = await evaluateReservationGate({
    request: parsed.gate,
    env: c.env
  });
  if (!gate.allowed) {
    return c.json(
      {
        ok: false,
        reason: "auth_failed",
        authReason: gate.reason
      },
      403
    );
  }

  if (!c.env.DB) {
    return c.json({ ok: false, reason: "missing_database" }, 500);
  }

  const result = await createPublicReservation({
    db: c.env.DB,
    env: c.env,
    request: parsed.reservation,
    line: {
      lineUserId: gate.lineUserId,
      channelId: c.env.LINE_CHANNEL_ID ?? ""
    }
  });

  if (result.ok) {
    scheduleQueueKicks(c, { google: true, line: true });
    notifyAdminPush(c, { event: "reservation_created", reservationId: result.reservationId });
  }

  return c.json(result, statusForPublicReservationResult(result));
});

publicRoutes.get("/my-reservations", async (c) => {
  const auth = await authenticateCustomerLiffFromHeaders(c, "customer_reservations_read");
  if ("error" in auth) {
    return auth.error;
  }
  const db = c.env.DB;
  if (!db) {
    return customerLiffForbidden(c, "missing_database", 500);
  }
  const rows = await listMyReservations(db, {
    lineIdentityId: auth.auth.lineIdentityId,
    nowIso: new Date().toISOString()
  });
  return c.json(
    { ok: true, reservations: rows },
    200,
    PUBLIC_RESERVATION_HEADERS
  );
});

// キャンセル申請機能 (POST /change-requests, POST /change-requests/:id/withdraw,
// GET /reschedule-availability) は 2026-08-01 に全廃 — 変更・キャンセルは店舗連絡へ
// 一本化。未登録パスは app.notFound が 404 を返す。
