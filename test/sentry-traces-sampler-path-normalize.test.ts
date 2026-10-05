import { describe, expect, it } from "vitest";

import type { TransactionEvent } from "@sentry/core";
import { instrumentFetchRequest, spanToJSON, startInactiveSpan, withActiveSpan, withScope } from "@sentry/core";
import { CloudflareClient } from "@sentry/cloudflare";

import {
  ADMIN_PATH_TEMPLATES,
  getBaseSampleRate,
  normalizeEventRoutePaths,
  normalizePathnameTemplate,
  normalizeSpanName,
  normalizeThenScrubErrorEvent,
  normalizeTransactionEvent
} from "../src/index";
import { matchPathnameTemplate } from "../src/sentry-path-templates";
import { redactPushEndpoints } from "../src/pii-normalize";
import { adminApiRoutes } from "../src/routes/admin-api";
import { adminPageRoutes } from "../src/routes/admin-pages";
import { customerPageRoutes } from "../src/routes/customer-pages";
import { googleRoutes } from "../src/routes/google";
import { lineRoutes } from "../src/routes/line";
import { publicRoutes } from "../src/routes/public";

describe("normalizePathnameTemplate", () => {
  it("normalizes dynamic admin reservation ID to :id template", () => {
    expect(normalizePathnameTemplate("/api/admin/reservations/abc-123/approve")).toBe(
      "/api/admin/reservations/:id/approve"
    );
  });

  it("normalizes dynamic customer UUID to :id template", () => {
    expect(
      normalizePathnameTemplate(
        "/api/admin/customers/4f3a8e21-9c01-4a3d-bb52-1c8f0e2d3a99"
      )
    ).toBe("/api/admin/customers/:id");
  });

  it("normalizes dynamic settings/staff path", () => {
    expect(normalizePathnameTemplate("/api/admin/settings/staff/stf-42")).toBe(
      "/api/admin/settings/staff/:id"
    );
  });

  it("normalizes sync/conflicts/manual-resolve path", () => {
    expect(
      normalizePathnameTemplate("/api/admin/sync/conflicts/conf-xyz/manual-resolve")
    ).toBe("/api/admin/sync/conflicts/:id/manual-resolve");
  });

  it("passes the retired change-request withdraw path through untemplated", () => {
    // キャンセル申請機能の廃止 (2026-08-01) でルートもテンプレも撤去済み。未登録
    // パスは素通し (テンプレ不一致 = Sentry tag なし) になる。
    expect(
      normalizePathnameTemplate("/api/public/change-requests/cr-9/withdraw")
    ).toBe("/api/public/change-requests/cr-9/withdraw");
  });

  it("returns static admin path unchanged", () => {
    expect(normalizePathnameTemplate("/api/admin/reservations")).toBe(
      "/api/admin/reservations"
    );
  });

  it("returns public availability path unchanged", () => {
    expect(normalizePathnameTemplate("/api/public/availability")).toBe(
      "/api/public/availability"
    );
  });

  it("returns unknown dynamic admin path unchanged (no false match)", () => {
    expect(
      normalizePathnameTemplate("/api/admin/some-future-route/abc-123")
    ).toBe("/api/admin/some-future-route/abc-123");
  });

  it("prefers more-specific template before generic :id catch-all", () => {
    // /reservations/:id/approve must match before /reservations/:id
    expect(
      normalizePathnameTemplate("/api/admin/reservations/r-1/approve")
    ).toBe("/api/admin/reservations/:id/approve");
    // bare /reservations/:id when no sub-action
    expect(normalizePathnameTemplate("/api/admin/reservations/r-1")).toBe(
      "/api/admin/reservations/:id"
    );
  });

  it("is idempotent — normalizing an already-template path returns the same value", () => {
    const template = "/api/admin/customers/:id";
    expect(normalizePathnameTemplate(template)).toBe(template);
  });

  it("strips query string before matching (matches templates on path+query input)", () => {
    expect(
      normalizePathnameTemplate("/api/admin/customers/abc-123?foo=bar")
    ).toBe("/api/admin/customers/:id");
  });

  it("strips fragment before matching", () => {
    expect(
      normalizePathnameTemplate("/api/admin/customers/abc-123#section")
    ).toBe("/api/admin/customers/:id");
  });

  it("strips query+fragment before matching sub-action route", () => {
    expect(
      normalizePathnameTemplate(
        "/api/admin/reservations/r-7/approve?audit=1#x"
      )
    ).toBe("/api/admin/reservations/:id/approve");
  });

  describe("static siblings under /api/admin/reservations/ pass through", () => {
    // src/app.ts registers GET /pending, /search, /export.csv BEFORE the
    // GET /:id route. The catch-all in this template table must not swallow them.
    it("keeps /pending unchanged", () => {
      expect(normalizePathnameTemplate("/api/admin/reservations/pending")).toBe(
        "/api/admin/reservations/pending"
      );
    });
    it("keeps /search unchanged", () => {
      expect(normalizePathnameTemplate("/api/admin/reservations/search")).toBe(
        "/api/admin/reservations/search"
      );
    });
    it("keeps /export.csv unchanged", () => {
      expect(
        normalizePathnameTemplate("/api/admin/reservations/export.csv")
      ).toBe("/api/admin/reservations/export.csv");
    });
    it("still normalizes a real dynamic ID under /reservations/", () => {
      expect(
        normalizePathnameTemplate("/api/admin/reservations/r-123")
      ).toBe("/api/admin/reservations/:id");
    });
  });
});

