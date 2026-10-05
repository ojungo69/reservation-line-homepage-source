import * as Sentry from "@sentry/cloudflare";
import type { ErrorEvent, TransactionEvent } from "@sentry/core";

import { createApp, isAdminHost, isAdminPrivatePath } from "./app";
import { ensureGoogleCalendarWatchChannels } from "./google/channel-watch";
import { processDueCalendarSyncJobs } from "./google/calendar-sync";
import { detectConflictBursts } from "./google/conflict-burst-detector";
import {
  enqueueGoogleCalendarMaintenanceJobs,
  processDueGoogleCalendarImportJobs,
  pruneGoogleEventHistory
} from "./google/import-sync";
import { processDueLineNotificationJobs } from "./line/notifications";
import { notifyLowLineQuota, refreshLineQuotaSnapshot } from "./line/quota";
import {
  CLAIM_TASK_TIMEOUT_MS,
  CRON_WATCHDOG_MS,
  DAILY_CLEANUP_WATCHDOG_MS,
  DAILY_TASK_TIMEOUT_MS,
  PER_TASK_TIMEOUT_MS,
  PRELUDE_TASK_TIMEOUT_MS,
  runTasksWithWatchdog,
  withTaskTimeout
} from "./cron-watchdog";
import { classifyD1SweepFailure, isTransientD1Error, readErrorMessage } from "./outbound-timeout";
export { LineRateLimiter } from "./line/rate-limiter-do";
export { OperationsHealth } from "./operations-health";
import { ReservationConfirmWorkflow as ReservationConfirmWorkflowBase } from "./workflows/reservation-confirm";
import { dispatchDailyOpsSummary } from "./notifications/daily-ops-summary";
import { dispatchReservationReminders } from "./notifications/reminder-dispatcher";
import { dispatchExpiringApprovalPush } from "./notifications/admin-push";
import { AUTO_COMPLETE_GRACE_MS, runAutoCompleteForCron } from "./reservations/auto-complete";
import { expirePendingReservations } from "./reservations/expiration";
import { runRetentionSweepPhase1 } from "./retention-sweep";
import {
  D1_DR_FREEZE_HEADER_NAME,
  D1_DR_FREEZE_MAINTENANCE_MODE,
  D1_DR_FREEZE_RETRY_DELAY_SECONDS,
  D1_DR_FREEZE_SENTINEL_PATH,
  isDailyOpsSummaryDispatchEnabled,
  isD1DrFreezeMaintenanceMode,
  isGoogleImportEnabled,
  isReservationReminderDispatchEnabled
} from "./runtime-config";
import {
  CLOUDFLARE_WEB_ANALYTICS_SCRIPT,
  HSTS_HEADER_NAME,
  HSTS_HEADER_VALUE,
  withFreshCspNonce
} from "./security-headers";
import { dropSdkWorkflowEvent, safeCaptureException } from "./sentry-helpers";
import { normalizePathnameTemplate } from "./sentry-path-templates";
import { scrubSentryEvent, scrubSentryBreadcrumb, scrubSentryRequest } from "./sentry-pii-filter";
import { isPushServiceHost, isSensitiveContextKey, redactPushEndpoints } from "./pii-normalize";

import type { WorkerBindings } from "./bindings";

const app = createApp();
const GOOGLE_SYNC_QUEUE_NAME = "reservation-google-sync";
const LINE_NOTIFICATION_QUEUE_NAME = "reservation-line-notifications";
const GOOGLE_SYNC_QUEUE_NAMES = new Set([
  GOOGLE_SYNC_QUEUE_NAME,
  "reservation-line-homepage-staging-google-sync",
  "reservation-line-homepage-production-google-sync"
]);
const LINE_NOTIFICATION_QUEUE_NAMES = new Set([
  LINE_NOTIFICATION_QUEUE_NAME,
  "reservation-line-homepage-staging-line-notifications",
  "reservation-line-homepage-production-line-notifications"
]);
// Dead-letter queues: messages land here after a consumer exhausts
// max_retries. Without a consumer they sit invisible and expire after the
// queue retention window — the DLQ consumer below turns them into a Sentry
// alert + structured log instead (商品化評価 §6 ② DLQ滞留アラート).
const DEAD_LETTER_QUEUE_NAMES = new Set([
  "reservation-google-sync-dlq",
  "reservation-line-notifications-dlq",
  "reservation-line-homepage-staging-google-sync-dlq",
  "reservation-line-homepage-staging-line-notifications-dlq",
  "reservation-line-homepage-production-google-sync-dlq",
  "reservation-line-homepage-production-line-notifications-dlq"
]);
const PUBLIC_ASSET_CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  // LINE publishes no fixed LIFF host list and rotates across its first-party
  // CDNs, so keep these reviewed wildcards scoped to the two LINE roots.
  `script-src 'self' https://static.line-scdn.net https://*.line-scdn.net https://challenges.cloudflare.com ${CLOUDFLARE_WEB_ANALYTICS_SCRIPT}`,
  "style-src 'self'",
  "img-src 'self' data: https://profile.line-scdn.net https://*.line-scdn.net",
  "connect-src 'self' https://api.line.me https://liff-api.line.me https://access.line.me https://liff.line.me https://*.line.me https://*.line-scdn.net https://challenges.cloudflare.com",
  "frame-src https://challenges.cloudflare.com https://access.line.me https://liff.line.me https://line.me https://*.line.me",
  "object-src 'none'"
].join("; ");

const LEGAL_ASSET_PATH_RE =
  /^\/legal\/(?:terms|notice|cancellation|privacy|tokusho)(?:\.html|\/)?$/;
const LEGAL_ASSET_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  `script-src 'self' ${CLOUDFLARE_WEB_ANALYTICS_SCRIPT}`,
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "object-src 'none'"
].join("; ");

const PUBLIC_ASSET_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": PUBLIC_ASSET_CSP,
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "no-referrer",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY"
};

// Vite emits content-addressed bundle names under /admin-app/assets/ as
// `<name>-<hash>.<ext>` where Vite's default hash is exactly 8 base64url
// characters (which can themselves include '-' and '_', e.g.
// label-BJTLg-6Y.js or shared-ChJ_j-JJ.css). Anchoring on the fixed
// 8-char suffix lets us split deterministically without a greedy regex,
// avoiding the catastrophic-backtracking class of regex vulnerabilities.
// If the project ever opts into a non-default hash length, update
// VITE_HASH_LENGTH and the corresponding tests.
const ADMIN_ASSET_PREFIX = "/admin-app/assets/";
const VITE_HASH_LENGTH = 8;
const HASH_CHAR_CLASS_RE = /^[A-Za-z0-9_-]+$/;
const BASENAME_CHAR_CLASS_RE = /^[A-Za-z0-9._-]+$/;

export const isHashedAdminAssetPath = (pathname: string): boolean => {
  if (!pathname.startsWith(ADMIN_ASSET_PREFIX)) return false;
  const tail = pathname.slice(ADMIN_ASSET_PREFIX.length);
  if (tail.length === 0 || tail.includes("/")) return false;

  let extLength: number;
  if (tail.endsWith(".js")) extLength = 3;
  else if (tail.endsWith(".css")) extLength = 4;
  else return false;

  const base = tail.slice(0, -extLength);
  // need at least 1 name char + '-' + hash chars
  if (base.length < VITE_HASH_LENGTH + 2) return false;
  if (base[base.length - VITE_HASH_LENGTH - 1] !== "-") return false;

  const hash = base.slice(-VITE_HASH_LENGTH);
  if (!HASH_CHAR_CLASS_RE.test(hash)) return false;

  const namePart = base.slice(0, -VITE_HASH_LENGTH - 1);
  return BASENAME_CHAR_CLASS_RE.test(namePart);
};

