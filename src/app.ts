import { Hono } from "hono";
import { INSTANCE_CONFIG } from "./instance-config";

import type { AppEnvironment } from "./routes/types";
import { d1SessionMiddleware } from "./middleware/d1-session";
import { publicRoutes } from "./routes/public";
import { adminApiRoutes } from "./routes/admin-api";
import { adminPageRoutes } from "./routes/admin-pages";
import { customerPageRoutes } from "./routes/customer-pages";
import { googleRoutes } from "./routes/google";
import { lineRoutes } from "./routes/line";
import {
  ADMIN_SPA_CSP,
  ADMIN_SW_CSP,
  PUBLIC_LIFF_CSP,
  STRICT_CSP,
  withFreshCspNonce
} from "./security-headers";
import { isTransientD1Error } from "./outbound-timeout";
import { safeCaptureException } from "./sentry-helpers";
import { matchPathnameTemplate } from "./sentry-path-templates";

export const ADMIN_HOSTNAME = INSTANCE_CONFIG.adminHostname;

export const isAdminPrivatePath = (path: string) => {
  // /admin-next (the retired transitional alias) is intentionally absent here: it is
  // 404'd at the worker entrypoint (handleFetch, decode-aware) before these predicates
  // run, so it never needs to be admin-scoped for routing or private-header purposes.
  return path === "/admin" || path.startsWith("/admin/") ||
    path === "/admin-app" || path.startsWith("/admin-app/") ||
    path === "/api/admin" || path.startsWith("/api/admin/");
};

export const isAdminHost = (host: string | null | undefined): boolean => {
  if (typeof host !== "string") return false;
  const lower = host.toLowerCase();
  const colonIdx = lower.indexOf(":");
  const hostnameOnly = colonIdx >= 0 ? lower.slice(0, colonIdx) : lower;
  return hostnameOnly === ADMIN_HOSTNAME;
};

const isPublicReservationPrivatePath = (path: string) => {
  return (
    path === "/api/public/reservation-options" ||
    path === "/api/public/availability" ||
    path === "/api/public/reservation-gate" ||
    path === "/api/public/reservations" ||
    path === "/api/public/my-reservations"
  );
};

const isPrivateResponsePath = (path: string) => {
  return isAdminPrivatePath(path) || isPublicReservationPrivatePath(path);
};

const logUnhandledApplicationError = (error: unknown) => {
  // Deliberately log ONLY a category discriminator — never the error message or
  // stack. Unhandled errors here are frequently raw D1/upstream failures whose
  // text can embed secrets or PII (tokens, connection details, customer data),
  // and Cloudflare Logs is not a PII-safe sink. Guarded by the test
  // "does not log secret values from unexpected admin API errors" — do not add
  // message/stack fields here.
  console.error("Unhandled application error", {
    category: error instanceof Error ? "error" : typeof error
  });
};

const SECURITY_HEADERS = {
  "Content-Security-Policy": STRICT_CSP,
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY"
};

const PRIVATE_RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  Pragma: "no-cache"
};

const PUBLIC_LIFF_CSP_PATHS: ReadonlySet<string> = new Set(["/customer/reservations"]);

const isHtmlGetResponse = (c: {
  req: { method: string };
  res: { status: number; headers: Headers };
}) => {
  if (c.req.method !== "GET" || c.res.status !== 200) return false;
  const contentType = c.res.headers.get("Content-Type");
  return typeof contentType === "string" && contentType.startsWith("text/html");
};

// The admin React SPA is now served from `/admin` and `/admin/*` (PR1 of the /admin canonical
// migration). The CSP must match the SPA's loader needs — same allow-list previously applied
// to `/admin-next`.
const shouldUseAdminSpaCsp = (c: {
  req: { path: string; method: string };
  res: { status: number; headers: Headers };
}) => (c.req.path === "/admin" || c.req.path.startsWith("/admin/")) && isHtmlGetResponse(c);

const shouldUsePublicLiffCsp = (c: {
  req: { path: string; method: string };
  res: { status: number; headers: Headers };
}) => PUBLIC_LIFF_CSP_PATHS.has(c.req.path) && isHtmlGetResponse(c);

