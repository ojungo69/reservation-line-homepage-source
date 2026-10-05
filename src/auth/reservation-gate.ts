import { verifyLineAccessTokenUser, verifyLineFriendship, verifyLineIdToken } from "./line";
import { verifyTurnstileToken } from "./turnstile";
import { getUpcomingReservations, type UpcomingReservation } from "../reservations/public-submit";
import { sha256Hex } from "../crypto-utils";
import { safeCaptureException } from "../sentry-helpers";

import type { WorkerBindings } from "../bindings";

export type ReservationGateRequest = {
  stage: "form" | "submit";
  idToken: string;
  nonce?: string;
  lineAccessToken: string;
  turnstileToken?: string;
  remoteIp?: string;
};

// Masked contact summary returned to a LINE-recognized existing customer on the
// form stage so the booking page can pre-fill / skip the name+phone inputs.
// Only the verified caller's OWN record is ever returned, and the phone is masked
// to its last 4 digits — the full phone_normalized / phone_hash never leave the server.
export type ReservationFormCustomer = {
  displayName: string;
  displayNameKana: string | null;
  phoneMasked: string | null;
};

export type ReservationGateResult =
  | {
      allowed: true;
      lineUserId: string;
      stage: "form" | "submit";
      customer?: ReservationFormCustomer;
      // The verified customer's active future reservations (form stage only). Lets the
      // booking page warn a recognized customer that a NEW booking does not replace an
      // existing one. The customer_id itself is NOT exposed — only the display fields.
      upcomingReservations?: UpcomingReservation[];
    }
  | {
      allowed: false;
      reason:
        | "invalid_stage"
        | "missing_turnstile_token"
        | "turnstile_failed"
        | "line_id_token_failed"
        | "line_user_mismatch"
        | "line_friendship_failed"
        | "line_not_friend"
        | "rate_limited"
        | "customer_blocked"
        | "customer_lookup_failed";
    };

export type CustomerBlockResult =
  | {
      ok: true;
      blocked: boolean;
    }
  | {
      ok: false;
      reason: "customer_lookup_failed";
    };

export type RateLimitResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      reason: "rate_limited";
    };

const RESERVATION_GATE_RATE_LIMIT_LIMIT = 30;
const RESERVATION_GATE_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
export async function hashRateLimitKey(action: string, rawKey: string): Promise<string> {
  return sha256Hex(`${action}:${rawKey}`);
}

export async function enforceRateLimit(
  db: D1Database,
  action: string,
  rawKey: string,
  now: () => number = Date.now,
  limit = RESERVATION_GATE_RATE_LIMIT_LIMIT,
  windowMs = RESERVATION_GATE_RATE_LIMIT_WINDOW_MS,
  // Behavior when the rate-limit store itself errors (D1 down, or the weekly
  // backup-verify export-lock window where every D1 write is rejected). Customer
  // paths fail CLOSED — an attacker must not bypass the limit by inducing errors.
  // Already-authenticated admin mutations pass `failOpen: true`: a stolen-cookie
  // throttle must never lock a real owner out of the dashboard during a transient
  // D1 blip, and the mutation's own write would fail downstream anyway if D1 were
  // truly unavailable.
  failOpen = false
): Promise<RateLimitResult> {
  try {
    const occurredAtMs = now();
    const occurredAt = new Date(occurredAtMs).toISOString();
    const windowStart = new Date(occurredAtMs - windowMs).toISOString();
    const hashedKey = await hashRateLimitKey(action, rawKey);

    const insert = await db
      .prepare(
        `
          INSERT INTO rate_limit_events (id, action, rate_limit_key, occurred_at, metadata_json)
          SELECT ?, ?, ?, ?, NULL
          WHERE (
            SELECT COUNT(*)
            FROM rate_limit_events
            WHERE action = ?
              AND rate_limit_key = ?
              AND occurred_at >= ?
          ) < ?
        `
      )
      .bind(crypto.randomUUID(), action, hashedKey, occurredAt, action, hashedKey, windowStart, limit)
      .run();

    if (Number(insert.meta?.changes ?? 0) !== 1) {
      return {
        ok: false,
        reason: "rate_limited"
      };
    }

    return {
      ok: true
    };
  } catch (error) {
    // failOpen silently disables the limiter, failClosed silently throttles real
    // customers — either way the underlying store failure needs telemetry.
    // captureTransientD1: the weekly D1 export lock lands here as a customer-visible
    // rate_limited rejection, so the transient-suppression must not hide it.
    safeCaptureException(error instanceof Error ? error : new Error(String(error)), {
      tags: {
        component: "reservation-gate",
        op: "rate_limit_check_failed",
        helper: "enforceRateLimit"
      },
      captureTransientD1: true
    });
    return failOpen ? { ok: true } : { ok: false, reason: "rate_limited" };
  }
}

