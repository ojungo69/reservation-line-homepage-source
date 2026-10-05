import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("worker runtime", () => {
  it("exposes only the bounded named operations entrypoint to a Service binding", async () => {
    const refused = await exports.OperationsHealth.fetch(
      new Request("https://ops.internal/job-health?sql=select", { method: "GET" })
    );
    expect(refused.status).toBe(404);

    // The test D1 has no production job schema; an unreadable probe must have
    // a fixed unknown response and must never leak the database error.
    const unavailable = await exports.OperationsHealth.fetch(
      new Request("https://ops.internal/job-health")
    );
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({ status: "unknown", sources: [] });
  });

  it("serves the health endpoint through the Cloudflare Workers runtime", async () => {
    const response = await exports.default.fetch(
      new Request("https://reservation.test/api/health")
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      service: "reservation-line-homepage",
      environment: "local",
      specVersion: "v1.5-draft"
    });
  });

  // NOTE: the "/admin/* routes to the worker, never leaks the public SPA" guarantee
  // is covered artifact-independently by test/admin-spa-routing.test.ts (the
  // shouldRouteToWorker predicate). We avoid a worker-runtime body assertion here
  // because serveAdminSpa reads the gitignored /admin-app build which CI does not
  // generate. The /admin-next 404 below is artifact-independent (entrypoint 404).
  it("404s the retired /admin-next alias on the admin host at the worker runtime", async () => {
    // redirect: "manual" so a regression back to a 301 surfaces here as a 301
    // rather than being transparently followed to /admin (which would be a 200).
    const response = await exports.default.fetch(
      new Request("https://admin.example.invalid/admin-next/reservations?store=1", {
        redirect: "manual"
      })
    );

    expect(response.status).toBe(404);
  });

  it("adds browser security headers to public reservation assets", async () => {
    const response = await exports.default.fetch(
      new Request("https://reservation.test/")
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("content-security-policy")).toContain("https://static.line-scdn.net");
    expect(response.headers.get("content-security-policy")).toContain("https://liff-api.line.me");
    expect(response.headers.get("content-security-policy")).toContain("https://challenges.cloudflare.com");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("permissions-policy")).toContain("camera=()");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("strict-transport-security")).toBe(
      "max-age=31536000; includeSubDomains"
    );
    await expect(response.text()).resolves.toContain("LINE予約");
  });

  it("allows Cloudflare edge scripts with a unique response-header CSP nonce", async () => {
    const firstResponse = await exports.default.fetch(
      new Request("https://reservation.test/")
    );
    const secondResponse = await exports.default.fetch(
      new Request("https://reservation.test/")
    );

    const firstPolicy = firstResponse.headers.get("content-security-policy") ?? "";
    const secondPolicy = secondResponse.headers.get("content-security-policy") ?? "";
    const firstNonce = firstPolicy.match(/'nonce-([0-9a-f]{32})'/)?.[1];
    const secondNonce = secondPolicy.match(/'nonce-([0-9a-f]{32})'/)?.[1];

    expect(firstPolicy).toContain("https://static.cloudflareinsights.com/beacon.min.js");
    expect(firstPolicy).not.toContain("'unsafe-inline'");
    expect(firstNonce).toMatch(/^[0-9a-f]{32}$/);
    expect(secondNonce).toMatch(/^[0-9a-f]{32}$/);
    expect(secondNonce).not.toBe(firstNonce);
  });

  it("adds HSTS to every response, including bare 404s", async () => {
    // /admin-next alias is retired and 404s before the worker/ASSETS split —
    // the leanest response path in handleFetch. The outermost HSTS boundary
    // must still stamp it.
    const response = await exports.default.fetch(
      new Request("https://reservation.test/admin-next")
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("strict-transport-security")).toBe(
      "max-age=31536000; includeSubDomains"
    );
  });
});
