import { describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { renderCustomerReservationsPage } from "../src/customer/reservations-page";

describe("renderCustomerReservationsPage", () => {
  it("embeds the LIFF id as meta tag and module-preloads the client bundle", () => {
    const html = renderCustomerReservationsPage({ liffId: "1234567890-AbcdEfGh" });
    expect(html).toContain('<meta name="line-liff-id" content="1234567890-AbcdEfGh"');
    expect(html).toContain('<link rel="modulepreload" href="/customer/reservations.js"');
    expect(html).toContain('src="https://static.line-scdn.net/liff/edge/2/sdk.js"');
    expect(html).toContain('<script type="module" src="/customer/reservations.js"');
  });

  it("escapes the LIFF id to defend against meta-tag injection", () => {
    const html = renderCustomerReservationsPage({ liffId: '"><script>alert(1)</script>' });
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("renders an empty status banner with aria-live=polite", () => {
    const html = renderCustomerReservationsPage({ liffId: "" });
    expect(html).toContain('id="status-banner" aria-live="polite"');
  });
});

describe("GET /customer/reservations", () => {
  it("returns HTML 200 with the LIFF id from env injected", async () => {
    const app = createApp();
    const response = await app.request("/customer/reservations", {}, {
      LINE_LIFF_ID: "1234567890-LiffTest"
    } as Record<string, unknown>);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(response.headers.get("Content-Type") ?? "").toContain("text/html");
    expect(text).toContain('content="1234567890-LiffTest"');
  });

  it("renders the page even when LINE_LIFF_ID is undefined (client will surface missing_liff_id)", async () => {
    const app = createApp();
    const response = await app.request("/customer/reservations", {}, {} as Record<string, unknown>);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('<meta name="line-liff-id" content=""');
  });
});
