/**
 * Phase 3 customer LIFF authentication.
 *
 * Verifies a LINE ID token + access token combo without Turnstile, and
 * returns the server-resolved customer identity (line_identity_id +
 * customer_id) so the calling endpoint never trusts client-provided
 * customer IDs. This is intentionally NOT a wrapper around
 * evaluateReservationGate({ stage: "form" }) because Phase 3 needs:
 *   - a distinct rate-limit action so reservation-create and the customer
 *     reservation-list read do not share quota windows
 *   - the database row id of line_identities so subsequent queries can
 *     scope by line_identity_id (which is what reservations rows store)
 *   - no Turnstile dependency in the LIFF in-app flow
 *
 * Sec-Fetch-Site / Origin checks are not performed in this helper; they
 * live in the route handler so the helper stays reusable for tests that
 * cannot easily synthesize headers.
 */

import { verifyLineAccessTokenUser, verifyLineFriendship, verifyLineIdToken } from "./line";
import { checkCustomerBlocked, enforceRateLimit } from "./reservation-gate";

import type { WorkerBindings } from "../bindings";

export type CustomerLineAuthAction = "customer_reservations_read";

export type CustomerLineAuthRequest = {
  action: CustomerLineAuthAction;
  idToken: string;
  lineAccessToken: string;
  nonce?: string;
  remoteIp?: string;
};

export type CustomerLineAuthFailure =
  | "rate_limited"
  | "line_id_token_failed"
  | "line_user_mismatch"
  | "line_friendship_failed"
  | "line_not_friend"
  | "customer_blocked"
  | "customer_lookup_failed"
  | "line_identity_not_found";

export type CustomerLineAuthResult =
  | {
      ok: true;
      lineUserId: string;
      lineIdentityId: string;
      customerId: string;
      channelId: string;
    }
  | {
      ok: false;
      reason: CustomerLineAuthFailure;
    };

type LineIdentityLookupRow = {
  identity_id: string;
  customer_id: string;
};

const lookupLineIdentity = async (
  db: D1Database,
  channelId: string,
  lineUserId: string
): Promise<LineIdentityLookupRow | null> => {
  try {
    return await db
      .prepare(
        `
          SELECT
            line_identities.id          AS identity_id,
            line_identities.customer_id AS customer_id
          FROM line_identities
          WHERE line_identities.provider = 'line'
            AND line_identities.channel_id = ?
            AND line_identities.line_user_id = ?
          LIMIT 1
        `
      )
      .bind(channelId, lineUserId)
      .first<LineIdentityLookupRow>();
  } catch {
    return null;
  }
};

export async function verifyCustomerLineAuth(
  db: D1Database,
  env: Pick<WorkerBindings, "LINE_CHANNEL_ID">,
  request: CustomerLineAuthRequest,
  fetcher: typeof fetch = fetch.bind(globalThis),
  now: () => number = Date.now
): Promise<CustomerLineAuthResult> {
  const channelId = env.LINE_CHANNEL_ID ?? "";

  // See reservation-gate.ts: an absent client IP must fail closed, never collapse
  // into the shared SHA256("<action>:unknown") rate-limit bucket. CF-Connecting-IP
  // is always present for real ingress, so a missing IP here is anomalous.
  const remoteIp = request.remoteIp;
  if (!remoteIp) {
    return { ok: false, reason: "rate_limited" };
  }
  const rateLimit = await enforceRateLimit(db, request.action, remoteIp, now);
  if (!rateLimit.ok) {
    return { ok: false, reason: "rate_limited" };
  }

  const idToken = await verifyLineIdToken(
    {
      idToken: request.idToken,
      nonce: request.nonce,
      channelId
    },
    fetcher,
    now
  );
  if (!idToken.ok) {
    return { ok: false, reason: "line_id_token_failed" };
  }

  const accessTokenUser = await verifyLineAccessTokenUser(
    request.lineAccessToken,
    idToken.payload.sub,
    fetcher
  );
  if (!accessTokenUser.ok) {
    return {
      ok: false,
      reason:
        accessTokenUser.reason === "line_user_mismatch"
          ? "line_user_mismatch"
          : "line_friendship_failed"
    };
  }

  const friendship = await verifyLineFriendship(request.lineAccessToken, fetcher);
  if (!friendship.ok) {
    return { ok: false, reason: "line_friendship_failed" };
  }
  if (!friendship.friendFlag) {
    return { ok: false, reason: "line_not_friend" };
  }

  const blockStatus = await checkCustomerBlocked(db, channelId, idToken.payload.sub);
  if (!blockStatus.ok) {
    return { ok: false, reason: "customer_lookup_failed" };
  }
  if (blockStatus.blocked) {
    return { ok: false, reason: "customer_blocked" };
  }

  const identity = await lookupLineIdentity(db, channelId, idToken.payload.sub);
  if (!identity) {
    return { ok: false, reason: "line_identity_not_found" };
  }

  return {
    ok: true,
    lineUserId: idToken.payload.sub,
    lineIdentityId: identity.identity_id,
    customerId: identity.customer_id,
    channelId
  };
}
