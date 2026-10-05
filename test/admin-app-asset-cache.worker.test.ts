import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

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