describe("normalizeSpanName", () => {
  it("rewrites 'METHOD /dynamic/path' to template form", () => {
    expect(
      normalizeSpanName("GET /api/admin/customers/abc-123")
    ).toBe("GET /api/admin/customers/:id");
  });

  it("rewrites POST + sub-action path", () => {
    expect(
      normalizeSpanName("POST /api/admin/reservations/r-7/approve")
    ).toBe("POST /api/admin/reservations/:id/approve");
  });

  it("handles bare pathname with no method prefix", () => {
    expect(normalizeSpanName("/api/admin/customers/abc-123")).toBe(
      "/api/admin/customers/:id"
    );
  });

  it("passes through cron span names unchanged", () => {
    expect(normalizeSpanName("scheduled")).toBe("scheduled");
    expect(normalizeSpanName("Scheduled Cron */10 * * * *")).toBe(
      "Scheduled Cron */10 * * * *"
    );
  });

  it("passes through static admin paths unchanged", () => {
    expect(normalizeSpanName("GET /api/admin/reservations")).toBe(
      "GET /api/admin/reservations"
    );
  });

  it("is idempotent", () => {
    const normalized = "GET /api/admin/customers/:id";
    expect(normalizeSpanName(normalized)).toBe(normalized);
  });
});

describe("normalizeTransactionEvent", () => {
  // Sentry's TransactionEvent has many required nested fields (span_id, trace_id, etc.)
  // that this normalizer doesn't read. We construct minimal test inputs and cast
  // through `unknown` so the test focuses on the fields the normalizer actually touches.
  const makeEvent = (input: Record<string, unknown>): TransactionEvent =>
    ({ type: "transaction", ...input }) as unknown as TransactionEvent;

  it("normalizes the top-level transaction name", () => {
    const event = makeEvent({
      transaction: "GET /api/admin/customers/abc-123"
    });
    const result = normalizeTransactionEvent(event);
    expect(result.transaction).toBe("GET /api/admin/customers/:id");
  });

  it("normalizes trace context http.target", () => {
    const event = makeEvent({
      transaction: "GET /api/admin/customers/abc-123",
      contexts: {
        trace: {
          data: { "http.target": "/api/admin/customers/abc-123" }
        }
      }
    });
    const result = normalizeTransactionEvent(event);
    expect(result.contexts?.trace?.data?.["http.target"]).toBe(
      "/api/admin/customers/:id"
    );
  });

  it("normalizes trace context url.path (@sentry/cloudflare server root span attribute)", () => {
    const event = makeEvent({
      transaction: "GET /api/admin/customers/abc-123",
      contexts: {
        trace: {
          data: { "url.path": "/api/admin/customers/abc-123" }
        }
      }
    });
    const result = normalizeTransactionEvent(event);
    expect(result.contexts?.trace?.data?.["url.path"]).toBe(
      "/api/admin/customers/:id"
    );
  });

  it("normalizes event.request.url (raw URL from incoming Request)", () => {
    const event = makeEvent({
      transaction: "GET /api/admin/customers/abc-123",
      request: {
        url: "https://example.com/api/admin/customers/abc-123?foo=bar"
      }
    });
    const result = normalizeTransactionEvent(event);
    expect(
      (result as unknown as { request?: { url?: string } }).request?.url
    ).toBe("https://example.com/api/admin/customers/:id?foo=bar");
  });

  it("normalizes event.request.url for reservation sub-action path", () => {
    const event = makeEvent({
      request: {
        url: "https://example.com/api/admin/reservations/r-7/approve"
      }
    });
    const result = normalizeTransactionEvent(event);
    expect(
      (result as unknown as { request?: { url?: string } }).request?.url
    ).toBe("https://example.com/api/admin/reservations/:id/approve");
  });

  it("leaves event.request.url unchanged for static paths", () => {
    const event = makeEvent({
      request: {
        url: "https://example.com/api/admin/reservations/pending"
      }
    });
    const result = normalizeTransactionEvent(event);
    expect(
      (result as unknown as { request?: { url?: string } }).request?.url
    ).toBe("https://example.com/api/admin/reservations/pending");
  });

  it("deep-scrubs event.request.data so transaction events never ship body PII", () => {
    const event = makeEvent({
      request: {
        url: "https://example.com/api/public/reservations",
        data: { customerName: "山田太郎", phone: "09012345678", email: "foo@example.com" }
      }
    });
    const result = normalizeTransactionEvent(event);
    const serialized = JSON.stringify(
      (result as unknown as { request?: { data?: unknown } }).request?.data
    );
    expect(serialized).not.toContain("09012345678");
    expect(serialized).not.toContain("foo@example.com");
    expect(serialized).not.toContain("山田太郎");
    expect(serialized).toContain("[REDACTED]");
  });

  it("redacts raw cookie values on the trace context (root HTTP span attributes)", () => {
    // @sentry/cloudflare's wrapRequestHandler writes http.request.header.cookie.<name>
    // onto the root span from the client dataCollection cookie deny-list, which does NOT
    // cover Cloudflare cookies (cf_clearance, __cf_bm) — independent of the
    // requestDataIntegration include.cookies:false set in buildSentryOptions.
    const event = makeEvent({
      contexts: {
        trace: {
          data: {
            "http.request.header.cookie.cf_clearance": "raw-bot-token-value",
            "http.request.header.cookie.__cf_bm": "raw-bot-management-value",
            // Sentry's normalizeAttributeKey underscores header names: set-cookie -> set_cookie.
            "http.response.header.set_cookie.session": "raw-session-value",
            "http.target": "/api/public/reservations"
          }
        }
      }
    });
    const result = normalizeTransactionEvent(event);
    const traceData = result.contexts?.trace?.data as Record<string, unknown>;
    expect(traceData["http.request.header.cookie.cf_clearance"]).toBe("[REDACTED]");
    expect(traceData["http.request.header.cookie.__cf_bm"]).toBe("[REDACTED]");
    expect(traceData["http.response.header.set_cookie.session"]).toBe("[REDACTED]");
    // Non-cookie attributes still normalize normally.
    expect(traceData["http.target"]).toBe("/api/public/reservations");
  });

  it("redacts raw cookie values on child span.data attributes", () => {
    const event = makeEvent({
      spans: [
        {
          description: "http.server",
          data: {
            "http.request.header.cookie.cf_clearance": "raw-bot-token-value",
            "db.statement": "SELECT 1"
          }
        }
      ]
    });
    const result = normalizeTransactionEvent(event);
    expect(result.spans?.[0]?.data?.["http.request.header.cookie.cf_clearance"]).toBe(
      "[REDACTED]"
    );
    expect(result.spans?.[0]?.data?.["db.statement"]).toBe("SELECT 1");
  });

  it("normalizes trace context http.url (full URL attribute variant)", () => {
    const event = makeEvent({
      transaction: "GET /api/admin/customers/abc-123",
      contexts: {
        trace: {
          data: { "http.url": "https://example.com/api/admin/customers/abc-123" }
        }
      }
    });
    const result = normalizeTransactionEvent(event);
    expect(result.contexts?.trace?.data?.["http.url"]).toBe(
      "https://example.com/api/admin/customers/:id"
    );
  });

  it("normalizes trace context url.full pathname while keeping origin + query", () => {
    const event = makeEvent({
      transaction: "GET /api/admin/customers/abc-123",
      contexts: {
        trace: {
          data: {
            "url.full": "https://example.com/api/admin/customers/abc-123?foo=bar"
          }
        }
      }
    });
    const result = normalizeTransactionEvent(event);
    expect(result.contexts?.trace?.data?.["url.full"]).toBe(
      "https://example.com/api/admin/customers/:id?foo=bar"
    );
  });

  it("leaves url.full untouched when parse fails", () => {
    const event = makeEvent({
      contexts: {
        trace: {
          data: { "url.full": "not-a-url" }
        }
      }
    });
    const result = normalizeTransactionEvent(event);
    expect(result.contexts?.trace?.data?.["url.full"]).toBe("not-a-url");
  });

  it("normalizes child span descriptions and span.data path/url attributes", () => {
    const event = makeEvent({
      transaction: "GET /api/admin/reservations",
      spans: [
        {
          description: "GET /api/admin/customers/abc-123",
          data: {
            "http.target": "/api/admin/customers/abc-123",
            "url.path": "/api/admin/customers/abc-123",
            "url.full": "https://example.com/api/admin/customers/abc-123?x=1",
            "http.url": "https://example.com/api/admin/customers/abc-123"
          }
        },
        {
          description: "SELECT * FROM reservations",
          data: { "db.statement": "SELECT ..." }
        }
      ]
    });
    const result = normalizeTransactionEvent(event);
    expect(result.spans?.[0]?.description).toBe(
      "GET /api/admin/customers/:id"
    );
    expect(result.spans?.[0]?.data?.["http.target"]).toBe(
      "/api/admin/customers/:id"
    );
    expect(result.spans?.[0]?.data?.["url.path"]).toBe(
      "/api/admin/customers/:id"
    );
    expect(result.spans?.[0]?.data?.["url.full"]).toBe(
      "https://example.com/api/admin/customers/:id?x=1"
    );
    expect(result.spans?.[0]?.data?.["http.url"]).toBe(
      "https://example.com/api/admin/customers/:id"
    );
    // Non-path span description untouched
    expect(result.spans?.[1]?.description).toBe("SELECT * FROM reservations");
  });

  it("is a no-op for static paths (no spurious mutation)", () => {
    const event = makeEvent({
      transaction: "GET /api/admin/reservations",
      contexts: {
        trace: {
          data: { "http.target": "/api/admin/reservations" }
        }
      }
    });
    const result = normalizeTransactionEvent(event);
    expect(result.transaction).toBe("GET /api/admin/reservations");
    expect(result.contexts?.trace?.data?.["http.target"]).toBe(
      "/api/admin/reservations"
    );
  });

  it("is idempotent — normalizing twice yields the same result", () => {
    const event = makeEvent({
      transaction: "GET /api/admin/customers/abc-123",
      contexts: {
        trace: {
          data: { "http.target": "/api/admin/customers/abc-123" }
        }
      },
      spans: [
        {
          description: "POST /api/admin/reservations/r-7/approve"
        }
      ]
    });
    const first = normalizeTransactionEvent(event);
    const second = normalizeTransactionEvent(first);
    expect(second.transaction).toBe(first.transaction);
    expect(second.contexts?.trace?.data?.["http.target"]).toBe(
      first.contexts?.trace?.data?.["http.target"]
    );
    expect(second.spans?.[0]?.description).toBe(first.spans?.[0]?.description);
  });

  it("tolerates missing optional fields without crashing", () => {
    expect(() => normalizeTransactionEvent(makeEvent({}))).not.toThrow();
    expect(() =>
      normalizeTransactionEvent(makeEvent({ contexts: {} }))
    ).not.toThrow();
    expect(() =>
      normalizeTransactionEvent(
        makeEvent({ contexts: { trace: { data: undefined } } })
      )
    ).not.toThrow();
  });
});