export async function checkCustomerBlocked(
  db: D1Database,
  lineChannelId: string,
  lineUserId: string
): Promise<CustomerBlockResult> {
  try {
    const row = await db
      .prepare(
        `
          SELECT
            CASE
              WHEN customers.block_status = 'blocked' OR customers.archived_at IS NOT NULL
              THEN 1 ELSE 0
            END AS is_blocked
          FROM line_identities
          JOIN customers ON customers.id = line_identities.customer_id
          WHERE line_identities.provider = 'line'
            AND line_identities.channel_id = ?
            AND line_identities.line_user_id = ?
          LIMIT 1
        `
      )
      .bind(lineChannelId, lineUserId)
      .first<{ is_blocked: number }>();

    return {
      ok: true,
      blocked: row?.is_blocked === 1
    };
  } catch (error) {
    // Fail-closed: this lookup failing blocks every reservation/login for the
    // customer, so a silent catch turns a D1 outage into an invisible full stop.
    // captureTransientD1: the weekly D1 export lock also lands here as a
    // customer-visible denial, so the transient-suppression must not hide it.
    safeCaptureException(error instanceof Error ? error : new Error(String(error)), {
      tags: {
        component: "reservation-gate",
        op: "customer_blocked_lookup_failed",
        helper: "checkCustomerBlocked"
      },
      captureTransientD1: true
    });
    return {
      ok: false,
      reason: "customer_lookup_failed"
    };
  }
}

const maskPhoneTail = (phoneNormalized: string | null): string | null => {
  if (!phoneNormalized) {
    return null;
  }
  const digits = phoneNormalized.replace(/\D/g, "");
  return digits.length < 4 ? "****" : `****${digits.slice(-4)}`;
};

// Look up the verified LINE customer's on-file contact for form pre-fill.
// Keyed on the verified line_user_id only (never a phone_hash) so a caller can
// only see their own record. Blocked customers are excluded (defense in depth;
// they are already rejected earlier by verifyCustomerCanReserve). DB errors
// fail open to null — booking proceeds without pre-fill rather than breaking.
// Resolves both the masked contact (for pre-fill) and the internal customer_id (used
// server-side to look up the customer's existing reservations for the duplicate-warning).
// The customer_id never leaves this module — only the masked ReservationFormCustomer and
// the resulting upcomingReservations are returned to the client.
const getReservationFormCustomer = async (
  db: D1Database,
  lineChannelId: string,
  lineUserId: string
): Promise<{ customer: ReservationFormCustomer; customerId: string } | null> => {
  try {
    const row = await db
      .prepare(
        `
          SELECT
            customers.id AS customer_id,
            customers.display_name,
            customers.display_name_kana,
            customers.phone_normalized
          FROM line_identities
          JOIN customers ON customers.id = line_identities.customer_id
          WHERE line_identities.provider = 'line'
            AND line_identities.channel_id = ?
            AND line_identities.line_user_id = ?
            AND customers.block_status != 'blocked'
            AND customers.archived_at IS NULL
          LIMIT 1
        `
      )
      .bind(lineChannelId, lineUserId)
      .first<{
        customer_id: string;
        display_name: string;
        display_name_kana: string | null;
        phone_normalized: string | null;
      }>();
    if (!row) {
      return null;
    }
    return {
      customer: {
        displayName: row.display_name,
        displayNameKana: row.display_name_kana,
        phoneMasked: maskPhoneTail(row.phone_normalized)
      },
      customerId: row.customer_id
    };
  } catch {
    return null;
  }
};

