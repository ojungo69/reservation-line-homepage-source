import { describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { withFreshCspNonce } from "../src/security-headers";

describe("customer LIFF CSP", () => {
  it("applies PUBLIC_LIFF_CSP to /customer/reservations responses", async () => {
    const app = createApp();
    const response = await app.request("/customer/reservations", {}, {
      LINE_LIFF_ID: "liff_test"
    } as Record<string, unknown>);
    const secondResponse = await app.request("/customer/reservations", {}, {
      LINE_LIFF_ID: "liff_test"
    } as Record<string, unknown>);
    const csp = response.headers.get("Content-Security-Policy") ?? "";
    const secondCsp = secondResponse.headers.get("Content-Security-Policy") ?? "";
    const nonce = csp.match(/'nonce-([0-9a-f]{32})'/)?.[1];
    const secondNonce = secondCsp.match(/'nonce-([0-9a-f]{32})'/)?.[1];
    expect(csp).toContain("https://static.line-scdn.net");
    expect(csp).toContain("https://liff-api.line.me");
    expect(csp).toContain("https://api.line.me");
    expect(csp).toContain("https://static.cloudflareinsights.com/beacon.min.js");
    expect(csp).toContain("default-src 'self'");
    // style-src decision (002-monotone-glass R13): our markup is inline-style
    // free; 'unsafe-inline' is retained conservatively until a real-device LIFF
    // pass proves the SDK injects no inline styles — and must not widen further.
    // Parsed per directive: a substring check would miss e.g. an appended
    // `style-src-elem https:` overriding the stylesheet allow-list.
    const directives = csp.split(";").map((d) => d.trim()).filter(Boolean);
    const styleSrc = directives.filter((d) => d.split(/\s+/)[0] === "style-src");
    expect(styleSrc).toEqual(["style-src 'self' 'unsafe-inline'"]);
    expect(directives.some((d) => /^style-src-(elem|attr)\b/.test(d))).toBe(false);
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(secondNonce).toMatch(/^[0-9a-f]{32}$/);
    expect(secondNonce).not.toBe(nonce);
  });

  it("keeps STRICT_CSP on /api/public/reservation-options responses", async () => {
    const app = createApp();
    const response = await app.request(
      "/api/public/reservation-options",
      {},
      { DB: null } as Record<string, unknown>
    );
    const csp = response.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("https://static.line-scdn.net");
  });

  it("applies private cache headers to /api/public/my-reservations regardless of body status", async () => {
    const app = createApp();
    const response = await app.request(
      "/api/public/my-reservations",
      {
        headers: {
          "Sec-Fetch-Site": "same-origin"
        }
      },
      { DB: null } as Record<string, unknown>
    );
    expect(response.headers.get("Cache-Control") ?? "").toContain("no-store");
  });
});

describe("CSP nonce insertion", () => {
  it("accepts valid directive whitespace variations", () => {
    for (const whitespace of ["  ", "\t"]) {
      const csp = withFreshCspNonce(
        `default-src 'none'; script-src${whitespace}'self'; object-src 'none'`
      );

      expect(csp).toMatch(/script-src 'nonce-[0-9a-f]{32}' 'self'/);
    }
  });
});