describe("normalizeEventRoutePaths (error-event path / beforeSend)", () => {
  // The HTTP onError handler forwards unhandled exceptions through beforeSend,
  // so error events carry the raw request URL + transaction name. scrubSentryEvent
  // only redacts emails/phones/secrets, so this normalizer must strip the route
  // IDs to keep raw customer/reservation UUIDs out of Sentry (PII + cardinality)
  // — the same guarantee transaction events get via beforeSendTransaction.
  const makeErrorEvent = (input: Record<string, unknown>) =>
    ({ ...input }) as unknown as TransactionEvent;

  it("normalizes the transaction name on an error event", () => {
    const event = makeErrorEvent({
      transaction: "POST /api/admin/customers/abc-123/profile"
    });
    expect(normalizeEventRoutePaths(event).transaction).toBe(
      "POST /api/admin/customers/:id/profile"
    );
  });

  it("normalizes event.request.url (raw incoming URL) and preserves the query", () => {
    const event = makeErrorEvent({
      request: { url: "https://admin.example.com/api/admin/customers/abc-123/profile?x=1" }
    });
    const result = normalizeEventRoutePaths(event) as unknown as { request: { url: string } };
    expect(result.request.url).toBe(
      "https://admin.example.com/api/admin/customers/:id/profile?x=1"
    );
  });

  it("normalizes contexts.trace.data url fields on an error event", () => {
    const event = makeErrorEvent({
      contexts: { trace: { data: { "url.path": "/api/admin/reservations/r-9/cancel" } } }
    });
    const result = normalizeEventRoutePaths(event) as unknown as {
      contexts: { trace: { data: Record<string, string> } };
    };
    expect(result.contexts.trace.data["url.path"]).toBe(
      "/api/admin/reservations/:id/cancel"
    );
  });

  it("collapses an admin SPA browser deep-link (untemplated, carries a UUID) to /admin/*", () => {
    // serveAdminSpa can throw (e.g. authenticateAdmin JWKS failure) while serving
    // /admin/customers/<uuid>, so the raw UUID must not survive in the error event.
    const event = makeErrorEvent({
      transaction: "GET /admin/customers/4f3a8e21-9c01-4a3d-bb52-1c8f0e2d3a99",
      request: { url: "https://admin.example.com/admin/customers/4f3a8e21-9c01-4a3d-bb52-1c8f0e2d3a99" }
    });
    const result = normalizeEventRoutePaths(event) as unknown as {
      transaction: string;
      request: { url: string };
    };
    expect(result.transaction).toBe("GET /admin/*");
    expect(result.request.url).toBe("https://admin.example.com/admin/*");
  });

  it("normalizeThenScrubErrorEvent normalizes the route BEFORE scrubbing so a token-query scrub cannot strand the raw ID", () => {
    // scrubSentryEvent's sanitizeValue strips `?access_token=` and can mangle the
    // path tail; if it ran first the `/profile$` template would no longer match
    // and the raw customer ID would survive. normalize-then-scrub avoids that.
    const event = makeErrorEvent({
      transaction: "PATCH /api/admin/customers/abc-123-uuid/profile",
      request: {
        url: "https://admin.example.com/api/admin/customers/abc-123-uuid/profile?access_token=supersecret"
      }
    });
    const out = normalizeThenScrubErrorEvent(event as never);
    expect(out).not.toBeNull();
    const o = out as unknown as { transaction: string; request: { url: string } };
    // Route ID templated on both fields…
    expect(o.transaction).toBe("PATCH /api/admin/customers/:id/profile");
    expect(o.request.url).toContain("/api/admin/customers/:id/profile");
    // …raw UUID gone, and the token still scrubbed.
    expect(o.request.url).not.toContain("abc-123-uuid");
    expect(o.request.url).not.toContain("supersecret");
  });
});