// SPA fallback (single-page-application) means /admin-app/assets/missing.js
// can resolve to index.html or 404. We refuse to cache anything that isn't
// a 200 + JS/CSS response so rollback / cache-poisoning races stay safe.
export const isImmutableAdminAssetResponse = (
  pathname: string,
  response: Response
): boolean => {
  if (!isHashedAdminAssetPath(pathname)) return false;
  if (response.status !== 200) return false;
  const ct = (response.headers.get("Content-Type") ?? "").toLowerCase();
  return (
    ct.startsWith("application/javascript") ||
    ct.startsWith("text/javascript") ||
    ct.startsWith("text/css")
  );
};

const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

const addPublicAssetHeaders = (response: Response, pathname: string) => {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(PUBLIC_ASSET_HEADERS)) {
    headers.set(key, value);
  }
  if ((response.headers.get("Content-Type") ?? "").toLowerCase().startsWith("text/html")) {
    const policy = LEGAL_ASSET_PATH_RE.test(pathname) ? LEGAL_ASSET_CSP : PUBLIC_ASSET_CSP;
    headers.set("Content-Security-Policy", withFreshCspNonce(policy));
  }
  if (isImmutableAdminAssetResponse(pathname, response)) {
    headers.set("Cache-Control", IMMUTABLE_CACHE_CONTROL);
    // Pragma: no-cache contradicts a long-lived public cache hint; drop it
    // for the immutable subset so caches don't have to reconcile both.
    headers.delete("Pragma");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
};

// Extracted so a unit test can assert the shape of the observability payload
// without spinning up a full scheduled-handler harness. The payload feeds
// Cloudflare Workers Tail/Trace logs; the event_type acts as the filter
// key and must stay stable so dashboards/alerts can pin to it.
export const buildImportDisabledLog = (env: Partial<WorkerBindings>): string =>
  JSON.stringify({
    event_type: "scheduled_handler_google_import_disabled",
    outcome: "noop",
    environment: typeof env.ENVIRONMENT === "string" ? env.ENVIRONMENT : "unknown"
  });

// `drain` defaults to true for the request-time path (shouldExpireBeforeFetch)
// and the queue handler: those must fully clear expired holds (so a just-expired
// slot shows free on the very next read) and are NOT under the cron watchdog.
//
// The cron PRELUDE passes `drain: false` so a scheduled tick does a SINGLE
// bounded batch (≤200 rows) instead of looping over an unbounded backlog. The
// prelude runs sequentially ahead of the claim fan-out under a fixed
// PRELUDE_TASK_TIMEOUT_MS budget, so an unbounded drain there could false-kill a
// large-but-legitimate backlog (and starve the downstream dispatch). Bounding it
// per tick keeps the budget honest; any overflow drains over later cron ticks
// and the on-read request path (which still drains fully).
const expireReservationsBeforeSideEffects = async (
  db: D1Database,
  options: { drain?: boolean } = {}
) => {
  const result = await expirePendingReservations({
    db,
    maxReservations: 200,
    drain: options.drain ?? true
  });
  if (!result.ok) {
    if (result.reason === "d1_export_locked") {
      // A long-running D1 export (backup-verify's weekly `wrangler d1 export`) is
      // transiently rejecting writes. Skip this tick's bounded expiry sweep rather
      // than throwing — a throw would escape to the cron / queue boundary as a
      // generic `pending_reservation_expiration_*` error that is no longer
      // recognizable as the transient export-lock, and get captured. The sweep
      // drains on a later tick once the export clears. Sentry RESERVATION-LINE-HOMEPAGE-D.
      console.warn("pending_reservation_expiration_d1_export_locked", { event: "d1_export_locked" });
      return;
    }
    if (result.reason === "transient_d1") {
      // D1 側の一過性インフラ障害で掃除処理が失敗しても本来の request / cron / queue
      // を落とさず、次回 sweep に回す。原エラーは expiration 側で capture 済みなので
      // 観測性は維持される。Sentry RESERVATION-LINE-HOMEPAGE-E/F。
      console.warn("pending_reservation_expiration_transient_d1", { event: "transient_d1" });
      return;
    }
    throw new Error(`pending_reservation_expiration_${result.reason}`);
  }
};

const shouldExpireBeforeFetch = (url: URL) => {
  return url.pathname === "/api/public/availability" ||
    url.pathname === "/api/public/reservations" ||
    url.pathname === "/api/admin/reservations" ||
    url.pathname.startsWith("/api/admin/reservations/");
};

export type ReservationQueueKind = "google_sync" | "line_notifications" | "dead_letter";

export const classifyReservationQueue = (queueName: string): ReservationQueueKind | undefined => {
  const normalized = queueName.trim();
  if (GOOGLE_SYNC_QUEUE_NAMES.has(normalized)) {
    return "google_sync";
  }
  if (LINE_NOTIFICATION_QUEUE_NAMES.has(normalized)) {
    return "line_notifications";
  }
  if (DEAD_LETTER_QUEUE_NAMES.has(normalized)) {
    return "dead_letter";
  }
  return undefined;
};

// Phase 3 — LIFF-served customer surfaces routed to the worker. /customer/reservations.js
// (the client bundle) keeps falling through to ASSETS via the exact-match check.
const CUSTOMER_SSR_PATHS: ReadonlySet<string> = new Set(["/customer/reservations"]);

// Strip a single trailing slash (but keep "/" itself intact) so "/admin/" routes the same as
// "/admin". Without this, "/admin/" would miss the predicate, fall through to ASSETS, hit the
// SPA fallback, and silently serve public/index.html (the public reservation UI) under the
// CF Access gate — the very leak admin-host isolation is meant to close.
const normalizePathname = (pathname: string): string => {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
};

// Routing predicate the worker uses to decide whether to hand the request to Hono (`app.fetch`)
// or fall through to the ASSETS binding for static delivery.
//
// Admin routing uses an EXACT-SHAPE prefix predicate so paths like `/admin-app`, `/admin-other`,
// or `/administrator` do NOT match (they would if we used a bare `startsWith("/admin")`). The
// React SPA is now mounted at `/admin` (PR1 of the /admin canonical migration). The legacy
// `/admin-next` alias was retired in Phase 5 — it 404s earlier in handleFetch (before this
// predicate runs), so it deliberately does not match `/admin`/`/admin/` below.
export const shouldRouteToWorker = (pathname: string): boolean => {
  if (pathname.startsWith("/api/")) {
    return true;
  }
  const normalized = normalizePathname(pathname);
  // Canonical admin SPA mount point. (The legacy /admin-next alias was retired in
  // Phase 5 — it 404s at the entrypoint BEFORE this predicate runs — see
  // handleFetch — so it deliberately does NOT match here.)
  if (normalized === "/admin" || normalized.startsWith("/admin/")) {
    return true;
  }
  return CUSTOMER_SSR_PATHS.has(normalized);
};

const ADMIN_HOST_REDIRECT_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "private, no-store",
  Pragma: "no-cache",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
};

const redirectToAdmin = (search: string): Response => {
  return new Response(null, {
    status: 301,
    headers: {
      ...ADMIN_HOST_REDIRECT_HEADERS,
      Location: search ? `/admin${search}` : "/admin"
    }
  });
};

// LIFF redirects deep links such as liff.line.me/<liffId>/customer/reservations to
// `${endpoint}/?liff.state=%2Fcustomer%2Freservations` and relies on the LIFF SDK to
// finish the navigation client-side. Our root SPA only calls liff.init() lazily on
// form submit, so the second hop never fires and the booking UI ends up rendered in
// place of the requested Phase 3 surface. Resolve liff.state server-side instead and
// return a 302 to the encoded target so deep links work without a live SDK.
const isSafeLiffStatePath = (path: string): boolean => {
  if (!path.startsWith("/")) return false;
  if (path.startsWith("//")) return false;
  if (path.startsWith("/\\")) return false;
  for (let i = 0; i < path.length; i += 1) {
    const code = path.codePointAt(i);
    if (code !== undefined && (code < 0x20 || code === 0x7f)) return false;
  }
  return true;
};

