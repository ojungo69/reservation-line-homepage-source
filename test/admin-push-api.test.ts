import { generateVAPIDKeys } from "web-push-neo";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import {
  createAccessJwtFixture,
  createAccessSigningKey,
  requestUrl,
  type AccessJwtFixture,
} from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

// HTTP wiring for the admin Web Push routes. Handlers are exercised through
// app.request() rather than being called directly: the failure this guards
// against is a ROUTING one — /admin/* shadowing the service-worker path, or a
// future `:id` route swallowing the /notifications/push/* prefix — which a
// direct handler call cannot see (the available-slots 404 incident).

const TEAM_DOMAIN = "https://team.example.cloudflareaccess.com";
const ACCESS_AUD = "admin-push-aud";
const OWNER_EMAIL = "owner@example.com";
const OWNER_SUBJECT = "access_sub_owner_push";

const APPLE_ENDPOINT = "https://web.push.apple.com/QAAAAA_api_test";
// Generated / derived rather than pasted: registration imports p256dh, so it has
// to be a genuine 65-byte P-256 point, and a random-looking literal here reads
// as a real secret to a scanner. auth is any 16 bytes.
const AUTH = btoa("test-auth-secret").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
let P256DH = "";

beforeAll(async () => {
  P256DH = (await generateVAPIDKeys()).publicKey;
});

const mintFixture = (): AccessJwtFixture =>
  createAccessJwtFixture({
    issuer: TEAM_DOMAIN,
    audience: ACCESS_AUD,
    keyId: "admin-push-key-1",
    signingKey: createAccessSigningKey("admin-push-key-1"),
    claims: { email: OWNER_EMAIL, sub: OWNER_SUBJECT },
  });