describe("LINE credentials on transaction requests", () => {
  it("scrubs the http.query attribute produced by actual SDK fetch instrumentation", () => {
    const client = new CloudflareClient({
      dsn: "https://public@example.test/1", tracesSampleRate: 1, integrations: [], stackParser: () => [],
      transport: () => ({ send: async () => ({ statusCode: 200 }), flush: async () => true })
    });
    withScope((scope) => {
      scope.setClient(client);
      const parent = startInactiveSpan({ name: "Scheduled Cron */10 * * * *", forceTransaction: true });
      try {
        const url = "https://www.googleapis.com/calendar/v3/calendars/store%40gmail.com/events?syncToken=syntheticSecret&maxResults=250";
        const child = withActiveSpan(parent, () => instrumentFetchRequest({
          startTimestamp: Date.now(), fetchData: { method: "GET", url }, args: [url]
        }, () => true, () => false, {}, "auto.http.fetch"));
        expect(spanToJSON(child!).data?.["http.query"]).toContain("syntheticSecret");
        child!.end();
        const result = normalizeTransactionEvent({ type: "transaction", spans: [spanToJSON(child!)] });
        const query = new URLSearchParams(result.spans![0].data!["http.query"] as string);
        expect(query.get("syncToken")).toBe("[REDACTED]");
        expect(query.get("maxResults")).toBe("250");
      } finally {
        parent.end();
        client.dispose();
      }
    });
  });

  it.each(["url.full", "http.url", "url"])("scrubs encoded Calendar account paths in %s and fetch descriptions", (key) => {
    const url = "https://www.googleapis.com/calendar/v3/calendars/store%40gmail.com/events?maxResults=250";
    const result = normalizeTransactionEvent({
      type: "transaction",
      spans: [{ start_timestamp: 1, timestamp: 2, trace_id: "a".repeat(32), span_id: "c".repeat(16),
        description: `GET ${url}`, data: { [key]: url } }]
    } as TransactionEvent);
    expect(JSON.stringify(result)).not.toContain("gmail.com");
    expect(decodeURIComponent(result.spans![0].data![key] as string)).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/[REDACTED_EMAIL]/events?maxResults=250"
    );
    expect(result.spans![0].description).toBe(`GET ${result.spans![0].data![key]}`);
  });

  it("retains safe encoded path segments and service Calendar identifiers", () => {
    const url = "https://example.test/a%2fb/c%3Ad/%EF%BC%A1/team%40group.calendar.google.com/events?maxResults=250";
    const result = normalizeTransactionEvent({ type: "transaction", request: { url } } as TransactionEvent);
    expect(result.request?.url).toBe(url);
  });

  it.each(["http.target", "url.path"])("scrubs queries in root and child %s paths", (key) => {
    const data = { [key]: "/api/public/my-reservations?id%54oken=opaqueSecret&safe=booking" };
    const result = normalizeTransactionEvent({
      type: "transaction",
      contexts: { trace: { trace_id: "a".repeat(32), span_id: "b".repeat(16), data: { ...data } } },
      spans: [{ start_timestamp: 1, timestamp: 2, trace_id: "a".repeat(32), span_id: "c".repeat(16), data: { ...data } }]
    } as TransactionEvent);
    expect(JSON.stringify(result)).not.toContain("opaqueSecret");
    for (const bag of [result.contexts!.trace!.data!, result.spans![0].data!]) {
      const url = new URL(bag[key] as string, "https://example.test");
      expect(url.pathname).toBe("/api/public/my-reservations");
      expect(url.searchParams.get("safe")).toBe("booking");
      expect(url.searchParams.get("idToken")).toBe("[REDACTED]");
    }
  });

  it("keeps route templates and safe query values on relative admin targets", () => {
    const result = normalizeTransactionEvent({
      type: "transaction",
      contexts: { trace: { trace_id: "a".repeat(32), span_id: "b".repeat(16), data: {
        "http.target": "/api/admin/reservations/r-7/approve?idToken=opaqueSecret&safe=booking"
      } } }
    } as TransactionEvent);
    expect(result.contexts?.trace?.data?.["http.target"]).toBe(
      "/api/admin/reservations/:id/approve?idToken=%5BREDACTED%5D&safe=booking"
    );
  });

  it("scrubs SDK query and LINE nonce attributes on root and child spans", () => {
    const data = {
      "url.query": "id%54oken=opaqueQuerySecret&safe=booking",
      "url.full": "https://example.test/api/public/my-reservations?lineAccessToken=opaqueQuerySecret&safe=booking",
      "http.request.header.x_line_nonce": "opaqueNonceSecret",
      "http.request.header.content_type": "application/json"
    };
    const result = normalizeTransactionEvent({
      type: "transaction", contexts: { trace: { trace_id: "a".repeat(32), span_id: "b".repeat(16), data: { ...data } } },
      spans: [{ start_timestamp: 1, timestamp: 2, trace_id: "a".repeat(32), span_id: "c".repeat(16), description: "GET https://example.test/auth?id%54oken=opaqueQuerySecret&safe=booking", data: { ...data } }]
    } as TransactionEvent);
    expect(JSON.stringify(result)).not.toContain("opaqueQuerySecret");
    expect(JSON.stringify(result)).not.toContain("opaqueNonceSecret");
    expect(JSON.stringify(result)).toContain("booking");
    expect(JSON.stringify(result)).toContain("application/json");
    const cleanedUrl = new URL(result.contexts!.trace!.data!["url.full"] as string);
    expect(cleanedUrl.pathname).toBe("/api/public/my-reservations");
    expect(cleanedUrl.searchParams.get("safe")).toBe("booking");
  });

  it("scrubs headers and the separate query bag after normalizing the route", () => {
    const result = normalizeTransactionEvent({
      type: "transaction",
      request: {
        url: "https://example.test/api/public/my-reservations?idToken=opaqueSecret&safe=booking",
        headers: { "X-LINE-IdToken": "opaqueSecret", "X-LINE-AccessToken": "opaqueSecret", "cf-ray": "safe-ray" },
        query_string: [["id_token", "opaqueSecret"], ["safe", "booking"]]
      }
    } as TransactionEvent);
    expect(JSON.stringify(result)).not.toContain("opaqueSecret");
    expect(result.request?.headers?.["cf-ray"]).toBe("safe-ray");
    expect(JSON.stringify(result.request?.query_string)).toContain("booking");
  });
});

