import type { AdminUser } from "../admin/access";
import { adminWriteGuard, adminWriteWasRevoked, assertAdminWriteCurrent } from "../admin/write-authorization";
import type { Context } from "hono";
import { generateRequestDetails } from "web-push-neo";
import type { WorkerBindings } from "../bindings";
import type { AppEnvironment } from "../routes/types";
import { safeCaptureException } from "../sentry-helpers";
import { withOutboundTimeout } from "../outbound-timeout";
import { isPushServiceHost } from "../pii-normalize";

const formatDateTimeJa = (iso: string, timezone: string): string =>
  new Intl.DateTimeFormat("ja-JP", {
    timeZone: timezone,
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(new Date(iso));

/**
 * Web Push to the admin devices.
 *
 * Deliberately best-effort: every send is fired from `waitUntil` (or a cron
 * subtask) and a failure is swallowed after a Sentry capture. The approval queue
 * in the SPA, the owner's LINE/email notification and the reminder cron all
 * still work when a push is lost, so nothing here is allowed to fail a booking
 * or a cron run.
 *
 * The notification body carries the STORE and the APPOINTMENT TIME only. Push
 * payloads land on a lock screen that anyone holding the phone can read, and
 * they are decrypted by a device we do not control, so no customer name, phone
 * number, menu or note ever goes in. `test/admin-push.test.ts` locks that.
 */

export type AdminPushEvent = "reservation_created" | "approval_expiring";

type SubscriptionRow = {
  endpoint: string;
  admin_user_id: string;
  p256dh: string;
  auth: string;
};

export type AdminPushPayload = {
  title: string;
  body: string;
  url: string;
  tag: string;
};

/**
 * The endpoint arrives from the browser, so it is user-supplied input that this
 * Worker then fetches — the only such path in the app. Every real endpoint
 * belongs to one of the four push services in `isPushServiceHost`, so an
 * allow-list costs nothing and keeps a signed-in staff member from turning
 * "register my device" into "make the Worker POST to an arbitrary host".
 *
 * Returns the URL-normalized form so the `endpoint` PRIMARY KEY actually
 * de-duplicates a device: two spellings of the same endpoint would otherwise
 * become two rows and the upsert would never fire.
 */
export const normalizePushEndpoint = (endpoint: string): string | null => {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  // `https://evil@web.push.apple.com/x` passes a hostname check but is not a
  // URL fetch() will accept ("cannot be constructed from a URL that includes
  // credentials"), so it would only ever become a permanently undeliverable row.
  if (url.username || url.password) return null;
  if (!isPushServiceHost(url.hostname)) return null;
  // A fragment never leaves the client, so `…#a` and `…#b` are the same POST to
  // the same device — but two different PRIMARY KEY rows if kept.
  url.hash = "";
  return url.href;
};

const base64UrlToBytes = (value: string): ArrayBuffer => {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (char) => char.codePointAt(0) ?? 0).buffer;
};

/** Byte length of a base64url payload, or null when it is not base64url. */
const decodedByteLength = (value: string): number | null => {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null;
  try {
    return base64UrlToBytes(value).byteLength;
  } catch {
    return null;
  }
};

/**
 * Validate a subscription as the browser's PushSubscription.toJSON() shape.
 *
 * The key sizes are fixed by RFC 8291 — an uncompressed P-256 point is 65 bytes
 * and the auth secret is 16 — so they are checked after decoding rather than as
 * string lengths: a base64url character count admits values the encryption then
 * rejects at send time, where nobody sees the failure.
 */
export const parsePushSubscription = async (input: {
  endpoint: unknown;
  p256dh: unknown;
  auth: unknown;
}): Promise<{ endpoint: string; p256dh: string; auth: string } | null> => {
  if (typeof input.endpoint !== "string" || input.endpoint.length > 1024) return null;
  if (typeof input.p256dh !== "string" || typeof input.auth !== "string") return null;
  // Cheap bound before the decode: the exact byte sizes are checked below, and
  // these caps keep a megabyte of base64 from being expanded to find that out.
  if (input.p256dh.length > 88 || input.auth.length > 24) return null;
  const endpoint = normalizePushEndpoint(input.endpoint);
  if (!endpoint) return null;
  if (decodedByteLength(input.p256dh) !== 65) return null;
  if (decodedByteLength(input.auth) !== 16) return null;
  // 65 bytes is necessary but not sufficient: a value off the P-256 curve would
  // pass and then fail INSIDE the encryption on every send forever — never
  // reaching the 404/410 path that retires a dead row. Importing the key here is
  // the same check the encryption does, run once, where it can still 400.
  try {
    await crypto.subtle.importKey(
      "raw",
      base64UrlToBytes(input.p256dh),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      []
    );
  } catch {
    return null;
  }
  return { endpoint, p256dh: input.p256dh, auth: input.auth };
};

const EVENT_TITLE: Readonly<Record<AdminPushEvent, string>> = {
  reservation_created: "新しいご予約の申込",
  approval_expiring: "承認期限が近づいています",
};

// Deep links are relative on purpose: an absolute URL opens a fresh Safari tab
// instead of the home-screen web app on iOS.
const EVENT_URL: Readonly<Record<AdminPushEvent, string>> = {
  reservation_created: "/admin/reservations",
  approval_expiring: "/admin/reservations",
};

export const buildAdminPushPayload = (input: {
  event: AdminPushEvent;
  reservationId: string;
  storeName: string;
  startAt: string;
  timezone: string;
}): AdminPushPayload => ({
  title: EVENT_TITLE[input.event],
  body: `${input.storeName}\n${formatDateTimeJa(input.startAt, input.timezone)}`,
  url: EVENT_URL[input.event],
  // Same event for the same reservation replaces the previous notification
  // rather than stacking a second one (a webhook redelivery, say).
  tag: `${input.event}:${input.reservationId}`,
});

const vapidDetails = (env: Partial<WorkerBindings>) => {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim() ?? "";
  const privateKey = env.VAPID_PRIVATE_KEY?.trim() ?? "";
  const contact = env.OPERATIONS_NOTIFICATION_EMAIL?.trim() ?? "";
  if (!publicKey || !privateKey || !contact) return undefined;
  // `sub` must be a mailto: or https: URL the push service can use to reach the
  // operator; reuse the address the ops notifications already go to.
  return { subject: `mailto:${contact}`, publicKey, privateKey };
};

/**
 * The public key the SPA subscribes with — empty unless this environment can
 * actually send. Handing out the public key while the private key or the VAPID
 * contact address is missing would let a device register and then never receive
 * anything, with the UI reporting it as subscribed.
 */
export const adminPushPublicKey = (env: Partial<WorkerBindings>): string =>
  vapidDetails(env)?.publicKey ?? "";

/**
 * POST one encrypted push. Returns "gone" when the push service says the
 * subscription no longer exists, so the caller can drop the row.
 */
const deliver = async (
  details: NonNullable<ReturnType<typeof vapidDetails>>,
  row: SubscriptionRow,
  payload: AdminPushPayload,
  fetcher: typeof fetch
): Promise<"sent" | "gone" | "failed"> => {
  const request = await generateRequestDetails(
    { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
    JSON.stringify(payload),
    {
      // An hour: a notification about an appointment is worthless once the
      // owner's phone has been offline longer than that.
      TTL: 3600,
      urgency: "high",
      vapidDetails: details,
    }
  );

  const response = await fetcher(request.endpoint, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    // A push service has no reason to redirect. Following one would take the
    // request — VAPID header included — to a host the allow-list never saw.
    // "manual" and not "error": Workers' fetch implements only follow/manual
    // and throws a TypeError on "error" — before the request is made, on every
    // send. A redirect comes back as a non-ok response and counts as failed.
    redirect: "manual",
  });

  // Workers allows only six simultaneous outbound connections, and a response
  // whose body is never read holds its connection open. Nothing here wants the
  // body, so release it before the status is even looked at — otherwise a
  // fan-out wider than six devices stalls behind the first replies.
  void response.body?.cancel().catch(() => undefined);

  if (response.ok) return "sent";
  // 404/410 mean the subscription is permanently gone (app deleted, permission
  // revoked). Anything else — 401/403 (VAPID), 413 (payload), 429, 5xx — is a
  // condition to fix or retry, not a reason to forget the device.
  if (response.status === 404 || response.status === 410) return "gone";
  safeCaptureException(new Error(`admin_push_failed:${response.status}`), {
    tags: { feature: "admin_web_push", status: String(response.status) },
  });
  return "failed";
};

/**
 * Registration is open to every signed-in admin, so both the row count and the
 * fan-out need a ceiling: without one, an authenticated staff member could
 * register thousands of endpoints and every booking would then spend the
 * request's subrequest budget POSTing to them.
 *
 * ponytail: no batching under the fan-out cap — 200 concurrent POSTs sit well
 * inside the Workers subrequest limit. Chunk it if the cap ever rises.
 */
const MAX_DEVICES_PER_ADMIN = 10;
const MAX_STORE_FANOUT = 200;

const sendToRows = async (
  env: Partial<WorkerBindings>,
  db: D1Database,
  rows: SubscriptionRow[],
  payload: AdminPushPayload,
  fetcher: typeof fetch = fetch
): Promise<number> => {
  const details = vapidDetails(env);
  if (!details || rows.length === 0) return 0;

  const timedFetcher = withOutboundTimeout(fetcher);
  const outcomes = await Promise.allSettled(
    rows.map(async (row) => {
      const result = await deliver(details, row, payload, timedFetcher);
      if (result === "gone") {
        // A late response describes the subscription used for this send. A
        // shared device may already belong to another admin or have new keys.
        await db
          .prepare(`DELETE FROM admin_push_subscriptions
            WHERE endpoint = ? AND admin_user_id = ? AND p256dh = ? AND auth = ?`)
          .bind(row.endpoint, row.admin_user_id, row.p256dh, row.auth)
          .run();
      }
      return result;
    })
  );

  let sent = 0;
  for (const outcome of outcomes) {
    if (outcome.status === "fulfilled" && outcome.value === "sent") {
      sent += 1;
      continue;
    }
    if (outcome.status === "rejected") {
      safeCaptureException(outcome.reason, { tags: { feature: "admin_web_push" } });
    }
  }
  return sent;
};

/**
 * Devices that should hear about something happening at `storeId`.
 *
 * `admin_users` has no store column — a staff member's store comes from the
 * joined `staff_members` row (the same shape src/admin/access.ts authenticates
 * with), so owner/system_admin (no staff row, or one in another store) hear
 * about every store and a staff member only about their own.
 *
 * `active = 1` and `is_service_token = 0` mirror the login query: deactivating
 * an admin is how access is revoked, and it must silence their device too — the
 * row is not deleted, so the CASCADE would never fire.
 */
const loadStoreSubscriptions = (db: D1Database, storeId: string) =>
  db
    .prepare(
      `SELECT p.endpoint, p.admin_user_id, p.p256dh, p.auth
         FROM admin_push_subscriptions p
         JOIN admin_users u ON u.id = p.admin_user_id
         LEFT JOIN staff_members sm ON sm.id = u.staff_member_id
        WHERE u.active = 1
          AND u.is_service_token = 0
          AND (u.role IN ('owner', 'system_admin') OR sm.store_id = ?)
        ORDER BY p.created_at DESC
        LIMIT ?`
    )
    .bind(storeId, MAX_STORE_FANOUT)
    .all<SubscriptionRow>();

type ReservationPushRow = {
  id: string;
  store_id: string;
  store_name: string;
  timezone: string;
  start_at: string;
};

const loadReservationForPush = (db: D1Database, reservationId: string) =>
  db
    .prepare(
      `SELECT r.id, r.store_id, s.name AS store_name, s.timezone, r.start_at
         FROM reservations r
         JOIN stores s ON s.id = r.store_id
        WHERE r.id = ?
        LIMIT 1`
    )
    .bind(reservationId)
    .first<ReservationPushRow>();

const prepareReservationPush = async (
  db: D1Database,
  event: AdminPushEvent,
  reservationId: string
) => {
  const reservation = await loadReservationForPush(db, reservationId);
  if (!reservation) return null;
  const { results } = await loadStoreSubscriptions(db, reservation.store_id);
  return {
    rows: results ?? [],
    payload: buildAdminPushPayload({
      event,
      reservationId,
      storeName: reservation.store_name,
      startAt: reservation.start_at,
      timezone: reservation.timezone,
    }),
  };
};

const pushForReservation = async (
  env: Partial<WorkerBindings>,
  db: D1Database,
  event: AdminPushEvent,
  reservationId: string,
  fetcher?: typeof fetch
): Promise<number> => {
  const prepared = await prepareReservationPush(db, event, reservationId);
  if (!prepared) return 0;
  return sendToRows(env, db, prepared.rows, prepared.payload, fetcher);
};

/**
 * Fire-and-forget from a request handler, shaped exactly like scheduleQueueKicks
 * (src/routes/shared.ts): hand the promise to waitUntil when there is an
 * execution context, and otherwise make sure the rejection is swallowed so it
 * never becomes an unhandled rejection.
 */
export const notifyAdminPush = (
  c: Context<AppEnvironment>,
  input: { event: AdminPushEvent; reservationId: string }
): void => {
  const db = c.env.DB;
  if (!db) return;

  const promise = pushForReservation(c.env, db, input.event, input.reservationId)
    .then(() => undefined)
    .catch((error: unknown) => {
      safeCaptureException(error, {
        tags: { feature: "admin_web_push", event: input.event },
      });
    });

  try {
    c.executionCtx.waitUntil(promise);
  } catch {
    promise.catch(() => {});
  }
};

/**
 * Reservations whose approval deadline falls inside the next hour and that have
 * not been pushed about yet. Called from the 10-minute maintenance cron.
 *
 * The `approval_expiry_pushed_at` marker (migration 0049) is what lets the
 * window be a full hour instead of a single cron tick: a skipped or slow tick
 * delays the notification rather than dropping it, and a reservation is still
 * only ever pushed once.
 */
const EXPIRY_PUSH_LEAD_MS = 60 * 60 * 1000;

/**
 * Reservations per tick. Deliberately small: every one of them fans out to up to
 * MAX_STORE_FANOUT devices in the SAME invocation, which the 10-minute cron
 * shares with the LINE dispatcher (up to 500 sends) and the other maintenance
 * tasks. The platform's own subrequest ceiling is no longer the constraint
 * (Workers Paid defaults to 10,000 per invocation since 2026-02), so
 * MAX_EXPIRY_PUSH_SENDS_PER_TICK is an OPERATIONAL bound: it keeps one runaway
 * subscription table from eating the tick's wall-clock and outbound budget.
 * It must stay >= MAX_STORE_FANOUT, or a single max-fan-out reservation could
 * never be admitted and would starve until its window passes.
 *
 * Undersizing either bound is safe — a reservation left over or deferred is
 * simply picked up by the next tick, and the window is a full hour.
 */
const EXPIRY_PUSH_BATCH = 4;
const MAX_EXPIRY_PUSH_SENDS_PER_TICK = 250;

export const dispatchExpiringApprovalPush = async (
  env: Partial<WorkerBindings>,
  db: D1Database,
  nowMs: number,
  fetcher?: typeof fetch
): Promise<number> => {
  if (!vapidDetails(env)) return 0;

  const nowIso = new Date(nowMs).toISOString();
  const untilIso = new Date(nowMs + EXPIRY_PUSH_LEAD_MS).toISOString();
  const { results } = await db
    .prepare(
      `SELECT id FROM reservations
        WHERE status = 'pending_approval'
          AND approval_expiry_pushed_at IS NULL
          AND pending_expires_at IS NOT NULL
          AND pending_expires_at > ?
          AND pending_expires_at <= ?
        ORDER BY pending_expires_at ASC
        LIMIT ?`
    )
    .bind(nowIso, untilIso, EXPIRY_PUSH_BATCH)
    .all<{ id: string }>();

  // Admission BEFORE stamping, sequentially in expiry order: a reservation is
  // only stamped once its ENTIRE fan-out fits the remaining tick budget. A
  // reservation that does not fit stays unstamped and is picked up whole by
  // the next tick — truncating a stamped reservation instead would silently
  // and permanently drop the sliced-off devices, because the stamp removes it
  // from every future query.
  //
  // Forward-progress guarantee: candidates arrive ORDER BY pending_expires_at
  // ASC and MAX_EXPIRY_PUSH_SENDS_PER_TICK >= MAX_STORE_FANOUT, so the
  // soonest-expiring unstamped reservation is ALWAYS admitted each tick (it
  // sees the full budget first). A deferred reservation is therefore only ever
  // one that expires later than everything admitted ahead of it, and it
  // becomes the soonest candidate on a following tick (~6 ticks per one-hour
  // window). Missing the window entirely would need a sustained arrival of
  // sooner-expiring reservations consuming 250+ sends every 10 minutes —
  // far beyond this deployment's device count (10 devices per admin, a
  // handful of admins) — and that regime fires the deferred warning below on
  // every tick, so it cannot stay silent.
  let remaining = MAX_EXPIRY_PUSH_SENDS_PER_TICK;
  let deferred = 0;
  const admitted: {
    id: string;
    prepared: NonNullable<Awaited<ReturnType<typeof prepareReservationPush>>>;
  }[] = [];
  for (const row of results ?? []) {
    const prepared = await prepareReservationPush(db, "approval_expiring", row.id);
    if (!prepared) continue;
    if (prepared.rows.length > remaining) {
      deferred += 1;
      continue;
    }
    remaining -= prepared.rows.length;
    admitted.push({ id: row.id, prepared });
  }

  // Sends run concurrently, NOT one reservation at a time: a serial loop spends
  // the outbound timeout of every slow device in sequence, and since each row is
  // STAMPED before its send, anything the cron task's own timeout cuts off is
  // marked as notified and never retried. Concurrency makes the wall time one
  // send, not twenty.
  const outcomes = await Promise.allSettled(
    admitted.map(async ({ id, prepared }) => {
      // Stamp BEFORE sending. A crash between the two costs one notification; the
      // reverse order costs a repeated one every ten minutes for an hour. The
      // status guard covers the admission→stamp window: a reservation approved
      // or rejected in between is skipped instead of getting a stale
      // "approval expiring" push (it stays unstamped, and the dispatch query
      // never selects non-pending rows again).
      const marked = await db
        .prepare(
          `UPDATE reservations SET approval_expiry_pushed_at = ?
            WHERE id = ? AND approval_expiry_pushed_at IS NULL
              AND status = 'pending_approval'`
        )
        .bind(nowIso, id)
        .run();
      if (Number(marked.meta?.changes ?? 0) === 0) return 0;
      return sendToRows(env, db, prepared.rows, prepared.payload, fetcher);
    })
  );

  let pushed = 0;
  for (const outcome of outcomes) {
    if (outcome.status === "fulfilled") {
      pushed += outcome.value;
      continue;
    }
    safeCaptureException(outcome.reason, {
      tags: { feature: "admin_web_push", event: "approval_expiring" },
    });
  }
  if (deferred > 0) {
    // Deferred, not lost: the reservations stayed unstamped and the next tick
    // retries them — but repeated deferrals inside the one-hour window mean the
    // budget is undersized for the device count, so keep it loud.
    console.warn("admin_push_expiring_fanout_deferred", {
      limit: MAX_EXPIRY_PUSH_SENDS_PER_TICK,
      deferred,
    });
    safeCaptureException(new Error("admin_push_expiring_fanout_deferred"), {
      tags: { feature: "admin_web_push", event: "approval_expiring", reason: "fanout_deferred" },
      contexts: {
        fanout: {
          limit: MAX_EXPIRY_PUSH_SENDS_PER_TICK,
          deferred,
        },
      },
    });
  }
  return pushed;
};

// Subscription management (called from the admin API)

type AdminPushMutationResult = { ok: true } | { ok: false; reason: "forbidden" };

export const savePushSubscription = async (
  db: D1Database,
  admin: AdminUser,
  input: { endpoint: string; p256dh: string; auth: string }
): Promise<AdminPushMutationResult> => {
  // Re-registering the same device — or handing the shared shop tablet to a
  // different admin — rebinds the row to whoever is signed in now.
  //
  // The DO UPDATE ... WHERE is what keeps that from becoming a way to take over
  // someone else's device: rebinding requires either already owning the row, or
  // presenting the subscription's own p256dh/auth, which only the browser
  // holding that subscription can produce. An endpoint leaked on its own (a log,
  // a screenshot) is then not enough. A caller failing the check gets a silent
  // no-op — it is not a case a legitimate client can reach.
  //
  // The second statement caps how many devices one admin can hold, dropping the
  // oldest. A person has a phone and maybe a tablet; ten is far past legitimate
  // use and keeps the fan-out bounded. D1 runs a batch as one transaction, so
  // the insert and the trim never half-apply.
  try {
    await db.batch([
      adminWriteGuard(db, admin),
      db
        .prepare(
          `INSERT INTO admin_push_subscriptions (endpoint, admin_user_id, p256dh, auth)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(endpoint) DO UPDATE SET
             admin_user_id = excluded.admin_user_id,
             p256dh = excluded.p256dh,
             auth = excluded.auth,
             -- A rebind is this admin's newest device. Keeping the original
             -- timestamp would let the trim below delete it in the same batch,
             -- while the API still answered ok.
             created_at = CURRENT_TIMESTAMP
           WHERE admin_push_subscriptions.admin_user_id = excluded.admin_user_id
              OR (admin_push_subscriptions.p256dh = excluded.p256dh
                  AND admin_push_subscriptions.auth = excluded.auth)`
        )
        .bind(input.endpoint, admin.id, input.p256dh, input.auth),
      db
        .prepare(
          `DELETE FROM admin_push_subscriptions
            WHERE admin_user_id = ?1
              AND endpoint NOT IN (
                SELECT endpoint FROM admin_push_subscriptions
                 WHERE admin_user_id = ?1
                 ORDER BY created_at DESC, endpoint DESC
                 LIMIT ?2)`
        )
        .bind(admin.id, MAX_DEVICES_PER_ADMIN)
    ]);
    return { ok: true };
  } catch (error) {
    if (await adminWriteWasRevoked(db, admin, error)) return { ok: false, reason: "forbidden" };
    throw error;
  }
};

export const deletePushSubscription = async (
  db: D1Database,
  admin: AdminUser,
  endpoint: string
): Promise<AdminPushMutationResult> => {
  try {
    await db.batch([adminWriteGuard(db, admin), db
      .prepare("DELETE FROM admin_push_subscriptions WHERE endpoint = ? AND admin_user_id = ?")
      .bind(endpoint, admin.id)]);
    return { ok: true };
  } catch (error) {
    if (await adminWriteWasRevoked(db, admin, error)) return { ok: false, reason: "forbidden" };
    throw error;
  }
};

/**
 * Test send — only ever to the caller's OWN devices.
 *
 * Returns the device count alongside the successes because this is a diagnostic:
 * "no device registered" and "three devices, all failing" both send zero, and
 * telling them apart is the entire point of the button.
 */
export const sendAdminPushTest = async (
  env: Partial<WorkerBindings>,
  db: D1Database,
  admin: AdminUser,
  fetcher?: typeof fetch
): Promise<({ ok: true; devices: number; sent: number }) | { ok: false; reason: "forbidden" }> => {
  const { results } = await db
    .prepare(
      `SELECT endpoint, admin_user_id, p256dh, auth FROM admin_push_subscriptions
        WHERE admin_user_id = ?
        ORDER BY created_at DESC
        LIMIT ?`
    )
    .bind(admin.id, MAX_DEVICES_PER_ADMIN)
    .all<SubscriptionRow>();

  const rows = results ?? [];
  let authorizationFailure: unknown;
  const authorizedFetcher: typeof fetch = async (url, init) => {
    if (authorizationFailure !== undefined) throw authorizationFailure;
    try { await assertAdminWriteCurrent(db, admin); }
    catch (error) { authorizationFailure = error; throw error; }
    return (fetcher ?? fetch)(url, init);
  };
  // Check even with no devices. Each real POST rechecks after encryption.
  try { await assertAdminWriteCurrent(db, admin); }
  catch (error) {
    if (await adminWriteWasRevoked(db, admin, error)) return { ok: false, reason: "forbidden" };
    throw error;
  }
  const sent = await sendToRows(
    env,
    db,
    rows,
    {
      title: "テスト通知",
      body: "この端末で通知を受け取れます。",
      url: "/admin/",
      tag: "admin_push_test",
    },
    authorizedFetcher
  );
  // sendToRows isolates provider failures. An authorization failure must instead
  // reach the admin request as a denial (or database error), never sent:0 success.
  if (authorizationFailure !== undefined) {
    if (await adminWriteWasRevoked(db, admin, authorizationFailure)) return { ok: false, reason: "forbidden" };
    throw authorizationFailure;
  }
  return { ok: true, devices: rows.length, sent };
};