/** JWKS fetch for Access, plus a push service that accepts everything. */
const stubOutbound = (jwk: AccessJwtFixture["jwk"]) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === `${TEAM_DOMAIN}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
      if (url.startsWith("https://web.push.apple.com/")) return new Response(null, { status: 201 });
      return Response.json({ message: "unexpected" }, { status: 404 });
    })
  );
};

/** ASSETS stub standing in for the built admin-app output. */
const assetsStub = (files: Record<string, string>) => ({
  fetch: async (request: Request) => {
    const path = new URL(request.url).pathname;
    const body = files[path];
    if (body === undefined) {
      // Mirrors `not_found_handling: single-page-application`: a missing asset
      // answers 200 with the CUSTOMER shell, which is exactly the state of a
      // deploy that skipped `npm run admin:build`.
      return new Response("<!doctype html><html><body>customer shell</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }
    return new Response(body, { status: 200 });
  },
});

describe("admin web push API", () => {
  let db: SqliteD1Database;
  let fixture: AccessJwtFixture;

  const env = (overrides: Record<string, unknown> = {}) => ({
    ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
    ACCESS_AUD,
    DB: db,
    VAPID_PUBLIC_KEY: "test-public-key",
    ...overrides,
  });

  const request = (path: string, init: RequestInit = {}, overrides: Record<string, unknown> = {}) => {
    const app = createApp();
    const headers = new Headers(init.headers);
    if (!headers.has("Cf-Access-Jwt-Assertion")) headers.set("Cf-Access-Jwt-Assertion", fixture.token);
    if (init.body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    return app.request(path, { ...init, headers }, env(overrides));
  };

  beforeEach(() => {
    db = createMigratedSqliteD1();
    db.sqlite
      .prepare(
        `INSERT INTO admin_users (id, email, access_subject, role, active, updated_at)
         VALUES ('admin_owner_push', ?, ?, 'owner', 1, '2026-07-27T00:00:00.000Z')`
      )
      .run(OWNER_EMAIL, OWNER_SUBJECT);
    fixture = mintFixture();
    stubOutbound(fixture.jwk);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers a device and is idempotent for the same endpoint", async () => {
    const body = JSON.stringify({ endpoint: APPLE_ENDPOINT, p256dh: P256DH, auth: AUTH });
    expect((await request("/api/admin/notifications/push/subscriptions", { method: "POST", body })).status).toBe(200);
    expect((await request("/api/admin/notifications/push/subscriptions", { method: "POST", body })).status).toBe(200);

    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM admin_push_subscriptions").get()).toEqual({
      n: 1,
    });
  });

  it("rejects an endpoint that is not a known push service", async () => {
    const response = await request("/api/admin/notifications/push/subscriptions", {
      method: "POST",
      body: JSON.stringify({
        endpoint: "https://attacker.example.com/collect",
        p256dh: P256DH,
        auth: AUTH,
      }),
    });

    expect(response.status).toBe(400);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM admin_push_subscriptions").get()).toEqual({
      n: 0,
    });
  });

  it("requires authentication", async () => {
    const app = createApp();
    const response = await app.request(
      "/api/admin/notifications/push/subscriptions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: APPLE_ENDPOINT, p256dh: P256DH, auth: AUTH }),
      },
      env()
    );

    expect([401, 403]).toContain(response.status);
  });

  it("blocks a cross-site submission (CSRF middleware is applied to the new routes)", async () => {
    const response = await request("/api/admin/notifications/push/subscriptions", {
      method: "POST",
      headers: { "Sec-Fetch-Site": "cross-site" },
      body: JSON.stringify({ endpoint: APPLE_ENDPOINT, p256dh: P256DH, auth: AUTH }),
    });

    expect(response.status).toBe(403);
  });

  it("unsubscribes and test-sends the caller's own devices", async () => {
    const body = JSON.stringify({ endpoint: APPLE_ENDPOINT, p256dh: P256DH, auth: AUTH });
    await request("/api/admin/notifications/push/subscriptions", { method: "POST", body });

    const test = await request("/api/admin/notifications/push/test", { method: "POST" });
    expect(test.status).toBe(200);
    // No VAPID private key in this env, so nothing is actually sent.
    expect(await test.json()).toEqual({ ok: true, devices: 1, sent: 0 });

    const off = await request("/api/admin/notifications/push/unsubscribe", {
      method: "POST",
      body: JSON.stringify({ endpoint: APPLE_ENDPOINT }),
    });
    expect(off.status).toBe(200);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM admin_push_subscriptions").get()).toEqual({
      n: 0,
    });
  });

  it("rejects keys that are not the sizes Web Push encryption needs", async () => {
    const response = await request("/api/admin/notifications/push/subscriptions", {
      method: "POST",
      body: JSON.stringify({ endpoint: APPLE_ENDPOINT, p256dh: P256DH.slice(0, 40), auth: AUTH }),
    });

    expect(response.status).toBe(400);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM admin_push_subscriptions").get()).toEqual({
      n: 0,
    });
  });

  it("hands the SPA the VAPID public key on /me", async () => {
    const response = await request("/api/admin/me", {}, {
      VAPID_PRIVATE_KEY: "test-private-key",
      OPERATIONS_NOTIFICATION_EMAIL: "ops@example.com",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, vapidPublicKey: "test-public-key" });
  });

  // Registering a device against an environment that cannot sign would leave the
  // UI reporting "subscribed" for a device that never hears anything.
  it("withholds the key when the environment cannot actually send", async () => {
    const response = await request("/api/admin/me");
    expect(await response.json()).toMatchObject({ ok: true, vapidPublicKey: "" });
  });

  describe("PWA assets", () => {
    const ASSETS = assetsStub({
      "/admin-app/sw.js": "self.addEventListener('push', () => {});",
      "/admin-app/manifest.webmanifest": '{"name":"管理画面","display":"standalone"}',
    });

    it("serves the service worker as JavaScript, not the SPA shell", async () => {
      const response = await request("/admin/sw.js", { method: "GET" }, { ASSETS });

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/javascript");
      const body = await response.text();
      expect(body).toContain("addEventListener");
      expect(body).not.toContain("<!doctype html");
      // The worker gets its own CSP: locked down like STRICT_CSP except for
      // connect-src 'self', which the in-worker pushsubscriptionchange
      // re-registration fetch needs. Exact match on purpose — a containment
      // check would keep passing if connect-src were ever widened beyond
      // 'self', and if connect-src disappeared the handler would fail silently
      // at runtime with no build-time error.
      expect(response.headers.get("Content-Security-Policy")).toBe(
        "default-src 'none'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
      );
    });

    it("does not widen the CSP for the manifest, only for the worker script", async () => {
      const response = await request(
        "/admin/manifest.webmanifest",
        { method: "GET" },
        { ASSETS }
      );
      expect(response.headers.get("Content-Security-Policy")).not.toContain("connect-src");
    });

    it("serves the manifest with the manifest content type", async () => {
      const response = await request("/admin/manifest.webmanifest", { method: "GET" }, { ASSETS });

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("application/manifest+json");
      expect(await response.json()).toMatchObject({ display: "standalone" });
    });

    // Without this guard a deploy that skipped `npm run admin:build` would serve
    // the customer HTML shell as text/javascript and the service worker would
    // fail to register with a parse error pointing nowhere.
    it("404s instead of serving the SPA fallback HTML when the asset is missing", async () => {
      const response = await request("/admin/sw.js", { method: "GET" }, { ASSETS: assetsStub({}) });

      expect(response.status).toBe(404);
    });
  });
});