describe("getBaseSampleRate with template normalization", () => {
  it("dynamic admin reservation approve path → 0.05 (admin route class)", () => {
    expect(
      getBaseSampleRate("POST /api/admin/reservations/r-7/approve")
    ).toBe(0.05);
  });

  it("dynamic customer UUID path → 0.05 (admin route class via template)", () => {
    expect(
      getBaseSampleRate(
        "GET /api/admin/customers/4f3a8e21-9c01-4a3d-bb52-1c8f0e2d3a99"
      )
    ).toBe(0.05);
  });

  it("public change-request withdraw with dynamic ID → 0 (not in admin/public-reservation/availability classes)", () => {
    // Public change-requests is not under /api/public/reservations or /api/public/availability,
    // so falls into the catch-all 0. Template still applies but rate-class is "else".
    expect(
      getBaseSampleRate("POST /api/public/change-requests/cr-9/withdraw")
    ).toBe(0);
  });

  it("static admin path → 0.05 (unchanged from before this PR)", () => {
    expect(getBaseSampleRate("GET /api/admin/reservations")).toBe(0.05);
  });

  it("cron handler → 0.1 (unaffected by template normalization)", () => {
    expect(getBaseSampleRate("Scheduled Cron */10 * * * *")).toBe(0.1);
  });
});

