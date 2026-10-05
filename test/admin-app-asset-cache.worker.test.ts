import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { INSTANCE_CONFIG } from "../src/instance-config";

// We deliberately do NOT pin specific hashed bundle names here: the Vite
// build output lives in `public/admin-app/` which is gitignored, so CI
// runs without those files on disk. The immutable cache contract for
// hashed bundles is fully covered by the helper unit tests in
// `test/public-asset-cache-control.test.ts`; this worker runtime suite
// only pins the integration points that exist regardless of the
// admin-app build artifacts.

const expectSecurityHeaders = (response: Response) => {
  expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
};

describe("admin-app asset Cache-Control", () => {
  it("serves /admin-app/index.html with no-store + Pragma: no-cache", async () => {
    const response = await exports.default.fetch(
      new Request("https://reservation.test/admin-app/index.html")
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expectSecurityHeaders(response);
  });

  it("serves SPA fallback for /admin-app/assets/missing-AbCd1234.js with no-store", async () => {
    const response = await exports.default.fetch(
      new Request("https://reservation.test/admin-app/assets/missing-AbCd1234.js")
    );

    // SPA mode resolves missing under /admin-app/* to index.html (status 200).
    // The contract here is: even though the path *looks* hashed, we must
    // NOT serve immutable when the actual response is the fallback HTML.
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
  });

  it("serves /styles.css (non-admin-app root asset) with no-store", async () => {
    const response = await exports.default.fetch(
      new Request("https://reservation.test/styles.css")
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
  });
});

it("offers corresponding source on the admin host while keeping customer assets redirected", async () => {
  const headers = { host: INSTANCE_CONFIG.adminHostname };
  const source = await exports.default.fetch(new Request(`https://${INSTANCE_CONFIG.adminHostname}/source`, { headers, redirect: "manual" }));
  expect(source.status).toBe(200);
  expect(await source.text()).toContain("https://github.com/ojungo69/reservation-line-homepage-source");
  expectSecurityHeaders(source);
  const customerAsset = await exports.default.fetch(new Request(`https://${INSTANCE_CONFIG.adminHostname}/styles.css`, { headers, redirect: "manual" }));
  expect(customerAsset.status).toBe(301);
  expect(customerAsset.headers.get("location")).toBe("/admin");
});

it.each([["HEAD", 200], ["POST", 301], ["PUT", 301]])("keeps the admin source offer method boundary for %s", async (method, status) => {
  const response = await exports.default.fetch(new Request(`https://${INSTANCE_CONFIG.adminHostname}/source`, {
    method, headers: { host: INSTANCE_CONFIG.adminHostname }, redirect: "manual"
  }));
  expect(response.status).toBe(status);
  if (method === "HEAD") expect(await response.text()).toBe("");
  else expect(response.headers.get("location")).toBe("/admin");
});
