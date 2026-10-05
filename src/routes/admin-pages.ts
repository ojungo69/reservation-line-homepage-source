import { Hono, type Context } from "hono";
import type { AppEnvironment } from "./types";
import { ADMIN_PRIVATE_HEADERS, statusForAdminAuthResult } from "./shared";
import { authenticateAdmin } from "../admin/access";
import { ADMIN_SPA_CSP } from "../security-headers";

export const adminPageRoutes = new Hono<AppEnvironment>();

// React SPA serving at /admin and /admin/*
//
// PR1 of the /admin canonical URL migration: the React SPA, previously mounted
// at /admin-next, now owns the whole /admin namespace. The legacy SSR route
// handlers (renderFullAdminDashboard, the staff page, the /admin/sync 301)
// have been removed — their old code paths are preserved in git history. The
// SPA's React Router handles every sub-path client-side.
//
// Hono matches in registration order, so the /admin and /admin/* SPA routes
// must be the only /admin* page routes in this file. /admin-next (the legacy
// transitional alias, retired in Phase 5) is NOT handled here — it is 404'd at
// the worker entrypoint (src/index.ts handleFetch), because Hono's /admin/*
// wildcard shadows /admin-next/* in the workerd runtime.

const ADMIN_SPA_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
  "Content-Security-Policy": ADMIN_SPA_CSP,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

const serveAdminSpa = async (c: Context<AppEnvironment>) => {
  // Skip auth for local development so the SPA can load without Cloudflare Access
  const isLocal = c.env.ENVIRONMENT === "local";
  if (!isLocal) {
    const auth = await authenticateAdmin({
      token: c.req.header("Cf-Access-Jwt-Assertion") ?? undefined,
      env: c.env,
    });
    if (!auth.ok) {
      return c.json({ ok: false, error: auth.reason }, statusForAdminAuthResult(auth), ADMIN_PRIVATE_HEADERS);
    }
  }

  if (!c.env.ASSETS) {
    return c.html("<!doctype html><title>エラー</title><h1>アセット配信が設定されていません</h1>", 500, ADMIN_PRIVATE_HEADERS);
  }

  const origin = new URL(c.req.url).origin;
  const assetUrl = new URL("/admin-app/index.html", origin);
  const assetResponse = await c.env.ASSETS.fetch(new Request(assetUrl));

  const html = await assetResponse.text();

  if (!assetResponse.ok || !html.includes("admin-spa-sentinel")) {
    return c.html("<!doctype html><title>エラー</title><h1>管理画面を読み込めません</h1><p>ビルドが必要です: npm run admin:build</p>", 500, ADMIN_PRIVATE_HEADERS);
  }

  return c.html(html, 200, ADMIN_SPA_HEADERS);
};

// PWA assets (service worker + web app manifest)
//
// Served from /admin/ rather than /admin-app/ so the service worker's default
// scope is /admin/ — the SPA's own namespace — without needing a
// Service-Worker-Allowed header.
//
// These MUST be registered before the /admin/* SPA route below: Hono matches in
// registration order, so the wildcard would otherwise answer with index.html and
// the browser would reject sw.js on its MIME type.

const serveAdminPwaAsset = async (
  c: Context<AppEnvironment>,
  assetPath: string,
  contentType: string
) => {
  if (!c.env.ASSETS) {
    return c.text("assets binding is not configured", 500, ADMIN_PRIVATE_HEADERS);
  }

  const assetUrl = new URL(assetPath, new URL(c.req.url).origin);
  const assetResponse = await c.env.ASSETS.fetch(new Request(assetUrl));
  const body = await assetResponse.text();

  // `not_found_handling: single-page-application` answers 200 with the CUSTOMER
  // index.html for any asset that does not exist — which is exactly the state of
  // a deploy that skipped `npm run admin:build`. Serving that HTML under
  // Content-Type: text/javascript makes the service worker fail to register with
  // a parse error that points nowhere. Reject anything HTML-shaped instead; the
  // SPA route does the same with its admin-spa-sentinel check.
  if (!assetResponse.ok || body.trimStart().startsWith("<")) {
    return c.text("not found", 404, ADMIN_PRIVATE_HEADERS);
  }

  // No admin authentication here: neither file carries anything private, and the
  // browser fetches both outside the SPA's own request flow. On the admin host
  // Cloudflare Access still gates them at the edge, the same way it already does
  // for /admin-app/assets/*.js.
  return c.body(body, 200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });
};

adminPageRoutes.get("/admin/sw.js", (c) =>
  serveAdminPwaAsset(c, "/admin-app/sw.js", "text/javascript; charset=utf-8")
);

adminPageRoutes.get("/admin/manifest.webmanifest", (c) =>
  serveAdminPwaAsset(c, "/admin-app/manifest.webmanifest", "application/manifest+json; charset=utf-8")
);

adminPageRoutes.get("/admin", serveAdminSpa);
adminPageRoutes.get("/admin/*", serveAdminSpa);

// NOTE: /admin-next (retired in Phase 5) is 404'd at the worker entrypoint
// (src/index.ts handleFetch), NOT here. Hono's /admin/* wildcard shadows
// /admin-next/* in the workerd runtime, so in-Hono handling would be silently
// overridden by serveAdminSpa. The entrypoint 404 is deterministic.