const validateGateRequest = (input: {
  request: ReservationGateRequest;
  env: Partial<WorkerBindings>;
}): ReservationGateResult | undefined => {
  if (input.request.stage !== "form" && input.request.stage !== "submit") {
    return {
      allowed: false,
      reason: "invalid_stage"
    };
  }
  if (input.request.stage === "submit" && !input.request.turnstileToken) {
    return {
      allowed: false,
      reason: "missing_turnstile_token"
    };
  }
  if (!input.env.DB) {
    return {
      allowed: false,
      reason: "customer_lookup_failed"
    };
  }
  return undefined;
};

const verifySubmitTurnstile = async (
  request: ReservationGateRequest,
  env: Partial<WorkerBindings>,
  fetcher: typeof fetch
): Promise<ReservationGateResult | undefined> => {
  if (request.stage !== "submit") {
    return undefined;
  }

  const turnstile = await verifyTurnstileToken(
    {
      token: request.turnstileToken,
      secret: env.TURNSTILE_SECRET_KEY ?? "",
      remoteIp: request.remoteIp,
      idempotencyKey: crypto.randomUUID(),
      expectedHostname: env.TURNSTILE_EXPECTED_HOSTNAME,
      expectedAction: env.TURNSTILE_EXPECTED_ACTION
    },
    fetcher
  );

  return turnstile.ok
    ? undefined
    : {
        allowed: false,
        reason: "turnstile_failed"
      };
};

const verifyLineReservationAccess = async (
  request: ReservationGateRequest,
  env: Partial<WorkerBindings>,
  fetcher: typeof fetch,
  now: () => number
): Promise<
  | {
      ok: true;
      lineUserId: string;
    }
  | {
      ok: false;
      result: ReservationGateResult;
    }
> => {
  const lineResult = await verifyLineIdToken(
    {
      idToken: request.idToken,
      nonce: request.nonce,
      channelId: env.LINE_CHANNEL_ID ?? ""
    },
    fetcher,
    now
  );
  if (!lineResult.ok) {
    return {
      ok: false,
      result: {
        allowed: false,
        reason: "line_id_token_failed"
      }
    };
  }

  const accessTokenUser = await verifyLineAccessTokenUser(
    request.lineAccessToken,
    lineResult.payload.sub,
    fetcher
  );
  if (!accessTokenUser.ok) {
    return {
      ok: false,
      result: {
        allowed: false,
        reason: accessTokenUser.reason === "line_user_mismatch" ? "line_user_mismatch" : "line_friendship_failed"
      }
    };
  }

  const friendship = await verifyLineFriendship(request.lineAccessToken, fetcher);
  if (!friendship.ok) {
    return {
      ok: false,
      result: {
        allowed: false,
        reason: "line_friendship_failed"
      }
    };
  }
  if (!friendship.friendFlag) {
    return {
      ok: false,
      result: {
        allowed: false,
        reason: "line_not_friend"
      }
    };
  }

  return {
    ok: true,
    lineUserId: lineResult.payload.sub
  };
};