export const buildLiffStateRedirect = (url: URL): Response | null => {
  if (url.pathname !== "/") return null;
  const raw = url.searchParams.get("liff.state");
  if (raw === null || raw.length === 0) return null;
  if (!isSafeLiffStatePath(raw)) return null;
  let target: URL;
  try {
    target = new URL(raw, url.origin);
  } catch {
    return null;
  }
  if (target.origin !== url.origin) return null;
  // Re-check the normalized pathname so payloads such as "/a/..//evil.example.com" or
  // "/%2e%2e//evil.example.com" — which begin with a single slash but normalize to
  // "//evil.example.com" — cannot leak into a protocol-relative Location header that a
  // browser would resolve against the attacker-controlled host.
  if (!target.pathname.startsWith("/") || target.pathname.startsWith("//")) return null;
  // Preserve non-LIFF query params that LIFF appends from the endpoint URL itself
  // (e.g. `?store=kyoto&liff.state=…`). LIFF SDK's reference behavior merges endpoint
  // query params with the liff.state path/query; we mirror that so feature flags or
  // campaign routing keys configured on the LIFF endpoint URL survive the 302. The
  // embedded liff.state query wins on conflict because it represents the user-facing
  // deep link, while liff.* params are LIFF-internal and dropped.
  for (const [key, value] of url.searchParams) {
    if (key === "liff.state" || key.startsWith("liff.")) continue;
    if (target.searchParams.has(key)) continue;
    target.searchParams.append(key, value);
  }
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${target.pathname}${target.search}${target.hash}`,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer"
    }
  });
};

// Stamp HSTS on a response, tolerating immutable headers (ASSETS /
// fetch-through responses) by re-wrapping. See src/security-headers.ts for
// the policy rationale (includeSubDomains yes, preload no).
const applyHsts = (response: Response): Response => {
  try {
    response.headers.set(HSTS_HEADER_NAME, HSTS_HEADER_VALUE);
    return response;
  } catch {
    try {
      const writable = new Response(response.body, response);
      writable.headers.set(HSTS_HEADER_NAME, HSTS_HEADER_VALUE);
      return writable;
    } catch {
      // Re-wrap itself can throw for statuses the Response constructor
      // refuses (e.g. 101/1xx). No such response exists on current routes,
      // but HSTS is best-effort — never break the response over a header.
      return response;
    }
  }
};

const buildD1DrFreezeResponse = (isSentinelPath: boolean): Response =>
  new Response(
    JSON.stringify({
      ok: false,
      error: "maintenance",
      reason: D1_DR_FREEZE_MAINTENANCE_MODE,
      sentinel: isSentinelPath
    }),
    {
      status: 503,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        Pragma: "no-cache",
        [D1_DR_FREEZE_HEADER_NAME]: D1_DR_FREEZE_MAINTENANCE_MODE
      }
    }
  );

// Outermost fetch boundary: route the request, then stamp HSTS so every
// response — app routes, static assets, redirects, bare 404s — carries it.
async function handleFetch(
  request: Request,
  env: WorkerBindings,
  ctx: ExecutionContext
): Promise<Response> {
  if (isD1DrFreezeMaintenanceMode(env)) {
    const isSentinelPath = new URL(request.url).pathname === D1_DR_FREEZE_SENTINEL_PATH;
    return applyHsts(buildD1DrFreezeResponse(isSentinelPath));
  }
  return applyHsts(await routeRequest(request, env, ctx));
}

async function routeRequest(
  request: Request,
  env: WorkerBindings,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);

  const host = request.headers.get("host");

  // /admin-next was the transitional SPA mount during the /admin canonical migration
  // (PR1); retired in Phase 5 — it now 404s on every host. The match decodes each
  // well-formed percent triplet INDIVIDUALLY (not the whole string via
  // decodeURIComponent, which throws on any stray `%` and would leave the alias
  // still-encoded), so ASCII-encoded aliases like /admin-next%2Fx, /%61dmin-next and
  // /admin%2dnext are caught — including ones with trailing malformed escapes — before
  // reaching the single-page-application ASSETS fallback (which would otherwise surface
  // the customer shell). Checked BEFORE the host redirect / reverse guard so the 404 is
  // uniform across hosts.
  //
  // Security invariant (holds for ANY encoding, however exotic): /admin-next never
  // serves admin content. If a path dodges this probe (e.g. multi-level encoding), on
  // the public host it resolves to the public customer shell (public content, never
  // admin data) and on the admin host to an auth-gated /admin redirect — not a leak.
  // Fast path: the vast majority of request paths contain no `%`, so skip the
  // regex/decoder entirely (a path with no percent-escape decodes to itself).
  const aliasProbe = url.pathname.includes("%")
    ? url.pathname.replace(/%[0-9A-Fa-f]{2}/g, (triplet) => {
        try {
          return decodeURIComponent(triplet);
        } catch {
          return triplet;
        }
      })
    : url.pathname;
  // Match "/admin-next" when it is the whole path or is followed by a path / query /
  // fragment delimiter (/, ?, #) — so encoded delimiters (…%2F, …%3F, …%23) all 404.
  // A non-delimiter next char (e.g. "/admin-nextfoo") is a distinct path and is
  // intentionally NOT matched.
  const ALIAS_PREFIX = "/admin-next";
  if (aliasProbe.startsWith(ALIAS_PREFIX)) {
    const boundary = aliasProbe.charAt(ALIAS_PREFIX.length);
    if (boundary === "" || boundary === "/" || boundary === "?" || boundary === "#") {
      return new Response("Not Found", { status: 404 });
    }
  }

  // admin.example.invalid is operator-only. Any non-admin path on that host (e.g. /,
  // /styles.css, /api/public/*) redirects to /admin. The GET/HEAD source offer is public,
  // so all remote users can obtain this version without entering the booking UI. Customers never see the
  // reservation UI on the admin domain and operators always land on the dashboard.
  // The check lives here — BEFORE the worker/ASSETS split — because Hono middleware
  // never sees the asset paths (/, /styles.css) that fall straight through to ASSETS.
  const publicSourceOffer = url.pathname === "/source" && (request.method === "GET" || request.method === "HEAD");
  if (isAdminHost(host) && !isAdminPrivatePath(url.pathname) && !publicSourceOffer) {
    return redirectToAdmin(url.search);
  }

  // Reverse guard: block admin paths on non-admin hosts in production.
  // Prevents reserve.example.invalid (or workers.dev) from exposing
  // admin UI shell, static assets, or API endpoints.
  if (
    env.ENVIRONMENT === "production" &&
    !isAdminHost(host) &&
    isAdminPrivatePath(url.pathname)
  ) {
    return new Response("Not Found", { status: 404 });
  }

  if (request.method === "GET" && url.pathname === "/") {
    const liffRedirect = buildLiffStateRedirect(url);
    if (liffRedirect) {
      return liffRedirect;
    }
  }

  if (shouldRouteToWorker(url.pathname)) {
    if (shouldExpireBeforeFetch(url)) {
      await expireReservationsBeforeSideEffects(env.DB);
    }
    return app.fetch(request, env, ctx);
  }

  return addPublicAssetHeaders(await env.ASSETS.fetch(request), url.pathname);
}

// ── Sentry traces sampler ───────────────────────────────────────────
// Route-class base rates (Sentry free plan: 5k errors + 10M spans/mo).
// Conservative defaults keep monthly span budget well under 5%.
// The override multiplier lets operators throttle without a redeploy.

/** Extract an HTTP pathname from the span name set by @sentry/cloudflare.
 *  Span names are typically "METHOD /path" for fetch handlers. */
export const extractPathnameFromSpanName = (name: string): string | undefined => {
  // @sentry/cloudflare names HTTP spans as "METHOD /path" (e.g. "GET /api/public/availability")
  const spaceIndex = name.indexOf(" ");
  if (spaceIndex >= 0) {
    const afterSpace = name.slice(spaceIndex + 1);
    if (afterSpace.startsWith("/")) {
      return afterSpace;
    }
  }
  // Bare pathname (no method prefix)
  if (name.startsWith("/")) {
    return name;
  }
  return undefined;
};

// The path-template table for dynamic admin/reservation routes lives in
// ./sentry-path-templates so the HTTP error handler in src/app.ts can reuse
// normalizePathnameTemplate for the Sentry route tag without a circular import
// (index.ts imports createApp from app.ts). Re-exported here so the traces
// sampler below and existing importers keep the same module surface.
export { ADMIN_PATH_TEMPLATES } from "./sentry-path-templates";
export { normalizePathnameTemplate };
export type { PathTemplate } from "./sentry-path-templates";

/** Map a span name to a base sample rate.
 *  Normalizes dynamic IDs in pathnames before route-class matching.
 *  Cron handlers → 0.1, public availability → 0.01, public reservations → 0.1,
 *  admin routes → 0.05, everything else → 0. */
export const getBaseSampleRate = (name: string): number => {
  // @sentry/cloudflare v10.53.1 instrumentScheduled names the root span
  // `Scheduled Cron ${controller.cron}` (e.g. "Scheduled Cron */10 * * * *").
  // The bare "scheduled" forms are kept as a back-compat fallback in case
  // future SDK versions revert the naming.
  if (name.startsWith("Scheduled Cron ")) {
    return 0.1;
  }
  if (name === "scheduled" || name.startsWith("scheduled ")) {
    return 0.1;
  }

  const pathname = extractPathnameFromSpanName(name);
  if (pathname === undefined) {
    return 0;
  }

  // Normalize dynamic IDs to template form before route-class matching.
  const normalized = normalizePathnameTemplate(pathname);

  if (normalized === "/api/public/availability") {
    return 0.01;
  }
  if (normalized === "/api/public/reservations" || normalized.startsWith("/api/public/reservations/")) {
    return 0.1;
  }
  if (normalized.startsWith("/api/admin/") || normalized === "/api/admin") {
    return 0.05;
  }

  return 0;
};

// Module-scoped warn-once set so per-request invocations of
// buildSentryOptions do not flood logs with the same warning.
const sentryOverrideWarnSeen = new Set<string>();
const warnOverrideOnce = (raw: string, payload: Record<string, unknown>): void => {
  if (sentryOverrideWarnSeen.has(raw)) {
    return;
  }
  sentryOverrideWarnSeen.add(raw);
  console.warn("sentry_traces_sample_rate_override_warn", { raw, ...payload });
};

/** Parse and clamp the override multiplier from the env var.
 *  Accepts only finite numeric strings whose entire (trimmed) content
 *  parses cleanly via `Number(...)`. Partial-numeric strings such as
 *  "0.5abc" fall back to 1 with a warning. Out-of-range finite values
 *  clamp to [0, 1] with a warning. Each unique invalid raw value warns
 *  once per worker isolate. */
export const parseTracesSampleRateOverride = (raw: string | undefined): number => {
  if (raw === undefined) {
    return 1;
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return 1;
  }
  // Number() is strict: rejects partial-numeric strings such as "0.5abc".
  // Number.isFinite excludes NaN and ±Infinity (which we treat as invalid
  // for the fallback case; out-of-range finite numbers clamp below).
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    warnOverrideOnce(raw, { reason: "non_finite", fallback: 1 });
    return 1;
  }
  if (parsed < 0) {
    warnOverrideOnce(raw, { reason: "below_zero", clamped: 0 });
    return 0;
  }
  if (parsed > 1) {
    warnOverrideOnce(raw, { reason: "above_one", clamped: 1 });
    return 1;
  }
  return parsed;
};

// Test-only export to reset the warn cache between cases.
export const __resetSentryOverrideWarnCache = (): void => {
  sentryOverrideWarnSeen.clear();
};

// ── Normalize full span name ("METHOD /path") ──────────────────────
/** Rewrite dynamic IDs in a span name to their template form.
 *  E.g. "GET /api/admin/customers/abc-123" → "GET /api/admin/customers/:id".
 *  Non-HTTP span names (e.g. "scheduled") pass through unchanged. */
export const normalizeSpanName = (name: string): string => {
  const spaceIndex = name.indexOf(" ");
  if (spaceIndex >= 0) {
    const method = name.slice(0, spaceIndex);
    const afterSpace = name.slice(spaceIndex + 1);
    if (afterSpace.startsWith("/")) {
      const normalized = normalizePathnameTemplate(afterSpace);
      return normalized === afterSpace ? name : `${method} ${normalized}`;
    }
    if (/^https?:\/\//.test(afterSpace)) {
      const attributes = { url: afterSpace };
      normalizeUrlAttribute(attributes, "url");
      return `${method} ${attributes.url}`;
    }
  }
  if (name.startsWith("/")) {
    return normalizePathnameTemplate(name);
  }
  return name;
};

// ── beforeSendTransaction — rewrite transaction names to templates ──
// This prevents raw customer UUIDs / reservation IDs from becoming
// unique transaction names in Sentry, which causes PII exposure and
// high-cardinality span grouping issues.
// Sentry SDK attribute names that carry a raw pathname.
const PATHNAME_ATTRS = ["http.target", "url.path"] as const;
// Sentry SDK attribute names that carry a full URL whose pathname needs rewriting.
// `url` is the bare key @sentry/cloudflare's fetch instrumentation writes
// alongside the namespaced ones; missing it left outbound URLs unnormalized.
const URL_ATTRS = ["url.full", "http.url", "url"] as const;
// Span-attribute keys whose values are raw cookie data. @sentry/cloudflare's
// wrapRequestHandler writes http.request.header.cookie.<name> onto the root HTTP span
// (and child spans) using the client dataCollection cookie deny-list — which only
// covers a small snippet set (cf_clearance / __cf_bm are NOT on it) and is independent
// of requestDataIntegration's include.cookies:false. So non-deny-listed cookie values
// survive to transaction attributes; redact them here (the transaction-path equivalent
// of include.cookies:false for error events). Sentry's normalizeAttributeKey lowercases
// and underscores header names, so set-cookie becomes set_cookie — match both the
// SDK-normalized underscore form and the literal hyphen form defensively.
const COOKIE_ATTR_PATTERN = /\.header\.(set[_-])?cookie(\.|$)/;

const normalizePathAttribute = (
  data: Record<string, unknown>,
  key: string
): void => {
  const value = data[key];
  if (typeof value === "string" && value.startsWith("/")) {
    const queryStart = value.indexOf("?");
    if (queryStart < 0) {
      data[key] = normalizePathnameTemplate(value);
      return;
    }
    const pathname = normalizePathnameTemplate(value.slice(0, queryStart));
    const request = { query_string: value.slice(queryStart + 1) };
    scrubSentryRequest(request);
    data[key] = `${pathname}?${request.query_string}`;
  }
};

const normalizeUrlAttribute = (
  data: Record<string, unknown>,
  key: string
): void => {
  const value = data[key];
  if (typeof value !== "string") {
    return;
  }
  try {
    const parsed = new URL(value);
    // Outbound push sends land here as span attributes (url.full / http.url).
    // The endpoint path is the per-device delivery token, so drop it and keep
    // only the push service origin.
    if (isPushServiceHost(parsed.hostname)) {
      data[key] = `${parsed.origin}/[REDACTED_PUSH_ENDPOINT]`;
      return;
    }
    const normalizedPath = normalizePathnameTemplate(parsed.pathname);
    if (normalizedPath !== parsed.pathname) {
      parsed.pathname = normalizedPath;
    }
    const request = { url: parsed.toString() };
    scrubSentryRequest(request);
    data[key] = request.url;
  } catch {
    // Malformed URL — leave as-is
  }
};

const normalizeAttributeBag = (data: Record<string, unknown> | undefined): void => {
  if (data === undefined || data === null || typeof data !== "object") {
    return;
  }
  for (const key of PATHNAME_ATTRS) {
    normalizePathAttribute(data, key);
  }
  for (const key of URL_ATTRS) {
    normalizeUrlAttribute(data, key);
  }
  for (const key of ["url.query", "http.query"]) {
    if (typeof data[key] !== "string") continue;
    const request = { query_string: data[key] };
    scrubSentryRequest(request);
    data[key] = request.query_string;
  }
  for (const key of Object.keys(data)) {
    const headerName = key.replace(/^http\.(?:request|response)\.header\./, "");
    if (COOKIE_ATTR_PATTERN.test(key) || isSensitiveContextKey(headerName)) {
      data[key] = "[REDACTED]";
    }
  }
};

// Route-path + trace-attribute normalization shared by BOTH the error
// (beforeSend) and transaction (beforeSendTransaction) pipelines: rewrite the
// dynamic IDs in the transaction name, request.url, and trace.data to route
// templates (and strip cookie span attributes via normalizeAttributeBag) so raw
// UUIDs / tokens / cookies never reach Sentry. Error events need this too now
// that the HTTP onError handler captures unhandled exceptions — those events
// flow through beforeSend (scrubSentryEvent), NOT beforeSendTransaction, and
// scrubSentryEvent only redacts emails/phones/secrets, never route IDs.
export const normalizeEventRoutePaths = <T extends ErrorEvent | TransactionEvent>(event: T): T => {
  if (typeof event.transaction === "string") {
    event.transaction = normalizeSpanName(event.transaction);
  }
  // @sentry/cloudflare populates event.request.url from the incoming Request,
  // so raw IDs land here even when the name/trace are otherwise scrubbed.
  if (event.request !== undefined && event.request !== null) {
    normalizeUrlAttribute(event.request as Record<string, unknown>, "url");
  }
  normalizeAttributeBag(event.contexts?.trace?.data as Record<string, unknown> | undefined);
  return event;
};

export const normalizeTransactionEvent = (event: TransactionEvent): TransactionEvent => {
  // Shared route normalization: transaction name + request.url + trace.data.
  normalizeEventRoutePaths(event);

  // beforeSend does not run for transactions; apply the same request boundary.
  scrubSentryRequest(event.request);

  // Rewrite child span descriptions + each span's data bag
  if (Array.isArray(event.spans)) {
    for (const span of event.spans) {
      if (typeof span.description === "string") {
        // An outbound fetch span is described as "POST <full url>", so the push
        // endpoint's delivery token needs stripping here too — normalizeSpanName
        // only rewrites our own route templates.
        span.description = redactPushEndpoints(normalizeSpanName(span.description));
      }
      normalizeAttributeBag(span.data as Record<string, unknown> | undefined);
    }
  }

  return event;
};

// beforeSend pipeline for error events. Normalize route IDs FIRST (on the clean
// URL / transaction) so the later PII scrub cannot corrupt the path before its
// route template matches: scrubSentryEvent's sanitizeValue strips
// `?access_token=` / Bearer / sync_token query strings and can mangle the path
// tail (e.g. `/profile?access_token=x` → `/profile[REDACTED]`), which would stop
// `/profile$` from matching and leave the raw ID in request.url. THEN scrub PII
// (emails / phones / secrets / body / cookies). The raw token lives only
// in-memory between the two steps and is redacted before the event is sent.
export const normalizeThenScrubErrorEvent = (event: ErrorEvent): ErrorEvent | null =>
  scrubSentryEvent(normalizeEventRoutePaths(event));

// ── Sentry SDK options builder ───────────────────────────────────────
const buildSentryOptions = (env: WorkerBindings) => {
  const override = parseTracesSampleRateOverride(env.SENTRY_TRACES_SAMPLE_RATE_OVERRIDE);
  return {
    dsn: env.SENTRY_DSN,
    environment: env.ENVIRONMENT,
    tracesSampler: (samplingContext: { name: string }) => {
      const baseRate = getBaseSampleRate(samplingContext.name);
      return baseRate * override;
    },
    sendDefaultPii: false,
    // Disable request BODY + COOKIE capture at the source. Two distinct
    // @sentry/cloudflare default integrations attach request PII regardless of
    // sendDefaultPii, so BOTH must be neutralized:
    //   1. httpServerIntegration reads the raw POST body into
    //      sdkProcessingMetadata.normalizedRequest.data (default maxRequestBodySize
    //      'medium' = 10KB). Set 'none' so the reservation body (name/phone/email)
    //      is never captured in the first place — source-level kill, no reliance on
    //      downstream include.data subtleties.
    //   2. requestDataIntegration copies normalizedRequest fields onto events.
    //      include:{data:false,cookies:false} drops the body + the cookie header
    //      from error events (event.request) and from requestData-driven spans. The
    //      user instance merges over the default ([...defaults,...user] +
    //      filterDuplicates keeps it; include merges field-wise) so url/headers stay
    //      for debugging.
    // NOTE: cookie values STILL reach transaction root-span attributes via
    // wrapRequestHandler -> httpHeadersToSpanAttributes (gated by the client
    // dataCollection cookie deny-list, which misses cf_clearance / __cf_bm), NOT by
    // include.cookies. normalizeTransactionEvent strips those
    // http.request.header.cookie.* attributes (see COOKIE_ATTR_PATTERN).
    // beforeSend + beforeSendTransaction also deep-scrub request.data defensively.
    integrations: [
      Sentry.httpServerIntegration({ maxRequestBodySize: "none" }),
      Sentry.requestDataIntegration({ include: { data: false, cookies: false } })
    ],
    // Normalize route IDs THEN scrub PII (see normalizeThenScrubErrorEvent). The
    // HTTP onError handler forwards unhandled exceptions here, so error events
    // carry the raw request URL + transaction that scrubSentryEvent alone does
    // not route-normalize (it would otherwise leak `/customers/<uuid>/...`).
    // SDK workflow instrumentation auto-captures final step attempts — tagless
    // duplicates of the workflow's own catch-block captures (which also cover
    // NonRetryableError / direct step.do rejections the SDK misses). Drop them
    // here before scrubbing; see dropSdkWorkflowEvent.
    beforeSend: (event: ErrorEvent): ErrorEvent | null =>
      dropSdkWorkflowEvent(event) === null ? null : normalizeThenScrubErrorEvent(event),
    beforeBreadcrumb: scrubSentryBreadcrumb,
    // Rewrite dynamic IDs in transaction/span names to route templates
    // so Sentry groups by route shape instead of raw IDs (PII + cardinality).
    beforeSendTransaction: (event: TransactionEvent): TransactionEvent =>
      normalizeTransactionEvent(event)
  };
};

// ── Sentry Crons monitor configuration ──────────────────────────────
// Each Cloudflare cron trigger registers an independent Sentry monitor
// so missed-run and runtime-exceeded alerts can be tuned per cadence.
// Slugs are kebab-case (Sentry constraint: [a-z0-9-_]{1,50}).
// timezone is "Etc/UTC" because wrangler.jsonc cron expressions run in UTC.
type CronMonitorEntry = {
  slug: string;
  config: Parameters<typeof Sentry.withMonitor>[2];
};

export const CRON_MONITOR_CONFIG: Readonly<Record<string, CronMonitorEntry>> = {
  "*/10 * * * *": {
    slug: "maintenance-10min",
    config: {
      schedule: { type: "crontab", value: "*/10 * * * *" },
      checkinMargin: 2,
      maxRuntime: 8,
      timezone: "Etc/UTC"
    }
  },
  // Offset to minute 3 (was minute 0) so this reminder cron never fires on the
  // same UTC minute as a */10 tick. At 19:00 UTC both landed in the maintenance
  // else branch and ran concurrently, so ensure_watch_channels' read-then-register
  // (no CAS) could double-register a watch channel. Minute 3 makes the collision
  // permanently impossible.
  "3 19 * * *": {
    slug: "reservation-reminder-dispatch",
    config: {
      schedule: { type: "crontab", value: "3 19 * * *" },
      checkinMargin: 5,
      maxRuntime: 10,
      timezone: "Etc/UTC"
    }
  },
  "0 11 * * *": {
    slug: "daily-ops-summary",
    config: {
      schedule: { type: "crontab", value: "0 11 * * *" },
      checkinMargin: 5,
      maxRuntime: 10,
      timezone: "Etc/UTC"
    }
  },
  // Dedicated daily cleanup cron (5 16 * * * UTC = 01:05 JST). Minute 5 so it
  // never collides with a */10 tick. Owns the heavy daily DELETE sweeps
  // (prune + retention) that previously ran on the 00:00 UTC (=09:00 JST) */10
  // tick. Larger maxRuntime than maintenance-10min because those DELETEs can be
  // large; the branch watchdog is DAILY_CLEANUP_WATCHDOG_MS (10 min) < this.
  "5 16 * * *": {
    slug: "daily-cleanup",
    config: {
      schedule: { type: "crontab", value: "5 16 * * *" },
      checkinMargin: 5,
      maxRuntime: 12,
      timezone: "Etc/UTC"
    }
  }
};

// ── maintenance-cron helpers ─────────────────────────────────────────

/**
 * Surfaces the first rejection from a Promise.allSettled fan-out as a throw,
 * logging every rejected subtask and capturing secondary culprits to Sentry so
 * operators see the full set of failures — not just the one rethrown.
 *
 * We surface only rejections[0] upward (one named cron failure for Cloudflare /
 * the Sentry monitor), but when several siblings fail at once the array-order
 * "first" may not be the earliest. Log EVERY rejected subtask so operators see
 * the full set of culprits, not just the one thrown.
 *
 * Only rejections[0] is rethrown (the single named cron failure for the Sentry
 * monitor). Capture the rest explicitly so secondary culprits aren't lost when
 * several subtasks fail together.
 *
 * Cloudflare-retryable D1 errors are soft-logged and dropped from the throw
 * path: cron work is idempotent and re-runs on the next 10-minute tick. A tick
 * holding only those returns without throwing, so `Sentry.withMonitor` records
 * an ok (GREEN) check-in; visibility there is the structured console.warn alone
 * (`event: "d1_export_locked"` / `"transient_d1"`). Known limit: no cross-tick
 * escalation for a prolonged outage — that needs state in D1/KV (consecutive-
 * failure count, or an alert wired to those log events). Genuine app failures
 * still throw (primary) / capture (secondary).
 */
export function surfaceMaintenanceCronRejections(
  settled: PromiseSettledResult<unknown>[],
  cronSpec: string
): void {
  const rejections = settled.filter(
    (r): r is PromiseRejectedResult => r.status === "rejected"
  );
  if (rejections.length === 0) return;
  // The two gates below are asymmetric on purpose. "Currently processing a
  // long-running export" is specific enough to match bare, and
  // isTransientD1Error also reads the `{ message }` plain objects a rethrow
  // produces — demanding a D1_ERROR prefix there would let the weekly export
  // turn the cron red. "Network connection lost" is generic (Google / LINE
  // subtasks land in this same array and can emit it), so those retryable
  // strings need proof of D1 origin or a non-D1 outage would green the cron.
  // Past the export-lock gate classifyD1SweepFailure stays the single source of
  // the retryable split, and a future fourth outcome fails the Record type here
  // instead of silently landing in write_failed. Export lock keeps its
  // historical log key so existing alerts stay wired.
  // Sentry RESERVATION-LINE-HOMEPAGE-D/E/F.
  const buckets: Record<
    ReturnType<typeof classifyD1SweepFailure>,
    PromiseRejectedResult[]
  > = { d1_export_locked: [], transient_d1: [], write_failed: [] };
  for (const rejection of rejections) {
    if (isTransientD1Error(rejection.reason)) {
      buckets.d1_export_locked.push(rejection);
      continue;
    }
    // readErrorMessage and not String(reason): a serialized / rethrown D1 error
    // arrives as a plain `{ message }` object, which would stringify to
    // "[object Object]" and lose the marker the gate below looks for. The
    // export-lock gate above already reads that shape through the same helper.
    if (!readErrorMessage(rejection.reason).includes("D1_ERROR")) {
      buckets.write_failed.push(rejection);
      continue;
    }
    buckets[classifyD1SweepFailure(rejection.reason)].push(rejection);
  }
  const {
    d1_export_locked: exportLocked,
    transient_d1: transientD1,
    write_failed: genuine
  } = buckets;
  if (exportLocked.length > 0) {
    console.warn("maintenance_cron_d1_export_locked", {
      event: "d1_export_locked",
      cron: cronSpec,
      subtasks: exportLocked.length
    });
  }
  if (transientD1.length > 0) {
    console.warn("maintenance_cron_transient_d1", {
      event: "transient_d1",
      cron: cronSpec,
      subtasks: transientD1.length,
      reasons: transientD1.map((r) => readErrorMessage(r.reason))
    });
  }
  if (genuine.length === 0) return;
  if (genuine.length > 1) {
    console.error("maintenance_cron_multiple_subtask_failures", {
      count: genuine.length,
      reasons: genuine.map((r) => readErrorMessage(r.reason))
    });
    for (const rejection of genuine.slice(1)) {
      safeCaptureException(
        rejection.reason instanceof Error
          ? rejection.reason
          : // readErrorMessage, matching the console.error above: a plain
            // { message } reason would otherwise reach Sentry as the literal
            // "[object Object]" while the log line next to it shows the real text.
            new Error(readErrorMessage(rejection.reason)),
        { tags: { component: "maintenance-cron", op: "subtask_failure_secondary", cron: cronSpec } }
      );
    }
  }
  throw genuine[0].reason;
}

// ── extracted handlers (named const for withSentry compat) ──────────

const scheduled: ExportedHandler<WorkerBindings>["scheduled"] = (controller, env, ctx) => {
  const cronSpec = controller.cron;
  const monitorEntry = CRON_MONITOR_CONFIG[cronSpec];
  if (isD1DrFreezeMaintenanceMode(env)) {
    const aggregateTasks = (): Promise<void> => {
      console.warn(JSON.stringify({
        event_type: "d1_dr_freeze_scheduled_noop",
        outcome: "noop",
        environment: typeof env.ENVIRONMENT === "string" ? env.ENVIRONMENT : "unknown",
        cron: cronSpec
      }));
      return Promise.resolve();
    };
    const aggregated = monitorEntry
      ? Sentry.withMonitor(monitorEntry.slug, aggregateTasks, monitorEntry.config)
      : aggregateTasks();
    ctx.waitUntil(aggregated);
    return aggregated;
  }

  const tasks: Promise<void>[] = [];

  // ── daily_ops_summary cron (0 11 * * * UTC = 20:00 JST) ──────────
  if (cronSpec === "0 11 * * *") {
    tasks.push(
      (async () => {
        // Each await is labeled-timeout wrapped (same as the maintenance branch)
        // so a stall fails fast WITH ITS NAME rather than as the generic
        // branch-level cron_watchdog_timeout.
        await withTaskTimeout(
          "expire_reservations",
          expireReservationsBeforeSideEffects(env.DB, { drain: false }),
          PRELUDE_TASK_TIMEOUT_MS
        );
        let opsEnqueued = 0;
        if (isDailyOpsSummaryDispatchEnabled(env)) {
          try {
            const result = await withTaskTimeout(
              "daily_ops_summary",
              dispatchDailyOpsSummary({
                db: env.DB,
                env,
                nowMs: Date.now()
              }),
              PRELUDE_TASK_TIMEOUT_MS
            );
            opsEnqueued = result.enqueued;
          } catch (error) {
            // B2: daily_ops_summary dispatcher-level failure
            console.error("daily_ops_summary_dispatch_failed", {
              error: error instanceof Error ? error.message : String(error)
            });
            safeCaptureException(error, {
              tags: { cron: cronSpec, dispatcher: "daily_ops_summary" }
            });
            throw error;
          }
        }
        if (opsEnqueued > 0) {
          // Refresh the quota snapshot before this (optional) dispatch path too, so
          // the budget guard reads current usage rather than the last maintenance
          // tick's. Best-effort: refreshLineQuotaSnapshot never throws, so only the
          // per-task timeout can reject — swallow it (with a Sentry breadcrumb) so
          // a stalled refresh does not abort the dispatch that follows.
          await withTaskTimeout(
            "refresh_quota",
            refreshLineQuotaSnapshot({ db: env.DB, env, now: Date.now }),
            PRELUDE_TASK_TIMEOUT_MS
          ).catch((error) => {
            safeCaptureException(error, {
              tags: { cron: cronSpec, task: "refresh_quota" }
            });
          });
          await withTaskTimeout(
            "line_notifications",
            processDueLineNotificationJobs({
              db: env.DB,
              env,
              maxJobs: Math.max(5, opsEnqueued + 5)
            }),
            CLAIM_TASK_TIMEOUT_MS
          );
        }
      })()
    );
  } else if (cronSpec === "5 16 * * *") {
    // ── daily-cleanup cron (5 16 * * * UTC = 01:05 JST) ─────────────
    // Owns the two heavy daily-idempotent DELETE sweeps that previously ran on
    // the 00:00 UTC (=09:00 JST) */10 tick (the chronic cron-hang spike). Each
    // is a top-level watchdog'd task: unlike the */10 path there are NO
    // critical siblings to protect, so a timeout/failure SHOULD surface
    // (`cron_task_timeout:<label>`) via the Sentry monitor rather than being
    // swallowed. NOTE: these D1 writes carry NO isTransientD1Error guard, which is
    // safe ONLY because the backup-verify export (`17 18 * * 0`, Sunday 18:17 UTC)
    // never overlaps 16:05 UTC. If backups become more frequent, extend the
    // export-lock soft-fail (see surfaceMaintenanceCronRejections) to this path.
    const importEnabled = isGoogleImportEnabled(env);
    tasks.push(
      withTaskTimeout(
        "prune_event_history",
        importEnabled
          ? pruneGoogleEventHistory({ db: env.DB }).then(() => undefined)
          : Promise.resolve(),
        DAILY_TASK_TIMEOUT_MS
      ),
      withTaskTimeout(
        "retention_sweep",
        runRetentionSweepPhase1({ db: env.DB }).then(() => undefined),
        DAILY_TASK_TIMEOUT_MS
      ),
      withTaskTimeout(
        "auto_complete_reservations",
        runAutoCompleteForCron({ db: env.DB, graceMs: AUTO_COMPLETE_GRACE_MS }),
        DAILY_TASK_TIMEOUT_MS
      ),
      // Low LINE quota alert. Deliberately NOT on the `0 11 * * *` summary cron:
      // that branch dispatches LINE pushes (processDueLineNotificationJobs, ≥5
      // jobs) in a sibling task, so a parallel alert reads usage from just before
      // those sends and a crossing of the threshold goes unreported until the next
      // day — burning most of the ten-message lead it exists to provide. Awaiting
      // it after that dispatch instead would push the branch past CRON_WATCHDOG_MS
      // (3*40s prelude + 270s claim leaves only 30s). This branch sends no LINE
      // messages at all, so the reading cannot be raced, and its failure semantics
      // already match the alert's: no critical siblings, so a rejection SHOULD
      // surface on the Sentry monitor. The `*/10` refresh keeps the snapshot ≤10
      // minutes old here, well inside LOW_QUOTA_SNAPSHOT_MAX_AGE_MS.
      withTaskTimeout("line_quota_alert", notifyLowLineQuota({ db: env.DB, env }), PER_TASK_TIMEOUT_MS)
    );
  } else {
    // ── maintenance cron (*/10 * * * * and 3 19 * * *) ──────────────
    // Each subtask is wrapped in withTaskTimeout so a stalled await fails fast
    // WITH ITS NAME (`cron_task_timeout:<label>`) instead of collapsing into the
    // generic 7-minute branch watchdog. The heavy daily prune/retention sweeps
    // moved to the dedicated daily-cleanup cron above; full_reconcile import is
    // deferred to a quiet window by enqueueGoogleCalendarMaintenanceJobs, so the
    // import subtask here normally claims only light incremental work.
    const importEnabled = isGoogleImportEnabled(env);
    if (!importEnabled) {
      console.warn(buildImportDisabledLog(env));
    }
    tasks.push(
      (async () => {
        await withTaskTimeout(
          "expire_reservations",
          expireReservationsBeforeSideEffects(env.DB, { drain: false }),
          PRELUDE_TASK_TIMEOUT_MS
        );

        let reminderEnqueued = 0;
        // B8: holds a reminder-dispatch failure until after the fan-out below,
        // which then re-throws it. The boolean is the sentinel, not the value:
        // `reminderDispatchError !== undefined` would read as "no failure" for a
        // `Promise.reject()` / `throw undefined`, swallowing the very failure
        // this stash exists to preserve.
        let reminderDispatchFailed = false;
        let reminderDispatchError: unknown;
        if (isReservationReminderDispatchEnabled(env)) {
          try {
            const result = await withTaskTimeout(
              "reservation_reminders",
              dispatchReservationReminders(env.DB, Date.now()),
              PRELUDE_TASK_TIMEOUT_MS
            );
            reminderEnqueued = result.enqueued;
          } catch (error) {
            // B8: reservation_reminder dispatcher-level failure. Throwing HERE
            // would skip the Promise.allSettled fan-out below (import_jobs,
            // line_notifications, calendar_sync and five more), silently dropping
            // this tick's entire queue drain. Stash it and re-throw after the
            // fan-out so the cron still goes red without costing the siblings.
            console.error("reservation_reminder_dispatch_failed", {
              error: error instanceof Error ? error.message : String(error)
            });
            safeCaptureException(error, {
              tags: { cron: cronSpec, dispatcher: "reservation_reminder" }
            });
            reminderDispatchFailed = true;
            reminderDispatchError = error;
          }
        }

        const lineMaxJobs = Math.min(500, Math.max(5, reminderEnqueued + 5));

        // Refresh the LINE monthly-quota snapshot BEFORE dispatch so the budget
        // guard reads this tick's usage, not the previous tick's. Best-effort:
        // refreshLineQuotaSnapshot returns null on any failure and never throws,
        // so the ONLY rejection here is the per-task timeout. Swallow that timeout
        // (with a Sentry breadcrumb) so a stalled quota refresh is BOUNDED without
        // aborting this tick's notification dispatch — dispatch then falls back to
        // the prior snapshot (missing/unknown limit ⇒ Infinity headroom =
        // availability over accuracy). Preserves the original non-blocking
        // contract while still capping the stall. (Free quota API, not a send.)
        await withTaskTimeout(
          "refresh_quota",
          refreshLineQuotaSnapshot({ db: env.DB, env, now: Date.now }),
          PRELUDE_TASK_TIMEOUT_MS
        ).catch((error) => {
          safeCaptureException(error, {
            tags: { cron: cronSpec, task: "refresh_quota" }
          });
        });

        // Promise.allSettled (NOT Promise.all): a light sibling timing out at
        // its 90s budget must NOT fail-fast the aggregate and let the runtime
        // tear down a slower-but-legitimate sibling (e.g. a large LINE dispatch
        // still running under its 270s claim budget) — that would orphan
        // claimed jobs until lock expiry and risk a duplicate send. Every
        // sibling is independently bounded by its own withTaskTimeout, so we let
        // them all settle and THEN surface the first rejection (still named).
        const settled = await Promise.allSettled([
          // Admin Web Push for approvals whose deadline is inside the next hour.
          // A CONCURRENT sibling, not a prelude await: the prelude budgets stack
          // ahead of the claim fan-out (MAX_SEQUENTIAL_PRELUDE_TASKS in
          // cron-watchdog.ts), so a fourth one there would push a claim
          // dispatcher past the branch watchdog. Best-effort: swallowed here
          // rather than surfaced, because unlike its siblings this has no queue
          // and no retry behind it and must not fail the tick.
          withTaskTimeout(
            "admin_push_expiring",
            dispatchExpiringApprovalPush(env, env.DB, Date.now()).then(() => undefined),
            PER_TASK_TIMEOUT_MS
          ).catch((error: unknown) => {
            safeCaptureException(error, {
              tags: { cron: cronSpec, dispatcher: "admin_push_expiring" }
            });
          }),
          withTaskTimeout(
            "ensure_watch_channels",
            importEnabled
              ? ensureGoogleCalendarWatchChannels({ db: env.DB, env }).then(() => undefined)
              : Promise.resolve(),
            PER_TASK_TIMEOUT_MS
          ),
          withTaskTimeout(
            "enqueue_maintenance_jobs",
            importEnabled
              ? enqueueGoogleCalendarMaintenanceJobs({ db: env.DB }).then(() => undefined)
              : Promise.resolve(),
            PER_TASK_TIMEOUT_MS
          ),
          withTaskTimeout(
            "import_jobs",
            importEnabled
              ? processDueGoogleCalendarImportJobs({ db: env.DB, env }).then(() => undefined)
              : Promise.resolve(),
            CLAIM_TASK_TIMEOUT_MS
          ),
          withTaskTimeout(
            "detect_conflict_bursts",
            importEnabled
              ? detectConflictBursts({ db: env.DB, env, nowMs: Date.now() })
              : Promise.resolve(),
            PER_TASK_TIMEOUT_MS
          ),
          withTaskTimeout(
            "calendar_sync",
            processDueCalendarSyncJobs({ db: env.DB, env }),
            CLAIM_TASK_TIMEOUT_MS
          ),
          withTaskTimeout(
            "line_notifications",
            processDueLineNotificationJobs({ db: env.DB, env, maxJobs: lineMaxJobs }),
            CLAIM_TASK_TIMEOUT_MS
          )
        ]);
        surfaceMaintenanceCronRejections(settled, cronSpec);
        // Re-throw the stashed reminder failure now that every sibling has run.
        // Kept OUT of `settled[]` on purpose: entering that array would subject it
        // to the classifyD1SweepFailure soft-skip (export lock + transient D1 infra
        // errors) and let a reminder failure during those windows be swallowed.
        // Thrown here it propagates exactly as before — cron red, Sentry monitor
        // check-in failed. Reminder failures must never soft-skip.
        //
        // Deliberately AFTER surfaceMaintenanceCronRejections: if a sibling also
        // failed, that one becomes the surfaced reason and this line never runs.
        // Throwing first would skip the sibling secondary captures inside it, and
        // the reminder failure is already in Sentry from the catch above (tagged
        // dispatcher: reservation_reminder), so nothing is lost by yielding here.
        if (reminderDispatchFailed) {
          throw reminderDispatchError;
        }
      })()
    );
  }

  // B3: aggregate all cron branch tasks; withSentry uses the returned
  // promise to keep the Sentry client alive until work completes.
  // The watchdog races the aggregation so a stalled outbound await fails
  // fast instead of holding the invocation to the 15-minute wall limit
  // (root cause of the intermittent */10 exceededCpu kills). The
  // "surface the first rejection" semantics are preserved. Per-cron budget:
  // the daily-cleanup cron's prune/retention DELETEs get a larger window than
  // the */10 hot path; both stay under the Cloudflare 15-minute wall.
  const watchdogMs =
    cronSpec === "5 16 * * *" ? DAILY_CLEANUP_WATCHDOG_MS : CRON_WATCHDOG_MS;
  const aggregateTasks = (): Promise<void> =>
    runTasksWithWatchdog(tasks, cronSpec, watchdogMs);

  // B9: wrap with Sentry.withMonitor when the cron spec is registered so
  // Sentry Crons receives in_progress/ok/error check-ins for uptime
  // monitoring. SDK no-ops when DSN is empty.
  const aggregated = monitorEntry
    ? Sentry.withMonitor(monitorEntry.slug, aggregateTasks, monitorEntry.config)
    : aggregateTasks();
  ctx.waitUntil(aggregated);
  return aggregated;
};

const queue: ExportedHandler<WorkerBindings>["queue"] = async (batch, env) => {
  try {
    const queueKind = classifyReservationQueue(batch.queue);
    if (!queueKind) {
      throw new Error(`unsupported_queue:${batch.queue.slice(0, 128)}`);
    }

    if (queueKind === "dead_letter") {
      // DLQ滞留アラート: a message reaching the DLQ means a job kick was
      // retried to exhaustion. D1 rows remain the source of truth (the cron
      // sweep re-processes due jobs), so the DLQ message itself is only a
      // signal — surface it loudly, then ack so the queue cannot silently
      // accumulate until retention expiry. Message bodies are NOT logged
      // (they may reference job/recipient identifiers).
      console.error("queue_dead_letter_messages", {
        queue: batch.queue,
        messageCount: batch.messages.length
      });
      safeCaptureException(new Error(`queue_dead_letter_messages:${batch.queue}`), {
        tags: { queue: batch.queue, handler: "queue_dlq" },
        contexts: { dlq: { message_count: batch.messages.length } }
      });
      batch.ackAll();
      return;
    }

    if (isD1DrFreezeMaintenanceMode(env)) {
      console.warn(JSON.stringify({
        event_type: "d1_dr_freeze_queue_retry",
        outcome: "retry",
        environment: typeof env.ENVIRONMENT === "string" ? env.ENVIRONMENT : "unknown",
        queue: batch.queue,
        message_count: batch.messages.length,
        delay_seconds: D1_DR_FREEZE_RETRY_DELAY_SECONDS
      }));
      batch.retryAll({ delaySeconds: D1_DR_FREEZE_RETRY_DELAY_SECONDS });
      return;
    }

    await expireReservationsBeforeSideEffects(env.DB);

    if (queueKind === "google_sync") {
      if (isGoogleImportEnabled(env)) {
        await processDueGoogleCalendarImportJobs({
          db: env.DB,
          env,
          maxJobs: batch.messages.length
        });
      }
      await processDueCalendarSyncJobs({
        db: env.DB,
        env,
        maxJobs: batch.messages.length
      });
    }
    if (queueKind === "line_notifications") {
      await processDueLineNotificationJobs({
        db: env.DB,
        env,
        maxJobs: batch.messages.length
      });
    }
    batch.ackAll();
  } catch (error) {
    if (isTransientD1Error(error)) {
      // A long-running D1 export (the backup-verify workflow's weekly `wrangler
      // d1 export`) briefly rejects every D1 write on this database. Retry the
      // batch after it clears instead of capturing — the same soft-fail contract
      // the cron path uses, mirroring the D1-freeze branch above. Without this the
      // export would open a NEW Sentry issue under handler:"queue". Sentry
      // RESERVATION-LINE-HOMEPAGE-D.
      console.warn("queue_d1_export_locked", {
        event: "d1_export_locked",
        queue: batch.queue,
        delay_seconds: D1_DR_FREEZE_RETRY_DELAY_SECONDS
      });
      batch.retryAll({ delaySeconds: D1_DR_FREEZE_RETRY_DELAY_SECONDS });
      return;
    }
    // B4: queue handler top-level catch — capture then RETHROW so
    // Cloudflare Queues retry/DLQ semantics are maintained.
    safeCaptureException(error, {
      tags: { queue: batch.queue, handler: "queue" }
    });
    throw error;
  }
};

// Workflows are separately exported classes — withSentry only wraps the default
// handler, so without this instrumentation any Sentry capture inside the
// workflow runs on an uninitialized client and is silently dropped.
export const ReservationConfirmWorkflow = Sentry.instrumentWorkflowWithSentry(
  (env: WorkerBindings) => buildSentryOptions(env),
  ReservationConfirmWorkflowBase
);
// worker-configuration.d.ts resolves `import("./index").ReservationConfirmWorkflow`
// in TYPE position (RESERVATION_WORKFLOW binding payload); the const above only
// exports the value, and skipLibCheck would hide the silent type degradation.
export type ReservationConfirmWorkflow = ReservationConfirmWorkflowBase;

export default Sentry.withSentry(
  (env: WorkerBindings) => buildSentryOptions(env),
  { fetch: handleFetch, scheduled, queue } satisfies ExportedHandler<WorkerBindings>
);
