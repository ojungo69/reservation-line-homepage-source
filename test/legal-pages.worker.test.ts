import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// Worker-runtime contract for the published legal documents: every page must be
// served as the REAL asset file (not the single-page-application ASSETS fallback,
// which would 200 with the customer booking shell) and carry the baseline
// security headers the worker attaches to public assets.

const PAGES = [
  { path: "/legal/terms", heading: "<h1>利用規約</h1>" },
  { path: "/legal/notice", heading: "<h1>予約前確認事項</h1>" },
  { path: "/legal/cancellation", heading: "<h1>キャンセルポリシー</h1>" },
  { path: "/legal/privacy", heading: "<h1>プライバシーポリシー</h1>" },
  { path: "/legal/tokusho", heading: "<h1>特定商取引法に基づく表記</h1>" }
];

describe("legal pages served by the worker", () => {
  for (const { path, heading } of PAGES) {
    it(`serves ${path} as the real document with security headers`, async () => {
      const response = await exports.default.fetch(
        new Request(`https://reservation.test${path}`)
      );

      expect(response.status).toBe(200);
      const body = await response.text();
      // The document heading proves this is the legal page itself — the SPA
      // fallback would return the booking shell (予約フォーム) instead.
      expect(body).toContain(heading);
      expect(body).not.toContain('id="reservation-form"');

      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");

      const csp = response.headers.get("content-security-policy") ?? "";
      const scriptSources = csp.match(/(?:^|; )script-src ([^;]+)/)?.[1] ?? "";
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("connect-src 'self'");
      expect(scriptSources).toContain("'self'");
      expect(scriptSources).toContain("https://static.cloudflareinsights.com/beacon.min.js");
      expect(scriptSources).toMatch(/'nonce-[0-9a-f]{32}'/);
      expect(scriptSources).not.toContain("line-scdn.net");
      expect(scriptSources).not.toContain("challenges.cloudflare.com");
    });
  }

  it("uses a fresh nonce for each legal-page response", async () => {
    const first = await exports.default.fetch(
      new Request("https://reservation.test/legal/terms")
    );
    const second = await exports.default.fetch(
      new Request("https://reservation.test/legal/terms")
    );
    const firstNonce = first.headers
      .get("content-security-policy")
      ?.match(/'nonce-([0-9a-f]{32})'/)?.[1];
    const secondNonce = second.headers
      .get("content-security-policy")
      ?.match(/'nonce-([0-9a-f]{32})'/)?.[1];

    expect(firstNonce).toMatch(/^[0-9a-f]{32}$/);
    expect(secondNonce).toMatch(/^[0-9a-f]{32}$/);
    expect(secondNonce).not.toBe(firstNonce);
  });
});