describe("ADMIN_PATH_TEMPLATES table integrity", () => {
  // Prefixes mirror the app.route(...) mounts in src/app.ts.
  const ROUTERS: { routes: readonly { path: string }[]; prefix: string }[] = [
    { routes: adminApiRoutes.routes, prefix: "/api/admin" },
    { routes: publicRoutes.routes, prefix: "/api/public" },
    { routes: lineRoutes.routes, prefix: "/api/line" },
    { routes: googleRoutes.routes, prefix: "/api/google" },
    { routes: adminPageRoutes.routes, prefix: "" },
    { routes: customerPageRoutes.routes, prefix: "" }
  ];

  it("normalizes EVERY registered route (static + dynamic) to its exact template — fails on drift", () => {
    // Drive a concrete sample path through normalizePathnameTemplate for every
    // real Hono route registration and assert it lands on the route's intended
    // template. This guards BOTH failure modes at once:
    //   - a dynamic route with no template → its UUID/token survives (the exact
    //     PII + cardinality leak src/app.ts's onError route tag must avoid), and
    //   - a static sibling swallowed by the bare `:id` catch-all → observability
    //     drift (e.g. /reservations/available-slots collapsing to :id).
    // A new route that breaks either invariant fails CI. Wildcard catch-alls
    // (`/admin/*`) are not normalization targets and are skipped.
    for (const { routes, prefix } of ROUTERS) {
      for (const { path } of routes) {
        if (path.includes("*")) continue;
        const concrete = prefix + path.replace(/:[^/]+/g, "SAMPLEID");
        const expected = prefix + path.replace(/:[^/]+/g, ":id");
        expect(normalizePathnameTemplate(concrete)).toBe(expected);
      }
    }
  });

  it("matchPathnameTemplate maps API + SPA paths to ID-free buckets and returns null only for genuinely untemplated paths", () => {
    // Known API routes resolve to their template…
    expect(matchPathnameTemplate("/api/admin/customers/abc-123-uuid")).toBe(
      "/api/admin/customers/:id"
    );
    // …admin SPA browser deep-links (served by `/admin/*` → serveAdminSpa) carry
    // raw customer/reservation IDs but can reach onError, so they collapse to the
    // ID-free `/admin/*` bucket rather than leaking the UUID.
    expect(matchPathnameTemplate("/admin/customers/abc-123-uuid")).toBe("/admin/*");
    expect(matchPathnameTemplate("/admin/reservations/7f3e-uuid/edit")).toBe("/admin/*");
    // Bare `/admin` carries no ID and is a distinct route — not collapsed.
    expect(matchPathnameTemplate("/admin")).toBeNull();
    // A genuinely untemplated path still returns null so onError drops the tag.
    expect(matchPathnameTemplate("/some/unknown/abc-123-uuid")).toBeNull();
  });

  it("contains the expected number of templates and covers core admin resource groups", () => {
    expect(ADMIN_PATH_TEMPLATES.length).toBeGreaterThan(0);

    // Each known resource group has at least one template registered.
    const templates = ADMIN_PATH_TEMPLATES.map((t) => t.template);
    expect(templates).toContain("/api/admin/customers/:id");
    expect(templates).toContain("/api/admin/reservations/:id");
    expect(templates).toContain("/api/admin/settings/staff/:id");
    expect(templates).toContain("/api/admin/settings/services/:id");
    expect(templates).toContain("/api/admin/sync/conflicts/:id/manual-resolve");
  });

  it("more-specific routes appear before the generic :id catch-all for each resource", () => {
    const reservationIndices = ADMIN_PATH_TEMPLATES
      .map((t, i) => ({ template: t.template, index: i }))
      .filter((e) => e.template.startsWith("/api/admin/reservations/"));

    const catchAllIndex = reservationIndices.find(
      (e) => e.template === "/api/admin/reservations/:id"
    )?.index;
    expect(catchAllIndex).toBeDefined();

    // All sub-action templates appear before the catch-all.
    const subActionIndices = reservationIndices
      .filter((e) => e.template !== "/api/admin/reservations/:id")
      .map((e) => e.index);
    for (const idx of subActionIndices) {
      expect(idx).toBeLessThan(catchAllIndex!);
    }
  });
});