const verifyCustomerCanReserve = async (
  db: D1Database,
  lineChannelId: string,
  lineUserId: string
): Promise<ReservationGateResult | undefined> => {
  const customerBlock = await checkCustomerBlocked(db, lineChannelId, lineUserId);
  if (!customerBlock.ok) {
    return {
      allowed: false,
      reason: "customer_lookup_failed"
    };
  }
  if (customerBlock.blocked) {
    return {
      allowed: false,
      reason: "customer_blocked"
    };
  }
  return undefined;
};

// Resolve the form-stage extras (masked on-file contact + the customer's active future
// reservations) for a recognized customer. Kept out of evaluateReservationGate to hold
// that function's cognitive complexity down. The upcoming-reservations lookup fails open:
// a DB error must not break the booking form, since the submit path re-checks duplicates.
const resolveFormStageExtras = async (
  db: D1Database,
  lineChannelId: string,
  lineUserId: string,
  now: () => number
): Promise<{ customer?: ReservationFormCustomer; upcomingReservations?: UpcomingReservation[] }> => {
  const onFile = await getReservationFormCustomer(db, lineChannelId, lineUserId);
  if (!onFile) {
    return {};
  }
  try {
    const upcoming = await getUpcomingReservations(db, onFile.customerId, new Date(now()).toISOString());
    return upcoming.length > 0
      ? { customer: onFile.customer, upcomingReservations: upcoming }
      : { customer: onFile.customer };
  } catch {
    return { customer: onFile.customer };
  }
};

export async function evaluateReservationGate(input: {
  request: ReservationGateRequest;
  env: Partial<WorkerBindings>;
  fetcher?: typeof fetch;
  now?: () => number;
}): Promise<ReservationGateResult> {
  const fetcher = input.fetcher ?? fetch.bind(globalThis);
  const now = input.now ?? Date.now;

  const validationError = validateGateRequest(input);
  if (validationError) {
    return validationError;
  }

  const db = input.env.DB;
  if (!db) {
    return {
      allowed: false,
      reason: "customer_lookup_failed"
    };
  }
  // An absent client IP would collapse every IP-less request into ONE shared
  // rate-limit bucket (SHA256("reservation_gate:unknown")): a header-stripping
  // burst could exhaust it for everyone, or sporadic header loss could 429 a
  // legitimate user. CF-Connecting-IP is always set by the edge for real
  // ingress, so a missing IP here is anomalous — fail closed instead of sharing
  // a bucket (mirrors the if(!db) fail-closed above).
  const remoteIp = input.request.remoteIp;
  if (!remoteIp) {
    return {
      allowed: false,
      reason: "rate_limited"
    };
  }
  const rateLimit = await enforceRateLimit(db, "reservation_gate", remoteIp, now);
  if (!rateLimit.ok) {
    return {
      allowed: false,
      reason: "rate_limited"
    };
  }

  const turnstileError = await verifySubmitTurnstile(input.request, input.env, fetcher);
  if (turnstileError) {
    return turnstileError;
  }

  const lineAccess = await verifyLineReservationAccess(input.request, input.env, fetcher, now);
  if (!lineAccess.ok) {
    return lineAccess.result;
  }

  const customerError = await verifyCustomerCanReserve(db, input.env.LINE_CHANNEL_ID ?? "", lineAccess.lineUserId);
  if (customerError) {
    return customerError;
  }

  // Attach the masked on-file contact and the customer's existing reservations only on
  // the form stage so the booking page can pre-fill the name+phone inputs and warn a
  // recognized customer about active future reservations. The submit stage has no need
  // for either (the server reuses the record and re-checks duplicates directly).
  const extras =
    input.request.stage === "form"
      ? await resolveFormStageExtras(db, input.env.LINE_CHANNEL_ID ?? "", lineAccess.lineUserId, now)
      : {};

  return {
    allowed: true,
    lineUserId: lineAccess.lineUserId,
    stage: input.request.stage,
    ...(extras.customer ? { customer: extras.customer } : {}),
    ...(extras.upcomingReservations ? { upcomingReservations: extras.upcomingReservations } : {})
  };
}