export function createApp() {
  const app = new Hono<AppEnvironment>();

  app.use("*", async (c, next) => {
    await next();
    const useAdminSpaCsp = shouldUseAdminSpaCsp(c);
    const usePublicLiffCsp = shouldUsePublicLiffCsp(c);
    // The service worker's CSP is the one on the RESPONSE THAT SERVES ITS
    // SCRIPT, not the SPA page's — under STRICT_CSP its in-worker
    // `pushsubscriptionchange` re-registration fetch would be blocked.
    const useAdminSwCsp = c.req.path === "/admin/sw.js";
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (name === "Content-Security-Policy" && useAdminSpaCsp) {
        c.header(name, withFreshCspNonce(ADMIN_SPA_CSP));
      } else if (name === "Content-Security-Policy" && usePublicLiffCsp) {
        c.header(name, withFreshCspNonce(PUBLIC_LIFF_CSP));
      } else if (name === "Content-Security-Policy" && useAdminSwCsp) {
        c.header(name, ADMIN_SW_CSP);
      } else {
        c.header(name, value);
      }
    }
    if (isPrivateResponsePath(c.req.path)) {
      for (const [name, value] of Object.entries(PRIVATE_RESPONSE_HEADERS)) {
        c.header(name, value);
      }
    }
  });

  app.onError((error, c) => {
    // Surface unhandled HTTP exceptions to Sentry. The @sentry/cloudflare
    // withSentry wrapper never observes these — Hono catches the rejection
    // here before it can propagate to the worker handler — so without this
    // explicit capture every unhandled route error is invisible in Sentry,
    // unlike the queue/scheduled handlers which call safeCaptureException
    // directly. The `route` tag is set ONLY to a known route template (API
    // routes → `:id`, admin SPA deep-links → `/admin/*`); Sentry tags are NOT
    // run through the beforeSend PII scrubber, so a genuinely untemplated path
    // is dropped rather than leaking a raw UUID/token into telemetry. The
    // scrubbed request.url still carries the full path for those cases.
    const routeTemplate = matchPathnameTemplate(c.req.path);
    safeCaptureException(error, {
      tags: {
        method: c.req.method,
        ...(routeTemplate ? { route: routeTemplate } : {})
      },
      // Request boundary: a D1 export-lock here is a RAW 500 a customer/admin
      // sees right now, not unattended background noise — opt out of the
      // transient-D1 suppression so it stays visible. Sentry RESERVATION-LINE-HOMEPAGE-D.
      captureTransientD1: true
    });
    logUnhandledApplicationError(error);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      c.header(name, value);
    }

    if (isPrivateResponsePath(c.req.path)) {
      for (const [name, value] of Object.entries(PRIVATE_RESPONSE_HEADERS)) {
        c.header(name, value);
      }
    }

    if (c.req.path.startsWith("/admin")) {
      return c.html("<!doctype html><title>Error</title><h1>Internal Server Error</h1>", 500, PRIVATE_RESPONSE_HEADERS);
    }

    if (isPrivateResponsePath(c.req.path)) {
      return c.json({ error: "internal_server_error" }, 500, PRIVATE_RESPONSE_HEADERS);
    }

    return c.json({ error: "internal_server_error" }, 500);
  });

  // Liveness + D1 reachability. Distinct from the MAINTENANCE_MODE=d1-dr-freeze
  // 503 sentinel in src/index.ts (pre-Hono gate for intentional DR freeze).
  app.get("/api/health", async (c) => {
    const base = {
      service: "reservation-line-homepage",
      environment: c.env.ENVIRONMENT ?? "unknown",
      specVersion: c.env.SPEC_VERSION ?? "v1.5-draft"
    };

    const db = c.env.DB as D1Database | undefined;
    // Same defensive guard as d1SessionMiddleware: skip probe when binding absent
    // (unit tests / local stubs without DB still get 200).
    if (db && typeof db.prepare === "function") {
      try {
        await db.prepare("SELECT 1").first();
      } catch (error) {
        // The weekly D1 export lock is brief (recent production exports: 9–17s).
        // Keep HTTP 200 / ok:true so runtime verification and deploy smoke do not
        // fail, but expose a fixed warning that the independent uptime Worker can
        // promote only when it survives two five-minute monitor runs.
        if (!isTransientD1Error(error)) {
          return c.json({ ok: false, status: "fail", ...base, reason: "d1_unreachable" }, 503);
        }
        c.header("X-SDJ-Health-Status", "warn");
        return c.json({ ok: true, status: "warn", ...base, reason: "d1_export_locked" });
      }
    }

    return c.json({ ok: true, status: "pass", ...base });
  });

  app.get("/api/version", (c) => {
    return c.json({
      specVersion: c.env.SPEC_VERSION ?? "v1.5-draft"
    });
  });

  app.use("*", d1SessionMiddleware());

  app.route("/api/public", publicRoutes);
  app.route("/api/line", lineRoutes);
  app.route("/api/google", googleRoutes);
  app.route("/api/admin", adminApiRoutes);
  app.route("", adminPageRoutes);
  app.route("", customerPageRoutes);

  app.notFound((c) => {
    return c.json(
      {
        error: "not_found"
      },
      404
    );
  });

  return app;
}