// A Web Push endpoint is a capability URL: its path is a per-device token that
// lets whoever holds it deliver to that device. @sentry/cloudflare attaches the
// full URL of every outbound fetch to its spans, so these are the choke points
// that keep the token out of the error tracker.
describe("push endpoint redaction", () => {
  const makeEvent = (input: Record<string, unknown>): TransactionEvent =>
    ({ type: "transaction", ...input }) as unknown as TransactionEvent;

  const ENDPOINT = "https://web.push.apple.com/QAAAAA_secret_device_token";

  it.each(["url.full", "http.url", "url"])("strips the token from the %s span attribute", (key) => {
    const event = makeEvent({ spans: [{ data: { [key]: ENDPOINT } }] });

    const attribute = (normalizeTransactionEvent(event).spans?.[0].data as Record<string, unknown>)[
      key
    ];
    expect(attribute).toBe("https://web.push.apple.com/[REDACTED_PUSH_ENDPOINT]");
  });

  it("strips the token from the span description", () => {
    const event = makeEvent({ spans: [{ description: `POST ${ENDPOINT}` }] });

    const description = normalizeTransactionEvent(event).spans?.[0].description;
    expect(description).toBe("POST https://web.push.apple.com/[REDACTED_PUSH_ENDPOINT]");
  });

  // normalizePushEndpoint accepts a port, so the redaction has to know about one
  // too — otherwise that spelling reaches Sentry intact.
  it("covers every push service, query strings and non-default ports", () => {
    for (const url of [
      "https://fcm.googleapis.com/fcm/send/abc123",
      "https://updates.push.services.mozilla.com/wpush/v2/abc123",
      "https://wns2-par02p.notify.windows.com/w/?token=abc123",
      "https://web.push.apple.com:8443/QAAAAA_secret",
    ]) {
      expect(redactPushEndpoints(url)).not.toContain("abc123");
      expect(redactPushEndpoints(url)).not.toContain("QAAAAA_secret");
    }
  });

  it("leaves unrelated URLs alone", () => {
    const url = "https://api.line.me/v2/bot/message/push";
    expect(redactPushEndpoints(url)).toBe(url);
  });
});
